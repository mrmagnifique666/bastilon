/**
 * Mood Detection Engine — $0 cost regex/heuristic analysis.
 * Detects Nicolas's mood from message text and provides adaptive tone instructions.
 */
import { getDb } from "../storage/store.js";
import { log } from "../utils/log.js";

export interface MoodSignal {
  score: number; // 1 (très négatif) à 10 (très positif)
  energy: "low" | "medium" | "high";
  intent: "chat" | "work" | "urgent" | "explore" | "vent";
  indicators: string[];
}

// Global current mood context — set before LLM call, read by buildSystemInstruction
let _currentMoodContext = "";

export function setCurrentMoodContext(ctx: string): void {
  _currentMoodContext = ctx;
}

export function getCurrentMoodContext(): string {
  return _currentMoodContext;
}

/** Lightweight mood detection — no LLM call, instant, $0 */
export function detectMood(message: string): MoodSignal {
  const lower = message.toLowerCase().trim();
  const len = message.length;
  let score = 5;
  let energy: "low" | "medium" | "high" = "medium";
  let intent: "chat" | "work" | "urgent" | "explore" | "vent" = "work";
  const indicators: string[] = [];

  // Positive signals
  if (/parfait|excellent|nice|super|génial|genial|cool|bravo|merci|love|❤|🔥|💪|😊|👍/i.test(lower)) {
    score += 2;
    indicators.push("positive_words");
  }
  if (/!{2,}/.test(message)) {
    score += 1;
    energy = "high";
    indicators.push("excitement");
  }
  if (/haha|lol|😂|🤣|😄/.test(lower)) {
    score += 1;
    indicators.push("humor");
  }

  // Negative signals
  if (/merde|fuck|shit|tabarnak|calisse|crisse|putain|chier|osti/.test(lower)) {
    score -= 3;
    indicators.push("frustration");
    intent = "vent";
  }
  if (/bug|erreur|marche pas|broken|crash|fail|cassé/.test(lower)) {
    score -= 1;
    indicators.push("technical_issue");
    intent = "urgent";
  }
  if (/fatigué|tired|épuisé|ras le bol|tanné|brûlé/.test(lower)) {
    score -= 2;
    energy = "low";
    indicators.push("fatigue");
  }
  if (/non|pas ça|mauvais|wrong|nope/.test(lower)) {
    score -= 1;
    indicators.push("disagreement");
  }

  // Energy signals
  if (len < 10) {
    energy = "low";
    indicators.push("terse");
  }
  if (len > 300) {
    energy = "high";
    indicators.push("verbose");
    intent = "explore";
  }
  if (/URGENT|ASAP|vite|maintenant|now|!!!/.test(message)) {
    intent = "urgent";
    energy = "high";
    indicators.push("urgency");
  }
  if (/\?.*\?/.test(message)) {
    intent = "explore";
    indicators.push("multiple_questions");
  }
  if (/^(ok|oui|non|yep|yup|ouais|k|np|go|fais-le|fais le|do it)$/i.test(lower)) {
    energy = "low";
    indicators.push("minimal_response");
  }

  // Time-based heuristic
  const h = new Date().getHours();
  if (h < 7 || h > 23) {
    energy = "low";
    indicators.push("late_hours");
  }

  score = Math.max(1, Math.min(10, score));

  return { score, energy, intent, indicators };
}

/** Get adaptive tone instructions based on mood */
export function getToneInstructions(mood: MoodSignal): string {
  const parts: string[] = ["[MOOD ADAPTATIF]"];

  if (mood.score <= 3) {
    parts.push(
      "Nicolas semble frustré. Sois empathique, direct, et orienté solution. Pas de blagues."
    );
  } else if (mood.score >= 8) {
    parts.push("Nicolas est de bonne humeur! Tu peux être plus détendu et enthousiaste.");
  }

  if (mood.energy === "low") {
    parts.push("Réponse ULTRA courte (1-3 lignes max). Il est occupé ou fatigué.");
  } else if (mood.energy === "high") {
    parts.push("Tu peux détailler davantage, il est engagé.");
  }

  if (mood.intent === "urgent") {
    parts.push("URGENT — va droit au but, pas de préambule.");
  } else if (mood.intent === "vent") {
    parts.push("Il ventile. Écoute, valide, puis propose une solution.");
  } else if (mood.intent === "explore") {
    parts.push("Mode exploration — détaille, propose des options, sois créatif.");
  }

  return parts.join(" ");
}

// Track last logged mood to avoid spamming episodic memory with identical readings
let _lastLoggedMood: { score: number; energy: string; intent: string } | null = null;

/** Log mood to episodic memory for pattern learning.
 *  Only logs when mood changes significantly (score ±2, or energy/intent change). */
export function logMood(mood: MoodSignal, chatId: number | string): void {
  // Skip if mood hasn't changed significantly
  if (_lastLoggedMood) {
    const scoreDiff = Math.abs(mood.score - _lastLoggedMood.score);
    if (scoreDiff < 2 && mood.energy === _lastLoggedMood.energy && mood.intent === _lastLoggedMood.intent) {
      return; // No significant change — skip logging
    }
  }

  _lastLoggedMood = { score: mood.score, energy: mood.energy, intent: mood.intent };

  try {
    const db = getDb();
    db.prepare(
      `INSERT INTO episodic_events (event_type, summary, importance, emotional_valence, created_at)
       VALUES ('mood_reading', ?, ?, ?, ?)`
    ).run(
      JSON.stringify({
        score: mood.score,
        energy: mood.energy,
        intent: mood.intent,
        indicators: mood.indicators,
      }),
      2, // low importance — background data
      mood.score >= 5 ? 1 : -1,
      Math.floor(Date.now() / 1000)
    );
  } catch (e) {
    log.warn(`[mood] Failed to log: ${e}`);
  }
}
