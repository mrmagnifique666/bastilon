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
        if (pid > 0 && pid !== process.pid) {
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
      // Kill launcher.ts processes that aren't us
      if (line.includes("launcher.ts") && !line.includes("heartbeat")) {
        const parts = line.split(",");
        const pid = Number(parts[parts.length - 1]?.trim());
        if (pid > 0 && pid !== process.pid) {
          try {
            process.kill(pid, "SIGTERM");
            logConsole("\u26A1", "cleanup", `Killed rival launcher.ts (PID ${pid})`);
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

    const child = spawn("npx", ["tsx", ENTRY_POINT], {
      stdio: "inherit",
      shell: true,
      cwd: process.cwd(),
      env: launchEnv,
      windowsHide: true,
    });

    kingston = child;
    kingstonPID = child.pid ?? 0;
    kingstonStatus = "running";
    startInProgress = false; // Reset guard once process is spawned

    child.on("exit", (code) => {
      const uptime = formatUptime(Date.now() - kingstonStartTime);

    if (code === 0) {
      logConsole("\u2705", "bot.stop", `Kingston stopped cleanly after ${uptime}`);
      kingstonStatus = "stopped";
      cleanLock();
      process.exit(0);
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
  // Check PID from lock file
  let pid = kingstonPID;
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const raw = fs.readFileSync(LOCK_FILE, "utf-8").trim();
      const parsed = Number(raw);
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
// TASK: trading.bracket-manager — ATR-based brackets
// Ensures every open position has stop-loss & take-profit
// Strategy: Kingston ATR-Based v1
//   SL = 1.5x ATR | TP = 3x ATR | Scale out: 50% at 2x ATR
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
      return { ok: true, summary: "No positions — no brackets needed" };
    }

    // 2. Fetch open orders to see which positions already have brackets
    const ordResp = await fetch(`${ALPACA_BASE}/v2/orders?status=open&limit=100`, {
      headers, signal: AbortSignal.timeout(8000),
    });
    const openOrders = ordResp.ok ? ((await ordResp.json()) as any[]) : [];

    // Build set of symbols that have SL or TP orders
    const coveredSymbols = new Set<string>();
    for (const ord of openOrders) {
      if (ord.order_class === "oto" || ord.order_class === "bracket" || ord.order_class === "oco") {
        coveredSymbols.add(ord.symbol);
      }
      // Also count any stop or limit sell as coverage
      if ((ord.type === "stop" || ord.type === "limit") && ord.side === "sell") {
        coveredSymbols.add(ord.symbol);
      }
      // Short positions: buy orders cover them
      if ((ord.type === "stop" || ord.type === "limit") && ord.side === "buy") {
        coveredSymbols.add(ord.symbol);
      }
    }

    const bracketState = loadBracketState();
    const actions: string[] = [];
    let alert: string | undefined;

    // 3. For each uncovered position, calculate ATR and place bracket
    for (const pos of positions) {
      const sym = pos.symbol;
      const qty = Math.abs(parseInt(pos.qty));
      const side = parseInt(pos.qty) > 0 ? "long" : "short";
      const entryPrice = parseFloat(pos.avg_entry_price);

      if (coveredSymbols.has(sym)) {
        continue; // Already has bracket orders
      }

      // Fetch 14-day bars for ATR calculation
      // CRITICAL: Alpaca requires 'start' param or it returns only today's bar
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - 30); // 30 calendar days to get ~14 trading days
      const startStr = startDate.toISOString().split("T")[0];
      const barsUrl = `${ALPACA_DATA_BASE}/v2/stocks/${sym}/bars?timeframe=1Day&limit=15&start=${startStr}`;
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

      // Calculate ATR (Average True Range) over available bars
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
      const atr = atrSum / atrCount;

      // Kingston ATR-Based v1 strategy
      // SL: 1.5x ATR from entry | TP: 3x ATR from entry
      let stopPrice: number;
      let takeProfitPrice: number;

      if (side === "long") {
        stopPrice = Math.round((entryPrice - 1.5 * atr) * 100) / 100;
        takeProfitPrice = Math.round((entryPrice + 3.0 * atr) * 100) / 100;
      } else {
        // Short position: reversed
        stopPrice = Math.round((entryPrice + 1.5 * atr) * 100) / 100;
        takeProfitPrice = Math.round((entryPrice - 3.0 * atr) * 100) / 100;
      }

      // Place OTO (one-triggers-other) with SL and TP as separate GTC orders
      // Place stop-loss
      const slSide = side === "long" ? "sell" : "buy";
      const slOrder = {
        symbol: sym,
        qty: qty,
        side: slSide,
        type: "stop",
        stop_price: stopPrice,
        time_in_force: "gtc",
      };

      const slResp = await fetch(`${ALPACA_BASE}/v2/orders`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(slOrder),
        signal: AbortSignal.timeout(8000),
      });

      // Place take-profit
      const tpOrder = {
        symbol: sym,
        qty: qty,
        side: slSide,
        type: "limit",
        limit_price: takeProfitPrice,
        time_in_force: "gtc",
      };

      const tpResp = await fetch(`${ALPACA_BASE}/v2/orders`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(tpOrder),
        signal: AbortSignal.timeout(8000),
      });

      const slOk = slResp.ok;
      const tpOk = tpResp.ok;

      if (slOk && tpOk) {
        const slData = (await slResp.json()) as any;
        const tpData = (await tpResp.json()) as any;
        bracketState[sym] = {
          side,
          entry: entryPrice,
          atr: Math.round(atr * 100) / 100,
          stopLoss: stopPrice,
          takeProfit: takeProfitPrice,
          slOrderId: slData.id,
          tpOrderId: tpData.id,
          placedAt: new Date().toISOString(),
        };
        actions.push(`${sym}: SL=$${stopPrice} TP=$${takeProfitPrice} (ATR=$${atr.toFixed(2)})`);
        alert = `\u{1F3AF} Bracket plac\u00E9 ${sym} ${side}: SL=$${stopPrice}, TP=$${takeProfitPrice}`;
      } else {
        const slErr = !slOk ? await slResp.text() : "";
        const tpErr = !tpOk ? await tpResp.text() : "";
        actions.push(`${sym}: order failed (SL:${slOk ? "ok" : slErr.slice(0, 50)}, TP:${tpOk ? "ok" : tpErr.slice(0, 50)})`);
      }
    }

    saveBracketState(bracketState);

    // Update trading journal with bracket info
    const journal = loadJournal();
    journal.brackets = bracketState;
    saveJournal(journal);

    const summary = actions.length > 0
      ? actions.join(" | ")
      : `${positions.length} pos covered`;

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
      signal: AbortSignal.timeout(8000),
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
// TASK: trading.daytrader — invoke crypto-daytrader.cjs
// ═══════════════════════════════════════════

registerTask("trading.daytrader", "\u{1F916}", 5, async () => {
  if (!fs.existsSync(DAYTRADER_SCRIPT)) {
    return { ok: false, summary: "Script not found" };
  }

  return new Promise<TaskResult>((resolve) => {
    const child = spawn("node", [DAYTRADER_SCRIPT], {
      cwd: DATA_DIR,
      timeout: 30_000,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));

    child.on("exit", (code) => {
      if (code === 0) {
        // Read state to get summary
        try {
          const statePath = path.join(DATA_DIR, "crypto-daytrader-state.json");
          if (fs.existsSync(statePath)) {
            const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
            const posCount = state.openPositions?.length || 0;
            const balance = state.totalBalance?.toFixed(0) || "?";
            resolve({ ok: true, summary: `${posCount} position${posCount !== 1 ? "s" : ""}, balance $${balance}` });
            return;
          }
        } catch { /* fall through */ }
        resolve({ ok: true, summary: stdout.trim().slice(0, 100) || "OK" });
      } else {
        resolve({ ok: false, summary: `Exit ${code}: ${stderr.trim().slice(0, 100)}` });
      }
    });

    child.on("error", (err) => {
      resolve({ ok: false, summary: `Spawn error: ${err.message}` });
    });
  });
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

  // Run briefings check
  await checkBriefings();

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
      const result = await task.handler();
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
  // Kill rival supervisors (launcher.ts) before starting
  killRivalSupervisors();

  // Start bot
  startKingston();

  // First tick after 10s (let Kingston start)
  setTimeout(
    () => tick().catch((e) => logConsole("\u274C", "tick", `Error: ${e}`)),
    10_000,
  );

  // Regular tick every 60s
  setInterval(
    () => tick().catch((e) => logConsole("\u274C", "tick", `Error: ${e}`)),
    TICK_MS,
  );

  logConsole("\u{1F49A}", "heartbeat", "Running. Ctrl+C to stop.");

  // Notify on Telegram that heartbeat started
  sendTelegramDirect(
    `\u{1F49A} *Kingston Heartbeat* demarre (${timeStr} ET)\n` +
    `Tasks: ${tasks.length} | Briefings: ${briefingTimes}\n` +
    `Tick: ${TICK_MS / 1000}s`,
  );
}
