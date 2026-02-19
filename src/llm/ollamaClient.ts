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

  const systemPrompt = buildSystemInstruction(userIsAdmin, chatId, userMessage);
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

  // Loop detection
  let lastToolName = "";
  let repeatCount = 0;

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

    // Loop detection: same tool called 3+ times = stuck
    if (msg.tool_calls.length === 1) {
      const callName = msg.tool_calls[0].function.name;
      if (callName === lastToolName) {
        repeatCount++;
        if (repeatCount >= 3) {
          log.warn(`[ollama-chat] 🔄 Loop detected: ${callName} called ${repeatCount + 1}x — breaking`);
          return msg.content || `(Loop détecté: ${callName} appelé en boucle.)`;
        }
      } else {
        lastToolName = callName;
        repeatCount = 1;
      }
    } else {
      lastToolName = "";
      repeatCount = 0;
    }

    // Process tool calls
    // Add assistant message with tool_calls to history
    messages.push({
      role: "assistant",
      content: msg.content || "",
      tool_calls: msg.tool_calls,
    });

    // Execute all tool calls in parallel for speed
    const results = await Promise.all(
      msg.tool_calls.map(tc => executeToolCall(
        { toolName: tc.function.name, rawArgs: tc.function.arguments || {} },
        { chatId, userId, provider: "ollama-chat", onToolProgress, step, maxSteps: config.maxToolChain }
      ))
    );
    for (const result of results) {
      messages.push({ role: "tool", content: result.content });
    }
    // Loop continues — Ollama processes tool results
  }

  // Exhausted tool chain
  return `Reached tool chain limit (${config.maxToolChain} steps).`;
}

// --- Ollama Tool Router (hybrid mode: Ollama handles tool routing, Opus handles conversation) ---

/**
 * Result from runOllamaToolRouter — either another tool_call or a final summary.
 * Matches the router's ParsedResult format for easy integration.
 */
export interface OllamaRouterResult {
  type: "tool_call" | "message";
  tool?: string;
  args?: Record<string, unknown>;
  text?: string;
}

/**
 * Use Ollama as the tool routing brain for intermediate steps.
 * Takes the original user message + accumulated tool history and decides:
 *   - Call another tool (returns type: "tool_call")
 *   - Return a text summary (returns type: "message")
 *
 * This saves Claude Opus/Sonnet tokens by offloading tool routing to local Ollama ($0).
 * The router calls Opus ONLY for the initial message and the final conversational response.
 */
export async function runOllamaToolRouter(
  chatId: number,
  originalUserMessage: string,
  toolHistory: Array<{ tool: string; result: string }>,
  userIsAdmin: boolean,
): Promise<OllamaRouterResult> {
  const tools = getSkillsForOllama(originalUserMessage);

  const systemPrompt = [
    "Tu es Kingston, un assistant IA autonome. Tu EXÉCUTES des tâches en utilisant des outils.",
    "Tu reçois le message original de l'utilisateur et les résultats des outils déjà exécutés.",
    "DÉCIDE: soit appeler un AUTRE outil nécessaire, soit rédiger un résumé final des résultats.",
    "Si la tâche est complète, retourne un résumé concis en français des actions effectuées et résultats obtenus.",
    "Si d'autres outils sont nécessaires, appelle-les.",
    "Sois CONCIS. Max 4-5 lignes pour le résumé final.",
    "IMPORTANT: Ne fais PAS de tool call si la tâche est déjà accomplie par les outils précédents.",
  ].join(" ");

  const messages: OllamaChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: `Message de Nicolas: "${originalUserMessage}"` },
  ];

  // Add tool history as conversation context
  for (const { tool, result } of toolHistory) {
    messages.push({
      role: "assistant",
      content: `J'ai appelé l'outil ${tool}.`,
    });
    messages.push({
      role: "user",
      content: `[Résultat de ${tool}]:\n${result.slice(0, 3000)}`,
    });
  }

  // Ask Ollama to decide
  messages.push({
    role: "user",
    content: "Basé sur les résultats ci-dessus, que dois-je faire? Appeler un autre outil ou rédiger le réponse finale?",
  });

  log.info(`[ollama-router] 🦙 Asking Ollama for next step (${toolHistory.length} tools executed so far)`);

  try {
    const response = await callOllamaChatAPI(messages, tools);

    if (response.error) {
      log.warn(`[ollama-router] Ollama error: ${response.error}`);
      return { type: "message", text: undefined }; // Signal to fallback to Sonnet
    }

    const msg = response.message;
    if (!msg) {
      log.warn(`[ollama-router] No message in response`);
      return { type: "message", text: undefined };
    }

    // Ollama wants to call a tool
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      const tc = msg.tool_calls[0]; // Take first tool call
      const toolName = tc.function.name;
      const toolArgs = tc.function.arguments || {};
      log.info(`[ollama-router] 🦙 Ollama wants to call: ${toolName}`);
      return { type: "tool_call", tool: toolName, args: toolArgs };
    }

    // Ollama returned text — it's the summary
    const text = (msg.content || "").trim();
    if (text) {
      log.info(`[ollama-router] 🦙 Ollama returned summary (${text.length} chars)`);
      return { type: "message", text };
    }

    // Empty — signal to use Sonnet fallback
    return { type: "message", text: undefined };
  } catch (err) {
    log.warn(`[ollama-router] Failed: ${err instanceof Error ? err.message : String(err)}`);
    return { type: "message", text: undefined }; // Fallback to Sonnet
  }
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
