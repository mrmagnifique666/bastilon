/**
 * Built-in skills using FREE APIs (no API key required).
 *
 * Tier 1: hackernews, wiki, geo, qr, url, dict, words, holidays, dns
 * All zero-cost, no registration needed.
 */
import { registerSkill } from "../loader.js";

const UA = "Kingston/2.0 (Bastilon OS; contact: nicolas@qplus.plus)";

// ── Helper: fetch with timeout + user-agent ──
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
// 1. HACKER NEWS — Tech news feed (Firebase API, no key)
// ═══════════════════════════════════════════════════════════════

const HN = "https://hacker-news.firebaseio.com/v0";

registerSkill({
  name: "hackernews.top",
  description:
    "Get top stories from Hacker News with titles, scores, and URLs. Great for tech news briefings.",
  argsSchema: {
    type: "object",
    properties: {
      limit: { type: "number", description: "Number of stories (default: 10, max: 30)" },
    },
  },
  async execute(args): Promise<string> {
    const limit = Math.min((args.limit as number) || 10, 30);
    const ids: number[] = await apiFetch(`${HN}/topstories.json`);
    const topIds = ids.slice(0, limit);

    const stories = await Promise.all(
      topIds.map((id) => apiFetch(`${HN}/item/${id}.json`))
    );

    return stories
      .filter(Boolean)
      .map((s: any, i: number) => {
        const url = s.url ? ` — ${s.url}` : "";
        return `${i + 1}. **${s.title}** (${s.score} pts, ${s.descendants || 0} comments)${url}`;
      })
      .join("\n");
  },
});

registerSkill({
  name: "hackernews.search",
  description: "Search Hacker News stories by keyword using Algolia HN Search API.",
  argsSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      limit: { type: "number", description: "Number of results (default: 10)" },
    },
    required: ["query"],
  },
  async execute(args): Promise<string> {
    const query = encodeURIComponent(String(args.query));
    const limit = Math.min((args.limit as number) || 10, 20);
    const data = await apiFetch(
      `https://hn.algolia.com/api/v1/search?query=${query}&hitsPerPage=${limit}&tags=story`
    );
    const hits = data.hits || [];
    if (hits.length === 0) return `No Hacker News results for "${args.query}".`;

    return hits
      .map((h: any, i: number) => {
        const url = h.url ? ` — ${h.url}` : "";
        return `${i + 1}. **${h.title}** (${h.points || 0} pts, ${h.num_comments || 0} comments)${url}`;
      })
      .join("\n");
  },
});

// ═══════════════════════════════════════════════════════════════
// 2. WIKIPEDIA — Knowledge lookup (MediaWiki API, no key)
// ═══════════════════════════════════════════════════════════════

const WIKI_EN = "https://en.wikipedia.org/w/api.php";
const WIKI_FR = "https://fr.wikipedia.org/w/api.php";

registerSkill({
  name: "wiki.summary",
  description:
    "Get a Wikipedia summary for a topic. Returns extract text (first paragraph). Supports EN and FR.",
  argsSchema: {
    type: "object",
    properties: {
      topic: { type: "string", description: "Topic to look up" },
      lang: { type: "string", description: "Language: en or fr (default: fr)" },
    },
    required: ["topic"],
  },
  async execute(args): Promise<string> {
    const lang = String(args.lang || "fr").toLowerCase();
    const base = lang === "en" ? WIKI_EN : WIKI_FR;
    const topic = encodeURIComponent(String(args.topic));
    const data = await apiFetch(
      `${base}?action=query&titles=${topic}&prop=extracts&exintro=1&explaintext=1&redirects=1&format=json`
    );
    const pages = data.query?.pages || {};
    const page = Object.values(pages)[0] as any;
    if (!page || page.missing !== undefined) {
      return `Aucun article Wikipedia trouve pour "${args.topic}" (${lang}).`;
    }
    const extract = (page.extract || "").slice(0, 1500);
    return `**${page.title}** (Wikipedia ${lang.toUpperCase()})\n\n${extract}`;
  },
});

registerSkill({
  name: "wiki.search",
  description: "Search Wikipedia articles by keyword. Returns titles and snippets.",
  argsSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      lang: { type: "string", description: "Language: en or fr (default: fr)" },
      limit: { type: "number", description: "Max results (default: 5)" },
    },
    required: ["query"],
  },
  async execute(args): Promise<string> {
    const lang = String(args.lang || "fr").toLowerCase();
    const base = lang === "en" ? WIKI_EN : WIKI_FR;
    const query = encodeURIComponent(String(args.query));
    const limit = Math.min((args.limit as number) || 5, 10);
    const data = await apiFetch(
      `${base}?action=query&list=search&srsearch=${query}&srlimit=${limit}&format=json`
    );
    const results = data.query?.search || [];
    if (results.length === 0) return `Aucun resultat Wikipedia pour "${args.query}".`;

    return results
      .map((r: any, i: number) => {
        const snippet = (r.snippet || "").replace(/<[^>]+>/g, "").slice(0, 120);
        return `${i + 1}. **${r.title}** — ${snippet}...`;
      })
      .join("\n");
  },
});

