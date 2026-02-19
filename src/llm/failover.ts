/**
 * Error classification + intelligent provider health tracking.
 *
 * Replaces the blind "3 errors = disable" pattern with nuanced handling:
 *   - auth_error (organization_restricted, invalid key) => 4h cooldown, no agent penalty
 *   - rate_limit (429, quota exceeded) => 30min cooldown after 5 in 10min
 *   - timeout (ETIMEOUT, ECONNRESET, stall) => 15min cooldown after 3
 *   - empty_response (null/empty from model) => 10min cooldown after 5
 *   - context_overflow (context too long) => no cooldown, caller should trim
 *   - billing (payment required) => 4h cooldown (same as auth)
 *   - transient (500/502/503, network blip) => 5min cooldown after 3
 *
 * Usage:
 *   import { classifyError, recordFailure, isProviderHealthy } from "./failover.js";
 *   try { ... } catch (err) {
 *     const cls = classifyError(err);
 *     recordFailure("groq", cls);
 *     if (!isProviderHealthy("groq")) { // skip groq }
 *   }
 */
import { log } from "../utils/log.js";

// ── Types ──

export type ErrorClass =
  | "auth_error"
  | "rate_limit"
  | "timeout"
  | "empty_response"
  | "context_overflow"
  | "billing"
  | "transient"
  | "unknown";

export type FailoverProvider = "ollama" | "groq" | "gemini" | "claude";

interface FailureRecord {
  errorClass: ErrorClass;
  timestamp: number;
}

interface ProviderHealth {
  failures: FailureRecord[];
  cooldownUntil: number;
  cooldownReason: string;
}

// ── State ──

const health = new Map<FailoverProvider, ProviderHealth>();

function getOrCreate(provider: FailoverProvider): ProviderHealth {
  let h = health.get(provider);
  if (!h) {
    h = { failures: [], cooldownUntil: 0, cooldownReason: "" };
    health.set(provider, h);
  }
  return h;
}

// ── Cooldown configuration ──

/** How many failures of each class before triggering cooldown */
const COOLDOWN_THRESHOLDS: Record<ErrorClass, { count: number; windowMs: number; cooldownMs: number }> = {
  auth_error:        { count: 3,  windowMs: Infinity,   cooldownMs: 4 * 3600_000 },  // 3 auth errors ever => 4h
  rate_limit:        { count: 5,  windowMs: 10 * 60_000, cooldownMs: 30 * 60_000 },   // 5 in 10min => 30min
  timeout:           { count: 3,  windowMs: 15 * 60_000, cooldownMs: 15 * 60_000 },   // 3 in 15min => 15min
  empty_response:    { count: 5,  windowMs: 30 * 60_000, cooldownMs: 10 * 60_000 },   // 5 in 30min => 10min
  context_overflow:  { count: 999, windowMs: 60_000,     cooldownMs: 0 },              // never triggers cooldown
  billing:           { count: 1,  windowMs: Infinity,   cooldownMs: 4 * 3600_000 },  // 1 billing error => 4h
  transient:         { count: 3,  windowMs: 5 * 60_000,  cooldownMs: 5 * 60_000 },    // 3 in 5min => 5min
  unknown:           { count: 5,  windowMs: 10 * 60_000, cooldownMs: 5 * 60_000 },    // 5 in 10min => 5min
};

// ── Error classification ──

/** Regex patterns for each error class, ordered from most specific to least */
const AUTH_PATTERNS = [
  /organization.?restricted/i,
  /invalid.?api.?key/i,
  /unauthorized/i,
  /authentication/i,
  /invalid.?auth/i,
  /forbidden.*key/i,
  /api.?key.*invalid/i,
  /permission.?denied/i,
  /access.?denied/i,
  / 401[ :]/,
  / 403[ :]/,
];

const RATE_LIMIT_PATTERNS = [
  /too many requests/i,
  /rate.?limit/i,
  /quota.?exceeded/i,
  /usage.?cap/i,
  /hit your limit/i,
  /requests? per (min|sec|hour|day)/i,
  / 429[ :]/,
];

