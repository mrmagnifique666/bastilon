/**
 * Provider Cooldown Tracker — generic rate-limit cooldown for all LLM providers.
 * When a provider fails (429, timeout, error), it enters cooldown.
 * The fallback chain skips providers in cooldown to avoid wasting time.
 *
 * Different from rateLimitState.ts which handles Claude-specific parsing.
 * This is a lightweight Map-based tracker for Gemini, Groq, Ollama.
 */
import { log } from "../utils/log.js";

export type Provider = "gemini" | "groq" | "ollama";

interface CooldownEntry {
  until: number;
  reason: string;
  failures: number;
}

const cooldowns = new Map<Provider, CooldownEntry>();

/** Default cooldown durations (ms) — escalates with consecutive failures */
const BASE_COOLDOWN_MS: Record<Provider, number> = {
  gemini: 60_000,    // 1 min (has its own retry logic)
  groq: 60_000,      // 1 min
  ollama: 30_000,    // 30s (local, usually comes back fast)
};

const MAX_COOLDOWN_MS = 15 * 60_000; // 15 min cap

/** Check if a provider is currently in cooldown */
export function isProviderCoolingDown(provider: Provider): boolean {
  const entry = cooldowns.get(provider);
  if (!entry) return false;
  if (Date.now() >= entry.until) {
    cooldowns.delete(provider);
    return false;
  }
  return true;
}

/** Get remaining cooldown seconds for a provider (0 if not cooling) */
export function providerCooldownSeconds(provider: Provider): number {
  const entry = cooldowns.get(provider);
  if (!entry) return 0;
  const remaining = Math.max(0, entry.until - Date.now());
  return Math.round(remaining / 1000);
}

/**
 * Mark a provider as rate-limited / unavailable.
 * Uses exponential backoff: base * 2^(failures-1), capped at MAX_COOLDOWN_MS.
 */
export function markProviderCooldown(provider: Provider, reason: string): void {
  const existing = cooldowns.get(provider);
  const failures = (existing?.failures ?? 0) + 1;
  const base = BASE_COOLDOWN_MS[provider];
  const duration = Math.min(base * Math.pow(2, failures - 1), MAX_COOLDOWN_MS);

  cooldowns.set(provider, {
    until: Date.now() + duration,
    reason,
    failures,
  });

  log.warn(`[cooldown] ${provider} cooling down ${Math.round(duration / 1000)}s (${reason}, failures: ${failures})`);
}

/** Clear cooldown after a successful call */
export function clearProviderCooldown(provider: Provider): void {
  if (cooldowns.has(provider)) {
    log.info(`[cooldown] ${provider} recovered — cooldown cleared`);
    cooldowns.delete(provider);
  }
}

/** Get status of all providers for monitoring */
export function getCooldownStatus(): Record<Provider, { active: boolean; secondsLeft: number; reason: string }> {
  const providers: Provider[] = ["gemini", "groq", "ollama"];
  const result = {} as Record<Provider, { active: boolean; secondsLeft: number; reason: string }>;
  for (const p of providers) {
    const entry = cooldowns.get(p);
    if (entry && Date.now() < entry.until) {
      result[p] = { active: true, secondsLeft: Math.round((entry.until - Date.now()) / 1000), reason: entry.reason };
    } else {
      result[p] = { active: false, secondsLeft: 0, reason: "" };
    }
  }
  return result;
}
