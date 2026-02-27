/**
 * Kingston Heartbeat v1.0 — Unified Supervisor
 *
 * Replaces: launcher.ts + trading-monitor.cjs + kingston-heartbeat.cjs + briefing-sender.cjs
 *
 * Features:
 * - Bot process management with crash recovery & electroshock
 * - Deterministic briefings at 6h30, 11h50, 16h20, 20h, 23h30
 * - Trading monitoring (Alpaca stocks + Binance crypto)
 * - Crypto daytrader invocation
 * - System health: stuck crons, dead agents
 * - Live console dashboard
 *
 * Usage:
 *   npx tsx src/heartbeat.ts          — start supervisor + bot
 *   npx tsx src/heartbeat.ts --test   — fire all tasks once and exit
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
const CRASH_DELAY_MS = 5_000;
const RESTART_DELAY_MS = 1_500;
const MAX_RAPID_CRASHES = 5;
const RAPID_CRASH_WINDOW_MS = 60_000;
const RECOVERY_DELAY_MS = 10 * 60_000;
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
const DAYTRADER_SCRIPT = path.join(DATA_DIR, "crypto-daytrader.cjs");
const STATE_FILE = path.join(DATA_DIR, "heartbeat-state.json");
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
      // SAFE rotation: read only the last 2MB using a file descriptor
      // (prevents OOM when log files grow to GB+ size)
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
    // EPIPE = stdout pipe broken (parent process dead). Silently ignore.
    if (e?.code !== "EPIPE") throw e;
  }
}

function logConsole(icon: string, tag: string, msg: string): void {
  const { timeStr } = now();
  const padTag = tag.padEnd(20);
  const line = `[${timeStr}] ${icon} ${padTag}| ${msg}`;
  safeConsoleLog(line);

  // Append to detailed log (with rotation)
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
    // Retry without Markdown on 400
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
// HEARTBEAT PID LOCK — prevent multiple instances
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
          return false; // another heartbeat is running
        }
      } catch { /* invalid JSON, stale lock */ }
    }
    fs.writeFileSync(HEARTBEAT_LOCK_FILE, JSON.stringify({ pid: process.pid, timestamp: new Date().toISOString() }));
    return true;
  } catch {
    return true; // best-effort, allow startup
  }
}

function releaseHeartbeatLock(): void {
  try {
    if (fs.existsSync(HEARTBEAT_LOCK_FILE)) fs.unlinkSync(HEARTBEAT_LOCK_FILE);
  } catch { /* best-effort */ }
}

// ═══════════════════════════════════════════
// PORT & LOCK CLEANUP
// ═══════════════════════════════════════════

function cleanLock(): void {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch { /* best-effort */ }
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
        // Skip our own PID and the current Kingston child process (don't kill what we're managing)
        if (pid > 0 && pid !== process.pid && pid !== kingstonPID) {
          try {
            process.kill(pid, "SIGTERM");
            logConsole("\u26A1", "cleanup", `Killed stale process on port ${port} (PID ${pid})`);
          } catch { /* already dead */ }
        }
      }
    } catch { /* port not in use */ }
  }
}

// ═══════════════════════════════════════════
// KILL RIVAL SUPERVISORS (launcher.ts)
// ═══════════════════════════════════════════

function killRivalSupervisors(): void {
  if (process.platform !== "win32") return;
  try {
    const out = execSync(
      'wmic process where "name=\'node.exe\'" get commandline,processid /format:csv',
      { encoding: "utf-8", timeout: 8000 },
    );
    for (const line of out.split(/\r?\n/)) {
      // Kill launcher.ts OR rival heartbeat.ts processes that aren't us
      const isRival =
        (line.includes("launcher.ts") && !line.includes("heartbeat")) ||
        (line.includes("heartbeat.ts") && !line.includes(String(process.pid)));
      if (isRival) {
        const parts = line.split(",");
        const pid = Number(parts[parts.length - 1]?.trim());
        if (pid > 0 && pid !== process.pid) {
          try {
            process.kill(pid, "SIGTERM");
            logConsole("\u26A1", "cleanup", `Killed rival supervisor (PID ${pid})`);
          } catch { /* already dead */ }
        }
      }
    }
  } catch { /* best effort */ }
}

