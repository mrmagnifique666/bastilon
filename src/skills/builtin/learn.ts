/**
 * Built-in skills: learn.pattern, learn.preferences, learn.forget
 * Learning system — tracks user preferences and interaction patterns.
 */
import { registerSkill } from "../loader.js";
import { getDb } from "../../storage/store.js";
import { log } from "../../utils/log.js";

function ensureTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS learned_patterns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      pattern TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.5,
      sample_count INTEGER NOT NULL DEFAULT 1,
      last_updated INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_learn_cat ON learned_patterns(category);
  `);
}

registerSkill({
  name: "learn.pattern",
  description: "Record a learned user preference pattern. Call this when you notice Nicolas's preferences.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      category: { type: "string", description: "Category: communication, timing, content, format, topics" },
      pattern: { type: "string", description: "The pattern observed (e.g. 'prefers concise messages', 'ignores morning alerts')" },
      confidence: { type: "number", description: "Confidence 0.0-1.0 (default 0.5)" },
    },
    required: ["category", "pattern"],
  },
  async execute(args): Promise<string> {
    ensureTable();
    const db = getDb();
    const category = String(args.category);
    const pattern = String(args.pattern);
    const confidence = Math.max(0, Math.min(1, Number(args.confidence) || 0.5));

    // Check if pattern already exists
    const existing = db.prepare(
      "SELECT * FROM learned_patterns WHERE category = ? AND pattern = ? AND active = 1"
    ).get(category, pattern) as any;

    if (existing) {
      // Reinforce existing pattern
      const newConfidence = Math.min(1, existing.confidence + 0.1);
      const newCount = existing.sample_count + 1;
      db.prepare(
        "UPDATE learned_patterns SET confidence = ?, sample_count = ?, last_updated = ? WHERE id = ?"
      ).run(newConfidence, newCount, Math.floor(Date.now() / 1000), existing.id);
      return `Pattern reinforced: "${pattern}" (confidence: ${(newConfidence * 100).toFixed(0)}%, ${newCount} samples)`;
    }

    db.prepare(
      "INSERT INTO learned_patterns (category, pattern, confidence, last_updated) VALUES (?, ?, ?, ?)"
    ).run(category, pattern, confidence, Math.floor(Date.now() / 1000));
    return `New pattern learned: [${category}] "${pattern}" (confidence: ${(confidence * 100).toFixed(0)}%)`;
  },
});

registerSkill({
  name: "learn.preferences",
  description: "Get all learned user preferences, grouped by category.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      category: { type: "string", description: "Filter by category (optional)" },
    },
  },
  async execute(args): Promise<string> {
    ensureTable();
    const db = getDb();

    let query = "SELECT * FROM learned_patterns WHERE active = 1";
    const params: string[] = [];
    if (args.category) {
      query += " AND category = ?";
      params.push(String(args.category));
    }
    query += " ORDER BY category, confidence DESC";

    const patterns = db.prepare(query).all(...params) as any[];
    if (!patterns.length) return "No learned patterns yet. I'll learn as I interact with Nicolas.";

    // Group by category
    const groups: Record<string, any[]> = {};
    for (const p of patterns) {
      (groups[p.category] = groups[p.category] || []).push(p);
    }

    const lines = ["**Learned Preferences:**", ""];
    for (const [cat, items] of Object.entries(groups)) {
      lines.push(`**${cat.toUpperCase()}:**`);
      for (const item of items) {
        const bar = item.confidence >= 0.8 ? "🟢" : item.confidence >= 0.5 ? "🟡" : "⚪";
        const age = Math.floor((Date.now() / 1000 - item.last_updated) / 86400);
        lines.push(`  ${bar} ${item.pattern} (${(item.confidence * 100).toFixed(0)}%, ${item.sample_count} samples, ${age}d ago)`);
      }
      lines.push("");
    }

    return lines.join("\n");
  },
});

registerSkill({
  name: "learn.forget",
  description: "Unlearn an incorrect pattern.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      patternId: { type: "number", description: "Pattern ID to forget (get from learn.preferences)" },
    },
    required: ["patternId"],
  },
  async execute(args): Promise<string> {
    ensureTable();
    const db = getDb();
    const id = Number(args.patternId);

    const pattern = db.prepare("SELECT * FROM learned_patterns WHERE id = ?").get(id) as any;
    if (!pattern) return `Pattern #${id} not found.`;

    db.prepare("UPDATE learned_patterns SET active = 0 WHERE id = ?").run(id);
    return `Forgot pattern #${id}: "${pattern.pattern}" (category: ${pattern.category})`;
  },
});

log.debug("Registered 3 learn.* skills");
