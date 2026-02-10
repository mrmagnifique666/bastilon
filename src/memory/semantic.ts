/**
 * Semantic memory system — inspired by MemU.
 * Embeddings via Gemini (free), extraction via Gemini Flash, storage in SQLite.
 * Provides automatic memory extraction, semantic search, and salience scoring.
 */
import crypto from "node:crypto";
import { config } from "../config/env.js";
import { getDb } from "../storage/store.js";
import { log } from "../utils/log.js";

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

// --- Salience ---

function calculateSalience(item: MemoryRow): number {
  const daysSinceAccess = (Date.now() / 1000 - item.last_accessed_at) / 86400;
  const recencyDecay = Math.pow(0.5, daysSinceAccess / 30); // half-life: 30 days
  const reinforcement = Math.min(item.access_count / 10, 1.0);
  const baseSalience = item.salience;
  return baseSalience * 0.4 + recencyDecay * 0.3 + reinforcement * 0.3;
}

// --- Content Hash ---

function hashContent(content: string): string {
  const normalized = content.toLowerCase().trim().replace(/\s+/g, " ");
  return crypto.createHash("sha256").update(normalized).digest("hex");
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
  let embeddingJson: string | null = null;
  try {
    const embedding = await embedText(content);
    embeddingJson = JSON.stringify(embedding);
  } catch (err) {
    log.warn(`[semantic] Embedding failed for new memory: ${err instanceof Error ? err.message : String(err)}`);
  }

  const info = db
    .prepare(
      `INSERT INTO memory_items (category, content, content_hash, embedding, salience, source, chat_id, last_accessed_at)
       VALUES (?, ?, ?, ?, 0.5, ?, ?, unixepoch())`
    )
    .run(category, content, hash, embeddingJson, source, chatId ?? null);

  log.debug(`[semantic] Added memory #${info.lastInsertRowid} [${category}]: ${content.slice(0, 80)}`);
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

// --- Build context for prompt injection ---

export async function buildSemanticContext(userMessage: string, limit: number = 10): Promise<string> {
  if (!config.geminiApiKey) return "";

  try {
    const db = getDb();
    const count = (db.prepare("SELECT COUNT(*) as c FROM memory_items").get() as { c: number }).c;
    if (count === 0) return "";

    const results = await searchMemories(userMessage, limit);
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
