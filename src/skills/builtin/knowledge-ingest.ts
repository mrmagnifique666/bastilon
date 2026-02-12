/**
 * Built-in skills: memory.ingest, memory.recall
 * RAG URL Ingestion — save any web content, chunk it, embed it, recall later.
 */
import crypto from "node:crypto";
import { registerSkill, getSkill } from "../loader.js";
import { getDb } from "../../storage/store.js";
import { embedText } from "../../memory/semantic.js";
import { cosineSimilarity } from "../../memory/semantic.js";
import { log } from "../../utils/log.js";

// --- URL normalization ---

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    // Remove tracking params
    u.searchParams.delete("utm_source");
    u.searchParams.delete("utm_medium");
    u.searchParams.delete("utm_campaign");
    u.searchParams.delete("ref");
    u.searchParams.delete("fbclid");
    // Lowercase host, remove trailing slash
    return u.toString().replace(/\/$/, "");
  } catch {
    return url.trim().toLowerCase();
  }
}

// --- Source type detection ---

function detectSourceType(url: string): string {
  const lower = url.toLowerCase();
  if (lower.includes("youtube.com/watch") || lower.includes("youtu.be/")) return "youtube";
  if (lower.includes("twitter.com/") || lower.includes("x.com/")) return "tweet";
  if (lower.includes("reddit.com/")) return "reddit";
  return "article";
}

// --- Content chunking ---

function chunkContent(text: string, chunkSize = 800, overlap = 200): string[] {
  if (text.length <= chunkSize) return [text];

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end = start + chunkSize;

    // Try to break at sentence boundary
    if (end < text.length) {
      const lastPeriod = text.lastIndexOf(".", end);
      const lastNewline = text.lastIndexOf("\n", end);
      const breakPoint = Math.max(lastPeriod, lastNewline);
      if (breakPoint > start + chunkSize / 2) {
        end = breakPoint + 1;
      }
    }

    chunks.push(text.slice(start, end).trim());
    start = end - overlap;
    if (start >= text.length) break;
  }

  return chunks.filter(c => c.length > 0);
}

// --- Extractors ---

async function extractArticle(url: string): Promise<{ title: string; content: string } | null> {
  const fetchSkill = getSkill("web.fetch");
  if (!fetchSkill) {
    // Direct fetch fallback
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) return null;
      const html = await res.text();
      // Simple extraction: strip HTML tags
      const text = html
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
      return { title: titleMatch?.[1]?.trim() || url, content: text.slice(0, 10000) };
    } catch {
      return null;
    }
  }

  try {
    const result = await fetchSkill.execute({ url });
    // web.fetch returns the content as text
    return { title: url, content: String(result).slice(0, 10000) };
  } catch {
    return null;
  }
}

async function extractYouTube(url: string): Promise<{ title: string; content: string } | null> {
  try {
    const noembedUrl = `https://noembed.com/embed?url=${encodeURIComponent(url)}`;
    const res = await fetch(noembedUrl, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const data = await res.json();
    const title = data.title || "YouTube video";
    const author = data.author_name || "";
    return { title, content: `${title} by ${author}. ${data.provider_name || "YouTube"}.` };
  } catch {
    return null;
  }
}

async function extractTweet(url: string): Promise<{ title: string; content: string } | null> {
  try {
    // Use fxtwitter API (free, no auth)
    const tweetUrl = url.replace("twitter.com", "api.fxtwitter.com").replace("x.com", "api.fxtwitter.com");
    const res = await fetch(tweetUrl, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const data = await res.json();
    const tweet = data.tweet;
    if (!tweet) return null;
    return {
      title: `@${tweet.author?.screen_name || "unknown"}: ${(tweet.text || "").slice(0, 60)}`,
      content: tweet.text || "",
    };
  } catch {
    return null;
  }
}

// --- Skills ---

registerSkill({
  name: "memory.ingest",
  description:
    "Ingest a URL into the knowledge base: extract content, chunk it, embed each chunk for later recall. Supports articles, YouTube, tweets.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL to ingest" },
      tags: { type: "string", description: "Comma-separated tags (optional)" },
    },
    required: ["url"],
  },
  async execute(args): Promise<string> {
    const url = String(args.url).trim();
    const tags = args.tags ? String(args.tags).split(",").map(t => t.trim()).filter(Boolean) : [];
    const urlNormalized = normalizeUrl(url);
    const sourceType = detectSourceType(url);
    const d = getDb();

    // Check URL dupe
    const existing = d.prepare("SELECT id, title FROM knowledge_sources WHERE url_normalized = ?")
      .get(urlNormalized) as { id: number; title: string } | undefined;
    if (existing) {
      return `URL déjà ingérée: "${existing.title}" (source #${existing.id})`;
    }

    // Extract content
    let extracted: { title: string; content: string } | null = null;
    if (sourceType === "youtube") {
      extracted = await extractYouTube(url);
    } else if (sourceType === "tweet") {
      extracted = await extractTweet(url);
    } else {
      extracted = await extractArticle(url);
    }

    if (!extracted || extracted.content.length < 20) {
      return `Erreur: impossible d'extraire le contenu de ${url} (contenu trop court ou page d'erreur).`;
    }

    // Hash content to detect dupe by content
    const contentHash = crypto.createHash("sha256").update(extracted.content).digest("hex");
    const hashDupe = d.prepare("SELECT id, title FROM knowledge_sources WHERE content_hash = ?")
      .get(contentHash) as { id: number; title: string } | undefined;
    if (hashDupe) {
      return `Contenu identique déjà ingéré: "${hashDupe.title}" (source #${hashDupe.id})`;
    }

    // Store source
    const info = d.prepare(
      `INSERT INTO knowledge_sources (url, url_normalized, title, source_type, summary, raw_content, content_hash, tags)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      url, urlNormalized, extracted.title, sourceType,
      extracted.content.slice(0, 300),
      extracted.content, contentHash, JSON.stringify(tags),
    );
    const sourceId = info.lastInsertRowid as number;

    // Chunk and embed
    const chunks = chunkContent(extracted.content);
    let embedded = 0;

    for (let i = 0; i < chunks.length; i++) {
      try {
        const embedding = await embedText(chunks[i]);
        d.prepare(
          "INSERT INTO knowledge_chunks (source_id, chunk_index, content, embedding) VALUES (?, ?, ?, ?)"
        ).run(sourceId, i, chunks[i], JSON.stringify(embedding));
        embedded++;
      } catch (err) {
        log.debug(`[memory.ingest] Chunk ${i} embed failed: ${err}`);
        // Store without embedding
        d.prepare(
          "INSERT INTO knowledge_chunks (source_id, chunk_index, content) VALUES (?, ?, ?)"
        ).run(sourceId, i, chunks[i]);
      }
    }

    return (
      `Ingested: "${extracted.title}" (${sourceType})\n` +
      `Source #${sourceId} — ${chunks.length} chunks (${embedded} embedded)\n` +
      `Content: ${extracted.content.length} chars\n` +
      (tags.length > 0 ? `Tags: ${tags.join(", ")}` : "")
    );
  },
});

