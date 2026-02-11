/**
 * HuggingFace Inference API skills — free NLP models.
 * API: https://api-inference.huggingface.co — free tier (rate-limited).
 * Skills: nlp.summarize, nlp.sentiment, nlp.translate
 */
import { registerSkill } from "../loader.js";
import { config } from "../../config/env.js";

const BASE_URL = "https://api-inference.huggingface.co/models";

async function hfInference(model: string, inputs: string | Record<string, unknown>): Promise<unknown> {
  if (!config.huggingfaceApiKey) {
    throw new Error("HuggingFace non configuré. Ajoute HUGGINGFACE_API_KEY dans .env (gratuit: https://huggingface.co/settings/tokens)");
  }

  const res = await fetch(`${BASE_URL}/${model}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.huggingfaceApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ inputs }),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // Model might be loading
    if (res.status === 503 && body.includes("loading")) {
      throw new Error("Modèle en cours de chargement — réessaie dans ~20s");
    }
    throw new Error(`HuggingFace ${res.status}: ${body.slice(0, 200)}`);
  }

  return res.json();
}

registerSkill({
  name: "nlp.summarize",
  description: "Summarize text using HuggingFace (facebook/bart-large-cnn). Free tier.",
  argsSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "Text to summarize" },
      max_length: { type: "number", description: "Max summary length in tokens (default 150)" },
    },
    required: ["text"],
  },
  async execute(args): Promise<string> {
    const text = String(args.text);
    const maxLen = Number(args.max_length) || 150;

    try {
      const result = await hfInference("facebook/bart-large-cnn", {
        inputs: text.slice(0, 4000),
        parameters: { max_length: maxLen, min_length: 30 },
      }) as Array<{ summary_text: string }>;

      return result[0]?.summary_text || "Aucun résumé généré.";
    } catch (err) {
      return `Erreur: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

registerSkill({
  name: "nlp.sentiment",
  description: "Analyze sentiment of text (positive/negative/neutral). Uses HuggingFace free tier.",
  argsSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "Text to analyze" },
    },
    required: ["text"],
  },
  async execute(args): Promise<string> {
    const text = String(args.text);

    try {
      const result = await hfInference(
        "cardiffnlp/twitter-roberta-base-sentiment-latest",
        text.slice(0, 1000),
      ) as Array<Array<{ label: string; score: number }>>;

      if (!result[0] || result[0].length === 0) return "Pas de résultat.";

      const sentiments = result[0]
        .sort((a, b) => b.score - a.score)
        .map((s) => `  ${s.label}: ${(s.score * 100).toFixed(1)}%`);

      return `**Analyse de sentiment:**\n${sentiments.join("\n")}`;
    } catch (err) {
      return `Erreur: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

registerSkill({
  name: "nlp.translate",
  description: "Translate text between languages using HuggingFace. Default: French → English.",
  argsSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "Text to translate" },
      from: { type: "string", description: "Source language: en, fr, de, es, etc. (default: fr)" },
      to: { type: "string", description: "Target language (default: en)" },
    },
    required: ["text"],
  },
  async execute(args): Promise<string> {
    const text = String(args.text);
    const from = String(args.from || "fr");
    const to = String(args.to || "en");

    // Helsinki-NLP has models for most language pairs
    const model = `Helsinki-NLP/opus-mt-${from}-${to}`;

    try {
      const result = await hfInference(model, text.slice(0, 2000)) as Array<{ translation_text: string }>;
      return result[0]?.translation_text || "Traduction non disponible.";
    } catch (err) {
      return `Erreur: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});
