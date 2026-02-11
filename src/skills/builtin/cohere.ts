/**
 * Cohere API skills — free embeddings & reranking.
 * API: https://cohere.com — free tier (1000 req/min, rate-limited).
 * Skills: cohere.embed, cohere.rerank
 */
import { registerSkill } from "../loader.js";
import { config } from "../../config/env.js";

const BASE_URL = "https://api.cohere.com/v1";

async function cohereRequest(endpoint: string, body: Record<string, unknown>): Promise<unknown> {
  if (!config.cohereApiKey) {
    throw new Error("Cohere non configuré. Ajoute COHERE_API_KEY dans .env (gratuit: https://dashboard.cohere.com/api-keys)");
  }

  const res = await fetch(`${BASE_URL}/${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.cohereApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Cohere ${res.status}: ${text.slice(0, 200)}`);
  }

  return res.json();
}

registerSkill({
  name: "cohere.embed",
  description: "Generate text embeddings using Cohere (free tier, 1000 req/min). Returns vector dimensions.",
  argsSchema: {
    type: "object",
    properties: {
      texts: { type: "string", description: "Texts to embed, one per line (max 96)" },
      input_type: { type: "string", description: "search_document | search_query | classification | clustering (default: search_document)" },
    },
    required: ["texts"],
  },
  async execute(args): Promise<string> {
    const texts = String(args.texts).split("\n").filter((t) => t.trim()).slice(0, 96);
    const inputType = String(args.input_type || "search_document");

    try {
      const data = (await cohereRequest("embed", {
        texts,
        model: "embed-multilingual-v3.0",
        input_type: inputType,
        truncate: "END",
      })) as { embeddings: number[][]; meta?: { billed_units?: { input_tokens: number } } };

      const dims = data.embeddings[0]?.length || 0;
      const tokens = data.meta?.billed_units?.input_tokens || 0;

      return [
        `**${data.embeddings.length} embedding(s) generated**`,
        `  Dimensions: ${dims}`,
        `  Model: embed-multilingual-v3.0`,
        `  Input type: ${inputType}`,
        `  Tokens facturés: ${tokens}`,
        `  Premier vecteur (5 premiers): [${data.embeddings[0]?.slice(0, 5).map((v) => v.toFixed(4)).join(", ")}...]`,
      ].join("\n");
    } catch (err) {
      return `Erreur: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

registerSkill({
  name: "cohere.rerank",
  description: "Rerank documents by relevance to a query using Cohere. Great for improving search results.",
  argsSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "The search query" },
      documents: { type: "string", description: "Documents to rerank, one per line" },
      top_n: { type: "number", description: "Return top N results (default 5)" },
    },
    required: ["query", "documents"],
  },
  async execute(args): Promise<string> {
    const query = String(args.query);
    const documents = String(args.documents).split("\n").filter((d) => d.trim());
    const topN = Number(args.top_n) || 5;

    if (documents.length < 2) return "Besoin d'au moins 2 documents à reranger.";

    try {
      const data = (await cohereRequest("rerank", {
        query,
        documents: documents.map((text) => ({ text })),
        model: "rerank-multilingual-v3.0",
        top_n: topN,
      })) as { results: Array<{ index: number; relevance_score: number }> };

      return data.results
        .map((r, i) => {
          const score = (r.relevance_score * 100).toFixed(1);
          const text = documents[r.index]?.slice(0, 120) || "(?)";
          return `${i + 1}. [${score}%] ${text}`;
        })
        .join("\n");
    } catch (err) {
      return `Erreur: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});