const TIMEOUT_PATTERNS = [
  /timed?\s*out/i,
  /ETIMEDOUT/,
  /ECONNRESET/,
  /ECONNREFUSED/,
  /ENOTFOUND/,
  /socket hang up/i,
  /network.?error/i,
  /request.?aborted/i,
  /abort/i,
  /stalled/i,
  /safety.?timeout/i,
];

const EMPTY_PATTERNS = [
  /empty.?response/i,
  /no.?content/i,
  /returned.?empty/i,
  /empty.?stdout/i,
  /no.?message/i,
  /null.?response/i,
];

const CONTEXT_PATTERNS = [
  /context.?too.?long/i,
  /max.?tokens?.?exceeded/i,
  /context.?length/i,
  /token.?limit/i,
  /input.?too.?long/i,
  /maximum.?context/i,
  /prompt.?too.?long/i,
];

const BILLING_PATTERNS = [
  /payment.?required/i,
  /credit.?balance.*too.?low/i,
  /billing/i,
  /insufficient.?funds/i,
  /subscription/i,
  / 402[ :]/,
];

const TRANSIENT_PATTERNS = [
  /internal.?server.?error/i,
  /bad.?gateway/i,
  /service.?unavailable/i,
  /temporarily.?unavailable/i,
  / 500[ :]/,
  / 502[ :]/,
  / 503[ :]/,
  / 504[ :]/,
  /overloaded/i,
  /capacity/i,
];

/**
 * Classify an error into a category.
 * Accepts Error objects, strings, or anything with a message property.
 */
export function classifyError(error: Error | string | unknown): ErrorClass {
  const msg = typeof error === "string"
    ? error
    : error instanceof Error
      ? `${error.message} ${(error as any).code || ""}`
      : String(error);

  // Order matters: more specific patterns first
  for (const p of AUTH_PATTERNS) if (p.test(msg)) return "auth_error";
  for (const p of BILLING_PATTERNS) if (p.test(msg)) return "billing";
  for (const p of RATE_LIMIT_PATTERNS) if (p.test(msg)) return "rate_limit";
  for (const p of CONTEXT_PATTERNS) if (p.test(msg)) return "context_overflow";
  for (const p of EMPTY_PATTERNS) if (p.test(msg)) return "empty_response";
  for (const p of TIMEOUT_PATTERNS) if (p.test(msg)) return "timeout";
  for (const p of TRANSIENT_PATTERNS) if (p.test(msg)) return "transient";

  return "unknown";
}

// ── Failure recording ──

/**
 * Record a failure for a provider. Automatically manages cooldowns.
 * Returns true if the provider entered cooldown as a result.
 */
export function recordFailure(provider: FailoverProvider, errorClass: ErrorClass): boolean {
  const h = getOrCreate(provider);
  const now = Date.now();

  h.failures.push({ errorClass, timestamp: now });

  // Prune old failures (keep last 60 minutes only)
  const cutoff = now - 60 * 60_000;
  h.failures = h.failures.filter(f => f.timestamp > cutoff);

  // Check if this error class triggers a cooldown
  const config = COOLDOWN_THRESHOLDS[errorClass];
  if (!config || config.cooldownMs === 0) return false;

  // Count recent failures of this class within the window
  const windowStart = config.windowMs === Infinity ? 0 : now - config.windowMs;
  const recentCount = h.failures.filter(
    f => f.errorClass === errorClass && f.timestamp >= windowStart
  ).length;

  if (recentCount >= config.count) {
    h.cooldownUntil = now + config.cooldownMs;
    h.cooldownReason = `${recentCount}x ${errorClass} in ${config.windowMs === Infinity ? "total" : Math.round(config.windowMs / 60_000) + "min"}`;

    const cooldownMin = Math.round(config.cooldownMs / 60_000);
    log.warn(
      `[failover] ${provider} entering ${cooldownMin}min cooldown: ${h.cooldownReason}`
    );

    return true;
  }

  return false;
}