// ═══════════════════════════════════════════════════════════════
// 3. GEOCODING — Nominatim / OpenStreetMap (no key, 1 req/sec)
// ═══════════════════════════════════════════════════════════════

registerSkill({
  name: "geo.search",
  description:
    "Search for an address or place name and get coordinates, full address. Uses OpenStreetMap Nominatim (free, no key).",
  argsSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Address or place name to search" },
      limit: { type: "number", description: "Max results (default: 3)" },
    },
    required: ["query"],
  },
  async execute(args): Promise<string> {
    const query = encodeURIComponent(String(args.query));
    const limit = Math.min((args.limit as number) || 3, 5);
    const data = await apiFetch(
      `https://nominatim.openstreetmap.org/search?q=${query}&format=jsonv2&limit=${limit}&addressdetails=1`
    );
    if (!Array.isArray(data) || data.length === 0) {
      return `Aucun resultat pour "${args.query}".`;
    }
    return data
      .map((r: any, i: number) =>
        `${i + 1}. **${r.display_name}**\n   Lat: ${r.lat}, Lon: ${r.lon} | Type: ${r.type}`
      )
      .join("\n");
  },
});

registerSkill({
  name: "geo.reverse",
  description: "Reverse geocode: get address from latitude/longitude coordinates.",
  argsSchema: {
    type: "object",
    properties: {
      lat: { type: "number", description: "Latitude" },
      lon: { type: "number", description: "Longitude" },
    },
    required: ["lat", "lon"],
  },
  async execute(args): Promise<string> {
    const data = await apiFetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${args.lat}&lon=${args.lon}&format=jsonv2&addressdetails=1`
    );
    if (!data || data.error) return `Aucune adresse trouvee pour ${args.lat}, ${args.lon}.`;
    const a = data.address || {};
    return (
      `**${data.display_name}**\n` +
      `Rue: ${a.road || "-"} | Ville: ${a.city || a.town || a.village || "-"}\n` +
      `Province/Etat: ${a.state || "-"} | Pays: ${a.country || "-"} | Code postal: ${a.postcode || "-"}`
    );
  },
});

// ═══════════════════════════════════════════════════════════════
// 4. QR CODE — goQR.me (no key, unlimited)
// ═══════════════════════════════════════════════════════════════

registerSkill({
  name: "qr.generate",
  description:
    "Generate a QR code image URL for any text, URL, or data. Returns a direct PNG link.",
  argsSchema: {
    type: "object",
    properties: {
      data: { type: "string", description: "Text or URL to encode in the QR code" },
      size: { type: "number", description: "Size in pixels (default: 300)" },
    },
    required: ["data"],
  },
  async execute(args): Promise<string> {
    const data = encodeURIComponent(String(args.data));
    const size = (args.size as number) || 300;
    const url = `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${data}`;
    return `QR Code genere:\n![QR Code](${url})\n\nLien direct: ${url}`;
  },
});

// ═══════════════════════════════════════════════════════════════
// 5. URL SHORTENER — is.gd (no key)
// ═══════════════════════════════════════════════════════════════

registerSkill({
  name: "url.shorten",
  description: "Shorten a URL using is.gd (free, no API key). Returns a short URL.",
  argsSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL to shorten" },
    },
    required: ["url"],
  },
  async execute(args): Promise<string> {
    const longUrl = encodeURIComponent(String(args.url));
    const resp = await fetch(
      `https://is.gd/create.php?format=json&url=${longUrl}`,
      { headers: { "User-Agent": UA } }
    );
    if (!resp.ok) throw new Error(`is.gd error: ${resp.status}`);
    const data = await resp.json() as { shorturl?: string; errorcode?: number; errormessage?: string };
    if (data.errorcode) return `Erreur: ${data.errormessage}`;
    return `URL raccourcie: ${data.shorturl}\nOriginal: ${args.url}`;
  },
});

// ═══════════════════════════════════════════════════════════════
// 6. DICTIONARY — Free Dictionary API (no key)
// ═══════════════════════════════════════════════════════════════

