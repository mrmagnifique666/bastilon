/**
 * LLM Response Cache — prevents redundant API calls for identical prompts.
 * Uses SHA-256 hash of prompt + model as cache key, with configurable TTL.
 */
import crypto from "node:crypto";
import { getDb } from "../storage/store.js";
import { log } from "../utils/log.js";

interface CacheEntry {
  id: number;
  prompt_hash: string;
  model: string;
  response: string;
  ttl_seconds: number;
  created_at: number;
}

function hashPrompt(prompt: string, model: string): string {
  return crypto.createHash("sha256").update(`${model}:${prompt}`).digest("hex");
}

/**
 * Get a cached response if it exists and hasn't expired.
 */
export function getCachedResponse(prompt: string, model: string): string | null {
  try {
    const db = getDb();
    const hash = hashPrompt(prompt, model);
    const row = db.prepare(
      `SELECT response, created_at, ttl_seconds FROM llm_cache
       WHERE prompt_hash = ? AND model = ?
       AND (unixepoch() - created_at) < ttl_seconds
       ORDER BY created_at DESC LIMIT 1`
    ).get(hash, model) as CacheEntry | undefined;

    if (row) {
      log.debug(`[llm-cache] HIT for ${model} (hash: ${hash.slice(0, 8)}...)`);
      return row.response;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Store a response in cache.
 * @param ttl Time-to-live in seconds (default: 1 hour)
 */
export function setCachedResponse(prompt: string, model: string, response: string, ttl: number = 3600): void {
  try {
    const db = getDb();
    const hash = hashPrompt(prompt, model);
    db.prepare(
      `INSERT INTO llm_cache (prompt_hash, model, response, ttl_seconds) VALUES (?, ?, ?, ?)`
    ).run(hash, model, response, ttl);
    log.debug(`[llm-cache] STORE for ${model} (hash: ${hash.slice(0, 8)}..., ttl: ${ttl}s)`);
  } catch (err) {
    log.debug(`[llm-cache] Store failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Clean up expired cache entries.
 * Returns number of entries removed.
 */
export function cleanupCache(): number {
  try {
    const db = getDb();
    const info = db.prepare(
      "DELETE FROM llm_cache WHERE (unixepoch() - created_at) >= ttl_seconds"
    ).run();
    if (info.changes > 0) {
      log.info(`[llm-cache] Cleaned ${info.changes} expired entries`);
    }
    return info.changes;
  } catch {
    return 0;
  }
}

/**
 * Get cache stats.
 */
export function getCacheStats(): { total: number; expired: number; hitRate: string } {
  try {
    const db = getDb();
    const total = (db.prepare("SELECT COUNT(*) as c FROM llm_cache").get() as { c: number }).c;
    const expired = (db.prepare(
      "SELECT COUNT(*) as c FROM llm_cache WHERE (unixepoch() - created_at) >= ttl_seconds"
    ).get() as { c: number }).c;
    return { total, expired, hitRate: "N/A" };
  } catch {
    return { total: 0, expired: 0, hitRate: "N/A" };
  }
}
