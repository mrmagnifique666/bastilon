/**
 * Built-in skills using FREE APIs (no API key required).
 *
 * Tier 3 bonus: Open Library, Wayback Machine, Open Food Facts, World Bank
 * All completely free with zero registration.
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
// 1. OPEN LIBRARY — Book search & metadata (no key)
// ═══════════════════════════════════════════════════════════════

registerSkill({
  name: "books.search",
  description:
    "Search for books by title, author, or subject using Open Library (free, no key). " +
    "Returns title, author, year, cover image, and ISBN.",
  argsSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query (title, author name, or subject)" },
      type: { type: "string", description: "Search type: title (default), author, subject" },
      limit: { type: "number", description: "Number of results (default: 5)" },
    },
    required: ["query"],
  },
  async execute(args): Promise<string> {
    const query = encodeURIComponent(String(args.query));
    const limit = Math.min((args.limit as number) || 5, 10);
    const type = String(args.type || "title").toLowerCase();

    const paramMap: Record<string, string> = {
      title: "title",
      author: "author",
      subject: "subject",
    };
    const param = paramMap[type] || "title";

    const data = await apiFetch(
      `https://openlibrary.org/search.json?${param}=${query}&limit=${limit}`
    );
    const docs = data.docs || [];
    if (docs.length === 0) return `No books found for "${args.query}".`;

    return docs
      .map((b: any, i: number) => {
        const authors = (b.author_name || []).slice(0, 2).join(", ") || "Unknown";
        const year = b.first_publish_year || "?";
        const isbn = b.isbn?.[0] || "";
        const coverId = b.cover_i;
        const cover = coverId
          ? `![Cover](https://covers.openlibrary.org/b/id/${coverId}-S.jpg)`
          : "";
        return `${i + 1}. ${cover} **${b.title}** — ${authors} (${year})\n   ISBN: ${isbn || "N/A"} | Editions: ${b.edition_count || "?"}`;
      })
      .join("\n");
  },
});

registerSkill({
  name: "books.details",
  description:
    "Get detailed book information by ISBN or Open Library ID. Returns description, subjects, cover.",
  argsSchema: {
    type: "object",
    properties: {
      isbn: { type: "string", description: "ISBN-10 or ISBN-13" },
      olid: { type: "string", description: "Open Library ID (e.g., OL7353617M) — alternative to ISBN" },
    },
  },
  async execute(args): Promise<string> {
    let key: string;
    let data: any;

    if (args.isbn) {
      key = `ISBN:${args.isbn}`;
      const resp = await apiFetch(
        `https://openlibrary.org/api/books?bibkeys=${key}&format=json&jscmd=data`
      );
      data = resp[key];
    } else if (args.olid) {
      data = await apiFetch(`https://openlibrary.org/books/${args.olid}.json`);
    } else {
      return "Provide either isbn or olid parameter.";
    }

    if (!data) return "Book not found.";

    let output = `**${data.title || "?"}**\n`;
    if (data.authors) {
      output += `Authors: ${data.authors.map((a: any) => a.name || a).join(", ")}\n`;
    }
    if (data.publish_date) output += `Published: ${data.publish_date}\n`;
    if (data.number_of_pages) output += `Pages: ${data.number_of_pages}\n`;
    if (data.subjects) {
      output += `Subjects: ${data.subjects.slice(0, 5).map((s: any) => s.name || s).join(", ")}\n`;
    }
    if (data.cover) {
      output += `\n![Cover](${data.cover.medium || data.cover.small})\n`;
    }
    const desc =
      typeof data.description === "string"
        ? data.description
        : data.description?.value || "";
    if (desc) output += `\n${desc.slice(0, 800)}`;

    return output;
  },
});

// ═══════════════════════════════════════════════════════════════
// 2. WAYBACK MACHINE — Internet Archive (no key)
// ═══════════════════════════════════════════════════════════════

registerSkill({
  name: "archive.check",
  description:
    "Check if a URL has been archived on the Wayback Machine. Returns the latest snapshot URL and date.",
  argsSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL to check" },
      date: { type: "string", description: "Target date YYYYMMDD (default: latest)" },
    },
    required: ["url"],
  },
  async execute(args): Promise<string> {
    const url = encodeURIComponent(String(args.url));
    const timestamp = args.date ? `&timestamp=${args.date}` : "";
    const data = await apiFetch(
      `https://archive.org/wayback/available?url=${url}${timestamp}`
    );
    const snapshot = data.archived_snapshots?.closest;
    if (!snapshot) return `No Wayback Machine snapshots found for "${args.url}".`;
    return (
      `**Wayback Machine Snapshot**\n` +
      `URL: ${args.url}\n` +
      `Archived: ${snapshot.timestamp?.slice(0, 8) || "?"}\n` +
      `Status: ${snapshot.status || "?"}\n` +
      `View: ${snapshot.url}`
    );
  },
});

registerSkill({
  name: "archive.save",
  description:
    "Save a URL to the Wayback Machine (Internet Archive). Triggers archival of the current page state.",
  argsSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL to save/archive" },
    },
    required: ["url"],
  },
  async execute(args): Promise<string> {
    const url = String(args.url);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30_000);
    try {
      const resp = await fetch(`https://web.archive.org/save/${url}`, {
        method: "GET",
        headers: { "User-Agent": UA },
        signal: ctrl.signal,
        redirect: "manual",
      });
      // The save endpoint returns a redirect to the archived URL
      const location = resp.headers.get("location") || resp.headers.get("content-location");
      if (location) {
        return `Page archived successfully!\nView: ${location}`;
      }
      return `Save request sent for ${url}. The page should appear on the Wayback Machine shortly.\nCheck: https://web.archive.org/web/*/${url}`;
    } finally {
      clearTimeout(timer);
    }
  },
});

// ═══════════════════════════════════════════════════════════════
// 3. OPEN FOOD FACTS — Food product database (no key)
// ═══════════════════════════════════════════════════════════════

registerSkill({
  name: "food.barcode",
  description:
    "Look up a food product by barcode (UPC/EAN). Returns nutritional info, ingredients, Nutri-Score. " +
    "Uses Open Food Facts (free, community database).",
  argsSchema: {
    type: "object",
    properties: {
      barcode: { type: "string", description: "Product barcode (UPC or EAN)" },
    },
    required: ["barcode"],
  },
  async execute(args): Promise<string> {
    const barcode = String(args.barcode).trim();
    const data = await apiFetch(
      `https://world.openfoodfacts.org/api/v2/product/${barcode}.json`
    );
    if (data.status !== 1 || !data.product) {
      return `Product not found for barcode "${barcode}".`;
    }
    const p = data.product;
    let output = `**${p.product_name || "Unknown Product"}**\n`;
    if (p.brands) output += `Brand: ${p.brands}\n`;
    if (p.categories) output += `Category: ${p.categories.split(",").slice(0, 3).join(", ")}\n`;
    if (p.nutriscore_grade) output += `Nutri-Score: **${p.nutriscore_grade.toUpperCase()}**\n`;
    if (p.nova_group) output += `NOVA Group: ${p.nova_group}\n`;

    const nut = p.nutriments || {};
    if (Object.keys(nut).length > 0) {
      output += `\n**Nutrition (per 100g):**\n`;
      if (nut["energy-kcal_100g"]) output += `  Calories: ${nut["energy-kcal_100g"]} kcal\n`;
      if (nut.fat_100g !== undefined) output += `  Fat: ${nut.fat_100g}g\n`;
      if (nut.carbohydrates_100g !== undefined) output += `  Carbs: ${nut.carbohydrates_100g}g\n`;
      if (nut.sugars_100g !== undefined) output += `  Sugars: ${nut.sugars_100g}g\n`;
      if (nut.proteins_100g !== undefined) output += `  Protein: ${nut.proteins_100g}g\n`;
      if (nut.salt_100g !== undefined) output += `  Salt: ${nut.salt_100g}g\n`;
      if (nut.fiber_100g !== undefined) output += `  Fiber: ${nut.fiber_100g}g\n`;
    }

    if (p.ingredients_text) {
      output += `\n**Ingredients:** ${p.ingredients_text.slice(0, 500)}`;
    }

    if (p.image_url) output += `\n\n![Product](${p.image_url})`;
    return output;
  },
});

