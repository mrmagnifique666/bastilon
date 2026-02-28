/**
 * Kingston Wrapper v2.0 — Unified Supervisor
 *
 * THE ONLY supervisor. Merges: wrapper.ts (backoff) + heartbeat.ts (monitoring) + launcher.ts (briefings)
 *
 * Features:
 * - Bot process management with exponential backoff + crash reports + electroshock
 * - Deterministic briefings at 3h, 4h, 5h, 6h30, 11h50, 16h20, 20h, 23h30
 * - Trading monitoring (Alpaca stocks + Binance crypto + Edge v2 brackets)
 * - Crypto daytrader + swing invocation
 * - System health: stuck crons, dead agents
 * - stdout pipe for tray.ts "Bot online" detection
 * - State persistence for Kingston to read
 *
 * Usage:
 *   npx tsx src/wrapper.ts          — start supervisor + bot
 *   npx tsx src/wrapper.ts --test   — fire all tasks + briefings once and exit
 *
 * Exit codes from bot:
 *   0  = clean shutdown (wrapper stays alive for electroshock)
 *   42 = restart requested (by system.restart skill)
 *   *  = crash, restart after exponential backoff
 */
import { spawn, execSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

dotenv.config();

// ═══════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════

const TZ = "America/Toronto";
const TICK_MS = 60_000; // main loop: 1 min
const RESTART_CODE = 42;
const BASE_CRASH_DELAY_MS = 5_000;
const MAX_CRASH_DELAY_MS = 10 * 60_000; // 10 minutes max backoff
const RESTART_DELAY_MS = 1_500;
const MAX_RAPID_CRASHES = 5;
const RAPID_CRASH_WINDOW_MS = 60_000;
const ELECTROSHOCK_GRACE_MS = 90_000;
const STALE_PORTS = [3100, 3200];
const ENTRY_POINT = path.resolve("src/index.ts");
const LOCK_FILE = path.resolve("relay/bot.lock");
const HEARTBEAT_LOCK_FILE = path.resolve("data/heartbeat.lock");
const DB_PATH = path.resolve("relay.db");
const DATA_DIR = path.resolve("data");
const JOURNAL_FILE = path.join(DATA_DIR, "trading-journal.json");
const LOG_FILE = path.join(DATA_DIR, "heartbeat.log");
const LOG_DETAILED_FILE = path.join(DATA_DIR, "heartbeat-detailed.log");
const STATE_FILE = path.join(DATA_DIR, "heartbeat-state.json");
const CRASH_REPORT_FILE = path.resolve("relay/crash-report.txt");
const TEST_MODE = process.argv.includes("--test");

const ALPACA_BASE = "https://paper-api.alpaca.markets";
const BINANCE_BASE = "https://api.binance.com";
const CRYPTO_SYMBOLS = ["BTCUSDT", "ETHUSDT", "DOGEUSDT", "SOLUSDT"];

// ═══════════════════════════════════════════
// TIME
// ═══════════════════════════════════════════

function now(): {
  hour: number;
  minute: number;
  dateStr: string;
  dayOfWeek: number;
  timeStr: string;
  fullDate: string;
} {
  const d = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    hour: "numeric",
    minute: "numeric",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);

  const hour = Number(parts.find((p) => p.type === "hour")!.value);
  const minute = Number(parts.find((p) => p.type === "minute")!.value);
  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  const day = parts.find((p) => p.type === "day")!.value;
  const dateStr = `${y}-${m}-${day}`;
  const timeStr = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  const fullDate = d.toLocaleDateString("fr-CA", {
    timeZone: TZ,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return { hour, minute, dateStr, dayOfWeek: d.getDay(), timeStr, fullDate };
}

function isMarketOpen(): boolean {
  const { hour, minute, dayOfWeek } = now();
  if (dayOfWeek === 0 || dayOfWeek === 6) return false;
  const t = hour * 60 + minute;
  return t >= 540 && t <= 990; // 9:00 - 16:30 ET
}

function formatUptime(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec >= 3600) return `${Math.floor(sec / 3600)}h${Math.floor((sec % 3600) / 60)}m`;
  if (sec >= 60) return `${Math.floor(sec / 60)}m${sec % 60}s`;
  return `${sec}s`;
}

// ═══════════════════════════════════════════
// LOGGING
// ═══════════════════════════════════════════

const MAX_LOG_BYTES = 10 * 1024 * 1024; // 10 MB

function rotateLog(filePath: string): void {
  try {
    if (!fs.existsSync(filePath)) return;
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_LOG_BYTES) {
      const KEEP_BYTES = 2 * 1024 * 1024;
      const fd = fs.openSync(filePath, "r");
      const buf = Buffer.alloc(KEEP_BYTES);
      const readStart = Math.max(0, stat.size - KEEP_BYTES);
      fs.readSync(fd, buf, 0, KEEP_BYTES, readStart);
      fs.closeSync(fd);
      const tail = buf.toString("utf-8");
      const cutIndex = tail.indexOf("\n");
      fs.writeFileSync(filePath, cutIndex > 0 ? tail.slice(cutIndex + 1) : tail);
    }
  } catch { /* best effort */ }
}

function safeConsoleLog(line: string): void {
  try {
    process.stdout.write(line + "\n");
  } catch (e: any) {
    if (e?.code !== "EPIPE") throw e;
  }
}

function logConsole(icon: string, tag: string, msg: string): void {
  const { timeStr } = now();
  const padTag = tag.padEnd(20);
  const line = `[${timeStr}] ${icon} ${padTag}| ${msg}`;
  safeConsoleLog(line);

  try {
    rotateLog(LOG_DETAILED_FILE);
    fs.appendFileSync(LOG_DETAILED_FILE, `${new Date().toISOString()} ${line}\n`);
  } catch { /* best effort */ }
}

