/**
 * Kingston Launcher — Process Supervisor & Deterministic Scheduler
 *
 * The main entry point for Kingston. Manages the bot process and
 * fires critical scheduled tasks independently of the bot.
 *
 * Features:
 * - Accurate timezone clock (America/Toronto)
 * - Deterministic briefings at 6h30, 11h50, 16h20, 20h (no LLM dependency)
 * - Crash recovery with rapid-crash detection + auto-recovery cooldown
 * - Status logging every 15 minutes
 * - Telegram alerts on crash/recovery
 * - Briefings fire even if Kingston is down
 *
 * Usage:
 *   npm run dev              — start launcher + Kingston
 *   npx tsx src/launcher.ts  — same
 *   npx tsx src/launcher.ts --test  — fire all briefings NOW and exit
 */
import { spawn, execSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

// Load .env for Telegram/API credentials (needed for briefings & alerts)
dotenv.config();

// ─── Constants ───

const TZ = "America/Toronto";
const TICK_MS = 60_000;
const RESTART_CODE = 42;
const CRASH_DELAY_MS = 5_000;
const RESTART_DELAY_MS = 1_500;
const MAX_RAPID_CRASHES = 5;
const RAPID_CRASH_WINDOW_MS = 60_000;
const RECOVERY_DELAY_MS = 10 * 60_000; // 10 minutes cooldown after crash loop
const STALE_PORTS = [3100, 3200];
const ENTRY_POINT = path.resolve("src/index.ts");
const LOCK_FILE = path.resolve("relay/bot.lock");

// ─── State ───

let kingston: ChildProcess | null = null;
let kingstonStatus: "starting" | "running" | "crashed" | "restarting" | "stopped" = "stopped";
let kingstonStartTime = 0;
const crashTimes: number[] = [];
const firedToday: Record<string, string> = {}; // event key → dateStr of last fire
let recoveryTimer: ReturnType<typeof setTimeout> | null = null;
let tickCount = 0;

// ─── Time ───

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

// ─── Logging ───

function log(level: "info" | "warn" | "error" | "debug", msg: string): void {
  const { timeStr, dateStr } = now();
  const icon =
    level === "info" ? "\u2139" : level === "warn" ? "\u26A0" : level === "error" ? "\u2716" : "\u00B7";
  console.log(`${icon} [${dateStr} ${timeStr}] [launcher] ${msg}`);
}

function formatUptime(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec >= 3600) return `${Math.floor(sec / 3600)}h${Math.floor((sec % 3600) / 60)}m`;
  if (sec >= 60) return `${Math.floor(sec / 60)}m${sec % 60}s`;
  return `${sec}s`;
}

// ─── Telegram Direct Send (for launcher alerts) ───

async function sendTelegramDirect(text: string): Promise<boolean> {
  const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID || process.env.ADMIN_CHAT_ID;
  const token = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
  if (!chatId || !token) return false;
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

// ─── Port & Lock Cleanup ───

function cleanLock(): void {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      fs.unlinkSync(LOCK_FILE);
      log("debug", "Cleaned lock file");
    }
  } catch {
    /* best-effort */
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
        if (pid > 0 && pid !== process.pid) {
          try {
            process.kill(pid, "SIGTERM");
            log("info", `Killed stale process on port ${port} (PID ${pid})`);
          } catch {
            /* already dead */
          }
        }
      }
    } catch {
      /* port not in use */
    }
  }
}

// ─── Kingston Process Management ───

