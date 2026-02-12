/**
 * Shared memory context builder — used by both Claude CLI (batch + stream).
 * Runs all DB queries in parallel for optimal speed.
 */
import { getDb, getSummary } from "../../storage/store.js";
import { buildSemanticContext } from "../../memory/semantic.js";
import { log } from "../../utils/log.js";

export async function buildMemoryContext(chatId: number, userMessage?: string): Promise<string> {
  const db = getDb();
  const parts: string[] = [];

  // Run ALL queries in parallel (saves ~300-800ms vs sequential)
  const notesPromise = Promise.resolve().then(() => {
    try {
      return db
        .prepare("SELECT id, text, created_at FROM notes ORDER BY id DESC LIMIT 15")
        .all() as { id: number; text: string; created_at: number }[];
    } catch (err) { log.warn(`[memory-ctx] Notes query failed: ${err instanceof Error ? err.message : String(err)}`); return []; }
  });

  const semanticPromise = userMessage
    ? buildSemanticContext(userMessage, 10, chatId).catch(() => "")
    : Promise.resolve("");

  const summaryPromise = Promise.resolve().then(() => {
    try { return getSummary(chatId); } catch { return null; }
  });

  const cutoff = Math.floor(Date.now() / 1000) - 48 * 3600;
  const recentTurnsPromise = Promise.resolve().then(() => {
    try {
      return db.prepare(
        `SELECT role, content, created_at FROM turns
         WHERE chat_id = ? AND created_at > ? AND role = 'user'
         AND content NOT LIKE '[Tool %' AND content NOT LIKE '[AGENT:%' AND content NOT LIKE '[SCHEDULER%'
         ORDER BY id DESC LIMIT 20`
      ).all(chatId, cutoff) as { role: string; content: string; created_at: number }[];
    } catch { return []; }
  });

  const [notes, semanticCtx, summary, recentTurns] = await Promise.all([
    notesPromise, semanticPromise, summaryPromise, recentTurnsPromise,
  ]);

  // 1. Conversation summary
  if (summary?.summary) {
    parts.push("[CONVERSATION SUMMARY]");
    parts.push(summary.summary);
    if (summary.topics.length > 0) {
      parts.push(`Topics actifs: [${summary.topics.join(", ")}]`);
    }
  }

  // 2. Recent notes
  if (notes.length > 0) {
    parts.push("\n[NOTES — Long-term memory]");
    for (const n of notes.reverse()) {
      const text = n.text.length > 200 ? n.text.slice(0, 200) + "..." : n.text;
      parts.push(`#${n.id}: ${text}`);
    }
  }

  // 3. Semantic memory
  if (semanticCtx) {
    parts.push("\n" + semanticCtx);
  }

  // 4. Recent conversation activity (last 48h)
  if (recentTurns.length > 0) {
    parts.push("\n[RECENT ACTIVITY — last 48h user messages]");
    for (const t of recentTurns.reverse()) {
      const date = new Date(t.created_at * 1000);
      const timeStr = date.toLocaleString("fr-CA", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "America/Toronto" });
      const content = t.content.length > 120 ? t.content.slice(0, 120) + "..." : t.content;
      parts.push(`[${timeStr}] ${content}`);
    }
  }

  return parts.length > 0 ? parts.join("\n") : "";
}
