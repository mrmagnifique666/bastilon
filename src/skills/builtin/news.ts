/**
 * NewsAPI skills — free headlines and search (100 req/day).
 * API: https://newsapi.org — free developer tier.
 * Skills: news.headlines, news.search
 */
import { registerSkill } from "../loader.js";
import { config } from "../../config/env.js";
import { log } from "../../utils/log.js";

const BASE_URL = "https://newsapi.org/v2";

interface NewsArticle {
  title: string;
  description: string;
  url: string;
  source: { name: string };
  publishedAt: string;
}

interface NewsResponse {
  status: string;
  totalResults: number;
  articles: NewsArticle[];
}

async function fetchNews(endpoint: string, params: Record<string, string>): Promise<string> {
  if (!config.newsApiKey) {
    return "NewsAPI non configuré. Ajoute NEWS_API_KEY dans .env (gratuit: https://newsapi.org)";
  }

  const url = `${BASE_URL}/${endpoint}?${new URLSearchParams({ ...params, apiKey: config.newsApiKey })}`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return `NewsAPI error ${res.status}: ${body.slice(0, 200)}`;
    }

    const data = (await res.json()) as NewsResponse;
    if (!data.articles || data.articles.length === 0) {
      return "Aucun article trouvé.";
    }

    return data.articles
      .slice(0, 8)
      .map((a, i) => {
        const date = a.publishedAt ? a.publishedAt.split("T")[0] : "";
        return `${i + 1}. **${a.title}** (${a.source.name}, ${date})\n   ${a.description || ""}\n   ${a.url}`;
      })
      .join("\n\n");
  } catch (err) {
    return `NewsAPI error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

registerSkill({
  name: "news.headlines",
  description: "Get top news headlines. Supports country and category filters. Free: 100 req/day.",
  argsSchema: {
    type: "object",
    properties: {
      country: { type: "string", description: "2-letter country code (default: ca)" },
      category: { type: "string", description: "business | entertainment | general | health | science | sports | technology" },
    },
  },
  async execute(args): Promise<string> {
    const params: Record<string, string> = {
      country: String(args.country || "ca"),
    };
    if (args.category) params.category = String(args.category);
    return fetchNews("top-headlines", params);
  },
});

registerSkill({
  name: "news.search",
  description: "Search news articles by keyword. Returns recent articles matching the query.",
  argsSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search keywords" },
      language: { type: "string", description: "Language (default: fr)" },
      sort_by: { type: "string", description: "relevancy | popularity | publishedAt (default: publishedAt)" },
    },
    required: ["query"],
  },
  async execute(args): Promise<string> {
    return fetchNews("everything", {
      q: String(args.query),
      language: String(args.language || "fr"),
      sortBy: String(args.sort_by || "publishedAt"),
      pageSize: "8",
    });
  },
});
