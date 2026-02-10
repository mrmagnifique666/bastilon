/**
 * Model selector — picks the right model tier based on task context.
 *
 * Tiers:
 *   ollama — local: heartbeats, greetings, trivial status checks (free, instant)
 *   haiku  — fast: agent tasks, simple routing
 *   sonnet — balanced: most interactions, analysis, tool chain follow-ups
 *   opus   — premium: content creation, strategic thinking, complex reasoning
 */
import { config } from "../config/env.js";
import { log } from "../utils/log.js";

export type ModelTier = "ollama" | "haiku" | "sonnet" | "opus";

export function getModelId(tier: ModelTier): string {
  switch (tier) {
    case "ollama": return config.ollamaModel;
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
  context: "user" | "scheduler" | "tool_followup" = "user"
): ModelTier {
  // Explicit override: [MODEL:opus], [MODEL:haiku], [MODEL:sonnet], [MODEL:ollama]
  const override = message.match(/\[MODEL:(ollama|haiku|sonnet|opus)\]/i);
  if (override) {
    const tier = override[1].toLowerCase() as ModelTier;
    log.debug(`[model] Explicit override: ${tier}`);
    return tier;
  }

  // Tool chain follow-ups — use sonnet for better reasoning ($0 on Max plan)
  if (context === "tool_followup") {
    return "sonnet";
  }

  // Agent tasks — Ollama-first when enabled (local, free, 24/7 with tools)
  if (message.startsWith("[AGENT:")) {
    // Complex agent tasks still go to Sonnet for best quality
    if (/weekly.*deep.*dive|alpha.*report|proactive.*fix|effectiveness.*review/i.test(message)) return "sonnet";
    // All other agent tasks → Ollama with tool chain (when enabled)
    if (config.ollamaEnabled) {
      log.debug(`[model] Agent task → ollama (Ollama-first architecture)`);
      return "ollama";
    }
    // Ollama disabled → fallback to haiku (backward compatible)
    return "haiku";
  }

  // Scheduler events
  if (context === "scheduler" || message.startsWith("[SCHEDULER]") || message.startsWith("[HEARTBEAT")) {
    // Heartbeat checks, stability → ollama if enabled
    if (config.ollamaEnabled && /heartbeat|stability/i.test(message)) {
      log.debug(`[model] Scheduler heartbeat → ollama`);
      return "ollama";
    }
    if (/digest/i.test(message)) return "haiku";
    return "sonnet";
  }

  // Very short greetings → ollama if enabled (< 40 chars, simple pattern)
  const greetingPatterns = /^(bonjour|salut|hey|hi|ok|merci|thanks|ça va|parfait|super|cool|bye|bonne nuit|good)\s*[!.?]?\s*$/i;
  if (config.ollamaEnabled && greetingPatterns.test(message.trim()) && message.length < 40) {
    log.debug(`[model] Short greeting → ollama`);
    return "ollama";
  }

  // Simple/short messages → sonnet (still capable but faster than opus)
  const simplePatterns = /^(bonjour|salut|hey|hi|ok|oui|non|merci|thanks|ça va|parfait|super|cool|bye|bonne nuit|good)\b/i;
  if (simplePatterns.test(message.trim()) && message.length < 80) {
    log.debug(`[model] Simple message detected → sonnet`);
    return "sonnet";
  }

  // Questions about status, time, weather, simple facts → sonnet
  const factualPatterns = /\b(quelle heure|what time|météo|weather|ping|status|combien|how many|quel jour|what day)\b/i;
  if (factualPatterns.test(message) && message.length < 150) {
    log.debug(`[model] Factual query detected → sonnet`);
    return "sonnet";
  }

  // Default: opus (best reasoning for production user interactions)
  log.debug(`[model] User message → opus`);
  return "opus";
}

/**
 * Get a human-readable label for logging.
 */
export function modelLabel(tier: ModelTier): string {
  const labels: Record<ModelTier, string> = {
    ollama: "🦙",
    haiku: "💨",
    sonnet: "🎵",
    opus: "🎼",
  };
  return `${labels[tier]} ${tier}`;
}
