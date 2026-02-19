/**
 * Correction Feedback Loop — detects when Nicolas corrects Kingston
 * and auto-creates behavioral rules from the correction.
 *
 * Triggered from backgroundExtract in the router (fire-and-forget).
 * Uses Groq (free, fast) or Ollama to analyze corrections.
 */
import { log } from "../utils/log.js";
import { addRule } from "../storage/store.js";
import { config } from "../config/env.js";

/** Regex patterns that indicate Nicolas is correcting Kingston */
const CORRECTION_PATTERNS = [
  /\b(non|nan|nope)\b.{0,20}\b(c'est|c est)\b/i,
  /\bje t'ai (dit|demandé|expliqué)\b/i,
  /\barrête de\b/i,
  /\bne (fais|fait|dis|dit) (pas|plus|jamais)\b/i,
  /\bc'est (pas|faux|incorrect|wrong)\b/i,
  /\bje (veux|voulais) (pas|not)\b/i,
  /\bt'as (tort|mal compris)\b/i,
  /\b(mauvais|wrong|incorrect|faux)\b/i,
  /\bpas comme (ça|ca)\b/i,
  /\bje (préfère|prefere) que tu\b/i,
  /\bla prochaine fois\b/i,
  /\bsouviens-toi que\b/i,
  /\bretiens que\b/i,
  /\btoujours\b.{0,30}\bjamais\b/i,
];

/** Quick heuristic: does this user message look like a correction? */
export function looksLikeCorrection(userMessage: string): boolean {
  if (userMessage.length < 10 || userMessage.length > 500) return false;
  return CORRECTION_PATTERNS.some((p) => p.test(userMessage));
}

/**
 * Extract a behavioral rule from a correction.
 * Uses Groq (fast, free) to understand the correction and formulate a rule.
 */
async function extractRuleFromCorrection(
  userMessage: string,
  previousResponse: string,
): Promise<{ ruleName: string; condition: string; action: string; category: string } | null> {
  // Use Groq if available, otherwise skip (we don't want to use expensive models for this)
  if (!config.groqApiKey) return null;

  try {
    const { runGroq } = await import("../llm/groqClient.js");
    const prompt = `Tu es un analyseur de corrections. L'utilisateur a corrigé l'assistant.

Message de l'utilisateur (correction): "${userMessage}"
Réponse précédente de l'assistant: "${previousResponse.slice(0, 300)}"

Extrais UNE règle comportementale de cette correction.
Réponds UNIQUEMENT en JSON (pas de markdown):
{"rule_name": "nom-court-kebab-case", "condition": "Quand [situation déclencheur]", "action": "Alors [comportement correct]", "category": "communication|trading|content|general"}

Si ce n'est PAS une vraie correction (juste un désaccord, une question, etc.), réponds: null`;

    const response = await runGroq(prompt, "", { temperature: 0, maxTokens: 200 });
    const trimmed = response.trim();

    if (trimmed === "null" || trimmed === "{}") return null;

    // Parse JSON, handling potential markdown fences
    const jsonStr = trimmed.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(jsonStr);

    if (!parsed?.rule_name || !parsed?.condition || !parsed?.action) return null;

    return parsed;
  } catch (err) {
    log.debug(`[correction] Failed to extract rule: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Main entry point — called from backgroundExtract in router.
 * Detects corrections and auto-creates pending rules.
 */
export async function detectAndLearnFromCorrection(
  userMessage: string,
  previousResponse: string,
): Promise<void> {
  if (!looksLikeCorrection(userMessage)) return;

  log.info(`[correction] Detected potential correction: "${userMessage.slice(0, 80)}"`);

  const rule = await extractRuleFromCorrection(userMessage, previousResponse);
  if (!rule) {
    log.debug(`[correction] No rule extracted (not a real correction)`);
    return;
  }

  // Check for duplicate rules
  try {
    const { getDb } = await import("../storage/store.js");
    const db = getDb();
    const existing = db
      .prepare("SELECT id FROM behavioral_rules WHERE rule_name = ?")
      .get(rule.ruleName) as any;
    if (existing) {
      log.debug(`[correction] Rule "${rule.ruleName}" already exists, skipping`);
      return;
    }
  } catch {
    // DB check failed, proceed anyway
  }

  // Create the rule as pending (auto-approval after 3 successes via existing cron)
  const id = addRule(
    rule.ruleName,
    rule.condition,
    rule.action,
    rule.category,
    60, // slightly above default priority
    "correction-detector",
  );

  log.info(
    `[correction] Auto-created rule #${id}: "${rule.ruleName}" — ` +
      `Quand: ${rule.condition} → Alors: ${rule.action}`,
  );
}