// ── Health checks ──

/**
 * Check if a provider is healthy (not in cooldown).
 * Returns true if the provider can be used.
 */
export function isProviderHealthy(provider: FailoverProvider): boolean {
  const h = health.get(provider);
  if (!h) return true; // no data = healthy
  if (h.cooldownUntil <= Date.now()) {
    // Cooldown expired — clear it
    if (h.cooldownUntil > 0) {
      log.info(`[failover] ${provider} cooldown expired — marking healthy`);
      h.cooldownUntil = 0;
      h.cooldownReason = "";
      h.failures = []; // reset failures on recovery
    }
    return true;
  }
  return false;
}

/**
 * Get list of healthy providers (not in cooldown).
 */
export function getHealthyProviders(): FailoverProvider[] {
  const all: FailoverProvider[] = ["ollama", "groq", "gemini", "claude"];
  return all.filter(p => isProviderHealthy(p));
}

/**
 * Get full status of all providers for monitoring/dashboard.
 */
export function providerStatus(): Record<FailoverProvider, {
  healthy: boolean;
  failures: number;
  cooldownUntil: number | null;
  cooldownReason: string;
  recentErrors: Array<{ class: ErrorClass; ago: string }>;
}> {
  const all: FailoverProvider[] = ["ollama", "groq", "gemini", "claude"];
  const now = Date.now();
  const result = {} as ReturnType<typeof providerStatus>;

  for (const p of all) {
    const h = health.get(p);
    if (!h) {
      result[p] = {
        healthy: true,
        failures: 0,
        cooldownUntil: null,
        cooldownReason: "",
        recentErrors: [],
      };
      continue;
    }

    const healthy = isProviderHealthy(p);
    const recentErrors = h.failures.slice(-5).map(f => ({
      class: f.errorClass,
      ago: formatAgo(now - f.timestamp),
    }));

    result[p] = {
      healthy,
      failures: h.failures.length,
      cooldownUntil: h.cooldownUntil > now ? h.cooldownUntil : null,
      cooldownReason: h.cooldownUntil > now ? h.cooldownReason : "",
      recentErrors,
    };
  }

  return result;
}

/**
 * Clear a provider's health state. Called on successful response.
 */
export function clearProviderFailures(provider: FailoverProvider): void {
  const h = health.get(provider);
  if (h) {
    if (h.cooldownUntil > 0 || h.failures.length > 0) {
      log.info(`[failover] ${provider} success — clearing ${h.failures.length} failures`);
    }
    h.failures = [];
    h.cooldownUntil = 0;
    h.cooldownReason = "";
  }
}

/**
 * Determine if an error class should penalize the agent (increment consecutiveErrors).
 * Returns true if the error is the AGENT's fault or truly unrecoverable.
 * Returns false if the error is a provider issue that the agent can't control.
 */
export function shouldPenalizeAgent(errorClass: ErrorClass): boolean {
  switch (errorClass) {
    // Provider-side issues: don't blame the agent
    case "auth_error":
    case "rate_limit":
    case "timeout":
    case "billing":
    case "transient":
      return false;

    // These might indicate a problem with the agent's request
    case "empty_response":
    case "context_overflow":
    case "unknown":
      return true;
  }
}

/**
 * Infer which provider likely caused an error based on the error message.
 * Used when the caller doesn't know which provider failed (e.g., router catch blocks).
 */
export function inferProvider(errorMsg: string): FailoverProvider | null {
  const lower = errorMsg.toLowerCase();
  if (lower.includes("ollama") || lower.includes("localhost:11434")) return "ollama";
  if (lower.includes("groq") || lower.includes("groq.com")) return "groq";
  if (lower.includes("gemini") || lower.includes("generativelanguage")) return "gemini";
  if (lower.includes("claude") || lower.includes("anthropic")) return "claude";
  return null;
}

// ── Helpers ──

function formatAgo(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3600_000) return `${Math.round(ms / 60_000)}min ago`;
  return `${Math.round(ms / 3600_000)}h ago`;
}
