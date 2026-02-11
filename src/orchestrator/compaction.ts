/**
 * Adaptive Context Compaction — token-aware progressive summarization.
 * Summarizes old conversation turns to reduce token usage.
 * Uses Ollama/Groq ($0) instead of Claude for summarization.
 * Progressive: summarizes in layers, preserving recent context.
 */
import { getTurns, clearTurns, addTurn, type Turn } from "../storage/store.js";
import { extractAndSaveLifeboat } from "./lifeboat.js";
import { config } from "../config/env.js";
import { log } from "../utils/log.js";
import { isOllamaAvailable } from "../llm/ollamaClient.js";

/** Rough token estimate: ~4 chars per token for English/French mix */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Estimate total tokens for a set of turns */
function turnsTokenCount(turns: Turn[]): number {
  return turns.reduce((acc, t) => acc + estimateTokens(t.content), 0);
}

/** Threshold: auto-compact when context exceeds this many estimated tokens */
const AUTO_COMPACT_THRESHOLD = 12000; // ~48K chars
const COMPACT_TARGET = 6000; // Target after compaction

const COMPACT_PROMPT = `Tu es un compacteur de contexte. Résume les messages de conversation suivants en un contexte concis.
Préserve:
- Faits clés, décisions, résultats
- Résultats d'outils encore pertinents
- Préférences et instructions de l'utilisateur
- Tâches en cours ou éléments en attente

Format: points clés, structurés, < 400 mots. Pas de salutations ni de remplissage.

Messages à résumer:`;

/**
 * Summarize text using Ollama or Groq (free).
 * Falls back to simple truncation if both are unavailable.
 */
async function freeSummarize(text: string): Promise<string> {
  const prompt = `${COMPACT_PROMPT}\n\n${text.slice(0, 8000)}`;

  // Try Ollama (local, free)
  if (config.ollamaEnabled && (await isOllamaAvailable())) {
    try {
      const res = await fetch(`${config.ollamaUrl}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: config.ollamaModel,
          prompt,
          stream: false,
          options: { temperature: 0.1, num_predict: 1024 },
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.response) return data.response;
      }
    } catch (err) {
      log.debug(`[compaction] Ollama summarize failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Try Groq (free cloud)
  if (config.groqApiKey) {
    try {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.groqApiKey}`,
        },
        body: JSON.stringify({
          model: config.groqModel,
          messages: [{ role: "user", content: prompt }],
          temperature: 0.1,
          max_tokens: 1024,
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) {
        const data = await res.json();
        const text = data.choices?.[0]?.message?.content;
        if (text) return text;
      }
    } catch (err) {
      log.debug(`[compaction] Groq summarize failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Fallback: simple truncation (no LLM available)
  const lines = text.split("\n").filter((l) => l.trim());
  return lines.slice(0, 20).join("\n") + "\n...(truncated)";
}

/**
 * Compact the conversation history for a chat.
 * Keeps the most recent `keepRecent` turns intact, summarizes the rest.
 */
export async function compactContext(
  chatId: number,
  userId: number,
  keepRecent: number = 4,
): Promise<string> {
  const turns = getTurns(chatId);

  if (turns.length <= keepRecent) {
    return `Nothing to compact — only ${turns.length} turn(s) in history.`;
  }

  const oldTurns = turns.slice(0, turns.length - keepRecent);
  const recentTurns = turns.slice(turns.length - keepRecent);

  const conversationText = oldTurns
    .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.content}`)
    .join("\n\n");

  // Save lifeboat before compaction
  log.info(`[compaction] Saving lifeboat before compacting...`);
  await extractAndSaveLifeboat(chatId).catch((err) =>
    log.warn(`[compaction] Lifeboat extraction failed (non-fatal): ${err}`),
  );

  log.info(`[compaction] Compacting ${oldTurns.length} turns (~${estimateTokens(conversationText)} tokens) for chat ${chatId}`);

  const summary = await freeSummarize(conversationText);

  if (!summary || summary.length < 20) {
    log.error("[compaction] Failed to generate summary");
    return "Compaction failed — context unchanged.";
  }

  // Replace turns: clear all, add summary + recent turns
  clearTurns(chatId);
  addTurn(chatId, {
    role: "assistant",
    content: `[Context Summary — ${oldTurns.length} turns compacted]\n${summary}`,
  });
  for (const turn of recentTurns) {
    addTurn(chatId, turn);
  }

  const oldTokens = estimateTokens(conversationText);
  const newTokens = estimateTokens(summary);
  const msg = `Compacted ${oldTurns.length} turns (~${oldTokens} → ~${newTokens} tokens). ${recentTurns.length} recent turns preserved.`;
  log.info(`[compaction] ${msg}`);
  return msg;
}

/**
 * Auto-compact when context is too large.
 * Token-aware: only triggers when estimated tokens exceed threshold.
 * Returns true if compaction was performed.
 */
export async function autoCompact(chatId: number, userId: number): Promise<boolean> {
  const turns = getTurns(chatId);
  if (turns.length <= 4) {
    log.warn("[compaction] Too few turns to auto-compact");
    return false;
  }

  const totalTokens = turnsTokenCount(turns);
  if (totalTokens < AUTO_COMPACT_THRESHOLD) {
    log.debug(`[compaction] Context OK (~${totalTokens} tokens < ${AUTO_COMPACT_THRESHOLD} threshold)`);
    return false;
  }

  log.info(`[compaction] Auto-compacting ${turns.length} turns (~${totalTokens} tokens, threshold: ${AUTO_COMPACT_THRESHOLD})`);

  // Progressive: keep more recent turns if context is very large
  const keepRecent = totalTokens > AUTO_COMPACT_THRESHOLD * 2 ? 2 : 4;
  const result = await compactContext(chatId, userId, keepRecent);
  return !result.includes("failed");
}

/**
 * Check if a chat should be auto-compacted (non-blocking).
 * Call this after each message to proactively manage context size.
 */
export function shouldAutoCompact(chatId: number): boolean {
  const turns = getTurns(chatId);
  return turnsTokenCount(turns) >= AUTO_COMPACT_THRESHOLD;
}
