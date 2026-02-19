/**
 * Progressive conversation summarizer.
 * Fuses old summary + pruned turns into an updated summary using Gemini Flash ($0).
 * Extracts active topics for contextual memory enrichment.
 */
import { config } from "../config/env.js";
import { getSummary, saveSummary, type Turn } from "../storage/store.js";
import { log } from "../utils/log.js";

const SUMMARIZE_PROMPT = `Tu es un assistant de mémoire conversationnelle. Fusionne le résumé existant avec les nouveaux échanges.

RÉSUMÉ EXISTANT:
{existing_summary}

NOUVEAUX ÉCHANGES:
{new_turns}

INSTRUCTIONS:
- Garde: décisions prises, tâches en cours, préférences exprimées, contexte important, sujets discutés.
- Supprime: bavardage, formules de politesse, détails techniques résolus, messages systèmes.
- Le résumé doit être concis (max 800 chars) et factuel.
- Extrais les 3-5 sujets actifs de la conversation.
- Réponds UNIQUEMENT en JSON valide (pas de markdown):
{"summary": "...", "topics": ["sujet1", "sujet2", ...]}`;

/**
 * Summarize pruned turns by fusing them with the existing summary.
 * Called fire-and-forget from addTurn() before pruning.
 */
export async function summarizeConversation(chatId: number, turnsToSummarize: Turn[]): Promise<void> {
  if (!config.geminiApiKey) return;
  if (turnsToSummarize.length === 0) return;

  const existing = getSummary(chatId);
  const existingSummary = existing?.summary || "(aucun résumé précédent)";
  const existingTurnCount = existing?.turn_count || 0;

  // Format turns for the prompt
  const turnsText = turnsToSummarize
    .map((t) => `${t.role === "user" ? "User" : "Kingston"}: ${t.content.slice(0, 300)}`)
    .join("\n");

  const prompt = SUMMARIZE_PROMPT
    .replace("{existing_summary}", existingSummary)
    .replace("{new_turns}", turnsText);

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${config.geminiApiKey}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 1024,
        },
      }),
    });

    if (!res.ok) {
      log.debug(`[summarizer] Gemini API failed (${res.status})`);
      return;
    }

    const data = await res.json();
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";

    // Parse JSON from response (may be wrapped in markdown fences or truncated)
    const jsonStr = rawText.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
    if (!jsonStr) return;

    let parsed: { summary: string; topics: string[] };
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      // Try to extract summary from truncated JSON
      const summaryMatch = jsonStr.match(/"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (summaryMatch) {
        const topicsMatch = jsonStr.match(/"topics"\s*:\s*\[(.*?)\]/);
        const topics = topicsMatch
          ? topicsMatch[1].match(/"([^"]+)"/g)?.map(s => s.replace(/"/g, "")) || []
          : [];
        parsed = { summary: summaryMatch[1], topics };
        log.debug(`[summarizer] Recovered truncated JSON (${parsed.summary.length} chars)`);
      } else {
        log.debug(`[summarizer] Failed to parse JSON: ${jsonStr.slice(0, 200)}`);
        return;
      }
    }

    if (!parsed.summary || typeof parsed.summary !== "string") return;

    const topics = Array.isArray(parsed.topics)
      ? parsed.topics.filter((t): t is string => typeof t === "string").slice(0, 5)
      : [];

    const newTurnCount = existingTurnCount + turnsToSummarize.length;
    saveSummary(chatId, parsed.summary, newTurnCount, topics);

    log.info(`[summarizer] Updated summary for chat ${chatId}: ${parsed.summary.length} chars, topics: [${topics.join(", ")}]`);
  } catch (err) {
    log.debug(`[summarizer] Failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
