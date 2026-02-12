/**
 * Base Agent class — autonomous workers with their own heartbeat loops.
 * Agents share the skill registry and SQLite with Kingston but have
 * independent identities, specialized prompts, and configurable intervals.
 *
 * Resilience features:
 * - State persistence to SQLite (survives restarts)
 * - Exponential backoff on consecutive errors
 * - Auto-disable after MAX_CONSECUTIVE_ERRORS with admin notification
 * - Audit trail: every run logged to agent_runs table
 */
import { handleMessage } from "../orchestrator/router.js";
import { getDb } from "../storage/store.js";
import { clearTurns, clearSession } from "../storage/store.js";
import { log } from "../utils/log.js";
import { broadcast } from "../dashboard/broadcast.js";
import { emitHook } from "../hooks/hooks.js";
import { isOllamaAvailable, runOllama } from "../llm/ollamaClient.js";
import { config } from "../config/env.js";
import {
  isClaudeRateLimited,
  getClaudeRateLimitReset,
  rateLimitRemainingMinutes,
  detectAndSetRateLimit,
} from "../llm/rateLimitState.js";
import { getBotSendFn } from "../skills/builtin/telegram.js";

const MAX_CONSECUTIVE_ERRORS = 5;

// Re-export for backward compatibility
export const isRateLimited = isClaudeRateLimited;
export const getRateLimitReset = getClaudeRateLimitReset;

export interface AgentConfig {
  /** Unique agent identifier (e.g. "scout", "concierge") */
  id: string;
  /** Display name */
  name: string;
  /** Short description of the agent's role */
  role: string;
  /** Heartbeat interval in milliseconds */
  heartbeatMs: number;
  /** Whether the agent is enabled */
  enabled: boolean;
  /** Telegram chat ID to route messages through */
  chatId: number;
  /** User ID for permission checks */
  userId: number;
  /** Build the heartbeat prompt — returns null to skip this cycle */
  buildPrompt: (cycle: number) => string | null;
  /** Optional: number of cycles before rotating (default: 1 — every heartbeat fires) */
  cycleCount?: number;
  /** Optional: async pre-tick hook for quantitative work (runs before LLM, no cost). sendAlert sends a Telegram message. */
  onTick?: (cycle: number, sendAlert: (msg: string) => void) => Promise<void>;
}

export type AgentStatus = "idle" | "running" | "stopped" | "error" | "backoff";

export interface AgentStats {
  id: string;
  name: string;
  role: string;
  status: AgentStatus;
  enabled: boolean;
  heartbeatMs: number;
  cycle: number;
  totalRuns: number;
  lastRunAt: number | null;
  lastError: string | null;
  consecutiveErrors: number;
  createdAt: number;
}

// --- Persistence helpers ---

interface AgentStateRow {
  agent_id: string;
  cycle: number;
  total_runs: number;
  last_run_at: number | null;
  last_error: string | null;
  consecutive_errors: number;
}

function loadState(agentId: string): AgentStateRow | null {
  try {
    const db = getDb();
    return db
      .prepare("SELECT * FROM agent_state WHERE agent_id = ?")
      .get(agentId) as AgentStateRow | undefined ?? null;
  } catch {
    return null; // table may not exist yet on first run
  }
}

function saveState(agent: Agent): void {
  try {
    const db = getDb();
    const stats = agent.getStats();
    db.prepare(
      `INSERT INTO agent_state (agent_id, cycle, total_runs, last_run_at, last_error, consecutive_errors, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, unixepoch())
       ON CONFLICT(agent_id) DO UPDATE SET
         cycle = excluded.cycle,
         total_runs = excluded.total_runs,
         last_run_at = excluded.last_run_at,
         last_error = excluded.last_error,
         consecutive_errors = excluded.consecutive_errors,
         updated_at = excluded.updated_at`
    ).run(stats.id, stats.cycle, stats.totalRuns, stats.lastRunAt, stats.lastError, stats.consecutiveErrors);
  } catch (err) {
    log.debug(`[agent:${agent.id}] Failed to save state: ${err}`);
  }
}

