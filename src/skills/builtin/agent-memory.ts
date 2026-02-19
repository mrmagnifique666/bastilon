/**
 * Agent Working Memory — per-agent learnings that persist across cycles.
 * Skills: learn.save, learn.recall, learn.confirm, learn.forget
 *
 * Unlike notes.* (global notepad), these learnings are scoped per agent
 * with confidence scoring and auto-consolidation.
 */
import { registerSkill } from "../loader.js";
import { getDb } from "../../storage/store.js";
import { log } from "../../utils/log.js";

// ── Table setup ──────────────────────────────────────────────────────

function ensureTables(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      cycle INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_agent_memory_agent
      ON agent_memory(agent_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS agent_learnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      category TEXT NOT NULL,
      learning TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.5,
      times_used INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_agent_learnings_agent
      ON agent_learnings(agent_id, category);
  `);
}

// Ensure tables on module load
try {
  ensureTables();
} catch { /* tables will be created on first use */ }

// ── Valid categories ─────────────────────────────────────────────────

const VALID_CATEGORIES = ["strategy", "error_pattern", "optimization", "observation"];

// ── Auto-consolidation ──────────────────────────────────────────────

/**
 * Consolidate learnings for an agent when count exceeds threshold.
 * 1. Delete low-confidence (< 0.3) old (> 7 days) learnings
 * 2. Merge same-category learnings with similar text (substring match)
 */
function consolidateAgentLearnings(agentId: string): void {
  try {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    const sevenDaysAgo = now - 7 * 86400;

    // Count total learnings for this agent
    const countRow = db.prepare(
      "SELECT COUNT(*) as cnt FROM agent_learnings WHERE agent_id = ?"
    ).get(agentId) as { cnt: number };

    if (countRow.cnt <= 20) return;

    log.info(`[agent-memory] Consolidation lancée pour ${agentId} (${countRow.cnt} apprentissages)`);

    // Step 1: Delete low-confidence + old learnings
    const deleted = db.prepare(
      "DELETE FROM agent_learnings WHERE agent_id = ? AND confidence < 0.3 AND created_at < ?"
    ).run(agentId, sevenDaysAgo);

    if (deleted.changes > 0) {
      log.info(`[agent-memory] ${deleted.changes} apprentissages obsolètes supprimés pour ${agentId}`);
    }

    // Step 2: Merge same-category duplicates (simple substring matching)
    const categories = db.prepare(
      "SELECT DISTINCT category FROM agent_learnings WHERE agent_id = ?"
    ).all(agentId) as { category: string }[];

    for (const { category } of categories) {
      const learnings = db.prepare(
        "SELECT id, learning, confidence, times_used FROM agent_learnings WHERE agent_id = ? AND category = ? ORDER BY confidence DESC"
      ).all(agentId, category) as {
        id: number;
        learning: string;
        confidence: number;
        times_used: number;
      }[];

      const toDelete: number[] = [];

      for (let i = 0; i < learnings.length; i++) {
        if (toDelete.includes(learnings[i].id)) continue;

        for (let j = i + 1; j < learnings.length; j++) {
          if (toDelete.includes(learnings[j].id)) continue;

          const a = learnings[i].learning.toLowerCase();
          const b = learnings[j].learning.toLowerCase();

          // Simple similarity: one is a substring of the other, or they share > 60% words
          const isSubstring = a.includes(b) || b.includes(a);
          const wordsA = new Set(a.split(/\s+/));
          const wordsB = new Set(b.split(/\s+/));
          const intersection = [...wordsA].filter((w) => wordsB.has(w)).length;
          const union = new Set([...wordsA, ...wordsB]).size;
          const overlap = union > 0 ? intersection / union : 0;

          if (isSubstring || overlap > 0.6) {
            // Keep the higher-confidence one, merge stats
            const keeper = learnings[i];
            const merged = learnings[j];
            const newConfidence = Math.min(1.0, Math.max(keeper.confidence, merged.confidence) + 0.05);
            const newTimesUsed = keeper.times_used + merged.times_used;

            db.prepare(
              "UPDATE agent_learnings SET confidence = ?, times_used = ?, updated_at = ? WHERE id = ?"
            ).run(newConfidence, newTimesUsed, now, keeper.id);

            toDelete.push(merged.id);
          }
        }
      }

      if (toDelete.length > 0) {
        const placeholders = toDelete.map(() => "?").join(",");
        db.prepare(
          `DELETE FROM agent_learnings WHERE id IN (${placeholders})`
        ).run(...toDelete);
        log.info(`[agent-memory] ${toDelete.length} apprentissages fusionnés dans ${category} pour ${agentId}`);
      }
    }
  } catch (err) {
    log.warn(`[agent-memory] Erreur de consolidation pour ${agentId}: ${err}`);
  }
}

// ── Skill 1: learn.save ─────────────────────────────────────────────

registerSkill({
  name: "learn.save",
  description:
    "Save a learning or insight that should persist across cycles. Use when you discover a pattern, learn from a mistake, or find something that works well. Categories: strategy, error_pattern, optimization, observation.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      learning: { type: "string", description: "What you learned (be specific and actionable)" },
      category: { type: "string", description: "Category: strategy | error_pattern | optimization | observation" },
      agent_id: { type: "string", description: "Which agent is learning (default: system)" },
    },
    required: ["learning", "category"],
  },
  async execute(args): Promise<string> {
    ensureTables();
    const db = getDb();
    const learning = String(args.learning).trim();
    const category = String(args.category).trim().toLowerCase();
    const agentId = String(args.agent_id || "system").trim();

    if (!learning) {
      return "Erreur : le champ 'learning' ne peut pas être vide.";
    }

    if (!VALID_CATEGORIES.includes(category)) {
      return `Erreur : catégorie invalide "${category}". Catégories valides : ${VALID_CATEGORIES.join(", ")}`;
    }

    const now = Math.floor(Date.now() / 1000);

    const info = db.prepare(
      "INSERT INTO agent_learnings (agent_id, category, learning, confidence, times_used, created_at, updated_at) VALUES (?, ?, ?, 0.5, 0, ?, ?)"
    ).run(agentId, category, learning, now, now);

    // Auto-consolidate if too many learnings
    consolidateAgentLearnings(agentId);

    return `Apprentissage #${info.lastInsertRowid} sauvegardé [${category}] pour ${agentId} : "${learning.slice(0, 80)}${learning.length > 80 ? "..." : ""}"`;
  },
});