// ═══════════════════════════════════════════
// BOT PROCESS MANAGEMENT
// ═══════════════════════════════════════════

let kingston: ChildProcess | null = null;
let kingstonStatus: "starting" | "running" | "crashed" | "restarting" | "stopped" = "stopped";
let kingstonStartTime = 0;
let kingstonPID = 0;
const crashTimes: number[] = [];
let recoveryTimer: ReturnType<typeof setTimeout> | null = null;
let lastElectroshockTime = 0;

let startInProgress = false;

function startKingston(): void {
  // Guard: prevent double-start from electroshock + crash handler racing
  if (startInProgress) {
    logConsole("\u26A0\uFE0F", "bot.start", "Start already in progress — skipping duplicate");
    return;
  }
  startInProgress = true;

  killRivalSupervisors();
  cleanLock();
  cleanPorts();

  // Wait for ports to actually be freed before spawning
  kingstonStatus = "starting";
  logConsole("\u{1F680}", "bot.start", "Starting Kingston (waiting 2s for ports)...");

  setTimeout(() => {
    kingstonStartTime = Date.now();

    const launchEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE")) continue;
      if (v !== undefined) launchEnv[k] = v;
    }
    launchEnv.__KINGSTON_LAUNCHER = "1";

    // Resolve tsx binary — more reliable than npx on Windows (avoids ENOENT loops)
    const tsxBin = path.resolve("node_modules/.bin/tsx");
    const useTsx = fs.existsSync(tsxBin) || fs.existsSync(tsxBin + ".cmd");

    // Use pipe to prevent Kingston's IO from stalling heartbeat's event loop
    // windowsHide: true prevents visible CMD window
    const child = useTsx
      ? spawn(tsxBin, [ENTRY_POINT], {
          stdio: ["ignore", "pipe", "pipe"],
          shell: true,
          cwd: process.cwd(),
          env: launchEnv,
          windowsHide: true,
        })
      : spawn("npx", ["tsx", ENTRY_POINT], {
          stdio: ["ignore", "pipe", "pipe"],
          shell: true,
          cwd: process.cwd(),
          env: launchEnv,
          windowsHide: true,
        });

    if (!useTsx) {
      logConsole("\u26A0\uFE0F", "bot.start", "tsx not found in node_modules/.bin — falling back to npx");
    }

    // Drain child stdout/stderr to log file (prevent pipe buffer full + freeze)
    const botLogPath = path.join(DATA_DIR, "kingston-output.log");
    rotateLog(botLogPath); // Rotate before opening new stream (prevent unbounded growth)
    const botLogStream = fs.createWriteStream(botLogPath, { flags: "a" });
    botLogStream.on("error", (err) => logConsole("⚠️", "log.stream", `Log stream error: ${err.message}`));
    if (child.stdout) child.stdout.pipe(botLogStream);
    if (child.stderr) child.stderr.pipe(botLogStream);

    kingston = child;
    kingstonPID = child.pid ?? 0;
    kingstonStatus = "running";
    // DON'T reset startInProgress here — reset only when child exits or after grace period
    setTimeout(() => { startInProgress = false; }, 30_000); // Safety: reset after 30s max

    child.on("exit", (code) => {
      // Clean up log stream to prevent memory leak
      botLogStream.end();
      startInProgress = false; // Allow restarts now that the process exited
      const uptime = formatUptime(Date.now() - kingstonStartTime);

    if (code === 0) {
      logConsole("\u2705", "bot.stop", `Kingston stopped cleanly after ${uptime}`);
      kingstonStatus = "stopped";
      cleanLock();
      // DON'T exit heartbeat — stay alive so the Task Scheduler watchdog
      // doesn't need to restart us. The bot can be restarted via:
      //   - system.restart (exit 42 → auto-restart)
      //   - restart-kingston.bat (kills child, heartbeat restarts it)
      //   - electroshock (health.bot detects dead child, restarts)
      logConsole("\u{1F49A}", "heartbeat", "Heartbeat staying alive (bot stopped). Electroshock will restart if needed.");
      return;
    }

    if (code === RESTART_CODE) {
      logConsole("\u{1F504}", "bot.restart", `Restart requested after ${uptime}`);
      kingstonStatus = "restarting";
      cleanLock();
      setTimeout(startKingston, RESTART_DELAY_MS);
      return;
    }

    // Crash
    const t = Date.now();
    crashTimes.push(t);
    while (crashTimes.length > 0 && crashTimes[0] < t - RAPID_CRASH_WINDOW_MS) {
      crashTimes.shift();
    }

    if (crashTimes.length >= MAX_RAPID_CRASHES) {
      logConsole("\u{1F534}", "bot.crash", `${MAX_RAPID_CRASHES} crashes in ${RAPID_CRASH_WINDOW_MS / 1000}s — cooldown 10min`);
      kingstonStatus = "crashed";
      cleanLock();
      sendTelegramDirect(`\u{1F534} *Kingston crash loop*\n${MAX_RAPID_CRASHES} crashes rapides.\nHeartbeat continue. Recovery dans 10 minutes.`);
      if (recoveryTimer) clearTimeout(recoveryTimer);
      recoveryTimer = setTimeout(() => {
        logConsole("\u{1F504}", "bot.recovery", "Recovery attempt after 10min cooldown");
        crashTimes.length = 0;
        startKingston();
      }, RECOVERY_DELAY_MS);
      return;
    }

    logConsole("\u{1F7E1}", "bot.crash", `Exit ${code} after ${uptime}. Restart in ${CRASH_DELAY_MS / 1000}s (${crashTimes.length}/${MAX_RAPID_CRASHES})`);
    kingstonStatus = "crashed";
    cleanLock();
    setTimeout(startKingston, CRASH_DELAY_MS);
  });

  child.on("error", (err) => {
    logConsole("\u274C", "bot.error", `Spawn failed: ${err.message}`);
    kingstonStatus = "crashed";
    startInProgress = false;
    cleanLock();

    // Track crash times (same logic as exit handler)
    const t = Date.now();
    crashTimes.push(t);
    while (crashTimes.length > 0 && crashTimes[0] < t - RAPID_CRASH_WINDOW_MS) {
      crashTimes.shift();
    }

    if (crashTimes.length >= MAX_RAPID_CRASHES) {
      logConsole("\u{1F534}", "bot.crash", `${MAX_RAPID_CRASHES} spawn errors in ${RAPID_CRASH_WINDOW_MS / 1000}s — cooldown 10min`);
      sendTelegramDirect(`\u{1F534} *Kingston spawn loop*\n${MAX_RAPID_CRASHES} échecs de démarrage.\nErreur: ${err.message}\nRecovery dans 10 minutes.`);
      if (recoveryTimer) clearTimeout(recoveryTimer);
      recoveryTimer = setTimeout(() => {
        crashTimes.length = 0;
        startKingston();
      }, RECOVERY_DELAY_MS);
      return;
    }

    setTimeout(startKingston, CRASH_DELAY_MS);
  });
  }, 2000); // end of port-wait setTimeout
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
// TASK: health.bot — PID alive + HTTP ping
// ═══════════════════════════════════════════

