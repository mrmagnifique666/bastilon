/**
 * Session Memory Hook — auto-saves a summary when /new is triggered.
 * Runs on "session:new" event, summarizes the conversation using Haiku,
 * and stores it as a semantic memory item.
 *
 * Safety: all in try/catch — failure never blocks /new.
 */
import { registerHook, type HookEvent, type HookContext } from "../hooks.js";
import { getTurns } from "../../storage/store.js";
import { runClaude } from "../../llm/claudeCli.js";
import { addMemory } from "../../memory/semantic.js";
import { getModelId } from "../../llm/modelSelector.js";
import { log } from "../../utils/log.js";

const MIN_TURNS = 3;
const MAX_TURNS_TO_SUMMARIZE = 20;

async function onSessionNew(_event: HookEvent, context: HookContext): Promise<void> {
  const { chatId } = context;

  // Skip agents, scheduler, dashboard
  if (!chatId || chatId <= 1000) return;

  // Get conversation turns before they're cleared
  const turns = getTurns(chatId);
  if (turns.length < MIN_TURNS) {
    log.debug(`[session-memory] Skipping — only ${turns.length} turns (min ${MIN_TURNS})`);
    return;
  }

  // Build conversation text from last N turns
  const recentTurns = turns.slice(-MAX_TURNS_TO_SUMMARIZE);
  const conversation = recentTurns
    .map(t => `${t.role === "user" ? "User" : "Kingston"}: ${t.content}`)
    .join("\n");

  // Use a temporary chatId so we don't pollute the user's session
  const tempChatId = 9999;

  try {
    const haikuModel = getModelId("haiku");
    const result = await runClaude(
      tempChatId,
      `Résume cette conversation en 2-3 phrases en français. Identifie les sujets principaux, décisions prises et actions effectuées. Pas de préambule, juste le résumé.\n\n${conversation}`,
      false,
      haikuModel
    );

    const summary = result.text?.trim();
    if (!summary || summary.length < 20) {
      log.debug(`[session-memory] Summary too short or empty, skipping`);
      return;
    }

    await addMemory(summary, "event", "session-summary", chatId);
    log.info(`[session-memory] Saved session summary (${summary.length} chars)`);
  } catch (err) {
    log.warn(`[session-memory] Failed to summarize: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Register the hook
registerHook("session:new", onSessionNew);
log.info("[session-memory] Hook registered");
