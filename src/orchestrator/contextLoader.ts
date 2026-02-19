/**
 * Context Loader — Automatic context enrichment for every LLM call.
 *
 * Before Kingston processes any message from Nicolas, this module gathers:
 * 1. Active goals and their status
 * 2. Recent autonomous decisions
 * 3. Market state (positions, day P&L)
 * 4. Pending observations (feedback loops)
 * 5. Skill health alerts
 * 6. Pending reminders/tasks
 *
 * The output is a compact text block (< 1500 tokens) injected into the system prompt.
 * This gives Kingston "working memory" — awareness of what's happening RIGHT NOW.
 */
import { getDb } from "../storage/store.js";
import { log } from "../utils/log.js";
import { getSkillStats } from "../skills/tool-pipeline.js";

const CACHE_TTL_MS = 120_000; // 2 min cache — context doesn't change every message
let cachedContext = "";
let cacheTimestamp = 0;

/**
 * Build the live context block for Nicolas's messages.
 * Cached for 2 minutes to avoid DB spam.
 */
export function buildLiveContext(chatId: number): string {
  // Only enrich for real Telegram users (Nicolas)
  if (chatId <= 1000) return "";

  const now = Date.now();
  if (cachedContext && (now - cacheTimestamp) < CACHE_TTL_MS) {
    return cachedContext;
  }

  try {
    const sections: string[] = [];
    const db = getDb();

    // 1. Active goals
    try {
      const goals = db.prepare(
        "SELECT title, status, progress FROM goals WHERE status IN ('active', 'in_progress') ORDER BY updated_at DESC LIMIT 5"
      ).all() as Array<{ title: string; status: string; progress: number }>;
      if (goals.length > 0) {
        const goalLines = goals.map(g => `- ${g.title} (${g.progress}%)`);
        sections.push(`**Objectifs actifs:**\n${goalLines.join("\n")}`);
      }
    } catch { /* table may not exist */ }

    // 2. Recent autonomous decisions (last 24h)
    try {
      const decisions = db.prepare(
        "SELECT decision, confidence, created_at FROM autonomous_decisions WHERE created_at > datetime('now', '-24 hours') ORDER BY created_at DESC LIMIT 3"
      ).all() as Array<{ decision: string; confidence: string; created_at: string }>;
      if (decisions.length > 0) {
        const decLines = decisions.map(d => `- [${d.confidence}] ${d.decision.slice(0, 100)}`);
        sections.push(`**Décisions récentes (24h):**\n${decLines.join("\n")}`);
      }
    } catch { /* table may not exist */ }

    // 3. Market state (Alpaca positions — lightweight)
    try {
      const trades = db.prepare(
        "SELECT COUNT(*) as cnt FROM notes WHERE category = 'trading' AND created_at > datetime('now', '-24 hours')"
      ).get() as { cnt: number } | undefined;
      if (trades && trades.cnt > 0) {
        sections.push(`**Trading:** ${trades.cnt} note(s) trading aujourd'hui`);
      }
    } catch { /* */ }

    // 4. Pending observations
    try {
      const obs = db.prepare(
        "SELECT action_type, action_detail FROM observations WHERE status = 'pending' AND check_at <= ? ORDER BY check_at LIMIT 5"
      ).all(Math.floor(now / 1000)) as Array<{ action_type: string; action_detail: string }>;
      if (obs.length > 0) {
        const obsLines = obs.map(o => `- ${o.action_type}: ${o.action_detail.slice(0, 80)}`);
        sections.push(`**Observations en attente:**\n${obsLines.join("\n")}`);
      }
    } catch { /* table may not exist yet */ }

    // 5. Skill health alerts (top failing skills)
    try {
      const allStats = getSkillStats();
      if (allStats.total > 10 && allStats.failures > 0) {
        const failRate = Math.round((allStats.failures / allStats.total) * 100);
        if (failRate > 15) {
          sections.push(`**Santé skills:** ${failRate}% d'échec (${allStats.failures}/${allStats.total})`);
        }
      }
    } catch { /* */ }

    // 6. Pending reminders
    try {
      const nowISO = new Date().toISOString();
      const reminders = db.prepare(
        "SELECT message FROM scheduler_reminders WHERE fire_at > ? AND fire_at < datetime(?, '+24 hours') ORDER BY fire_at LIMIT 3"
      ).all(nowISO, nowISO) as Array<{ message: string }>;
      if (reminders.length > 0) {
        const remLines = reminders.map(r => `- ${r.message.slice(0, 80)}`);
        sections.push(`**Rappels à venir:**\n${remLines.join("\n")}`);
      }
    } catch { /* */ }

    // 7. Pending code requests
    try {
      const codeReqs = db.prepare(
        "SELECT COUNT(*) as cnt FROM agent_tasks WHERE status = 'pending'"
      ).get() as { cnt: number } | undefined;
      if (codeReqs && codeReqs.cnt > 0) {
        sections.push(`**Code requests:** ${codeReqs.cnt} en attente`);
      }
    } catch { /* */ }

    if (sections.length === 0) {
      cachedContext = "";
    } else {
      cachedContext = `\n## [CONTEXTE LIVE — ${new Date().toLocaleTimeString("fr-CA", { timeZone: "America/Toronto", hour: "2-digit", minute: "2-digit" })}]\n${sections.join("\n\n")}`;
    }
    cacheTimestamp = now;
    log.debug(`[contextLoader] Built live context: ${sections.length} sections, ${cachedContext.length} chars`);
    return cachedContext;
  } catch (err) {
    log.warn(`[contextLoader] Failed to build context: ${err instanceof Error ? err.message : String(err)}`);
    return "";
  }
}

/** Force refresh the cached context */
export function invalidateContextCache(): void {
  cacheTimestamp = 0;
}