// ── Skill 2: learn.recall ───────────────────────────────────────────

registerSkill({
  name: "learn.recall",
  description:
    "Recall previous learnings for an agent or category. Use at the start of a cycle to remember what you've learned before.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      agent_id: { type: "string", description: "Which agent's learnings to recall" },
      category: { type: "string", description: "Filter by category (optional)" },
      limit: { type: "number", description: "Max learnings to return (default 10)" },
    },
    required: [],
  },
  async execute(args): Promise<string> {
    ensureTables();
    const db = getDb();
    const agentId = args.agent_id ? String(args.agent_id).trim() : null;
    const category = args.category ? String(args.category).trim().toLowerCase() : null;
    const limit = Math.max(1, Math.min(50, Number(args.limit) || 10));

    let query = "SELECT id, agent_id, category, learning, confidence, times_used, created_at FROM agent_learnings WHERE 1=1";
    const params: (string | number)[] = [];

    if (agentId) {
      query += " AND agent_id = ?";
      params.push(agentId);
    }
    if (category) {
      if (!VALID_CATEGORIES.includes(category)) {
        return `Erreur : catégorie invalide "${category}". Catégories valides : ${VALID_CATEGORIES.join(", ")}`;
      }
      query += " AND category = ?";
      params.push(category);
    }

    query += " ORDER BY confidence DESC, times_used DESC LIMIT ?";
    params.push(limit);

    const rows = db.prepare(query).all(...params) as {
      id: number;
      agent_id: string;
      category: string;
      learning: string;
      confidence: number;
      times_used: number;
      created_at: number;
    }[];

    if (rows.length === 0) {
      const scope = agentId ? `pour ${agentId}` : "global";
      const catInfo = category ? ` (catégorie: ${category})` : "";
      return `Aucun apprentissage trouvé ${scope}${catInfo}.`;
    }

    const now = Math.floor(Date.now() / 1000);
    const lines = rows.map((r, i) => {
      const age = Math.floor((now - r.created_at) / 86400);
      const conf = (r.confidence * 100).toFixed(0);
      return `${i + 1}. [#${r.id}] [${r.category}] ${r.learning}\n   Confiance: ${conf}% | Utilisé: ${r.times_used}x | Agent: ${r.agent_id} | ${age}j`;
    });

    const header = agentId
      ? `Apprentissages de ${agentId}${category ? ` (${category})` : ""} :`
      : `Tous les apprentissages${category ? ` (${category})` : ""} :`;

    return `${header}\n\n${lines.join("\n\n")}`;
  },
});

