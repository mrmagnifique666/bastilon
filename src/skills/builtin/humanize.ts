/**
 * Built-in skills: nlp.detect_ai, nlp.humanize
 * AI artifact detection + humanized rewriting via Gemini Flash.
 */
import { registerSkill } from "../loader.js";
import { config } from "../../config/env.js";
import { log } from "../../utils/log.js";

// --- AI pattern detection ---

interface AIPattern {
  pattern: RegExp;
  weight: number;
  label: string;
}

const AI_PATTERNS: AIPattern[] = [
  // English patterns
  { pattern: /\bdelve\b/gi, weight: 6, label: "delve" },
  { pattern: /\bleverage\b/gi, weight: 4, label: "leverage" },
  { pattern: /\blandscape\b/gi, weight: 3, label: "landscape" },
  { pattern: /\bgame[- ]changing\b/gi, weight: 5, label: "game-changing" },
  { pattern: /\btransformative\b/gi, weight: 4, label: "transformative" },
  { pattern: /\bseamless(ly)?\b/gi, weight: 4, label: "seamless" },
  { pattern: /\bholistic\b/gi, weight: 4, label: "holistic" },
  { pattern: /\bsynerg(y|ies|istic)\b/gi, weight: 5, label: "synergy" },
  { pattern: /\btapestry\b/gi, weight: 6, label: "tapestry" },
  { pattern: /\bempower(s|ed|ing)?\b/gi, weight: 4, label: "empower" },
  { pattern: /\bfoster(s|ed|ing)?\b/gi, weight: 4, label: "foster" },
  { pattern: /\bpivotal\b/gi, weight: 4, label: "pivotal" },
  { pattern: /\bunlock(s|ed|ing)?\b/gi, weight: 3, label: "unlock" },
  { pattern: /\brobust\b/gi, weight: 3, label: "robust" },
  { pattern: /\bcutting[- ]edge\b/gi, weight: 4, label: "cutting-edge" },
  { pattern: /\bparadigm\b/gi, weight: 5, label: "paradigm" },
  { pattern: /\bgroundbreaking\b/gi, weight: 5, label: "groundbreaking" },
  { pattern: /\bin today's (fast-paced|rapidly|ever)\b/gi, weight: 5, label: "in today's..." },
  { pattern: /\bIt's worth noting\b/gi, weight: 4, label: "it's worth noting" },
  { pattern: /\bIt is important to\b/gi, weight: 3, label: "it is important to" },
  // French patterns
  { pattern: /\btirer parti\b/gi, weight: 4, label: "tirer parti" },
  { pattern: /\bun paysage\b/gi, weight: 3, label: "un paysage" },
  { pattern: /\brévolutionnaire\b/gi, weight: 4, label: "révolutionnaire" },
  { pattern: /\bsans couture\b/gi, weight: 5, label: "sans couture" },
  { pattern: /\bholistique\b/gi, weight: 4, label: "holistique" },
  { pattern: /\bautonomiser\b/gi, weight: 4, label: "autonomiser" },
  { pattern: /\bIl convient de noter\b/gi, weight: 4, label: "il convient de noter" },
  { pattern: /\bdans le monde actuel\b/gi, weight: 4, label: "dans le monde actuel" },
];

function detectAI(text: string): { score: number; flagged: string[]; verdict: string } {
  let totalWeight = 0;
  const flagged: string[] = [];

  for (const p of AI_PATTERNS) {
    const matches = text.match(p.pattern);
    if (matches) {
      totalWeight += p.weight * matches.length;
      flagged.push(`"${p.label}" (x${matches.length}, poids ${p.weight})`);
    }
  }

  const score = Math.min(100, totalWeight * 5);
  const verdict = score < 20 ? "human" : score < 50 ? "suspicious" : "ai";

  return { score, flagged, verdict };
}

registerSkill({
  name: "nlp.detect_ai",
  description: "Detect AI-generated text patterns. Returns a score 0-100 and flagged phrases.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "Text to analyze for AI patterns" },
    },
    required: ["text"],
  },
  async execute(args): Promise<string> {
    const text = String(args.text);
    const { score, flagged, verdict } = detectAI(text);

    const icon = verdict === "human" ? "✅" : verdict === "suspicious" ? "⚠️" : "🤖";
    const lines = [
      `${icon} **AI Detection Score: ${score}/100** (${verdict})`,
      ``,
    ];

    if (flagged.length > 0) {
      lines.push(`**Patterns détectés (${flagged.length}):**`);
      for (const f of flagged) lines.push(`  - ${f}`);
    } else {
      lines.push(`Aucun pattern AI détecté.`);
    }

    return lines.join("\n");
  },
});

// --- Humanized rewriting ---

const CHANNEL_PROMPTS: Record<string, string> = {
  moltbook: "Edgy, authentique, provocateur. Pas de corporate speak. Opinions fortes, ton conversationnel, comme un entrepreneur qui parle franchement.",
  twitter: "Punchy, moins de 280 caractères, casual. Pas de hashtags excessifs. Ton naturel.",
  linkedin: "Professionnel mais conversationnel, première personne. Des anecdotes personnelles. Pas de jargon corporate vide.",
  blog: "Personnel, anecdotes, contractions OK. Comme si tu parlais à un ami intelligent. Paragraphes courts.",
};

registerSkill({
  name: "nlp.humanize",
  description: "Rewrite AI-sounding text to be more human. Detects AI patterns, then rewrites via Gemini Flash if needed.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "Text to humanize" },
      channel: { type: "string", description: "Target channel: moltbook, twitter, linkedin, blog (optional)" },
    },
    required: ["text"],
  },
  async execute(args): Promise<string> {
    const text = String(args.text);
    const channel = args.channel ? String(args.channel) : undefined;

    const before = detectAI(text);
    if (before.score < 20) {
      return `✅ Texte déjà humain (score: ${before.score}/100). Aucune réécriture nécessaire.`;
    }

    if (!config.geminiApiKey) {
      return `⚠️ Score AI: ${before.score}/100 — Gemini API key manquante pour réécrire.`;
    }

    const channelInstruction = channel && CHANNEL_PROMPTS[channel]
      ? `\n\nTon cible (${channel}): ${CHANNEL_PROMPTS[channel]}`
      : "";

    const prompt = `Réécris ce texte pour le rendre plus humain et naturel. Supprime les clichés AI (delve, leverage, seamless, etc.). Garde le même sens et la même langue (français ou anglais selon l'original). Sois direct, utilise des contractions, des tournures conversationnelles.${channelInstruction}

Texte original:
${text}

Texte réécrit (texte brut uniquement, pas de préambule):`;

    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${config.geminiApiKey}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.8, maxOutputTokens: 2048 },
        }),
      });

      if (!res.ok) {
        return `Erreur Gemini (${res.status}): impossible de réécrire.`;
      }

      const data = await res.json();
      const rewritten = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (!rewritten) return `Erreur: Gemini n'a pas retourné de texte.`;

      const after = detectAI(rewritten);

      return [
        `**Réécriture humanisée${channel ? ` (${channel})` : ""}:**\n`,
        rewritten,
        `\n---`,
        `Score avant: ${before.score}/100 (${before.verdict}) → après: ${after.score}/100 (${after.verdict})`,
        before.flagged.length > 0 ? `Patterns supprimés: ${before.flagged.length}` : "",
      ].filter(Boolean).join("\n");
    } catch (err) {
      log.error(`[nlp.humanize] Error: ${err}`);
      return `Erreur lors de la réécriture: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

log.debug("Registered 2 nlp.* skills");
