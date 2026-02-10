/**
 * Context compaction.
 * Summarizes old conversation turns to reduce token usage
 * while preserving key information.
 */
import { getTurns, clearTurns, addTurn, type Turn } from "../storage/store.js";
import { runClaude } from "../llm/claudeCli.js";
import { extractAndSaveLifeboat } from "./lifeboat.js";
import { config } from "../config/env.js";
import { log } from "../utils/log.js";

const COMPACT_SUMMARY_PROMPT = `You are a context compactor. Summarize the following conversation turns into a concise context summary.
Preserve:
- Key facts, decisions, and outcomes
- Tool call results that are still relevant
- User preferences and instructions mentioned
- Any ongoing tasks or pending items

Format as a brief, structured summary (bullet points). Do NOT include greetings or filler.
Keep it under 500 words.

Conversation to summarize:`;

/**
 * Compact the conversation history for a chat.
 * Keeps the most recent `keepRecent` turns intact, summarizes the rest.
 * Returns a status message.
 */
export async function compactContext(
  chatId: number,
  userId: number,
  keepRecent: number = 4
): Promise<string> {
  const turns = getTurns(chatId);

  if (turns.length <= keepRecent) {
    return `Nothing to compact — only ${turns.length} turn(s) in history.`;
  }

  const oldTurns = turns.slice(0, turns.length - keepRecent);
  const recentTurns = turns.slice(turns.length - keepRecent);

  // Build the text to summarize
  const conversationText = oldTurns
    .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.content}`)
    .join("\n\n");

  const prompt = `${COMPACT_SUMMARY_PROMPT}\n\n${conversationText}`;

  // Save lifeboat before compaction to preserve critical context
  log.info(`[compaction] Saving lifeboat before compacting...`);
  await extractAndSaveLifeboat(chatId).catch((err) =>
    log.warn(`[compaction] Lifeboat extraction failed (non-fatal): ${err}`)
  );

  log.info(`[compaction] Compacting ${oldTurns.length} turns for chat ${chatId}, keeping ${recentTurns.length} recent`);

  // Use Claude to generate the summary (batch mode, not streaming)
  const result = await runClaude(chatId, prompt, false);
  const summary = result.type === "message" ? result.text : "(compaction failed)";

  if (summary === "(compaction failed)") {
    log.error("[compaction] Failed to generate summary");
    return "Compaction failed — context unchanged.";
  }

  // Replace turns: clear all, add summary + recent turns
  clearTurns(chatId);
  addTurn(chatId, {
    role: "assistant",
    content: `[Context Summary]\n${summary}`,
  });
  for (const turn of recentTurns) {
    addTurn(chatId, turn);
  }

  const msg = `Compacted ${oldTurns.length} turns into a summary. ${recentTurns.length} recent turns preserved.`;
  log.info(`[compaction] ${msg}`);
  return msg;
}

/**
 * Auto-compact when context is too large.
 * Called by the router when Claude returns a context overflow error.
 */
export async function autoCompact(chatId: number, userId: number): Promise<boolean> {
  const turns = getTurns(chatId);
  if (turns.length <= 4) {
    log.warn("[compaction] Too few turns to auto-compact");
    return false;
  }

  log.info(`[compaction] Auto-compacting ${turns.length} turns for chat ${chatId}`);
  const result = await compactContext(chatId, userId);
  return !result.includes("failed");
}
