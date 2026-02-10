/**
 * Trust Decay for cached/stored data.
 *
 * Applies a time-based decay to data freshness.
 * Formula: trust = baseTrust * (1 - decayRate) ^ daysSinceCreation
 *
 * Data types have different decay rates:
 *   - facts (user preferences): very slow decay (180 days half-life)
 *   - observations (things noticed): moderate decay (30 days half-life)
 *   - external data (API results, web content): fast decay (7 days half-life)
 *   - cached responses: very fast decay (1 day half-life)
 */
import { log } from "../utils/log.js";

export type DataKind = "fact" | "observation" | "external" | "cached";

/** Half-life in days for each data kind */
const HALF_LIVES: Record<DataKind, number> = {
  fact: 180,
  observation: 30,
  external: 7,
  cached: 1,
};

/** Trust threshold below which data is considered stale */
const STALE_THRESHOLD = 0.3;

/**
 * Calculate current trust score for a piece of data.
 * Returns a value between 0 and 1.
 */
export function calculateTrust(
  createdAt: Date | number,
  kind: DataKind = "observation",
  baseTrust: number = 1.0
): number {
  const created = typeof createdAt === "number" ? createdAt * 1000 : createdAt.getTime();
  const daysSince = (Date.now() - created) / 86_400_000;
  if (daysSince <= 0) return baseTrust;

  const halfLife = HALF_LIVES[kind];
  // decay = 0.5 ^ (days / halfLife) which is equivalent to (1 - rate) ^ days
  const trust = baseTrust * Math.pow(0.5, daysSince / halfLife);
  return Math.round(trust * 1000) / 1000; // 3 decimal places
}

/**
 * Check if a piece of data is stale (trust below threshold).
 */
export function isStale(
  createdAt: Date | number,
  kind: DataKind = "observation"
): boolean {
  return calculateTrust(createdAt, kind) < STALE_THRESHOLD;
}

/**
 * Format a trust score as a human-readable indicator.
 */
export function trustIndicator(trust: number): string {
  if (trust >= 0.8) return "FRESH";
  if (trust >= 0.5) return "OK";
  if (trust >= STALE_THRESHOLD) return "AGING";
  return "STALE";
}

/**
 * Annotate a list of notes with trust scores.
 * Each note needs an `id`, `text`, and `created_at` (unix timestamp).
 */
export function annotateWithTrust(
  items: Array<{ id: number; text: string; created_at: number }>,
  kind: DataKind = "observation"
): string {
  if (items.length === 0) return "No items.";

  return items
    .map((item) => {
      const trust = calculateTrust(item.created_at, kind);
      const indicator = trustIndicator(trust);
      const date = new Date(item.created_at * 1000).toLocaleDateString("fr-CA");
      const staleWarning = trust < STALE_THRESHOLD ? " ⚠️ STALE — may be outdated" : "";
      return `#${item.id} [${indicator} ${Math.round(trust * 100)}%] (${date})${staleWarning}\n  ${item.text}`;
    })
    .join("\n");
}

/**
 * Get a freshness summary for the system prompt.
 * Warns about stale data categories.
 */
export function getFreshnessSummary(
  noteCount: number,
  oldestNoteAge: number // unix timestamp of oldest note
): string {
  if (noteCount === 0) return "";

  const oldestTrust = calculateTrust(oldestNoteAge, "observation");
  if (oldestTrust >= STALE_THRESHOLD) return ""; // all fresh enough

  const staleCount = Math.round(noteCount * (1 - oldestTrust)); // rough estimate
  return `Note: ~${staleCount} notes may be stale. Use notes.list to review freshness scores.`;
}
