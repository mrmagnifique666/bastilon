/**
 * Model selector — picks the right model tier based on task context.
 *
 * Tiers (pyramid, cheapest first):
 *   ollama — local 14B: heartbeats, greetings, agent tool chains (free, instant)
 *   groq   — cloud 70B: text-only fallback for greetings/heartbeats (free, fast)
 *   haiku  — fast: agent fallback, simple routing
 *   sonnet — balanced: most interactions, analysis, tool chain follow-ups
 *   opus   — premium: content creation, strategic thinking, complex reasoning
 */
import { config } from "../config/env.js";
import { log } from "../utils/log.js";

export type ModelTier = "ollama" | "groq" | "haiku" | "sonnet" | "opus";

export function getModelId(tier: ModelTier): string {
  switch (tier) {
    case "ollama": return config.ollamaModel;
    case "groq": return config.groqModel;
    case "haiku": return config.claudeModelHaiku;
    case "sonnet": return config.claudeModelSonnet;
    case "opus": return config.claudeModelOpus;
  }
}

/**
 * Select the best model tier for a given message and context.
 */
export function selectModel(
  message: string,
  context: "user" | "scheduler" | "tool_followup" = "user",
  chatId?: number
): ModelTier {
  // Explicit override: [MODEL:opus], [MODEL:haiku], [MODEL:sonnet], [MODEL:ollama]
  const override = message.match(/\[MODEL:(ollama|groq|haiku|sonnet|opus)\]/i);
  if (override) {
    const tier = override[1].toLowerCase() as ModelTier;
    log.debug(`[model] Explicit override: ${tier}`);
    return tier;
  }

  // Tool chain follow-ups — use sonnet for better reasoning ($0 on Max plan)
  if (context === "tool_followup") {
    return "sonnet";
  }

  // Agent tasks — ALL go to Ollama when enabled (local, free, 24/7 with tools)
  if (message.startsWith("[AGENT:")) {
    if (config.ollamaEnabled) {
      log.debug(`[model] Agent task → ollama (Ollama-first architecture)`);
      return "ollama";
    }
    // Ollama disabled → fallback to haiku (backward compatible)
    return "haiku";
  }

  // Scheduler events — ALL go to Ollama (free, local) when enabled
  if (context === "scheduler" || message.startsWith("[SCHEDULER]") || message.startsWith("[HEARTBEAT")) {
    if (config.ollamaEnabled) {
      log.debug(`[model] Scheduler task → ollama`);
      return "ollama";
    }
    log.debug(`[model] Scheduler task → haiku (ollama disabled)`);
    return "haiku";
  }

  // Very short greetings → ollama (instant, local)
  const greetingPatterns = /^(bonjour|salut|hey|hi|ok|merci|thanks|ça va|parfait|super|cool|bye|bonne nuit|good)\s*[!.?]?\s*$/i;
  if (greetingPatterns.test(message.trim()) && message.length < 40) {
    if (config.ollamaEnabled) {
      log.debug(`[model] Short greeting → ollama`);
      return "ollama";
    }
    if (config.groqApiKey) {
      log.debug(`[model] Short greeting → groq`);
      return "groq";
    }
  }

  // Opus only via explicit [MODEL:opus] override — never auto-selected
  // Groq handles everything else fast and free

  // Everything else → Groq (fast, free, with tools) → fallback to sonnet if Groq unavailable
  if (config.groqApiKey) {
    log.debug(`[model] User message → groq (fast, $0)`);
    return "groq";
  }

  // Groq not available — use sonnet
  log.debug(`[model] User message → sonnet (groq unavailable)`);
  return "sonnet";
}

/**
 * Get a human-readable label for logging.
 */
export function modelLabel(tier: ModelTier): string {
  const labels: Record<ModelTier, string> = {
    ollama: "🦙",
    groq: "⚡",
    haiku: "💨",
    sonnet: "🎵",
    opus: "🎼",
  };
  return `${labels[tier]} ${tier}`;
}