function logFile(msg: string): void {
  try {
    rotateLog(LOG_FILE);
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} | ${msg}\n`);
  } catch { /* best effort */ }
}

// ═══════════════════════════════════════════
// TELEGRAM DIRECT SEND
// ═══════════════════════════════════════════

async function sendTelegramDirect(text: string): Promise<boolean> {
  const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID || process.env.ADMIN_CHAT_ID;
  const token = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
  if (!chatId || !token) return false;
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
      signal: AbortSignal.timeout(10_000),
    });
    if (resp.ok) return true;
    if (resp.status === 400) {
      const retry = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text }),
        signal: AbortSignal.timeout(10_000),
      });
      return retry.ok;
    }
    return false;
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════════
// INSTANCE LOCK — prevent multiple supervisors
// ═══════════════════════════════════════════

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireHeartbeatLock(): boolean {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(HEARTBEAT_LOCK_FILE)) {
      const raw = fs.readFileSync(HEARTBEAT_LOCK_FILE, "utf-8").trim();
      try {
        const { pid } = JSON.parse(raw);
        if (pid > 0 && pid !== process.pid && isProcessAlive(pid)) {
          return false;
        }
      } catch { /* invalid JSON, stale lock */ }
    }
    fs.writeFileSync(HEARTBEAT_LOCK_FILE, JSON.stringify({ pid: process.pid, timestamp: new Date().toISOString() }));
    return true;
  } catch {
    return true;
  }
}

function releaseHeartbeatLock(): void {
  try {
    if (fs.existsSync(HEARTBEAT_LOCK_FILE)) fs.unlinkSync(HEARTBEAT_LOCK_FILE);
  } catch { /* best-effort */ }
}

// ═══════════════════════════════════════════
// PORT & LOCK CLEANUP + KILL RIVALS
// ═══════════════════════════════════════════

function cleanLock(): void {
  try {
    if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE);
  } catch { /* best-effort */ }
}

function forceKillPid(pid: number): void {
  if (pid <= 0 || pid === process.pid) return;
  try {
    if (process.platform === "win32") {
      // /F = force, /T = kill child process tree
      execSync(`taskkill /PID ${pid} /F /T 2>nul`, { timeout: 5000 });
    } else {
      process.kill(pid, "SIGKILL");
    }
  } catch { /* already dead */ }
}

function isProcessRunning(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function cleanPorts(): void {
  if (process.platform !== "win32") return;
  for (const port of STALE_PORTS) {
    try {
      const out = execSync(
        `powershell -Command "Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess"`,
        { encoding: "utf-8", timeout: 5000 },
      ).trim();
      if (!out) continue;
      for (const pidStr of out.split(/\r?\n/)) {
        const pid = Number(pidStr.trim());
        // Kill ANY process holding our ports (except the wrapper itself)
        if (pid > 0 && pid !== process.pid) {
          forceKillPid(pid);
          logConsole("\u26A1", "cleanup", `Killed stale process on port ${port} (PID ${pid})`);
        }
      }
    } catch { /* port not in use */ }
  }
}

function killRivalSupervisors(): void {
  if (process.platform !== "win32") return;
  try {
    const out = execSync(
      'wmic process where "name=\'node.exe\'" get commandline,processid /format:csv',
      { encoding: "utf-8", timeout: 8000 },
    );
    for (const line of out.split(/\r?\n/)) {
      // Kill any rival supervisor (heartbeat.ts, launcher.ts, or another wrapper.ts)
      const isRival =
        (line.includes("launcher.ts") || line.includes("heartbeat.ts") ||
         (line.includes("wrapper.ts") && !line.includes(String(process.pid))));
      if (isRival) {
        const parts = line.split(",");
        const pid = Number(parts[parts.length - 1]?.trim());
        if (pid > 0 && pid !== process.pid) {
          forceKillPid(pid);
          logConsole("\u26A1", "cleanup", `Killed rival supervisor (PID ${pid})`);
        }
      }
    }
  } catch { /* best effort */ }
}

// ═══════════════════════════════════════════
// TSX RESOLUTION (from original wrapper.ts)
// ═══════════════════════════════════════════

let tsxReady = false;

async function awaitTsxReady(): Promise<string> {
  const localTsxCmd = path.resolve("node_modules/.bin/tsx.cmd");
  const localTsx = path.resolve("node_modules/.bin/tsx");
  const delays = [1000, 2000, 3000, 5000, 8000, 10000, 15000, 20000, 30000];

  for (let i = 0; i < delays.length; i++) {
    if (process.platform === "win32" && fs.existsSync(localTsxCmd)) {
      if (!tsxReady) logConsole("\u2705", "tsx", "tsx.cmd found — ready to spawn");
      tsxReady = true;
      return localTsxCmd;
    }
    if (fs.existsSync(localTsx)) {
      if (!tsxReady) logConsole("\u2705", "tsx", "tsx found — ready to spawn");
      tsxReady = true;
      return localTsx;
    }
    if (tsxReady) break;
    logConsole("\u26A0\uFE0F", "tsx", `Waiting for tsx... (attempt ${i + 1}/${delays.length})`);
    await new Promise((r) => setTimeout(r, delays[i]));
  }

  if (process.platform === "win32" && fs.existsSync(localTsxCmd)) return localTsxCmd;
  if (fs.existsSync(localTsx)) return localTsx;

  logConsole("\u26A0\uFE0F", "tsx", "tsx not found locally — falling back to npx");
  return "npx";
}

// ═══════════════════════════════════════════
// BOT PROCESS MANAGEMENT
// Exponential backoff from wrapper + electroshock from heartbeat
// ═══════════════════════════════════════════

let kingston: ChildProcess | null = null;
let kingstonStatus: "starting" | "running" | "crashed" | "restarting" | "stopped" = "stopped";
let kingstonStartTime = 0;
let kingstonPID = 0;
const crashTimes: number[] = [];
let consecutiveCrashes = 0;
let spawnErrors = 0;
let recoveryTimer: ReturnType<typeof setTimeout> | null = null;
let lastElectroshockTime = 0;
let startInProgress = false;

function writeCrashReport(code: number | null, uptimeStr: string, signal?: string): void {
  try {
    const report = [
      `=== Kingston Crash Report ===`,
      `Time: ${new Date().toISOString()}`,
      `Exit code: ${code}`,
      `Signal: ${signal || "none"}`,
      `Uptime: ${uptimeStr}`,
      `Consecutive crashes: ${consecutiveCrashes}`,
      `Rapid crashes (60s window): ${crashTimes.length}`,
      `Spawn errors: ${spawnErrors}`,
      `PID: ${process.pid}`,
      `Node: ${process.version}`,
      `Platform: ${process.platform}`,
      `Memory: ${JSON.stringify(process.memoryUsage())}`,
      ``,
    ].join("\n");
    fs.appendFileSync(CRASH_REPORT_FILE, report);
  } catch { /* best-effort */ }
}

function getCrashDelay(): number {
  return Math.min(
    BASE_CRASH_DELAY_MS * Math.pow(2, Math.max(0, consecutiveCrashes - 1)),
    MAX_CRASH_DELAY_MS,
  );
}

async function killOldBot(): Promise<void> {
  // 1. Kill the tracked child process
  if (kingston && !kingston.killed) {
    const oldPid = kingston.pid ?? 0;
    logConsole("\u26A1", "bot.cleanup", `Killing old bot process (PID ${oldPid})...`);
    try { kingston.kill("SIGTERM"); } catch { /* already dead */ }
    // Give it 2s to die gracefully, then force-kill
    await new Promise((r) => setTimeout(r, 2000));
    if (oldPid > 0 && isProcessRunning(oldPid)) {
      logConsole("\u26A1", "bot.cleanup", `Old bot still alive — force killing PID ${oldPid}`);
      forceKillPid(oldPid);
      await new Promise((r) => setTimeout(r, 1000));
    }
    kingston = null;
  }

  // 2. Also kill any process matching the old kingstonPID (in case ref was lost)
  if (kingstonPID > 0 && kingstonPID !== process.pid && isProcessRunning(kingstonPID)) {
    logConsole("\u26A1", "bot.cleanup", `Killing tracked PID ${kingstonPID}`);
    forceKillPid(kingstonPID);
    await new Promise((r) => setTimeout(r, 1000));
  }

  // 3. Kill anything on our ports
  cleanPorts();

  // 4. Verify ports are actually free
  for (const port of STALE_PORTS) {
    try {
      const out = execSync(
        `powershell -Command "Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess"`,
        { encoding: "utf-8", timeout: 5000 },
      ).trim();
      if (out) {
        logConsole("\u26A0\uFE0F", "bot.cleanup", `Port ${port} still occupied after cleanup — force killing`);
        for (const pidStr of out.split(/\r?\n/)) {
          const pid = Number(pidStr.trim());
          if (pid > 0 && pid !== process.pid) forceKillPid(pid);
        }
      }
    } catch { /* ok */ }
  }
}

async function startBot(): Promise<void> {
  if (startInProgress) {
    logConsole("\u26A0\uFE0F", "bot.start", "Start already in progress — skipping duplicate");
    return;
  }
  startInProgress = true;

  killRivalSupervisors();

  // Kill old bot process BEFORE anything else
  await killOldBot();

  cleanLock();

  kingstonStatus = "starting";
  logConsole("\u{1F680}", "bot.start", "Starting Kingston (waiting 2s for ports)...");

  // Wait for ports to be freed
  await new Promise((r) => setTimeout(r, 2000));

  // Wait for tsx to be ready (handles post-reboot delays)
  const tsxPath = await awaitTsxReady();
  const useNpx = tsxPath === "npx";

  kingstonStartTime = Date.now();

  // Strip Claude Code env vars to prevent nested session issues
  const launchEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE")) continue;
    if (v !== undefined) launchEnv[k] = v;
  }
  launchEnv.__KINGSTON_LAUNCHER = "1";
  launchEnv.__KINGSTON_WRAPPER = "1";

  const args = useNpx ? ["tsx", ENTRY_POINT] : [ENTRY_POINT];

  // stdio: pipe stdout/stderr to log file + echo to process.stdout (for tray.ts "Bot online" detection)
  const child = spawn(tsxPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
    cwd: process.cwd(),
    env: launchEnv,
    windowsHide: true,
  });

  // Drain child stdout/stderr to log file + echo to our stdout
  const botLogPath = path.join(DATA_DIR, "kingston-output.log");
  rotateLog(botLogPath);
  const botLogStream = fs.createWriteStream(botLogPath, { flags: "a" });
  botLogStream.on("error", (err) => logConsole("\u26A0\uFE0F", "log.stream", `Log stream error: ${err.message}`));

  if (child.stdout) {
    child.stdout.on("data", (chunk: Buffer) => {
      botLogStream.write(chunk);
      // Echo to our stdout so tray.ts can detect "Bot online"
      try { process.stdout.write(chunk); } catch { /* EPIPE */ }
    });
  }
  if (child.stderr) {
    child.stderr.on("data", (chunk: Buffer) => {
      botLogStream.write(chunk);
      try { process.stderr.write(chunk); } catch { /* EPIPE */ }
    });
  }

  kingston = child;
  kingstonPID = child.pid ?? 0;
  kingstonStatus = "running";
  // Reset startInProgress after 60s (enough for full startup) or on exit
  setTimeout(() => { startInProgress = false; }, 60_000);

  child.on("exit", (code, signal) => {
    botLogStream.end();
    startInProgress = false;
    const uptimeSec = Math.round((Date.now() - kingstonStartTime) / 1000);
    const uptimeStr = formatUptime(Date.now() - kingstonStartTime);

    // Clean shutdown — wrapper stays alive for electroshock
    if (code === 0) {
      logConsole("\u2705", "bot.stop", `Kingston stopped cleanly after ${uptimeStr}`);
      kingstonStatus = "stopped";
      consecutiveCrashes = 0;
      cleanLock();
      logConsole("\u{1F49A}", "wrapper", "Staying alive (bot stopped). Electroshock will restart if needed.");
      return;
    }

    // Restart requested
    if (code === RESTART_CODE) {
      logConsole("\u{1F504}", "bot.restart", `Restart requested after ${uptimeStr}`);
      kingstonStatus = "restarting";
      consecutiveCrashes = 0;
      cleanLock();
      setTimeout(startBot, RESTART_DELAY_MS);
      return;
    }

    // Crash — track and calculate backoff
    consecutiveCrashes++;
    const t = Date.now();
    crashTimes.push(t);
    while (crashTimes.length > 0 && crashTimes[0] < t - RAPID_CRASH_WINDOW_MS) {
      crashTimes.shift();
    }

    // Write crash report
    writeCrashReport(code, uptimeStr, signal ?? undefined);

    // If uptime was > 5 minutes, reset consecutive crash counter (it was stable)
    if (uptimeSec > 300) {
      consecutiveCrashes = 1;
    }

    if (crashTimes.length >= MAX_RAPID_CRASHES) {
      const cooldown = MAX_CRASH_DELAY_MS;
      logConsole("\u{1F534}", "bot.crash", `${MAX_RAPID_CRASHES} crashes in ${RAPID_CRASH_WINDOW_MS / 1000}s — cooldown ${cooldown / 60_000}min`);
      kingstonStatus = "crashed";
      cleanLock();
      sendTelegramDirect(`\u{1F534} *Kingston crash loop*\n${MAX_RAPID_CRASHES} crashes rapides.\nWrapper continue. Recovery dans 10 minutes.`);
      crashTimes.length = 0;
      if (recoveryTimer) clearTimeout(recoveryTimer);
      recoveryTimer = setTimeout(() => {
        logConsole("\u{1F504}", "bot.recovery", "Recovery attempt after cooldown");
        consecutiveCrashes = 0;
        startBot();
      }, cooldown);
      return;
    }

    const delay = getCrashDelay();
    const delayStr = delay >= 60_000 ? `${Math.round(delay / 60_000)}min` : `${delay / 1000}s`;
    logConsole("\u{1F7E1}", "bot.crash", `Exit ${code} after ${uptimeStr}. Restart in ${delayStr} (${crashTimes.length}/${MAX_RAPID_CRASHES})`);
    kingstonStatus = "crashed";
    cleanLock();
    setTimeout(startBot, delay);
  });

  child.on("error", (err) => {
    spawnErrors++;
    startInProgress = false;
    const isEnoent = err.message.includes("ENOENT");

    if (isEnoent) {
      tsxReady = false;
      logConsole("\u274C", "bot.error", `Spawn failed: ${err.message}. System may be rebooting.`);
    } else {
      logConsole("\u274C", "bot.error", `Spawn failed: ${err.message}`);
    }
    kingstonStatus = "crashed";
    cleanLock();

    // Track crash times
    const t = Date.now();
    crashTimes.push(t);
    while (crashTimes.length > 0 && crashTimes[0] < t - RAPID_CRASH_WINDOW_MS) {
      crashTimes.shift();
    }

    if (crashTimes.length >= MAX_RAPID_CRASHES) {
      logConsole("\u{1F534}", "bot.crash", `${MAX_RAPID_CRASHES} spawn errors — cooldown 10min`);
      sendTelegramDirect(`\u{1F534} *Kingston spawn loop*\n${MAX_RAPID_CRASHES} \u00E9checs.\nErreur: ${err.message}\nRecovery dans 10 minutes.`);
      if (recoveryTimer) clearTimeout(recoveryTimer);
      recoveryTimer = setTimeout(() => {
        crashTimes.length = 0;
        consecutiveCrashes = 0;
        spawnErrors = 0;
        startBot();
      }, MAX_CRASH_DELAY_MS);
      return;
    }

    const base = isEnoent ? 15_000 : BASE_CRASH_DELAY_MS;
    const delay = Math.min(base * Math.pow(2, Math.min(spawnErrors - 1, 6)), MAX_CRASH_DELAY_MS);
    const delayStr = delay >= 60_000 ? `${Math.round(delay / 60_000)}min` : `${delay / 1000}s`;
    logConsole("\u26A0\uFE0F", "bot.error", `Retrying in ${delayStr}... (attempt ${spawnErrors})`);
    setTimeout(startBot, delay);
  });
}

// ═══════════════════════════════════════════
// TASK REGISTRY
// ═══════════════════════════════════════════

interface TaskResult {
  ok: boolean;
  summary: string;
  alert?: string;
}

interface Task {
  name: string;
  icon: string;
  intervalMin: number;
  lastRun: number;
  enabled: boolean;
  marketHoursOnly?: boolean;
  handler: () => Promise<TaskResult>;
}

const tasks: Task[] = [];

function registerTask(
  name: string,
  icon: string,
  intervalMin: number,
  handler: () => Promise<TaskResult>,
  opts?: { marketHoursOnly?: boolean },
): void {
  tasks.push({
    name,
    icon,
    intervalMin,
    lastRun: 0,
    enabled: true,
    marketHoursOnly: opts?.marketHoursOnly,
    handler,
  });
}

// ═══════════════════════════════════════════
// TASK: health.bot — PID alive + HTTP ping + electroshock
// ═══════════════════════════════════════════

registerTask("health.bot", "\u2705", 5, async () => {
  let pid = kingstonPID;
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const raw = fs.readFileSync(LOCK_FILE, "utf-8").trim();
      let parsed = Number(raw);
      if (isNaN(parsed) && raw.startsWith("{")) {
        try { parsed = JSON.parse(raw).pid; } catch { /* not JSON */ }
      }
      if (parsed > 0) pid = parsed;
    }
  } catch { /* use tracked PID */ }

  let processAlive = false;
  if (pid > 0) {
    try {
      process.kill(pid, 0);
      processAlive = true;
    } catch {
      processAlive = false;
    }
  }

  let dashboardOk = false;
  try {
    const resp = await fetch("http://127.0.0.1:3200", {
      signal: AbortSignal.timeout(5000),
    });
    dashboardOk = resp.ok || resp.status === 304;
  } catch {
    dashboardOk = false;
  }

  const uptime = kingstonStatus === "running" ? formatUptime(Date.now() - kingstonStartTime) : "--";

  if (processAlive && dashboardOk) {
    return { ok: true, summary: `Bot alive (PID ${pid}, uptime ${uptime}, dashboard OK)` };
  }
  if (processAlive && !dashboardOk) {
    return { ok: true, summary: `Bot alive (PID ${pid}, uptime ${uptime}, dashboard DOWN)` };
  }

  // Bot is dead
  if (TEST_MODE) {
    return { ok: false, summary: "Bot not running (test mode, no electroshock)" };
  }

  if (Date.now() - lastElectroshockTime < ELECTROSHOCK_GRACE_MS) {
    return { ok: false, summary: `Bot dead, grace period (${Math.round((ELECTROSHOCK_GRACE_MS - (Date.now() - lastElectroshockTime)) / 1000)}s left)` };
  }

  if (startInProgress || kingstonStatus === "starting") {
    return { ok: false, summary: `Bot dead, restart already in progress` };
  }

  logConsole("\u26A1", "electroshock", "Bot dead — restarting...");
  lastElectroshockTime = Date.now();
  cleanLock();

  // startBot() handles full cleanup (killOldBot + cleanPorts)
  setTimeout(startBot, 2000);
  const alert = "\u26A1 Kingston down \u2014 red\u00E9marrage automatique";
  sendTelegramDirect(alert);

  return { ok: false, summary: "Bot dead — electroshock fired", alert };
});

// ═══════════════════════════════════════════
// TASK: trading.stocks — Alpaca portfolio
// ═══════════════════════════════════════════

registerTask("trading.stocks", "\u{1F4CA}", 5, async () => {
  const key = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_SECRET_KEY;
  if (!key || !secret) return { ok: false, summary: "No Alpaca credentials" };

  try {
    const headers = { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret };

    const [accResp, posResp] = await Promise.all([
      fetch(`${ALPACA_BASE}/v2/account`, { headers, signal: AbortSignal.timeout(8000) }),
      fetch(`${ALPACA_BASE}/v2/positions`, { headers, signal: AbortSignal.timeout(8000) }),
    ]);

    if (!accResp.ok) return { ok: false, summary: `Alpaca error ${accResp.status}` };

    const acc = (await accResp.json()) as any;
    const positions = posResp.ok ? ((await posResp.json()) as any[]) : [];

    const equity = parseFloat(acc.equity);
    const cash = parseFloat(acc.cash);
    const dayPnl = equity - parseFloat(acc.last_equity);
    const dayPnlPct = ((dayPnl / parseFloat(acc.last_equity)) * 100).toFixed(2);

    const journal = loadJournal();
    journal.lastUpdate = new Date().toISOString();
    journal.stocks = {
      equity,
      cash,
      dayPL: dayPnl,
      positions: positions.map((p: any) => ({
        symbol: p.symbol,
        qty: parseInt(p.qty),
        price: parseFloat(p.current_price),
        pl: parseFloat(p.unrealized_pl),
        plPct: parseFloat(p.unrealized_plpc) * 100,
      })),
    };

    const today = new Date().toISOString().split("T")[0];
    if (!journal.dailyPL) journal.dailyPL = [];
    const existing = journal.dailyPL.find((d: any) => d.date === today);
    if (existing) {
      existing.equity = equity;
      existing.pl = dayPnl;
    } else {
      journal.dailyPL.push({ date: today, equity, pl: dayPnl });
      if (journal.dailyPL.length > 30) journal.dailyPL.shift();
    }
    saveJournal(journal);

    let summary = `Equity: $${equity.toLocaleString("en-US", { maximumFractionDigits: 0 })} | P&L: ${dayPnl >= 0 ? "+" : ""}$${dayPnl.toFixed(2)} (${dayPnlPct}%)`;
    if (positions.length > 0) {
      summary += ` | ${positions.length} pos: ${positions.map((p: any) => p.symbol).join(",")}`;
    }

    let alert: string | undefined;
    for (const p of positions) {
      const plPct = parseFloat(p.unrealized_plpc) * 100;
      if (plPct <= -5) {
        alert = `\u26A0 ${p.symbol} at ${plPct.toFixed(1)}% (stop-loss zone)`;
      } else if (plPct >= 10) {
        alert = `\u{1F389} ${p.symbol} at +${plPct.toFixed(1)}% (take-profit zone)`;
      }
    }

    return { ok: true, summary, alert };
  } catch (e) {
    return { ok: false, summary: `Error: ${e instanceof Error ? e.message : String(e)}` };
  }
}, { marketHoursOnly: true });

// ═══════════════════════════════════════════
// TASK: trading.bracket-manager — Kingston Edge v2
// ═══════════════════════════════════════════

const ALPACA_DATA_BASE = "https://data.alpaca.markets";
const BRACKET_STATE_FILE = path.join(DATA_DIR, "bracket-state.json");

function loadBracketState(): Record<string, any> {
  try {
    return JSON.parse(fs.readFileSync(BRACKET_STATE_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function saveBracketState(state: Record<string, any>): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(BRACKET_STATE_FILE, JSON.stringify(state, null, 2));
}

function calculateATR(bars: any[]): number {
  let atrSum = 0;
  let atrCount = 0;
  for (let i = 1; i < bars.length; i++) {
    const high = bars[i].h;
    const low = bars[i].l;
    const prevClose = bars[i - 1].c;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    atrSum += tr;
    atrCount++;
  }
  return atrCount > 0 ? atrSum / atrCount : 0;
}

async function placeAlpacaOrder(
  headers: Record<string, string>,
  order: Record<string, any>,
): Promise<{ ok: boolean; data?: any; error?: string }> {
  try {
    const resp = await fetch(`${ALPACA_BASE}/v2/orders`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(order),
      signal: AbortSignal.timeout(8000),
    });
    if (resp.ok) return { ok: true, data: await resp.json() };
    return { ok: false, error: (await resp.text()).slice(0, 80) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function cancelAlpacaOrder(
  headers: Record<string, string>,
  orderId: string,
): Promise<boolean> {
  try {
    const resp = await fetch(`${ALPACA_BASE}/v2/orders/${orderId}`, {
      method: "DELETE",
      headers,
      signal: AbortSignal.timeout(8000),
    });
    return resp.ok || resp.status === 404;
  } catch {
    return false;
  }
}

async function isOrderFilled(
  headers: Record<string, string>,
  orderId: string,
): Promise<{ filled: boolean; filledQty: number }> {
  try {
    const resp = await fetch(`${ALPACA_BASE}/v2/orders/${orderId}`, {
      headers,
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return { filled: false, filledQty: 0 };
    const order = (await resp.json()) as any;
    return {
      filled: order.status === "filled",
      filledQty: parseInt(order.filled_qty || "0"),
    };
  } catch {
    return { filled: false, filledQty: 0 };
  }
}

registerTask("trading.bracket-manager", "\u{1F3AF}", 5, async () => {
  const key = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_SECRET_KEY;
  if (!key || !secret) return { ok: false, summary: "No Alpaca credentials" };

  try {
    const headers: Record<string, string> = { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret };

    const posResp = await fetch(`${ALPACA_BASE}/v2/positions`, {
      headers, signal: AbortSignal.timeout(8000),
    });
    if (!posResp.ok) return { ok: false, summary: `Positions error ${posResp.status}` };
    const positions = (await posResp.json()) as any[];

    if (positions.length === 0) {
      saveBracketState({});
      return { ok: true, summary: "No positions — no brackets needed" };
    }

    const ordResp = await fetch(`${ALPACA_BASE}/v2/orders?status=open&limit=100`, {
      headers, signal: AbortSignal.timeout(8000),
    });
    const openOrders = ordResp.ok ? ((await ordResp.json()) as any[]) : [];

    const orderCountBySymbol: Record<string, number> = {};
    for (const ord of openOrders) {
      if ((ord.type === "stop" || ord.type === "limit") &&
          (ord.side === "sell" || ord.side === "buy")) {
        orderCountBySymbol[ord.symbol] = (orderCountBySymbol[ord.symbol] || 0) + 1;
      }
    }

    const bracketState = loadBracketState();
    const actions: string[] = [];
    let alert: string | undefined;
    const posSymbols = new Set(positions.map((p: any) => p.symbol));

    for (const sym of Object.keys(bracketState)) {
      if (!posSymbols.has(sym)) delete bracketState[sym];
    }

    for (const pos of positions) {
      const sym = pos.symbol;
      const totalQty = Math.abs(parseInt(pos.qty));
      const side = parseInt(pos.qty) > 0 ? "long" : "short";
      const entryPrice = parseFloat(pos.avg_entry_price);
      const slSide = side === "long" ? "sell" : "buy";

      // PHASE A: Check tier fills for existing brackets
      const existing = bracketState[sym];
      if (existing && existing.version === "edge-v2") {
        let stateChanged = false;

        if (existing.tier === 0 && existing.tp1OrderId) {
          const tp1Status = await isOrderFilled(headers, existing.tp1OrderId);
          if (tp1Status.filled) {
            existing.tier = 1;
            stateChanged = true;
            if (existing.slOrderId) await cancelAlpacaOrder(headers, existing.slOrderId);
            const remainingQty = totalQty;
            const breakeven = Math.round(entryPrice * 100) / 100;
            const newSl = await placeAlpacaOrder(headers, {
              symbol: sym, qty: remainingQty, side: slSide,
              type: "stop", stop_price: breakeven, time_in_force: "gtc",
            });
            if (newSl.ok) {
              existing.slOrderId = newSl.data.id;
              existing.currentStop = breakeven;
            }
            actions.push(`${sym}: TP1 filled! SL\u2192breakeven $${breakeven}`);
            alert = `\u2705 ${sym} TP1 hit (+1.5R)! SL moved to breakeven. Profit locked.`;
          }
        }

        if (existing.tier === 1 && existing.tp2OrderId) {
          const tp2Status = await isOrderFilled(headers, existing.tp2OrderId);
          if (tp2Status.filled) {
            existing.tier = 2;
            stateChanged = true;
            if (existing.slOrderId) await cancelAlpacaOrder(headers, existing.slOrderId);
            const remainingQty = totalQty;
            const r1Price = side === "long"
              ? Math.round((entryPrice + 1.5 * existing.atr) * 100) / 100
              : Math.round((entryPrice - 1.5 * existing.atr) * 100) / 100;
            const newSl = await placeAlpacaOrder(headers, {
              symbol: sym, qty: remainingQty, side: slSide,
              type: "stop", stop_price: r1Price, time_in_force: "gtc",
            });
            if (newSl.ok) {
              existing.slOrderId = newSl.data.id;
              existing.currentStop = r1Price;
            }
            actions.push(`${sym}: TP2 filled! SL\u2192+1R $${r1Price}`);
            alert = `\u{1F525} ${sym} TP2 hit (+2.5R)! SL locked at +1R profit. Last tier running.`;
          }
        }

        if (existing.tier === 2 && existing.tp3OrderId) {
          const tp3Status = await isOrderFilled(headers, existing.tp3OrderId);
          if (tp3Status.filled) {
            existing.tier = 3;
            stateChanged = true;
            if (existing.slOrderId) await cancelAlpacaOrder(headers, existing.slOrderId);
            actions.push(`${sym}: TP3 filled! Full exit at +3.5R`);
            alert = `\u{1F3C6} ${sym} TP3 hit (+3.5R)! Full position closed. Maximum profit!`;
            delete bracketState[sym];
          }
        }

        if (stateChanged) saveBracketState(bracketState);
        continue;
      }

      // PHASE B: Place new Edge v2 brackets for uncovered positions
      if ((orderCountBySymbol[sym] || 0) >= 2) continue;

      const startDate = new Date();
      startDate.setDate(startDate.getDate() - 30);
      const startStr = startDate.toISOString().split("T")[0];
      const barsUrl = `${ALPACA_DATA_BASE}/v2/stocks/${sym}/bars?timeframe=1Day&limit=15&start=${startStr}&feed=iex`;
      const barsResp = await fetch(barsUrl, {
        headers, signal: AbortSignal.timeout(8000),
      });

      if (!barsResp.ok) {
        actions.push(`${sym}: bars error ${barsResp.status}`);
        continue;
      }

      const barsData = (await barsResp.json()) as any;
      const bars = barsData.bars || [];
      if (bars.length < 2) {
        actions.push(`${sym}: not enough bars (${bars.length})`);
        continue;
      }

      const atr = calculateATR(bars);
      const R = 1.5 * atr;

      const stopPrice = side === "long"
        ? Math.round((entryPrice - R) * 100) / 100
        : Math.round((entryPrice + R) * 100) / 100;
      const tp1Price = side === "long"
        ? Math.round((entryPrice + 1.5 * R) * 100) / 100
        : Math.round((entryPrice - 1.5 * R) * 100) / 100;
      const tp2Price = side === "long"
        ? Math.round((entryPrice + 2.5 * R) * 100) / 100
        : Math.round((entryPrice - 2.5 * R) * 100) / 100;
      const tp3Price = side === "long"
        ? Math.round((entryPrice + 3.5 * R) * 100) / 100
        : Math.round((entryPrice - 3.5 * R) * 100) / 100;

      const qty1 = Math.max(1, Math.floor(totalQty * 0.33));
      const qty2 = Math.max(1, Math.floor(totalQty * 0.33));
      const qty3 = Math.max(1, totalQty - qty1 - qty2);

      const slResult = await placeAlpacaOrder(headers, {
        symbol: sym, qty: totalQty, side: slSide,
        type: "stop", stop_price: stopPrice, time_in_force: "gtc",
      });
      const tp1Result = await placeAlpacaOrder(headers, {
        symbol: sym, qty: qty1, side: slSide,
        type: "limit", limit_price: tp1Price, time_in_force: "gtc",
      });
      const tp2Result = await placeAlpacaOrder(headers, {
        symbol: sym, qty: qty2, side: slSide,
        type: "limit", limit_price: tp2Price, time_in_force: "gtc",
      });
      const tp3Result = await placeAlpacaOrder(headers, {
        symbol: sym, qty: qty3, side: slSide,
        type: "limit", limit_price: tp3Price, time_in_force: "gtc",
      });

      if (slResult.ok && tp1Result.ok) {
        bracketState[sym] = {
          version: "edge-v2",
          side,
          entry: entryPrice,
          atr: Math.round(atr * 100) / 100,
          R: Math.round(R * 100) / 100,
          currentStop: stopPrice,
          tp1Price, tp2Price, tp3Price,
          qty1, qty2, qty3,
          tier: 0,
          slOrderId: slResult.data?.id,
          tp1OrderId: tp1Result.data?.id,
          tp2OrderId: tp2Result.ok ? tp2Result.data?.id : null,
          tp3OrderId: tp3Result.ok ? tp3Result.data?.id : null,
          placedAt: new Date().toISOString(),
        };
        actions.push(`${sym}: Edge v2 — SL=$${stopPrice} TP1=$${tp1Price}(${qty1}) TP2=$${tp2Price}(${qty2}) TP3=$${tp3Price}(${qty3})`);
        alert = `\u{1F3AF} Edge v2 bracket ${sym}: SL=$${stopPrice} | TP1=$${tp1Price} | TP2=$${tp2Price} | TP3=$${tp3Price}`;
      } else {
        const errors = [
          !slResult.ok ? `SL:${slResult.error}` : "",
          !tp1Result.ok ? `TP1:${tp1Result.error}` : "",
        ].filter(Boolean).join(", ");
        actions.push(`${sym}: order failed (${errors})`);
      }
    }

    saveBracketState(bracketState);

    const journal = loadJournal();
    journal.brackets = bracketState;
    saveJournal(journal);

    const summary = actions.length > 0
      ? actions.join(" | ")
      : `${positions.length} pos covered (Edge v2)`;

    return { ok: true, summary, alert };
  } catch (e) {
    return { ok: false, summary: `Error: ${e instanceof Error ? e.message : String(e)}` };
  }
}, { marketHoursOnly: true });

// ═══════════════════════════════════════════
// TASK: trading.crypto — Binance prices
// ═══════════════════════════════════════════

let lastCryptoPrices: Record<string, number> = {};

registerTask("trading.crypto", "\u{1FA99}", 5, async () => {
  try {
    const symbols = encodeURIComponent(JSON.stringify(CRYPTO_SYMBOLS));
    const resp = await fetch(`${BINANCE_BASE}/api/v3/ticker/price?symbols=${symbols}`, {
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) return { ok: false, summary: `Binance error ${resp.status}` };

    const data = (await resp.json()) as any[];
    if (!Array.isArray(data)) return { ok: false, summary: "Invalid Binance response" };

    const prices: Record<string, number> = {};
    const parts: string[] = [];

    for (const item of data) {
      const name = item.symbol.replace("USDT", "");
      const price = parseFloat(item.price);
      prices[item.symbol] = price;

      let priceStr: string;
      if (price < 1) priceStr = `$${price.toFixed(4)}`;
      else if (price < 100) priceStr = `$${price.toFixed(2)}`;
      else priceStr = `$${price.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

      const prev = lastCryptoPrices[item.symbol];
      let changeStr = "";
      if (prev) {
        const changePct = ((price - prev) / prev) * 100;
        if (Math.abs(changePct) >= 0.01) {
          changeStr = ` (${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%)`;
        }
      }

      parts.push(`${name} ${priceStr}${changeStr}`);
    }

    let alert: string | undefined;
    for (const item of data) {
      const name = item.symbol.replace("USDT", "");
      const price = parseFloat(item.price);
      const prev = lastCryptoPrices[item.symbol];
      if (prev) {
        const changePct = ((price - prev) / prev) * 100;
        if (Math.abs(changePct) >= 8) {
          alert = `\u{1FA99} ${name} ${changePct >= 0 ? "+" : ""}${changePct.toFixed(1)}% move!`;
        }
      }
    }

    lastCryptoPrices = prices;

    const journal = loadJournal();
    journal.lastCrypto = prices;
    saveJournal(journal);

    return { ok: true, summary: parts.join(" | "), alert };
  } catch (e) {
    return { ok: false, summary: `Error: ${e instanceof Error ? e.message : String(e)}` };
  }
});

