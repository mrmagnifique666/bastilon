/**
 * claude-telegram-relay — Entry point
 *
 * Inspired by: https://github.com/godagoo/claude-telegram-relay
 * Original code, written from scratch.
 *
 * Connects Telegram chats to a local Claude Code CLI instance.
 */
import { config, watchEnv } from "./config/env.js";
import { setLogLevel, addRedactPattern, log } from "./utils/log.js";
import { loadBuiltinSkills } from "./skills/loader.js";
import { migrateNotesToMemories } from "./memory/semantic.js";
import { processCodeRequests } from "./processors/codequeue.js";
import { createBot } from "./bot/telegram.js";
import { startVoiceServer } from "./voice/server.js";
import { startXttsServer } from "./voice/xttsLauncher.js";
import { startScheduler, stopScheduler } from "./scheduler/scheduler.js";
import { startAgents, shutdownAgents } from "./agents/startup.js";
import { cleanupDatabase } from "./storage/store.js";
import { startDeferredQueue, stopDeferredQueue } from "./memory/deferred.js";
import { startDashboard } from "./dashboard/server.js";
import { isOllamaAvailable } from "./llm/ollamaClient.js";
import { emitHook } from "./hooks/hooks.js";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const LOCK_FILE = path.resolve(config.relayDir, "bot.lock");

interface LockData {
  pid: number;
  timestamp: string;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock(): void {
  if (fs.existsSync(LOCK_FILE)) {
    try {
      const raw = fs.readFileSync(LOCK_FILE, "utf-8");
      const lock: LockData = JSON.parse(raw);
      if (isPidAlive(lock.pid)) {
        console.error(
          `Another instance is already running (PID ${lock.pid}, started ${lock.timestamp}).\n` +
          `If this is incorrect, delete ${LOCK_FILE} and try again.`
        );
        process.exit(1);
      }
      log.warn(`Removing stale lock file (PID ${lock.pid} is not running)`);
    } catch {
      log.warn("Removing unreadable lock file");
    }
    fs.unlinkSync(LOCK_FILE);
  }

  const data: LockData = { pid: process.pid, timestamp: new Date().toISOString() };
  fs.writeFileSync(LOCK_FILE, JSON.stringify(data, null, 2));
  log.debug(`Lock file created: PID ${process.pid}`);
}

function releaseLock(): void {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const raw = fs.readFileSync(LOCK_FILE, "utf-8");
      const lock: LockData = JSON.parse(raw);
      // Only remove if it's our lock
      if (lock.pid === process.pid) {
        fs.unlinkSync(LOCK_FILE);
        log.debug("Lock file removed");
      }
    }
  } catch {
    // Best-effort cleanup
  }
}

