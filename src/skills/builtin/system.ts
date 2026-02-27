/**
 * Built-in skill: system info, process management, restart, and open.
 * system.info — system information (any user)
 * system.processes — list running processes (any user)
 * system.kill — kill a process by PID (admin only)
 * system.restart — restart the bot (admin only, requires wrapper)
 * system.open — open a file/URL with the default app (admin only)
 */
import os from "node:os";
import { spawn } from "node:child_process";
import { registerSkill } from "../loader.js";
import { clearSession, clearTurns } from "../../storage/store.js";
import { saveLifeboatRaw, loadLifeboat } from "../../orchestrator/lifeboat.js";
import { getPatternSummary } from "../../memory/self-review.js";
import { config } from "../../config/env.js";
import { log } from "../../utils/log.js";

registerSkill({
  name: "system.info",
  description: "Show system information (OS, CPU, memory, uptime).",
  argsSchema: {
    type: "object",
    properties: {},
  },
  async execute(): Promise<string> {
    const totalMem = (os.totalmem() / 1024 / 1024 / 1024).toFixed(1);
    const freeMem = (os.freemem() / 1024 / 1024 / 1024).toFixed(1);
    const uptimeH = (os.uptime() / 3600).toFixed(1);
    const cpus = os.cpus();
    return [
      `Platform: ${os.platform()} ${os.arch()}`,
      `OS: ${os.type()} ${os.release()}`,
      `Hostname: ${os.hostname()}`,
      `CPU: ${cpus[0]?.model || "unknown"} (${cpus.length} cores)`,
      `Memory: ${freeMem} GB free / ${totalMem} GB total`,
      `Uptime: ${uptimeH} hours`,
      `Node: ${process.version}`,
    ].join("\n");
  },
});

registerSkill({
  name: "system.processes",
  description: "List running processes (top 30 by CPU/memory).",
  argsSchema: {
    type: "object",
    properties: {},
  },
  async execute(): Promise<string> {
    return new Promise<string>((resolve) => {
      const isWindows = process.platform === "win32";
      let cmd: string;
      let args: string[];

      if (isWindows) {
        cmd = "powershell.exe";
        args = [
          "-NoProfile",
          "-Command",
          "Get-Process | Sort-Object CPU -Descending | Select-Object -First 30 Id, ProcessName, @{N='CPU(s)';E={[math]::Round($_.CPU,1)}}, @{N='Mem(MB)';E={[math]::Round($_.WorkingSet64/1MB,1)}} | Format-Table -AutoSize | Out-String",
        ];
      } else {
        cmd = "/bin/sh";
        args = ["-c", "ps aux --sort=-%cpu | head -31"];
      }

      const proc = spawn(cmd, args, {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 10000,
        windowsHide: true,
      });

      let stdout = "";
      proc.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      proc.on("error", (err) => {
        resolve(`Error: ${err.message}`);
      });

      proc.on("close", () => {
        resolve(stdout.trim() || "(no output)");
      });
    });
  },
});

registerSkill({
  name: "system.kill",
  description: "Kill a process by PID (admin only).",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      pid: { type: "number", description: "Process ID to kill" },
    },
    required: ["pid"],
  },
  async execute(args): Promise<string> {
    const pid = args.pid as number;
    try {
      process.kill(pid, "SIGTERM");
      return `Sent SIGTERM to PID ${pid}.`;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

registerSkill({
  name: "system.restart",
  description: "Restart the bot process (admin only). Works with or without the wrapper.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      reason: { type: "string", description: "Reason for restart (logged)" },
    },
  },
  async execute(args): Promise<string> {
    const reason = (args.reason as string) || "no reason given";
    log.info(`[system.restart] Restart requested: ${reason}`);

    // Clear ALL sessions — user, agents (100-106), cron (200-249), scheduler (1)
    const allChatIds = [
      ...config.allowedUsers,
      1, // scheduler
      ...Array.from({ length: 7 }, (_, i) => 100 + i), // agents 100-106
      ...Array.from({ length: 50 }, (_, i) => 200 + i), // cron 200-249
    ];
    for (const uid of allChatIds) {
      try {
        clearSession(uid);
        clearTurns(uid);
      } catch { /* best-effort */ }
    }

    // Detect if wrapper is running (heartbeat sets __KINGSTON_LAUNCHER=1)
    const hasWrapper = process.env.__KINGSTON_WRAPPER === "1" || process.env.__KINGSTON_LAUNCHER === "1";

    if (hasWrapper) {
      // Wrapper catches exit code 42 and restarts the bot in 1.5s
      // The heartbeat process STAYS ALIVE — only the bot child dies
      log.info(`[system.restart] Heartbeat detected — exiting with code 42 (heartbeat restarts in 1.5s)`);
      process.exit(42);
    } else {
      // No wrapper — self-respawn then exit
      const child = spawn("npx", ["tsx", "src/index.ts"], {
        stdio: "inherit",
        shell: true,
        cwd: process.cwd(),
        detached: true,
        windowsHide: true,
      });
      child.unref();
      log.info(`[system.restart] No wrapper detected — spawned new instance (PID ${child.pid})`);
      setTimeout(() => process.exit(0), 2000);
    }
    return "Restarting...";
  },
});

