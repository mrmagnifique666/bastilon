/**
 * Orchestrator / tool router.
 * Receives parsed Claude output, validates tool calls, executes skills,
 * and supports multi-step tool chaining (up to MAX_TOOL_CHAIN iterations).
 */
import { isToolPermitted } from "../security/policy.js";
import { isAdmin } from "../security/policy.js";
import { getSkill, validateArgs, getSkillSchema } from "../skills/loader.js";
import { runClaude } from "../llm/claudeCli.js";
import { runClaudeStream, type StreamResult } from "../llm/claudeStream.js";
import { runGemini, GeminiRateLimitError, GeminiSafetyError } from "../llm/gemini.js";
import { runOllama, runOllamaChat, isOllamaAvailable, runOllamaToolRouter } from "../llm/ollamaClient.js";
import { runGroq, runGroqChat, isGroqAvailable } from "../llm/groqClient.js";
import { runOpenRouter, runOpenRouterChat, isOpenRouterAvailable } from "../llm/openrouterClient.js";
import { addTurn, logError, getTurns, clearSession } from "../storage/store.js";
import { autoCompact } from "./compaction.js";
import { config } from "../config/env.js";
import { log } from "../utils/log.js";
import { extractAndStoreMemories } from "../memory/semantic.js";
import { detectAndLearnFromCorrection } from "../memory/correctionDetector.js";
import { evaluateResponseQuality } from "../memory/qualityGate.js";
import { selectModel, getModelId, modelLabel, type ModelTier } from "../llm/modelSelector.js";
import { isClaudeRateLimited, detectAndSetRateLimit, clearRateLimit, rateLimitRemainingMinutes, shouldProbeRateLimit, markProbeAttempt } from "../llm/rateLimitState.js";
import { isProviderCoolingDown, markProviderCooldown, clearProviderCooldown, providerCooldownSeconds } from "../llm/providerCooldown.js";
import { classifyError, recordFailure, clearProviderFailures, isProviderHealthy } from "../llm/failover.js";
import { emitHook } from "../hooks/hooks.js";
import { isInterrupted, enqueueAdminAsync } from "../bot/chatLock.js";
import { tryParallelDispatch } from "../llm/parallel.js";
import type { DraftController } from "../bot/draftMessage.js";
import { detectMood, getToneInstructions, logMood, setCurrentMoodContext } from "../personality/mood.js";

/**
 * Check if a chatId belongs to an automated/internal session (scheduler, agents, or cron jobs).
 * Scheduler chatId: 1, Agent chatIds: 100-106, Cron chatIds: 200-249
 */
export function isInternalChatId(chatId: number): boolean {
  return chatId === 1 || (chatId >= 100 && chatId <= 107) || (chatId >= 200 && chatId <= 249);
}

