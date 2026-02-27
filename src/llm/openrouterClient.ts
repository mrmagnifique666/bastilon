/**
 * OpenRouter LLM client — unified gateway to 100+ models via OpenAI-compatible API.
 * Default free models: deepseek/deepseek-r1-0528:free, meta-llama/llama-3.3-70b-instruct:free
 *
 * runOpenRouter()     — text-only (simple fallback)
 * runOpenRouterChat() — full tool chain (agents, user messages)
 */
import { config } from "../config/env.js";
import { log } from "../utils/log.js";
import { logTokens, enforceRateDelay, markCallComplete } from "./tokenTracker.js";
import { getTurns } from "../storage/store.js";
import { getSkillsForOllama } from "../skills/loader.js";
import { buildSystemInstruction } from "./gemini.js";
import { executeToolCall } from "./shared/toolExecutor.js";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// --- Types ---

interface ORMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ORToolCall[];
  tool_call_id?: string;
}

interface ORToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface ORTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface ORResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: ORToolCall[];
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface OpenRouterChatOptions {
  chatId: number;
  userMessage: string;
  isAdmin: boolean;
  userId: number;
  onToolProgress?: (chatId: number, msg: string) => Promise<void>;
}

// --- Convert Ollama tool format to OpenAI format ---
function convertToolsToOpenAI(ollamaTools: Array<{
  type: string;
  function: { name: string; description: string; parameters: { type: string; properties: Record<string, any>; required?: string[] } };
}>): ORTool[] {
  return ollamaTools.map(t => ({
    type: "function" as const,
    function: {
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    },
  }));
}

// --- API call ---
async function callOpenRouterAPI(messages: ORMessage[], tools?: ORTool[]): Promise<ORResponse> {
  if (!config.openrouterApiKey) throw new Error("OPENROUTER_API_KEY not configured");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.openrouterTimeoutMs);

  try {
    await enforceRateDelay("openrouter");

    const body: Record<string, unknown> = {
      model: config.openrouterModel,
      messages,
      max_tokens: 4096,
      temperature: 0.7,
    };
    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = "auto";
    }

    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.openrouterApiKey}`,
        "HTTP-Referer": "https://bastilon.org",
        "X-Title": "Kingston AI",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(`OpenRouter API ${res.status}: ${errBody.slice(0, 300)}`);
    }

    const data = (await res.json()) as ORResponse;
    const tokens = data.usage;
    if (tokens) {
      logTokens("openrouter", tokens.prompt_tokens, tokens.completion_tokens);
    }
    markCallComplete("openrouter");
    return data;
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`OpenRouter request timed out (${config.openrouterTimeoutMs / 1000}s)`);
    }
    throw err;
  }
}

// --- Simple text-only completion ---

/**
 * Run a simple completion via OpenRouter API.
 * Returns the assistant's text response.
 */
export async function runOpenRouter(
  systemPrompt: string,
  userMessage: string,
  options?: {
    model?: string;
    maxTokens?: number;
    temperature?: number;
    messages?: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  },
): Promise<string> {
  const messages: ORMessage[] = options?.messages?.map(m => ({ ...m, content: m.content })) || [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ];

  const data = await callOpenRouterAPI(messages);
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("No content in OpenRouter response");

  log.info(`[openrouter] ${config.openrouterModel} — ${content.length} chars`);
  return content;
}

/**
 * Run OpenRouter with full tool chain support via OpenAI-compatible API.
 * Uses the same tool infrastructure as Ollama/Groq.
 */
export async function runOpenRouterChat(options: OpenRouterChatOptions): Promise<string> {
  const { chatId, userMessage, isAdmin: userIsAdmin, userId, onToolProgress } = options;

  const systemPrompt = buildSystemInstruction(userIsAdmin, chatId, userMessage);
  const ollamaTools = getSkillsForOllama(userMessage);
  const tools = convertToolsToOpenAI(ollamaTools);

  // Build conversation history
  const messages: ORMessage[] = [
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

  // Add current user message
  messages.push({ role: "user", content: userMessage });

  log.info(`[openrouter-chat] 🌐 Sending to ${config.openrouterModel} (chatId=${chatId}, tools=${tools.length}): ${userMessage.slice(0, 100)}...`);

  for (let step = 0; step < config.maxToolChain; step++) {
    log.debug(`[openrouter-chat] Calling API (${messages.length} messages, ${tools.length} tools)`);
    const data = await callOpenRouterAPI(messages, tools);

    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error("No message in OpenRouter response");

    // No tool calls — return the text response
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      const text = (msg.content || "").trim();
      if (!text) throw new Error("OpenRouter chat returned empty response");
      log.info(`[openrouter-chat] 🌐 Response (${text.length} chars, ${step} tool steps)`);
      return text;
    }

    // Add assistant message with tool_calls to history
    messages.push({
      role: "assistant",
      content: msg.content || null,
      tool_calls: msg.tool_calls,
    });

    // Execute all tool calls in parallel
    const results = await Promise.all(
      msg.tool_calls.map(tc => {
        let rawArgs: Record<string, unknown> = {};
        try { rawArgs = JSON.parse(tc.function.arguments || "{}"); } catch { rawArgs = {}; }
        return executeToolCall(
          { toolName: tc.function.name, rawArgs, callId: tc.id },
          { chatId, userId, provider: "openrouter-chat", onToolProgress, step, maxSteps: config.maxToolChain }
        );
      })
    );
    for (const result of results) {
      messages.push({ role: "tool", content: result.content, tool_call_id: result.tool_call_id });
    }
  }

  // Max tool chain reached — get final response without tools
  log.warn(`[openrouter-chat] Max tool chain (${config.maxToolChain}) reached, getting final response`);
  const finalData = await callOpenRouterAPI(messages);
  const finalText = (finalData.choices?.[0]?.message?.content || "").trim();
  return finalText || "J'ai effectué les actions demandées.";
}

/**
 * Check if OpenRouter is available (API key configured).
 */
export function isOpenRouterAvailable(): boolean {
  return !!config.openrouterApiKey;
}
