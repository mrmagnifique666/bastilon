/**
 * Semantic memory system — inspired by MemU.
 * Embeddings via Gemini (free), extraction via Gemini Flash, storage in SQLite.
 * Provides automatic memory extraction, semantic search, and salience scoring.
 */
import crypto from "node:crypto";
import { config } from "../config/env.js";
import { getDb, getSummary, getTurns } from "../storage/store.js";
import { log } from "../utils/log.js";
import { calculateTrust, type DataKind } from "./trust-decay.js";

// --- Types ---

export type MemoryCategory = "profile" | "preference" | "event" | "knowledge" | "skill" | "project";

export interface MemoryItem {
  id: number;
  category: MemoryCategory;
  content: string;
  content_hash: string;
  embedding: number[] | null;
  salience: number;
  access_count: number;
  last_accessed_at: number;
  source: string;
  chat_id: number | null;
  created_at: number;
  updated_at: number;
}

export interface MemoryStats {
  total: number;
  byCategory: Record<string, number>;
  avgSalience: number;
  oldestDate: string | null;
  mostAccessed: { id: number; content: string; access_count: number } | null;
}

interface MemoryRow {
  id: number;
  category: string;
  content: string;
  content_hash: string;
  embedding: string | null;
  salience: number;
  access_count: number;
  last_accessed_at: number;
  source: string;
  chat_id: number | null;
  created_at: number;
  updated_at: number;
}

// --- Embedding ---

const EMBEDDING_DIMS = 768;

