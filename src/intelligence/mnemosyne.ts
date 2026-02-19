/**
 * Mnemosyne — Intelligent memory decay and scoring.
 * Named after the Greek goddess of memory.
 *
 * Four scoring signals:
 * 1. Connectivity: how many other memories/entities link to this one
 * 2. Frequency: how often this memory has been accessed
 * 3. Recency: exponential decay based on time since last access
 * 4. Entropy: information uniqueness (length + distinct words ratio)
 *
 * Based on: "Memory in the Age of AI Agents" (arXiv 2512.13564, December 2025)
 */
import { getDb } from "../storage/store.js";
import { log } from "../utils/log.js";

// ── Schema Migration ──

export function ensureMnemosyneColumns(): void {
  const db = getDb();

  // Add columns to memory_items if they don't exist
  const cols = db.prepare("PRAGMA table_info(memory_items)").all() as Array<{ name: string }>;
  const colNames = new Set(cols.map(c => c.name));

  if (!colNames.has("access_count")) {
    try { db.exec("ALTER TABLE memory_items ADD COLUMN access_count INTEGER DEFAULT 0"); } catch { /* already exists */ }
  }
  if (!colNames.has("last_accessed_at")) {
    try { db.exec("ALTER TABLE memory_items ADD COLUMN last_accessed_at INTEGER DEFAULT 0"); } catch { /* already exists */ }
  }
  if (!colNames.has("mnemosyne_score")) {
    try { db.exec("ALTER TABLE memory_items ADD COLUMN mnemosyne_score REAL DEFAULT 0.5"); } catch { /* already exists */ }
  }
  if (!colNames.has("archived")) {
    try { db.exec("ALTER TABLE memory_items ADD COLUMN archived INTEGER DEFAULT 0"); } catch { /* already exists */ }
  }

  // Add columns to episodic_events too
  const epCols = db.prepare("PRAGMA table_info(episodic_events)").all() as Array<{ name: string }>;
  const epColNames = new Set(epCols.map(c => c.name));

  if (!epColNames.has("access_count")) {
    try { db.exec("ALTER TABLE episodic_events ADD COLUMN access_count INTEGER DEFAULT 0"); } catch { /* already exists */ }
  }
  if (!epColNames.has("last_accessed_at")) {
    try { db.exec("ALTER TABLE episodic_events ADD COLUMN last_accessed_at INTEGER DEFAULT 0"); } catch { /* already exists */ }
  }
  if (!epColNames.has("mnemosyne_score")) {
    try { db.exec("ALTER TABLE episodic_events ADD COLUMN mnemosyne_score REAL DEFAULT 0.5"); } catch { /* already exists */ }
  }

  log.debug("[mnemosyne] Schema columns verified");
}

// ── Scoring Functions ──

/**
 * Calculate connectivity score (0-1).
 * How many KG relations reference this entity?
 */
function connectivityScore(content: string, db: any): number {
  try {
    // Extract potential entity names from the memory content
    const words = content.split(/\s+/).filter(w => w.length > 3 && /^[A-Z]/.test(w));
    if (words.length === 0) return 0.1;

    let totalRelations = 0;
    for (const word of words.slice(0, 5)) {
      // Join through kg_entities to match by name
      const count = db.prepare(
        `SELECT COUNT(*) as c FROM kg_relations r
         JOIN kg_entities e1 ON r.from_entity_id = e1.id
         JOIN kg_entities e2 ON r.to_entity_id = e2.id
         WHERE e1.name LIKE ? OR e2.name LIKE ?`
      ).get(`%${word}%`, `%${word}%`) as { c: number };
      totalRelations += count.c;
    }

    return Math.min(1.0, totalRelations / 10); // Normalize: 10+ relations = max score
  } catch {
    return 0.1;
  }
}

/**
 * Calculate frequency score (0-1).
 * How often has this memory been accessed?
 */
function frequencyScore(accessCount: number): number {
  // Logarithmic scaling: 1 access = 0.3, 5 = 0.7, 10+ = 1.0
  if (accessCount <= 0) return 0.1;
  return Math.min(1.0, 0.3 + Math.log10(accessCount) * 0.35);
}

/**
 * Calculate recency score (0-1).
 * Exponential decay based on days since last access.
 */
function recencyScore(lastAccessedAt: number): number {
  if (lastAccessedAt <= 0) return 0.2;
  const daysSinceAccess = (Date.now() / 1000 - lastAccessedAt) / 86400;
  // Decay: score halves every 7 days
  return Math.max(0.05, Math.exp(-0.099 * daysSinceAccess)); // -ln(2)/7 ≈ -0.099
}

/**
 * Calculate entropy/uniqueness score (0-1).
 * Longer, more diverse content is more valuable.
 */
function entropyScore(content: string): number {
  if (!content || content.length < 10) return 0.1;

  const words = content.toLowerCase().split(/\s+/);
  const uniqueWords = new Set(words);
  const diversityRatio = uniqueWords.size / Math.max(words.length, 1);
  const lengthScore = Math.min(1.0, content.length / 500); // 500+ chars = max

  return (diversityRatio * 0.5 + lengthScore * 0.5);
}

/**
 * Calculate the combined Mnemosyne score for a memory item.
 */
