/**
 * Built-in skills: brand.analyze, brand.check, brand.rewrite
 * Brand Voice Consistency Engine — extract style from content samples, enforce on all outgoing content.
 * Inspired by OpenClaw Brand Voice pattern: 50+ samples → style guide → draft enforcement.
 */
import { registerSkill } from "../loader.js";
import { getDb, kgUpsertEntity, kgGetEntity } from "../../storage/store.js";
import { config } from "../../config/env.js";
import { log } from "../../utils/log.js";

const BRAND_VOICE_ENTITY = "kingston_brand_voice";
const BRAND_VOICE_TYPE = "config";

async function askGemini(prompt: string): Promise<string> {
  if (!config.geminiApiKey) throw new Error("GEMINI_API_KEY required");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${config.geminiApiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 4096 },
    }),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
}

registerSkill({
  name: "brand.analyze",
  description:
    "Analyze content samples to extract a brand voice style guide. Provide 5+ content samples (posts, tweets, articles). " +
    "Generates: tone, vocabulary patterns, sentence structure, do's and don'ts. Stored in Knowledge Graph.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      samples: {
        type: "string",
        description: "Content samples separated by \\n---\\n (minimum 5 recommended)",
      },
      brand_name: { type: "string", description: "Brand name (default: Kingston/Q+)" },
    },
    required: ["samples"],
  },
  async execute(args): Promise<string> {
    const samples = String(args.samples);
    const brandName = String(args.brand_name || "Kingston/Q+");
    const sampleList = samples.split(/\n---\n|\n\n\n/).filter(s => s.trim().length > 10);

    if (sampleList.length < 3) {
      return "Besoin d'au moins 3 échantillons (séparés par ---). Plus il y en a, meilleure sera l'analyse.";
    }

    const prompt = `Analyze these ${sampleList.length} content samples from "${brandName}" and generate a comprehensive brand voice guide.

SAMPLES:
${sampleList.map((s, i) => `[Sample ${i + 1}]\n${s}`).join("\n\n")}

Generate a brand voice guide with these sections:
1. **Tone & Personality** (3-5 adjectives with explanations)
2. **Vocabulary Patterns** (words/phrases frequently used, words to avoid)
3. **Sentence Structure** (avg length, use of questions, contractions, first person)
4. **Content Patterns** (how posts start, how they end, use of emojis/hashtags)
5. **Do's** (5-8 rules to follow)
6. **Don'ts** (5-8 things to avoid)
7. **Example Templates** (3 template patterns extracted from the samples)

Write the guide in French. Be specific — use actual examples from the samples.`;

    try {
      const guide = await askGemini(prompt);

      // Store in KG
      kgUpsertEntity(BRAND_VOICE_ENTITY, BRAND_VOICE_TYPE, {
        brand_name: brandName,
        guide,
        sample_count: sampleList.length,
        generated_at: new Date().toISOString(),
      });

      return `**Guide de voix de marque — ${brandName}**\n(basé sur ${sampleList.length} échantillons)\n\n${guide}\n\n_Stocké dans le Knowledge Graph pour référence future._`;
    } catch (err) {
      return `Erreur: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

registerSkill({
  name: "brand.check",
  description: "Check if a text matches the established brand voice. Returns a consistency score and suggestions.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "Text to check against brand voice" },
    },
    required: ["text"],
  },
  async execute(args): Promise<string> {
    const text = String(args.text);

    const entity = kgGetEntity(BRAND_VOICE_ENTITY, BRAND_VOICE_TYPE);
    if (!entity || !entity.properties.guide) {
      return "Aucun guide de voix de marque. Utilise brand.analyze d'abord avec des échantillons de contenu.";
    }

    const guide = String(entity.properties.guide);

    const prompt = `You are a brand voice consistency checker. Given this brand voice guide and a text sample, evaluate how well the text matches the brand voice.

BRAND VOICE GUIDE:
${guide.slice(0, 3000)}

TEXT TO CHECK:
${text}

Evaluate and respond in French with:
1. **Score de cohérence**: X/100
2. **Ce qui fonctionne** (2-3 points positifs)
3. **Ce qui ne colle pas** (2-3 problèmes identifiés)
4. **Suggestions** (2-3 corrections concrètes)

Be specific — quote actual phrases from the text.`;

    try {
      const result = await askGemini(prompt);
      return result;
    } catch (err) {
      return `Erreur: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

registerSkill({
  name: "brand.rewrite",
  description: "Rewrite text to match the established brand voice. Preserves the message but adjusts tone and style.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "Text to rewrite in brand voice" },
      platform: { type: "string", description: "Target platform: moltbook, linkedin, twitter, blog (optional)" },
    },
    required: ["text"],
  },
  async execute(args): Promise<string> {
    const text = String(args.text);
    const platform = args.platform ? String(args.platform) : "";

    const entity = kgGetEntity(BRAND_VOICE_ENTITY, BRAND_VOICE_TYPE);
    if (!entity || !entity.properties.guide) {
      return "Aucun guide de voix de marque. Utilise brand.analyze d'abord.";
    }

    const guide = String(entity.properties.guide);
    const platformNote = platform ? `\n\nPlateforme cible: ${platform}. Adapte le format en conséquence (longueur, ton).` : "";

    const prompt = `Rewrite this text to perfectly match the brand voice described below. Keep the same core message but adjust tone, vocabulary, and structure.${platformNote}

BRAND VOICE GUIDE:
${guide.slice(0, 3000)}

ORIGINAL TEXT:
${text}

REWRITTEN TEXT (plain text only, no explanation):`;

    try {
      const rewritten = await askGemini(prompt);
      return `**Texte réécrit${platform ? ` (${platform})` : ""}:**\n\n${rewritten}\n\n---\n_Original: ${text.length} chars → Réécrit: ${rewritten.length} chars_`;
    } catch (err) {
      return `Erreur: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

log.debug("Registered 3 brand.* skills");