registerSkill({
  name: "system.open",
  description: "Open a file or URL with the default application (admin only).",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      target: { type: "string", description: "File path or URL to open" },
    },
    required: ["target"],
  },
  async execute(args): Promise<string> {
    const target = args.target as string;
    return new Promise<string>((resolve) => {
      let cmd: string;
      let cmdArgs: string[];

      switch (process.platform) {
        case "win32":
          cmd = "cmd.exe";
          cmdArgs = ["/c", "start", "", target];
          break;
        case "darwin":
          cmd = "open";
          cmdArgs = [target];
          break;
        default:
          cmd = "xdg-open";
          cmdArgs = [target];
      }

      const proc = spawn(cmd, cmdArgs, {
        stdio: "ignore",
        detached: true,
        windowsHide: true,
      });

      proc.on("error", (err) => {
        resolve(`Error: ${err.message}`);
      });

      proc.unref();
      resolve(`Opened: ${target}`);
    });
  },
});

// ── system.lifeboat ── Save/load context lifeboat (handoff packet)

registerSkill({
  name: "system.lifeboat",
  description:
    "Save or load a context lifeboat (handoff packet). " +
    "Use 'save' to checkpoint critical context before it's lost. " +
    "Use 'load' to read the current lifeboat.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      action: { type: "string", description: "'save' or 'load' (default: load)" },
      goal: { type: "string", description: "Current primary objective (for save)" },
      state: { type: "string", description: "What is already done (for save)" },
      nextAction: { type: "string", description: "Next concrete step (for save)" },
      constraints: { type: "string", description: "Hard rules/deadlines (for save)" },
      unknowns: { type: "string", description: "What to verify (for save)" },
      artifacts: { type: "string", description: "Relevant paths/IDs/links (for save)" },
      stopConditions: { type: "string", description: "When to halt and ask user (for save)" },
    },
  },
  async execute(args): Promise<string> {
    const action = (args.action as string) || "load";
    const chatId = Number(args.chatId) || config.allowedUsers[0] || 0;

    if (action === "save") {
      saveLifeboatRaw(chatId, {
        goal: (args.goal as string) || "none",
        state: (args.state as string) || "none",
        nextAction: (args.nextAction as string) || "none",
        constraints: (args.constraints as string) || "none",
        unknowns: (args.unknowns as string) || "none",
        artifacts: (args.artifacts as string) || "none",
        stopConditions: (args.stopConditions as string) || "none",
      });
      return "Lifeboat saved. Context will survive compression.";
    }

    const packet = loadLifeboat(chatId);
    if (!packet) return "No lifeboat found for this chat.";

    const age = Math.round((Date.now() - new Date(packet.timestamp).getTime()) / 60_000);
    const ageStr = age < 60 ? `${age}min ago` : `${Math.round(age / 60)}h ago`;
    return [
      `Lifeboat (saved ${ageStr}):`,
      `Goal: ${packet.goal}`,
      `State: ${packet.state}`,
      `Next Action: ${packet.nextAction}`,
      `Constraints: ${packet.constraints}`,
      `Unknowns: ${packet.unknowns}`,
      `Artifacts: ${packet.artifacts}`,
      `Stop Conditions: ${packet.stopConditions}`,
    ].join("\n");
  },
});

// ── system.patterns ── View MISS/FIX error pattern tracking

registerSkill({
  name: "system.patterns",
  description:
    "View tracked error patterns and auto-graduated rules (MISS/FIX system). " +
    "Shows which errors are recurring and which have been promoted to permanent rules.",
  argsSchema: {
    type: "object",
    properties: {},
  },
  async execute(): Promise<string> {
    return getPatternSummary();
  },
});

