/**
 * Built-in skills using FREE APIs (free API key required).
 *
 * Tier 2: finnhub (stocks), stackexchange, nasa, pollinations (AI images)
 * All zero-cost with free registration.
 *
 * Required env vars:
 *   FINNHUB_API_KEY     — https://finnhub.io (free: 60 calls/min)
 *   NASA_API_KEY        — https://api.nasa.gov (free: 1000 calls/hour, or use DEMO_KEY)
 *   NEWSDATA_API_KEY    — https://newsdata.io (free: 200 calls/day) — optional
 */
import { registerSkill } from "../loader.js";

const UA = "Kingston/2.0 (Bastilon OS)";

async function apiFetch(url: string, timeoutMs = 10_000): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    return resp.json();
  } finally {
    clearTimeout(timer);
  }
}

// ═══════════════════════════════════════════════════════════════
// 1. FINNHUB — Real-time stock data (free key: 60 calls/min)
// ═══════════════════════════════════════════════════════════════

const FINNHUB_KEY = () => process.env.FINNHUB_API_KEY || "";

registerSkill({
  name: "finnhub.quote",
  description:
    "Get real-time stock quote (price, change, high, low, open, previous close). Requires FINNHUB_API_KEY.",
  argsSchema: {
    type: "object",
    properties: {
      symbol: { type: "string", description: "Stock ticker symbol (e.g., AAPL, TSLA, MSFT)" },
    },
    required: ["symbol"],
  },
  async execute(args): Promise<string> {
    const key = FINNHUB_KEY();
    if (!key) return "FINNHUB_API_KEY not configured. Get a free key at https://finnhub.io";
    const symbol = String(args.symbol).toUpperCase().trim();
    const data = await apiFetch(
      `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${key}`
    );
    if (!data || data.c === 0) return `No quote data for "${symbol}". Check the symbol.`;
    const change = data.d >= 0 ? `+${data.d.toFixed(2)}` : data.d.toFixed(2);
    const pct = data.dp >= 0 ? `+${data.dp.toFixed(2)}%` : `${data.dp.toFixed(2)}%`;
    return (
      `**${symbol}** — $${data.c.toFixed(2)} (${change} | ${pct})\n` +
      `Open: $${data.o.toFixed(2)} | High: $${data.h.toFixed(2)} | Low: $${data.l.toFixed(2)}\n` +
      `Previous Close: $${data.pc.toFixed(2)}`
    );
  },
});

registerSkill({
  name: "finnhub.news",
  description:
    "Get latest market news or company-specific news. Free Finnhub API.",
  argsSchema: {
    type: "object",
    properties: {
      symbol: { type: "string", description: "Company ticker for company news (omit for general market news)" },
      limit: { type: "number", description: "Number of articles (default: 5)" },
    },
  },
  async execute(args): Promise<string> {
    const key = FINNHUB_KEY();
    if (!key) return "FINNHUB_API_KEY not configured. Get a free key at https://finnhub.io";
    const limit = Math.min((args.limit as number) || 5, 10);

    let url: string;
    if (args.symbol) {
      const symbol = String(args.symbol).toUpperCase().trim();
      const to = new Date().toISOString().slice(0, 10);
      const from = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
      url = `https://finnhub.io/api/v1/company-news?symbol=${symbol}&from=${from}&to=${to}&token=${key}`;
    } else {
      url = `https://finnhub.io/api/v1/news?category=general&token=${key}`;
    }

    const data = await apiFetch(url);
    if (!Array.isArray(data) || data.length === 0) return "No news found.";

    return data
      .slice(0, limit)
      .map((n: any, i: number) => {
        const date = new Date(n.datetime * 1000).toLocaleDateString("fr-CA");
        return `${i + 1}. **${n.headline}** (${n.source}, ${date})\n   ${n.url}`;
      })
      .join("\n");
  },
});

registerSkill({
  name: "finnhub.search",
  description: "Search for stock symbols by company name. Returns ticker, description, type.",
  argsSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Company name or keyword to search" },
    },
    required: ["query"],
  },
  async execute(args): Promise<string> {
    const key = FINNHUB_KEY();
    if (!key) return "FINNHUB_API_KEY not configured.";
    const query = encodeURIComponent(String(args.query));
    const data = await apiFetch(
      `https://finnhub.io/api/v1/search?q=${query}&token=${key}`
    );
    const results = (data.result || []).slice(0, 10);
    if (results.length === 0) return `No symbols found for "${args.query}".`;
    return results
      .map((r: any) => `**${r.symbol}** — ${r.description} (${r.type})`)
      .join("\n");
  },
});