function logRun(agentId: string, cycle: number, startedAt: number, durationMs: number, outcome: string, errorMsg?: string): void {
  try {
    const db = getDb();
    db.prepare(
      "INSERT INTO agent_runs (agent_id, cycle, started_at, duration_ms, outcome, error_msg) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(agentId, cycle, Math.floor(startedAt / 1000), durationMs, outcome, errorMsg ?? null);

    // Push real-time event to dashboard
    broadcast("agent_run", {
      agent_id: agentId, cycle, started_at: Math.floor(startedAt / 1000),
      duration_ms: durationMs, outcome, error_msg: errorMsg ?? null,
    });
  } catch (err) {
    log.debug(`[agent:${agentId}] Failed to log run: ${err}`);
  }
}

export class Agent {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly heartbeatMs: number;
  readonly chatId: number;
  readonly userId: number;

  private enabled: boolean;
  private status: AgentStatus = "idle";
  private cycle = 0;
  private totalRuns = 0;
  private lastRunAt: number | null = null;
  private lastError: string | null = null;
  private consecutiveErrors = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private buildPrompt: (cycle: number) => string | null;
  private cycleCount: number;
  private createdAt: number;
  private running = false; // guard against overlapping runs
  private onTickHook?: (cycle: number, sendAlert: (msg: string) => void) => Promise<void>;

  constructor(config: AgentConfig) {
    this.id = config.id;
    this.name = config.name;
    this.role = config.role;
    this.heartbeatMs = config.heartbeatMs;
    this.enabled = config.enabled;
    this.chatId = config.chatId;
    this.userId = config.userId;
    this.buildPrompt = config.buildPrompt;
    this.cycleCount = config.cycleCount ?? 1;
    this.onTickHook = config.onTick;
    this.createdAt = Date.now();

    // Restore persisted state
    const saved = loadState(this.id);
    if (saved) {
      this.cycle = saved.cycle;
      this.totalRuns = saved.total_runs;
      this.lastRunAt = saved.last_run_at;
      this.lastError = saved.last_error;
      this.consecutiveErrors = saved.consecutive_errors;
      log.info(`[agent:${this.id}] Restored state — cycle ${this.cycle}, runs ${this.totalRuns}, errors ${this.consecutiveErrors}`);
    }
  }

  /** Start the agent's heartbeat loop */
  start(): void {
    if (this.timer) {
      log.warn(`[agent:${this.id}] Already running`);
      return;
    }
    if (!this.enabled) {
      log.info(`[agent:${this.id}] Disabled — not starting`);
      this.status = "stopped";
      return;
    }

    // If too many errors from previous session, reset but warn
    if (this.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      log.warn(`[agent:${this.id}] Had ${this.consecutiveErrors} consecutive errors — resetting error count`);
      this.consecutiveErrors = 0;
    }

    this.status = "idle";
    log.info(`[agent:${this.id}] Starting (${this.name}) — heartbeat every ${this.heartbeatMs / 1000}s`);

    // First tick after a short delay
    setTimeout(() => this.tick(), 10_000);

    this.timer = setInterval(() => this.tick(), this.heartbeatMs);
  }

  /** Stop the agent */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.status = "stopped";
    saveState(this);
    log.info(`[agent:${this.id}] Stopped`);
  }

  /** Enable/disable the agent */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.stop();
  }

  /** Get agent stats */
  getStats(): AgentStats {
    return {
      id: this.id,
      name: this.name,
      role: this.role,
      status: this.status,
      enabled: this.enabled,
      heartbeatMs: this.heartbeatMs,
      cycle: this.cycle,
      totalRuns: this.totalRuns,
      lastRunAt: this.lastRunAt,
      lastError: this.lastError,
      consecutiveErrors: this.consecutiveErrors,
      createdAt: this.createdAt,
    };
  }

  /** Single heartbeat tick */
  private async tick(): Promise<void> {
    if (!this.enabled || this.running) return;

    // Global rate limit: try Ollama fallback instead of skipping entirely
    if (isRateLimited()) {
      const remaining = rateLimitRemainingMinutes();

      // Check if Ollama is available as backup
      if (config.ollamaEnabled) {
        const ollamaUp = await isOllamaAvailable();
        if (ollamaUp) {
          log.info(`[agent:${this.id}] Rate limited (${remaining}min) — using Ollama fallback`);
          await this.tickOllama();
          return;
        }
      }

      log.debug(`[agent:${this.id}] Rate limited — ${remaining}min until reset, no Ollama available`);
      return;
    }

    // Exponential backoff: skip tick if in backoff period
    if (this.consecutiveErrors > 0) {
      const backoffMs = Math.min(
        Math.pow(2, this.consecutiveErrors) * 10_000, // 20s, 40s, 80s, 160s, 320s
        this.heartbeatMs * 2 // cap at 2x heartbeat
      );
      const timeSinceLastRun = Date.now() - (this.lastRunAt ?? 0);
      if (timeSinceLastRun < backoffMs) {
        this.status = "backoff";
        log.debug(`[agent:${this.id}] Backoff — ${Math.round((backoffMs - timeSinceLastRun) / 1000)}s remaining (${this.consecutiveErrors} errors)`);
        return;
      }
    }

    // Run quantitative pre-tick hook (no LLM cost)
    if (this.onTickHook) {
      try {
        // sendAlert is fire-and-forget — never blocks onTick or the chat queue
        const sendAlert = (msg: string) => {
          const send = getBotSendFn();
          const targetChat = config.adminChatId || this.chatId;
          if (send) {
            // Fire-and-forget: don't await to avoid blocking the agent tick
            send(targetChat, msg).catch((e: unknown) => {
              log.warn(`[agent:${this.id}] Alert send failed: ${e}`);
            });
          }
        };
        await this.onTickHook(this.cycle, sendAlert);
      } catch (err) {
        log.warn(`[agent:${this.id}] onTick error: ${err}`);
      }
    }

    const prompt = this.buildPrompt(this.cycle);
    this.cycle++;

    if (!prompt) {
      log.debug(`[agent:${this.id}] Cycle ${this.cycle} — skipped (no prompt)`);
      saveState(this); // persist cycle increment
      return;
    }

    this.running = true;
    this.status = "running";
    const startTime = Date.now();
    log.info(`[agent:${this.id}] Cycle ${this.cycle} — executing`);

    // Fresh session every cycle — prevents context bloat from accumulated turns
    clearTurns(this.chatId);
    clearSession(this.chatId);

    await emitHook("agent:cycle:start", { agentId: this.id, cycle: this.cycle, chatId: this.chatId });

    try {
      // Prefix prompt with agent identity + global no-spam rule
      const agentPrompt =
        `[AGENT:${this.id.toUpperCase()}] (${this.name} — ${this.role})\n\n` +
        `RÈGLE GLOBALE ANTI-SPAM (PRIORITÉ MAXIMALE):\n` +
        `- NE PAS utiliser telegram.send pour des rapports de routine, heartbeats, ou résumés.\n` +
        `- Utilise notes.add pour TOUT rapport interne, résumé, réflexion, log.\n` +
        `- telegram.send UNIQUEMENT si Nicolas DOIT AGIR (décision requise, erreur critique, opportunité urgente).\n` +
        `- Si tu n'es pas sûr → notes.add. Le doute = pas de notification.\n\n` +
        prompt;

      const result = await handleMessage(this.chatId, agentPrompt, this.userId, "scheduler");

      // Check if Claude returned a rate limit message
      if (detectAndSetRateLimit(result)) {
        const durationMs = Date.now() - startTime;
        this.lastRunAt = Date.now();
        this.lastError = "rate_limit";
        this.status = "backoff";
        logRun(this.id, this.cycle, startTime, durationMs, "rate_limit");
        saveState(this);
        log.warn(`[agent:${this.id}] Cycle ${this.cycle} — rate limited, pausing`);
        return;
      }

      const durationMs = Date.now() - startTime;
      this.totalRuns++;
      this.lastRunAt = Date.now();
      this.lastError = null;
      this.consecutiveErrors = 0;
      this.status = "idle";

      logRun(this.id, this.cycle, startTime, durationMs, "success");
      saveState(this);
      await emitHook("agent:cycle:end", { agentId: this.id, cycle: this.cycle, chatId: this.chatId });
      log.info(`[agent:${this.id}] Cycle ${this.cycle} — completed (${durationMs}ms)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const durationMs = Date.now() - startTime;
      this.lastError = msg;
      this.lastRunAt = Date.now();
      this.consecutiveErrors++;
      this.status = "error";

      logRun(this.id, this.cycle, startTime, durationMs, "error", msg);
      saveState(this);
      log.error(`[agent:${this.id}] Cycle ${this.cycle} — error (${this.consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}): ${msg}`);

      // Auto-disable after too many consecutive errors
      if (this.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        log.error(`[agent:${this.id}] Disabled after ${MAX_CONSECUTIVE_ERRORS} consecutive errors`);
        this.stop();

        // Notify admin via Telegram
        try {
          const alertPrompt =
            `[AGENT:SYSTEM] L'agent ${this.name} (${this.id}) a été désactivé automatiquement après ${MAX_CONSECUTIVE_ERRORS} erreurs consécutives.\n` +
            `Dernière erreur: ${msg}\n` +
            `Utilise agents.start(id="${this.id}") pour le redémarrer après investigation.\n` +
            `Envoie cette alerte à Nicolas via telegram.send.`;
          await handleMessage(this.chatId, alertPrompt, this.userId, "scheduler");
        } catch {
          // Best effort — don't fail on notification failure
        }
      }
    } finally {
      this.running = false;
    }
  }

  /** Ollama-only tick — used when Claude is rate-limited but agent still needs to run */
  private async tickOllama(): Promise<void> {
    const prompt = this.buildPrompt(this.cycle);
    this.cycle++;

    if (!prompt) {
      log.debug(`[agent:${this.id}] Ollama tick cycle ${this.cycle} — skipped (no prompt)`);
      saveState(this);
      return;
    }

    this.running = true;
    this.status = "running";
    const startTime = Date.now();
    log.info(`[agent:${this.id}] Cycle ${this.cycle} — executing via Ollama (rate-limit fallback)`);

    try {
      const agentPrompt =
        `[AGENT:${this.id.toUpperCase()}] (${this.name} — ${this.role})\n` +
        `[MODE: Ollama fallback — pas d'outils disponibles, texte seulement]\n\n` +
        prompt;

      const result = await runOllama(this.chatId, agentPrompt);

      const durationMs = Date.now() - startTime;
      this.totalRuns++;
      this.lastRunAt = Date.now();
      this.lastError = null;
      this.consecutiveErrors = 0;
      this.status = "idle";

      logRun(this.id, this.cycle, startTime, durationMs, "success_ollama");
      saveState(this);
      log.info(`[agent:${this.id}] Cycle ${this.cycle} — completed via Ollama (${durationMs}ms)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const durationMs = Date.now() - startTime;
      this.lastError = `ollama_fallback: ${msg}`;
      this.lastRunAt = Date.now();
      this.status = "idle"; // Don't increment errors for Ollama failures — it's already a fallback
      logRun(this.id, this.cycle, startTime, durationMs, "error_ollama", msg);
      saveState(this);
      log.warn(`[agent:${this.id}] Ollama fallback failed: ${msg}`);
    } finally {
      this.running = false;
    }
  }
}
