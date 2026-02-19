/**
 * Response Quality Gate — evaluates Kingston's responses before delivery.
 *
 * Scores responses 1-5 using Groq (free, fast) or heuristics.
 * Logs scores to response_quality table for trend tracking.
 * Does NOT block responses — purely observational (fire-and-forget).
 */
import { log } from "../utils/log.js";
import { config } from "../config/env.js";
import { getDb } from "../storage/store.js";

interface QualityScore {
  score: number; // 1-5
  issues: string[];
}

/** Heuristic quality check — instant, no LLM cost */
function heuristicCheck(userMessage: string, response: string): QualityScore {
  const issues: string[] = [];
  let score = 5;

  // Too short (< 20 chars) for a non-trivial question
  if (response.length < 20 && userMessage.length > 30) {
    issues.push("response_too_short");
    score -= 1;
  }

  // Too long (> 3000 chars) — verbose
  if (response.length > 3000) {
    issues.push("response_too_long");
    score -= 1;
  }

  // Contains error messages
  if (/Error:|Failed:|erreur|exception/i.test(response) && !/```/.test(response)) {
    issues.push("contains_error");
    score -= 1;
  }

  // Hallucination indicators — claiming data without tool calls
  if (/\b\d{1,3}[.,]\d{2}\s*\$/.test(response) && !/tool|function|result/i.test(response)) {
    issues.push("possible_hallucinated_price");
    score -= 1;
  }

  // Repetition of user's question
  if (response.includes(userMessage.slice(0, 50))) {
    issues.push("echoes_user_message");
    score -= 1;
  }

  // Non-answer patterns
  if (/je ne (peux|sais) pas|I (can't|cannot)|unfortunately/i.test(response)) {
    issues.push("non_answer");
    score -= 1;
  }

  return { score: Math.max(1, score), issues };
}

/** LLM-based quality check — uses Groq (free, ~200ms) */
async function llmCheck(
  userMessage: string,
  response: string,
): Promise<QualityScore | null> {
  if (!config.groqApiKey) return null;

  try {
    const { runGroq } = await import("../llm/groqClient.js");

    const prompt = `Score cette réponse d'assistant 1-5.
Question: "${userMessage.slice(0, 200)}"
Réponse: "${response.slice(0, 500)}"

Critères: 1=hors-sujet/hallucination, 2=incomplet, 3=correct mais pas top, 4=bon, 5=excellent.
Réponds UNIQUEMENT en JSON: {"score": N, "issues": ["issue1"]}`;

    const result = await runGroq(prompt, "", { temperature: 0, maxTokens: 100 });
    const trimmed = result.trim().replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(trimmed);

    if (parsed?.score && parsed.score >= 1 && parsed.score <= 5) {
      return { score: parsed.score, issues: parsed.issues || [] };
    }
  } catch (err) {
    log.debug(`[quality] LLM check failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return null;
}

/**
 * Evaluate response quality and log to DB (fire-and-forget).
 * Only runs for main user chat, not internal sessions.
 */
export async function evaluateResponseQuality(
  chatId: number,
  userMessage: string,
  response: string,
  provider?: string,
): Promise<void> {
  // Only evaluate real user conversations
  if (chatId <= 1000) return;
  // Skip very short interactions (greetings, confirmations)
  if (userMessage.length < 15 || response.length < 10) return;

  // Run heuristic check (instant)
  const heuristic = heuristicCheck(userMessage, response);

  // Run LLM check if heuristic flagged issues or randomly (10% sample)
  let finalScore = heuristic;
  if (heuristic.score <= 3 || Math.random() < 0.1) {
    const llm = await llmCheck(userMessage, response);
    if (llm) {
      // Blend: LLM score takes priority but heuristic issues are kept
      finalScore = {
        score: llm.score,
        issues: [...new Set([...heuristic.issues, ...llm.issues])],
      };
    }
  }

  // Log to DB
  try {
    const db = getDb();
    db.prepare(
      `INSERT INTO response_quality (chat_id, score, issues, user_message, response_preview, provider)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      chatId,
      finalScore.score,
      JSON.stringify(finalScore.issues),
      userMessage.slice(0, 200),
      response.slice(0, 200),
      provider || "unknown",
    );

    if (finalScore.score <= 2) {
      log.warn(
        `[quality] Low score ${finalScore.score}/5 — issues: ${finalScore.issues.join(", ")} — Q: "${userMessage.slice(0, 60)}"`,
      );
    } else {
      log.debug(`[quality] Score ${finalScore.score}/5`);
    }
  } catch (err) {
    log.debug(`[quality] Failed to log: ${err instanceof Error ? err.message : String(err)}`);
  }
}