export async function embedText(text: string): Promise<number[]> {
  if (!config.geminiApiKey) {
    throw new Error("GEMINI_API_KEY not configured — cannot embed text");
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${config.geminiApiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: { parts: [{ text }] },
      output_dimensionality: EMBEDDING_DIMS,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini embedding failed (${res.status}): ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  return data.embedding.values;
}

// --- Cosine Similarity ---

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// --- Salience (trust-decay aware) ---

/** Map memory category → trust-decay DataKind */
const CATEGORY_DECAY: Record<string, DataKind> = {
  profile: "fact",        // 180-day half-life
  preference: "fact",     // 180-day half-life
  knowledge: "observation", // 30-day half-life
  skill: "observation",     // 30-day half-life
  project: "external",      // 7-day half-life
  event: "external",        // 7-day half-life
};

function calculateSalience(item: MemoryRow): number {
  const kind = CATEGORY_DECAY[item.category] || "observation";
  const trustDecay = calculateTrust(item.created_at, kind);
  const reinforcement = Math.min(item.access_count / 10, 1.0);
  const baseSalience = item.salience;
  return baseSalience * 0.35 + trustDecay * 0.35 + reinforcement * 0.3;
}

// --- Content Hash ---

function hashContent(content: string): string {
  const normalized = content.toLowerCase().trim().replace(/\s+/g, " ");
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

// --- Semantic Dedup ---

/**
 * Find the nearest existing memory within the same category.
 * Returns {id, similarity} if cosine > threshold, else null.
 */
function findNearestMemory(
  embedding: number[],
  category: MemoryCategory,
  threshold: number
): { id: number; similarity: number } | null {
  const db = getDb();
  const rows = db
    .prepare("SELECT id, embedding FROM memory_items WHERE category = ? AND embedding IS NOT NULL")
    .all(category) as Array<{ id: number; embedding: string }>;

  let bestId = -1;
  let bestSim = -1;

  for (const row of rows) {
    const other = JSON.parse(row.embedding) as number[];
    const sim = cosineSimilarity(embedding, other);
    if (sim > bestSim) {
      bestSim = sim;
      bestId = row.id;
    }
  }

  return bestSim >= threshold ? { id: bestId, similarity: bestSim } : null;
}

// --- CRUD ---

export async function addMemory(
  content: string,
  category: MemoryCategory = "knowledge",
  source: string = "manual",
  chatId?: number
): Promise<number> {
  const db = getDb();
  const hash = hashContent(content);

  // Check for duplicate
  const existing = db
    .prepare("SELECT id, access_count, salience FROM memory_items WHERE content_hash = ?")
    .get(hash) as { id: number; access_count: number; salience: number } | undefined;

  if (existing) {
    // Reinforce existing memory
    db.prepare(
      `UPDATE memory_items SET access_count = access_count + 1,
       salience = MIN(salience + 0.1, 1.0),
       last_accessed_at = unixepoch(), updated_at = unixepoch()
       WHERE id = ?`
    ).run(existing.id);
    log.debug(`[semantic] Reinforced memory #${existing.id} (hash collision)`);
    return existing.id;
  }

  // Embed the content
  let embedding: number[] | null = null;
  let embeddingJson: string | null = null;
  try {
    embedding = await embedText(content);
    embeddingJson = JSON.stringify(embedding);
  } catch (err) {
    log.warn(`[semantic] Embedding failed for new memory: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Semantic dedup: if near-duplicate exists in same category, reinforce instead of inserting
  if (embedding) {
    const nearest = findNearestMemory(embedding, category, config.memoryDedupThreshold);
    if (nearest) {
      db.prepare(
        `UPDATE memory_items SET access_count = access_count + 1,
         salience = MIN(salience + 0.05, 1.0),
         last_accessed_at = unixepoch(), updated_at = unixepoch()
         WHERE id = ?`
      ).run(nearest.id);
      log.debug(`[semantic] Near-dup of #${nearest.id} (sim=${nearest.similarity.toFixed(3)}), reinforced`);
      return nearest.id;
    }
  }

  const info = db
    .prepare(
      `INSERT INTO memory_items (category, content, content_hash, embedding, salience, source, chat_id, last_accessed_at)
       VALUES (?, ?, ?, ?, 0.5, ?, ?, unixepoch())`
    )
    .run(category, content, hash, embeddingJson, source, chatId ?? null);

  log.debug(`[semantic] Added memory #${info.lastInsertRowid} [${category}]: ${content.slice(0, 80)}`);

  // Auto-prune if over ceiling
  pruneIfOverCeiling();

  return info.lastInsertRowid as number;
}

export async function reinforceMemory(id: number): Promise<void> {
  const db = getDb();
  db.prepare(
    `UPDATE memory_items SET access_count = access_count + 1,
     salience = MIN(salience + 0.05, 1.0),
     last_accessed_at = unixepoch(), updated_at = unixepoch()
     WHERE id = ?`
  ).run(id);
}

export function forgetMemory(id: number): boolean {
  const db = getDb();
  const info = db.prepare("DELETE FROM memory_items WHERE id = ?").run(id);
  return info.changes > 0;
}

export function getMemoryStats(): MemoryStats {
  const db = getDb();

  const total = (db.prepare("SELECT COUNT(*) as c FROM memory_items").get() as { c: number }).c;

  const categories = db
    .prepare("SELECT category, COUNT(*) as c FROM memory_items GROUP BY category")
    .all() as { category: string; c: number }[];
  const byCategory: Record<string, number> = {};
  for (const row of categories) {
    byCategory[row.category] = row.c;
  }

  const avgRow = db
    .prepare("SELECT AVG(salience) as avg FROM memory_items")
    .get() as { avg: number | null };

  const oldest = db
    .prepare("SELECT created_at FROM memory_items ORDER BY created_at ASC LIMIT 1")
    .get() as { created_at: number } | undefined;

  const mostAccessed = db
    .prepare("SELECT id, content, access_count FROM memory_items ORDER BY access_count DESC LIMIT 1")
    .get() as { id: number; content: string; access_count: number } | undefined;

  return {
    total,
    byCategory,
    avgSalience: avgRow.avg ?? 0,
    oldestDate: oldest ? new Date(oldest.created_at * 1000).toISOString().split("T")[0] : null,
    mostAccessed: mostAccessed ?? null,
  };
}

// --- Semantic Search ---

export async function searchMemories(query: string, limit: number = 10): Promise<(MemoryItem & { score: number })[]> {
  const db = getDb();

  // Get all memories with embeddings
  const rows = db
    .prepare("SELECT * FROM memory_items WHERE embedding IS NOT NULL")
    .all() as MemoryRow[];

  if (rows.length === 0) return [];

  // Embed the query
  let queryEmbedding: number[];
  try {
    queryEmbedding = await embedText(query);
  } catch (err) {
    log.warn(`[semantic] Query embedding failed, falling back to text search: ${err instanceof Error ? err.message : String(err)}`);
    return fallbackTextSearch(query, limit);
  }

  // Score each memory: cosine similarity * salience weight
  const scored = rows.map((row) => {
    const embedding = JSON.parse(row.embedding!) as number[];
    const similarity = cosineSimilarity(queryEmbedding, embedding);
    const salience = calculateSalience(row);
    // Weighted score: 70% similarity + 30% salience
    const score = similarity * 0.7 + salience * 0.3;
    return { ...rowToItem(row), score };
  });

  // Sort by score descending, take top N
  scored.sort((a, b) => b.score - a.score);
  const results = scored.slice(0, limit);

  // Update access counts for returned results
  const now = Math.floor(Date.now() / 1000);
  const updateStmt = db.prepare(
    "UPDATE memory_items SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?"
  );
  for (const item of results) {
    if (item.score > 0.3) { // Only count meaningful accesses
      updateStmt.run(now, item.id);
    }
  }

  return results.filter((r) => r.score > 0.2); // Filter noise
}

function fallbackTextSearch(query: string, limit: number): (MemoryItem & { score: number })[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM memory_items WHERE content LIKE ? ORDER BY salience DESC LIMIT ?")
    .all(`%${query}%`, limit) as MemoryRow[];
  return rows.map((row) => ({ ...rowToItem(row), score: 0.5 }));
}

function rowToItem(row: MemoryRow): MemoryItem {
  return {
    ...row,
    category: row.category as MemoryCategory,
    embedding: row.embedding ? JSON.parse(row.embedding) : null,
  };
}

// --- Auto-Pruning ---

function pruneIfOverCeiling(): void {
  const db = getDb();
  const count = (db.prepare("SELECT COUNT(*) as c FROM memory_items").get() as { c: number }).c;
  if (count <= config.memoryMaxItems) return;

  log.info(`[semantic] Memory ceiling hit (${count}/${config.memoryMaxItems}), pruning to ${config.memoryPruneTarget}...`);

  // Score all memories, delete the lowest-scored ones
  const rows = db.prepare("SELECT * FROM memory_items").all() as MemoryRow[];
  const scored = rows.map(r => ({ id: r.id, score: calculateSalience(r) }));
  scored.sort((a, b) => a.score - b.score); // ascending — worst first

  const toDelete = scored.slice(0, count - config.memoryPruneTarget).map(s => s.id);
  if (toDelete.length === 0) return;

  db.prepare(`DELETE FROM memory_items WHERE id IN (${toDelete.join(",")})`).run();
  log.info(`[semantic] Pruned ${toDelete.length} low-salience memories (${count} → ${count - toDelete.length})`);
}

// --- Cleanup & Consolidation ---

/**
 * One-time cleanup: delete trivial memories, merge near-duplicates.
 * Returns {deleted, merged}.
 */
export function runMemoryCleanup(): { deleted: number; merged: number } {
  const db = getDb();
  let deleted = 0;
  let merged = 0;

  // Step 1: Delete trivial memories
  const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 86400;
  const trivialResult = db.prepare(
    `DELETE FROM memory_items
     WHERE length(content) < 10
        OR (salience < 0.15 AND access_count = 0 AND created_at < ?)`
  ).run(thirtyDaysAgo);
  deleted += trivialResult.changes;
  log.info(`[semantic] Cleanup: deleted ${trivialResult.changes} trivial memories`);

  // Step 2: Merge near-duplicates within each category
  const categories = db.prepare("SELECT DISTINCT category FROM memory_items").all() as { category: string }[];

  for (const { category } of categories) {
    const rows = db.prepare(
      "SELECT id, embedding, salience, access_count FROM memory_items WHERE category = ? AND embedding IS NOT NULL ORDER BY salience DESC"
    ).all(category) as Array<{ id: number; embedding: string; salience: number; access_count: number }>;

    const deletedIds = new Set<number>();

    for (let i = 0; i < rows.length; i++) {
      if (deletedIds.has(rows[i].id)) continue;
      const embA = JSON.parse(rows[i].embedding) as number[];

      for (let j = i + 1; j < rows.length; j++) {
        if (deletedIds.has(rows[j].id)) continue;
        const embB = JSON.parse(rows[j].embedding) as number[];
        const sim = cosineSimilarity(embA, embB);

        if (sim >= config.memoryDedupThreshold) {
          // Keep the one with higher salience (rows are sorted by salience DESC → keep i)
          const keepId = rows[i].id;
          const removeId = rows[j].id;
          db.prepare(
            `UPDATE memory_items SET access_count = access_count + ?, updated_at = unixepoch() WHERE id = ?`
          ).run(rows[j].access_count, keepId);
          db.prepare("DELETE FROM memory_items WHERE id = ?").run(removeId);
          deletedIds.add(removeId);
          merged++;
        }
      }
    }
  }

  log.info(`[semantic] Cleanup: merged ${merged} near-duplicates`);
  return { deleted, merged };
}

/**
 * Consolidate memories via clustering + Gemini Flash summarization.
 * Groups semantically similar memories (cosine > 0.80), then merges clusters of 3+.
 */
export async function consolidateMemories(options?: {
  category?: MemoryCategory;
  dryRun?: boolean;
}): Promise<{ clusters: number; consolidated: number; removed: number }> {
  const db = getDb();
  const dryRun = options?.dryRun ?? false;
  const categoryFilter = options?.category;
  let totalClusters = 0;
  let totalConsolidated = 0;
  let totalRemoved = 0;

  const categories = categoryFilter
    ? [{ category: categoryFilter }]
    : db.prepare("SELECT DISTINCT category FROM memory_items").all() as { category: string }[];

  for (const { category } of categories) {
    const rows = db.prepare(
      "SELECT id, content, embedding, salience, access_count FROM memory_items WHERE category = ? AND embedding IS NOT NULL"
    ).all(category) as Array<{ id: number; content: string; embedding: string; salience: number; access_count: number }>;

    if (rows.length < 3) continue;

    // Greedy clustering: cosine > 0.80
    const assigned = new Set<number>();
    const clusters: Array<typeof rows> = [];

    for (let i = 0; i < rows.length; i++) {
      if (assigned.has(rows[i].id)) continue;
      const cluster = [rows[i]];
      assigned.add(rows[i].id);
      const embA = JSON.parse(rows[i].embedding) as number[];

      for (let j = i + 1; j < rows.length; j++) {
        if (assigned.has(rows[j].id)) continue;
        const embB = JSON.parse(rows[j].embedding) as number[];
        if (cosineSimilarity(embA, embB) > 0.80) {
          cluster.push(rows[j]);
          assigned.add(rows[j].id);
        }
      }

      if (cluster.length >= 3) {
        clusters.push(cluster);
      }
    }

    if (clusters.length === 0) continue;
    totalClusters += clusters.length;

    if (dryRun) {
      for (const c of clusters) {
        totalConsolidated++;
        totalRemoved += c.length;
        log.info(`[semantic] [dry-run] Cluster (${category}, ${c.length} items): ${c.map(m => `#${m.id}`).join(", ")}`);
      }
      continue;
    }

    // Consolidate each cluster via Gemini Flash
    for (const cluster of clusters) {
      try {
        const contents = cluster.map(m => `- ${m.content}`).join("\n");
        const prompt = `These ${cluster.length} memories about "${category}" are semantically similar. Merge them into ONE concise memory (1-2 sentences, French if the originals are French, English otherwise). Keep only the most important facts.\n\n${contents}\n\nMerged memory (plain text, no quotes):`;

        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${config.geminiApiKey}`;
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.1, maxOutputTokens: 256 },
          }),
        });

        if (!res.ok) {
          log.warn(`[semantic] Consolidation API failed for cluster: ${res.status}`);
          continue;
        }

        const data = await res.json();
        const merged = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (!merged || merged.length < 5) continue;

        // Sum access counts from all cluster members
        const totalAccess = cluster.reduce((sum, m) => sum + m.access_count, 0);
        const maxSalience = Math.max(...cluster.map(m => m.salience));

        // Insert consolidated memory
        await addMemory(merged, category as MemoryCategory, "consolidated");
        // Update salience/access on the newly inserted one
        db.prepare(
          `UPDATE memory_items SET access_count = ?, salience = ?
           WHERE content_hash = ? AND source = 'consolidated'`
        ).run(totalAccess, maxSalience, hashContent(merged));

        // Delete old cluster members
        const ids = cluster.map(m => m.id);
        db.prepare(`DELETE FROM memory_items WHERE id IN (${ids.join(",")})`).run();

        totalConsolidated++;
        totalRemoved += cluster.length;
        log.info(`[semantic] Consolidated ${cluster.length} memories → "${merged.slice(0, 60)}..."`);
      } catch (err) {
        log.warn(`[semantic] Consolidation error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return { clusters: totalClusters, consolidated: totalConsolidated, removed: totalRemoved };
}

// --- Extraction (Gemini Flash) ---

const EXTRACTION_PROMPT = `Analyze this conversation and extract important memories. Return a JSON array.

Categories:
- profile: facts about the user (name, job, location, phone, etc.)
- preference: user preferences (language, style, schedule, etc.)
- event: past or future events (meetings, deployments, deadlines)
- knowledge: technical facts, business info, learnings
- skill: capabilities, configured APIs, tools learned
- project: project status, decisions, objectives, priorities

Rules:
- Only extract FACTUAL information, not opinions or small talk
- Each memory should be a single, atomic fact (1 sentence)
- Skip greetings, tool call syntax, error messages
- If nothing meaningful, return []

Conversation:
{conversation}

Return ONLY a JSON array:
[{"category": "...", "content": "..."}, ...]`;

export async function extractAndStoreMemories(chatId: number, conversation: string): Promise<number> {
  if (!config.geminiApiKey) return 0;

  // Skip very short conversations
  if (conversation.length < 50) return 0;

  // Truncate to last ~2000 chars to keep extraction focused
  const trimmed = conversation.length > 2000 ? conversation.slice(-2000) : conversation;

  try {
    const prompt = EXTRACTION_PROMPT.replace("{conversation}", trimmed);

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${config.geminiApiKey}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 1024,
        },
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      log.warn(`[semantic] Extraction API failed (${res.status}): ${errText.slice(0, 200)}`);
      return 0;
    }

    const data = await res.json();
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";

    // Parse JSON from response (may be wrapped in markdown fences)
    const jsonStr = rawText.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
    if (!jsonStr || jsonStr === "[]") return 0;

    let memories: Array<{ category: string; content: string }>;
    try {
      memories = JSON.parse(jsonStr);
    } catch {
      log.debug(`[semantic] Failed to parse extraction JSON: ${jsonStr.slice(0, 200)}`);
      return 0;
    }

    if (!Array.isArray(memories)) return 0;

    // Validate categories
    const validCategories = new Set<string>(["profile", "preference", "event", "knowledge", "skill", "project"]);
    let stored = 0;

    for (const mem of memories) {
      if (!mem.content || typeof mem.content !== "string" || mem.content.length < 5) continue;
      const category = validCategories.has(mem.category) ? mem.category as MemoryCategory : "knowledge";

      try {
        await addMemory(mem.content, category, "auto", chatId);
        stored++;
      } catch (err) {
        log.debug(`[semantic] Failed to store memory: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return stored;
  } catch (err) {
    log.debug(`[semantic] Extraction failed: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}

// --- Enriched Query for Short/Ambiguous Messages ---

/**
 * Build an enriched query for semantic search when the user message is too short
 * or ambiguous (e.g. "fais-le", "ok", "oui") to have meaningful semantic value.
 * Enriches with recent turns + active topics from conversation summary.
 */
export function buildEnrichedQuery(userMessage: string, chatId: number): string {
  // Long messages have enough semantic content on their own
  if (userMessage.length >= 50) return userMessage;

  const parts: string[] = [];

  // 1. Active topics from conversation summary
  try {
    const summary = getSummary(chatId);
    if (summary?.topics && summary.topics.length > 0) {
      parts.push(summary.topics.join(" "));
    }
  } catch { /* no summary available */ }

  // 2. Recent turns for context (last 3 user messages)
  try {
    const turns = getTurns(chatId);
    const recentUser = turns
      .filter((t) => t.role === "user")
      .slice(-3)
      .map((t) => t.content.slice(0, 100));
    if (recentUser.length > 0) {
      parts.push(recentUser.join(" "));
    }
  } catch { /* no turns available */ }

  // 3. The original message
  parts.push(userMessage);

  const enriched = parts.join(" ").slice(0, 300);
  if (enriched.length > userMessage.length + 10) {
    log.debug(`[semantic] Enriched query: "${userMessage}" → "${enriched.slice(0, 80)}..."`);
  }
  return enriched;
}

// --- Build context for prompt injection ---

export async function buildSemanticContext(userMessage: string, limit: number = 10, chatId?: number): Promise<string> {
  if (!config.geminiApiKey) return "";

  try {
    const db = getDb();
    const count = (db.prepare("SELECT COUNT(*) as c FROM memory_items").get() as { c: number }).c;
    if (count === 0) return "";

    // Use enriched query for short messages when chatId is available
    const query = chatId ? buildEnrichedQuery(userMessage, chatId) : userMessage;
    const results = await searchMemories(query, limit);
    if (results.length === 0) return "";

    const lines: string[] = ["[SEMANTIC MEMORY — relevant memories]"];
    for (const item of results) {
      lines.push(`[${item.category}] #${item.id} (score: ${item.score.toFixed(2)}): ${item.content}`);
    }
    return lines.join("\n");
  } catch (err) {
    log.debug(`[semantic] buildSemanticContext failed: ${err instanceof Error ? err.message : String(err)}`);
    return "";
  }
}

// --- Migration: notes → memory_items ---

export async function migrateNotesToMemories(): Promise<number> {
  const db = getDb();

  // Skip if already migrated
  const migrated = db
    .prepare("SELECT COUNT(*) as c FROM memory_items WHERE source = 'migration'")
    .get() as { c: number };
  if (migrated.c > 0) {
    log.debug(`[semantic] Notes already migrated (${migrated.c} items)`);
    return 0;
  }

  // Check if notes table has entries
  let notes: Array<{ id: number; text: string; created_at: number }>;
  try {
    notes = db
      .prepare("SELECT id, text, created_at FROM notes ORDER BY id ASC")
      .all() as Array<{ id: number; text: string; created_at: number }>;
  } catch {
    return 0;
  }

  if (notes.length === 0) return 0;

  log.info(`[semantic] Migrating ${notes.length} notes to semantic memory...`);
  let count = 0;

  for (const note of notes) {
    try {
      // Auto-categorize using simple heuristics (no API call needed for migration)
      const category = categorizeByHeuristic(note.text);
      await addMemory(note.text, category, "migration");
      count++;
    } catch (err) {
      log.debug(`[semantic] Failed to migrate note #${note.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  log.info(`[semantic] Migrated ${count}/${notes.length} notes to semantic memory`);
  return count;
}

function categorizeByHeuristic(text: string): MemoryCategory {
  const lower = text.toLowerCase();
  if (/\b(nom|name|prénom|téléphone|phone|email|adresse|address|âge|age)\b/.test(lower)) return "profile";
  if (/\b(préfère|prefer|aime|like|déteste|hate|toujours|never|jamais)\b/.test(lower)) return "preference";
  if (/\b(réunion|meeting|rendez-vous|deadline|échéance|demain|tomorrow|lundi|mardi)\b/.test(lower)) return "event";
  if (/\b(projet|project|objectif|goal|priorité|priority|sprint|milestone)\b/.test(lower)) return "project";
  if (/\b(api|sdk|config|installed|configured|setup|skill|outil|tool)\b/.test(lower)) return "skill";
  return "knowledge";
}
