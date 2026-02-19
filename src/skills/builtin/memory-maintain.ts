/**
 * Built-in skill: memory.maintain
 * Kingston's memory hygiene system — consolidation, decay, dedup, and review.
 *
 * Scheduled by crons to run at strategic times:
 * - 5h ET (nightly): Full consolidation + decay + cleanup
 * - 12h ET (noon): Quick dedup scan + stats report
 * - 22h ET (evening): Day review + important memory promotion
 */
import { registerSkill } from "../loader.js";
import { getDb } from "../../storage/store.js";
import { log } from "../../utils/log.js";
import {
  searchMemories,
  getMemoryStats,
  runMemoryCleanup,
  consolidateMemories,
  type MemoryCategory,
} from "../../memory/semantic.js";

// ── Helpers ──

function getMemoryCount(): number {
  try {
    const db = getDb();
    const row = db.prepare("SELECT COUNT(*) as cnt FROM semantic_memories").get() as { cnt: number };
    return row.cnt;
  } catch {
    return 0;
  }
}

function getStaleMemories(daysSinceAccess: number, limit = 20): Array<{ id: number; content: string; category: string; last_accessed_at: number }> {
  try {
    const db = getDb();
    const cutoff = Math.floor(Date.now() / 1000) - daysSinceAccess * 86400;
    return db.prepare(
      `SELECT id, content, category, last_accessed_at FROM semantic_memories
       WHERE last_accessed_at < ? AND salience < 0.3
       ORDER BY last_accessed_at ASC LIMIT ?`
    ).all(cutoff, limit) as any[];
  } catch {
    return [];
  }
}

function getDuplicateCandidates(limit = 20): Array<{ id: number; content: string; content_hash: string }> {
  try {
    const db = getDb();
    return db.prepare(
      `SELECT a.id, a.content, a.content_hash FROM semantic_memories a
       INNER JOIN semantic_memories b ON a.content_hash = b.content_hash AND a.id > b.id
       LIMIT ?`
    ).all(limit) as any[];
  } catch {
    return [];
  }
}

function getMemoriesByCategory(): Record<string, number> {
  try {
    const db = getDb();
    const rows = db.prepare(
      "SELECT category, COUNT(*) as cnt FROM semantic_memories GROUP BY category"
    ).all() as Array<{ category: string; cnt: number }>;
    const result: Record<string, number> = {};
    for (const r of rows) result[r.category] = r.cnt;
    return result;
  } catch {
    return {};
  }
}

function getRecentMemories(hours: number, limit = 10): Array<{ id: number; content: string; category: string; created_at: number }> {
  try {
    const db = getDb();
    const cutoff = Math.floor(Date.now() / 1000) - hours * 3600;
    return db.prepare(
      `SELECT id, content, category, created_at FROM semantic_memories
       WHERE created_at > ? ORDER BY created_at DESC LIMIT ?`
    ).all(cutoff, limit) as any[];
  } catch {
    return [];
  }
}

function getMostAccessedMemories(limit = 10): Array<{ id: number; content: string; category: string; access_count: number }> {
  try {
    const db = getDb();
    return db.prepare(
      `SELECT id, content, category, access_count FROM semantic_memories
       ORDER BY access_count DESC LIMIT ?`
    ).all(limit) as any[];
  } catch {
    return [];
  }
}

function getNotesCount(): number {
  try {
    const db = getDb();
    const row = db.prepare("SELECT COUNT(*) as cnt FROM notes").get() as { cnt: number };
    return row.cnt;
  } catch {
    return 0;
  }
}

function getEpisodicCount(): number {
  try {
    const db = getDb();
    const row = db.prepare("SELECT COUNT(*) as cnt FROM episodic_events").get() as { cnt: number };
    return row.cnt;
  } catch {
    return 0;
  }
}

// ── Skills ──