export function calculateScore(
  content: string,
  accessCount: number,
  lastAccessedAt: number,
  db?: any,
): number {
  const w1 = 0.2;  // connectivity
  const w2 = 0.3;  // frequency
  const w3 = 0.3;  // recency
  const w4 = 0.2;  // entropy

  const conn = db ? connectivityScore(content, db) : 0.3;
  const freq = frequencyScore(accessCount);
  const rec = recencyScore(lastAccessedAt);
  const ent = entropyScore(content);

  return w1 * conn + w2 * freq + w3 * rec + w4 * ent;
}

// ── Memory Access Tracking ──

/**
 * Record that a memory was accessed (increment counter, update timestamp).
 */
export function touchMemory(table: "memory_items" | "episodic_events", id: number): void {
  try {
    const db = getDb();
    db.prepare(
      `UPDATE ${table} SET access_count = COALESCE(access_count, 0) + 1, last_accessed_at = unixepoch() WHERE id = ?`
    ).run(id);
  } catch { /* ignore — column might not exist yet */ }
}

// ── Nightly Decay Job ──

/**
 * Run the nightly Mnemosyne decay cycle.
 * Recalculates scores for all memories and archives low-scoring ones.
 * Returns stats about the operation.
 */
export function runMnemosyneDecay(): {
  memoriesScored: number;
  memoriesArchived: number;
  episodicScored: number;
  episodicPruned: number;
} {
  ensureMnemosyneColumns();
  const db = getDb();
  const ARCHIVE_THRESHOLD = 0.15;
  const PRUNE_EPISODIC_THRESHOLD = 0.10;

  let memoriesScored = 0;
  let memoriesArchived = 0;
  let episodicScored = 0;
  let episodicPruned = 0;

  // Score memory_items
  try {
    const memories = db.prepare(
      "SELECT id, content, access_count, last_accessed_at FROM memory_items WHERE archived = 0 OR archived IS NULL"
    ).all() as Array<{ id: number; content: string; access_count: number; last_accessed_at: number }>;

    const updateStmt = db.prepare(
      "UPDATE memory_items SET mnemosyne_score = ?, archived = ? WHERE id = ?"
    );

    for (const m of memories) {
      const score = calculateScore(m.content, m.access_count || 0, m.last_accessed_at || 0, db);
      const shouldArchive = score < ARCHIVE_THRESHOLD ? 1 : 0;
      updateStmt.run(score, shouldArchive, m.id);
      memoriesScored++;
      if (shouldArchive) memoriesArchived++;
    }
  } catch (err) {
    log.warn(`[mnemosyne] Error scoring memories: ${err}`);
  }

  // Score episodic_events
  try {
    const events = db.prepare(
      "SELECT id, summary, details, access_count, last_accessed_at FROM episodic_events"
    ).all() as Array<{ id: number; summary: string; details: string; access_count: number; last_accessed_at: number }>;

    const updateStmt = db.prepare(
      "UPDATE episodic_events SET mnemosyne_score = ? WHERE id = ?"
    );

    for (const e of events) {
      const content = `${e.summary} ${e.details || ""}`;
      const score = calculateScore(content, e.access_count || 0, e.last_accessed_at || 0, db);
      updateStmt.run(score, e.id);
      episodicScored++;
    }

    // Prune very old, low-scoring episodic events (keep at least 100)
    const totalEvents = (db.prepare("SELECT COUNT(*) as c FROM episodic_events").get() as { c: number }).c;
    if (totalEvents > 100) {
      const pruned = db.prepare(
        `DELETE FROM episodic_events WHERE mnemosyne_score < ? AND id NOT IN (
          SELECT id FROM episodic_events ORDER BY created_at DESC LIMIT 100
        )`
      ).run(PRUNE_EPISODIC_THRESHOLD);
      episodicPruned = pruned.changes;
    }
  } catch (err) {
    log.warn(`[mnemosyne] Error scoring episodic events: ${err}`);
  }

  log.info(`[mnemosyne] Decay cycle: ${memoriesScored} memories scored, ${memoriesArchived} archived, ${episodicScored} events scored, ${episodicPruned} pruned`);

  return { memoriesScored, memoriesArchived, episodicScored, episodicPruned };
}

// ── Consolidation ──

/**
 * Get memories from the last 24 hours for consolidation review.
 */
export function getRecentMemories(hoursBack = 24): Array<{ id: number; content: string; created_at: number }> {
  try {
    const db = getDb();
    const since = Math.floor(Date.now() / 1000) - hoursBack * 3600;
    return db.prepare(
      "SELECT id, content, created_at FROM memory_items WHERE created_at > ? AND (archived = 0 OR archived IS NULL) ORDER BY created_at"
    ).all(since) as Array<{ id: number; content: string; created_at: number }>;
  } catch {
    return [];
  }
}

/**
 * Find potential duplicate memories (Jaccard similarity on word sets).
 */
export function findDuplicates(memories: Array<{ id: number; content: string }>, threshold = 0.6): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];

  const wordSets = memories.map(m => {
    const words = m.content.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    return new Set(words);
  });

  for (let i = 0; i < memories.length; i++) {
    for (let j = i + 1; j < memories.length; j++) {
      const setA = wordSets[i];
      const setB = wordSets[j];
      const intersection = new Set([...setA].filter(w => setB.has(w)));
      const union = new Set([...setA, ...setB]);
      const jaccard = union.size > 0 ? intersection.size / union.size : 0;

      if (jaccard >= threshold) {
        pairs.push([memories[i].id, memories[j].id]);
      }
    }
  }

  return pairs;
}