registerTask("health.bot", "\u2705", 5, async () => {
  // Check PID from lock file (JSON format: {"pid": N, "timestamp": "..."})
  let pid = kingstonPID;
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const raw = fs.readFileSync(LOCK_FILE, "utf-8").trim();
      let parsed = Number(raw); // plain number format
      if (isNaN(parsed) && raw.startsWith("{")) {
        try { parsed = JSON.parse(raw).pid; } catch { /* not JSON */ }
      }
      if (parsed > 0) pid = parsed;
    }
  } catch { /* use tracked PID */ }

  // Check if process alive
  let processAlive = false;
  if (pid > 0) {
    try {
      process.kill(pid, 0);
      processAlive = true;
    } catch {
      processAlive = false;
    }
  }

  // Check dashboard HTTP
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

  // Electroshock — auto-restart
  if (Date.now() - lastElectroshockTime < ELECTROSHOCK_GRACE_MS) {
    return { ok: false, summary: `Bot dead, grace period (${Math.round((ELECTROSHOCK_GRACE_MS - (Date.now() - lastElectroshockTime)) / 1000)}s left)` };
  }

  // Skip if a restart is already queued (crash handler is handling it)
  if (startInProgress || kingstonStatus === "starting") {
    return { ok: false, summary: `Bot dead, restart already in progress` };
  }

  logConsole("\u26A1", "electroshock", "Bot dead — restarting...");
  lastElectroshockTime = Date.now();
  cleanPorts();
  cleanLock();

  if (kingston && !kingston.killed) {
    try { kingston.kill("SIGTERM"); } catch { /* already dead */ }
  }

  setTimeout(startKingston, 2000);
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

    // Update trading journal
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

    // Track daily P&L
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

    // Build summary
    let summary = `Equity: $${equity.toLocaleString("en-US", { maximumFractionDigits: 0 })} | P&L: ${dayPnl >= 0 ? "+" : ""}$${dayPnl.toFixed(2)} (${dayPnlPct}%)`;
    if (positions.length > 0) {
      summary += ` | ${positions.length} pos: ${positions.map((p: any) => p.symbol).join(",")}`;
    }

    // Alerts for positions near SL/TP
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
// 3-tier progressive exit system
// SL = 1.5x ATR | TP1 = 1.5R (33%) | TP2 = 2.5R (33%) | TP3 = 3.5R (34%)
// After TP1: SL → breakeven | After TP2: SL → +1R
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

