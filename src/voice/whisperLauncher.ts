/**
 * Auto-launches the Whisper STT Python microservice as a child process.
 * Same pattern as xttsLauncher.ts — spawn venv, health check, auto-restart.
 */
import { spawn, ChildProcess } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { config } from "../config/env.js";
import { log } from "../utils/log.js";

let whisperProcess: ChildProcess | null = null;
let restartCount = 0;
const MAX_RESTARTS = 3;

const WHISPER_DIR = path.resolve(process.cwd(), "src", "voice", "whisper");
const VENV_PYTHON = path.join(WHISPER_DIR, ".venv", "Scripts", "python.exe");
const SERVER_SCRIPT = path.join(WHISPER_DIR, "server.py");

/** Check if the Whisper venv is set up. */
function isWhisperInstalled(): boolean {
  return fs.existsSync(VENV_PYTHON) && fs.existsSync(SERVER_SCRIPT);
}

/** Start the Whisper Python server as a background process. */
export function startWhisperServer(): void {
  if (!config.whisperEnabled) {
    log.info("[whisper] Whisper server disabled (WHISPER_ENABLED=false)");
    return;
  }

  if (!isWhisperInstalled()) {
    log.info("[whisper] Whisper not installed (no venv found) — skipping auto-start");
    log.info("[whisper] To install: cd src/voice/whisper && py -3.12 -m venv .venv && .venv\\Scripts\\pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu121 && .venv\\Scripts\\pip install -r requirements.txt");
    return;
  }

  if (whisperProcess) {
    log.warn("[whisper] Server already running");
    return;
  }

  log.info(`[whisper] Starting Whisper STT on port ${config.whisperPort}...`);

  const env = {
    ...process.env,
    WHISPER_PORT: String(config.whisperPort),
    WHISPER_MODEL: config.whisperModel,
    WHISPER_COMPUTE_TYPE: config.whisperComputeType,
    WHISPER_MODEL_CACHE: config.whisperModelCache,
    WHISPER_LANGUAGE: config.whisperLanguage,
    WHISPER_RPG_MODE: config.whisperRpgMode,
    DASHBOARD_TOKEN: config.dashboardToken,
  };

  whisperProcess = spawn(VENV_PYTHON, [SERVER_SCRIPT], {
    cwd: WHISPER_DIR,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  whisperProcess.stdout?.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    if (line) log.info(`[whisper] ${line}`);
  });

  whisperProcess.stderr?.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    if (line) log.warn(`[whisper] ${line}`);
  });

  whisperProcess.on("exit", (code) => {
    log.warn(`[whisper] Server exited with code ${code}`);
    whisperProcess = null;

    if (restartCount < MAX_RESTARTS) {
      restartCount++;
      const delay = restartCount * 5000;
      log.info(`[whisper] Restarting in ${delay / 1000}s (attempt ${restartCount}/${MAX_RESTARTS})`);
      setTimeout(() => startWhisperServer(), delay);
    } else {
      log.error(`[whisper] Max restarts reached (${MAX_RESTARTS}) — giving up. Deepgram will be used as fallback.`);
    }
  });

  whisperProcess.on("error", (err) => {
    log.error(`[whisper] Failed to start: ${err.message}`);
    whisperProcess = null;
  });
}

/** Stop the Whisper server. */
export function stopWhisperServer(): void {
  if (whisperProcess) {
    log.info("[whisper] Stopping server...");
    whisperProcess.kill("SIGTERM");
    whisperProcess = null;
    restartCount = MAX_RESTARTS; // prevent auto-restart
  }
}

/** Check if Whisper server process is running. */
export function isWhisperRunning(): boolean {
  return whisperProcess !== null && !whisperProcess.killed;
}