async function main() {
  // Configure logging
  setLogLevel(config.logLevel);

  // Redact secrets from logs
  const secretsToRedact = [
    config.telegramToken,
    config.geminiApiKey,
    config.anthropicApiKey,
    config.twilioAuthToken,
    config.deepgramApiKey,
    config.elevenlabsApiKey,
    config.adminPassphrase,
    config.braveSearchApiKey,
  ];
  for (const secret of secretsToRedact) {
    if (secret && secret.length > 4) {
      addRedactPattern(new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"));
    }
  }

  log.info("Starting Bastilon OS — Kingston online...");
  log.info(`Allowed users: ${config.allowedUsers.length > 0 ? config.allowedUsers.join(", ") : "(none — all blocked!)"}`);
  log.info(`Allowed tools: ${config.allowedTools.join(", ")}`);
  log.info(`Memory turns: ${config.memoryTurns}`);
  log.info(`Rate limit: ${config.rateLimitMs}ms`);

  // Ensure directories exist
  for (const dir of [config.sandboxDir, config.relayDir, config.uploadsDir]) {
    const resolved = path.resolve(dir);
    if (!fs.existsSync(resolved)) {
      fs.mkdirSync(resolved, { recursive: true });
      log.info(`Created directory: ${resolved}`);
    }
  }

  // Acquire lock file (exits if another instance is running)
  acquireLock();

  // Register cleanup handlers with graceful shutdown
  process.on("exit", releaseLock);

  let shuttingDown = false;
  function gracefulShutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`[bastilon] ${signal} received — shutting down gracefully...`);
    shutdownAgents();
    stopScheduler();
    stopDeferredQueue().catch(() => {});
    // Give in-flight requests up to 5 seconds to complete
    setTimeout(() => {
      log.info("[bastilon] Grace period ended — exiting.");
      releaseLock();
      process.exit(0);
    }, 5000);
  }

  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  // Catch unhandled errors — prevent silent crashes
  process.on("uncaughtException", (err) => {
    log.error("[FATAL] Uncaught exception:", err);
  });
  process.on("unhandledRejection", (reason) => {
    log.error("[FATAL] Unhandled promise rejection:", reason);
  });

  // Process any pending code requests from Kingston
  await processCodeRequests();

  // Load skills
  await loadBuiltinSkills();

  // Load hooks (after skills so they can use the skill registry)
  await import("./hooks/builtin/session-memory.js");

  // Ollama: auto-start + health check
  if (config.ollamaEnabled) {
    const startOllama = async () => {
      const alreadyUp = await isOllamaAvailable();
      if (alreadyUp) {
        log.info(`[ollama] 🦙 Ollama already running (${config.ollamaModel} at ${config.ollamaUrl})`);
        return;
      }
      log.info("[ollama] Starting ollama serve...");
      const child = execFile("ollama", ["serve"], { detached: true, stdio: "ignore" });
      child.unref();
      // Wait up to 10s for Ollama to be ready
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 1000));
        if (await isOllamaAvailable()) {
          log.info(`[ollama] 🦙 Ollama started (${config.ollamaModel} at ${config.ollamaUrl})`);
          return;
        }
      }
      log.warn(`[ollama] Ollama not reachable after 10s — will fallback to Haiku`);
    };
    startOllama().catch(err =>
      log.warn(`[ollama] Auto-start failed: ${err instanceof Error ? err.message : String(err)}`)
    );
  }

  // Migrate notes to semantic memory (one-time, non-blocking)
  migrateNotesToMemories().catch(err =>
    log.warn(`[semantic] Migration failed: ${err instanceof Error ? err.message : String(err)}`)
  );

  // Watch .env for hot-reload
  watchEnv();

  // Cleanup stale database entries on startup
  cleanupDatabase();

  // Start local dashboard UI first so we always have a control plane.
  try {
    startDashboard();
  } catch (err) {
    log.error(`[dashboard] Failed to start: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Non-critical services should never prevent dashboard access.
  try {
    startVoiceServer();
  } catch (err) {
    log.warn(`[voice] Disabled due to startup error: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    startXttsServer();
  } catch (err) {
    log.warn(`[xtts] Disabled due to startup error: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Start deferred memory queue (background processing of embeddings/KG ops)
  startDeferredQueue();

  try {
    // Start scheduler with its own chatId (1) to avoid polluting Nicolas's CLI session
    // userId stays as Nicolas's so telegram.send reaches him
    startScheduler(1, config.voiceUserId);
  } catch (err) {
    log.warn(`[scheduler] Disabled due to startup error: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    startAgents();
  } catch (err) {
    log.warn(`[agents] Disabled due to startup error: ${err instanceof Error ? err.message : String(err)}`);
  }

  const telegramEnabled = config.telegramEnabled && !!config.telegramToken;
  if (!telegramEnabled) {
    log.warn("[telegram] Disabled (TELEGRAM_ENABLED=false or TELEGRAM_BOT_TOKEN missing). Dashboard remains available.");
    return;
  }

  // Create and start Telegram bot (long polling). Keep it non-fatal for dashboard mode.
  try {
    const bot = createBot();
    log.info("Starting Telegram long polling...");
    void bot.start({
      onStart: (botInfo) => {
        log.info(`Bot online as @${botInfo.username} (id: ${botInfo.id})`);
      },
    }).catch((err) => {
      log.error(`[telegram] Long polling stopped: ${err instanceof Error ? err.message : String(err)}`);
    });
  } catch (err) {
    log.error(`[telegram] Failed to start: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Emit startup hook (fire-and-forget)
  emitHook("gateway:startup", {}).catch(err =>
    log.warn(`[hooks] Startup hook error: ${err instanceof Error ? err.message : String(err)}`)
  );
}

main().catch((err) => {
  releaseLock();
  console.error("Fatal error:", err);
  process.exit(1);
});