registerSkill({
  name: "dict.define",
  description:
    "Look up a word definition, phonetics, and examples. Supports English. For French, use wiki.summary.",
  argsSchema: {
    type: "object",
    properties: {
      word: { type: "string", description: "Word to look up" },
    },
    required: ["word"],
  },
  async execute(args): Promise<string> {
    const word = encodeURIComponent(String(args.word).toLowerCase().trim());
    const resp = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${word}`);
    if (!resp.ok) {
      if (resp.status === 404) return `Word "${args.word}" not found in dictionary.`;
      throw new Error(`Dictionary API ${resp.status}`);
    }
    const data = (await resp.json()) as any[];
    const entry = data[0];
    if (!entry) return `No definition found for "${args.word}".`;

    let output = `**${entry.word}**`;
    if (entry.phonetic) output += ` ${entry.phonetic}`;
    output += "\n";

    for (const meaning of (entry.meanings || []).slice(0, 3)) {
      output += `\n*${meaning.partOfSpeech}*\n`;
      for (const def of (meaning.definitions || []).slice(0, 2)) {
        output += `  - ${def.definition}\n`;
        if (def.example) output += `    Example: "${def.example}"\n`;
      }
    }

    if (entry.sourceUrls?.[0]) output += `\nSource: ${entry.sourceUrls[0]}`;
    return output;
  },
});

// ═══════════════════════════════════════════════════════════════
// 7. WORDS — Datamuse API (no key, 100K req/day)
// ═══════════════════════════════════════════════════════════════

registerSkill({
  name: "words.related",
  description:
    "Find related words: synonyms, similar meaning, sounds-like, rhymes. Uses Datamuse API (free, no key).",
  argsSchema: {
    type: "object",
    properties: {
      word: { type: "string", description: "The word to find relations for" },
      type: {
        type: "string",
        description:
          "Relation type: synonyms (default), rhymes, sounds_like, spelled_like, triggers (associated words)",
      },
      limit: { type: "number", description: "Max results (default: 10)" },
    },
    required: ["word"],
  },
  async execute(args): Promise<string> {
    const word = encodeURIComponent(String(args.word).trim());
    const limit = Math.min((args.limit as number) || 10, 20);
    const typeMap: Record<string, string> = {
      synonyms: "ml",
      rhymes: "rel_rhy",
      sounds_like: "sl",
      spelled_like: "sp",
      triggers: "rel_trg",
    };
    const type = String(args.type || "synonyms").toLowerCase();
    const param = typeMap[type] || "ml";

    const data = await apiFetch(
      `https://api.datamuse.com/words?${param}=${word}&max=${limit}`
    );
    if (!Array.isArray(data) || data.length === 0) {
      return `No ${type} found for "${args.word}".`;
    }
    return (
      `**${type}** for "${args.word}":\n` +
      data.map((w: any) => `  - ${w.word} (score: ${w.score || 0})`).join("\n")
    );
  },
});

// ═══════════════════════════════════════════════════════════════
// 8. HOLIDAYS — Nager.Date API (no key)
// ═══════════════════════════════════════════════════════════════

registerSkill({
  name: "holidays.list",
  description:
    "List public holidays for a country and year. Useful for scheduling around holidays. Uses Nager.Date API (free).",
  argsSchema: {
    type: "object",
    properties: {
      country: {
        type: "string",
        description: "ISO 3166-1 alpha-2 country code (default: CA for Canada)",
      },
      year: { type: "number", description: "Year (default: current year)" },
    },
  },
  async execute(args): Promise<string> {
    const country = String(args.country || "CA").toUpperCase();
    const year = (args.year as number) || new Date().getFullYear();
    const data = await apiFetch(
      `https://date.nager.at/api/v3/PublicHolidays/${year}/${country}`
    );
    if (!Array.isArray(data) || data.length === 0) {
      return `No holidays found for ${country} in ${year}.`;
    }

    // Show upcoming holidays first
    const today = new Date().toISOString().slice(0, 10);
    const upcoming = data.filter((h: any) => h.date >= today);
    const past = data.filter((h: any) => h.date < today);

    let output = `**Jours feries ${country} ${year}** (${data.length} total)\n\n`;

    if (upcoming.length > 0) {
      output += `**A venir:**\n`;
      for (const h of upcoming.slice(0, 10)) {
        output += `  ${h.date} — ${h.localName} (${h.name})\n`;
      }
    }
    if (past.length > 0 && upcoming.length < 5) {
      output += `\n**Passes:**\n`;
      for (const h of past.slice(-5)) {
        output += `  ${h.date} — ${h.localName} (${h.name})\n`;
      }
    }
    return output;
  },
});

// NOTE: forex.convert already exists in forex.ts — skipped here to avoid duplicates

// ═══════════════════════════════════════════════════════════════
// 10. DNS LOOKUP — Google DNS API (no key)
// ═══════════════════════════════════════════════════════════════

registerSkill({
  name: "dns.lookup",
  description:
    "DNS record lookup for a domain using Google Public DNS. Supports A, AAAA, MX, TXT, CNAME, NS record types.",
  argsSchema: {
    type: "object",
    properties: {
      domain: { type: "string", description: "Domain name to look up" },
      type: {
        type: "string",
        description: "Record type: A (default), AAAA, MX, TXT, CNAME, NS",
      },
    },
    required: ["domain"],
  },
  async execute(args): Promise<string> {
    const domain = String(args.domain).trim();
    const type = String(args.type || "A").toUpperCase();
    const data = await apiFetch(
      `https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=${type}`
    );

    let output = `**DNS ${type}** for ${domain}\n`;
    output += `Status: ${data.Status === 0 ? "OK (NOERROR)" : `Code ${data.Status}`}\n`;

    if (data.Answer && data.Answer.length > 0) {
      output += `\nRecords:\n`;
      for (const r of data.Answer) {
        output += `  ${r.name} (TTL: ${r.TTL}s) → ${r.data}\n`;
      }
    } else {
      output += `\nNo ${type} records found.`;
    }

    if (data.Comment) output += `\nNote: ${data.Comment}`;
    return output;
  },
});