// ═══════════════════════════════════════════
// TASK: trading.daytrader — MCM v3 crypto auto-trader
// ═══════════════════════════════════════════

registerTask("trading.daytrader", "\u{1F916}", 5, async () => {
  try {
    const { getSkill } = await import("./skills/loader.js");
    const skill = getSkill("crypto_auto.tick");
    if (!skill) return { ok: false, summary: "crypto_auto.tick skill not loaded" };
    const result = await skill.execute({});
    const summary = typeof result === "string" ? result.slice(0, 200) : String(result).slice(0, 200);
    const ok = !summary.includes("Error") && !summary.includes("CIRCUIT BREAKER");
    return { ok, summary };
  } catch (e) {
    return { ok: false, summary: `MCM tick error: ${e instanceof Error ? e.message : String(e)}` };
  }
});

// ═══════════════════════════════════════════
// TASK: trading.crypto-swing — Big Crypto Swing (Module 2)
// ═══════════════════════════════════════════

registerTask("trading.crypto-swing", "\u{1F30A}", 15, async () => {
  try {
    const { getSkill } = await import("./skills/loader.js");
    const skill = getSkill("crypto_swing.tick");
    if (!skill) return { ok: false, summary: "crypto_swing.tick skill not loaded" };
    const result = await skill.execute({});
    const summary = typeof result === "string" ? result.slice(0, 200) : String(result).slice(0, 200);
    const ok = !summary.includes("Error") && !summary.includes("CIRCUIT BREAKER");
    return { ok, summary };
  } catch (e) {
    return { ok: false, summary: `Swing tick error: ${e instanceof Error ? e.message : String(e)}` };
  }
});

