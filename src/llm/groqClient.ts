/**
 * Groq LLM client — free cloud tier via OpenAI-compatible API.
 * Models: llama-3.3-70b-versatile (default), mixtral-8x7b-32768, etc.
 * Free tier: 30 req/min, 14.4K tokens/min, 500K tokens/day.
 */
import { config } from "../config/env.js";
import { log } from "../utils/log.js";
import { logTokens, enforceRateDelay, markCallComplete } from "./tokenTracker.js";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

interface GroqMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface GroqResponse {
  choices?: Array<{
    message?: { content?: string };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

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
    messages?: GroqMessage[];
  },
): Promise<string> {
  if (!config.groqApiKey) {
    throw new Error("GROQ_API_KEY not configured");
  }

  const model = options?.model || config.groqModel;
  const maxTokens = options?.maxTokens || 2048;
  const temperature = options?.temperature ?? 0.7;

  const messages: GroqMessage[] = options?.messages || [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.groqTimeoutMs);

  try {
    await enforceRateDelay("groq");
    const res = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.groqApiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens,
        temperature,
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Groq API ${res.status}: ${body.slice(0, 200)}`);
    }

    const data = (await res.json()) as GroqResponse;
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("No content in Groq response");

    const tokens = data.usage;
    log.info(
      `[groq] ${model} — ${content.length} chars` +
        (tokens ? ` (${tokens.prompt_tokens}+${tokens.completion_tokens} tokens)` : ""),
    );

    // Track actual token usage
    if (tokens) {
      logTokens("groq", tokens.prompt_tokens, tokens.completion_tokens);
    }
    markCallComplete("groq");

    return content;
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Groq request timed out (${config.groqTimeoutMs / 1000}s)`);
    }
    throw err;
  }
}

/**
 * Check if Groq is available (API key configured).
 */
export function isGroqAvailable(): boolean {
  return !!config.groqApiKey;
}