// ═══════════════════════════════════════════════════════════════
// 2. STACK EXCHANGE — Programming Q&A (no key needed for basic)
// ═══════════════════════════════════════════════════════════════

registerSkill({
  name: "stackexchange.search",
  description:
    "Search Stack Overflow questions by keyword. Returns top answers, scores, and links. No API key required.",
  argsSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query (programming question or topic)" },
      site: { type: "string", description: "Site: stackoverflow (default), serverfault, superuser, askubuntu" },
      limit: { type: "number", description: "Number of results (default: 5)" },
    },
    required: ["query"],
  },
  async execute(args): Promise<string> {
    const query = encodeURIComponent(String(args.query));
    const site = String(args.site || "stackoverflow");
    const limit = Math.min((args.limit as number) || 5, 10);
    const data = await apiFetch(
      `https://api.stackexchange.com/2.3/search/advanced?q=${query}&site=${site}&sort=relevance&pagesize=${limit}&filter=!nNPvSNdWme`
    );
    const items = data.items || [];
    if (items.length === 0) return `No results on ${site} for "${args.query}".`;

    return items
      .map((q: any, i: number) => {
        const answered = q.is_answered ? "✓" : "○";
        const tags = (q.tags || []).slice(0, 3).join(", ");
        return (
          `${i + 1}. ${answered} **${decodeHTMLEntities(q.title)}** (score: ${q.score}, answers: ${q.answer_count})\n` +
          `   Tags: ${tags} | ${q.link}`
        );
      })
      .join("\n");
  },
});

registerSkill({
  name: "stackexchange.answers",
  description: "Get top answers for a Stack Overflow question by question ID.",
  argsSchema: {
    type: "object",
    properties: {
      questionId: { type: "number", description: "Question ID (from the URL)" },
      site: { type: "string", description: "Site (default: stackoverflow)" },
    },
    required: ["questionId"],
  },
  async execute(args): Promise<string> {
    const site = String(args.site || "stackoverflow");
    const data = await apiFetch(
      `https://api.stackexchange.com/2.3/questions/${args.questionId}/answers?site=${site}&sort=votes&filter=withbody&pagesize=3`
    );
    const items = data.items || [];
    if (items.length === 0) return "No answers found for this question.";

    return items
      .map((a: any, i: number) => {
        const accepted = a.is_accepted ? " ✓ ACCEPTED" : "";
        // Strip HTML tags for clean text
        const body = (a.body || "")
          .replace(/<code>/g, "`")
          .replace(/<\/code>/g, "`")
          .replace(/<pre>/g, "\n```\n")
          .replace(/<\/pre>/g, "\n```\n")
          .replace(/<[^>]+>/g, "")
          .slice(0, 800);
        return `**Answer ${i + 1}** (score: ${a.score}${accepted})\n${body}`;
      })
      .join("\n\n---\n\n");
  },
});

// ═══════════════════════════════════════════════════════════════
// 3. NASA — Space imagery and data (free key, DEMO_KEY fallback)
// ═══════════════════════════════════════════════════════════════

const NASA_KEY = () => process.env.NASA_API_KEY || "DEMO_KEY";

registerSkill({
  name: "nasa.apod",
  description:
    "Get NASA's Astronomy Picture of the Day (APOD). Returns image URL, title, and explanation. " +
    "Works with DEMO_KEY (30 calls/hour) or free NASA_API_KEY (1000 calls/hour).",
  argsSchema: {
    type: "object",
    properties: {
      date: { type: "string", description: "Date in YYYY-MM-DD format (default: today)" },
    },
  },
  async execute(args): Promise<string> {
    const dateParam = args.date ? `&date=${args.date}` : "";
    const data = await apiFetch(
      `https://api.nasa.gov/planetary/apod?api_key=${NASA_KEY()}${dateParam}`
    );
    let output = `**${data.title}** (${data.date})\n\n`;
    if (data.media_type === "image") {
      output += `![APOD](${data.url})\n\n`;
    } else if (data.media_type === "video") {
      output += `Video: ${data.url}\n\n`;
    }
    output += (data.explanation || "").slice(0, 1000);
    if (data.copyright) output += `\n\nCredit: ${data.copyright}`;
    return output;
  },
});