// ═══════════════════════════════════════════
// TASK: system.crons — check for stuck cron_runs
// ═══════════════════════════════════════════

registerTask("system.crons", "\u2699\uFE0F", 30, async () => {
  try {
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(DB_PATH, { readonly: true });

    const nowSec = Math.floor(Date.now() / 1000);
    const stuckCutoff = nowSec - 7200;

    const stuck = db.prepare(
      "SELECT job_name, started_at FROM cron_runs WHERE outcome = 'running' AND started_at < ?",
    ).all(stuckCutoff) as any[];

    const total = (db.prepare("SELECT COUNT(*) as c FROM cron_jobs WHERE enabled = 1").get() as any).c;

    const errorCutoff = nowSec - 86400;
    const errors = (db.prepare(
      "SELECT COUNT(*) as c FROM cron_runs WHERE outcome = 'error' AND started_at > ?",
    ).get(errorCutoff) as any).c;

    const failing = db.prepare(
      "SELECT name FROM cron_jobs WHERE retry_count >= 2 AND enabled = 1",
    ).all() as any[];

    db.close();

    let summary = `${total} jobs, ${errors} errors (24h)`;
    let alert: string | undefined;

    if (stuck.length > 0) {
      const names = stuck.map((s: any) => s.job_name).join(", ");
      summary += ` | STUCK: ${names}`;
      alert = `\u26A0 Stuck crons: ${names}`;
    }

    if (failing.length > 0) {
      summary += ` | Failing: ${failing.map((f: any) => f.name).join(", ")}`;
    }

    return { ok: stuck.length === 0, summary, alert };
  } catch (e) {
    return { ok: false, summary: `DB error: ${e instanceof Error ? e.message : String(e)}` };
  }
});

