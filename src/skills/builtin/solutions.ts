/**
 * Solutions Memory — cache successful problem resolutions.
 * When Kingston solves a problem, store the solution.
 * On similar future problems, recall what worked.
 * Uses existing semantic memory (type=knowledge, tagged as solution).
 *
 * Skills: solutions.save, solutions.recall, solutions.list
 */
import { registerSkill } from "../loader.js";
import { addMemory, searchMemories } from "../../memory/semantic.js";
import { getDb } from "../../storage/store.js";
import { log } from "../../utils/log.js";

registerSkill({
  name: "solutions.save",
  description:
    "Cache a successful problem resolution. Stores the problem description and solution for future recall.",
  argsSchema: {
    type: "object",
    properties: {
      problem: { type: "string", description: "Brief description of the problem" },
      solution: { type: "string", description: "What solved it (steps, commands, approach)" },
      tags: { type: "string", description: "Comma-separated tags (e.g. 'npm,windows,build')" },
    },
    required: ["problem", "solution"],
  },
  adminOnly: true,
  async execute(args): Promise<string> {
    const problem = String(args.problem);
    const solution = String(args.solution);
    const tags = args.tags ? String(args.tags) : "";

    const content = `[SOLUTION] Problem: ${problem}\nSolution: ${solution}${tags ? `\nTags: ${tags}` : ""}`;

    try {
      const id = await addMemory(content, "knowledge", { source: "solutions.save", tags });
      if (id) {
        return `Solution #${id} enregistrée:\n  Problème: ${problem}\n  Solution: ${solution.slice(0, 100)}...`;
      }
      return "Solution already exists (near-duplicate detected).";
    } catch (err) {
      return `Erreur: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

registerSkill({
  name: "solutions.recall",
  description:
    "Search for previously cached solutions by problem description. Returns the most relevant past solutions.",
  argsSchema: {
    type: "object",
    properties: {
      problem: { type: "string", description: "Describe the problem you're facing" },
      limit: { type: "number", description: "Max results (default 3)" },
    },
    required: ["problem"],
  },
  async execute(args): Promise<string> {
    const problem = String(args.problem);
    const limit = Number(args.limit) || 3;

    try {
      // Search semantic memory for solutions
      const results = await searchMemories(`[SOLUTION] ${problem}`, "knowledge", limit + 2);

      // Filter to only solution-tagged entries
      const solutions = results.filter((r) => r.content.startsWith("[SOLUTION]"));

      if (solutions.length === 0) {
        return `Aucune solution trouvée pour: "${problem}". Essaie avec d'autres termes.`;
      }

      return solutions
        .slice(0, limit)
        .map((s, i) => {
          const score = (s.score * 100).toFixed(0);
          return `${i + 1}. (${score}% match) ${s.content.replace("[SOLUTION] ", "")}`;
        })
        .join("\n\n");
    } catch (err) {
      return `Erreur: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

registerSkill({
  name: "solutions.list",
  description: "List all cached solutions, optionally filtered by tag.",
  argsSchema: {
    type: "object",
    properties: {
      tag: { type: "string", description: "Filter by tag (optional)" },
      limit: { type: "number", description: "Max results (default 10)" },
    },
  },
  async execute(args): Promise<string> {
    const tag = args.tag ? String(args.tag).toLowerCase() : "";
    const limit = Number(args.limit) || 10;

    try {
      const db = getDb();
      let rows: Array<{ id: number; content: string; created_at: number }>;

      if (tag) {
        rows = db
          .prepare(
            `SELECT id, content, created_at FROM memory_items
             WHERE category = 'knowledge' AND content LIKE '[SOLUTION]%' AND LOWER(content) LIKE ?
             ORDER BY created_at DESC LIMIT ?`,
          )
          .all(`%${tag}%`, limit) as typeof rows;
      } else {
        rows = db
          .prepare(
            `SELECT id, content, created_at FROM memory_items
             WHERE category = 'knowledge' AND content LIKE '[SOLUTION]%'
             ORDER BY created_at DESC LIMIT ?`,
          )
          .all(limit) as typeof rows;
      }

      if (rows.length === 0) return "Aucune solution en cache.";

      return rows
        .map((r, i) => {
          const date = new Date(r.created_at * 1000).toISOString().split("T")[0];
          const brief = r.content.replace("[SOLUTION] ", "").slice(0, 120);
          return `${i + 1}. (#${r.id}, ${date}) ${brief}`;
        })
        .join("\n");
    } catch (err) {
      return `Erreur: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});
