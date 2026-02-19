/**
 * Adaptive Tool Selection — learns from tool execution history.
 *
 * Uses the existing tool-pipeline metrics to:
 * 1. Generate reliability scores per tool (0-100)
 * 2. Build "tool hints" that LLMs can use to pick better tools
 * 3. Auto-disable tools with catastrophic failure rates
 * 4. Track tool success patterns per context (agent, cron, user)
 *
 * All functions are synchronous (metrics are in-memory).
 * No circular dependencies — imports only from tool-pipeline and loader.
 */

import { getSkillStats, getSkillMetrics } from "./tool-pipeline.js";
import { getRegistry } from "./loader.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ToolRecommendation = "preferred" | "ok" | "caution" | "avoid";

export interface ToolReliability {
  score: number;
  avgDurationMs: number;
  recommendation: ToolRecommendation;
}

// ---------------------------------------------------------------------------
// A. getToolReliability — score a single tool from execution history
// ---------------------------------------------------------------------------

/**
 * Compute a reliability score for a tool based on its execution metrics.
 *
 * Score = (successes / total) * 100, adjusted for recency:
 * - Recent failures (last 30min) weigh 2x heavier
 * - If total < 3: score = 50 (neutral — not enough data)
 *
 * Recommendation thresholds:
 * - >= 80: "preferred"
 * - >= 50: "ok"
 * - >= 20: "caution"
 * - < 20:  "avoid"
 */
export function getToolReliability(skillName: string): ToolReliability {
  const stats = getSkillStats(skillName);

  // Not enough data — return neutral
  if (stats.total < 3) {
    return { score: 50, avgDurationMs: stats.avgDurationMs, recommendation: "ok" };
  }

  // Base score from overall success rate
  let score = (stats.successes / stats.total) * 100;

  // Recency adjustment: check last 30 minutes of metrics for this skill
  const now = Date.now();
  const recentWindow = 30 * 60 * 1000; // 30 minutes
  const allRecent = getSkillMetrics(500); // get all available metrics (most recent first)
  const recentForSkill = allRecent.filter(
    (m) => m.skillName === skillName && (now - m.timestamp) < recentWindow,
  );

  if (recentForSkill.length >= 2) {
    const recentSuccesses = recentForSkill.filter((m) => m.ok).length;
    const recentRate = (recentSuccesses / recentForSkill.length) * 100;

    // Blend: 60% overall + 40% recent (recent failures matter more)
    score = score * 0.6 + recentRate * 0.4;
  }

  // Clamp to 0-100
  score = Math.round(Math.max(0, Math.min(100, score)));

  const recommendation: ToolRecommendation =
    score >= 80 ? "preferred" :
    score >= 50 ? "ok" :
    score >= 20 ? "caution" :
    "avoid";

  return { score, avgDurationMs: stats.avgDurationMs, recommendation };
}

// ---------------------------------------------------------------------------
// B. buildToolHints — compact prompt text about tool reliability
// ---------------------------------------------------------------------------

/**
 * Generate a compact text block for LLM prompt injection.
 * Only includes:
 * - Tools with score < 80 (problematic — LLM needs to know)
 * - Top 3 "preferred" tools (for positive reinforcement)
 * Max 10 lines to keep prompt compact.
 */
export function buildToolHints(skillNames: string[]): string {
  if (skillNames.length === 0) return "";

  const entries: Array<{ name: string; score: number; avgMs: number; rec: ToolRecommendation }> = [];

  for (const name of skillNames) {
    const rel = getToolReliability(name);
    entries.push({ name, score: rel.score, avgMs: rel.avgDurationMs, rec: rel.recommendation });
  }

  // Split into problematic (score < 80) and preferred
  const problematic = entries.filter((e) => e.score < 80 && e.rec !== "ok");
  const preferred = entries
    .filter((e) => e.rec === "preferred")
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  // Nothing interesting to report
  if (problematic.length === 0 && preferred.length === 0) return "";

  const lines: string[] = [];

  for (const e of preferred) {
    const ms = e.avgMs > 1000 ? `${(e.avgMs / 1000).toFixed(1)}s` : `${e.avgMs}ms`;
    lines.push(`  + ${e.name} (${e.score}% fiable, ${ms}) — recommande`);
  }

  for (const e of problematic) {
    const ms = e.avgMs > 1000 ? `${(e.avgMs / 1000).toFixed(1)}s` : `${e.avgMs}ms`;
    if (e.rec === "caution") {
      lines.push(`  ! ${e.name} (${e.score}% fiable, ${ms}) — utiliser avec precaution`);
    } else if (e.rec === "avoid") {
      lines.push(`  x ${e.name} (${e.score}% fiable, ${ms}) — eviter, chercher alternative`);
    }
  }

  // Cap at 10 lines
  const capped = lines.slice(0, 10);
  if (capped.length === 0) return "";

  return "FIABILITE DES OUTILS:\n" + capped.join("\n");
}