// ═══════════════════════════════════════════
// TASK: system.agents — check agent_state for dead agents
// ═══════════════════════════════════════════

registerTask("system.agents", "\u{1F9E0}", 30, async () => {
  try {
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(DB_PATH, { readonly: true });

    const agents = db.prepare("SELECT * FROM agent_state").all() as any[];
    db.close();

    if (agents.length === 0) return { ok: true, summary: "No agents registered" };

    const nowSec = Math.floor(Date.now() / 1000);
    const dead: string[] = [];
    const alive: string[] = [];
    const errored: string[] = [];

    const heartbeats: Record<string, number> = {
      scout: Number(process.env.AGENT_SCOUT_HEARTBEAT_MS || 43200000) / 1000,
      analyst: Number(process.env.AGENT_ANALYST_HEARTBEAT_MS || 21600000) / 1000,
      learner: Number(process.env.AGENT_LEARNER_HEARTBEAT_MS || 28800000) / 1000,
      executor: Number(process.env.AGENT_EXECUTOR_HEARTBEAT_MS || 300000) / 1000,
      "trading-monitor": Number(process.env.AGENT_TRADING_MONITOR_HEARTBEAT_MS || 300000) / 1000,
    };

    for (const a of agents) {
      const expectedInterval = heartbeats[a.agent_id] || 3600;
      const maxAge = expectedInterval * 2.5;

      if (a.consecutive_errors >= 3) {
        errored.push(a.agent_id);
      } else if (a.last_run_at && (nowSec - a.last_run_at) > maxAge) {
        dead.push(a.agent_id);
      } else {
        alive.push(a.agent_id);
      }
    }

    let summary = `${alive.length} alive, ${dead.length} dead, ${errored.length} errored`;
    let alert: string | undefined;

    if (dead.length > 0) summary += ` | Dead: ${dead.join(", ")}`;
    if (errored.length > 0) {
      summary += ` | Errored: ${errored.join(", ")}`;
      alert = `\u26A0 Agents in error: ${errored.join(", ")}`;
    }

    return { ok: dead.length === 0 && errored.length === 0, summary, alert };
  } catch (e) {
    return { ok: false, summary: `DB error: ${e instanceof Error ? e.message : String(e)}` };
  }
});