registerSkill({
  name: "food.search",
  description:
    "Search for food products by name or keyword. Returns names, brands, and Nutri-Scores.",
  argsSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Product name or keyword" },
      limit: { type: "number", description: "Number of results (default: 5)" },
    },
    required: ["query"],
  },
  async execute(args): Promise<string> {
    const query = encodeURIComponent(String(args.query));
    const limit = Math.min((args.limit as number) || 5, 10);
    const data = await apiFetch(
      `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${query}&page_size=${limit}&json=1`
    );
    const products = data.products || [];
    if (products.length === 0) return `No food products found for "${args.query}".`;

    return products
      .map((p: any, i: number) => {
        const name = p.product_name || "?";
        const brand = p.brands || "?";
        const score = p.nutriscore_grade ? ` [${p.nutriscore_grade.toUpperCase()}]` : "";
        return `${i + 1}. **${name}** — ${brand}${score}`;
      })
      .join("\n");
  },
});

// ═══════════════════════════════════════════════════════════════
// 4. WORLD BANK — Economic indicators (no key)
// ═══════════════════════════════════════════════════════════════

registerSkill({
  name: "worldbank.indicator",
  description:
    "Get economic indicators from World Bank Open Data. GDP, population, inflation, etc. " +
    "Free, no key, covers 200+ countries.",
  argsSchema: {
    type: "object",
    properties: {
      country: { type: "string", description: "ISO country code: CA, US, FR, or 'WLD' for world (default: CA)" },
      indicator: {
        type: "string",
        description:
          "Indicator code: NY.GDP.MKTP.CD (GDP), SP.POP.TOTL (population), " +
          "FP.CPI.TOTL.ZG (inflation), SL.UEM.TOTL.ZS (unemployment), " +
          "NY.GDP.PCAP.CD (GDP per capita). Default: NY.GDP.MKTP.CD",
      },
      years: { type: "number", description: "Number of recent years to show (default: 5)" },
    },
  },
  async execute(args): Promise<string> {
    const country = String(args.country || "CA").toUpperCase();
    const indicator = String(args.indicator || "NY.GDP.MKTP.CD");
    const years = Math.min((args.years as number) || 5, 15);

    const data = await apiFetch(
      `https://api.worldbank.org/v2/country/${country}/indicator/${indicator}?format=json&per_page=${years}&mrv=${years}`
    );

    if (!Array.isArray(data) || data.length < 2 || !data[1]) {
      return `No data found for ${country} / ${indicator}.`;
    }

    const meta = data[0];
    const records = data[1];
    const indicatorName = records[0]?.indicator?.value || indicator;
    const countryName = records[0]?.country?.value || country;

    let output = `**${indicatorName}** — ${countryName}\n\n`;
    for (const r of records) {
      if (r.value !== null) {
        const val =
          r.value > 1_000_000_000
            ? `${(r.value / 1_000_000_000).toFixed(2)}B`
            : r.value > 1_000_000
              ? `${(r.value / 1_000_000).toFixed(2)}M`
              : typeof r.value === "number"
                ? r.value.toFixed(2)
                : r.value;
        output += `  ${r.date}: ${val}\n`;
      }
    }

    output += `\nSource: World Bank (${meta.total} data points available)`;
    return output;
  },
});