registerSkill({
  name: "nasa.mars",
  description:
    "Get Mars rover photos from Curiosity, Opportunity, or Spirit rovers. Returns image URLs and camera info.",
  argsSchema: {
    type: "object",
    properties: {
      rover: { type: "string", description: "Rover name: curiosity (default), opportunity, spirit" },
      sol: { type: "number", description: "Martian sol day (default: latest)" },
      camera: { type: "string", description: "Camera: FHAZ, RHAZ, MAST, CHEMCAM, NAVCAM (optional)" },
    },
  },
  async execute(args): Promise<string> {
    const rover = String(args.rover || "curiosity").toLowerCase();
    let url = `https://api.nasa.gov/mars-photos/api/v1/rovers/${rover}/photos?api_key=${NASA_KEY()}`;
    if (args.sol) {
      url += `&sol=${args.sol}`;
    } else {
      // Get latest photos
      url += `&sol=1000`;
    }
    if (args.camera) url += `&camera=${String(args.camera).toLowerCase()}`;
    url += `&page=1`;

    const data = await apiFetch(url);
    const photos = (data.photos || []).slice(0, 5);
    if (photos.length === 0) return `No photos found for ${rover}${args.sol ? ` sol ${args.sol}` : ""}.`;

    return photos
      .map(
        (p: any, i: number) =>
          `${i + 1}. **${p.camera.full_name}** (Sol ${p.sol}, ${p.earth_date})\n   ![Mars](${p.img_src})`
      )
      .join("\n\n");
  },
});

registerSkill({
  name: "nasa.neo",
  description:
    "Get Near Earth Objects (asteroids) approaching Earth this week. Shows size, distance, velocity, and hazard status.",
  argsSchema: {
    type: "object",
    properties: {
      days: { type: "number", description: "Number of days to look ahead (default: 3, max: 7)" },
    },
  },
  async execute(args): Promise<string> {
    const days = Math.min((args.days as number) || 3, 7);
    const start = new Date().toISOString().slice(0, 10);
    const end = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
    const data = await apiFetch(
      `https://api.nasa.gov/neo/rest/v1/feed?start_date=${start}&end_date=${end}&api_key=${NASA_KEY()}`
    );
    const allNeos: any[] = [];
    for (const dateKey of Object.keys(data.near_earth_objects || {}).sort()) {
      for (const neo of data.near_earth_objects[dateKey]) {
        allNeos.push({ ...neo, approach_date: dateKey });
      }
    }
    if (allNeos.length === 0) return "No near-Earth objects found for this period.";

    // Sort by distance
    allNeos.sort((a, b) => {
      const da = parseFloat(a.close_approach_data?.[0]?.miss_distance?.kilometers || "999999999");
      const db = parseFloat(b.close_approach_data?.[0]?.miss_distance?.kilometers || "999999999");
      return da - db;
    });

    let output = `**Near-Earth Objects** (${start} to ${end}) — ${data.element_count} total\n\n`;
    for (const neo of allNeos.slice(0, 8)) {
      const approach = neo.close_approach_data?.[0] || {};
      const hazard = neo.is_potentially_hazardous_asteroid ? "⚠️ HAZARDOUS" : "safe";
      const diameter = neo.estimated_diameter?.meters;
      const sizeStr = diameter
        ? `${diameter.estimated_diameter_min.toFixed(0)}-${diameter.estimated_diameter_max.toFixed(0)}m`
        : "?";
      const dist = approach.miss_distance?.lunar
        ? `${parseFloat(approach.miss_distance.lunar).toFixed(1)} lunar distances`
        : "?";
      const speed = approach.relative_velocity?.kilometers_per_hour
        ? `${parseFloat(approach.relative_velocity.kilometers_per_hour).toFixed(0)} km/h`
        : "?";
      output += `- **${neo.name}** (${sizeStr}) — ${dist}, ${speed} [${hazard}]\n`;
      output += `  Date: ${neo.approach_date}\n`;
    }
    return output;
  },
});