// ── Skill 3: learn.confirm ──────────────────────────────────────────

registerSkill({
  name: "learn.confirm",
  description:
    "Confirm a previous learning was useful — increases its confidence score. Call this when you successfully apply a learning.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      learning_id: { type: "number", description: "ID of the learning to confirm" },
    },
    required: ["learning_id"],
  },
  async execute(args): Promise<string> {
    ensureTables();
    const db = getDb();
    const id = Number(args.learning_id);

    if (!id || id < 1) {
      return "Erreur : learning_id invalide.";
    }

    const row = db.prepare(
      "SELECT id, learning, confidence, times_used FROM agent_learnings WHERE id = ?"
    ).get(id) as { id: number; learning: string; confidence: number; times_used: number } | undefined;

    if (!row) {
      return `Erreur : apprentissage #${id} introuvable.`;
    }

    const newConfidence = Math.min(1.0, row.confidence + 0.1);
    const newTimesUsed = row.times_used + 1;
    const now = Math.floor(Date.now() / 1000);

    db.prepare(
      "UPDATE agent_learnings SET confidence = ?, times_used = ?, updated_at = ? WHERE id = ?"
    ).run(newConfidence, newTimesUsed, now, id);

    return `Apprentissage #${id} confirmé. Confiance : ${(row.confidence * 100).toFixed(0)}% -> ${(newConfidence * 100).toFixed(0)}% (utilisé ${newTimesUsed}x)`;
  },
});

// ── Skill 4: learn.forget ───────────────────────────────────────────

registerSkill({
  name: "learn.forget",
  description:
    "Remove a learning that turned out to be wrong or is no longer relevant.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      learning_id: { type: "number", description: "ID of the learning to remove" },
    },
    required: ["learning_id"],
  },
  async execute(args): Promise<string> {
    ensureTables();
    const db = getDb();
    const id = Number(args.learning_id);

    if (!id || id < 1) {
      return "Erreur : learning_id invalide.";
    }

    const row = db.prepare(
      "SELECT id, learning, category, agent_id FROM agent_learnings WHERE id = ?"
    ).get(id) as { id: number; learning: string; category: string; agent_id: string } | undefined;

    if (!row) {
      return `Erreur : apprentissage #${id} introuvable.`;
    }

    db.prepare("DELETE FROM agent_learnings WHERE id = ?").run(id);

    return `Apprentissage #${id} supprimé : [${row.category}] "${row.learning.slice(0, 60)}${row.learning.length > 60 ? "..." : ""}" (agent: ${row.agent_id})`;
  },
});

log.debug("Registered 4 learn.* agent memory skills (save/recall/confirm/forget)");
