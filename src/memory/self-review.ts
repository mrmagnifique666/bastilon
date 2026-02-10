/**
 * MISS/FIX Auto-Graduation v2 — Intelligent Error Learning System.
 *
 * Tracks repeated error patterns. When an error pattern occurs 5+ times,
 * it uses Claude (haiku) to generate a contextual prevention rule.
 * Rules are injected into the system prompt and their effectiveness is tracked.
 *
 * v2 improvements:
 * - Word-level normalization for better error clustering
 * - Claude-powered rule generation (async, with hardcoded fallback)
 * - Rule effectiveness tracking (pre/post graduation error rates)
 * - Error similarity scoring for finding related patterns
 * - Auto-resolution of errors matching graduated patterns
 *
 * Storage: relay/self-review.json (error patterns)
 *          relay/learned-rules.md  (graduated rules)
 */
import fs from "node:fs";
import path from "node:path";
import { log } from "../utils/log.js";

const RELAY_DIR = path.resolve(process.cwd(), "relay");
const PATTERNS_FILE = path.join(RELAY_DIR, "self-review.json");
const RULES_FILE = path.join(RELAY_DIR, "learned-rules.md");
const GRADUATION_THRESHOLD = 5;

// Stop words that don't help differentiate errors
const STOP_WORDS = new Set([
  "the", "a", "an", "is", "was", "are", "were", "been", "be", "have", "has",
  "had", "do", "does", "did", "will", "would", "could", "should", "may",
  "might", "can", "shall", "to", "of", "in", "for", "on", "with", "at",
  "by", "from", "as", "into", "through", "during", "before", "after",
  "error", "failed", "undefined", "null", "not", "no", "or", "and",
]);

export interface ErrorPattern {
  /** Normalized key for grouping */
  key: string;
  /** Human-readable description */
  description: string;
  /** Number of occurrences */
  count: number;
  /** First seen timestamp */
  firstSeen: string;
  /** Last seen timestamp */
  lastSeen: string;
  /** Whether this pattern has been graduated to a rule */
  graduated: boolean;
  /** The fix/rule that was generated */
  rule?: string;
  /** Timestamp when rule was graduated */
  graduatedAt?: string;
  /** Number of errors matching this pattern AFTER graduation */
  postGraduationHits: number;
  /** Tool name most commonly associated with this error */
  toolName?: string;
  /** Example error messages (last 3) for Claude analysis */
  examples: string[];
  /** Whether the rule is considered effective (null = not yet evaluated) */
  effective?: boolean | null;
}

function ensureDir(): void {
  if (!fs.existsSync(RELAY_DIR)) fs.mkdirSync(RELAY_DIR, { recursive: true });
}

function loadPatterns(): ErrorPattern[] {
  try {
    if (!fs.existsSync(PATTERNS_FILE)) return [];
    const raw = JSON.parse(fs.readFileSync(PATTERNS_FILE, "utf-8"));
    // Migrate old format: add missing fields
    return raw.map((p: ErrorPattern & Record<string, unknown>) => ({
      ...p,
      postGraduationHits: p.postGraduationHits ?? 0,
      examples: p.examples ?? [p.description],
      effective: p.effective ?? null,
    }));
  } catch {
    return [];
  }
}

function savePatterns(patterns: ErrorPattern[]): void {
  ensureDir();
  fs.writeFileSync(PATTERNS_FILE, JSON.stringify(patterns, null, 2));
}

/**
 * Extract significant tokens from an error message.
 * Strips noise, numbers, quotes, and stop words.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/["'`]/g, "")
    .replace(/[^a-z0-9_.\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
    .map((w) => w.replace(/\d+/g, "N")); // normalize numbers
}

/**
 * Normalize an error into a grouping key.
 * Uses context + top significant tokens for better clustering.
 */
function normalizeKey(context: string, message: string): string {
  const tokens = tokenize(message);
  // Take the top 5 most significant tokens (sorted alphabetically for stability)
  const sig = [...new Set(tokens)].sort().slice(0, 5).join("_");
  return `${context}:${sig || "unknown"}`.toLowerCase();
}