// ═══════════════════════════════════════════════════════════════
// 4. POLLINATIONS.AI — Free AI image generation (no key!)
// ═══════════════════════════════════════════════════════════════

registerSkill({
  name: "pollinations.image",
  description:
    "Generate an AI image from a text prompt using Pollinations.ai (free, no API key, no limits). " +
    "Returns a direct image URL. Great for creating visuals, thumbnails, social media images.",
  argsSchema: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "Text prompt describing the image to generate" },
      width: { type: "number", description: "Image width in pixels (default: 1024)" },
      height: { type: "number", description: "Image height in pixels (default: 1024)" },
      seed: { type: "number", description: "Random seed for reproducibility (optional)" },
    },
    required: ["prompt"],
  },
  async execute(args): Promise<string> {
    const prompt = encodeURIComponent(String(args.prompt));
    const width = (args.width as number) || 1024;
    const height = (args.height as number) || 1024;
    let url = `https://image.pollinations.ai/prompt/${prompt}?width=${width}&height=${height}&nologo=true`;
    if (args.seed) url += `&seed=${args.seed}`;
    return `Image generee:\n![AI Image](${url})\n\nLien direct: ${url}`;
  },
});

registerSkill({
  name: "pollinations.text",
  description:
    "Generate text using Pollinations.ai free API (no key). Uses various open-source models. " +
    "Good for quick text generation without using paid API credits.",
  argsSchema: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "Text prompt" },
      system: { type: "string", description: "System prompt (optional)" },
      model: { type: "string", description: "Model: openai, mistral, llama (default: openai)" },
    },
    required: ["prompt"],
  },
  async execute(args): Promise<string> {
    const prompt = encodeURIComponent(String(args.prompt));
    const model = String(args.model || "openai");
    let url = `https://text.pollinations.ai/${prompt}?model=${model}`;
    if (args.system) url += `&system=${encodeURIComponent(String(args.system))}`;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30_000);
    try {
      const resp = await fetch(url, {
        headers: { "User-Agent": UA },
        signal: ctrl.signal,
      });
      if (!resp.ok) throw new Error(`Pollinations ${resp.status}`);
      const text = await resp.text();
      return text.slice(0, 3000);
    } finally {
      clearTimeout(timer);
    }
  },
});

// ═══════════════════════════════════════════════════════════════
// 5. NEWSDATA.IO — News with sentiment (free key: 200 calls/day)
// ═══════════════════════════════════════════════════════════════

registerSkill({
  name: "newsdata.latest",
  description:
    "Get latest news with sentiment analysis from NewsData.io. Free tier: 200 calls/day. " +
    "Supports language and country filtering. Requires NEWSDATA_API_KEY.",
  argsSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search keyword (optional)" },
      country: { type: "string", description: "Country code: ca, us, fr, gb (default: ca)" },
      language: { type: "string", description: "Language: fr, en (default: fr)" },
      category: { type: "string", description: "Category: business, technology, science, health, sports, entertainment" },
      limit: { type: "number", description: "Number of articles (default: 5)" },
    },
  },
  async execute(args): Promise<string> {
    const key = process.env.NEWSDATA_API_KEY;
    if (!key) return "NEWSDATA_API_KEY not configured. Get a free key at https://newsdata.io";
    const limit = Math.min((args.limit as number) || 5, 10);
    const country = String(args.country || "ca");
    const language = String(args.language || "fr");

    let url = `https://newsdata.io/api/1/latest?apikey=${key}&country=${country}&language=${language}`;
    if (args.query) url += `&q=${encodeURIComponent(String(args.query))}`;
    if (args.category) url += `&category=${args.category}`;

    const data = await apiFetch(url, 15_000);
    const articles = (data.results || []).slice(0, limit);
    if (articles.length === 0) return "No news articles found.";

    return articles
      .map((a: any, i: number) => {
        const sentiment = a.sentiment ? ` [${a.sentiment}]` : "";
        const source = a.source_name || a.source_id || "?";
        return `${i + 1}. **${a.title}**${sentiment} (${source}, ${a.pubDate?.slice(0, 10) || "?"})\n   ${a.link || ""}`;
      })
      .join("\n");
  },
});

// ═══════════════════════════════════════════════════════════════
// HELPER
// ═══════════════════════════════════════════════════════════════

function decodeHTMLEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}