function buildGroqSystemPrompt(): string {
  const now = new Date();
  const date = now.toLocaleDateString("fr-CA", { timeZone: "America/Toronto", weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const time = now.toLocaleTimeString("fr-CA", { timeZone: "America/Toronto", hour: "2-digit", minute: "2-digit", hour12: false });
  return [
    "Tu es Kingston, un assistant IA personnel pour Nicolas.",
    `Date: ${date}. Heure: ${time} (heure de l'Est, Gatineau).`,
    "Tu es concis, amical et tu réponds en français par défaut.",
    "Tu ne peux PAS exécuter d'outils — réponds uniquement avec du texte.",
    "Si on te demande quelque chose qui nécessite un outil, dis que tu vas transmettre la demande.",
  ].join(" ");
}

/** Try Groq as text-only fallback. Returns null on failure. */
async function tryGroqFallback(chatId: number, userMessage: string, label: string): Promise<string | null> {
  if (!isGroqAvailable() || !isProviderHealthy("groq")) return null;
  try {
    log.info(`[router] ⚡ Groq fallback (${label}): ${userMessage.slice(0, 100)}...`);
    const result = await runGroq(buildGroqSystemPrompt(), userMessage);
    log.info(`[router] Groq fallback success (${result.length} chars)`);
    clearProviderFailures("groq");
    return result;
  } catch (err) {
    const errClass = classifyError(err);
    recordFailure("groq", errClass);
    log.warn(`[router] Groq fallback failed [${errClass}]: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Fire-and-forget background compaction — runs after response is sent, adds no latency */
function backgroundCompact(chatId: number, userId: number): void {
  const turns = getTurns(chatId);
  if (turns.length <= 20) return;
  log.info(`[router] Background compaction: ${turns.length} turns exceed threshold (20)`);
  autoCompact(chatId, userId).catch(err =>
    log.warn(`[router] Background compaction failed: ${err instanceof Error ? err.message : String(err)}`)
  );
}

/** Fire-and-forget background memory extraction — adds no latency */
function backgroundExtract(chatId: number, userMessage: string, assistantResponse: string): void {
  // Only extract for real user chats, not agents/scheduler/dashboard
  if (chatId <= 1000) return;
  extractAndStoreMemories(chatId, `User: ${userMessage}\nAssistant: ${assistantResponse}`)
    .then(count => { if (count > 0) log.debug(`[memory] Extracted ${count} new memories`); })
    .catch(err => log.warn(`[memory] Extraction failed (possible quota issue): ${err instanceof Error ? err.message : String(err)}`));
  // Detect corrections and auto-create behavioral rules (fire-and-forget)
  detectAndLearnFromCorrection(userMessage, assistantResponse)
    .catch(err => log.debug(`[correction] Detection failed: ${err instanceof Error ? err.message : String(err)}`));
  // Evaluate response quality (fire-and-forget)
  evaluateResponseQuality(chatId, userMessage, assistantResponse)
    .catch(err => log.debug(`[quality] Evaluation failed: ${err instanceof Error ? err.message : String(err)}`));
}

export let progressCallback: ((chatId: number, message: string) => Promise<void>) | null = null;

export function setProgressCallback(cb: (chatId: number, message: string) => Promise<void>) {
  progressCallback = cb;
}

/** Safe progress update — never throws (prevents Telegram API errors from crashing router) */
async function safeProgress(chatId: number, message: string): Promise<void> {
  if (!progressCallback || chatId <= 1000) return;
  try {
    await progressCallback(chatId, message);
  } catch (err) {
    log.warn(`[router] progressCallback failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Check if Gemini should be used for this request */
function shouldUseGemini(chatId: number): boolean {
  // Must be enabled and have API key
  if (!config.geminiOrchestratorEnabled || !config.geminiApiKey) return false;
  // Agents (chatId 100-106) and cron jobs (200-249) always use Ollama-first path
  if (isInternalChatId(chatId)) return false;
  // Real Telegram users (chatId > 1000) go directly to Claude Sonnet — they deserve the best model,
  // not Gemini Flash. Gemini is kept as fallback only (via fallbackWithoutClaude).
  if (chatId > 1000) return false;
  // Dashboard (chatId 2), Emile (chatId 3) can still use Gemini
  return true;
}

/**
 * Fallback chain when Claude CLI is unavailable (rate-limited or down).
 * Tries: Sonnet (if Opus was rate-limited) → Gemini Flash → Ollama-chat → Groq → error.
 * Ensures the bot NEVER goes silent.
 */
async function fallbackWithoutClaude(
  chatId: number,
  userMessage: string,
  userIsAdmin: boolean,
  userId: number,
  remainingMinutes: number,
  rateLimitedModel?: string
): Promise<string> {
  // --- Try Sonnet if it was Opus that got rate-limited (separate quotas on Max plan) ---
  if (rateLimitedModel && rateLimitedModel.includes("opus")) {
    try {
      const sonnetModel = getModelId("sonnet");
      log.info(`[router] 🎵 Trying Sonnet fallback (Opus rate-limited): ${userMessage.slice(0, 100)}...`);
      await safeProgress(chatId, `🎵 Mode Sonnet (Opus indisponible ~${remainingMinutes}min)`);
      const sonnetResult = await runClaude(chatId, userMessage, userIsAdmin, sonnetModel);
      if (sonnetResult.type === "message") {
        if (sonnetResult.text && detectAndSetRateLimit(sonnetResult.text)) {
          log.warn(`[router] Sonnet also rate-limited — continuing to Gemini`);
        } else {
          const text = sonnetResult.text?.trim() || "";
          if (text && !text.includes("(Claude returned an empty response)")) {
            clearRateLimit();
            addTurn(chatId, { role: "assistant", content: text });
            backgroundExtract(chatId, userMessage, text);
            log.info(`[router] Sonnet fallback success (${text.length} chars)`);
            return text;
          }
        }
      } else if (sonnetResult.type === "tool_call") {
        // Sonnet returned a tool call — process it through the normal tool chain
        // This is the best case: we get full tool support from Sonnet when Opus is down
        clearRateLimit();
        log.info(`[router] Sonnet returned tool_call: ${sonnetResult.tool} — processing tool chain`);
        // Store user turn and process tool chain inline
        let result = sonnetResult;
        const sonnetFollowUp = getModelId("sonnet");
        for (let step = 0; step < config.maxToolChain; step++) {
          if (result.type !== "tool_call") break;
          const skill = getSkill(result.tool || "");
          if (!skill || !isToolPermitted(result.tool || "", userId)) {
            const msg = `Tool "${result.tool}" not available.`;
            addTurn(chatId, { role: "assistant", content: msg });
            return msg;
          }
          try {
            const toolResult = await skill.execute((result.args || {}) as Record<string, unknown>);
            const followUp = `[Tool "${result.tool}" résultat]:\n${toolResult}\n\nÉvalue ce résultat et réponds à Nicolas.`;
            addTurn(chatId, { role: "assistant", content: `[called ${result.tool}]` });
            addTurn(chatId, { role: "user", content: followUp });
            result = await runClaude(chatId, followUp, userIsAdmin, sonnetFollowUp);
          } catch (err) {
            const errMsg = `Tool "${result.tool}" failed: ${err instanceof Error ? err.message : String(err)}`;
            addTurn(chatId, { role: "assistant", content: errMsg });
            return errMsg;
          }
        }
        if (result.type === "message") {
          const text = result.text?.trim() || "Tâche terminée.";
          addTurn(chatId, { role: "assistant", content: text });
          backgroundExtract(chatId, userMessage, text);
          return text;
        }
      }
    } catch (err) {
      log.warn(`[router] Sonnet fallback failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // --- Try Gemini Flash (supports full tool chain, $0) ---
  if (config.geminiApiKey && !isProviderCoolingDown("gemini") && isProviderHealthy("gemini")) {
    try {
      log.info(`[router] 🔄 Gemini fallback (Claude down ${remainingMinutes}min): ${userMessage.slice(0, 100)}...`);
      await safeProgress(chatId, `⚡ Mode Gemini (Claude indisponible ~${remainingMinutes}min)`);
      const geminiResult = await runGemini({
        chatId,
        userMessage,
        isAdmin: userIsAdmin,
        userId,
        onToolProgress: async (cid, msg) => safeProgress(cid, msg),
      });
      addTurn(chatId, { role: "assistant", content: geminiResult });
      backgroundExtract(chatId, userMessage, geminiResult);
      clearProviderCooldown("gemini");
      clearProviderFailures("gemini");
      log.info(`[router] Gemini fallback success (${geminiResult.length} chars)`);
      return geminiResult;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const errClass = classifyError(err);
      recordFailure("gemini", errClass);
      if (err instanceof GeminiRateLimitError) markProviderCooldown("gemini", "429 rate limit");
      log.warn(`[router] Gemini fallback also failed [${errClass}]: ${errMsg}`);
    }
  } else if (isProviderCoolingDown("gemini") || !isProviderHealthy("gemini")) {
    log.debug(`[router] Skipping Gemini (cooldown ${providerCooldownSeconds("gemini")}s remaining or failover cooldown)`);
  }

  // --- Try Ollama with tools (local, full tool chain, always available) ---
  if (config.ollamaEnabled && !isProviderCoolingDown("ollama") && isProviderHealthy("ollama")) {
    try {
      const ollamaUp = await isOllamaAvailable();
      if (ollamaUp) {
        log.info(`[router] 🦙 Ollama-chat fallback (Claude+Gemini down): ${userMessage.slice(0, 100)}...`);
        await safeProgress(chatId, `🦙 Mode local avec outils (services cloud indisponibles ~${remainingMinutes}min)`);
        const ollamaResult = await runOllamaChat({
          chatId,
          userMessage,
          isAdmin: userIsAdmin,
          userId,
          onToolProgress: async (cid, msg) => safeProgress(cid, msg),
        });
        addTurn(chatId, { role: "assistant", content: ollamaResult });
        backgroundExtract(chatId, userMessage, ollamaResult);
        clearProviderCooldown("ollama");
        clearProviderFailures("ollama");
        log.info(`[router] Ollama-chat fallback success (${ollamaResult.length} chars)`);
        return ollamaResult;
      } else {
        markProviderCooldown("ollama", "not reachable");
        recordFailure("ollama", "timeout");
      }
    } catch (err) {
      const errClass = classifyError(err);
      recordFailure("ollama", errClass);
      markProviderCooldown("ollama", err instanceof Error ? err.message : "unknown error");
      log.warn(`[router] Ollama-chat fallback failed [${errClass}]: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else if (isProviderCoolingDown("ollama") || !isProviderHealthy("ollama")) {
    log.debug(`[router] Skipping Ollama (cooldown ${providerCooldownSeconds("ollama")}s remaining or failover cooldown)`);
  }

  // --- Try Groq with tools (llama-3.3-70b, $0) ---
  if (isGroqAvailable() && !isProviderCoolingDown("groq") && isProviderHealthy("groq")) {
    try {
      log.info(`[router] ⚡ Groq-chat fallback (Claude+Gemini+Ollama down): ${userMessage.slice(0, 100)}...`);
      await safeProgress(chatId, `⚡ Mode Groq avec outils (services principaux indisponibles ~${remainingMinutes}min)`);
      const groqResult = await runGroqChat({
        chatId,
        userMessage,
        isAdmin: userIsAdmin,
        userId,
        onToolProgress: async (cid, msg) => safeProgress(cid, msg),
      });
      addTurn(chatId, { role: "assistant", content: groqResult });
      backgroundExtract(chatId, userMessage, groqResult);
      clearProviderCooldown("groq");
      clearProviderFailures("groq");
      return groqResult;
    } catch (err) {
      const errClass = classifyError(err);
      recordFailure("groq", errClass);
      markProviderCooldown("groq", err instanceof Error ? err.message : "unknown error");
      log.warn(`[router] Groq-chat fallback failed [${errClass}]: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else if (isProviderCoolingDown("groq") || !isProviderHealthy("groq")) {
    log.debug(`[router] Skipping Groq (cooldown ${providerCooldownSeconds("groq")}s remaining or failover cooldown)`);
  }

  // --- Try OpenRouter with tools (DeepSeek R1 / Llama 405B free, $0) ---
  if (isOpenRouterAvailable() && !isProviderCoolingDown("openrouter") && isProviderHealthy("openrouter")) {
    try {
      log.info(`[router] 🌐 OpenRouter-chat fallback (Claude+Gemini+Ollama+Groq down): ${userMessage.slice(0, 100)}...`);
      await safeProgress(chatId, `🌐 Mode OpenRouter avec outils (services principaux indisponibles ~${remainingMinutes}min)`);
      const orResult = await runOpenRouterChat({
        chatId,
        userMessage,
        isAdmin: userIsAdmin,
        userId,
        onToolProgress: async (cid, msg) => safeProgress(cid, msg),
      });
      addTurn(chatId, { role: "assistant", content: orResult });
      backgroundExtract(chatId, userMessage, orResult);
      clearProviderCooldown("openrouter");
      clearProviderFailures("openrouter");
      return orResult;
    } catch (err) {
      const errClass = classifyError(err);
      recordFailure("openrouter", errClass);
      markProviderCooldown("openrouter", err instanceof Error ? err.message : "unknown error");
      log.warn(`[router] OpenRouter-chat fallback failed [${errClass}]: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else if (isProviderCoolingDown("openrouter") || !isProviderHealthy("openrouter")) {
    log.debug(`[router] Skipping OpenRouter (cooldown ${providerCooldownSeconds("openrouter")}s remaining or failover cooldown)`);
  }

  // --- All models down — return a useful error instead of silence ---
  const msg = `⚠️ Tous les modèles sont temporairement indisponibles. Claude se réinitialise dans ~${remainingMinutes} minutes. Réessaie bientôt.`;
  log.error(`[router] ALL models unavailable — Claude (rate-limited), Gemini (${config.geminiApiKey ? "failed" : "no key"}), Ollama (${config.ollamaEnabled ? "failed" : "disabled"}), Groq (${isGroqAvailable() ? "failed" : "no key"}), OpenRouter (${isOpenRouterAvailable() ? "failed" : "no key"})`);
  addTurn(chatId, { role: "assistant", content: msg });
  return msg;
}

/**
 * Handle a user message end-to-end:
 * 1. Try Gemini (if enabled) — handles tool chain internally
 * 2. On Gemini failure, fall back to Claude CLI with manual tool chain
 * 3. On Claude rate limit, fall back to Gemini → Ollama → error
 * 4. Store turns and return the final text
 */
/**
 * Detect if Kingston promised a future action in his response that wasn't executed.
 * Returns the promised action text, or null if no deferred action found.
 */
function detectDeferredAction(response: string): string | null {
  if (!response || response.length < 20) return null;

  // Don't trigger on self-followups (prevent infinite loops)
  if (response.includes("[SELF-FOLLOWUP]")) return null;

  // Check last 200 chars of response for action promises
  const tail = response.slice(-200).toLowerCase();

  const patterns = [
    /(?:je vais|i'll|i will|let me|laisse-moi|attends?|un moment|donne-moi|give me)\s+(?:créer|create|générer|generate|faire|make|chercher|search|préparer|prepare|envoyer|send|poster|post|scanner|scan|analyser|analyze)/i,
    /(?:give me|donne-moi|attends?)\s+\d+\s*(?:second|minute|sec|min)/i,
    /(?:je m'en occupe|j'y travaille|en cours|working on it|on it)\s*[.!]?\s*$/i,
    /(?:je vais te|i'll send you|je t'envoie ça)\s/i,
  ];

  for (const pattern of patterns) {
    const match = response.slice(-300).match(pattern);
    if (match) {
      // Extract the promise — take from the match to end of response
      const promiseStart = response.lastIndexOf(match[0]);
      const promise = response.slice(promiseStart).trim();
      // Only trigger if the promise is near the END of the response (last 300 chars)
      if (response.length - promiseStart < 300) {
        return promise;
      }
    }
  }

  return null;
}

export async function handleMessage(
  chatId: number,
  userMessage: string,
  userId: number,
  contextHint: "user" | "scheduler" = "user"
): Promise<string> {
  const response = await handleMessageInner(chatId, userMessage, userId, contextHint);
  // Fire-and-forget compaction AFTER response — never blocks the user
  backgroundCompact(chatId, userId);

  // Self-reply: if Kingston promised an action, auto-trigger a follow-up
  if (!isInternalChatId(chatId) && !userMessage.includes("[SELF-FOLLOWUP]")) {
    const deferred = detectDeferredAction(response);
    if (deferred) {
      log.info(`[router] Deferred action detected: "${deferred.slice(0, 80)}..." — scheduling self-followup`);
      setTimeout(() => {
        enqueueAdminAsync(() =>
          handleMessage(
            chatId,
            `[SELF-FOLLOWUP] Tu viens de dire: "${deferred.slice(0, 200)}"\n\nEXÉCUTE cette action MAINTENANT. Utilise les tools nécessaires. Ne répète pas ta promesse — FAIS-LE et envoie le résultat directement.`,
            userId,
            "scheduler"
          )
        ).catch(err => log.warn(`[router] Self-followup failed: ${err}`));
      }, 3000); // 3 second delay
    }
  }

  return response;
}

async function handleMessageInner(
  chatId: number,
  userMessage: string,
  userId: number,
  contextHint: "user" | "scheduler" = "user"
): Promise<string> {
  const userIsAdmin = isAdmin(userId);

  // Mood detection for user messages (not agents/scheduler) — $0 cost heuristics
  if (!isInternalChatId(chatId) && chatId > 10) {
    const mood = detectMood(userMessage);
    logMood(mood, chatId);
    setCurrentMoodContext(getToneInstructions(mood));
  } else {
    setCurrentMoodContext("");
  }

  // Store user turn
  addTurn(chatId, { role: "user", content: userMessage });

  // --- Parallel dispatch (multi-task detection) ---
  if (!isInternalChatId(chatId) && config.groqApiKey) {
    try {
      const parallel = await tryParallelDispatch(
        chatId, userMessage, userId, userIsAdmin,
        async (cid, msg) => safeProgress(cid, msg),
      );
      if (parallel.attempted && parallel.merged) {
        addTurn(chatId, { role: "assistant", content: parallel.merged });
        backgroundExtract(chatId, userMessage, parallel.merged);
        return parallel.merged;
      }
    } catch (err) {
      log.warn(`[router] Parallel dispatch failed, falling through: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // --- Gemini path (primary) ---
  if (shouldUseGemini(chatId)) {
    try {
      log.info(`[router] Gemini: sending message (chatId=${chatId}, admin=${userIsAdmin}): ${userMessage.slice(0, 100)}...`);
      const geminiResult = await runGemini({
        chatId,
        userMessage,
        isAdmin: userIsAdmin,
        userId,
        onToolProgress: async (cid, msg) => safeProgress(cid, msg),
      });
      addTurn(chatId, { role: "assistant", content: geminiResult });
      backgroundExtract(chatId, userMessage, geminiResult);
      log.info(`[router] Gemini success (${geminiResult.length} chars)`);
      return geminiResult;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.warn(`[router] Gemini failed, falling back to Claude CLI: ${errMsg}`);
      logError(err instanceof Error ? err : errMsg, "router:gemini_fallback");
      // Force fresh session so Claude gets full system prompt + tool catalog
      clearSession(chatId);
    }
  }

  // --- Claude CLI path (fallback or agents) ---
  // Select model tier based on message content
  const tier = selectModel(userMessage, contextHint, chatId);
  const model = getModelId(tier);

  // --- Ollama path ---
  if (tier === "ollama") {
    // Agents (chatId 100-106) and scheduler tasks that need tools get full tool chain
    const isAgent = isInternalChatId(chatId);
    const needsTools = userMessage.startsWith("[SCHEDULER:") || userMessage.startsWith("[AGENT:") || userMessage.startsWith("[CRON:") || userMessage.startsWith("[TRAINING:");

    // Force Gemini for executor code request cycles (better code quality than Ollama)
    if (chatId === 103 && userMessage.includes("[CODE_REQUEST]") && config.geminiApiKey && !isProviderCoolingDown("gemini")) {
      try {
        log.info(`[router] 🔧 Gemini force for executor code request: ${userMessage.slice(0, 100)}...`);
        const geminiResult = await runGemini({ chatId, userMessage, isAdmin: userIsAdmin, userId, onToolProgress: async (cid, msg) => safeProgress(cid, msg) });
        addTurn(chatId, { role: "assistant", content: geminiResult });
        backgroundExtract(chatId, userMessage, geminiResult);
        return geminiResult;
      } catch (err) {
        log.warn(`[router] Gemini force for executor failed, falling back to Ollama: ${err instanceof Error ? err.message : String(err)}`);
        // Fall through to normal Ollama path
      }
    }

    // Force Gemini for training tasks (chatId 250) — Ollama is too weak at tool calling
    if (chatId === 250 && userMessage.startsWith("[TRAINING:") && config.geminiApiKey && !isProviderCoolingDown("gemini")) {
      try {
        log.info(`[router] 🏋️ Gemini force for training: ${userMessage.slice(0, 100)}...`);
        const geminiResult = await runGemini({ chatId, userMessage, isAdmin: userIsAdmin, userId, onToolProgress: async (cid, msg) => safeProgress(cid, msg) });
        addTurn(chatId, { role: "assistant", content: geminiResult });
        return geminiResult;
      } catch (err) {
        log.warn(`[router] Gemini force for training failed, falling back to Ollama-chat: ${err instanceof Error ? err.message : String(err)}`);
        // Fall through to Ollama-chat (still has tools, just weaker)
      }
    }

    if (isAgent || needsTools) {
      try {
        log.info(`[router] 🦙 Ollama-chat for ${isAgent ? `agent ${chatId}` : "scheduler"}: ${userMessage.slice(0, 100)}...`);
        const result = await runOllamaChat({
          chatId,
          userMessage,
          isAdmin: userIsAdmin,
          userId,
          onToolProgress: async (cid, msg) => safeProgress(cid, msg),
        });
        addTurn(chatId, { role: "assistant", content: result });
        backgroundExtract(chatId, userMessage, result);
        clearProviderFailures("ollama");
        return result;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const errClass = classifyError(err);
        recordFailure("ollama", errClass);
        log.warn(`[router] Ollama-chat failed [${errClass}] for ${isAgent ? `agent ${chatId}` : "scheduler"}, falling back to Gemini: ${errMsg}`);
        // Fallback to Gemini (free) instead of Haiku (burns Claude quota)
        try {
          const geminiResult = await runGemini({ chatId, userMessage, isAdmin: userIsAdmin, userId });
          if (geminiResult) {
            addTurn(chatId, { role: "assistant", content: geminiResult });
            backgroundExtract(chatId, userMessage, geminiResult);
            clearProviderFailures("gemini");
            return geminiResult;
          }
        } catch (gemErr) {
          const gemClass = classifyError(gemErr);
          recordFailure("gemini", gemClass);
        }
        // Last resort: Haiku
        const haikuModel = getModelId("haiku");
        const haikuResult = await runClaude(chatId, userMessage, userIsAdmin, haikuModel);
        if (haikuResult.type === "message") {
          const text = haikuResult.text?.trim() || "Désolé, je n'ai pas pu répondre.";
          addTurn(chatId, { role: "assistant", content: text });
          backgroundExtract(chatId, userMessage, text);
          return text;
        }
        const text = "Task acknowledged.";
        addTurn(chatId, { role: "assistant", content: text });
        return text;
      }
    }

    // Non-agent/non-scheduler: text-only (heartbeats, greetings)
    try {
      const ollamaResult = await runOllama(chatId, userMessage);
      addTurn(chatId, { role: "assistant", content: ollamaResult.text });
      backgroundExtract(chatId, userMessage, ollamaResult.text);
      clearProviderFailures("ollama");
      return ollamaResult.text;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const errClass = classifyError(err);
      recordFailure("ollama", errClass);
      log.warn(`[router] Ollama failed [${errClass}], trying Groq: ${errMsg}`);
      // Try Groq before Haiku ($0, text-only)
      const groqResult = await tryGroqFallback(chatId, userMessage, "ollama-fail");
      if (groqResult) {
        addTurn(chatId, { role: "assistant", content: groqResult });
        backgroundExtract(chatId, userMessage, groqResult);
        return groqResult;
      }
      log.warn(`[router] Groq also unavailable, falling back to Haiku`);
      const haikuModel = getModelId("haiku");
      const haikuResult = await runClaude(chatId, userMessage, userIsAdmin, haikuModel);
      if (haikuResult.type === "message") {
        const text = haikuResult.text?.trim() || "Désolé, je n'ai pas pu répondre.";
        addTurn(chatId, { role: "assistant", content: text });
        backgroundExtract(chatId, userMessage, text);
        return text;
      }
      const text = "Salut! Comment je peux t'aider?";
      addTurn(chatId, { role: "assistant", content: text });
      return text;
    }
  }

  // --- Groq path (fast, free, with tool calling via OpenAI-compatible API) ---
  if (tier === "groq") {
    try {
      log.info(`[router] ⚡ Groq-chat for user (chatId=${chatId}): ${userMessage.slice(0, 100)}...`);
      const groqResult = await runGroqChat({
        chatId,
        userMessage,
        isAdmin: userIsAdmin,
        userId,
        onToolProgress: async (cid, msg) => safeProgress(cid, msg),
      });
      addTurn(chatId, { role: "assistant", content: groqResult });
      backgroundExtract(chatId, userMessage, groqResult);
      clearProviderFailures("groq");
      return groqResult;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const errClass = classifyError(err);
      recordFailure("groq", errClass);
      log.warn(`[router] Groq-chat failed [${errClass}]: ${errMsg} — falling back to Ollama → Claude`);
      // Try Ollama-chat as second option
      if (config.ollamaEnabled) {
        try {
          const ollamaResult = await runOllamaChat({ chatId, userMessage, isAdmin: userIsAdmin, userId });
          addTurn(chatId, { role: "assistant", content: ollamaResult });
          backgroundExtract(chatId, userMessage, ollamaResult);
          return ollamaResult;
        } catch { /* Ollama also failed */ }
      }
      // Last resort: Claude (streaming path will be tried below)
    }
  }

  // --- OpenRouter path (free models with full tool support via unified gateway) ---
  if (tier === "openrouter") {
    try {
      log.info(`[router] 🌐 OpenRouter-chat for ${isInternalChatId(chatId) ? `internal ${chatId}` : `user`} (chatId=${chatId}): ${userMessage.slice(0, 100)}...`);
      const orResult = await runOpenRouterChat({
        chatId,
        userMessage,
        isAdmin: userIsAdmin,
        userId,
        onToolProgress: async (cid, msg) => safeProgress(cid, msg),
      });
      addTurn(chatId, { role: "assistant", content: orResult });
      backgroundExtract(chatId, userMessage, orResult);
      clearProviderFailures("openrouter");
      return orResult;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const errClass = classifyError(err);
      recordFailure("openrouter", errClass);
      log.warn(`[router] OpenRouter-chat failed [${errClass}]: ${errMsg} — falling back to Groq → Claude`);
      // Try Groq as second option
      if (isGroqAvailable()) {
        try {
          const groqResult = await runGroqChat({ chatId, userMessage, isAdmin: userIsAdmin, userId });
          addTurn(chatId, { role: "assistant", content: groqResult });
          backgroundExtract(chatId, userMessage, groqResult);
          return groqResult;
        } catch { /* Groq also failed */ }
      }
      // Last resort: Claude (streaming path will be tried below)
    }
  }

  // --- Proactive bypass: if Claude is known rate-limited, skip to fallbacks ---
  // But probe every 5min to auto-recover if credits were added
  if (isClaudeRateLimited()) {
    if (shouldProbeRateLimit()) {
      markProbeAttempt();
      log.info(`[router] Probing Claude (rate limit may have lifted)...`);
      // Fall through to try Claude normally — if it works, clearRateLimit() is called
    } else {
      const remaining = rateLimitRemainingMinutes();
      log.info(`[router] Claude rate-limited (${remaining}min left) — bypassing to fallback chain`);
      return await fallbackWithoutClaude(chatId, userMessage, userIsAdmin, userId, remaining, model);
    }
  }

  // First pass: Claude — always use a Claude model (tier may be groq/ollama if fallback reached here)
  const claudeModel = (tier === "groq" || tier === "openrouter") ? getModelId("sonnet") : model;
  log.info(`[router] ${modelLabel(tier)} Sending to Claude (admin=${userIsAdmin}, model=${claudeModel}): ${userMessage.slice(0, 100)}...`);
  let result = await runClaude(chatId, userMessage, userIsAdmin, claudeModel);
  log.info(`[router] Claude responded with type: ${result.type}`);

  if (result.type === "message") {
    // --- Rate limit detection: catch it before passing to user ---
    if (result.text && detectAndSetRateLimit(result.text)) {
      log.warn(`[router] Claude rate-limited — falling back for this message`);
      recordFailure("claude", "rate_limit");
      const remaining = rateLimitRemainingMinutes();
      return await fallbackWithoutClaude(chatId, userMessage, userIsAdmin, userId, remaining, claudeModel);
    }

    const isEmpty = !result.text || !result.text.trim() || result.text.includes("(Claude returned an empty response)");
    if (isEmpty) {
      // Record empty response in failover tracker
      recordFailure("claude", "empty_response");
      // Auto-recovery: clear corrupt session and retry with fresh context
      log.warn(`[router] Empty CLI response — clearing session ${chatId} and retrying`);
      clearSession(chatId);
      result = await runClaude(chatId, userMessage, userIsAdmin, model);
      log.info(`[router] Retry responded with type: ${result.type}`);

      // Check retry for rate limit too
      if (result.type === "message" && result.text && detectAndSetRateLimit(result.text)) {
        log.warn(`[router] Claude rate-limited on retry — falling back`);
        return await fallbackWithoutClaude(chatId, userMessage, userIsAdmin, userId, rateLimitRemainingMinutes(), model);
      }

      if (result.type === "message") {
        const text = result.text && result.text.trim()
          ? result.text
          : "Désolé, je n'ai pas pu générer de réponse. Réessaie.";
        addTurn(chatId, { role: "assistant", content: text });
        backgroundExtract(chatId, userMessage, text);
        return text;
      }
      // Retry returned a tool_call — continue to tool chain below
    } else {
      // Successful Claude response — clear any stale rate limit + failover state
      clearRateLimit();
      clearProviderFailures("claude");
      addTurn(chatId, { role: "assistant", content: result.text });
      backgroundExtract(chatId, userMessage, result.text);
      return result.text;
    }
  } else {
    // Tool call succeeded — Claude is working, clear rate limit + failover state
    clearRateLimit();
    clearProviderFailures("claude");
  }

  // Tool chaining loop — HYBRID MODE: Ollama ($0 local) handles tool routing,
  // Opus handles ONLY the final conversational response.
  // Saves ~90% of tool-chain tokens compared to using Sonnet for follow-ups.
  // Fallback: if Ollama is unavailable, falls back to Sonnet.
  const followUpTier: ModelTier = "sonnet";
  const followUpModel = getModelId(followUpTier);
  const useOllamaRouter = config.ollamaEnabled;
  log.info(`[router] Tool chain mode: ${useOllamaRouter ? "🦙 Ollama-hybrid ($0)" : `${modelLabel(followUpTier)} (${followUpModel})`}`);

  // Track tool execution history for Ollama router
  const toolHistory: Array<{ tool: string; result: string }> = [];

  // Agents get a lower chain limit to prevent stalls
  const isAgentChat = chatId >= 100 && chatId < 1000;
  const effectiveChainLimit = isAgentChat ? Math.min(config.maxToolChain, 10) : config.maxToolChain;
  const chainStartTime = Date.now();
  const CHAIN_TIMEOUT_MS = isAgentChat ? 120_000 : 300_000; // 2min agents, 5min users

  for (let step = 0; step < effectiveChainLimit; step++) {
    if (result.type !== "tool_call") break;

    // CHECK TIMEOUT: abort chain if total time exceeded
    if (Date.now() - chainStartTime > CHAIN_TIMEOUT_MS) {
      const msg = `[Tool chain timeout after ${Math.round((Date.now() - chainStartTime) / 1000)}s — aborting]`;
      log.warn(`[router] ${msg}`);
      addTurn(chatId, { role: "assistant", content: msg });
      return msg;
    }

    // CHECK INTERRUPT: if a new user message arrived, stop processing
    if (isInterrupted()) {
      const msg = "[Traitement interrompu — nouveau message reçu]";
      log.info(`[router] Tool chain interrupted at step ${step + 1} — new user message`);
      addTurn(chatId, { role: "assistant", content: msg });
      return msg;
    }

    const { tool, args } = result;

    // Guard against malformed tool calls
    if (!tool || typeof tool !== "string") {
      const errorMsg = "Tool call missing or invalid tool name.";
      log.warn(`[router] ${errorMsg}`);
      logError(errorMsg, "router:malformed_tool");
      addTurn(chatId, { role: "assistant", content: errorMsg });
      return errorMsg;
    }
    if (!args || typeof args !== "object") {
      log.debug(`[router] Tool "${tool}" called with missing args — defaulting to {}`);
      result.args = {};
    }
    const safeArgs = result.args as Record<string, unknown>;

    // Normalize common arg aliases (snake_case → camelCase)
    if (safeArgs.chat_id !== undefined && safeArgs.chatId === undefined) {
      safeArgs.chatId = safeArgs.chat_id;
      delete safeArgs.chat_id;
      log.debug(`[router] Normalized chat_id → chatId for ${tool}`);
    }
    if (safeArgs.message !== undefined && safeArgs.text === undefined) {
      safeArgs.text = safeArgs.message;
      delete safeArgs.message;
      log.debug(`[router] Normalized message → text for ${tool}`);
    }

    // Auto-inject chatId for telegram.*/browser.* skills when missing
    if ((tool.startsWith("telegram.") || tool.startsWith("browser.")) && !safeArgs.chatId) {
      safeArgs.chatId = String(chatId);
      log.debug(`[router] Auto-injected chatId=${chatId} for ${tool}`);
    }

    // Agent/cron chatId fix: agents (100-106) and cron jobs (200-249) use fake chatIds for session isolation.
    // When they call telegram.send/voice, replace with the real admin chatId.
    if (isInternalChatId(chatId) && tool.startsWith("telegram.") && config.adminChatId > 0) {
      safeArgs.chatId = String(config.adminChatId);
      log.debug(`[router] Internal session ${chatId}: rewrote chatId to admin ${config.adminChatId} for ${tool}`);
    }

    // Dashboard chatIds (2, 3) should NOT send Telegram messages — return text for voice/TTS instead
    if ((chatId === 2 || chatId === 3) && tool === "telegram.send") {
      const textContent = safeArgs.text || safeArgs.message || JSON.stringify(safeArgs);
      log.info(`[router] Dashboard chatId=${chatId}: blocked telegram.send, returning text for TTS`);
      addTurn(chatId, { role: "assistant", content: textContent });
      return textContent;
    }

    // Agents can use read-only browser skills (snapshot, extract, navigate, status)
    // but destructive skills (click, type, computer_use, etc.) are blocked
    const AGENT_BROWSER_ALLOWED = ["browser.navigate", "browser.snapshot", "browser.extract", "browser.status"];
    if (isInternalChatId(chatId) && tool.startsWith("browser.") && !AGENT_BROWSER_ALLOWED.includes(tool)) {
      const msg = `Tool "${tool}" is blocked for agents — use browser.snapshot or web.search instead.`;
      log.warn(`[router] Agent chatId=${chatId} tried to call ${tool} — blocked`);
      toolHistory.push({ tool, result: `ERROR: ${msg}` });
      const followUp = `[Tool "${tool}" error]:\n${msg}`;
      addTurn(chatId, { role: "assistant", content: `[blocked ${tool}]` });
      addTurn(chatId, { role: "user", content: followUp });
      result = await runClaude(chatId, followUp, userIsAdmin, followUpModel);
      if (result.type === "message") {
        addTurn(chatId, { role: "assistant", content: result.text });
        return result.text;
      }
      continue;
    }

    // Security: check allowlist + admin — hard block, no retry
    if (!isToolPermitted(tool, userId)) {
      const msg = tool
        ? `Tool "${tool}" is not permitted${getSkill(tool)?.adminOnly ? " (admin only)" : ""}.`
        : "Tool not permitted.";
      await safeProgress(chatId, `❌ ${msg}`);
      addTurn(chatId, { role: "assistant", content: msg });
      return msg;
    }

    // Look up skill — feed error back so it can retry
    const skill = getSkill(tool);
    if (!skill) {
      const errorMsg = `Error: Unknown tool "${tool}". Check the tool catalog and try again.`;
      log.warn(`[router] ${errorMsg}`);
      logError(errorMsg, "router:unknown_tool", tool);
      await safeProgress(chatId, `❌ Unknown tool: ${tool}`);
      toolHistory.push({ tool, result: errorMsg });
      // For unknown tools, ask Ollama or Sonnet for next step
      if (useOllamaRouter) {
        const ollamaNext = await runOllamaToolRouter(chatId, userMessage, toolHistory, userIsAdmin);
        if (ollamaNext.type === "tool_call" && ollamaNext.tool) {
          result = { type: "tool_call", tool: ollamaNext.tool, args: ollamaNext.args || {}, text: "" };
          continue;
        }
        // Ollama returned summary — feed to Opus for final polish
        break;
      }
      const followUp = `[Tool "${tool}" error]:\n${errorMsg}`;
      addTurn(chatId, { role: "assistant", content: `[called ${tool}]` });
      addTurn(chatId, { role: "user", content: followUp });
      result = await runClaude(chatId, followUp, userIsAdmin, followUpModel);
      if (result.type === "message") {
        addTurn(chatId, { role: "assistant", content: result.text });
        return result.text;
      }
      continue;
    }

    // Type coercion: LLMs often pass numbers as strings ("10" instead of 10)
    // Coerce args to match the expected schema types before validation
    for (const [key, val] of Object.entries(safeArgs)) {
      const prop = skill.argsSchema.properties[key];
      if (!prop) continue;
      if (prop.type === "number" && typeof val === "string") {
        const num = Number(val);
        if (!isNaN(num)) {
          safeArgs[key] = num;
          log.debug(`[router] Coerced "${key}" from string "${val}" to number ${num} for ${tool}`);
        }
      } else if (prop.type === "boolean" && typeof val === "string") {
        safeArgs[key] = val === "true" || val === "1";
        log.debug(`[router] Coerced "${key}" from string "${val}" to boolean for ${tool}`);
      } else if (prop.type === "string" && typeof val === "number") {
        safeArgs[key] = String(val);
        log.debug(`[router] Coerced "${key}" from number ${val} to string for ${tool}`);
      }
    }

    // Validate args — feed error back so it can fix & retry
    const validationError = validateArgs(safeArgs, skill.argsSchema);
    if (validationError) {
      const errorMsg = `Tool "${tool}" argument error: ${validationError}. Fix the arguments and try again.`;
      log.warn(`[router] ${errorMsg}`);
      logError(errorMsg, "router:validation", tool);
      await safeProgress(chatId, `❌ Arg error on ${tool}`);
      toolHistory.push({ tool, result: `ERROR: ${errorMsg}` });
      if (useOllamaRouter) {
        const ollamaNext = await runOllamaToolRouter(chatId, userMessage, toolHistory, userIsAdmin);
        if (ollamaNext.type === "tool_call" && ollamaNext.tool) {
          result = { type: "tool_call", tool: ollamaNext.tool, args: ollamaNext.args || {}, text: "" };
          continue;
        }
        break;
      }
      const followUp = `[Tool "${tool}" error]:\n${errorMsg}`;
      addTurn(chatId, { role: "assistant", content: `[called ${tool}]` });
      addTurn(chatId, { role: "user", content: followUp });
      result = await runClaude(chatId, followUp, userIsAdmin, followUpModel);
      if (result.type === "message") {
        addTurn(chatId, { role: "assistant", content: result.text });
        return result.text;
      }
      continue;
    }

    // Block placeholder hallucinations in outbound messages (agents and cron jobs)
    if (isInternalChatId(chatId)) {
      const outboundTools = ["telegram.send", "mind.ask", "moltbook.post", "moltbook.comment", "content.publish"];
      if (outboundTools.includes(tool)) {
        const textArg = String(safeArgs.text || safeArgs.content || safeArgs.question || "");
        const placeholderRe = /\[[A-ZÀ-ÜÉÈ][A-ZÀ-ÜÉÈ\s_\-]{2,}\]/;
        if (placeholderRe.test(textArg)) {
          log.warn(`[router] Blocked ${tool} — placeholder detected: "${textArg.slice(0, 120)}"`);
          toolHistory.push({ tool, result: `ERROR: Placeholder detected — blocked.` });
          if (useOllamaRouter) {
            const ollamaNext = await runOllamaToolRouter(chatId, userMessage, toolHistory, userIsAdmin);
            if (ollamaNext.type === "tool_call" && ollamaNext.tool) {
              result = { type: "tool_call", tool: ollamaNext.tool, args: ollamaNext.args || {}, text: "" };
              continue;
            }
            break;
          }
          const followUp = `[Tool "${tool}" error]:\nError: Message contains placeholder brackets like [RÉSUMÉ]. Get REAL data from tools first, then compose the message.`;
          addTurn(chatId, { role: "assistant", content: `[blocked ${tool} — placeholder]` });
          addTurn(chatId, { role: "user", content: followUp });
          result = await runClaude(chatId, followUp, userIsAdmin, followUpModel);
          if (result.type === "message") {
            addTurn(chatId, { role: "assistant", content: result.text });
            return result.text;
          }
          continue;
        }
      }
    }

    // Execute skill — feed errors back so it can adapt
    log.info(`Executing tool (step ${step + 1}/${config.maxToolChain}): ${tool}`);
    let toolResult: string;
    const toolStart = Date.now();
    const isSlowTool = tool.startsWith("browser.") || tool.startsWith("image.") || tool.startsWith("video.") || tool === "shell.exec";
    const batchToolTimeout = isSlowTool ? 180_000 : 120_000;
    emitHook("tool:before", { chatId, tool, args: safeArgs }).catch(() => {});
    try {
      const execPromise = skill.execute(safeArgs);
      const execTimeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Tool "${tool}" execution timed out (${batchToolTimeout / 1000}s)`)), batchToolTimeout)
      );
      toolResult = await Promise.race([execPromise, execTimeout]);
      emitHook("tool:after", { chatId, tool, durationMs: Date.now() - toolStart, success: true }).catch(() => {});
    } catch (err) {
      emitHook("tool:after", { chatId, tool, durationMs: Date.now() - toolStart, success: false, error: String(err) }).catch(() => {});
      const errorMsg = `Tool "${tool}" execution failed: ${err instanceof Error ? err.message : String(err)}`;
      log.error(errorMsg);
      logError(err instanceof Error ? err : errorMsg, `router:exec:${tool}`, tool);
      await safeProgress(chatId, `❌ ${tool} failed`);
      toolHistory.push({ tool, result: `ERROR: ${errorMsg}` });
      if (useOllamaRouter) {
        const ollamaNext = await runOllamaToolRouter(chatId, userMessage, toolHistory, userIsAdmin);
        if (ollamaNext.type === "tool_call" && ollamaNext.tool) {
          result = { type: "tool_call", tool: ollamaNext.tool, args: ollamaNext.args || {}, text: "" };
          continue;
        }
        break;
      }
      const followUp = `[Tool "${tool}" error]:\n${errorMsg}`;
      addTurn(chatId, { role: "assistant", content: `[called ${tool}]` });
      addTurn(chatId, { role: "user", content: followUp });
      result = await runClaude(chatId, followUp, userIsAdmin, followUpModel);
      if (result.type === "message") {
        addTurn(chatId, { role: "assistant", content: result.text });
        return result.text;
      }
      continue;
    }

    log.debug(`Tool result (${tool}):`, toolResult.slice(0, 200));
    toolHistory.push({ tool, result: toolResult });

    // Heartbeat: send intermediate progress to Telegram (skip dashboard/agent chatIds)
    const preview = toolResult.length > 200 ? toolResult.slice(0, 200) + "..." : toolResult;
    await safeProgress(chatId, `⚙️ **${tool}**\n\`\`\`\n${preview}\n\`\`\``);

    // --- HYBRID ROUTING: use Ollama ($0) for tool routing decisions ---
    if (useOllamaRouter) {
      log.info(`[router] 🦙 Asking Ollama for next step (step ${step + 1})...`);
      const ollamaNext = await runOllamaToolRouter(chatId, userMessage, toolHistory, userIsAdmin);

      if (ollamaNext.type === "tool_call" && ollamaNext.tool) {
        // Ollama wants another tool — continue the loop
        log.info(`[router] 🦙 Ollama requests next tool: ${ollamaNext.tool}`);
        addTurn(chatId, { role: "assistant", content: `[called ${tool}]` });
        result = { type: "tool_call", tool: ollamaNext.tool, args: ollamaNext.args || {}, text: "" };
        continue;
      }

      // Ollama returned a summary or failed — break to send to Opus for final response
      log.info(`[router] 🦙 Ollama says task is complete — sending to Opus for final response`);
      break;
    }

    // --- FALLBACK: use Sonnet for tool follow-ups (original behavior) ---
    const schemaHint = getSkillSchema(tool);
    const reflectionSuffix = `\n\nÉvalue ce résultat et AGIS:\n→ Tâche complète? Envoie un message FINAL résumant ce qui a été fait à Nicolas. OBLIGATOIRE.\n→ Prochaine étape nécessaire? Appelle le tool suivant IMMÉDIATEMENT.\n→ Erreur? Diagnostique et essaie une alternative.\nRAPPEL: Tu DOIS terminer par un message texte lisible pour Nicolas. JAMAIS terminer sur un tool_call sans réponse.`;
    const followUp = schemaHint
      ? `[Tool "${tool}" — schema: ${schemaHint}]\n${toolResult}${reflectionSuffix}`
      : `[Tool "${tool}" résultat]:\n${toolResult}${reflectionSuffix}`;
    addTurn(chatId, { role: "assistant", content: `[called ${tool}]` });
    addTurn(chatId, { role: "user", content: followUp });

    log.info(`[router] Feeding tool result back to Claude (step ${step + 1}, ${modelLabel("sonnet")})...`);
    result = await runClaude(chatId, followUp, userIsAdmin, followUpModel);
    log.info(`[router] Claude follow-up response type: ${result.type}`);

    // If Claude responds with a message, we're done
    if (result.type === "message") {
      addTurn(chatId, { role: "assistant", content: result.text });
      backgroundExtract(chatId, userMessage, result.text);
      return result.text;
    }

    // Otherwise loop continues with next tool call
    log.info(`[router] Continuing chain — next tool: ${result.type === "tool_call" ? result.tool : "unknown"}`);
  }

  // --- HYBRID FINAL RESPONSE: Opus crafts the conversational reply from tool results ---
  if (useOllamaRouter && toolHistory.length > 0) {
    log.info(`[router] 🎯 Opus final response — summarizing ${toolHistory.length} tool results`);
    const toolSummary = toolHistory.map(t => `• ${t.tool}: ${t.result.slice(0, 500)}`).join("\n");
    const finalPrompt = `[RÉSULTATS DES OUTILS — résume à Nicolas de façon concise et naturelle]\nMessage original: "${userMessage}"\n\n${toolSummary}\n\nRédige une réponse finale CONCISE pour Nicolas. Pas de tool_call. Texte seulement.`;
    addTurn(chatId, { role: "user", content: finalPrompt });
    const finalResult = await runClaude(chatId, finalPrompt, userIsAdmin, claudeModel);
    const finalText = finalResult.type === "message" && finalResult.text?.trim()
      ? finalResult.text
      : `J'ai exécuté ${toolHistory.length} outils. Résultats:\n${toolHistory.map(t => `• ${t.tool}: OK`).join("\n")}`;
    addTurn(chatId, { role: "assistant", content: finalText });
    backgroundExtract(chatId, userMessage, finalText);
    return finalText;
  }

  // If we exhausted the chain limit and still got a tool_call, force a final summary
  if (result.type === "tool_call") {
    log.warn(`[router] Chain limit reached (${config.maxToolChain} steps) — forcing final summary`);
    await safeProgress(chatId, `⚠️ Chain limit reached — requesting summary`);
    const summaryPrompt = `[SYSTEM] La chaîne de tools a atteint la limite de ${config.maxToolChain} étapes. Résume à Nicolas ce que tu as accompli jusqu'ici et ce qui reste à faire. NE fais PAS d'autre tool_call — réponds en texte seulement.`;
    addTurn(chatId, { role: "user", content: summaryPrompt });
    const summaryResult = await runClaude(chatId, summaryPrompt, userIsAdmin, followUpModel);
    const summaryText = summaryResult.type === "message" && summaryResult.text?.trim()
      ? summaryResult.text
      : `J'ai exécuté ${config.maxToolChain} étapes. Le dernier outil en attente était: ${result.tool}. Réessaie pour continuer.`;
    addTurn(chatId, { role: "assistant", content: summaryText });
    backgroundExtract(chatId, userMessage, summaryText);
    return summaryText;
  }

  // Shouldn't reach here, but safety fallback
  const text = result.type === "message" ? result.text : "(unexpected state)";
  addTurn(chatId, { role: "assistant", content: text });
  return text;
}

/**
 * Handle a user message with streaming output.
 * Tries Gemini first (batch mode — no streaming with function calling),
 * then falls back to Claude CLI streaming on failure.
 */
export async function handleMessageStreaming(
  chatId: number,
  userMessage: string,
  userId: number,
  draft: DraftController
): Promise<string> {
  const response = await handleMessageStreamingInner(chatId, userMessage, userId, draft);
  // Fire-and-forget compaction AFTER response — never blocks the user
  backgroundCompact(chatId, userId);
  return response;
}

async function handleMessageStreamingInner(
  chatId: number,
  userMessage: string,
  userId: number,
  draft: DraftController
): Promise<string> {
  const userIsAdmin = isAdmin(userId);

  // Mood detection for streaming path too
  if (!isInternalChatId(chatId) && chatId > 10) {
    const mood = detectMood(userMessage);
    logMood(mood, chatId);
    setCurrentMoodContext(getToneInstructions(mood));
  } else {
    setCurrentMoodContext("");
  }

  addTurn(chatId, { role: "user", content: userMessage });

  // --- Parallel dispatch (multi-task detection) ---
  if (!isInternalChatId(chatId) && config.groqApiKey) {
    try {
      const parallel = await tryParallelDispatch(
        chatId, userMessage, userId, userIsAdmin,
        async (cid, msg) => safeProgress(cid, msg),
      );
      if (parallel.attempted && parallel.merged) {
        await draft.update(parallel.merged);
        await draft.finalize();
        addTurn(chatId, { role: "assistant", content: parallel.merged });
        backgroundExtract(chatId, userMessage, parallel.merged);
        return parallel.merged;
      }
    } catch (err) {
      log.warn(`[router-stream] Parallel dispatch failed, falling through: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // --- Gemini path (batch mode — Gemini doesn't support streaming + function calling) ---
  if (shouldUseGemini(chatId)) {
    try {
      log.info(`[router-stream] Gemini: sending message (chatId=${chatId}): ${userMessage.slice(0, 100)}...`);
      const geminiResult = await runGemini({
        chatId,
        userMessage,
        isAdmin: userIsAdmin,
        userId,
        onToolProgress: async (cid, msg) => safeProgress(cid, msg),
      });
      // Update draft with final text and finalize
      await draft.update(geminiResult);
      await draft.finalize();
      addTurn(chatId, { role: "assistant", content: geminiResult });
      backgroundExtract(chatId, userMessage, geminiResult);
      log.info(`[router-stream] Gemini success (${geminiResult.length} chars)`);
      return geminiResult;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.warn(`[router-stream] Gemini failed, falling back to Claude CLI streaming: ${errMsg}`);
      logError(err instanceof Error ? err : errMsg, "router:gemini_stream_fallback");
      // Cancel any partial draft from Gemini attempt
      await draft.cancel();
      // Force fresh session so Claude gets full system prompt + tool catalog
      // (resumed sessions may have stale context where Kingston was confused)
      clearSession(chatId);
    }
  }

  // --- Claude CLI streaming path (fallback or agents) ---
  // Select model tier based on message content
  const tier = selectModel(userMessage, "user", chatId);
  const model = getModelId(tier);

  // --- Ollama path ---
  if (tier === "ollama") {
    // Agents and scheduler tasks get full tool chain
    const isAgentStream = isInternalChatId(chatId);
    const needsToolsStream = userMessage.startsWith("[SCHEDULER:") || userMessage.startsWith("[AGENT:") || userMessage.startsWith("[CRON:");

    // Force Gemini for executor code request cycles (streaming path)
    if (chatId === 103 && userMessage.includes("[CODE_REQUEST]") && config.geminiApiKey && !isProviderCoolingDown("gemini")) {
      try {
        log.info(`[router-stream] 🔧 Gemini force for executor code request: ${userMessage.slice(0, 100)}...`);
        await draft.cancel();
        const geminiResult = await runGemini({ chatId, userMessage, isAdmin: userIsAdmin, userId, onToolProgress: async (cid, msg) => safeProgress(cid, msg) });
        addTurn(chatId, { role: "assistant", content: geminiResult });
        backgroundExtract(chatId, userMessage, geminiResult);
        return geminiResult;
      } catch (err) {
        log.warn(`[router-stream] Gemini force for executor failed, falling back: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (isAgentStream || needsToolsStream) {
      try {
        log.info(`[router-stream] 🦙 Ollama-chat for ${isAgentStream ? `agent ${chatId}` : "scheduler"}: ${userMessage.slice(0, 100)}...`);
        await draft.cancel();
        const result = await runOllamaChat({
          chatId,
          userMessage,
          isAdmin: userIsAdmin,
          userId,
          onToolProgress: async (cid, msg) => safeProgress(cid, msg),
        });
        addTurn(chatId, { role: "assistant", content: result });
        backgroundExtract(chatId, userMessage, result);
        return result;
      } catch (err) {
        const ollamaErrClass = classifyError(err);
        recordFailure("ollama", ollamaErrClass);
        log.warn(`[router-stream] Ollama-chat failed [${ollamaErrClass}] for ${isAgentStream ? `agent ${chatId}` : "scheduler"}: ${err instanceof Error ? err.message : String(err)}`);
        await draft.cancel();
        // Fallback to Gemini (free) instead of Haiku
        try {
          const geminiResult = await runGemini({ chatId, userMessage, isAdmin: userIsAdmin, userId });
          if (geminiResult) {
            addTurn(chatId, { role: "assistant", content: geminiResult });
            clearProviderFailures("gemini");
            return geminiResult;
          }
        } catch (gemErr) {
          const gemClass = classifyError(gemErr);
          recordFailure("gemini", gemClass);
        }
        const haikuModel = getModelId("haiku");
        const haikuResult = await runClaude(chatId, userMessage, userIsAdmin, haikuModel);
        if (haikuResult.type === "message") {
          const text = haikuResult.text?.trim() || "Désolé, je n'ai pas pu répondre.";
          addTurn(chatId, { role: "assistant", content: text });
          return text;
        }
        const text = "Task acknowledged.";
        addTurn(chatId, { role: "assistant", content: text });
        return text;
      }
    }

    // Non-agent/non-scheduler: text-only (no streaming needed for trivial responses)
    try {
      const ollamaResult = await runOllama(chatId, userMessage);
      await draft.update(ollamaResult.text);
      await draft.finalize();
      addTurn(chatId, { role: "assistant", content: ollamaResult.text });
      backgroundExtract(chatId, userMessage, ollamaResult.text);
      clearProviderFailures("ollama");
      return ollamaResult.text;
    } catch (err) {
      const ollamaStreamErrClass = classifyError(err);
      recordFailure("ollama", ollamaStreamErrClass);
      log.warn(`[router-stream] Ollama failed [${ollamaStreamErrClass}], trying Groq: ${err instanceof Error ? err.message : String(err)}`);
      // Try Groq before Haiku ($0, text-only)
      const groqResult = await tryGroqFallback(chatId, userMessage, "stream-ollama-fail");
      if (groqResult) {
        await draft.update(groqResult);
        await draft.finalize();
        addTurn(chatId, { role: "assistant", content: groqResult });
        backgroundExtract(chatId, userMessage, groqResult);
        return groqResult;
      }
      await draft.cancel();
      log.warn(`[router-stream] Groq also unavailable, falling back to Haiku`);
      const haikuModel = getModelId("haiku");
      const haikuResult = await runClaude(chatId, userMessage, userIsAdmin, haikuModel);
      if (haikuResult.type === "message") {
        const text = haikuResult.text?.trim() || "Désolé, je n'ai pas pu répondre.";
        addTurn(chatId, { role: "assistant", content: text });
        backgroundExtract(chatId, userMessage, text);
        return text;
      }
      const text = "Salut! Comment je peux t'aider?";
      addTurn(chatId, { role: "assistant", content: text });
      return text;
    }
  }

  // --- Groq path (fast, free, with tool calling) ---
  if (tier === "groq") {
    try {
      log.info(`[router-stream] ⚡ Groq-chat for user (chatId=${chatId}): ${userMessage.slice(0, 100)}...`);
      await draft.cancel(); // Groq doesn't stream — cancel draft, send final message
      const groqResult = await runGroqChat({
        chatId,
        userMessage,
        isAdmin: userIsAdmin,
        userId,
        onToolProgress: async (cid, msg) => safeProgress(cid, msg),
      });
      addTurn(chatId, { role: "assistant", content: groqResult });
      backgroundExtract(chatId, userMessage, groqResult);
      clearProviderFailures("groq");
      return groqResult;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const groqStreamErrClass = classifyError(err);
      recordFailure("groq", groqStreamErrClass);
      log.warn(`[router-stream] Groq-chat failed [${groqStreamErrClass}]: ${errMsg} — falling back`);
      await draft.cancel();
      // Try Ollama, then fall through to Claude streaming
      if (config.ollamaEnabled) {
        try {
          const ollamaResult = await runOllamaChat({ chatId, userMessage, isAdmin: userIsAdmin, userId });
          addTurn(chatId, { role: "assistant", content: ollamaResult });
          backgroundExtract(chatId, userMessage, ollamaResult);
          return ollamaResult;
        } catch { /* Ollama also failed */ }
      }
      // Fall through to Claude streaming below
    }
  }

  // --- OpenRouter path (free models with full tool support) ---
  if (tier === "openrouter") {
    try {
      log.info(`[router-stream] 🌐 OpenRouter-chat for ${isInternalChatId(chatId) ? `internal ${chatId}` : `user`} (chatId=${chatId}): ${userMessage.slice(0, 100)}...`);
      await draft.cancel(); // OpenRouter doesn't stream — cancel draft, send final message
      const orResult = await runOpenRouterChat({
        chatId,
        userMessage,
        isAdmin: userIsAdmin,
        userId,
        onToolProgress: async (cid, msg) => safeProgress(cid, msg),
      });
      addTurn(chatId, { role: "assistant", content: orResult });
      backgroundExtract(chatId, userMessage, orResult);
      clearProviderFailures("openrouter");
      return orResult;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const orStreamErrClass = classifyError(err);
      recordFailure("openrouter", orStreamErrClass);
      log.warn(`[router-stream] OpenRouter-chat failed [${orStreamErrClass}]: ${errMsg} — falling back`);
      await draft.cancel();
      // Try Groq, then fall through to Claude streaming
      if (isGroqAvailable()) {
        try {
          const groqResult = await runGroqChat({ chatId, userMessage, isAdmin: userIsAdmin, userId });
          addTurn(chatId, { role: "assistant", content: groqResult });
          backgroundExtract(chatId, userMessage, groqResult);
          return groqResult;
        } catch { /* Groq also failed */ }
      }
      // Fall through to Claude streaming below
    }
  }

  // --- Proactive bypass: if Claude is known rate-limited, use Gemini/Ollama ---
  // But probe every 5min to auto-recover if credits were added
  if (isClaudeRateLimited()) {
    if (shouldProbeRateLimit()) {
      markProbeAttempt();
      log.info(`[router-stream] Probing Claude (rate limit may have lifted)...`);
      // Fall through to try Claude normally
    } else {
      const remaining = rateLimitRemainingMinutes();
      log.info(`[router-stream] Claude rate-limited (${remaining}min left) — bypassing to fallback`);
      await draft.cancel();
      const fallbackResult = await fallbackWithoutClaude(chatId, userMessage, userIsAdmin, userId, remaining, model);
      return fallbackResult;
    }
  }

  // Always use a Claude model for streaming (tier may be groq/ollama if fallback reached here)
  const streamClaudeModel = (tier === "groq" || tier === "openrouter") ? getModelId("sonnet") : model;
  log.info(`[router] ${modelLabel(tier)} Streaming to Claude (admin=${userIsAdmin}, model=${streamClaudeModel}): ${userMessage.slice(0, 100)}...`);

  // First pass: try streaming (with safety timeout to prevent hanging)
  let streamResult: StreamResult;
  try {
    const streamPromise = runClaudeStreamAsync(chatId, userMessage, userIsAdmin, draft, streamClaudeModel);
    const safetyTimeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Stream response safety timeout")), config.cliTimeoutMs + 10_000)
    );
    streamResult = await Promise.race([streamPromise, safetyTimeout]);
  } catch (streamErr) {
    const errMsg = streamErr instanceof Error ? streamErr.message : String(streamErr);
    const isStallOrTimeout = errMsg.includes("stalled") || errMsg.includes("timeout") || errMsg.includes("safety timeout");
    const streamErrClass = classifyError(streamErr);
    recordFailure("claude", streamErrClass);
    await draft.cancel();
    clearSession(chatId);

    if (isStallOrTimeout) {
      // Claude CLI stalled/timed out — likely rate-limited. Use Gemini/Ollama/Groq instead of retrying Claude.
      log.warn(`[router-stream] Stream stalled/timed out [${streamErrClass}]: ${errMsg} — falling back to non-Claude chain`);
      return await fallbackWithoutClaude(chatId, userMessage, userIsAdmin, userId, 5, streamClaudeModel);
    }

    // Other errors (spawn failure, etc.) — try batch Claude once
    log.warn(`[router-stream] Stream failed [${streamErrClass}]: ${errMsg} — falling back to batch`);
    const batchResponse = await runClaude(chatId, userMessage, userIsAdmin, model);
    if (batchResponse.type === "message") {
      const text = batchResponse.text && batchResponse.text.trim() ? batchResponse.text : "Désolé, je n'ai pas pu générer de réponse. Réessaie.";
      addTurn(chatId, { role: "assistant", content: text });
      backgroundExtract(chatId, userMessage, text);
      return text;
    }
    // If batch also returned a tool call, process it below
    streamResult = {
      text: batchResponse.text || "",
      session_id: batchResponse.session_id,
      is_tool_call: batchResponse.type === "tool_call",
      tool: batchResponse.tool,
      args: batchResponse.args,
    };
  }
  log.info(`[router-stream] Stream completed: is_tool_call=${streamResult.is_tool_call}, text=${streamResult.text.length} chars, tool=${streamResult.tool || "none"}`);

  // If it's a plain text response, we're done (draft already has the content)
  if (!streamResult.is_tool_call) {
    // --- Rate limit detection in streaming response ---
    if (streamResult.text && detectAndSetRateLimit(streamResult.text)) {
      log.warn(`[router-stream] Claude rate-limited in stream — falling back`);
      recordFailure("claude", "rate_limit");
      await draft.cancel();
      const fallbackResult = await fallbackWithoutClaude(chatId, userMessage, userIsAdmin, userId, rateLimitRemainingMinutes(), streamClaudeModel);
      return fallbackResult;
    }

    // Identity confusion detection: Kingston thinks it's in Claude Code CLI
    const confusedPatterns = /claude code|environnement cli|interface cli|pas accès.*bastilon|pas accès.*système|separate environment|port 4242/i;
    if (streamResult.text && confusedPatterns.test(streamResult.text)) {
      log.warn(`[router-stream] Identity confusion detected — clearing session and retrying`);
      await draft.cancel();
      clearSession(chatId);
      const retryResult = await runClaude(chatId, userMessage, userIsAdmin, model);

      // If retry returned a tool_call, process it through the full tool chain
      // (don't discard it with a generic fallback message)
      if (retryResult.type === "tool_call" && retryResult.tool) {
        log.info(`[router-stream] Identity retry returned tool_call: ${retryResult.tool} — routing to batch handler`);
        clearRateLimit();
        clearProviderFailures("claude");
        // Delegate to the batch handler which supports full tool chaining
        const batchResult = await handleMessage(chatId, userMessage, userId);
        return batchResult;
      }

      const retryText = retryResult.type === "message" && retryResult.text?.trim()
        ? retryResult.text
        : "Un moment — je me recalibre.";
      // Don't save confused response, only save retry
      addTurn(chatId, { role: "assistant", content: retryText });
      backgroundExtract(chatId, userMessage, retryText);
      return retryText;
    }

    // --- Missed tool-call detection ---
    // Claude sometimes hallucinate success without actually calling tools.
    // Detect when the response claims to have done something that requires a tool
    // (e.g., "Mème généré", "Image créée") and retry via Gemini which has native function calling.
    if (streamResult.text && !isInternalChatId(chatId) && config.geminiApiKey && !isProviderCoolingDown("gemini")) {
      const responseLC = streamResult.text.toLowerCase();
      const requestLC = userMessage.toLowerCase();
      // Check if user asked for an action that requires tool execution
      const actionRequested = /\b(meme|mème|image|photo|genere|génère|dessine|crée une? image|screenshot|capture)\b/i.test(requestLC)
        || /\b(envoie|envoyer|poste|poster|publie|publier|déploie|deploy)\b/i.test(requestLC);
      // Check if response falsely claims success without evidence of tool execution
      const claimsSuccess = /\b(généré|créé|envoyé|posté|publié|déployé|voilà|voici (ton|ta|le|la)|here'?s your)\b/i.test(responseLC);
      const hasToolEvidence = /\btool_call\b|Tool ".*" execution|Error:|HTTP \d{3}|\[called |ftp\.verify|telegram\.send/i.test(streamResult.text);
      const isShortResponse = streamResult.text.length < 200;

      if (actionRequested && claimsSuccess && !hasToolEvidence && isShortResponse) {
        log.warn(`[router-stream] Missed tool-call detected: Claude claimed "${streamResult.text.slice(0, 80)}" without calling tools — retrying via Gemini`);
        await draft.cancel();
        try {
          const geminiResult = await runGemini({
            chatId,
            userMessage,
            isAdmin: userIsAdmin,
            userId,
            onToolProgress: async (cid, msg) => safeProgress(cid, msg),
          });
          addTurn(chatId, { role: "assistant", content: geminiResult });
          backgroundExtract(chatId, userMessage, geminiResult);
          return geminiResult;
        } catch (err) {
          log.warn(`[router-stream] Gemini retry also failed: ${err instanceof Error ? err.message : String(err)}`);
          // Fall through to return Claude's original response
        }
      }
    }

    // Guard against empty responses sneaking through
    if (!streamResult.text || !streamResult.text.trim()) {
      recordFailure("claude", "empty_response");
      // Auto-recovery: clear session and retry once
      log.warn(`[router-stream] Empty stream response — clearing session and retrying`);
      await draft.cancel();
      clearSession(chatId);
      const retryResult = await runClaude(chatId, userMessage, userIsAdmin, model);

      // Check retry for rate limit
      if (retryResult.type === "message" && retryResult.text && detectAndSetRateLimit(retryResult.text)) {
        return await fallbackWithoutClaude(chatId, userMessage, userIsAdmin, userId, rateLimitRemainingMinutes(), streamClaudeModel);
      }

      const retryText = retryResult.type === "message" && retryResult.text?.trim()
        ? retryResult.text
        : "Désolé, je n'ai pas pu générer de réponse. Réessaie.";
      addTurn(chatId, { role: "assistant", content: retryText });
      backgroundExtract(chatId, userMessage, retryText);
      return retryText;
    }
    // Successful response — clear stale rate limit + failover state
    clearRateLimit();
    clearProviderFailures("claude");
    addTurn(chatId, { role: "assistant", content: streamResult.text });
    await draft.finalize();
    backgroundExtract(chatId, userMessage, streamResult.text);
    log.info(`[router-stream] Returning plain text (${streamResult.text.length} chars)`);
    return streamResult.text;
  }

  // It's a tool call — cancel the draft and process the tool chain in batch mode
  log.info(`[router-stream] Tool call detected: ${streamResult.tool} — switching to batch mode`);
  await draft.cancel();

  let result = {
    type: streamResult.is_tool_call ? "tool_call" as const : "message" as const,
    text: streamResult.text,
    tool: streamResult.tool || "",
    args: streamResult.args || {},
    session_id: streamResult.session_id,
  };

  // Tool chaining loop — HYBRID MODE: Ollama ($0 local) handles tool routing,
  // Opus handles ONLY the final conversational response.
  // Global timeout prevents the chain from blocking the chat lock forever.
  const isStreamAgentChat = chatId >= 100 && chatId < 1000;
  const TOOL_CHAIN_TIMEOUT_MS = isStreamAgentChat ? 120_000 : 300_000; // 2min agents, 5min users
  const toolChainStart = Date.now();
  const streamFollowUpTier: ModelTier = "sonnet";
  const streamFollowUpModel = getModelId(streamFollowUpTier);
  const useOllamaRouterStream = config.ollamaEnabled;
  log.info(`[router-stream] Tool chain mode: ${useOllamaRouterStream ? "🦙 Ollama-hybrid ($0)" : `${modelLabel(streamFollowUpTier)} (${streamFollowUpModel})`}`);

  // Track tool execution history for Ollama router
  const streamToolHistory: Array<{ tool: string; result: string }> = [];
  const effectiveStreamChainLimit = isStreamAgentChat ? Math.min(config.maxToolChain, 10) : config.maxToolChain;

  for (let step = 0; step < effectiveStreamChainLimit; step++) {
    if (result.type !== "tool_call") break;

    // CHECK INTERRUPT: if a new user message arrived, stop processing
    if (isInterrupted()) {
      const msg = "[Traitement interrompu — nouveau message reçu]";
      log.info(`[router-stream] Tool chain interrupted at step ${step + 1} — new user message`);
      addTurn(chatId, { role: "assistant", content: msg });
      return msg;
    }

    // Safety: check tool chain timeout
    if (Date.now() - toolChainStart > TOOL_CHAIN_TIMEOUT_MS) {
      const msg = `La chaîne d'outils a pris trop de temps (${Math.round((Date.now() - toolChainStart) / 1000)}s). Réessaie.`;
      log.warn(`[router-stream] Tool chain timeout after ${Math.round((Date.now() - toolChainStart) / 1000)}s`);
      addTurn(chatId, { role: "assistant", content: msg });
      return msg;
    }

    const { tool, args: rawArgs } = result;

    if (!tool || typeof tool !== "string") {
      const errorMsg = "Tool call missing or invalid tool name.";
      log.warn(`[router-stream] ${errorMsg}`);
      addTurn(chatId, { role: "assistant", content: errorMsg });
      return errorMsg;
    }
    const safeArgs = (rawArgs && typeof rawArgs === "object" ? rawArgs : {}) as Record<string, unknown>;

    // Normalize arg aliases
    if (safeArgs.chat_id !== undefined && safeArgs.chatId === undefined) {
      safeArgs.chatId = safeArgs.chat_id;
      delete safeArgs.chat_id;
    }
    if (safeArgs.message !== undefined && safeArgs.text === undefined) {
      safeArgs.text = safeArgs.message;
      delete safeArgs.message;
    }
    if ((tool.startsWith("telegram.") || tool.startsWith("browser.")) && !safeArgs.chatId) {
      safeArgs.chatId = String(chatId);
    }

    // Agent/cron chatId fix: rewrite internal chatIds to real admin chatId for telegram.*
    if (isInternalChatId(chatId) && tool.startsWith("telegram.") && config.adminChatId > 0) {
      safeArgs.chatId = String(config.adminChatId);
      log.debug(`[router-stream] Internal session ${chatId}: rewrote chatId to admin ${config.adminChatId} for ${tool}`);
    }

    // Agents can use read-only browser skills but destructive ones are blocked
    const AGENT_BROWSER_ALLOWED_STREAM = ["browser.navigate", "browser.snapshot", "browser.extract", "browser.status"];
    if (isInternalChatId(chatId) && tool.startsWith("browser.") && !AGENT_BROWSER_ALLOWED_STREAM.includes(tool)) {
      const msg = `Tool "${tool}" is blocked for agents — use browser.snapshot or web.search instead.`;
      log.warn(`[router-stream] Agent chatId=${chatId} tried to call ${tool} — blocked`);
      streamToolHistory.push({ tool, result: `ERROR: ${msg}` });
      if (useOllamaRouterStream) {
        const ollamaNext = await runOllamaToolRouter(chatId, userMessage, streamToolHistory, userIsAdmin);
        if (ollamaNext.type === "tool_call" && ollamaNext.tool) {
          result = { type: "tool_call" as const, text: "", tool: ollamaNext.tool, args: ollamaNext.args || {} };
          continue;
        }
        break;
      }
      const followUp = `[Tool "${tool}" error]:\n${msg}`;
      addTurn(chatId, { role: "assistant", content: `[blocked ${tool}]` });
      addTurn(chatId, { role: "user", content: followUp });
      const batchResult = await runClaude(chatId, followUp, userIsAdmin, streamFollowUpModel);
      if (batchResult.type === "message") {
        const text = batchResult.text || "Désolé, je n'ai pas pu répondre.";
        addTurn(chatId, { role: "assistant", content: text });
        return text;
      }
      result = batchResultToRouterResult(batchResult);
      continue;
    }

    if (!isToolPermitted(tool, userId)) {
      const msg = `Tool "${tool}" is not permitted.`;
      addTurn(chatId, { role: "assistant", content: msg });
      return msg;
    }

    const skill = getSkill(tool);
    if (!skill) {
      streamToolHistory.push({ tool, result: `ERROR: Unknown tool "${tool}".` });
      if (useOllamaRouterStream) {
        const ollamaNext = await runOllamaToolRouter(chatId, userMessage, streamToolHistory, userIsAdmin);
        if (ollamaNext.type === "tool_call" && ollamaNext.tool) {
          result = { type: "tool_call" as const, text: "", tool: ollamaNext.tool, args: ollamaNext.args || {} };
          continue;
        }
        break;
      }
      const followUp = `[Tool "${tool}" error]:\nUnknown tool "${tool}".`;
      addTurn(chatId, { role: "assistant", content: `[called ${tool}]` });
      addTurn(chatId, { role: "user", content: followUp });
      const batchResult = await runClaude(chatId, followUp, userIsAdmin, streamFollowUpModel);
      if (batchResult.type === "message") {
        const text = batchResult.text || "Désolé, je n'ai pas pu répondre.";
        addTurn(chatId, { role: "assistant", content: text });
        return text;
      }
      result = batchResultToRouterResult(batchResult);
      continue;
    }

    // Type coercion: LLMs often pass numbers as strings ("10" instead of 10)
    for (const [key, val] of Object.entries(safeArgs)) {
      const prop = skill.argsSchema.properties[key];
      if (!prop) continue;
      if (prop.type === "number" && typeof val === "string") {
        const num = Number(val);
        if (!isNaN(num)) {
          safeArgs[key] = num;
          log.debug(`[router-stream] Coerced "${key}" from string "${val}" to number ${num} for ${tool}`);
        }
      } else if (prop.type === "boolean" && typeof val === "string") {
        safeArgs[key] = val === "true" || val === "1";
      } else if (prop.type === "string" && typeof val === "number") {
        safeArgs[key] = String(val);
      }
    }

    const validationError = validateArgs(safeArgs, skill.argsSchema);
    if (validationError) {
      streamToolHistory.push({ tool, result: `ERROR: ${validationError}` });
      if (useOllamaRouterStream) {
        const ollamaNext = await runOllamaToolRouter(chatId, userMessage, streamToolHistory, userIsAdmin);
        if (ollamaNext.type === "tool_call" && ollamaNext.tool) {
          result = { type: "tool_call" as const, text: "", tool: ollamaNext.tool, args: ollamaNext.args || {} };
          continue;
        }
        break;
      }
      const followUp = `[Tool "${tool}" error]:\nArgument error: ${validationError}.`;
      addTurn(chatId, { role: "assistant", content: `[called ${tool}]` });
      addTurn(chatId, { role: "user", content: followUp });
      const batchResult = await runClaude(chatId, followUp, userIsAdmin, streamFollowUpModel);
      if (batchResult.type === "message") {
        const text = batchResult.text || "Désolé, je n'ai pas pu répondre.";
        addTurn(chatId, { role: "assistant", content: text });
        return text;
      }
      result = batchResultToRouterResult(batchResult);
      continue;
    }

    // Block placeholder hallucinations in outbound messages (agents and cron — streaming path)
    if (isInternalChatId(chatId)) {
      const outboundTools = ["telegram.send", "mind.ask", "moltbook.post", "moltbook.comment", "content.publish"];
      if (outboundTools.includes(tool)) {
        const textArg = String(safeArgs.text || safeArgs.content || safeArgs.question || "");
        const placeholderRe = /\[[A-ZÀ-ÜÉÈ][A-ZÀ-ÜÉÈ\s_\-]{2,}\]/;
        if (placeholderRe.test(textArg)) {
          log.warn(`[router-stream] Blocked ${tool} — placeholder detected: "${textArg.slice(0, 120)}"`);
          streamToolHistory.push({ tool, result: `ERROR: Placeholder detected — blocked.` });
          if (useOllamaRouterStream) {
            const ollamaNext = await runOllamaToolRouter(chatId, userMessage, streamToolHistory, userIsAdmin);
            if (ollamaNext.type === "tool_call" && ollamaNext.tool) {
              result = { type: "tool_call" as const, text: "", tool: ollamaNext.tool, args: ollamaNext.args || {} };
              continue;
            }
            break;
          }
          const followUp = `[Tool "${tool}" error]:\nError: Message contains placeholder brackets. Get REAL data from tools first.`;
          addTurn(chatId, { role: "assistant", content: `[blocked ${tool} — placeholder]` });
          addTurn(chatId, { role: "user", content: followUp });
          const batchResult = await runClaude(chatId, followUp, userIsAdmin, streamFollowUpModel);
          if (batchResult.type === "message") {
            addTurn(chatId, { role: "assistant", content: batchResult.text });
            return batchResult.text;
          }
          result = batchResultToRouterResult(batchResult);
          continue;
        }
      }
    }

    log.info(`[router-stream] Executing tool (step ${step + 1}): ${tool}`);
    let toolResult: string;
    const toolStart = Date.now();
    emitHook("tool:before", { chatId, tool, args: safeArgs }).catch(() => {});
    try {
      // Timeout individual tool execution — browser/image tools get extra time
      const isSlow = tool.startsWith("browser.") || tool.startsWith("image.") || tool.startsWith("video.") || tool === "shell.exec";
      const TOOL_EXEC_TIMEOUT = isSlow ? 180_000 : 120_000;
      const execPromise = skill.execute(safeArgs);
      const execTimeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Tool "${tool}" execution timed out (${TOOL_EXEC_TIMEOUT / 1000}s)`)), TOOL_EXEC_TIMEOUT)
      );
      toolResult = await Promise.race([execPromise, execTimeout]);
      emitHook("tool:after", { chatId, tool, durationMs: Date.now() - toolStart, success: true }).catch(() => {});
    } catch (err) {
      emitHook("tool:after", { chatId, tool, durationMs: Date.now() - toolStart, success: false, error: String(err) }).catch(() => {});
      const errorMsg = `Tool "${tool}" failed: ${err instanceof Error ? err.message : String(err)}`;
      log.error(`[router-stream] ${errorMsg}`);
      streamToolHistory.push({ tool, result: `ERROR: ${errorMsg}` });
      if (useOllamaRouterStream) {
        const ollamaNext = await runOllamaToolRouter(chatId, userMessage, streamToolHistory, userIsAdmin);
        if (ollamaNext.type === "tool_call" && ollamaNext.tool) {
          result = { type: "tool_call" as const, text: "", tool: ollamaNext.tool, args: ollamaNext.args || {} };
          continue;
        }
        break;
      }
      const followUp = `[Tool "${tool}" error]:\n${errorMsg}`;
      addTurn(chatId, { role: "assistant", content: `[called ${tool}]` });
      addTurn(chatId, { role: "user", content: followUp });
      const batchResult = await runClaude(chatId, followUp, userIsAdmin, streamFollowUpModel);
      if (batchResult.type === "message") {
        const text = batchResult.text || "Désolé, je n'ai pas pu répondre.";
        addTurn(chatId, { role: "assistant", content: text });
        return text;
      }
      result = batchResultToRouterResult(batchResult);
      continue;
    }

    log.info(`[router-stream] Tool ${tool} completed (${toolResult.length} chars)`);
    streamToolHistory.push({ tool, result: toolResult });
    const sPreview = toolResult.length > 200 ? toolResult.slice(0, 200) + "..." : toolResult;
    await safeProgress(chatId, `⚙️ **${tool}**\n\`\`\`\n${sPreview}\n\`\`\``);

    // --- HYBRID ROUTING: use Ollama ($0) for tool routing decisions ---
    if (useOllamaRouterStream) {
      log.info(`[router-stream] 🦙 Asking Ollama for next step (step ${step + 1})...`);
      const ollamaNext = await runOllamaToolRouter(chatId, userMessage, streamToolHistory, userIsAdmin);

      if (ollamaNext.type === "tool_call" && ollamaNext.tool) {
        log.info(`[router-stream] 🦙 Ollama requests next tool: ${ollamaNext.tool}`);
        addTurn(chatId, { role: "assistant", content: `[called ${tool}]` });
        result = { type: "tool_call" as const, text: "", tool: ollamaNext.tool, args: ollamaNext.args || {} };
        continue;
      }

      log.info(`[router-stream] 🦙 Ollama says task is complete — sending to Opus for final response`);
      break;
    }

    // --- FALLBACK: use Sonnet for tool follow-ups (original behavior) ---
    const sSchemaHint = getSkillSchema(tool);
    const sReflectionSuffix = `\n\nÉvalue ce résultat et AGIS:\n→ Tâche complète? Envoie un message FINAL résumant ce qui a été fait à Nicolas. OBLIGATOIRE.\n→ Prochaine étape nécessaire? Appelle le tool suivant IMMÉDIATEMENT.\n→ Erreur? Diagnostique et essaie une alternative.\nRAPPEL: Tu DOIS terminer par un message texte lisible pour Nicolas. JAMAIS terminer sur un tool_call sans réponse.`;
    const followUp = sSchemaHint
      ? `[Tool "${tool}" — schema: ${sSchemaHint}]\n${toolResult}${sReflectionSuffix}`
      : `[Tool "${tool}" résultat]:\n${toolResult}${sReflectionSuffix}`;
    addTurn(chatId, { role: "assistant", content: `[called ${tool}]` });
    addTurn(chatId, { role: "user", content: followUp });

    log.info(`[router-stream] Feeding tool result to Claude (step ${step + 1}, ${modelLabel("sonnet")})...`);
    const batchResult = await runClaude(chatId, followUp, userIsAdmin, streamFollowUpModel);
    log.info(`[router-stream] Claude follow-up type: ${batchResult.type}, text: ${(batchResult.text || "").length} chars`);
    if (batchResult.type === "message") {
      const text = batchResult.text?.trim() || "Désolé, je n'ai pas pu générer de réponse.";
      addTurn(chatId, { role: "assistant", content: text });
      backgroundExtract(chatId, userMessage, text);
      log.info(`[router-stream] Tool chain complete — returning ${text.length} chars`);
      return text;
    }
    result = batchResultToRouterResult(batchResult);
  }

  // --- HYBRID FINAL RESPONSE: Opus crafts the conversational reply from tool results ---
  if (useOllamaRouterStream && streamToolHistory.length > 0) {
    log.info(`[router-stream] 🎯 Opus final response — summarizing ${streamToolHistory.length} tool results`);
    const toolSummary = streamToolHistory.map(t => `• ${t.tool}: ${t.result.slice(0, 500)}`).join("\n");
    const finalPrompt = `[RÉSULTATS DES OUTILS — résume à Nicolas de façon concise et naturelle]\nMessage original: "${userMessage}"\n\n${toolSummary}\n\nRédige une réponse finale CONCISE pour Nicolas. Pas de tool_call. Texte seulement.`;
    addTurn(chatId, { role: "user", content: finalPrompt });
    const finalResult = await runClaude(chatId, finalPrompt, userIsAdmin, streamClaudeModel);
    const finalText = finalResult.type === "message" && finalResult.text?.trim()
      ? finalResult.text
      : `J'ai exécuté ${streamToolHistory.length} outils. Résultats:\n${streamToolHistory.map(t => `• ${t.tool}: OK`).join("\n")}`;
    addTurn(chatId, { role: "assistant", content: finalText });
    backgroundExtract(chatId, userMessage, finalText);
    return finalText;
  }

  if (result.type === "tool_call") {
    log.warn(`[router-stream] Chain limit reached (${config.maxToolChain} steps) — forcing final summary`);
    const summaryPrompt = `[SYSTEM] La chaîne de tools a atteint la limite. Résume ce que tu as accompli et ce qui reste à faire. NE fais PAS d'autre tool_call — réponds en texte seulement.`;
    addTurn(chatId, { role: "user", content: summaryPrompt });
    const summaryResult = await runClaude(chatId, summaryPrompt, userIsAdmin, streamFollowUpModel);
    const summaryText = summaryResult.type === "message" && summaryResult.text?.trim()
      ? summaryResult.text
      : `J'ai exécuté ${config.maxToolChain} étapes. Le dernier outil en attente était: ${result.tool}. Réessaie pour continuer.`;
    addTurn(chatId, { role: "assistant", content: summaryText });
    backgroundExtract(chatId, userMessage, summaryText);
    return summaryText;
  }

  const text = result.type === "message" ? (result.text || "(unexpected state)") : "(unexpected state)";
  addTurn(chatId, { role: "assistant", content: text });
  log.info(`[router-stream] Returning final text: ${text.length} chars`);
  return text;
}

/** Run Claude stream and return a promise that resolves with the result. */
function runClaudeStreamAsync(
  chatId: number,
  userMessage: string,
  isAdminUser: boolean,
  draft: DraftController,
  modelOverride?: string
): Promise<StreamResult> {
  return new Promise<StreamResult>((resolve, reject) => {
    let draftSuppressed = false;
    runClaudeStream(chatId, userMessage, isAdminUser, {
      onDelta(text: string) {
        if (draftSuppressed) return;
        // Detect tool_call JSON appearing anywhere in the stream
        // If found, suppress further draft updates — main flow handles cancel
        if (text.includes('{"type":"tool_call"')) {
          draftSuppressed = true;
          return;
        }
        draft.update(text).catch(() => {});
      },
      onComplete(result: StreamResult) {
        resolve(result);
      },
      onError(error: Error) {
        reject(error);
      },
    }, modelOverride);
  });
}

/** Convert a batch ParsedResult to the router's internal format. */
function batchResultToRouterResult(r: { type: string; text?: string; tool?: string; args?: Record<string, unknown> }) {
  if (r.type === "tool_call") {
    return { type: "tool_call" as const, text: "", tool: r.tool || "", args: r.args || {} };
  }
  return { type: "message" as const, text: (r as any).text || "", tool: "", args: {} };
}