registerSkill({
  name: "memory.maintain",
  description:
    "Run full memory maintenance: consolidation, dedup, decay cleanup, and stats report. " +
    "Use mode='full' for nightly deep maintenance, 'quick' for mid-day check, 'review' for day-end review.",
  argsSchema: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        description: "Maintenance mode: 'full' (nightly — consolidate + cleanup + decay), 'quick' (dedup + stats), 'review' (day summary + promote important memories)",
      },
    },
    required: ["mode"],
  },
  async execute(args): Promise<string> {
    const mode = (args.mode as string).toLowerCase().trim();
    const sections: string[] = [];
    const startTime = Date.now();

    sections.push(`## Memory Maintenance Report (mode: ${mode})\n`);

    // ── Stats baseline ──
    const totalBefore = getMemoryCount();
    const byCategory = getMemoriesByCategory();
    const notesCount = getNotesCount();
    const episodicCount = getEpisodicCount();

    sections.push(`### Baseline Stats:`);
    sections.push(`- Semantic memories: ${totalBefore}`);
    sections.push(`- By category: ${Object.entries(byCategory).map(([k, v]) => `${k}=${v}`).join(", ")}`);
    sections.push(`- Notes (SQLite): ${notesCount}`);
    sections.push(`- Episodic events: ${episodicCount}`);

    if (mode === "full" || mode === "nightly") {
      // ── FULL MAINTENANCE (nightly at 5h ET) ──

      // 1. Consolidation — merge near-duplicates via Gemini Flash
      sections.push(`\n### 1. Consolidation:`);
      try {
        const consolResult = await consolidateMemories("knowledge");
        sections.push(`- Knowledge: ${consolResult}`);
      } catch (err) {
        sections.push(`- Knowledge consolidation error: ${err}`);
      }
      try {
        const consolResult2 = await consolidateMemories("event");
        sections.push(`- Events: ${consolResult2}`);
      } catch (err) {
        sections.push(`- Event consolidation error: ${err}`);
      }

      // 2. Cleanup — remove trivial entries
      sections.push(`\n### 2. Cleanup:`);
      try {
        const cleanResult = await runMemoryCleanup();
        sections.push(`- ${cleanResult}`);
      } catch (err) {
        sections.push(`- Cleanup error: ${err}`);
      }

      // 3. Exact duplicates removal
      sections.push(`\n### 3. Deduplication:`);
      const dupes = getDuplicateCandidates(50);
      if (dupes.length > 0) {
        const db = getDb();
        const delStmt = db.prepare("DELETE FROM semantic_memories WHERE id = ?");
        let deleted = 0;
        for (const d of dupes) {
          try {
            delStmt.run(d.id);
            deleted++;
          } catch { /* skip if fails */ }
        }
        sections.push(`- Removed ${deleted} exact duplicates`);
      } else {
        sections.push(`- No exact duplicates found`);
      }

      // 4. Stale memory report (don't delete, just flag)
      sections.push(`\n### 4. Stale Memories (>30 days no access, low salience):`);
      const stale = getStaleMemories(30, 10);
      if (stale.length > 0) {
        for (const s of stale) {
          sections.push(`- #${s.id} [${s.category}]: ${s.content.slice(0, 80)}...`);
        }
        sections.push(`(${stale.length} stale memories flagged — review for archival)`);
      } else {
        sections.push(`- No stale memories found`);
      }

    } else if (mode === "quick" || mode === "midday") {
      // ── QUICK CHECK (noon) ──

      // 1. Dedup scan
      sections.push(`\n### 1. Quick Dedup Scan:`);
      const dupes = getDuplicateCandidates(20);
      if (dupes.length > 0) {
        const db = getDb();
        const delStmt = db.prepare("DELETE FROM semantic_memories WHERE id = ?");
        let deleted = 0;
        for (const d of dupes) {
          try {
            delStmt.run(d.id);
            deleted++;
          } catch { /* skip */ }
        }
        sections.push(`- Removed ${deleted} exact duplicates`);
      } else {
        sections.push(`- No duplicates found`);
      }

      // 2. Recent memories (last 6h)
      sections.push(`\n### 2. New Memories (last 6h):`);
      const recent = getRecentMemories(6, 10);
      if (recent.length > 0) {
        for (const r of recent) {
          sections.push(`- #${r.id} [${r.category}]: ${r.content.slice(0, 100)}`);
        }
      } else {
        sections.push(`- No new memories in the last 6h`);
      }

    } else if (mode === "review" || mode === "evening") {
      // ── DAY REVIEW (evening) ──

      // 1. Today's new memories
      sections.push(`\n### 1. Today's New Memories:`);
      const todayMemories = getRecentMemories(16, 20);
      sections.push(`- ${todayMemories.length} memories created today`);
      if (todayMemories.length > 0) {
        const catCount: Record<string, number> = {};
        for (const m of todayMemories) {
          catCount[m.category] = (catCount[m.category] || 0) + 1;
        }
        sections.push(`- Breakdown: ${Object.entries(catCount).map(([k, v]) => `${k}=${v}`).join(", ")}`);
      }

      // 2. Most accessed memories (promotion candidates)
      sections.push(`\n### 2. Most Accessed Memories (core knowledge):`);
      const topAccessed = getMostAccessedMemories(5);
      for (const m of topAccessed) {
        sections.push(`- #${m.id} [${m.category}] (${m.access_count} accesses): ${m.content.slice(0, 80)}`);
      }

      // 3. Quick cleanup
      sections.push(`\n### 3. Quick Cleanup:`);
      try {
        const cleanResult = await runMemoryCleanup();
        sections.push(`- ${cleanResult}`);
      } catch (err) {
        sections.push(`- Cleanup error: ${err}`);
      }
    } else {
      return `Unknown maintenance mode: "${mode}". Use 'full', 'quick', or 'review'.`;
    }

    // ── Final stats ──
    const totalAfter = getMemoryCount();
    const elapsed = Date.now() - startTime;
    sections.push(`\n### Summary:`);
    sections.push(`- Before: ${totalBefore} memories → After: ${totalAfter} memories`);
    sections.push(`- Delta: ${totalAfter - totalBefore} (${totalAfter > totalBefore ? "gained" : totalAfter < totalBefore ? "cleaned" : "stable"})`);
    sections.push(`- Duration: ${elapsed}ms`);

    const report = sections.join("\n");
    log.info(`[memory.maintain] ${mode} maintenance complete: ${totalBefore}→${totalAfter} memories in ${elapsed}ms`);
    return report;
  },
});

