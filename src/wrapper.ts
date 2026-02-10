/**
 * Auto-restart wrapper for Kingston.
 * Spawns the bot as a child process and restarts it on exit.
 *
 * Exit codes:
 *   0  = clean shutdown, stop
 *   42 = restart requested (by system.restart skill)
 *   *  = crash, restart after delay
 */
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const RESTART_CODE = 42;
const CRASH_DELAY_MS = 5000;
const RESTART_DELAY_MS = 1500;
const MAX_RAPID_CRASHES = 5;
const RAPID_CRASH_WINDOW_MS = 60_000;
const STALE_PORTS = [3100, 3200]; // voice + dashboard

const entryPoint = path.resolve("src/index.ts");
const lockFile = path.resolve("relay/bot.lock");
const crashTimes: number[] = [];

function log(msg: string) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [wrapper] ${msg}`);
}

function cleanLock() {
  try {
    if (fs.existsSync(lockFile)) {
      fs.unlinkSync(lockFile);
      log("Cleaned lock file");
    }
  } catch {
    // best-effort
  }
}

/** Kill stale node processes holding voice/dashboard ports */
function cleanPorts() {
  if (process.platform !== "win32") return;
  for (const port of STALE_PORTS) {
    try {
      const out = execSync(
        `powershell -Command "Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess"`,
        { encoding: "utf-8", timeout: 5000 }
      ).trim();
      if (!out) continue;
      for (const pidStr of out.split(/\r?\n/)) {
        const pid = Number(pidStr.trim());
        if (pid > 0 && pid !== process.pid) {
          try {
            process.kill(pid, "SIGTERM");
            log(`Killed stale process on port ${port} (PID ${pid})`);
          } catch { /* already dead */ }
        }
      }
    } catch {
      // port not in use — good
    }
  }
}

function startBot() {
  // Clean stale state before starting
  cleanLock();
  cleanPorts();

  log("Starting Kingston...");

  const startTime = Date.now();

  const child = spawn("npx", ["tsx", entryPoint], {
    stdio: "inherit",
    shell: true,
    cwd: process.cwd(),
  });

  child.on("exit", (code) => {
    const uptimeSec = Math.round((Date.now() - startTime) / 1000);
    const uptimeStr = uptimeSec >= 3600
      ? `${Math.floor(uptimeSec / 3600)}h${Math.floor((uptimeSec % 3600) / 60)}m`
      : uptimeSec >= 60
        ? `${Math.floor(uptimeSec / 60)}m${uptimeSec % 60}s`
        : `${uptimeSec}s`;

    if (code === 0) {
      log(`Kingston stopped cleanly after ${uptimeStr}. Not restarting.`);
      cleanLock();
      process.exit(0);
    }

    if (code === RESTART_CODE) {
      log(`Restart requested after ${uptimeStr} — restarting in 1.5s...`);
      cleanLock();
      setTimeout(startBot, RESTART_DELAY_MS);
      return;
    }

    // Crash — check for rapid crash loop
    const now = Date.now();
    crashTimes.push(now);
    while (crashTimes.length > 0 && crashTimes[0] < now - RAPID_CRASH_WINDOW_MS) {
      crashTimes.shift();
    }

    if (crashTimes.length >= MAX_RAPID_CRASHES) {
      log(`${MAX_RAPID_CRASHES} crashes in ${RAPID_CRASH_WINDOW_MS / 1000}s — giving up. Last uptime: ${uptimeStr}`);
      cleanLock();
      process.exit(1);
    }

    log(`Kingston crashed (exit ${code}) after ${uptimeStr}. Restarting in ${CRASH_DELAY_MS / 1000}s... (${crashTimes.length}/${MAX_RAPID_CRASHES} rapid crashes)`);
    cleanLock();
    setTimeout(startBot, CRASH_DELAY_MS);
  });

  child.on("error", (err) => {
    log(`Failed to spawn: ${err.message}`);
    cleanLock();
    setTimeout(startBot, CRASH_DELAY_MS);
  });
}

// Forward SIGINT/SIGTERM to stop cleanly
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    log(`Received ${sig} — shutting down.`);
    cleanLock();
    process.exit(0);
  });
}

startBot();
