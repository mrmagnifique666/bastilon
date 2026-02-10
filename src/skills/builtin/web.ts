/**
 * Built-in skills: web.fetch, web.search
 * Fetch a URL or search the web via Brave Search API.
 */
import { registerSkill } from "../loader.js";
import { config } from "../../config/env.js";
import { checkSSRF } from "../../security/ssrf.js";

const MAX_BODY = 12000;

/**
 * Naive HTML tag stripper — removes tags and decodes common entities.
 */
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

registerSkill({
  name: "web.fetch",
  description: "Fetch a URL and return its text content (HTML tags stripped, truncated to ~12 KB).",
  argsSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL to fetch" },
    },
    required: ["url"],
  },
  async execute(args): Promise<string> {
    const url = args.url as string;

    // SSRF protection via shared module (DNS resolution + private IP blocking)
    const ssrfError = await checkSSRF(url);
    if (ssrfError) return ssrfError;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      const res = await fetch(url, {
        signal: controller.signal,
        headers: { "User-Agent": "ClaudeRelay/1.0" },
      });
      clearTimeout(timeout);

      if (!res.ok) {
        return `Error: HTTP ${res.status} ${res.statusText}`;
      }

      const contentType = res.headers.get("content-type") || "";
      const body = await res.text();

      let text: string;
      if (contentType.includes("text/html")) {
        text = stripHtml(body);
      } else {
        text = body;
      }

      if (text.length > MAX_BODY) {
        text = text.slice(0, MAX_BODY) + "\n...(truncated)";
      }

      return text || "(empty response)";
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

// --- Brave Search ---

const BRAVE_TIMEOUT_MS = 10_000;
const MAX_RESULTS = 8;

interface BraveWebResult {
  title: string;
  url: string;
  description: string;
}

interface BraveSearchResponse {
  web?: { results?: BraveWebResult[] };
  query?: { original: string };
}

registerSkill({
  name: "web.search",
  description:
    "Search the web using Brave Search API. Returns top results with title, URL, and description.",
  argsSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      count: { type: "number", description: "Number of results (default 5, max 8)" },
    },
    required: ["query"],
  },
  async execute(args): Promise<string> {
    const query = args.query as string;
    const count = Math.min((args.count as number) || 5, MAX_RESULTS);

    if (!config.braveSearchApiKey) {
      return "Error: BRAVE_SEARCH_API_KEY not configured.";
    }

    const params = new URLSearchParams({
      q: query,
      count: String(count),
      search_lang: "fr",
      text_decorations: "false",
    });

    const url = `https://api.search.brave.com/res/v1/web/search?${params}`;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), BRAVE_TIMEOUT_MS);

      const res = await fetch(url, {
        headers: {
          Accept: "application/json",
          "Accept-Encoding": "gzip",
          "X-Subscription-Token": config.braveSearchApiKey,
        },
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return `Error: Brave API ${res.status}: ${body.slice(0, 200)}`;
      }

      const data = (await res.json()) as BraveSearchResponse;
      const results = data.web?.results;

      if (!results || results.length === 0) {
        return `No results found for "${query}".`;
      }

      return results
        .map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.description}`)
        .join("\n\n");
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return "Error: Brave Search request timed out (10s).";
      }
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});
