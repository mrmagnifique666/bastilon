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
import { runOllama, runOllamaChat, isOllamaAvailable } from "../llm/ollamaClient.js";
import { runGroq, isGroqAvailable } from "../llm/groqClient.js";
import { addTurn, logError, getTurns, clearSession } from "../storage/store.js";
import { autoCompact } from "./compaction.js";
import { config } from "../config/env.js";
import { log } from "../utils/log.js";
import { extractAndStoreMemories } from "../memory/semantic.js";
import { selectModel, getModelId, modelLabel, type ModelTier } from "../llm/modelSelector.js";
import { isClaudeRateLimited, detectAndSetRateLimit, clearRateLimit, rateLimitRemainingMinutes, shouldProbeRateLimit, markProbeAttempt } from "../llm/rateLimitState.js";
import type { DraftController } from "../bot/draftMessage.js";

const GROQ_SYSTEM_PROMPT = [
  "Tu es Kingston, un assistant IA personnel pour Nicolas.",
  "Tu es concis, amical et tu réponds en français par défaut.",
  "Tu ne peux PAS exécuter d'outils — réponds uniquement avec du texte.",
  "Si on te demande quelque chose qui nécessite un outil, dis que tu vas transmettre la demande.",
].join(" ");

/** Try Groq as text-only fallback. Returns null on failure. */
async function tryGroqFallback(chatId: number, userMessage: string, label: string): Promise<string | null> {
  if (!isGroqAvailable()) return null;
  try {
    log.info(`[router] ⚡ Groq fallback (${label}): ${userMessage.slice(0, 100)}...`);
    const result = await runGroq(GROQ_SYSTEM_PROMPT, userMessage);
    log.info(`[router] Groq fallback success (${result.length} chars)`);
    return result;
  } catch (err) {
    log.warn(`[router] Groq fallback failed: ${err instanceof Error ? err.message : String(err)}`);
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
    .catch(err => log.debug(`[memory] Extraction failed: ${err instanceof Error ? err.message : String(err)}`));
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
  // Agents (chatId 100-106) always use Ollama-first path to preserve Gemini rate limit for user
  if (chatId >= 100 && chatId <= 106) return false;
  return true;
}

/**
 * Fallback chain when Claude CLI is unavailable (rate-limited or down).
 * Tries: Gemini Flash (full tool chain) → Ollama-chat (tool chain) → Groq (text-only) → error message.
 * Ensures the bot NEVER goes silent.
 */
async function fallbackWithoutClaude(
  chatId: number,
  userMessage: string,
  userIsAdmin: boolean,
  userId: number,
  remainingMinutes: number
): Promise<string> {
  // --- Try Gemini Flash (supports full tool chain, $0) ---
  if (config.geminiApiKey) {
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
      log.info(`[router] Gemini fallback success (${geminiResult.length} chars)`);
      return geminiResult;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.warn(`[router] Gemini fallback also failed: ${errMsg}`);
    }
  }

  // --- Try Ollama with tools (local, full tool chain, always available) ---
  if (config.ollamaEnabled) {
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
        log.info(`[router] Ollama-chat fallback success (${ollamaResult.length} chars)`);
        return ollamaResult;
      }
    } catch (err) {
      log.warn(`[router] Ollama-chat fallback failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // --- Try Groq (text-only, llama-3.3-70b, $0) ---
  const groqFallback = await tryGroqFallback(chatId, userMessage, "Claude+Gemini+Ollama down");
  if (groqFallback) {
    await safeProgress(chatId, `⚡ Mode Groq (services principaux indisponibles ~${remainingMinutes}min)`);
    addTurn(chatId, { role: "assistant", content: groqFallback });
    backgroundExtract(chatId, userMessage, groqFallback);
    return groqFallback;
  }

  // --- All models down — return a useful error instead of silence ---
  const msg = `⚠️ Tous les modèles sont temporairement indisponibles. Claude se réinitialise dans ~${remainingMinutes} minutes. Réessaie bientôt.`;
  log.error(`[router] ALL models unavailable — Claude (rate-limited), Gemini (${config.geminiApiKey ? "failed" : "no key"}), Ollama (${config.ollamaEnabled ? "failed" : "disabled"}), Groq (${isGroqAvailable() ? "failed" : "no key"})`);
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
export async function handleMessage(
  chatId: number,
  userMessage: string,
  userId: number,
  contextHint: "user" | "scheduler" = "user"
): Promise<string> {
  const response = await handleMessageInner(chatId, userMessage, userId, contextHint);
  // Fire-and-forget compaction AFTER response — never blocks the user
  backgroundCompact(chatId, userId);
  return response;
}

async function handleMessageInner(
  chatId: number,
  userMessage: string,
  userId: number,
  contextHint: "user" | "scheduler" = "user"
): Promise<string> {
  const userIsAdmin = isAdmin(userId);

  // Store user turn
  addTurn(chatId, { role: "user", content: userMessage });

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
    }
  }

  // --- Claude CLI path (fallback or agents) ---
  // Select model tier based on message content
  const tier = selectModel(userMessage, contextHint, chatId);
  const model = getModelId(tier);

  // --- Ollama path ---
  if (tier === "ollama") {
    // Agents (chatId 100-106) and scheduler tasks that need tools get full tool chain
    const isAgent = chatId >= 100 && chatId <= 106;
    const needsTools = userMessage.startsWith("[SCHEDULER:") || userMessage.startsWith("[AGENT:");

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
        return result;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.warn(`[router] Ollama-chat failed for ${isAgent ? `agent ${chatId}` : "scheduler"}, falling back to Gemini: ${errMsg}`);
        // Fallback to Gemini (free) instead of Haiku (burns Claude quota)
        try {
          const geminiResult = await runGemini({ chatId, userMessage, isAdmin: userIsAdmin, userId });
          if (geminiResult) {
            addTurn(chatId, { role: "assistant", content: geminiResult });
            backgroundExtract(chatId, userMessage, geminiResult);
            return geminiResult;
          }
        } catch { /* Gemini failed too */ }
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
      return ollamaResult.text;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.warn(`[router] Ollama failed, trying Groq: ${errMsg}`);
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

  // --- Groq path (text-only, greetings/heartbeats when Ollama disabled) ---
  if (tier === "groq") {
    const groqResult = await tryGroqFallback(chatId, userMessage, "groq-tier");
    if (groqResult) {
      addTurn(chatId, { role: "assistant", content: groqResult });
      backgroundExtract(chatId, userMessage, groqResult);
      return groqResult;
    }
    // Groq failed — fall through to Haiku via Claude CLI
    log.warn(`[router] Groq tier failed, falling back to Haiku`);
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
      return await fallbackWithoutClaude(chatId, userMessage, userIsAdmin, userId, remaining);
    }
  }

  // First pass: Claude
  log.info(`[router] ${modelLabel(tier)} Sending to Claude (admin=${userIsAdmin}): ${userMessage.slice(0, 100)}...`);
  let result = await runClaude(chatId, userMessage, userIsAdmin, model);
  log.info(`[router] Claude responded with type: ${result.type}`);

  if (result.type === "message") {
    // --- Rate limit detection: catch it before passing to user ---
    if (result.text && detectAndSetRateLimit(result.text)) {
      log.warn(`[router] Claude rate-limited — falling back for this message`);
      const remaining = rateLimitRemainingMinutes();
      return await fallbackWithoutClaude(chatId, userMessage, userIsAdmin, userId, remaining);
    }

    const isEmpty = !result.text || !result.text.trim() || result.text.includes("(Claude returned an empty response)");
    if (isEmpty) {
      // Auto-recovery: clear corrupt session and retry with fresh context
      log.warn(`[router] Empty CLI response — clearing session ${chatId} and retrying`);
      clearSession(chatId);
      result = await runClaude(chatId, userMessage, userIsAdmin, model);
      log.info(`[router] Retry responded with type: ${result.type}`);

      // Check retry for rate limit too
      if (result.type === "message" && result.text && detectAndSetRateLimit(result.text)) {
        log.warn(`[router] Claude rate-limited on retry — falling back`);
        return await fallbackWithoutClaude(chatId, userMessage, userIsAdmin, userId, rateLimitRemainingMinutes());
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
      // Successful Claude response — clear any stale rate limit
      clearRateLimit();
      addTurn(chatId, { role: "assistant", content: result.text });
      backgroundExtract(chatId, userMessage, result.text);
      return result.text;
    }
  } else {
    // Tool call succeeded — Claude is working, clear rate limit
    clearRateLimit();
  }

  // Tool chaining loop — use sonnet for follow-ups (keeps intelligence + personality)
  const followUpModel = getModelId("sonnet");
  for (let step = 0; step < config.maxToolChain; step++) {
    if (result.type !== "tool_call") break;

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

    // Agent chatId fix: agents use fake chatIds (100-106) for session isolation.
    // When they call telegram.send/voice, replace with the real admin chatId.
    if (chatId >= 100 && chatId <= 106 && tool.startsWith("telegram.") && config.adminChatId > 0) {
      safeArgs.chatId = String(config.adminChatId);
      log.debug(`[router] Agent ${chatId}: rewrote chatId to admin ${config.adminChatId} for ${tool}`);
    }

    // Hard block: agents (chatId 100-106) cannot use browser.* tools — they open visible windows
    if (chatId >= 100 && chatId <= 106 && tool.startsWith("browser.")) {
      const msg = `Tool "${tool}" is blocked for agents — use web.search instead.`;
      log.warn(`[router] Agent chatId=${chatId} tried to call ${tool} — blocked`);
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

    // Look up skill — feed error back to Claude so it can retry
    const skill = getSkill(tool);
    if (!skill) {
      const errorMsg = `Error: Unknown tool "${tool}". Check the tool catalog and try again.`;
      log.warn(`[router] ${errorMsg}`);
      logError(errorMsg, "router:unknown_tool", tool);
      await safeProgress(chatId, `❌ Unknown tool: ${tool}`);
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

    // Validate args — feed error back to Claude so it can fix & retry
    const validationError = validateArgs(safeArgs, skill.argsSchema);
    if (validationError) {
      const errorMsg = `Tool "${tool}" argument error: ${validationError}. Fix the arguments and try again.`;
      log.warn(`[router] ${errorMsg}`);
      logError(errorMsg, "router:validation", tool);
      await safeProgress(chatId, `❌ Arg error on ${tool}`);
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

    // Block placeholder hallucinations in outbound messages (agents only)
    if (chatId >= 100 && chatId <= 106) {
      const outboundTools = ["telegram.send", "mind.ask", "moltbook.post", "moltbook.comment", "content.publish"];
      if (outboundTools.includes(tool)) {
        const textArg = String(safeArgs.text || safeArgs.content || safeArgs.question || "");
        const placeholderRe = /\[[A-ZÀ-ÜÉÈ][A-ZÀ-ÜÉÈ\s_\-]{2,}\]/;
        if (placeholderRe.test(textArg)) {
          log.warn(`[router] Blocked ${tool} — placeholder detected: "${textArg.slice(0, 120)}"`);
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

    // Execute skill — feed errors back to Claude so it can adapt
    log.info(`Executing tool (step ${step + 1}/${config.maxToolChain}): ${tool}`);
    let toolResult: string;
    try {
      toolResult = await skill.execute(safeArgs);
    } catch (err) {
      const errorMsg = `Tool "${tool}" execution failed: ${err instanceof Error ? err.message : String(err)}`;
      log.error(errorMsg);
      logError(err instanceof Error ? err : errorMsg, `router:exec:${tool}`, tool);
      await safeProgress(chatId, `❌ ${tool} failed`);
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

    // Heartbeat: send intermediate progress to Telegram (skip dashboard/agent chatIds)
    const preview = toolResult.length > 200 ? toolResult.slice(0, 200) + "..." : toolResult;
    await safeProgress(chatId, `⚙️ **${tool}**\n\`\`\`\n${preview}\n\`\`\``);

    // Feed tool result back to Claude for next step or final answer
    // Include skill schema hint so Claude knows the exact params for this tool
    const schemaHint = getSkillSchema(tool);
    const followUp = schemaHint
      ? `[Tool "${tool}" — schema: ${schemaHint}]\n${toolResult}`
      : `[Tool "${tool}" returned]:\n${toolResult}`;
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

  // If we exhausted the chain limit and still got a tool_call
  if (result.type === "tool_call") {
    const msg = `Reached tool chain limit (${config.maxToolChain} steps). Last pending tool: ${result.tool}.`;
    logError(msg, "router:chain_limit");
    await safeProgress(chatId, `⚠️ Chain limit reached (${config.maxToolChain} steps)`);
    addTurn(chatId, { role: "assistant", content: msg });
    return msg;
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

  addTurn(chatId, { role: "user", content: userMessage });

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
    }
  }

  // --- Claude CLI streaming path (fallback or agents) ---
  // Select model tier based on message content
  const tier = selectModel(userMessage, "user", chatId);
  const model = getModelId(tier);

  // --- Ollama path ---
  if (tier === "ollama") {
    // Agents and scheduler tasks get full tool chain
    const isAgentStream = chatId >= 100 && chatId <= 106;
    const needsToolsStream = userMessage.startsWith("[SCHEDULER:") || userMessage.startsWith("[AGENT:");

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
        log.warn(`[router-stream] Ollama-chat failed for ${isAgentStream ? `agent ${chatId}` : "scheduler"}: ${err instanceof Error ? err.message : String(err)}`);
        await draft.cancel();
        // Fallback to Gemini (free) instead of Haiku
        try {
          const geminiResult = await runGemini({ chatId, userMessage, isAdmin: userIsAdmin, userId });
          if (geminiResult) {
            addTurn(chatId, { role: "assistant", content: geminiResult });
            return geminiResult;
          }
        } catch { /* Gemini failed too */ }
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
      return ollamaResult.text;
    } catch (err) {
      log.warn(`[router-stream] Ollama failed, trying Groq: ${err instanceof Error ? err.message : String(err)}`);
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

  // --- Groq path (text-only, greetings/heartbeats when Ollama disabled) ---
  if (tier === "groq") {
    const groqResult = await tryGroqFallback(chatId, userMessage, "stream-groq-tier");
    if (groqResult) {
      await draft.update(groqResult);
      await draft.finalize();
      addTurn(chatId, { role: "assistant", content: groqResult });
      backgroundExtract(chatId, userMessage, groqResult);
      return groqResult;
    }
    // Groq failed — fall through to Haiku
    await draft.cancel();
    log.warn(`[router-stream] Groq tier failed, falling back to Haiku`);
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
      const fallbackResult = await fallbackWithoutClaude(chatId, userMessage, userIsAdmin, userId, remaining);
      return fallbackResult;
    }
  }

  log.info(`[router] ${modelLabel(tier)} Streaming to Claude (admin=${userIsAdmin}): ${userMessage.slice(0, 100)}...`);

  // First pass: try streaming (with safety timeout to prevent hanging)
  let streamResult: StreamResult;
  try {
    const streamPromise = runClaudeStreamAsync(chatId, userMessage, userIsAdmin, draft, model);
    const safetyTimeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Stream response safety timeout")), config.cliTimeoutMs + 10_000)
    );
    streamResult = await Promise.race([streamPromise, safetyTimeout]);
  } catch (streamErr) {
    // Streaming failed (empty response, timeout, process crash) — fall back to batch mode
    log.warn(`[router-stream] Stream failed: ${streamErr instanceof Error ? streamErr.message : String(streamErr)} — clearing session and falling back to batch`);
    await draft.cancel();
    // Clear potentially corrupt session before retry
    clearSession(chatId);
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
      await draft.cancel();
      const fallbackResult = await fallbackWithoutClaude(chatId, userMessage, userIsAdmin, userId, rateLimitRemainingMinutes());
      return fallbackResult;
    }

    // Guard against empty responses sneaking through
    if (!streamResult.text || !streamResult.text.trim()) {
      // Auto-recovery: clear session and retry once
      log.warn(`[router-stream] Empty stream response — clearing session and retrying`);
      await draft.cancel();
      clearSession(chatId);
      const retryResult = await runClaude(chatId, userMessage, userIsAdmin, model);

      // Check retry for rate limit
      if (retryResult.type === "message" && retryResult.text && detectAndSetRateLimit(retryResult.text)) {
        return await fallbackWithoutClaude(chatId, userMessage, userIsAdmin, userId, rateLimitRemainingMinutes());
      }

      const retryText = retryResult.type === "message" && retryResult.text?.trim()
        ? retryResult.text
        : "Désolé, je n'ai pas pu générer de réponse. Réessaie.";
      addTurn(chatId, { role: "assistant", content: retryText });
      backgroundExtract(chatId, userMessage, retryText);
      return retryText;
    }
    // Successful response — clear stale rate limit
    clearRateLimit();
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

  // Tool chaining loop — sonnet for follow-ups (keeps intelligence + personality)
  // Global timeout prevents the chain from blocking the chat lock forever.
  const TOOL_CHAIN_TIMEOUT_MS = 180_000; // 3 minutes max for entire tool chain
  const toolChainStart = Date.now();
  const streamFollowUpModel = getModelId("sonnet");
  for (let step = 0; step < config.maxToolChain; step++) {
    if (result.type !== "tool_call") break;

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

    // Agent chatId fix: rewrite fake agent chatIds (100-106) to real admin chatId for telegram.*
    if (chatId >= 100 && chatId <= 106 && tool.startsWith("telegram.") && config.adminChatId > 0) {
      safeArgs.chatId = String(config.adminChatId);
      log.debug(`[router-stream] Agent ${chatId}: rewrote chatId to admin ${config.adminChatId} for ${tool}`);
    }

    // Hard block: agents (chatId 100-106) cannot use browser.* tools
    if (chatId >= 100 && chatId <= 106 && tool.startsWith("browser.")) {
      const msg = `Tool "${tool}" is blocked for agents — use web.search instead.`;
      log.warn(`[router] Agent chatId=${chatId} tried to call ${tool} — blocked`);
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

    // Block placeholder hallucinations in outbound messages (agents — streaming path)
    if (chatId >= 100 && chatId <= 106) {
      const outboundTools = ["telegram.send", "mind.ask", "moltbook.post", "moltbook.comment", "content.publish"];
      if (outboundTools.includes(tool)) {
        const textArg = String(safeArgs.text || safeArgs.content || safeArgs.question || "");
        const placeholderRe = /\[[A-ZÀ-ÜÉÈ][A-ZÀ-ÜÉÈ\s_\-]{2,}\]/;
        if (placeholderRe.test(textArg)) {
          log.warn(`[router-stream] Blocked ${tool} — placeholder detected: "${textArg.slice(0, 120)}"`);
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
    try {
      // Timeout individual tool execution (2 minutes max per tool)
      const execPromise = skill.execute(safeArgs);
      const execTimeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Tool "${tool}" execution timed out (120s)`)), 120_000)
      );
      toolResult = await Promise.race([execPromise, execTimeout]);
    } catch (err) {
      const errorMsg = `Tool "${tool}" failed: ${err instanceof Error ? err.message : String(err)}`;
      log.error(`[router-stream] ${errorMsg}`);
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
    const sPreview = toolResult.length > 200 ? toolResult.slice(0, 200) + "..." : toolResult;
    await safeProgress(chatId, `⚙️ **${tool}**\n\`\`\`\n${sPreview}\n\`\`\``);

    // Include skill schema hint so Claude knows the exact params for this tool
    const sSchemaHint = getSkillSchema(tool);
    const followUp = sSchemaHint
      ? `[Tool "${tool}" — schema: ${sSchemaHint}]\n${toolResult}`
      : `[Tool "${tool}" returned]:\n${toolResult}`;
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

  if (result.type === "tool_call") {
    const msg = `Reached tool chain limit (${config.maxToolChain} steps).`;
    log.warn(`[router-stream] ${msg}`);
    addTurn(chatId, { role: "assistant", content: msg });
    return msg;
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
