/**
 * Semantic memory skills — search, remember, forget, stats.
 * Uses embeddings for semantic search instead of LIKE %query%.
 */
import { registerSkill } from "../loader.js";
import {
  searchMemories,
  searchMemoriesFTS,
  searchMemoriesHybrid,
  addMemory,
  forgetMemory,
  getMemoryStats,
  runMemoryCleanup,
  consolidateMemories,
  type MemoryCategory,
} from "../../memory/semantic.js";

const VALID_CATEGORIES = new Set(["profile", "preference", "event", "knowledge", "skill", "project"]);

registerSkill({
  name: "memory.search",
  description: "Semantic memory search — finds memories by meaning, not just keywords",
  argsSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query (natural language)" },
      category: { type: "string", description: "Filter by category: profile|preference|event|knowledge|skill|project" },
      limit: { type: "number", description: "Max results (default 10)" },
    },
    required: ["query"],
  },
  async execute(args) {
    const query = args.query as string;
    const limit = (args.limit as number) || 10;
    const categoryFilter = args.category as string | undefined;

    let results = await searchMemories(query, limit);

    if (categoryFilter && VALID_CATEGORIES.has(categoryFilter)) {
      results = results.filter((r) => r.category === categoryFilter);
    }

    if (results.length === 0) {
      return "No memories found matching this query.";
    }

    const lines = results.map((r) =>
      `#${r.id} [${r.category}] (score: ${r.score.toFixed(2)}, accesses: ${r.access_count}): ${r.content}`
    );
    return `Found ${results.length} memories:\n${lines.join("\n")}`;
  },
});

registerSkill({
  name: "memory.remember",
  description: "Store a new memory with auto-categorization and embedding",
  argsSchema: {
    type: "object",
    properties: {
      content: { type: "string", description: "The fact or information to remember" },
      category: { type: "string", description: "Category: profile|preference|event|knowledge|skill|project (auto if omitted)" },
    },
    required: ["content"],
  },
  async execute(args) {
    const content = args.content as string;
    let category = args.category as string | undefined;

    if (category && !VALID_CATEGORIES.has(category)) {
      category = undefined;
    }

    const id = await addMemory(
      content,
      (category as MemoryCategory) || "knowledge",
      "manual"
    );
    return `Memory #${id} stored [${category || "knowledge"}]: ${content}`;
  },
});

registerSkill({
  name: "memory.forget",
  description: "Delete a memory by ID",
  argsSchema: {
    type: "object",
    properties: {
      id: { type: "number", description: "Memory ID to delete" },
    },
    required: ["id"],
  },
  async execute(args) {
    const id = args.id as number;
    const success = forgetMemory(id);
    return success ? `Memory #${id} deleted.` : `Memory #${id} not found.`;
  },
});

registerSkill({
  name: "memory.stats",
  description: "Show semantic memory statistics — totals, categories, salience",
  argsSchema: {
    type: "object",
    properties: {},
  },
  async execute() {
    const stats = getMemoryStats();
    const lines = [
      `Total memories: ${stats.total}`,
      `Average salience: ${stats.avgSalience.toFixed(2)}`,
      `Oldest memory: ${stats.oldestDate || "none"}`,
    ];

    if (Object.keys(stats.byCategory).length > 0) {
      lines.push("\nBy category:");
      for (const [cat, count] of Object.entries(stats.byCategory)) {
        lines.push(`  ${cat}: ${count}`);
      }
    }

    if (stats.mostAccessed) {
      lines.push(`\nMost accessed: #${stats.mostAccessed.id} (${stats.mostAccessed.access_count}x): ${stats.mostAccessed.content.slice(0, 80)}`);
    }

    return lines.join("\n");
  },
});

registerSkill({
  name: "memory.cleanup",
  description: "Clean up memories — delete trivial entries and merge near-duplicates",
  argsSchema: {
    type: "object",
    properties: {},
  },
  async execute() {
    const result = runMemoryCleanup();
    return `Cleanup complete: deleted ${result.deleted} trivial, merged ${result.merged} near-duplicates.`;
  },
});

registerSkill({
  name: "memory.consolidate",
  description: "Consolidate similar memories into concise summaries via Gemini Flash",
  argsSchema: {
    type: "object",
    properties: {
      category: { type: "string", description: "Filter by category (optional)" },
      dry_run: { type: "boolean", description: "Preview clusters without merging (default false)" },
    },
  },
  async execute(args) {
    const category = args.category as string | undefined;
    const dryRun = args.dry_run as boolean | undefined;

    const validCat = category && VALID_CATEGORIES.has(category) ? category as MemoryCategory : undefined;
    const result = await consolidateMemories({ category: validCat, dryRun: dryRun ?? false });

    if (dryRun) {
      return `[Dry run] Found ${result.clusters} clusters (${result.removed} memories would be consolidated).`;
    }
    return `Consolidation complete: ${result.clusters} clusters found, ${result.consolidated} consolidated, ${result.removed} removed.`;
  },
});

// --- Tiered search: quick (FTS5 only) and deep (hybrid BM25 + vector + RRF) ---

registerSkill({
  name: "memory.quick",
  description: "Fast keyword search on memories using FTS5 BM25 — instant, no embeddings needed",
  argsSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search keywords" },
      category: { type: "string", description: "Filter by category (optional)" },
      limit: { type: "number", description: "Max results (default 10)" },
    },
    required: ["query"],
  },
  async execute(args) {
    const query = args.query as string;
    const limit = (args.limit as number) || 10;
    const category = args.category as string | undefined;
    const validCat = category && VALID_CATEGORIES.has(category) ? category : undefined;

    const results = searchMemoriesFTS(query, limit, validCat);

    if (results.length === 0) return "No memories found (FTS5 keyword search).";
    const lines = results.map((r) =>
      `#${r.id} [${r.category}] (score: ${r.score.toFixed(2)}): ${r.content}`
    );
    return `Found ${results.length} memories (FTS5 BM25):\n${lines.join("\n")}`;
  },
});

registerSkill({
  name: "memory.deep",
  description: "Deep hybrid search — BM25 + semantic vector + RRF fusion + query expansion via Ollama. Best quality, slower.",
  argsSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query (natural language)" },
      category: { type: "string", description: "Filter by category (optional)" },
      limit: { type: "number", description: "Max results (default 10)" },
      expand: { type: "boolean", description: "Enable query expansion via Ollama/Groq (default true)" },
    },
    required: ["query"],
  },
  async execute(args) {
    const query = args.query as string;
    const limit = (args.limit as number) || 10;
    const category = args.category as string | undefined;
    const validCat = category && VALID_CATEGORIES.has(category) ? category : undefined;
    const expand = args.expand !== false; // default true

    const results = await searchMemoriesHybrid(query, limit, validCat, expand);

    if (results.length === 0) return "No memories found (hybrid search).";
    const lines = results.map((r) =>
      `#${r.id} [${r.category}] (score: ${r.score.toFixed(2)}, accesses: ${r.access_count}): ${r.content}`
    );
    return `Found ${results.length} memories (hybrid BM25+vector+RRF${expand ? "+expansion" : ""}):\n${lines.join("\n")}`;
  },
});
