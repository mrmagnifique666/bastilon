/**
 * Model selector — picks the right model tier based on task context.
 *
 * Tiers (pyramid, cheapest first):
 *   ollama     — local 14B: heartbeats, greetings, agent tool chains (free, instant)
 *   groq       — cloud 70B: text-only fallback for greetings/heartbeats (free, fast)
 *   openrouter — unified gateway: 100+ models, free tiers (DeepSeek R1, Llama 405B)
 *   haiku      — fast: agent fallback, simple routing
 *   sonnet     — balanced: most interactions, analysis, tool chain follow-ups
 *   opus       — premium: content creation, strategic thinking, complex reasoning
 */
import { config } from "../config/env.js";
import { log } from "../utils/log.js";
import { isProviderHealthy, type FailoverProvider } from "./failover.js";

export type ModelTier = "ollama" | "groq" | "openrouter" | "haiku" | "sonnet" | "opus";

export function getModelId(tier: ModelTier): string {
  switch (tier) {
    case "ollama": return config.ollamaModel;
    case "groq": return config.groqModel;
    case "openrouter": return config.openrouterModel;
    case "haiku": return config.claudeModelHaiku;
    case "sonnet": return config.claudeModelSonnet;
    case "opus": return config.claudeModelOpus;
  }
}

/** Map model tiers to their failover provider for health checks */
const TIER_TO_PROVIDER: Record<ModelTier, FailoverProvider> = {
  ollama: "ollama",
  groq: "groq",
  openrouter: "openrouter",
  haiku: "claude",
  sonnet: "claude",
  opus: "claude",
};

/**
 * Check if a model tier's provider is healthy.
 * If not, log the skip and return false.
 */
function isTierHealthy(tier: ModelTier): boolean {
  const provider = TIER_TO_PROVIDER[tier];
  if (isProviderHealthy(provider)) return true;
  log.debug(`[model] Skipping ${tier} — provider ${provider} is in cooldown`);
  return false;
}

/**
 * Select the best model tier for a given message and context.
 * Automatically skips providers that are in cooldown (auth errors, rate limits, etc.).
 */
export function selectModel(
  message: string,
  context: "user" | "scheduler" | "tool_followup" = "user",
  chatId?: number
): ModelTier {
  // Explicit override: [MODEL:opus], [MODEL:haiku], [MODEL:sonnet], [MODEL:ollama]
  const override = message.match(/\[MODEL:(ollama|groq|openrouter|haiku|sonnet|opus)\]/i);
  if (override) {
    const tier = override[1].toLowerCase() as ModelTier;
    log.debug(`[model] Explicit override: ${tier}`);
    // Respect explicit overrides even if unhealthy — user knows what they're doing
    return tier;
  }

  // Tool chain follow-ups — use sonnet for better reasoning ($0 on Max plan)
  if (context === "tool_followup") {
    return isTierHealthy("sonnet") ? "sonnet" : "haiku";
  }

  // Agent tasks — Haiku-first (reliable tool calls, $0 on Max plan)
  // Ollama qwen3:14b was causing crash loops due to malformed tool args
  if (message.startsWith("[AGENT:")) {
    if (isTierHealthy("haiku")) {
      log.debug(`[model] Agent task → haiku (reliable tool calls)`);
      return "haiku";
    }
    // Haiku down → try ollama as fallback
    if (config.ollamaEnabled && isTierHealthy("ollama")) {
      log.debug(`[model] Agent task → ollama (haiku down)`);
      return "ollama";
    }
    // Both down → try groq
    if (config.groqApiKey && isTierHealthy("groq")) {
      log.debug(`[model] Agent task → groq (haiku+ollama down)`);
      return "groq";
    }
    return "haiku"; // return haiku anyway — router will handle the failure
  }

  // Scheduler events — Haiku for tool-heavy tasks, Ollama for simple ones
  if (context === "scheduler" || message.startsWith("[SCHEDULER]") || message.startsWith("[HEARTBEAT")) {
    // Heartbeats are simple — ollama is fine
    if (message.startsWith("[HEARTBEAT") && config.ollamaEnabled && isTierHealthy("ollama")) {
      log.debug(`[model] Heartbeat → ollama (simple, no tools)`);
      return "ollama";
    }
    // Everything else → Haiku (reliable tool calls)
    if (isTierHealthy("haiku")) {
      log.debug(`[model] Scheduler task → haiku (reliable tool calls)`);
      return "haiku";
    }
    // Haiku down → fallback chain
    if (config.ollamaEnabled && isTierHealthy("ollama")) {
      log.debug(`[model] Scheduler task → ollama (haiku down)`);
      return "ollama";
    }
    if (config.groqApiKey && isTierHealthy("groq")) {
      log.debug(`[model] Scheduler task → groq (haiku+ollama down)`);
      return "groq";
    }
    return "haiku";
  }

  // Very short greetings → ollama (instant, local)
  const greetingPatterns = /^(bonjour|salut|hey|hi|ok|merci|thanks|ça va|parfait|super|cool|bye|bonne nuit|good)\s*[!.?]?\s*$/i;
  if (greetingPatterns.test(message.trim()) && message.length < 40) {
    if (config.ollamaEnabled && isTierHealthy("ollama")) {
      log.debug(`[model] Short greeting → ollama`);
      return "ollama";
    }
    if (config.groqApiKey && isTierHealthy("groq")) {
      log.debug(`[model] Short greeting → groq`);
      return "groq";
    }
    if (config.openrouterApiKey && isTierHealthy("openrouter")) {
      log.debug(`[model] Short greeting → openrouter`);
      return "openrouter";
    }
    // All cheap options down — sonnet will handle it
  }

  // Real Telegram users (chatId > 1000) → Opus (deep reasoning, $0 on Max plan)
  // Fallback: Opus → Sonnet → Haiku
  if (chatId && chatId > 1000) {
    if (isTierHealthy("opus")) {
      log.debug(`[model] User message → opus (default for real users)`);
      return "opus";
    }
    log.warn(`[model] Opus unhealthy for user — falling back to sonnet`);
    if (isTierHealthy("sonnet")) return "sonnet";
    log.warn(`[model] Sonnet also unhealthy — falling back to haiku`);
  }

  // Everything else → Sonnet (tool chain follow-ups, dashboard, internal)
  if (isTierHealthy("sonnet")) {
    log.debug(`[model] User message → sonnet (Claude streaming)`);
    return "sonnet";
  }

  // Claude down — return sonnet anyway, router's fallbackWithoutClaude handles it
  log.warn(`[model] Claude unhealthy — user message will go through fallback chain`);
  return "sonnet";
}

/**
 * Get a human-readable label for logging.
 */
export function modelLabel(tier: ModelTier): string {
  const labels: Record<ModelTier, string> = {
    ollama: "🦙",
    groq: "⚡",
    openrouter: "🌐",
    haiku: "💨",
    sonnet: "🎵",
    opus: "🎼",
  };
  return `${labels[tier]} ${tier}`;
}
