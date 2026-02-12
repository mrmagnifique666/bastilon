/**
 * Ollama client — local LLM tier.
 *
 * Two modes:
 *   runOllama()     — text-only (heartbeats, greetings) via /api/generate
 *   runOllamaChat() — full tool chain (agents, fallback) via /api/chat
 *
 * Uses the Ollama REST API (localhost:11434) with qwen3:14b or similar.
 * Fallback to Haiku on failure is handled by the router.
 */
import { config } from "../config/env.js";
import { log } from "../utils/log.js";
import { getTurns } from "../storage/store.js";
import { getSkillsForOllama } from "../skills/loader.js";
import { buildSystemInstruction } from "./gemini.js";
import { executeToolCall } from "./shared/toolExecutor.js";
import { logEstimatedTokens } from "./tokenTracker.js";

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
        think: false,
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
    logEstimatedTokens("ollama", message.length + SYSTEM_PROMPT.length, text.length);
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
      logEstimatedTokens("ollama", userMessage.length + systemPrompt.length, text.length);
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
      const result = await executeToolCall(
        { toolName: tc.function.name, rawArgs: tc.function.arguments || {} },
        { chatId, userId, provider: "ollama-chat", onToolProgress, step, maxSteps: config.maxToolChain }
      );
      messages.push({ role: "tool", content: result.content });
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
      think: false,
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