// ═══════════════════════════════════════════
// TRADING JOURNAL
// ═══════════════════════════════════════════

function loadJournal(): any {
  try {
    return JSON.parse(fs.readFileSync(JOURNAL_FILE, "utf-8"));
  } catch {
    return { lastUpdate: null, stocks: {}, crypto: {}, alerts: [], dailyPL: [] };
  }
}

function saveJournal(j: any): void {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(JOURNAL_FILE, JSON.stringify(j, null, 2));
  } catch { /* best effort */ }
}

// ═══════════════════════════════════════════
// BRIEFING SCHEDULER
// ═══════════════════════════════════════════

type BriefingsModule = typeof import("./scheduler/briefings.js");
let briefingsModule: BriefingsModule | null = null;

async function loadBriefings(): Promise<BriefingsModule | null> {
  if (!briefingsModule) {
    try {
      briefingsModule = await import("./scheduler/briefings.ts" as string);
      logConsole("\u{1F4E6}", "briefings", "Module loaded");
    } catch (err) {
      logConsole("\u274C", "briefings", `Failed to load: ${err}`);
    }
  }
  return briefingsModule;
}

interface BriefingEvent {
  key: string;
  hour: number;
  minute?: number;
  description: string;
  handler: () => Promise<void>;
}

const BRIEFINGS: BriefingEvent[] = [
  {
    key: "night_self_review",
    hour: 3,
    description: "Self-Review nocturne (3h)",
    handler: async () => {
      const m = await loadBriefings();
      if (m) await m.sendNightSelfReview();
    },
  },
  {
    key: "night_api_health",
    hour: 4,
    description: "API Health Check (4h)",
    handler: async () => {
      const m = await loadBriefings();
      if (m) await m.sendApiHealthCheck();
    },
  },
  {
    key: "briefing_prep",
    hour: 5,
    description: "Briefing Prep (5h)",
    handler: async () => {
      const m = await loadBriefings();
      if (m) await m.sendBriefingPrep();
    },
  },
  {
    key: "morning_briefing",
    hour: 6,
    minute: 30,
    description: "Briefing matinal (6h30)",
    handler: async () => {
      const m = await loadBriefings();
      if (m) await m.sendMorningBriefing();
    },
  },
  {
    key: "noon_briefing",
    hour: 11,
    minute: 50,
    description: "Briefing midi (11h50)",
    handler: async () => {
      const m = await loadBriefings();
      if (m) await m.sendNoonBriefing();
    },
  },
  {
    key: "afternoon_briefing",
    hour: 16,
    minute: 20,
    description: "Update apres-midi (16h20)",
    handler: async () => {
      const m = await loadBriefings();
      if (m) await m.sendAfternoonBriefing();
    },
  },
  {
    key: "evening_briefing",
    hour: 20,
    description: "Briefing du soir (20h)",
    handler: async () => {
      const m = await loadBriefings();
      if (m) await m.sendEveningBriefing();
    },
  },
  {
    key: "night_summary",
    hour: 23,
    minute: 30,
    description: "Journal de nuit (23h30)",
    handler: async () => {
      const m = await loadBriefings();
      if (m) await m.generateNightSummary();
    },
  },
];

