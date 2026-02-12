/**
 * Groq LLM client — free cloud tier via OpenAI-compatible API.
 * Models: llama-3.3-70b-versatile (default), mixtral-8x7b-32768, etc.
 * Free tier: 30 req/min, 14.4K tokens/min, 500K tokens/day.
 *
 * runGroq()     — text-only (simple fallback)
 * runGroqChat() — full tool chain (user messages, agents)
 */
import { config } from "../config/env.js";
import { log } from "../utils/log.js";
import { logTokens, enforceRateDelay, markCallComplete } from "./tokenTracker.js";
import { getTurns } from "../storage/store.js";
import { getSkillsForOllama } from "../skills/loader.js";
import { buildSystemInstruction } from "./gemini.js";
import { executeToolCall } from "./shared/toolExecutor.js";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

// --- Types ---

interface GroqMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: GroqToolCall[];
  tool_call_id?: string;
}

interface GroqToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface GroqTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface GroqResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: GroqToolCall[];
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface GroqChatOptions {
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
}>): GroqTool[] {
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
async function callGroqAPI(messages: GroqMessage[], tools?: GroqTool[]): Promise<GroqResponse> {
  if (!config.groqApiKey) throw new Error("GROQ_API_KEY not configured");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.groqTimeoutMs);

  try {
    await enforceRateDelay("groq");

    const body: Record<string, unknown> = {
      model: config.groqModel,
      messages,
      max_tokens: 4096,
      temperature: 0.7,
    };
    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = "auto";
    }

    const res = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.groqApiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(`Groq API ${res.status}: ${errBody.slice(0, 300)}`);
    }

    const data = (await res.json()) as GroqResponse;
    const tokens = data.usage;
    if (tokens) {
      logTokens("groq", tokens.prompt_tokens, tokens.completion_tokens);
    }
    markCallComplete("groq");
    return data;
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Groq request timed out (${config.groqTimeoutMs / 1000}s)`);
    }
    throw err;
  }
}

// --- Simple text-only completion (legacy) ---

/**
 * Run a simple completion via Groq API.
 * Returns the assistant's text response.
 */
export async function runGroq(
  systemPrompt: string,
  userMessage: string,
  options?: {
    model?: string;
    maxTokens?: number;
    temperature?: number;
    messages?: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  },
): Promise<string> {
  const messages: GroqMessage[] = options?.messages?.map(m => ({ ...m, content: m.content })) || [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ];

  const data = await callGroqAPI(messages);
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("No content in Groq response");

  log.info(`[groq] ${config.groqModel} — ${content.length} chars`);
  return content;
}

/**
 * Run Groq with full tool chain support via OpenAI-compatible API.
 * Uses the same tool infrastructure as Ollama — getSkillsForOllama, normalizeArgs, etc.
 * Designed for user messages — fast ($0) alternative to Claude CLI.
 */
export async function runGroqChat(options: GroqChatOptions): Promise<string> {
  const { chatId, userMessage, isAdmin: userIsAdmin, userId, onToolProgress } = options;

  const systemPrompt = buildSystemInstruction(userIsAdmin, chatId);
  const ollamaTools = getSkillsForOllama(userMessage);
  const tools = convertToolsToOpenAI(ollamaTools);

  // Build conversation history
  const messages: GroqMessage[] = [
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

  log.info(`[groq-chat] ⚡ Sending to ${config.groqModel} (chatId=${chatId}, tools=${tools.length}): ${userMessage.slice(0, 100)}...`);

  for (let step = 0; step < config.maxToolChain; step++) {
    log.debug(`[groq-chat] Calling API (${messages.length} messages, ${tools.length} tools)`);
    const data = await callGroqAPI(messages, tools);

    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error("No message in Groq response");

    // No tool calls — return the text response
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      const text = (msg.content || "").trim();
      if (!text) throw new Error("Groq chat returned empty response");
      log.info(`[groq-chat] ⚡ Response (${text.length} chars, ${step} tool steps)`);
      return text;
    }

    // Add assistant message with tool_calls to history
    messages.push({
      role: "assistant",
      content: msg.content || null,
      tool_calls: msg.tool_calls,
    });

    // Process each tool call via shared executor
    for (const tc of msg.tool_calls) {
      let rawArgs: Record<string, unknown> = {};
      try { rawArgs = JSON.parse(tc.function.arguments || "{}"); } catch { rawArgs = {}; }

      const result = await executeToolCall(
        { toolName: tc.function.name, rawArgs, callId: tc.id },
        { chatId, userId, provider: "groq-chat", onToolProgress, step, maxSteps: config.maxToolChain }
      );
      messages.push({ role: "tool", content: result.content, tool_call_id: result.tool_call_id });
    }
  }

  // Max tool chain reached — get final response without tools
  log.warn(`[groq-chat] Max tool chain (${config.maxToolChain}) reached, getting final response`);
  const finalData = await callGroqAPI(messages);
  const finalText = (finalData.choices?.[0]?.message?.content || "").trim();
  return finalText || "J'ai effectué les actions demandées.";
}

/**
 * Check if Groq is available (API key configured).
 */
export function isGroqAvailable(): boolean {
  return !!config.groqApiKey;
}
