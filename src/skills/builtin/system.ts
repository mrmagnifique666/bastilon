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
  description: "Restart the bot process (admin only). Requires the wrapper to be running.",
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
    // Clear all sessions so stale messages don't re-trigger after restart
    for (const uid of config.allowedUsers) {
      clearSession(uid);
      clearTurns(uid);
    }
    // Exit immediately — wrapper will catch code 42 and restart
    process.exit(42);
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