// Calculate ATR from daily bars
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

// Place a single order on Alpaca
async function placeAlpacaOrder(
  headers: Record<string, string>,
  order: Record<string, any>
): Promise<{ ok: boolean; data?: any; error?: string }> {
  try {
    const resp = await fetch(`${ALPACA_BASE}/v2/orders`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(order),
      signal: AbortSignal.timeout(8000),
    });
    if (resp.ok) {
      return { ok: true, data: await resp.json() };
    }
    return { ok: false, error: (await resp.text()).slice(0, 80) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// Cancel an order by ID
async function cancelAlpacaOrder(
  headers: Record<string, string>,
  orderId: string
): Promise<boolean> {
  try {
    const resp = await fetch(`${ALPACA_BASE}/v2/orders/${orderId}`, {
      method: "DELETE",
      headers,
      signal: AbortSignal.timeout(8000),
    });
    return resp.ok || resp.status === 404; // 404 = already filled/cancelled
  } catch {
    return false;
  }
}

// Check if an order has been filled
async function isOrderFilled(
  headers: Record<string, string>,
  orderId: string
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

    // 1. Fetch open positions
    const posResp = await fetch(`${ALPACA_BASE}/v2/positions`, {
      headers, signal: AbortSignal.timeout(8000),
    });
    if (!posResp.ok) return { ok: false, summary: `Positions error ${posResp.status}` };
    const positions = (await posResp.json()) as any[];

    if (positions.length === 0) {
      // Clean up bracket state for closed positions
      saveBracketState({});
      return { ok: true, summary: "No positions — no brackets needed" };
    }

    // 2. Fetch open orders to check coverage
    const ordResp = await fetch(`${ALPACA_BASE}/v2/orders?status=open&limit=100`, {
      headers, signal: AbortSignal.timeout(8000),
    });
    const openOrders = ordResp.ok ? ((await ordResp.json()) as any[]) : [];

    // Count sell/buy orders per symbol (for coverage check)
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

    // Clean up bracket state for positions that no longer exist
    for (const sym of Object.keys(bracketState)) {
      if (!posSymbols.has(sym)) {
        delete bracketState[sym];
      }
    }

    for (const pos of positions) {
      const sym = pos.symbol;
      const totalQty = Math.abs(parseInt(pos.qty));
      const side = parseInt(pos.qty) > 0 ? "long" : "short";
      const entryPrice = parseFloat(pos.avg_entry_price);
      const slSide = side === "long" ? "sell" : "buy";

      // ── PHASE A: Check tier fills for existing brackets ──
      const existing = bracketState[sym];
      if (existing && existing.version === "edge-v2") {
        let stateChanged = false;

        // Check if TP1 filled (tier 1)
        if (existing.tier === 0 && existing.tp1OrderId) {
          const tp1Status = await isOrderFilled(headers, existing.tp1OrderId);
          if (tp1Status.filled) {
            // TP1 filled! Move SL to breakeven, advance to tier 1
            existing.tier = 1;
            stateChanged = true;

            // Cancel old SL, place new SL at breakeven for remaining qty
            if (existing.slOrderId) await cancelAlpacaOrder(headers, existing.slOrderId);
            const remainingQty = totalQty; // Alpaca auto-adjusts after partial sell
            const breakeven = Math.round(entryPrice * 100) / 100;
            const newSl = await placeAlpacaOrder(headers, {
              symbol: sym, qty: remainingQty, side: slSide,
              type: "stop", stop_price: breakeven, time_in_force: "gtc",
            });
            if (newSl.ok) {
              existing.slOrderId = newSl.data.id;
              existing.currentStop = breakeven;
            }
            actions.push(`${sym}: TP1 filled! SL→breakeven $${breakeven}`);
            alert = `\u{2705} ${sym} TP1 hit (+1.5R)! SL moved to breakeven. Profit locked.`;
          }
        }

        // Check if TP2 filled (tier 2)
        if (existing.tier === 1 && existing.tp2OrderId) {
          const tp2Status = await isOrderFilled(headers, existing.tp2OrderId);
          if (tp2Status.filled) {
            existing.tier = 2;
            stateChanged = true;

            // Cancel old SL, place new SL at +1R (entry + 1.5*ATR)
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
            actions.push(`${sym}: TP2 filled! SL→+1R $${r1Price}`);
            alert = `\u{1F525} ${sym} TP2 hit (+2.5R)! SL locked at +1R profit. Last tier running.`;
          }
        }

        // Check if TP3 filled (tier 3 — all done)
        if (existing.tier === 2 && existing.tp3OrderId) {
          const tp3Status = await isOrderFilled(headers, existing.tp3OrderId);
          if (tp3Status.filled) {
            existing.tier = 3;
            stateChanged = true;
            // Cancel remaining SL
            if (existing.slOrderId) await cancelAlpacaOrder(headers, existing.slOrderId);
            actions.push(`${sym}: TP3 filled! Full exit at +3.5R`);
            alert = `\u{1F3C6} ${sym} TP3 hit (+3.5R)! Full position closed. Maximum profit!`;
            delete bracketState[sym];
          }
        }

        if (stateChanged) {
          saveBracketState(bracketState);
        }
        continue; // Already managed by Edge v2
      }

      // ── PHASE B: Place new Edge v2 brackets for uncovered positions ──
      // Skip if position already has orders (legacy or manual)
      if ((orderCountBySymbol[sym] || 0) >= 2) {
        continue;
      }

      // Fetch 14-day bars for ATR
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
      const R = 1.5 * atr; // 1R = stop distance

      // Edge v2: 3-tier take-profit levels
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

      // Split qty into 3 tiers: 33% / 33% / 34%
      const qty1 = Math.max(1, Math.floor(totalQty * 0.33));
      const qty2 = Math.max(1, Math.floor(totalQty * 0.33));
      const qty3 = Math.max(1, totalQty - qty1 - qty2);

      // Place stop-loss for full position
      const slResult = await placeAlpacaOrder(headers, {
        symbol: sym, qty: totalQty, side: slSide,
        type: "stop", stop_price: stopPrice, time_in_force: "gtc",
      });

      // Place 3 take-profit limit orders
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
          tier: 0, // 0=initial, 1=TP1 filled, 2=TP2 filled, 3=done
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

    // Update trading journal
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

      // Format price
      let priceStr: string;
      if (price < 1) priceStr = `$${price.toFixed(4)}`;
      else if (price < 100) priceStr = `$${price.toFixed(2)}`;
      else priceStr = `$${price.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

      // Change from last check
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

    // Check for big moves (alert if >8%)
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

    // Update journal
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
// Calls crypto_auto.tick() directly instead of spawning old .cjs script
// ═══════════════════════════════════════════

registerTask("trading.daytrader", "\u{1F916}", 5, async () => {
  try {
    // Call crypto_auto.tick directly via skill registry (MCM v3)
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
// BTC/ETH/SOL/BNB with EMA200+RSI+MACD, 3-tier exits
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
    const stuckCutoff = nowSec - 7200; // 2 hours

    // Stuck jobs (running > 2h)
    const stuck = db.prepare(
      "SELECT job_name, started_at FROM cron_runs WHERE outcome = 'running' AND started_at < ?",
    ).all(stuckCutoff) as any[];

    // Total active jobs
    const total = (db.prepare("SELECT COUNT(*) as c FROM cron_jobs WHERE enabled = 1").get() as any).c;

    // Errors in last 24h
    const errorCutoff = nowSec - 86400;
    const errors = (db.prepare(
      "SELECT COUNT(*) as c FROM cron_runs WHERE outcome = 'error' AND started_at > ?",
    ).get(errorCutoff) as any).c;

    // Failing jobs (high retry count)
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

    // Expected heartbeat intervals (from .env, or defaults)
    const heartbeats: Record<string, number> = {
      scout: Number(process.env.AGENT_SCOUT_HEARTBEAT_MS || 43200000) / 1000,
      analyst: Number(process.env.AGENT_ANALYST_HEARTBEAT_MS || 21600000) / 1000,
      learner: Number(process.env.AGENT_LEARNER_HEARTBEAT_MS || 28800000) / 1000,
      executor: Number(process.env.AGENT_EXECUTOR_HEARTBEAT_MS || 300000) / 1000,
      "trading-monitor": Number(process.env.AGENT_TRADING_MONITOR_HEARTBEAT_MS || 300000) / 1000,
    };

    for (const a of agents) {
      const expectedInterval = heartbeats[a.agent_id] || 3600;
      const maxAge = expectedInterval * 2.5; // dead if 2.5x overdue

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

    if (dead.length > 0) {
      summary += ` | Dead: ${dead.join(", ")}`;
    }
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
// TRADING JOURNAL (shared file for briefings)
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
  const { hour, minute, dateStr, dayOfWeek } = now();

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
      sendTelegramDirect(`\u26A0 *Heartbeat:* ${event.description} a echoue: ${err}`);
    }
  }
}

// ═══════════════════════════════════════════
// MAIN TICK
// ═══════════════════════════════════════════

let tickCount = 0;

// State persistence — readable by Kingston via files.read
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

const heartbeatStartedAt = new Date().toISOString();

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
      startedAt: heartbeatStartedAt,
    };

    // Merge existing state for tasks not run this tick
    try {
      const existing = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")) as HeartbeatState;
      state.tasks = existing.tasks || {};
      state.briefings = existing.briefings || {};
    } catch { /* first run */ }

    // Update tasks that ran this tick
    for (const [name, result] of Object.entries(taskResults)) {
      state.tasks[name] = { lastRun: new Date().toISOString(), ...result };
    }

    // Update briefings
    for (const [key, dateStr] of Object.entries(firedToday)) {
      state.briefings[key] = { firedAt: dateStr, ok: true };
    }

    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch { /* best effort */ }
}

async function tick(): Promise<void> {
  tickCount++;
  const nowMs = Date.now();
  const { timeStr } = now();
  const taskResults: Record<string, { ok: boolean; summary: string; alert?: string }> = {};
  let ran = 0;
  let skipped = 0;
  let failed = 0;

  // Run briefings check (with 60s timeout to prevent tick stall)
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

    // Skip market-hours-only tasks when market is closed
    if (task.marketHoursOnly && !isMarketOpen()) {
      skipped++;
      // Log once per 30 min that market is closed
      if (tickCount % 30 === 1) {
        logConsole(task.icon, task.name, `Market closed (${timeStr} ET)`);
      }
      continue;
    }

    // Check if interval elapsed
    const elapsedMin = (nowMs - task.lastRun) / 60_000;
    if (task.lastRun > 0 && elapsedMin < task.intervalMin) {
      skipped++;
      continue;
    }

    task.lastRun = nowMs;

    try {
      const TASK_TIMEOUT_MS = 45_000; // 45s max per task
      const result = await Promise.race([
        task.handler(),
        new Promise<TaskResult>((_, reject) =>
          setTimeout(() => reject(new Error(`task timeout after ${TASK_TIMEOUT_MS / 1000}s`)), TASK_TIMEOUT_MS)
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

  // Flush delivery queue (retry failed briefings)
  try {
    const { flushDeliveryQueue } = await import("./scheduler/briefings.js");
    const queueResult = await flushDeliveryQueue();
    if (queueResult.sent > 0 || queueResult.failed > 0) {
      logConsole("\u{1F4E8}", "delivery-queue", `Flushed: ${queueResult.sent} sent, ${queueResult.failed} failed`);
    }
  } catch { /* delivery queue not critical */ }

  // Tick summary (every tick)
  if (ran > 0 || failed > 0) {
    logConsole("\u{1F49A}", "tick", `#${tickCount}: ${ran} OK, ${failed} fail, ${skipped} skip`);
  }

  // Save state for Kingston to read
  saveState(taskResults);
}

// ═══════════════════════════════════════════
// TEST MODE
// ═══════════════════════════════════════════

async function runTestMode(): Promise<void> {
  console.log("\n=== KINGSTON HEARTBEAT \u2014 TEST MODE ===\n");

  // Test Telegram
  const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID || process.env.ADMIN_CHAT_ID;
  const token = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
  console.log(`Telegram: chatId=${chatId ? "OK" : "MISSING"}, token=${token ? "OK" : "MISSING"}`);

  if (chatId && token) {
    const testOk = await sendTelegramDirect("*Kingston Heartbeat* \u2014 test en cours...");
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
  let failed = 0;
  for (const event of BRIEFINGS) {
    process.stdout.write(`  \u{1F514} ${event.description.padEnd(30)} `);
    try {
      await event.handler();
      success++;
      console.log("OK");
    } catch (err) {
      failed++;
      console.log(`FAIL: ${err}`);
    }
  }

  console.log(`\n=== DONE: ${success} briefings sent, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
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
  // Suppress EPIPE flood — happens when parent pipe dies
  if (err?.code === "EPIPE") return;
  logConsole("\u274C", "exception", `Uncaught: ${err.message}`);
  logFile(`UNCAUGHT: ${err.message}`);
});

process.on("unhandledRejection", (reason) => {
  logConsole("\u274C", "rejection", `Unhandled: ${reason}`);
  logFile(`UNHANDLED: ${reason}`);
});

// ═══════════════════════════════════════════
// STARTUP BANNER
// ═══════════════════════════════════════════

const { timeStr, fullDate } = now();

const briefingTimes = BRIEFINGS.map((b) => {
  const m = b.minute ?? 0;
  return m > 0 ? `${b.hour}h${String(m).padStart(2, "0")}` : `${b.hour}h`;
}).join(" - ");

console.log("");
console.log("\u2550".repeat(50));
console.log("  KINGSTON HEARTBEAT v1.0");
console.log("  Supervisor + Monitor + Electroshock");
console.log("\u2550".repeat(50));
console.log(`  ${fullDate}`);
console.log(`  ${timeStr} ET (${TZ})`);
console.log("");
console.log(`  Bot:       ${kingstonStatus}`);
console.log(`  Briefings: ${briefingTimes}`);
console.log(`  Tasks:     ${tasks.length} registered, tick every ${TICK_MS / 1000}s`);
console.log("\u2550".repeat(50));
console.log("");

// ═══════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════

if (process.argv.includes("--test")) {
  runTestMode();
} else {
  // Prevent multiple heartbeat instances
  if (!acquireHeartbeatLock()) {
    console.error("\n❌ Another heartbeat instance is already running. Exiting.\n");
    process.exit(1);
  }

  // Kill rival supervisors (launcher.ts or stale heartbeat.ts)
  killRivalSupervisors();

  // Start bot
  startKingston();

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

  logConsole("\u{1F49A}", "heartbeat", "Running. Ctrl+C to stop.");

  // Notify on Telegram that heartbeat started
  sendTelegramDirect(
    `\u{1F49A} *Kingston Heartbeat* demarre (${timeStr} ET)\n` +
    `Tasks: ${tasks.length} | Briefings: ${briefingTimes}\n` +
    `Tick: ${TICK_MS / 1000}s`,
  );
}
