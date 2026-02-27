/**
 * Auto-restart wrapper for Kingston.
 * Spawns the bot as a child process and restarts it on exit.
 *
 * Exit codes:
 *   0  = clean shutdown, stop
 *   42 = restart requested (by system.restart skill)
 *   *  = crash, restart after delay
 *
 * Resilience:
 *   - Exponential backoff on rapid crashes (5s → 10s → 20s → ... → 10min max)
 *   - NEVER gives up — backs off to 10min cooldown instead of exiting
 *   - Writes crash diagnostics to relay/crash-report.txt
 *   - Uses node directly (not npx) to avoid ENOENT on Windows PATH issues
 */
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const RESTART_CODE = 42;
const BASE_CRASH_DELAY_MS = 5_000;
const MAX_CRASH_DELAY_MS = 10 * 60_000; // 10 minutes max backoff
const RESTART_DELAY_MS = 1_500;
const MAX_RAPID_CRASHES = 5;
const RAPID_CRASH_WINDOW_MS = 60_000;
const STALE_PORTS = [3100, 3200]; // voice + dashboard

const entryPoint = path.resolve("src/index.ts");
const lockFile = path.resolve("relay/bot.lock");
const crashReportFile = path.resolve("relay/crash-report.txt");
const crashTimes: number[] = [];
let consecutiveCrashes = 0;
let spawnErrors = 0;
let tsxReady = false;