// ── system.diagnose ── Deep diagnostic of message pipeline
registerSkill({
  name: "system.diagnose",
  description:
    "Deep diagnostic of the message pipeline: checks Telegram bot connectivity, " +
    "Claude CLI responsiveness, heartbeat status, LLM fallback chain health, " +
    "and identifies why messages might fail to be processed. " +
    "Use this when messages are dropping or responses seem stuck.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {},
  },
  async execute(): Promise<string> {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const checks: string[] = [];
    let issues = 0;

    // 1. Process & heartbeat check
    const heartbeatLock = path.resolve("data/heartbeat.lock");
    const botLock = path.resolve("relay/bot.lock");
    const heartbeatAlive = fs.existsSync(heartbeatLock);
    const botAlive = fs.existsSync(botLock);

    if (heartbeatAlive) {
      const hbPid = fs.readFileSync(heartbeatLock, "utf-8").trim();
      checks.push(`✅ Heartbeat: PID ${hbPid} (lock file exists)`);
    } else {
      checks.push(`❌ Heartbeat: NO lock file — supervisor may be dead`);
      issues++;
    }

    if (botAlive) {
      const botPid = fs.readFileSync(botLock, "utf-8").trim();
      checks.push(`✅ Bot: PID ${botPid} (lock file exists)`);
    } else {
      checks.push(`❌ Bot: NO lock file — bot may be dead`);
      issues++;
    }

    // 2. Windows watchdog task
    try {
      const { execSync } = await import("node:child_process");
      const taskCheck = execSync(
        'schtasks /Query /TN "Kingston_Heartbeat_Watchdog" /FO CSV /NH',
        { encoding: "utf-8", timeout: 5000 }
      ).trim();
      if (taskCheck.includes("Ready") || taskCheck.includes("Running")) {
        checks.push(`✅ Watchdog task: Active`);
      } else {
        checks.push(`⚠️ Watchdog task: Exists but status: ${taskCheck.split(",")[2] || "unknown"}`);
      }
    } catch {
      checks.push(`❌ Watchdog task: NOT found — if heartbeat dies, no auto-recovery`);
      issues++;
    }

    // 3. Memory usage
    const mem = process.memoryUsage();
    const heapMB = Math.round(mem.heapUsed / 1048576);
    const rssMB = Math.round(mem.rss / 1048576);
    if (heapMB > 500) {
      checks.push(`⚠️ Memory: Heap ${heapMB}MB (high!) | RSS ${rssMB}MB`);
      issues++;
    } else {
      checks.push(`✅ Memory: Heap ${heapMB}MB | RSS ${rssMB}MB`);
    }

    // 4. Claude CLI timeout settings
    const cliTimeout = Number(process.env.CLAUDE_CLI_TIMEOUT_MS) || 300000;
    const stallTimeout = Number(process.env.CLAUDE_CLI_STALL_TIMEOUT_MS) || 150000;
    checks.push(`📋 CLI timeout: ${Math.round(cliTimeout / 60000)}min | Stall: ${Math.round(stallTimeout / 60000)}min`);

    // 5. LLM provider health
    try {
      const { isProviderHealthy } = await import("../../llm/failover.js");
      const providers = ["claude", "gemini", "ollama", "groq", "openrouter"] as const;
      for (const p of providers) {
        const healthy = isProviderHealthy(p as any);
        checks.push(`${healthy ? "✅" : "❌"} ${p}: ${healthy ? "healthy" : "COOLING DOWN"}`);
        if (!healthy) issues++;
      }
    } catch {
      checks.push(`⚠️ Failover module not loaded`);
    }

    // 6. Ollama availability
    try {
      const { isOllamaAvailable } = await import("../../llm/ollamaClient.js");
      const ollamaUp = await isOllamaAvailable();
      checks.push(`${ollamaUp ? "✅" : "⚠️"} Ollama: ${ollamaUp ? "reachable" : "DOWN (no local fallback)"}`);
      if (!ollamaUp) issues++;
    } catch {
      checks.push(`⚠️ Ollama check failed`);
    }

    // 7. Recent error rate
    try {
      const { getDb } = await import("../../storage/store.js");
      const db = getDb();
      const hourAgo = Math.floor(Date.now() / 1000) - 3600;
      const recentErrors = (db.prepare("SELECT COUNT(*) as c FROM error_log WHERE timestamp > ?").get(hourAgo) as any)?.c || 0;
      const recentTimeouts = (db.prepare("SELECT COUNT(*) as c FROM error_log WHERE timestamp > ? AND message LIKE '%timeout%'").get(hourAgo) as any)?.c || 0;
      if (recentErrors > 10) {
        checks.push(`❌ Errors (1h): ${recentErrors} total, ${recentTimeouts} timeouts — PROBLEMATIC`);
        issues++;
      } else if (recentErrors > 3) {
        checks.push(`⚠️ Errors (1h): ${recentErrors} total, ${recentTimeouts} timeouts`);
      } else {
        checks.push(`✅ Errors (1h): ${recentErrors} total, ${recentTimeouts} timeouts`);
      }
    } catch {
      checks.push(`⚠️ Error log check failed`);
    }

    // 8. Pending code requests
    try {
      const crPath = path.resolve("relay/code-requests.json");
      if (fs.existsSync(crPath)) {
        const crs = JSON.parse(fs.readFileSync(crPath, "utf-8"));
        const pending = Array.isArray(crs) ? crs.filter((r: any) => r.status === "pending").length : 0;
        if (pending > 10) {
          checks.push(`⚠️ Code requests: ${pending} pending (backlog growing)`);
        } else {
          checks.push(`📋 Code requests: ${pending} pending`);
        }
      }
    } catch { /* ignore */ }

    const verdict = issues === 0
      ? "🟢 Pipeline sain — tout fonctionne"
      : issues <= 2
        ? `🟡 ${issues} problème(s) mineur(s)`
        : `🔴 ${issues} problèmes détectés — intervention requise`;

    return `System Diagnostic\n${"═".repeat(30)}\n\n${verdict}\n\n${checks.join("\n")}`;
  },
});
