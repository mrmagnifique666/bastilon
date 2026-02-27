/**
 * claude-telegram-relay — Entry point
 *
 * Inspired by: https://github.com/godagoo/claude-telegram-relay
 * Original code, written from scratch.
 *
 * Connects Telegram chats to a local Claude Code CLI instance.
 */
import { config, watchEnv, validateEnv } from "./config/env.js";
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
import { readFromNoah, sendToNoah } from "./skills/builtin/noah-bridge.js";
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

      // On Windows, crashed processes can leave zombie PIDs that respond to kill(0)
      // If the lock is older than 10 minutes AND the heartbeat just started us,
      // treat it as stale regardless of PID check
      const lockAge = Date.now() - new Date(lock.timestamp).getTime();
      const MAX_LOCK_AGE_MS = 10 * 60_000; // 10 minutes
      const launchedByHeartbeat = !!process.env.__KINGSTON_LAUNCHER;

      if (isPidAlive(lock.pid) && !(launchedByHeartbeat && lockAge > MAX_LOCK_AGE_MS)) {
        console.error(
          `Another instance is already running (PID ${lock.pid}, started ${lock.timestamp}).\n` +
          `If this is incorrect, delete ${LOCK_FILE} and try again.`
        );
        process.exit(1);
      }

      if (launchedByHeartbeat && lockAge > MAX_LOCK_AGE_MS) {
        log.warn(`Removing stale lock file (PID ${lock.pid}, age ${Math.round(lockAge / 1000)}s — launched by heartbeat)`);
      } else {
        log.warn(`Removing stale lock file (PID ${lock.pid} is not running)`);
      }
    } catch {
      log.warn("Removing unreadable lock file");
    }
    try { fs.unlinkSync(LOCK_FILE); } catch { /* best effort */ }
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
  // Write crash diagnostics to file (console.error can be lost if pipes close before flush)
  const crashFile = path.resolve("relay/crash-report.txt");
  function writeCrashDiag(label: string, detail: string) {
    try {
      const line = `[${new Date().toISOString()}] [${label}] PID ${process.pid}: ${detail}\n`;
      fs.appendFileSync(crashFile, line);
    } catch { /* best effort */ }
  }

  // Trace ALL exits
  process.on("exit", (code) => {
    if (code !== 0) {
      const msg = `Kingston exiting with code ${code}`;
      console.error(`[EXIT] ${msg}`);
      writeCrashDiag("EXIT", `${msg}\nStack: ${new Error().stack}`);
    }
  });
  // Catch unhandled errors
  // uncaughtException: crash hard so the wrapper can restart cleanly (truly broken state)
  process.on("uncaughtException", (err) => {
    const msg = `Uncaught exception: ${err?.message || err}\n${err?.stack || ""}`;
    log.error(`[FATAL] ${msg}`);
    writeCrashDiag("FATAL", msg);
    process.exit(1);
  });
  // unhandledRejection: LOG but do NOT crash — transient network errors (Ollama, APIs)
  // are the #1 cause and crashing is worse than continuing with degraded service
  let rejectionCount = 0;
  process.on("unhandledRejection", (reason) => {
    rejectionCount++;
    const msg = reason instanceof Error ? `${reason.message}\n${reason.stack}` : String(reason);
    log.warn(`[WARN] Unhandled promise rejection (#${rejectionCount}): ${msg}`);
    writeCrashDiag("REJECTION", `#${rejectionCount}: ${msg}`);
    // Only crash if we see a flood of rejections (indicates a real systemic issue)
    if (rejectionCount > 50) {
      log.error(`[FATAL] Too many unhandled rejections (${rejectionCount}) — restarting`);
      writeCrashDiag("FATAL", `Too many rejections (${rejectionCount})`);
      process.exit(1);
    }
  });
  // Reset rejection counter every 5 minutes
  setInterval(() => { rejectionCount = 0; }, 5 * 60_000);

  // Validate env vars early
  validateEnv();

  // Process any pending code requests from Kingston
  await processCodeRequests();

  // Create organized upload directories
  const { ensureUploadDirs } = await import("./utils/uploads.js");
  ensureUploadDirs();

  // Load skills
  await loadBuiltinSkills();

  // Load hooks (after skills so they can use the skill registry)
  await import("./hooks/builtin/session-memory.js");

  // Load hook plugins (auto-discover from src/hooks/plugins/)
  const { loadPlugins } = await import("./hooks/hooks.js");
  const pluginsLoaded = await loadPlugins();
  if (pluginsLoaded > 0) log.info(`[hooks] Loaded ${pluginsLoaded} plugin(s)`);

  // Ollama: auto-start + health check — MUST complete before agents start
  // Expose globally so agents/compaction can skip Ollama calls when not available
  (globalThis as any).__ollamaReady = false;
  let ollamaReady = false;
  if (config.ollamaEnabled) {
    try {
      const alreadyUp = await isOllamaAvailable();
      if (alreadyUp) {
        log.info(`[ollama] 🦙 Ollama already running (${config.ollamaModel} at ${config.ollamaUrl})`);
        ollamaReady = true;
        (globalThis as any).__ollamaReady = true;
      } else {
        log.info("[ollama] Starting ollama serve...");
        const child = execFile("ollama", ["serve"], { detached: true, stdio: "ignore", windowsHide: true });
        child.unref();
        // Wait up to 15s for Ollama to be ready (was 10s — too aggressive)
        for (let i = 0; i < 15; i++) {
          await new Promise(r => setTimeout(r, 1000));
          if (await isOllamaAvailable()) {
            log.info(`[ollama] 🦙 Ollama started (${config.ollamaModel} at ${config.ollamaUrl})`);
            ollamaReady = true;
            (globalThis as any).__ollamaReady = true;
            break;
          }
        }
        if (!ollamaReady) {
          log.warn(`[ollama] Ollama not reachable after 15s — agents will use fallback models`);
        }
      }
    } catch (err) {
      log.warn(`[ollama] Auto-start failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Migrate notes to semantic memory (one-time, non-blocking)
  migrateNotesToMemories().catch(err =>
    log.warn(`[semantic] Migration failed: ${err instanceof Error ? err.message : String(err)}`)
  );

  // Watch .env for hot-reload
  watchEnv();

  // Cleanup stale database entries on startup + daily at 4am
  cleanupDatabase();
  setInterval(() => {
    const hour = new Date().getHours();
    if (hour === 4) cleanupDatabase();
  }, 3600_000); // Check every hour, run at 4am

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

  // Noah Bridge — poll inbox every 5 seconds, forward new messages to Nicolas via Telegram
  setInterval(async () => {
    try {
      const msgs = readFromNoah();
      for (const m of msgs) {
        const label = m.type === 'ping' ? '📡 PING de Noah' : m.type === 'pong' ? '🏓 PONG de Noah' : '💬 Noah dit';
        const text = `${label} :\n${m.msg}`;
        log.info(`[noah-bridge] Nouveau message : ${m.msg}`);
        // Auto-pong si c'est un ping
        if (m.type === 'ping') {
          sendToNoah('PONG', 'pong');
          log.info('[noah-bridge] PONG envoyé automatiquement');
        }
        // Forward au Telegram de Nicolas
        const chatId = config.voiceUserId || config.adminChatId;
        if (chatId) {
          const { getBotSendFn } = await import('./skills/builtin/telegram.js').catch(() => ({ getBotSendFn: null }));
          if (getBotSendFn) {
            const sendFn = (getBotSendFn as any)();
            if (sendFn) await sendFn(String(chatId), text);
          }
        }
      }
    } catch (err) {
      log.warn(`[noah-bridge] Erreur polling : ${err instanceof Error ? err.message : String(err)}`);
    }
  }, 5_000);

  const telegramEnabled = config.telegramEnabled && !!config.telegramToken;
  if (!telegramEnabled) {
    log.warn("[telegram] Disabled (TELEGRAM_ENABLED=false or TELEGRAM_BOT_TOKEN missing). Dashboard remains available.");
    return;
  }

  // Create and start Telegram bot (long polling) with resilient reconnection.
  try {
    const bot = createBot();
    log.info("Starting Telegram long polling...");

    const startPolling = (attempt = 0) => {
      bot.start({
        onStart: (botInfo) => {
          log.info(`Bot online as @${botInfo.username} (id: ${botInfo.id})`);
          attempt = 0; // reset on success
        },
      }).catch((err) => {
        const errMsg = err instanceof Error ? err.message : String(err);

        // Fatal errors: bad token or bot not found — exit for wrapper to restart cleanly
        const isFatal = errMsg.includes("401") || errMsg.includes("Not Found");
        if (isFatal) {
          log.error(`[telegram] Fatal error (bad token?): ${errMsg} — exiting`);
          process.exit(1);
        }

        const delay = Math.min(5000 * Math.pow(2, attempt), 300_000); // 5s → 5min max
        log.error(`[telegram] Polling stopped: ${errMsg}. Retry in ${delay / 1000}s (attempt ${attempt + 1})`);
        setTimeout(() => startPolling(attempt + 1), delay);
      });
    };
    startPolling();
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
