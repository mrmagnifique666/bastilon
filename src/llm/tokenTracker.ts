/**
 * Token Usage Tracker — logs estimated token usage per provider per day.
 * Inspired by OpenClaw Token Optimization Guide.
 *
 * Tracks: Ollama, Groq, Gemini, Claude (CLI), Haiku
 * Estimates tokens for providers that don't return usage stats (Ollama, Claude CLI).
 * Approximation: ~4 chars per token (standard for most LLMs).
 *
 * All data stored in `token_usage` table — queryable via analytics.tokens skill.
 * Cost is $0 for all providers (free tiers / local), but tracking enables
 * optimization and capacity planning.
 */
import { getDb } from "../storage/store.js";
import { log } from "../utils/log.js";

const CHARS_PER_TOKEN = 4; // rough estimate

export type Provider = "ollama" | "groq" | "gemini" | "claude" | "haiku" | "openrouter";

interface TokenUsageRow {
  provider: string;
  date: string;
  input_tokens: number;
  output_tokens: number;
  requests: number;
  estimated_cost_usd: number;
}

// Pricing per 1M tokens (input/output) — tracks theoretical cost even for free tiers
interface ModelPricing { inputPer1M: number; outputPer1M: number; }
export const PRICING_TABLE: Record<Provider, ModelPricing> = {
  claude:  { inputPer1M: 15.00, outputPer1M: 75.00 },  // Opus (Max plan = $0 réel)
  haiku:   { inputPer1M: 0.80,  outputPer1M: 4.00 },
  gemini:  { inputPer1M: 0.30,  outputPer1M: 1.20 },   // Flash free tier
  ollama:  { inputPer1M: 0,     outputPer1M: 0 },
  groq:    { inputPer1M: 0,     outputPer1M: 0 },
  openrouter: { inputPer1M: 0, outputPer1M: 0 },  // free tier models
};

let tableReady = false;

function ensureTable(): void {
  if (tableReady) return;
  try {
    const db = getDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS token_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        date TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        requests INTEGER NOT NULL DEFAULT 0,
        estimated_cost_usd REAL NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_token_provider_date ON token_usage(provider, date);
    `);
    tableReady = true;
  } catch (err) {
    log.debug(`[tokenTracker] Failed to create table: ${err}`);
  }
}

function getDateStr(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/**
 * Log token usage for a provider.
 * If actual token counts aren't available, estimates from character counts.
 */
export function logTokens(
  provider: Provider,
  inputTokens: number,
  outputTokens: number,
): void {
  ensureTable();
  try {
    const db = getDb();
    const date = getDateStr();
    const pricing = PRICING_TABLE[provider];
    const cost = (inputTokens / 1_000_000) * pricing.inputPer1M + (outputTokens / 1_000_000) * pricing.outputPer1M;

    db.prepare(
      `INSERT INTO token_usage (provider, date, input_tokens, output_tokens, requests, estimated_cost_usd)
       VALUES (?, ?, ?, ?, 1, ?)
       ON CONFLICT(provider, date) DO UPDATE SET
         input_tokens = input_tokens + excluded.input_tokens,
         output_tokens = output_tokens + excluded.output_tokens,
         requests = requests + 1,
         estimated_cost_usd = estimated_cost_usd + excluded.estimated_cost_usd,
         updated_at = unixepoch()`
    ).run(provider, date, inputTokens, outputTokens, cost);
  } catch (err) {
    log.debug(`[tokenTracker] Failed to log tokens: ${err}`);
  }
}

/**
 * Estimate tokens from character count (for providers that don't return usage).
 */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * Log estimated tokens from text lengths (for Ollama, Claude CLI).
 */
export function logEstimatedTokens(
  provider: Provider,
  inputChars: number,
  outputChars: number,
): void {
  logTokens(provider, estimateTokens(inputChars), estimateTokens(outputChars));
}

/**
 * Get usage summary for a date range.
 */
export function getUsageSummary(days = 1): TokenUsageRow[] {
  ensureTable();
  try {
    const db = getDb();
    const since = new Date();
    since.setDate(since.getDate() - days);
    const sinceStr = since.toISOString().split("T")[0];

    return db.prepare(
      `SELECT provider, date, input_tokens, output_tokens, requests, estimated_cost_usd
       FROM token_usage WHERE date >= ? ORDER BY date DESC, provider`
    ).all(sinceStr) as TokenUsageRow[];
  } catch {
    return [];
  }
}

/**
 * Get total tokens today per provider.
 */
export function getTodayUsage(): Record<string, { input: number; output: number; requests: number; cost: number }> {
  ensureTable();
  const result: Record<string, { input: number; output: number; requests: number; cost: number }> = {};
  try {
    const db = getDb();
    const date = getDateStr();
    const rows = db.prepare(
      "SELECT provider, input_tokens, output_tokens, requests, estimated_cost_usd FROM token_usage WHERE date = ?"
    ).all(date) as TokenUsageRow[];

    for (const r of rows) {
      result[r.provider] = {
        input: r.input_tokens,
        output: r.output_tokens,
        requests: r.requests,
        cost: r.estimated_cost_usd,
      };
    }
  } catch { /* ignore */ }
  return result;
}

/**
 * Get context size estimate in tokens for a set of messages.
 */
export function estimateContextTokens(messages: Array<{ content: string }>): number {
  let totalChars = 0;
  for (const m of messages) {
    totalChars += (m.content || "").length;
  }
  return estimateTokens(totalChars);
}

/**
 * Get daily usage trend — group by date with totals per provider.
 */
export function getUsageTrend(days = 7): Array<{
  date: string;
  provider: string;
  input_tokens: number;
  output_tokens: number;
  requests: number;
  cost: number;
}> {
  ensureTable();
  try {
    const db = getDb();
    const since = new Date();
    since.setDate(since.getDate() - days);
    const sinceStr = since.toISOString().split("T")[0];

    return db.prepare(
      `SELECT date, provider, input_tokens, output_tokens, requests, estimated_cost_usd as cost
       FROM token_usage WHERE date >= ? ORDER BY date ASC, provider`
    ).all(sinceStr) as any[];
  } catch {
    return [];
  }
}

// Rate limiting: track last call timestamp per provider
const lastCallTimestamp: Record<string, number> = {};
const MIN_DELAY_MS: Record<string, number> = {
  ollama: 0, // local, no limit
  groq: 2000, // 30 req/min = 2s minimum
  openrouter: 1000, // respect free tier rate limits
  gemini: 1000, // generous free tier but respect it
  claude: 0, // CLI handles its own rate limits
  haiku: 1000,
};

/**
 * Enforce minimum delay between API calls for a provider.
 * Returns a promise that resolves when it's safe to call.
 */
export async function enforceRateDelay(provider: Provider): Promise<void> {
  const minDelay = MIN_DELAY_MS[provider] || 0;
  if (minDelay === 0) return;

  const lastCall = lastCallTimestamp[provider] || 0;
  const elapsed = Date.now() - lastCall;

  if (elapsed < minDelay) {
    const waitMs = minDelay - elapsed;
    log.debug(`[tokenTracker] Rate delay: waiting ${waitMs}ms for ${provider}`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  lastCallTimestamp[provider] = Date.now();
}

/**
 * Mark a provider call as just completed (for rate tracking).
 */
export function markCallComplete(provider: Provider): void {
  lastCallTimestamp[provider] = Date.now();
}