// ---------------------------------------------------------------------------
// C. getToolAlternatives — suggest fallbacks for a failed tool
// ---------------------------------------------------------------------------

/** Static map of known fallback alternatives per skill */
const STATIC_ALTERNATIVES: Record<string, string[]> = {
  "web.search":       ["web.fetch", "web.browse"],
  "web.fetch":        ["web.search", "web.browse"],
  "web.browse":       ["web.fetch", "web.search"],
  "weather.current":  ["weather.now", "web.search"],
  "weather.now":      ["weather.current", "web.search"],
  "moltbook.post":    ["moltbook.draft", "content.draft"],
  "moltbook.draft":   ["content.draft"],
  "moltbook.feed":    ["web.search"],
  "trading.positions":["trading.account"],
  "trading.account":  ["trading.positions"],
  "image.generate":   ["web.search"],
  "memory.search":    ["memory.recall", "kg.search", "notes.list"],
  "memory.recall":    ["memory.search", "kg.search"],
  "kg.search":        ["memory.search", "kg.query"],
  "shell.exec":       ["code.request"],
  "gmail.read":       ["gmail.list"],
  "gmail.list":       ["gmail.read"],
};

/**
 * Suggest alternative tools when a skill fails.
 * Uses static map first, then dynamic namespace-based lookup.
 * Returns only alternatives that actually exist in the registry.
 */
export function getToolAlternatives(failedSkillName: string): string[] {
  const registry = getRegistry();
  const alternatives: string[] = [];

  // 1. Static alternatives
  const staticAlts = STATIC_ALTERNATIVES[failedSkillName];
  if (staticAlts) {
    for (const alt of staticAlts) {
      if (registry.has(alt)) {
        alternatives.push(alt);
      }
    }
  }

  // 2. Dynamic namespace-based lookup: find other skills in the same namespace
  const dotIdx = failedSkillName.indexOf(".");
  if (dotIdx > 0) {
    const namespace = failedSkillName.slice(0, dotIdx + 1); // e.g. "web."
    for (const name of Array.from(registry.keys())) {
      if (name.startsWith(namespace) && name !== failedSkillName && !alternatives.includes(name)) {
        alternatives.push(name);
      }
    }
  }

  // Cap at 5 alternatives to keep it useful
  return alternatives.slice(0, 5);
}

// ---------------------------------------------------------------------------
// D. getAdaptiveToolPrompt — full context-aware prompt addition
// ---------------------------------------------------------------------------

/**
 * Build a complete adaptive tool intelligence block for LLM prompt injection.
 * Designed to be SHORT (max ~15 lines) to avoid context bloat.
 *
 * @param context - "agent" | "cron" | "user" — affects which tools to analyze
 * @param agentId - Optional agent ID for agent-specific context
 * @returns Prompt text to inject, or empty string if nothing to report
 */
export function getAdaptiveToolPrompt(
  context: "agent" | "cron" | "user",
  agentId?: string,
): string {
  const registry = getRegistry();
  if (registry.size === 0) return "";

  // Gather all registered skill names
  const allSkills = Array.from(registry.keys());

  // Only compute reliability for tools that have some history (total > 0)
  const skillsWithHistory = allSkills.filter((name) => {
    const stats = getSkillStats(name);
    return stats.total > 0;
  });

  if (skillsWithHistory.length === 0) return "";

  // Build hints from tools with history
  const hints = buildToolHints(skillsWithHistory);
  if (!hints) return "";

  // Find tools that should have alternatives listed (score < 50)
  const altLines: string[] = [];
  for (const name of skillsWithHistory) {
    const rel = getToolReliability(name);
    if (rel.recommendation === "caution" || rel.recommendation === "avoid") {
      const alts = getToolAlternatives(name);
      if (alts.length > 0) {
        altLines.push(`  ${name} -> ${alts.slice(0, 3).join(", ")}`);
      }
    }
  }

  // Assemble the prompt block
  const parts: string[] = [
    "INTELLIGENCE ADAPTATIVE — OUTILS:",
    hints,
  ];

  if (altLines.length > 0) {
    parts.push("Alternatives si echec:");
    parts.push(...altLines.slice(0, 5));
  }

  parts.push("Si un outil echoue 2x de suite, passe a l'alternative.\n");

  return parts.join("\n");
}
