/**
 * Serper.dev skills — Google Search API (2500 free searches/month).
 * More accurate than DuckDuckGo, structured results.
 * Skills: google.search, google.news, google.images
 */
import { registerSkill } from "../loader.js";
import { config } from "../../config/env.js";

const BASE_URL = "https://google.serper.dev";

interface SerperResult {
  title: string;
  link: string;
  snippet: string;
  position?: number;
}

interface SerperNewsResult {
  title: string;
  link: string;
  snippet: string;
  date: string;
  source: string;
}

interface SerperImageResult {
  title: string;
  imageUrl: string;
  link: string;
}

async function serperFetch(endpoint: string, body: Record<string, unknown>): Promise<unknown> {
  if (!config.serperApiKey) {
    throw new Error("Serper.dev non configuré. Ajoute SERPER_API_KEY dans .env (gratuit: https://serper.dev)");
  }

  const res = await fetch(`${BASE_URL}/${endpoint}`, {
    method: "POST",
    headers: {
      "X-API-KEY": config.serperApiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Serper ${res.status}: ${text.slice(0, 200)}`);
  }

  return res.json();
}

registerSkill({
  name: "google.search",
  description: "Google Search via Serper.dev (2500 free/month). More accurate than DuckDuckGo.",
  argsSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      num: { type: "number", description: "Number of results (default 5, max 10)" },
    },
    required: ["query"],
  },
  async execute(args): Promise<string> {
    const query = String(args.query);
    const num = Math.min(Number(args.num) || 5, 10);

    try {
      const data = (await serperFetch("search", { q: query, num, gl: "ca", hl: "fr" })) as {
        organic?: SerperResult[];
        answerBox?: { answer?: string; snippet?: string };
      };

      const lines: string[] = [];

      // Include answer box if present
      if (data.answerBox?.answer || data.answerBox?.snippet) {
        lines.push(`**Réponse directe:** ${data.answerBox.answer || data.answerBox.snippet}\n`);
      }

      if (data.organic && data.organic.length > 0) {
        for (const r of data.organic.slice(0, num)) {
          lines.push(`${r.position || ""}. **${r.title}**\n   ${r.link}\n   ${r.snippet}`);
        }
      }

      return lines.length > 0 ? lines.join("\n\n") : `Aucun résultat pour "${query}".`;
    } catch (err) {
      return `Erreur: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

registerSkill({
  name: "google.news",
  description: "Google News search via Serper.dev. Returns recent news articles.",
  argsSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "News search query" },
      num: { type: "number", description: "Number of results (default 5)" },
    },
    required: ["query"],
  },
  async execute(args): Promise<string> {
    const query = String(args.query);
    const num = Math.min(Number(args.num) || 5, 10);

    try {
      const data = (await serperFetch("news", { q: query, num, gl: "ca", hl: "fr" })) as {
        news?: SerperNewsResult[];
      };

      if (!data.news || data.news.length === 0) return `Aucune news pour "${query}".`;

      return data.news
        .slice(0, num)
        .map((n, i) => `${i + 1}. **${n.title}** (${n.source}, ${n.date})\n   ${n.snippet}\n   ${n.link}`)
        .join("\n\n");
    } catch (err) {
      return `Erreur: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

registerSkill({
  name: "google.images",
  description: "Google Image search via Serper.dev. Returns image URLs.",
  argsSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Image search query" },
      num: { type: "number", description: "Number of results (default 5)" },
    },
    required: ["query"],
  },
  async execute(args): Promise<string> {
    const query = String(args.query);
    const num = Math.min(Number(args.num) || 5, 10);

    try {
      const data = (await serperFetch("images", { q: query, num })) as {
        images?: SerperImageResult[];
      };

      if (!data.images || data.images.length === 0) return `Aucune image pour "${query}".`;

      return data.images
        .slice(0, num)
        .map((img, i) => `${i + 1}. **${img.title}**\n   Image: ${img.imageUrl}\n   Source: ${img.link}`)
        .join("\n\n");
    } catch (err) {
      return `Erreur: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});