/**
 * Calculate similarity between two error messages (0-1).
 * Uses Jaccard coefficient on token sets.
 */
export function errorSimilarity(msg1: string, msg2: string): number {
  const t1 = new Set(tokenize(msg1));
  const t2 = new Set(tokenize(msg2));
  if (t1.size === 0 && t2.size === 0) return 1;
  const intersection = [...t1].filter((t) => t2.has(t)).length;
  const union = new Set([...t1, ...t2]).size;
  return union > 0 ? intersection / union : 0;
}

/**
 * Find the best matching pattern for an error (similarity > 0.6).
 */
function findSimilarPattern(
  patterns: ErrorPattern[],
  context: string,
  message: string,
): ErrorPattern | null {
  const key = normalizeKey(context, message);
  // Exact match first
  const exact = patterns.find((p) => p.key === key);
  if (exact) return exact;

  // Fuzzy match: find most similar pattern in the same context category
  const ctxPrefix = context.split(":")[0];
  let bestMatch: ErrorPattern | null = null;
  let bestScore = 0.6; // minimum threshold

  for (const p of patterns) {
    if (!p.key.startsWith(ctxPrefix)) continue;
    const score = errorSimilarity(message, p.description);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = p;
    }
  }

  return bestMatch;
}

/**
 * Hardcoded rule derivation (fast fallback).
 */
function deriveRuleFallback(pattern: ErrorPattern): string {
  const { key, description, count } = pattern;

  if (key.includes("unknown_tool")) {
    const toolName = description.match(/Unknown tool "([^"]+)"/)?.[1];
    return `RULE: The tool "${toolName || "?"}" does not exist. Use the tool catalog to find the correct tool name.`;
  }
  if (key.includes("validation")) {
    return `RULE: ${description.split(".")[0]}. Always check required arguments before calling tools.`;
  }
  if (key.includes("parse entities") || key.includes("markdown")) {
    return `RULE: Telegram messages with special characters (*, _, [, ]) may fail Markdown parsing. Avoid raw Markdown in dynamic content.`;
  }
  if (key.includes("timeout")) {
    return `RULE: Long-running operations may timeout. Break large tasks into smaller steps.`;
  }
  if (key.includes("not permitted") || key.includes("permission")) {
    return `RULE: ${description.split(".")[0]}. Check permissions before attempting restricted tools.`;
  }
  if (key.includes("econnrefused") || key.includes("network")) {
    return `RULE: Network operations can fail intermittently. Add retry logic for external API calls.`;
  }

  return `RULE (auto-learned from ${count} occurrences): Avoid pattern "${description.slice(0, 100)}". This error has occurred ${count} times.`;
}

/**
 * Generate a smart rule using Claude (haiku).
 * Falls back to hardcoded rules if Claude is unavailable.
 */
