/**
 * Agent Session Compaction — summarizes previous cycle context
 * so agents carry forward key learnings instead of starting from zero.
 *
 * Uses Ollama (free) for summarization, with graceful fallback to
 * simple truncation if Ollama is unavailable.
 */
import { getDb, getTurns, clearTurns, clearSession } from "../storage/store.js";
import { runOllama } from "../llm/ollamaClient.js";
import { log } from "../utils/log.js";

/** Dedicated chatId for compaction summarization — avoids polluting agent sessions */
const COMPACTION_CHAT_ID = 109;

/** Max characters of turn content sent to summarizer */
const MAX_INPUT_CHARS = 2000;

/** Max summary length stored in DB */
const MAX_SUMMARY_CHARS = 500;

/** Keep only this many summaries per agent */
const MAX_SUMMARIES_PER_AGENT = 5;

/**
 * Ensure the agent_memory table exists.
 * Called once at startup or lazily on first use.
 */
export function ensureAgentMemoryTable(): void {
  try {
    const db = getDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        cycle INTEGER NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_agent_memory_agent
        ON agent_memory(agent_id, created_at DESC)
    `);
  } catch (err) {
    log.warn(`[compaction] Failed to ensure agent_memory table: ${err}`);
  }
}

// Ensure table exists on module load
ensureAgentMemoryTable();

/**
 * Compact an agent's session: read turns, summarize via Ollama, store summary,
 * then clear the session. Returns the generated summary or null on failure.
 *
 * On any error, falls back to clearing the session normally so the agent is
 * never blocked.
 */
export async function compactAgentSession(
  agentId: string,
  chatId: number
): Promise<string | null> {
  try {
    // 1. Read current turns
    const turns = getTurns(chatId, 50);

    // If no turns, nothing to compact — just clear and move on
    if (!turns || turns.length === 0) {
      clearTurns(chatId);
      clearSession(chatId);
      return null;
    }

    // 2. Build a text representation of the turns (capped)
    let turnsText = turns
      .map((t) => `[${t.role}]: ${t.content}`)
      .join("\n");

    if (turnsText.length > MAX_INPUT_CHARS) {
      turnsText = turnsText.slice(-MAX_INPUT_CHARS); // keep the END (most recent)
    }

    // 3. Summarize via Ollama (free, $0)
    const prompt =
      `Résume cette session d'agent en MAX 3 phrases. Focus sur: décisions prises, résultats obtenus, problèmes rencontrés, et prochaines actions. Sois TRÈS concis.\n\n` +
      `SESSION:\n${turnsText}`;

    let summary: string;
    try {
      const result = await runOllama(COMPACTION_CHAT_ID, prompt);
      summary = result.text.slice(0, MAX_SUMMARY_CHARS);
    } catch (ollamaErr) {
      log.warn(`[compaction] Ollama summarization failed for ${agentId}: ${ollamaErr}`);
      // Fallback: just clear without saving a summary
      clearTurns(chatId);
      clearSession(chatId);
      return null;
    }

    // 4. Get current cycle count for this agent
    const cycle = getCycleCount(agentId);

    // 5. Save to agent_memory table
    try {
      const db = getDb();
      db.prepare(
        "INSERT INTO agent_memory (agent_id, summary, cycle) VALUES (?, ?, ?)"
      ).run(agentId, summary, cycle);
    } catch (dbErr) {
      log.warn(`[compaction] Failed to save summary for ${agentId}: ${dbErr}`);
    }

    // 6. Prune old summaries (keep only last N)
    pruneOldSummaries(agentId);

    // 7. Clear the session (after successful compaction)
    clearTurns(chatId);
    clearSession(chatId);

    log.info(`[compaction] Compacted session for ${agentId} (${summary.length} chars)`);
    return summary;
  } catch (err) {
    log.warn(`[compaction] Error compacting session for ${agentId}: ${err}`);
    // Safety net: always clear so the agent doesn't get stuck
    try {
      clearTurns(chatId);
      clearSession(chatId);
    } catch { /* ignore */ }
    return null;
  }
}

/**
 * Get the latest compacted summary for an agent.
 * Returns null if no summary exists.
 */
export function getAgentContext(agentId: string): string | null {
  try {
    const db = getDb();
    const row = db
      .prepare(
        "SELECT summary FROM agent_memory WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1"
      )
      .get(agentId) as { summary: string } | undefined;
    return row?.summary ?? null;
  } catch {
    return null;
  }
}

/**
 * Get the current cycle count for an agent from agent_state.
 */
function getCycleCount(agentId: string): number {
  try {
    const db = getDb();
    const row = db
      .prepare("SELECT cycle FROM agent_state WHERE agent_id = ?")
      .get(agentId) as { cycle: number } | undefined;
    return row?.cycle ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Keep only the last MAX_SUMMARIES_PER_AGENT summaries for an agent.
 */
function pruneOldSummaries(agentId: string): void {
  try {
    const db = getDb();
    db.prepare(
      `DELETE FROM agent_memory WHERE agent_id = ? AND id NOT IN (
        SELECT id FROM agent_memory WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?
      )`
    ).run(agentId, agentId, MAX_SUMMARIES_PER_AGENT);
  } catch (err) {
    log.debug(`[compaction] Failed to prune summaries for ${agentId}: ${err}`);
  }
}