const firedToday: Record<string, string> = {};

async function checkBriefings(): Promise<void> {
  const { hour, minute, dateStr } = now();

  for (const event of BRIEFINGS) {
    if (hour !== event.hour) continue;
    if (minute < (event.minute ?? 0)) continue;
    if (firedToday[event.key] === dateStr) continue;

    firedToday[event.key] = dateStr;
    logConsole("\u{1F514}", "briefing", `Firing: ${event.description}`);

    try {
      await event.handler();
      if (!briefingsModule) throw new Error("Module null after handler");
      logConsole("\u2705", "briefing", `${event.description} \u2014 sent`);
    } catch (err) {
      logConsole("\u274C", "briefing", `${event.description} failed: ${err}`);
      sendTelegramDirect(`\u26A0 *Wrapper:* ${event.description} a echoue: ${err}`);
    }
  }
}

// ═══════════════════════════════════════════
// STATE PERSISTENCE
// ═══════════════════════════════════════════

let tickCount = 0;

interface HeartbeatState {
  lastTick: string;
  tickCount: number;
  botStatus: string;
  botPID: number;
  botUptime: string;
  tasks: Record<string, { lastRun: string; ok: boolean; summary: string; alert?: string }>;
  briefings: Record<string, { firedAt: string; ok: boolean }>;
  startedAt: string;
}

const wrapperStartedAt = new Date().toISOString();