registerSkill({
  name: "memory.recall",
  description:
    "Recall knowledge from ingested URLs. Semantic search across all chunks, returns top matches with source URLs.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      limit: { type: "number", description: "Max results (default: 5)" },
      source_type: { type: "string", description: "Filter by source type: article, youtube, tweet (optional)" },
    },
    required: ["query"],
  },
  async execute(args): Promise<string> {
    const query = String(args.query);
    const limit = Number(args.limit) || 5;
    const sourceType = args.source_type ? String(args.source_type) : undefined;
    const d = getDb();

    // Embed query
    let queryEmb: number[];
    try {
      queryEmb = await embedText(query);
    } catch (err) {
      return `Erreur d'embedding: ${err instanceof Error ? err.message : String(err)}`;
    }

    // Load all chunks with embeddings
    let chunkQuery = `SELECT kc.*, ks.url, ks.title, ks.source_type
       FROM knowledge_chunks kc
       JOIN knowledge_sources ks ON kc.source_id = ks.id
       WHERE kc.embedding IS NOT NULL`;
    const params: unknown[] = [];
    if (sourceType) {
      chunkQuery += " AND ks.source_type = ?";
      params.push(sourceType);
    }

    const chunks = d.prepare(chunkQuery).all(...params) as Array<{
      id: number; source_id: number; chunk_index: number; content: string;
      embedding: string; url: string; title: string; source_type: string;
    }>;

    if (chunks.length === 0) {
      return "Aucune connaissance ingérée. Utilise memory.ingest pour ajouter des URLs.";
    }

    // Score and rank
    const scored = chunks.map(chunk => {
      let emb: number[];
      try { emb = JSON.parse(chunk.embedding); } catch { return null; }
      const score = cosineSimilarity(queryEmb, emb);
      return { ...chunk, score };
    }).filter(Boolean) as Array<typeof chunks[0] & { score: number }>;

    scored.sort((a, b) => b.score - a.score);

    // Dedup by source (keep best chunk per source)
    const seen = new Set<number>();
    const results: typeof scored = [];
    for (const s of scored) {
      if (seen.has(s.source_id)) continue;
      seen.add(s.source_id);
      results.push(s);
      if (results.length >= limit) break;
    }

    if (results.length === 0) {
      return "Aucun résultat pertinent trouvé.";
    }

    const lines = [`**Résultats pour "${query}"** (${results.length} sources):\n`];
    for (const r of results) {
      const excerpt = r.content.slice(0, 200) + (r.content.length > 200 ? "..." : "");
      lines.push(
        `**${r.title}** (${r.source_type}, ${Math.round(r.score * 100)}%)` +
        `\n  ${r.url}` +
        `\n  ${excerpt}\n`
      );
    }

    return lines.join("\n");
  },
});

log.debug("Registered 2 memory.ingest/recall skills");
