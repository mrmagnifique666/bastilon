/**
 * Ollama client — local LLM tier.
 *
 * Two modes:
 *   runOllama()     — text-only (heartbeats, greetings) via /api/generate
 *   runOllamaChat() — full tool chain (agents, fallback) via /api/chat
 *
 * Uses the Ollama REST API (localhost:11434) with qwen2.5:14b or similar.
 * Fallback to Haiku on failure is handled by the router.
 */
import { config } from "../config/env.js";
import { log } from "../utils/log.js";
import { getTurns } from "../storage/store.js";
import { isToolPermitted } from "../security/policy.js";
import { getSkill, validateArgs } from "../skills/loader.js";
import { getSkillsForOllama } from "../skills/loader.js";
import { buildSystemInstruction, normalizeArgs } from "./gemini.js";

const SYSTEM_PROMPT = [
  "Tu es Kingston, un assistant IA personnel pour Nicolas.",
  "Tu es concis, amical et tu reponds en francais.",
  "Tu ne peux PAS executer d'outils ou de commandes — reponds uniquement avec du texte.",
  "Si on te demande quelque chose qui necessite un outil, dis que tu vas transmettre la demande.",
].join(" ");

export interface OllamaResult {
  type: "message";
  text: string;
}

/** Check if Ollama is reachable. Non-blocking, returns false on any error. */
export async function isOllamaAvailable(): Promise<boolean> {
  if (!config.ollamaEnabled) return false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const resp = await fetch(`${config.ollamaUrl}/api/tags`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    return resp.ok;
  } catch {
    return false;
  }
}

/** Run a simple text prompt through Ollama. Never returns tool_call. */
export async function runOllama(chatId: number, message: string): Promise<OllamaResult> {
  const url = `${config.ollamaUrl}/api/generate`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);

  try {
    log.info(`[ollama] 🦙 Sending to ${config.ollamaModel} (chatId=${chatId}): ${message.slice(0, 80)}...`);

    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.ollamaModel,
        prompt: message,
        system: SYSTEM_PROMPT,
        stream: false,
        options: { temperature: 0.7, num_predict: 500 },
      }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      throw new Error(`Ollama HTTP ${resp.status}: ${resp.statusText}`);
    }

    const data = await resp.json() as { response?: string; error?: string };

    if (data.error) {
      throw new Error(`Ollama error: ${data.error}`);
    }

    const text = (data.response || "").trim();
    if (!text) {
      throw new Error("Ollama returned empty response");
    }

    log.info(`[ollama] 🦙 Response (${text.length} chars)`);
    return { type: "message", text };
  } finally {
    clearTimeout(timer);
  }
}

// --- Ollama Chat with Tool Chaining ---

/** Options for runOllamaChat — mirrors GeminiOptions */
export interface OllamaChatOptions {
  chatId: number;
  userMessage: string;
  isAdmin: boolean;
  userId: number;
  onToolProgress?: (chatId: number, message: string) => Promise<void>;
}

/** Ollama /api/chat message format */
interface OllamaChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OllamaToolCall[];
}

interface OllamaToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

interface OllamaChatResponse {
  message?: {
    role: string;
    content: string;
    tool_calls?: OllamaToolCall[];
  };
  error?: string;
  done?: boolean;
}

const MAX_TOOL_RESULT_LENGTH = 8000;

/** Detect bracket placeholders like [RÉSUMÉ], [PLACEHOLDER], [DATA HERE] in text */
const PLACEHOLDER_RE = /\[[A-ZÀ-ÜÉÈ][A-ZÀ-ÜÉÈ\s_\-]{2,}\]/;

function containsPlaceholders(text: string): boolean {
  return PLACEHOLDER_RE.test(text);
}

function truncateResult(result: string): string {
  if (result.length <= MAX_TOOL_RESULT_LENGTH) return result;
  return result.slice(0, MAX_TOOL_RESULT_LENGTH) + `\n... [truncated, ${result.length} chars total]`;
}