async function deriveRuleSmart(pattern: ErrorPattern): Promise<string> {
  try {
    // Dynamic import to avoid circular dependency
    const { spawn } = await import("node:child_process");
    const { config } = await import("../config/env.js");

    const examples = pattern.examples.slice(-3).join("\n---\n");
    const prompt =
      `You are analyzing a recurring error pattern in an autonomous AI assistant called Kingston.\n\n` +
      `Error context: ${pattern.key}\n` +
      `Occurrences: ${pattern.count}\n` +
      `First seen: ${pattern.firstSeen}\n` +
      `Last seen: ${pattern.lastSeen}\n` +
      `Tool involved: ${pattern.toolName || "unknown"}\n\n` +
      `Recent error examples:\n${examples}\n\n` +
      `Generate a SINGLE concise prevention rule (1-2 sentences) that would prevent this error from recurring. ` +
      `Start with "RULE:" and be specific and actionable. Focus on what to DO differently, not what went wrong.`;

    return new Promise<string>((resolve) => {
      const proc = spawn(config.claudeBin, [
        "-p", prompt,
        "--model", config.claudeModelHaiku,
        "--output-format", "text",
        "--max-tokens", "200",
      ], {
        timeout: 30000,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let output = "";
      proc.stdout.on("data", (d: Buffer) => (output += d.toString()));
      proc.on("close", (code) => {
        if (code === 0 && output.trim().startsWith("RULE")) {
          log.info(`[self-review] Claude generated smart rule for "${pattern.key}"`);
          resolve(output.trim());
        } else {
          resolve(deriveRuleFallback(pattern));
        }
      });
      proc.on("error", () => resolve(deriveRuleFallback(pattern)));

      // Write prompt via stdin for long prompts
      proc.stdin.write(prompt);
      proc.stdin.end();
    });
  } catch {
    return deriveRuleFallback(pattern);
  }
}

/**
 * Record an error occurrence and check for graduation.
 * Called from the error logging pipeline.
 */
export function recordErrorPattern(
  context: string,
  message: string,
  toolName?: string,
): void {
  const patterns = loadPatterns();
  const now = new Date().toISOString();

  // Find existing pattern (exact key or similar)
  let pattern = findSimilarPattern(patterns, context, message);
  const key = normalizeKey(context, message);

  if (pattern) {
    pattern.count++;
    pattern.lastSeen = now;
    pattern.description = message.slice(0, 200);
    if (toolName && !pattern.toolName) pattern.toolName = toolName;

    // Keep last 3 examples
    pattern.examples.push(message.slice(0, 300));
    if (pattern.examples.length > 5) pattern.examples = pattern.examples.slice(-3);

    // Track post-graduation hits
    if (pattern.graduated) {
      pattern.postGraduationHits++;
    }
  } else {
    pattern = {
      key,
      description: message.slice(0, 200),
      count: 1,
      firstSeen: now,
      lastSeen: now,
      graduated: false,
      postGraduationHits: 0,
      toolName: toolName || undefined,
      examples: [message.slice(0, 300)],
      effective: null,
    };
    patterns.push(pattern);
  }

  // Check for graduation (async — fire and forget)
  if (pattern.count >= GRADUATION_THRESHOLD && !pattern.graduated) {
    pattern.graduated = true;
    pattern.graduatedAt = now;
    // Generate smart rule asynchronously
    deriveRuleSmart(pattern).then((rule) => {
      pattern!.rule = rule;
      appendRule(rule, pattern!);
      savePatterns(patterns);
      log.info(
        `[self-review] Auto-graduated pattern "${pattern!.key}" (${pattern!.count} occurrences) → smart rule`,
      );
    });
  }

  savePatterns(patterns);
}

/**
 * Append a graduated rule to the learned-rules file.
 */
function appendRule(rule: string, pattern: ErrorPattern): void {
  ensureDir();
  const entry = `\n- ${rule} _(graduated ${new Date().toISOString().split("T")[0]}, ${pattern.count} occurrences, tool: ${pattern.toolName || "n/a"})_\n`;

  let content = "";
  if (fs.existsSync(RULES_FILE)) {
    content = fs.readFileSync(RULES_FILE, "utf-8");
  } else {
    content =
      "# Learned Rules\n\n> Auto-graduated from repeated error patterns (MISS/FIX system).\n> These rules are injected into the system prompt.\n";
  }

  content += entry;
  fs.writeFileSync(RULES_FILE, content);
}

/**
 * Get all learned rules as a prompt section.
 * Returns empty string if no rules exist.
 */
export function getLearnedRulesPrompt(): string {
  try {
    if (!fs.existsSync(RULES_FILE)) return "";
    const content = fs.readFileSync(RULES_FILE, "utf-8");
    const rules = content
      .split("\n")
      .filter((line) => line.startsWith("- RULE"))
      .map((line) => line.replace(/\s*_\(graduated.*\)_/, "").trim());
    if (rules.length === 0) return "";
    return `## Learned Rules (auto-graduated)\n${rules.join("\n")}`;
  } catch {
    return "";
  }
}

/**
 * Get a summary of tracked error patterns for the errors skill.
 */
export function getPatternSummary(): string {
  const patterns = loadPatterns();
  if (patterns.length === 0) return "No error patterns tracked.";

  const sorted = [...patterns].sort((a, b) => b.count - a.count);
  return sorted
    .slice(0, 20)
    .map((p) => {
      const status = p.graduated ? "GRADUATED" : `${p.count}/${GRADUATION_THRESHOLD}`;
      const eff = p.graduated
        ? p.postGraduationHits === 0
          ? " ✅ effective"
          : ` ⚠️ ${p.postGraduationHits} post-rule hits`
        : "";
      const tool = p.toolName ? ` [${p.toolName}]` : "";
      return (
        `[${status}]${tool} ${p.key}\n` +
        `  ${p.description.slice(0, 120)}\n` +
        `  First: ${p.firstSeen.split("T")[0]} | Last: ${p.lastSeen.split("T")[0]}${eff}`
      );
    })
    .join("\n\n");
}

/**
 * Evaluate rule effectiveness for all graduated patterns.
 * A rule is effective if post-graduation hits are < 20% of pre-graduation count.
 */
export function evaluateEffectiveness(): Array<{
  key: string;
  rule: string;
  preCount: number;
  postHits: number;
  effective: boolean;
  score: number;
}> {
  const patterns = loadPatterns();
  const results = [];

  for (const p of patterns) {
    if (!p.graduated || !p.rule) continue;
    const preCount = p.count - p.postGraduationHits;
    const score = preCount > 0 ? 1 - p.postGraduationHits / preCount : 1;
    const effective = score >= 0.8; // effective if reduced errors by 80%+
    p.effective = effective;
    results.push({
      key: p.key,
      rule: p.rule,
      preCount,
      postHits: p.postGraduationHits,
      effective,
      score: Math.round(score * 100),
    });
  }

  savePatterns(patterns);
  return results;
}

/**
 * Get error trend data for the last N hours.
 * Returns hourly error counts.
 */
export function getErrorTrends(hours = 24): Array<{ hour: string; count: number }> {
  try {
    // Dynamic import to avoid circular dependency at load time
    const Database = require("better-sqlite3");
    const dbPath = path.resolve("relay.db");
    if (!fs.existsSync(dbPath)) return [];
    const db = new Database(dbPath, { readonly: true });
    const cutoff = Math.floor(Date.now() / 1000) - hours * 3600;
    const rows = db
      .prepare(
        `SELECT strftime('%Y-%m-%d %H:00', timestamp, 'unixepoch', 'localtime') as hour,
                COUNT(*) as count
         FROM error_log WHERE timestamp > ?
         GROUP BY hour ORDER BY hour`,
      )
      .all(cutoff) as Array<{ hour: string; count: number }>;
    db.close();
    return rows;
  } catch {
    return [];
  }
}

/**
 * Get all patterns (for external analysis).
 */
export function getAllPatterns(): ErrorPattern[] {
  return loadPatterns();
}

/**
 * Reset post-graduation hits for a pattern (after confirming fix).
 */
export function resetPatternHits(key: string): boolean {
  const patterns = loadPatterns();
  const pattern = patterns.find((p) => p.key === key);
  if (!pattern) return false;
  pattern.postGraduationHits = 0;
  pattern.effective = null;
  savePatterns(patterns);
  return true;
}

/**
 * Deactivate an ineffective rule (remove from prompt injection).
 */
export function deactivateRule(key: string): boolean {
  const patterns = loadPatterns();
  const pattern = patterns.find((p) => p.key === key);
  if (!pattern || !pattern.graduated) return false;

  // Remove from rules file
  try {
    if (fs.existsSync(RULES_FILE)) {
      let content = fs.readFileSync(RULES_FILE, "utf-8");
      // Remove the line containing this rule
      const lines = content.split("\n").filter(
        (line) => !line.includes(pattern.rule || "___NOMATCH___"),
      );
      fs.writeFileSync(RULES_FILE, lines.join("\n"));
    }
  } catch { /* best effort */ }

  pattern.graduated = false;
  pattern.effective = false;
  pattern.count = 0; // Reset count so it can re-graduate
  pattern.postGraduationHits = 0;
  savePatterns(patterns);
  log.info(`[self-review] Deactivated ineffective rule: ${key}`);
  return true;
}