function saveState(taskResults: Record<string, { ok: boolean; summary: string; alert?: string }>): void {
  try {
    const state: HeartbeatState = {
      lastTick: new Date().toISOString(),
      tickCount,
      botStatus: kingstonStatus,
      botPID: kingstonPID,
      botUptime: kingstonStatus === "running" ? formatUptime(Date.now() - kingstonStartTime) : "--",
      tasks: {},
      briefings: {},
      startedAt: wrapperStartedAt,
    };

    try {
      const existing = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")) as HeartbeatState;
      state.tasks = existing.tasks || {};
      state.briefings = existing.briefings || {};
    } catch { /* first run */ }

    for (const [name, result] of Object.entries(taskResults)) {
      state.tasks[name] = { lastRun: new Date().toISOString(), ...result };
    }

    for (const [key, dateStr] of Object.entries(firedToday)) {
      state.briefings[key] = { firedAt: dateStr, ok: true };
    }

    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch { /* best effort */ }
}

// ═══════════════════════════════════════════
// MAIN TICK
// ═══════════════════════════════════════════

async function tick(): Promise<void> {
  tickCount++;
  const nowMs = Date.now();
  const { timeStr } = now();
  const taskResults: Record<string, { ok: boolean; summary: string; alert?: string }> = {};
  let ran = 0;
  let skipped = 0;
  let failed = 0;

  // Briefings check (with 60s timeout)
  try {
    await Promise.race([
      checkBriefings(),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error("briefing timeout")), 60_000)),
    ]);
  } catch (e) {
    logConsole("\u26A0\uFE0F", "briefing", `Timeout or error: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Run tasks that are due
  for (const task of tasks) {
    if (!task.enabled) continue;

    if (task.marketHoursOnly && !isMarketOpen()) {
      skipped++;
      if (tickCount % 30 === 1) {
        logConsole(task.icon, task.name, `Market closed (${timeStr} ET)`);
      }
      continue;
    }

    const elapsedMin = (nowMs - task.lastRun) / 60_000;
    if (task.lastRun > 0 && elapsedMin < task.intervalMin) {
      skipped++;
      continue;
    }

    task.lastRun = nowMs;

    try {
      const TASK_TIMEOUT_MS = 45_000;
      const result = await Promise.race([
        task.handler(),
        new Promise<TaskResult>((_, reject) =>
          setTimeout(() => reject(new Error(`task timeout after ${TASK_TIMEOUT_MS / 1000}s`)), TASK_TIMEOUT_MS),
        ),
      ]);
      logConsole(
        result.ok ? task.icon : "\u274C",
        task.name,
        result.summary,
      );
      logFile(`${task.name}: ${result.summary}`);
      taskResults[task.name] = { ok: result.ok, summary: result.summary, alert: result.alert };

      if (result.ok) ran++;
      else failed++;

      if (result.alert) {
        logConsole("\u26A1", "ALERT", result.alert);
        sendTelegramDirect(result.alert);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logConsole("\u274C", task.name, `Exception: ${msg}`);
      logFile(`${task.name}: ERROR ${msg}`);
      taskResults[task.name] = { ok: false, summary: `Exception: ${msg}` };
      failed++;
    }
  }

  // Flush delivery queue
  try {
    const { flushDeliveryQueue } = await import("./scheduler/briefings.js");
    const queueResult = await flushDeliveryQueue();
    if (queueResult.sent > 0 || queueResult.failed > 0) {
      logConsole("\u{1F4E8}", "delivery-queue", `Flushed: ${queueResult.sent} sent, ${queueResult.failed} failed`);
    }
  } catch { /* delivery queue not critical */ }

  // Tick summary
  if (ran > 0 || failed > 0) {
    logConsole("\u{1F49A}", "tick", `#${tickCount}: ${ran} OK, ${failed} fail, ${skipped} skip`);
  }

  saveState(taskResults);
}

// ═══════════════════════════════════════════
// TEST MODE
// ═══════════════════════════════════════════

async function runTestMode(): Promise<void> {
  console.log("\n=== KINGSTON WRAPPER \u2014 TEST MODE ===\n");

  const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID || process.env.ADMIN_CHAT_ID;
  const token = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
  console.log(`Telegram: chatId=${chatId ? "OK" : "MISSING"}, token=${token ? "OK" : "MISSING"}`);

  if (chatId && token) {
    const testOk = await sendTelegramDirect("*Kingston Wrapper* \u2014 test en cours...");
    console.log(`Telegram API: ${testOk ? "OK" : "FAILED"}\n`);
  }

  // Run all tasks once
  console.log("Running all tasks...\n");
  for (const task of tasks) {
    process.stdout.write(`  ${task.icon} ${task.name.padEnd(22)} `);
    try {
      const result = await task.handler();
      console.log(`${result.ok ? "OK" : "WARN"} \u2014 ${result.summary}`);
      if (result.alert) console.log(`    \u26A1 ALERT: ${result.alert}`);
    } catch (e) {
      console.log(`FAIL \u2014 ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Fire all briefings
  console.log("\nFiring all briefings...\n");
  let success = 0;
  let bFailed = 0;
  for (const event of BRIEFINGS) {
    process.stdout.write(`  \u{1F514} ${event.description.padEnd(30)} `);
    try {
      await event.handler();
      success++;
      console.log("OK");
    } catch (err) {
      bFailed++;
      console.log(`FAIL: ${err}`);
    }
  }

  console.log(`\n=== DONE: ${success} briefings sent, ${bFailed} failed ===`);
  process.exit(bFailed > 0 ? 1 : 0);
}

// ═══════════════════════════════════════════
// SIGNAL HANDLING
// ═══════════════════════════════════════════

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    logConsole("\u{1F6D1}", "shutdown", `Received ${sig}`);
    if (recoveryTimer) clearTimeout(recoveryTimer);
    if (kingston && !kingston.killed) {
      kingston.kill("SIGTERM");
    }
    cleanLock();
    releaseHeartbeatLock();
    setTimeout(() => process.exit(0), 2000);
  });
}

process.on("uncaughtException", (err: any) => {
  if (err?.code === "EPIPE") return;
  logConsole("\u274C", "exception", `Uncaught: ${err.message}`);
  logFile(`UNCAUGHT: ${err.message}`);
});

process.on("unhandledRejection", (reason) => {
  logConsole("\u274C", "rejection", `Unhandled: ${reason}`);
  logFile(`UNHANDLED: ${reason}`);
});

// ═══════════════════════════════════════════
// STARTUP
// ═══════════════════════════════════════════

const { timeStr: startTimeStr, fullDate: startFullDate } = now();

const briefingTimes = BRIEFINGS.map((b) => {
  const m = b.minute ?? 0;
  return m > 0 ? `${b.hour}h${String(m).padStart(2, "0")}` : `${b.hour}h`;
}).join(" - ");

console.log("");
console.log("\u2550".repeat(50));
console.log("  KINGSTON WRAPPER v2.0");
console.log("  Supervisor + Monitor + Electroshock");
console.log("\u2550".repeat(50));
console.log(`  ${startFullDate}`);
console.log(`  ${startTimeStr} ET (${TZ})`);
console.log("");
console.log(`  Bot:       ${kingstonStatus}`);
console.log(`  Briefings: ${briefingTimes}`);
console.log(`  Tasks:     ${tasks.length} registered, tick every ${TICK_MS / 1000}s`);
console.log(`  Backoff:   ${BASE_CRASH_DELAY_MS / 1000}s \u2192 ${MAX_CRASH_DELAY_MS / 60_000}min max`);
console.log("\u2550".repeat(50));
console.log("");

// ═══════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════

if (process.argv.includes("--test")) {
  runTestMode();
} else {
  // Prevent multiple instances
  if (!acquireHeartbeatLock()) {
    console.error("\n\u274C Another wrapper/heartbeat instance is already running. Exiting.\n");
    process.exit(1);
  }

  killRivalSupervisors();

  // Start bot
  startBot();

  // Tick loop with overlap guard
  let tickRunning = false;
  setInterval(() => {
    if (tickRunning) return;
    tickRunning = true;
    tick().then(() => { tickRunning = false; })
      .catch((e) => { logConsole("\u274C", "tick", `Error: ${e}`); tickRunning = false; });
  }, TICK_MS);

  // First tick after 10s (let Kingston start)
  setTimeout(() => {
    tickRunning = true;
    tick().then(() => { tickRunning = false; })
      .catch((e) => { logConsole("\u274C", "tick", `Error: ${e}`); tickRunning = false; });
  }, 10_000);

  logConsole("\u{1F49A}", "wrapper", "Running. Ctrl+C to stop.");

  sendTelegramDirect(
    `\u{1F49A} *Kingston Wrapper v2.0* d\u00E9marre (${startTimeStr} ET)\n` +
    `Tasks: ${tasks.length} | Briefings: ${briefingTimes}\n` +
    `Tick: ${TICK_MS / 1000}s | Backoff: ${BASE_CRASH_DELAY_MS / 1000}s\u2192${MAX_CRASH_DELAY_MS / 60_000}min`,
  );
}