/**
 * Run Ollama with full tool chain support via /api/chat.
 * Modelled on runGemini() — handles the complete tool loop internally.
 * Designed for agents (chatId 100-106) but works for any caller.
 */
export async function runOllamaChat(options: OllamaChatOptions): Promise<string> {
  const { chatId, userMessage, isAdmin: userIsAdmin, userId, onToolProgress } = options;

  const systemPrompt = buildSystemInstruction(userIsAdmin, chatId);
  const tools = getSkillsForOllama(userMessage);

  // Build conversation history
  const messages: OllamaChatMessage[] = [
    { role: "system", content: systemPrompt },
  ];

  // Load conversation context
  const turns = getTurns(chatId);
  for (const t of turns) {
    messages.push({
      role: t.role === "user" ? "user" : "assistant",
      content: t.content,
    });
  }

  // Cross-channel: include recent voice turns (chatId 5) if not already voice
  if (chatId !== 5) {
    const voiceTurns = getTurns(5).slice(-10);
    if (voiceTurns.length > 0) {
      messages.push({ role: "system", content: "[RECENT VOICE CONVERSATION]\n" +
        voiceTurns.map(t => `${t.role === "user" ? "Nicolas (voice)" : "Kingston"}: ${(t.content || "").slice(0, 200)}`).join("\n"),
      });
    }
  }

  // Add current user message
  messages.push({ role: "user", content: userMessage });

  log.info(`[ollama-chat] 🦙 Sending to ${config.ollamaModel} (chatId=${chatId}, tools=${tools.length}): ${userMessage.slice(0, 100)}...`);

  for (let step = 0; step < config.maxToolChain; step++) {
    const response = await callOllamaChatAPI(messages, tools);

    if (response.error) {
      throw new Error(`Ollama chat error: ${response.error}`);
    }

    const msg = response.message;
    if (!msg) {
      throw new Error("Ollama chat returned no message");
    }

    // No tool calls — return the text response
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      const text = (msg.content || "").trim();
      if (!text) {
        throw new Error("Ollama chat returned empty response");
      }
      log.info(`[ollama-chat] 🦙 Response (${text.length} chars, ${step} tool steps)`);
      return text;
    }

    // Process tool calls
    // Add assistant message with tool_calls to history
    messages.push({
      role: "assistant",
      content: msg.content || "",
      tool_calls: msg.tool_calls,
    });

    for (const tc of msg.tool_calls) {
      const toolName = tc.function.name;
      const rawArgs = tc.function.arguments || {};

      log.info(`[ollama-chat] Tool call (step ${step + 1}): ${toolName}(${JSON.stringify(rawArgs).slice(0, 200)})`);

      // Anti-hallucination: validate tool exists
      const skill = getSkill(toolName);
      if (!skill) {
        log.warn(`[ollama-chat] Unknown tool "${toolName}" — feeding error back`);
        messages.push({
          role: "tool",
          content: `Error: Unknown tool "${toolName}". Check the tool catalog and try again.`,
        });
        continue;
      }

      // Hard block: agents (100-106) cannot use browser.*
      if (chatId >= 100 && chatId <= 106 && toolName.startsWith("browser.")) {
        log.warn(`[ollama-chat] Agent chatId=${chatId} tried to call ${toolName} — blocked`);
        messages.push({
          role: "tool",
          content: `Error: Tool "${toolName}" is blocked for agents — use web.search instead.`,
        });
        continue;
      }

      // Security check
      if (!isToolPermitted(toolName, userId)) {
        const errMsg = `Error: Tool "${toolName}" is not permitted${skill.adminOnly ? " (admin only)" : ""}.`;
        log.warn(`[ollama-chat] ${errMsg}`);
        messages.push({ role: "tool", content: errMsg });
        continue;
      }

      // Normalize args (snake_case → camelCase, auto-inject chatId, type coercion)
      const safeArgs = normalizeArgs(toolName, rawArgs, chatId, skill);

      // Agent chatId fix: agents (100-106) use fake chatIds for session isolation.
      // Rewrite telegram.* targets to the real admin chatId so messages actually deliver.
      if (chatId >= 100 && chatId <= 106 && toolName.startsWith("telegram.") && config.adminChatId > 0) {
        safeArgs.chatId = String(config.adminChatId);
        log.debug(`[ollama-chat] Agent ${chatId}: rewrote chatId to admin ${config.adminChatId} for ${toolName}`);
      }

      // Validate args
      const validationError = validateArgs(safeArgs, skill.argsSchema);
      if (validationError) {
        log.warn(`[ollama-chat] Arg validation failed for ${toolName}: ${validationError}`);
        messages.push({
          role: "tool",
          content: `Error: ${validationError}. Fix the arguments and try again.`,
        });
        continue;
      }

      // Block placeholder hallucinations in outbound messages
      const outboundTools = ["telegram.send", "mind.ask", "moltbook.post", "moltbook.comment", "content.publish"];
      if (outboundTools.includes(toolName)) {
        const textArg = String(safeArgs.text || safeArgs.content || safeArgs.question || "");
        if (containsPlaceholders(textArg)) {
          log.warn(`[ollama-chat] Blocked ${toolName} — placeholder detected: "${textArg.slice(0, 120)}"`);
          messages.push({
            role: "tool",
            content: `Error: Your message contains placeholder brackets like [RÉSUMÉ] instead of real data. Use tools (trading.positions, client.list, etc.) to get REAL data first, then compose the message with actual values. NEVER use [BRACKETS] as placeholders.`,
          });
          continue;
        }
      }

      // Execute skill
      let toolResult: string;
      try {
        log.info(`[ollama-chat] Executing tool (step ${step + 1}/${config.maxToolChain}): ${toolName}`);
        toolResult = await skill.execute(safeArgs);
      } catch (err) {
        const errorMsg = `Tool "${toolName}" execution failed: ${err instanceof Error ? err.message : String(err)}`;
        log.error(`[ollama-chat] ${errorMsg}`);
        messages.push({
          role: "tool",
          content: `Error: ${errorMsg}\n\nBe RESOURCEFUL: Don't give up. Try an alternative tool or approach to achieve the same goal. For example:\n- web.search failed? Try api.call or web.fetch directly.\n- trading.* failed? Try api.call to the Alpaca API.\n- A tool doesn't exist? Use shell.exec or api.call as a workaround.`,
        });
        continue;
      }

      log.debug(`[ollama-chat] Tool result (${toolName}): ${toolResult.slice(0, 200)}`);

      // Progress callback
      if (onToolProgress) {
        const preview = toolResult.length > 200 ? toolResult.slice(0, 200) + "..." : toolResult;
        try {
          await onToolProgress(chatId, `⚙️ **${toolName}**\n\`\`\`\n${preview}\n\`\`\``);
        } catch { /* ignore progress errors */ }
      }

      // Feed result back as tool response
      messages.push({
        role: "tool",
        content: truncateResult(toolResult),
      });
    }
    // Loop continues — Ollama processes tool results
  }

  // Exhausted tool chain
  return `Reached tool chain limit (${config.maxToolChain} steps).`;
}

/** Call Ollama /api/chat endpoint */
async function callOllamaChatAPI(
  messages: OllamaChatMessage[],
  tools: unknown[],
): Promise<OllamaChatResponse> {
  const url = `${config.ollamaUrl}/api/chat`;
  const controller = new AbortController();
  const timeout = config.ollamaTimeoutMs || 120_000;
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const body: Record<string, unknown> = {
      model: config.ollamaModel,
      messages,
      stream: false,
      options: {
        temperature: 0.7,
        num_predict: config.ollamaNumPredict || 2048,
      },
    };

    // Only include tools if there are any
    if (tools.length > 0) {
      body.tools = tools;
    }

    log.debug(`[ollama-chat] Calling /api/chat (${messages.length} messages, ${tools.length} tools)`);

    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!resp.ok) {
      throw new Error(`Ollama HTTP ${resp.status}: ${resp.statusText}`);
    }

    return (await resp.json()) as OllamaChatResponse;
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error(`Ollama chat timeout after ${timeout}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
