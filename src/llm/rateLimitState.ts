/**
 * Shared rate-limit state for Claude CLI.
 * Used by both the router (user messages) and agents.
 * When Claude is rate-limited, callers should fall back to Gemini/Ollama.
 *
 * Self-healing: instead of blocking for 2h blindly, the router probes
 * Claude every PROBE_INTERVAL_MS to check if credits were added.
 */
import { log } from "../utils/log.js";

let rateLimitUntil = 0;
let lastProbeAt = 0;

/** Probe interval: try Claude every 5 minutes during rate limit */
const PROBE_INTERVAL_MS = 5 * 60_000;

/** Is Claude CLI currently rate-limited? */
export function isClaudeRateLimited(): boolean {
  return Date.now() < rateLimitUntil;
}

/** Get the timestamp when the rate limit resets */
export function getClaudeRateLimitReset(): number {
  return rateLimitUntil;
}

/** Remaining minutes until rate limit resets (0 if not limited) */
export function rateLimitRemainingMinutes(): number {
  if (!isClaudeRateLimited()) return 0;
  return Math.round((rateLimitUntil - Date.now()) / 60_000);
}

/**
 * Should we probe Claude to check if the rate limit has lifted?
 * Returns true every PROBE_INTERVAL_MS during an active rate limit,
 * allowing the router to try Claude and auto-recover if credits were added.
 */
export function shouldProbeRateLimit(): boolean {
  if (!isClaudeRateLimited()) return false;
  return Date.now() - lastProbeAt >= PROBE_INTERVAL_MS;
}

/** Mark that we just tried a probe (prevents spamming Claude) */
export function markProbeAttempt(): void {
  lastProbeAt = Date.now();
}

/** Manually clear the rate limit (e.g. after a successful Claude call) */
export function clearRateLimit(): void {
  if (rateLimitUntil > 0) {
    log.info("[rate-limit] Rate limit cleared — Claude CLI is available again");
    rateLimitUntil = 0;
    lastProbeAt = 0;
  }
}

/**
 * Check text for rate-limit indicators and set the global state if found.
 * Returns true if a rate limit was detected.
 *
 * Detected patterns:
 *   - "You've hit your limit · resets Xam/pm (TZ)"
 *   - "Credit balance is too low"
 *   - "rate limit" / "rate_limit"
 *   - Claude CLI exit with no useful output + stderr containing rate info
 */
export function detectAndSetRateLimit(text: string): boolean {
  if (!text) return false;

  // Fast negative check
  if (!/hit your limit|rate.?limit|credit balance is too low|usage cap|too many requests/i.test(text)) {
    return false;
  }

  // Try to parse the reset time from the message
  const match = text.match(/resets?\s+(\d{1,2})(am|pm)\s*\(([^)]+)\)/i);
  if (match) {
    const hour = parseInt(match[1]);
    const isPm = match[2].toLowerCase() === "pm";
    const tz = match[3];
    const resetHour = isPm && hour !== 12 ? hour + 12 : !isPm && hour === 12 ? 0 : hour;

    try {
      const now = new Date();
      const formatter = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        hour: "numeric",
        hour12: false,
      });
      const currentHour = Number(formatter.formatToParts(now).find((p) => p.type === "hour")!.value);

      let hoursUntilReset = resetHour - currentHour;
      if (hoursUntilReset <= 0) hoursUntilReset += 24;

      rateLimitUntil = Date.now() + hoursUntilReset * 3600_000;
      log.warn(`[rate-limit] Claude rate-limited — resets in ${hoursUntilReset}h (${new Date(rateLimitUntil).toISOString()})`);
    } catch {
      // Timezone parsing failed — fallback to 2h
      rateLimitUntil = Date.now() + 2 * 3600_000;
      log.warn("[rate-limit] Claude rate-limited — pausing for 2h (TZ parse failed)");
    }
  } else {
    // No parseable reset time — fallback to 2 hours
    rateLimitUntil = Date.now() + 2 * 3600_000;
    log.warn("[rate-limit] Claude rate-limited — pausing for 2h (no reset time found)");
  }

  return true;
}