function log(msg: string) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [wrapper] ${msg}`);
}

function writeCrashReport(code: number | null, uptimeStr: string, signal?: string) {
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
    fs.appendFileSync(crashReportFile, report);
  } catch { /* best-effort */ }
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

/** Calculate backoff delay with exponential increase */
function getCrashDelay(): number {
  const delay = Math.min(
    BASE_CRASH_DELAY_MS * Math.pow(2, Math.max(0, consecutiveCrashes - 1)),
    MAX_CRASH_DELAY_MS
  );
  return delay;
}

/** Resolve the tsx CLI path to avoid npx ENOENT issues on Windows */
function getTsxPath(): string {
  const localTsx = path.resolve("node_modules/.bin/tsx");
  // On Windows, .bin contains .cmd files
  const localTsxCmd = localTsx + ".cmd";
  if (process.platform === "win32" && fs.existsSync(localTsxCmd)) {
    return localTsxCmd;
  }
  if (fs.existsSync(localTsx)) {
    return localTsx;
  }
  // Fallback to npx (may fail if PATH not ready after reboot)
  return "npx";
}

/**
 * Wait for tsx to be available before spawning.
 * After a system reboot, node_modules/.bin/tsx.cmd may not be accessible
 * immediately (filesystem not ready, PATH not loaded). This polls with
 * increasing delay up to ~2 minutes total before falling back to npx.
 */
async function awaitTsxReady(): Promise<string> {
  const localTsxCmd = path.resolve("node_modules/.bin/tsx.cmd");
  const localTsx = path.resolve("node_modules/.bin/tsx");
  const delays = [1000, 2000, 3000, 5000, 8000, 10000, 15000, 20000, 30000]; // ~94s total

  for (let i = 0; i < delays.length; i++) {
    if (process.platform === "win32" && fs.existsSync(localTsxCmd)) {
      if (!tsxReady) log("tsx.cmd found — ready to spawn");
      tsxReady = true;
      return localTsxCmd;
    }
    if (fs.existsSync(localTsx)) {
      if (!tsxReady) log("tsx found — ready to spawn");
      tsxReady = true;
      return localTsx;
    }
    // Already confirmed on a previous start — skip waiting
    if (tsxReady) break;

    log(`Waiting for tsx to be available... (attempt ${i + 1}/${delays.length})`);
    await new Promise((r) => setTimeout(r, delays[i]));
  }

  // One last check before falling back
  if (process.platform === "win32" && fs.existsSync(localTsxCmd)) return localTsxCmd;
  if (fs.existsSync(localTsx)) return localTsx;

  log("tsx not found locally — falling back to npx");
  return "npx";
}

async function startBot() {
  // Clean stale state before starting
  cleanLock();
  cleanPorts();

  // Wait for tsx to be ready (handles post-reboot delays)
  const tsxPath = await awaitTsxReady();
  const useNpx = tsxPath === "npx";

  log("Starting Kingston...");

  const startTime = Date.now();

  const args = useNpx ? ["tsx", entryPoint] : [entryPoint];

  const child = spawn(tsxPath, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    cwd: process.cwd(),
    env: { ...process.env, __KINGSTON_WRAPPER: "1" },
    windowsHide: true,
  });

  child.on("exit", (code, signal) => {
    const uptimeSec = Math.round((Date.now() - startTime) / 1000);
    const uptimeStr = uptimeSec >= 3600
      ? `${Math.floor(uptimeSec / 3600)}h${Math.floor((uptimeSec % 3600) / 60)}m`
      : uptimeSec >= 60
        ? `${Math.floor(uptimeSec / 60)}m${uptimeSec % 60}s`
        : `${uptimeSec}s`;

    if (code === 0) {
      log(`Kingston stopped cleanly after ${uptimeStr}. Not restarting.`);
      consecutiveCrashes = 0;
      cleanLock();
      process.exit(0);
    }

    if (code === RESTART_CODE) {
      log(`Restart requested after ${uptimeStr} — restarting in 1.5s...`);
      consecutiveCrashes = 0;
      cleanLock();
      setTimeout(startBot, RESTART_DELAY_MS);
      return;
    }

    // Crash — track and calculate backoff
    consecutiveCrashes++;
    const now = Date.now();
    crashTimes.push(now);
    while (crashTimes.length > 0 && crashTimes[0] < now - RAPID_CRASH_WINDOW_MS) {
      crashTimes.shift();
    }

    // Write crash report for diagnostics
    writeCrashReport(code, uptimeStr, signal ?? undefined);

    // If uptime was > 5 minutes, reset consecutive crash counter (it was stable)
    if (uptimeSec > 300) {
      consecutiveCrashes = 1;
    }

    const delay = getCrashDelay();
    const delayStr = delay >= 60_000 ? `${Math.round(delay / 60_000)}min` : `${delay / 1000}s`;

    if (crashTimes.length >= MAX_RAPID_CRASHES) {
      // Instead of giving up, enter extended cooldown
      const cooldown = MAX_CRASH_DELAY_MS;
      log(`${MAX_RAPID_CRASHES} crashes in ${RAPID_CRASH_WINDOW_MS / 1000}s — cooldown ${cooldown / 60_000}min before retry. Last uptime: ${uptimeStr}`);
      crashTimes.length = 0; // reset window so we can try again
      cleanLock();
      setTimeout(startBot, cooldown);
      return;
    }

    log(`Kingston crashed (exit ${code}) after ${uptimeStr}. Restarting in ${delayStr}... (${crashTimes.length}/${MAX_RAPID_CRASHES} rapid crashes)`);
    cleanLock();
    setTimeout(startBot, delay);
  });

  child.on("error", (err) => {
    spawnErrors++;
    const isEnoent = err.message.includes("ENOENT");
    // ENOENT after reboot: use longer delays (15s base) to give the system time
    const base = isEnoent ? 15_000 : BASE_CRASH_DELAY_MS;
    const delay = Math.min(base * Math.pow(2, Math.min(spawnErrors - 1, 6)), MAX_CRASH_DELAY_MS);
    const delayStr = delay >= 60_000 ? `${Math.round(delay / 60_000)}min` : `${delay / 1000}s`;
    if (isEnoent) {
      tsxReady = false; // force re-probe on next start
      log(`Failed to spawn (${err.message}). System may be rebooting — retrying in ${delayStr}... (attempt ${spawnErrors})`);
    } else {
      log(`Failed to spawn (${err.message}). Retrying in ${delayStr}... (attempt ${spawnErrors})`);
    }
    cleanLock();
    setTimeout(() => {
      startBot();
    }, delay);
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