registerSkill({
  name: "memory.health",
  description:
    "Quick memory health check — shows stats, recent memories, stale count, duplicate count. " +
    "Use this for a fast overview of memory state without running maintenance.",
  argsSchema: {
    type: "object",
    properties: {},
  },
  async execute(): Promise<string> {
    const total = getMemoryCount();
    const byCategory = getMemoriesByCategory();
    const notes = getNotesCount();
    const episodic = getEpisodicCount();
    const recent = getRecentMemories(24, 5);
    const stale = getStaleMemories(30, 5);
    const dupes = getDuplicateCandidates(5);
    const topAccessed = getMostAccessedMemories(3);

    const sections: string[] = [];
    sections.push(`## Memory Health Report\n`);
    sections.push(`**Semantic memories:** ${total}`);
    sections.push(`**Categories:** ${Object.entries(byCategory).map(([k, v]) => `${k}=${v}`).join(", ")}`);
    sections.push(`**Notes:** ${notes}`);
    sections.push(`**Episodic events:** ${episodic}`);

    sections.push(`\n**Recent (24h):** ${recent.length} new memories`);
    if (recent.length > 0) {
      for (const r of recent) {
        sections.push(`  - #${r.id} [${r.category}]: ${r.content.slice(0, 60)}`);
      }
    }

    sections.push(`\n**Stale (>30d, low salience):** ${stale.length} found`);
    sections.push(`**Exact duplicates:** ${dupes.length} found`);

    if (topAccessed.length > 0) {
      sections.push(`\n**Most accessed:**`);
      for (const m of topAccessed) {
        sections.push(`  - #${m.id} (${m.access_count}x): ${m.content.slice(0, 60)}`);
      }
    }

    // Health score
    const dupeRatio = total > 0 ? dupes.length / total : 0;
    const staleRatio = total > 0 ? stale.length / total : 0;
    let healthScore = 100;
    if (dupeRatio > 0.05) healthScore -= 20;
    if (dupeRatio > 0.1) healthScore -= 20;
    if (staleRatio > 0.2) healthScore -= 15;
    if (staleRatio > 0.4) healthScore -= 15;
    if (total > 10000) healthScore -= 10; // memory bloat
    if (total < 50) healthScore -= 10; // too few memories
    healthScore = Math.max(0, Math.min(100, healthScore));

    const emoji = healthScore >= 80 ? "🟢" : healthScore >= 60 ? "🟡" : "🔴";
    sections.push(`\n**Health Score:** ${emoji} ${healthScore}/100`);

    return sections.join("\n");
  },
});

registerSkill({
  name: "memory.promote",
  description:
    "Manually promote a memory to higher salience (mark as important). " +
    "Use when a memory is frequently useful and should persist longer.",
  argsSchema: {
    type: "object",
    properties: {
      id: { type: "number", description: "Memory ID to promote" },
      salience: { type: "number", description: "New salience score (0.0-1.0, default 0.9)" },
    },
    required: ["id"],
  },
  async execute(args): Promise<string> {
    const id = args.id as number;
    const salience = Math.min(1.0, Math.max(0.0, (args.salience as number) || 0.9));

    try {
      const db = getDb();
      const row = db.prepare("SELECT content, category, salience FROM semantic_memories WHERE id = ?").get(id) as any;
      if (!row) return `Memory #${id} not found.`;

      db.prepare("UPDATE semantic_memories SET salience = ?, updated_at = ? WHERE id = ?")
        .run(salience, Math.floor(Date.now() / 1000), id);

      return `Memory #${id} promoted: salience ${row.salience.toFixed(2)} → ${salience.toFixed(2)} [${row.category}]: ${row.content.slice(0, 100)}`;
    } catch (err) {
      return `Error promoting memory: ${err}`;
    }
  },
});
