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
import { getSummary } from "../storage/store.js";
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

  // Very short greetings → ollama (if enabled) → groq (if available) → sonnet
  const greetingPatterns = /^(bonjour|salut|hey|hi|ok|merci|thanks|ça va|parfait|super|cool|bye|bonne nuit|good)\s*[!.?]?\s*$/i;
  if (greetingPatterns.test(message.trim()) && message.length < 40) {
    if (config.ollamaEnabled) {
      log.debug(`[model] Short greeting → ollama`);
      return "ollama";
    }
    if (config.groqApiKey) {
      log.debug(`[model] Short greeting → groq (ollama disabled)`);
      return "groq";
    }
  }

  // Reflection keywords → opus (even for short messages)
  const reflectionPatterns = /\b(pourquoi|comment ça marche|explique|explain|why|how does|réfléchis|think about|analyse ça|what do you think)\b/i;
  if (reflectionPatterns.test(message)) {
    log.debug(`[model] Reflection question → opus`);
    return "opus";
  }

  // Deep conversation: long summary + substantial message → opus
  if (chatId && message.length > 80) {
    try {
      const summary = getSummary(chatId);
      if (summary?.summary && summary.summary.length > 500) {
        log.debug(`[model] Deep conversation (summary ${summary.summary.length} chars + msg ${message.length} chars) → opus`);
        return "opus";
      }
    } catch { /* no summary */ }
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

  // Short/medium messages and direct commands → sonnet (fast, capable)
  if (message.length < 150) {
    log.debug(`[model] Short message (<150 chars) → sonnet`);
    return "sonnet";
  }

  // Complex tasks requiring deep reasoning → opus
  const complexPatterns = /\b(analyse|analyze|stratégie|strategy|rédige|write|rédaction|plan|compare|évalue|evaluate|refactor|architecture|design|explain|explique)\b/i;
  if (complexPatterns.test(message) || message.length > 500) {
    log.debug(`[model] Complex/long message → opus`);
    return "opus";
  }

  // Default: sonnet (good balance of speed + quality)
  log.debug(`[model] User message → sonnet`);
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