registerSkill({
  name: "worldbank.compare",
  description:
    "Compare an economic indicator across multiple countries. Great for business research.",
  argsSchema: {
    type: "object",
    properties: {
      countries: { type: "string", description: "Country codes separated by semicolons: CA;US;FR (default: CA;US)" },
      indicator: { type: "string", description: "Indicator code (default: NY.GDP.MKTP.CD for GDP)" },
      year: { type: "number", description: "Year to compare (default: latest available)" },
    },
  },
  async execute(args): Promise<string> {
    const countries = String(args.countries || "CA;US").toUpperCase();
    const indicator = String(args.indicator || "NY.GDP.MKTP.CD");
    const yearParam = args.year ? `&date=${args.year}` : "&mrv=1";

    const data = await apiFetch(
      `https://api.worldbank.org/v2/country/${countries}/indicator/${indicator}?format=json&per_page=50${yearParam}`
    );

    if (!Array.isArray(data) || data.length < 2 || !data[1]) {
      return `No comparison data found.`;
    }

    const records = data[1].filter((r: any) => r.value !== null);
    if (records.length === 0) return "No data available for these countries.";

    const indicatorName = records[0]?.indicator?.value || indicator;
    let output = `**${indicatorName}** — Comparison\n\n`;

    // Sort by value descending
    records.sort((a: any, b: any) => (b.value || 0) - (a.value || 0));

    for (const r of records) {
      const val =
        r.value > 1_000_000_000
          ? `${(r.value / 1_000_000_000).toFixed(2)}B`
          : r.value > 1_000_000
            ? `${(r.value / 1_000_000).toFixed(2)}M`
            : typeof r.value === "number"
              ? r.value.toFixed(2)
              : r.value;
      output += `  ${r.country.value} (${r.countryiso3code}): ${val} (${r.date})\n`;
    }

    return output;
  },
});