function startKingston(): void {
  cleanLock();
  cleanPorts();

  kingstonStatus = "starting";
  kingstonStartTime = Date.now();
  log("info", "Starting Kingston...");

  // Strip Claude Code env vars to prevent nested session issues
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
  kingstonStatus = "running";

  child.on("exit", (code) => {
    const uptime = formatUptime(Date.now() - kingstonStartTime);

    // Clean shutdown
    if (code === 0) {
      log("info", `Kingston stopped cleanly after ${uptime}`);
      kingstonStatus = "stopped";
      cleanLock();
      process.exit(0);
    }

    // Restart requested (system.restart skill)
    if (code === RESTART_CODE) {
      log("info", `Restart requested after ${uptime} — restarting in 1.5s...`);
      kingstonStatus = "restarting";
      cleanLock();
      setTimeout(startKingston, RESTART_DELAY_MS);
      return;
    }

    // Crash — check for rapid crash loop
    const t = Date.now();
    crashTimes.push(t);
    while (crashTimes.length > 0 && crashTimes[0] < t - RAPID_CRASH_WINDOW_MS) {
      crashTimes.shift();
    }

    if (crashTimes.length >= MAX_RAPID_CRASHES) {
      log(
        "error",
        `${MAX_RAPID_CRASHES} crashes in ${RAPID_CRASH_WINDOW_MS / 1000}s — entering cooldown. Uptime: ${uptime}`,
      );
      kingstonStatus = "crashed";
      cleanLock();

      // Notify Nicolas
      sendTelegramDirect(
        `\u{1F534} *Kingston crash loop*\n${MAX_RAPID_CRASHES} crashes rapides.\nLe launcher continue pour les briefings.\nRecovery dans 10 minutes.`,
      );

      // Schedule recovery attempt after cooldown
      if (recoveryTimer) clearTimeout(recoveryTimer);
      recoveryTimer = setTimeout(() => {
        log("info", "Recovery attempt — restarting Kingston after 10min cooldown");
        crashTimes.length = 0;
        startKingston();
      }, RECOVERY_DELAY_MS);
      return;
    }

    log(
      "warn",
      `Kingston crashed (exit ${code}) after ${uptime}. Restarting in ${CRASH_DELAY_MS / 1000}s... (${crashTimes.length}/${MAX_RAPID_CRASHES})`,
    );
    kingstonStatus = "crashed";
    cleanLock();
    setTimeout(startKingston, CRASH_DELAY_MS);
  });

  child.on("error", (err) => {
    log("error", `Failed to spawn Kingston: ${err.message}`);
    kingstonStatus = "crashed";
    cleanLock();
    setTimeout(startKingston, CRASH_DELAY_MS);
  });
}

// ─── Deterministic Briefings (lazy-loaded) ───

type BriefingsModule = typeof import("./scheduler/briefings.js");
let briefingsModule: BriefingsModule | null = null;

async function loadBriefings(): Promise<BriefingsModule | null> {
  if (!briefingsModule) {
    try {
      // tsx doesn't resolve .ts from .js in dynamic import() — use direct .ts path
      briefingsModule = await import("./scheduler/briefings.ts" as string);
      log("info", "Briefings module loaded");
    } catch (err) {
      log("error", `Failed to load briefings: ${err}`);
    }
  }
  return briefingsModule;
}

// ─── Scheduled Events ───

interface LauncherEvent {
  key: string;
  hour: number;
  minute?: number; // defaults to 0 — event fires when minute >= this value within the hour
  description: string;
  handler: () => Promise<void>;
  weekdayOnly?: boolean;
}

