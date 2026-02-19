/**
 * Intelligence skills — Reflexion, CRAG, and Mnemosyne.
 * Exposes the intelligence modules as callable skills for Kingston.
 */
import { registerSkill } from "../loader.js";
import { logReflection, getRelevantReflections } from "../../intelligence/reflexion.js";
import { gradeRelevance, applyCRAG } from "../../intelligence/crag.js";
import { runMnemosyneDecay, ensureMnemosyneColumns, getRecentMemories, findDuplicates } from "../../intelligence/mnemosyne.js";
import { log } from "../../utils/log.js";

// ── reflect.log — Store a reflection/lesson learned ──

registerSkill({
  name: "reflect.log",
  description:
    "Log a reflection or lesson learned from a failed task/goal. " +
    "Stores in episodic memory for future reference. " +
    "Use after failures to help Kingston learn from mistakes.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      task: { type: "string", description: "What was attempted" },
      outcome: { type: "string", description: "What happened (failure description)" },
      error: { type: "string", description: "Error message if applicable" },
      strategy: { type: "string", description: "Strategy that was used" },
      goalId: { type: "string", description: "Related goal ID (optional)" },
      agentId: { type: "string", description: "Agent that failed (optional)" },
    },
    required: ["task", "outcome"],
  },
  async execute(args): Promise<string> {
    const id = logReflection({
      task: String(args.task),
      outcome: String(args.outcome),
      error: args.error ? String(args.error) : undefined,
      strategy: args.strategy ? String(args.strategy) : undefined,
      goalId: args.goalId ? Number(args.goalId) : undefined,
      agentId: args.agentId ? String(args.agentId) : undefined,
    });
    return `Réflexion #${id} enregistrée: "${String(args.task).slice(0, 60)}" → leçon stockée en mémoire épisodique.`;
  },
});

// ── reflect.recall — Retrieve past reflections relevant to a task ──

registerSkill({
  name: "reflect.recall",
  description:
    "Recall past reflections and lessons learned relevant to a given task. " +
    "Searches episodic memory for past failures and their lessons.",
  adminOnly: false,
  argsSchema: {
    type: "object",
    properties: {
      task: { type: "string", description: "Current task description to find relevant reflections for" },
      limit: { type: "string", description: "Max reflections to return (default: 3)" },
    },
    required: ["task"],
  },
  async execute(args): Promise<string> {
    const result = getRelevantReflections(String(args.task), Number(args.limit) || 3);
    if (!result) return "Aucune réflexion passée trouvée pour cette tâche.";
    return result;
  },
});

// ── crag.grade — Grade document relevance for RAG queries ──

registerSkill({
  name: "crag.grade",
  description:
    "Grade retrieved documents for relevance to a query (CRAG pipeline). " +
    "Returns relevance scores (0-10) and suggests re-query if needed. " +
    "Use when Kingston retrieves documents and wants to check quality before using them.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "The original search query" },
      documents: {
        type: "string",
        description: "JSON array of {content, source} objects to grade",
      },
    },
    required: ["query", "documents"],
  },
  async execute(args): Promise<string> {
    let docs: Array<{ content: string; source: string }>;
    try {
      docs = JSON.parse(String(args.documents));
    } catch {
      return "Erreur: 'documents' doit être un JSON array valide de {content, source}";
    }

    const result = applyCRAG(String(args.query), docs);

    const lines = [
      `**CRAG Analysis** — ${docs.length} documents évalués`,
      ``,
      `Documents pertinents: ${result.goodDocs.length}/${docs.length}`,
    ];

    for (const d of result.goodDocs.slice(0, 5)) {
      lines.push(`  - Score ${d.score}/10: ${d.source} — "${d.content.slice(0, 80)}..."`);
    }

    if (result.needsRequery) {
      lines.push(``, `Re-query suggéré avec: ${result.expandedQueries.join(" | ")}`);
    }
    if (result.needsWebSearch) {
      lines.push(`Fallback web search recommandé (pertinence trop basse)`);
    }

    return lines.join("\n");
  },
});

// ── mnemosyne.decay — Run the memory decay cycle ──

registerSkill({
  name: "mnemosyne.decay",
  description:
    "Run the Mnemosyne memory decay cycle. Recalculates scores for all memories " +
    "based on connectivity, frequency, recency, and entropy. Archives low-scoring memories. " +
    "Normally runs nightly via cron — use manually to trigger immediately.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {},
  },
  async execute(): Promise<string> {
    const stats = runMnemosyneDecay();
    return [
      `**Mnemosyne Decay Cycle**`,
      `Memories scored: ${stats.memoriesScored}`,
      `Memories archived: ${stats.memoriesArchived}`,
      `Episodic events scored: ${stats.episodicScored}`,
      `Episodic events pruned: ${stats.episodicPruned}`,
    ].join("\n");
  },
});

// ── mnemosyne.status — View memory health metrics ──

registerSkill({
  name: "mnemosyne.status",
  description:
    "View memory health metrics: total memories, archived count, recent memories, " +
    "duplicate candidates, and score distribution.",
  adminOnly: false,
  argsSchema: {
    type: "object",
    properties: {},
  },
  async execute(): Promise<string> {
    ensureMnemosyneColumns();
    const { getDb } = await import("../../storage/store.js");
    const db = getDb();

    try {
      const total = (db.prepare("SELECT COUNT(*) as c FROM memory_items").get() as { c: number }).c;
      const archived = (db.prepare("SELECT COUNT(*) as c FROM memory_items WHERE archived = 1").get() as { c: number }).c;
      const active = total - archived;

      const epTotal = (db.prepare("SELECT COUNT(*) as c FROM episodic_events").get() as { c: number }).c;

      // Score distribution
      const highScore = (db.prepare("SELECT COUNT(*) as c FROM memory_items WHERE mnemosyne_score > 0.7 AND (archived = 0 OR archived IS NULL)").get() as { c: number }).c;
      const midScore = (db.prepare("SELECT COUNT(*) as c FROM memory_items WHERE mnemosyne_score BETWEEN 0.3 AND 0.7 AND (archived = 0 OR archived IS NULL)").get() as { c: number }).c;
      const lowScore = (db.prepare("SELECT COUNT(*) as c FROM memory_items WHERE mnemosyne_score < 0.3 AND (archived = 0 OR archived IS NULL)").get() as { c: number }).c;

      // Recent memories + duplicates
      const recent = getRecentMemories(24);
      const dupes = findDuplicates(recent);

      return [
        `**Mnemosyne — Memory Health**`,
        ``,
        `Semantic memories: ${active} active, ${archived} archived (${total} total)`,
        `Episodic events: ${epTotal}`,
        ``,
        `Score distribution (active):`,
        `  High (>0.7): ${highScore}`,
        `  Mid (0.3-0.7): ${midScore}`,
        `  Low (<0.3): ${lowScore}`,
        ``,
        `Recent (24h): ${recent.length} memories`,
        `Potential duplicates: ${dupes.length} pairs`,
      ].join("\n");
    } catch (err) {
      return `Erreur: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

log.debug("Registered 5 intelligence skills (reflect.log, reflect.recall, crag.grade, mnemosyne.decay, mnemosyne.status)");
