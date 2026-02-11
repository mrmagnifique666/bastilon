/**
 * Auto-launches the XTTS Python microservice as a child process.
 * Monitors health and restarts if needed.
 */
import { spawn, ChildProcess } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { config } from "../config/env.js";
import { log } from "../utils/log.js";

let xttsProcess: ChildProcess | null = null;
let restartCount = 0;
const MAX_RESTARTS = 3;

const XTTS_DIR = path.resolve(process.cwd(), "src", "voice", "xtts");
const VENV_PYTHON = path.join(XTTS_DIR, ".venv", "Scripts", "python.exe");
const SERVER_SCRIPT = path.join(XTTS_DIR, "server.py");

/** Check if the XTTS venv is set up. */
function isXttsInstalled(): boolean {
  return fs.existsSync(VENV_PYTHON) && fs.existsSync(SERVER_SCRIPT);
}

/** Start the XTTS Python server as a background process. */
export function startXttsServer(): void {
  if (!config.xttsEnabled) {
    log.info("[xtts] XTTS server disabled (XTTS_ENABLED=false)");
    return;
  }

  if (!isXttsInstalled()) {
    log.info("[xtts] XTTS not installed (no venv found) — skipping auto-start");
    log.info("[xtts] To install: cd src/voice/xtts && py -3.12 -m venv .venv && .venv\\Scripts\\pip install -r requirements.txt");
    return;
  }

  if (xttsProcess) {
    log.warn("[xtts] Server already running");
    return;
  }

  log.info(`[xtts] Starting XTTS server on port ${config.xttsPort}...`);

  const env = { ...process.env, XTTS_PORT: String(config.xttsPort) };

  xttsProcess = spawn(VENV_PYTHON, [SERVER_SCRIPT], {
    cwd: XTTS_DIR,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  xttsProcess.stdout?.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    if (line) log.info(`[xtts] ${line}`);
  });

  xttsProcess.stderr?.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    if (line) log.warn(`[xtts] ${line}`);
  });

  xttsProcess.on("exit", (code) => {
    log.warn(`[xtts] Server exited with code ${code}`);
    xttsProcess = null;

    if (restartCount < MAX_RESTARTS) {
      restartCount++;
      const delay = restartCount * 5000;
      log.info(`[xtts] Restarting in ${delay / 1000}s (attempt ${restartCount}/${MAX_RESTARTS})`);
      setTimeout(() => startXttsServer(), delay);
    } else {
      log.error(`[xtts] Max restarts reached (${MAX_RESTARTS}) — giving up. Edge TTS will be used as fallback.`);
    }
  });

  xttsProcess.on("error", (err) => {
    log.error(`[xtts] Failed to start: ${err.message}`);
    xttsProcess = null;
  });
}

/** Stop the XTTS server. */
export function stopXttsServer(): void {
  if (xttsProcess) {
    log.info("[xtts] Stopping server...");
    xttsProcess.kill("SIGTERM");
    xttsProcess = null;
    restartCount = MAX_RESTARTS; // prevent auto-restart
  }
}

/** Check if XTTS server process is running. */
export function isXttsRunning(): boolean {
  return xttsProcess !== null && !xttsProcess.killed;
}