const SCHEDULED: LauncherEvent[] = [
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
    description: "Briefing du soir",
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

// ─── Main Tick ───

async function tick(): Promise<void> {
  tickCount++;
  const { hour, minute, dateStr, dayOfWeek, timeStr } = now();

  // Status log every 15 minutes
  if (minute % 15 === 0) {
    const uptime =
      kingstonStatus === "running" || kingstonStatus === "starting"
        ? formatUptime(Date.now() - kingstonStartTime)
        : "--";

    // Calculate next event
    const upcoming = SCHEDULED.filter((e) => {
      if (firedToday[e.key] === dateStr) return false;
      if (e.weekdayOnly && (dayOfWeek === 0 || dayOfWeek === 6)) return false;
      const eventMinute = e.minute ?? 0;
      return e.hour > hour || (e.hour === hour && minute < eventMinute);
    }).sort((a, b) => (a.hour * 60 + (a.minute ?? 0)) - (b.hour * 60 + (b.minute ?? 0)));

    const nextStr =
      upcoming.length > 0
        ? upcoming
            .slice(0, 3)
            .map((e) => {
              const eventMinute = e.minute ?? 0;
              const minsUntil = (e.hour - hour) * 60 + eventMinute - minute;
              const timeLabel = eventMinute > 0 ? `${e.hour}h${String(eventMinute).padStart(2, "0")}` : `${e.hour}h`;
              return `${e.description} (${timeLabel}, ${minsUntil > 0 ? `dans ${minsUntil}min` : "maintenant"})`;
            })
            .join(", ")
        : "aucun aujourd'hui";

    log("info", `${timeStr} ET | Kingston: ${kingstonStatus} (${uptime}) | Prochain: ${nextStr}`);
  }

  // Fire scheduled events (briefings)
  for (const event of SCHEDULED) {
    if (hour !== event.hour) continue;
    if (minute < (event.minute ?? 0)) continue; // wait until the target minute
    if (firedToday[event.key] === dateStr) continue;
    if (event.weekdayOnly && (dayOfWeek === 0 || dayOfWeek === 6)) continue;

    firedToday[event.key] = dateStr;
    log("info", `\u{1F514} Firing: ${event.description}`);

    try {
      await event.handler();
      // Verify the briefings module was actually loaded (catches silent null returns)
      if (!briefingsModule) {
        throw new Error("Briefings module failed to load (null)");
      }
      log("info", `\u2705 ${event.description} — sent`);
    } catch (err) {
      log("error", `${event.description} failed: ${err}`);
      sendTelegramDirect(`\u26A0 *Launcher:* ${event.description} a echoue: ${err}`);
    }
  }

}

// ─── Test Mode ───

async function runTestMode(): Promise<void> {
  console.log("\n=== KINGSTON LAUNCHER — TEST MODE ===\n");

  // Verify Telegram credentials first
  const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID || process.env.ADMIN_CHAT_ID;
  const token = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
  console.log(`Telegram: chatId=${chatId ? "OK" : "MISSING"}, token=${token ? "OK" : "MISSING"}`);
  if (!chatId || !token) {
    console.log("\nFATAL: Missing Telegram credentials. Cannot send briefings.");
    process.exit(1);
  }

  // Quick connectivity test
  console.log("Testing Telegram API...");
  const testOk = await sendTelegramDirect("*Kingston Launcher* — test briefings en cours...");
  console.log(`Telegram API: ${testOk ? "OK" : "FAILED"}\n`);
  if (!testOk) {
    console.log("FATAL: Cannot reach Telegram API.");
    process.exit(1);
  }

  console.log("Firing all briefings...\n");

  let success = 0;
  let failed = 0;
  for (const event of SCHEDULED) {
    console.log(`--- ${event.description} (${event.key}) ---`);
    try {
      await event.handler();
      success++;
      console.log(`OK\n`);
    } catch (err) {
      failed++;
      console.log(`FAIL: ${err}\n`);
    }
  }

  console.log(`=== DONE: ${success} sent, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

// ─── Signal Handling ───

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    log("info", `Received ${sig} — shutting down`);
    if (recoveryTimer) clearTimeout(recoveryTimer);
    if (kingston && !kingston.killed) {
      kingston.kill("SIGTERM");
    }
    cleanLock();
    setTimeout(() => process.exit(0), 2000);
  });
}

// Prevent unhandled errors from crashing the launcher
process.on("uncaughtException", (err) => {
  log("error", `Uncaught exception: ${err.message}`);
});
process.on("unhandledRejection", (reason) => {
  log("error", `Unhandled rejection: ${reason}`);
});

// ─── Startup ───

const { timeStr, fullDate } = now();

console.log("");
console.log("========================================");
console.log("  KINGSTON LAUNCHER v2.1");
console.log("  Process Manager & Briefings");
console.log("========================================");
console.log(`  ${fullDate}`);
console.log(`  ${timeStr} ET (${TZ})`);
console.log("");
console.log("  Briefings:   6h30 - 11h50 - 16h20 - 20h - 23h30 (journal)");
console.log("  Status:      every 15 min");
console.log("  Recovery:    auto after 10min cooldown");
console.log("========================================");
console.log("");

// Check for --test flag
if (process.argv.includes("--test")) {
  runTestMode();
} else {
  // Normal mode: start Kingston + tick loop
  startKingston();

  // First tick after 10s (let Kingston begin starting)
  setTimeout(
    () => tick().catch((e) => log("error", `tick: ${e}`)),
    10_000,
  );

  // Regular tick every 60s
  setInterval(
    () => tick().catch((e) => log("error", `tick: ${e}`)),
    TICK_MS,
  );

  log("info", "Launcher running. Ctrl+C to stop.");
}
