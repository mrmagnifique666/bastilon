/**
 * Gemini orchestrator with native function calling.
 * Uses Gemini 2.0 Flash as primary LLM with structured tool calls.
 * Falls back to Claude CLI on failure (rate limit, safety filter, etc.).
 */
import os from "node:os";
import { config } from "../config/env.js";
import { log } from "../utils/log.js";
import { getTurns } from "../storage/store.js";
import { isToolPermitted } from "../security/policy.js";
import { getSkill, validateArgs } from "../skills/loader.js";
import { getLifeboatPrompt } from "../orchestrator/lifeboat.js";
import { getLearnedRulesPrompt } from "../memory/self-review.js";
import { getSkillsForGemini } from "../skills/loader.js";

// --- Types ---

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

type GeminiPart =
  | { text: string }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: { result: string } } };

interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: {
    type: string;
    properties: Record<string, { type: string; description?: string }>;
    required?: string[];
  };
}

interface GeminiCandidate {
  content?: { parts?: GeminiPart[] };
  finishReason?: string;
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
  error?: { code: number; message: string };
}

export interface GeminiOptions {
  chatId: number;
  userMessage: string;
  isAdmin: boolean;
  userId: number;
  onToolProgress?: (chatId: number, message: string) => Promise<void>;
}

export class GeminiRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeminiRateLimitError";
  }
}

export class GeminiSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeminiSafetyError";
  }
}

// --- Constants ---

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const MAX_TOOL_RESULT_LENGTH = 8000;
const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 2000, 4000];

// --- System instruction ---

export function buildSystemInstruction(isAdmin: boolean, chatId?: number): string {
  const lines = [
    `You are Kingston, an autonomous AI assistant operating through a Telegram relay on the user's machine.`,
    `Your name is Kingston. You are proactive, capable, and concise.`,
    `IMPORTANT: Your identity is Kingston. Never identify as Émile, OpenClaw, Claude, or any other name.`,
    ``,
    `## Environment`,
    `- Platform: ${os.platform()} ${os.arch()}`,
    `- OS: ${os.type()} ${os.release()}`,
    `- Hostname: ${os.hostname()}`,
    `- Node: ${process.version}`,
    `- Working directory: ${process.cwd()}`,
    `- Date: ${new Date().toISOString().split("T")[0]}`,
    `- Admin: ${isAdmin ? "yes" : "no"}`,
    ...(chatId ? [`- Telegram chat ID: ${chatId} (auto-injected for telegram.send — you can omit chatId)`] : []),
    ``,
    `## Guidelines (CRITICAL — READ CAREFULLY)`,
    `- EXECUTE IMMEDIATELY. Never ask "would you like me to...?" or "should I...?" — JUST DO IT.`,
    `- If Nicolas asks you to do something, USE TOOLS RIGHT NOW. Do not describe what you would do.`,
    `- You have FULL admin access. You can write files, run shell commands, deploy via FTP, browse the web.`,
    `- When a task requires multiple steps, chain ALL tool calls autonomously until completion.`,
    `- If a tool call fails, try an alternative approach before giving up.`,
    `- NEVER ask for permission to write files, execute code, or use any tool. You already have permission.`,
    `- The ONLY time to ask a question is when the task itself is ambiguous (e.g. "which color?").`,
    `- Format responses for Telegram: short paragraphs, bullet points. Keep it under 500 chars when possible.`,
    `- To persist important information, use notes.add. Your conversation memory is only 12 turns.`,
    `- To request code changes, use code.request (the Executor agent picks it up within 5 min).`,
    ``,
    `## ANTI-HALLUCINATION (MOST IMPORTANT RULES — VIOLATION = CRITICAL FAILURE)`,
    `- NEVER claim you did something unless a tool ACTUALLY returned a success result.`,
    `- NEVER invent, fabricate, or assume tool results. Only report what the tool output ACTUALLY says.`,
    `- If you do NOT have a tool for a task, say CLEARLY: "Je n'ai pas d'outil pour ça. Voici ce que tu dois faire manuellement: ..."`,
    `- If a tool call FAILS or returns an error, report the EXACT error. Never say "Done!" after a failure.`,
    `- BEFORE saying "Done" or "Terminé", mentally verify: did a tool ACTUALLY confirm success? If no → don't say it.`,
    `- When reporting results, quote the actual tool output. Don't paraphrase into something more positive.`,
    `- If you're unsure whether something worked, say "Je ne peux pas confirmer que ça a fonctionné" — NEVER guess.`,
    ``,
    `## POST-DEPLOYMENT VERIFICATION (MANDATORY)`,
    `- After ANY ftp.upload or ftp.upload_dir, you MUST call ftp.verify to confirm the content actually changed on the server.`,
    `- Do NOT say "Déployé" or "Terminé" until ftp.verify returns "VERIFICATION PASSED".`,
    ``,
    `## Self-modification (admin only)`,
    `- Your source code is at: ${process.cwd()}`,
    `- You can read your own code with files.read_anywhere`,
    `- You can modify your own code with files.write_anywhere`,
    `- You can run shell commands with shell.exec`,
    `- After modifying code, the bot must be restarted to apply changes.`,
  ];

  // Inject learned rules from MISS/FIX
  const learnedRules = getLearnedRulesPrompt();
  if (learnedRules) {
    lines.push("", learnedRules);
  }

  // Inject context lifeboat if available
  if (chatId) {
    const lifeboat = getLifeboatPrompt(chatId);
    if (lifeboat) {
      lines.push("", lifeboat);
    }
  }

  return lines.join("\n");
}

// --- Conversation history conversion ---

function buildContents(chatId: number, userMessage: string): GeminiContent[] {
  const turns = getTurns(chatId);
  const contents: GeminiContent[] = [];

  for (const t of turns) {
    contents.push({
      role: t.role === "user" ? "user" : "model",
      parts: [{ text: t.content }],
    });
  }

  // Add current user message
  contents.push({
    role: "user",
    parts: [{ text: userMessage }],
  });

  return contents;
}

// --- API call ---

async function callGeminiAPI(
  systemInstruction: string,
  contents: GeminiContent[],
  tools: GeminiFunctionDeclaration[],
  retryCount = 0,
): Promise<GeminiResponse> {
  const model = config.geminiOrchestratorModel;
  const url = `${API_BASE}/${model}:generateContent?key=${config.geminiApiKey}`;

  const body: Record<string, unknown> = {
    systemInstruction: { parts: [{ text: systemInstruction }] },
    contents,
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 4096,
    },
  };

  // Only add tools declaration if there are tools to declare
  if (tools.length > 0) {
    body.tools = [{ functionDeclarations: tools }];
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.geminiTimeoutMs);

  try {
    log.debug(`[gemini] Calling ${model} (attempt ${retryCount + 1}, ${contents.length} messages, ${tools.length} tools)`);

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    // Rate limit — retry with exponential backoff
    if (res.status === 429) {
      if (retryCount < MAX_RETRIES) {
        const delay = RETRY_DELAYS[retryCount] ?? 4000;
        log.warn(`[gemini] Rate limited (429), retrying in ${delay}ms (attempt ${retryCount + 1}/${MAX_RETRIES})`);
        await new Promise((r) => setTimeout(r, delay));
        return callGeminiAPI(systemInstruction, contents, tools, retryCount + 1);
      }
      throw new GeminiRateLimitError(`Gemini rate limited after ${MAX_RETRIES} retries`);
    }

    if (!res.ok) {
      const errText = await res.text();
      log.error(`[gemini] API error ${res.status}: ${errText.slice(0, 300)}`);
      throw new Error(`Gemini API error ${res.status}: ${errText.slice(0, 300)}`);
    }

    return (await res.json()) as GeminiResponse;
  } catch (err) {
    clearTimeout(timeout);
    if ((err as Error).name === "AbortError") {
      throw new Error(`Gemini API timeout after ${config.geminiTimeoutMs}ms`);
    }
    throw err;
  }
}

// --- Arg normalization ---

export function normalizeArgs(
  tool: string,
  args: Record<string, unknown>,
  chatId: number,
  skill: ReturnType<typeof getSkill>,
): Record<string, unknown> {
  const normalized = { ...args };

  // snake_case → camelCase aliases
  if (normalized.chat_id !== undefined && normalized.chatId === undefined) {
    normalized.chatId = normalized.chat_id;
    delete normalized.chat_id;
    log.debug(`[gemini] Normalized chat_id → chatId for ${tool}`);
  }
  if (normalized.message !== undefined && normalized.text === undefined) {
    normalized.text = normalized.message;
    delete normalized.message;
    log.debug(`[gemini] Normalized message → text for ${tool}`);
  }

  // Auto-inject chatId for telegram.*/browser.* skills
  if ((tool.startsWith("telegram.") || tool.startsWith("browser.")) && !normalized.chatId) {
    normalized.chatId = String(chatId);
    log.debug(`[gemini] Auto-injected chatId=${chatId} for ${tool}`);
  }

  // Type coercion: Gemini may send string for number fields
  if (skill?.argsSchema?.properties) {
    for (const [key, prop] of Object.entries(skill.argsSchema.properties)) {
      if (prop.type === "number" && typeof normalized[key] === "string") {
        const num = Number(normalized[key]);
        if (!isNaN(num)) {
          normalized[key] = num;
          log.debug(`[gemini] Coerced ${key} from string to number for ${tool}`);
        }
      }
    }
  }

  return normalized;
}

// --- Truncate tool results ---

function truncateResult(result: string): string {
  if (result.length <= MAX_TOOL_RESULT_LENGTH) return result;
  return result.slice(0, MAX_TOOL_RESULT_LENGTH) + `\n... [truncated, ${result.length} chars total]`;
}

// --- Main orchestrator ---

/**
 * Run Gemini as the primary orchestrator with native function calling.
 * Handles the full tool chain loop internally.
 * Throws on failure (rate limit, safety, etc.) so the caller can fall back to Claude CLI.
 */
export async function runGemini(options: GeminiOptions): Promise<string> {
  const { chatId, userMessage, isAdmin, userId, onToolProgress } = options;

  if (!config.geminiApiKey) {
    throw new Error("GEMINI_API_KEY not configured");
  }

  const systemInstruction = buildSystemInstruction(isAdmin, chatId);
  const contents = buildContents(chatId, userMessage);
  const tools = getSkillsForGemini(isAdmin, userMessage);

  log.info(`[gemini] Sending message (chatId=${chatId}, admin=${isAdmin}, tools=${tools.length}): ${userMessage.slice(0, 100)}...`);

  for (let step = 0; step < config.maxToolChain; step++) {
    const response = await callGeminiAPI(systemInstruction, contents, tools);

    // Check for API-level errors
    if (response.error) {
      throw new Error(`Gemini error: ${response.error.message}`);
    }

    const candidate = response.candidates?.[0];
    if (!candidate?.content?.parts) {
      throw new Error("Gemini returned no content");
    }

    // Check safety filter
    if (candidate.finishReason === "SAFETY") {
      throw new GeminiSafetyError("Gemini blocked response due to safety filter");
    }

    // Process parts — may contain text, functionCall, or both
    const parts = candidate.content.parts;
    let finalText = "";
    let hasFunctionCall = false;

    for (const part of parts) {
      // Text part — accumulate
      if ("text" in part) {
        finalText += part.text;
      }

      // Function call part — execute and loop
      if ("functionCall" in part) {
        hasFunctionCall = true;
        const { name: toolName, args: rawArgs } = part.functionCall;
        log.info(`[gemini] Function call (step ${step + 1}): ${toolName}(${JSON.stringify(rawArgs).slice(0, 200)})`);

        // Add the model's function call to contents
        contents.push({
          role: "model",
          parts: [{ functionCall: { name: toolName, args: rawArgs } }],
        });

        // Validate tool exists in registry (anti-hallucination)
        const skill = getSkill(toolName);
        if (!skill) {
          log.warn(`[gemini] Unknown tool "${toolName}" — feeding error back`);
          contents.push({
            role: "user",
            parts: [{ functionResponse: { name: toolName, response: { result: `Error: Unknown tool "${toolName}". Check the tool catalog and try again.` } } }],
          });
          continue;
        }

        // Hard block: agents cannot use browser.*
        if (chatId >= 100 && chatId <= 104 && toolName.startsWith("browser.")) {
          log.warn(`[gemini] Agent chatId=${chatId} tried to call ${toolName} — blocked`);
          contents.push({
            role: "user",
            parts: [{ functionResponse: { name: toolName, response: { result: `Error: Tool "${toolName}" is blocked for agents — use web.search instead.` } } }],
          });
          continue;
        }

        // Security check
        if (!isToolPermitted(toolName, userId)) {
          const msg = `Error: Tool "${toolName}" is not permitted${skill.adminOnly ? " (admin only)" : ""}.`;
          log.warn(`[gemini] ${msg}`);
          // Return text instead of looping — permission errors are final
          return msg;
        }

        // Normalize args
        const safeArgs = normalizeArgs(toolName, rawArgs || {}, chatId, skill);

        // Validate args
        const validationError = validateArgs(safeArgs, skill.argsSchema);
        if (validationError) {
          log.warn(`[gemini] Arg validation failed for ${toolName}: ${validationError}`);
          contents.push({
            role: "user",
            parts: [{ functionResponse: { name: toolName, response: { result: `Error: ${validationError}. Fix the arguments and try again.` } } }],
          });
          continue;
        }

        // Execute skill
        let toolResult: string;
        try {
          log.info(`[gemini] Executing tool (step ${step + 1}/${config.maxToolChain}): ${toolName}`);
          toolResult = await skill.execute(safeArgs);
        } catch (err) {
          const errorMsg = `Tool "${toolName}" execution failed: ${err instanceof Error ? err.message : String(err)}`;
          log.error(`[gemini] ${errorMsg}`);
          contents.push({
            role: "user",
            parts: [{ functionResponse: { name: toolName, response: { result: `Error: ${errorMsg}` } } }],
          });
          continue;
        }

        log.debug(`[gemini] Tool result (${toolName}): ${toolResult.slice(0, 200)}`);

        // Progress callback
        if (onToolProgress) {
          const preview = toolResult.length > 200 ? toolResult.slice(0, 200) + "..." : toolResult;
          try {
            await onToolProgress(chatId, `⚙️ **${toolName}**\n\`\`\`\n${preview}\n\`\`\``);
          } catch { /* ignore progress errors */ }
        }

        // Feed result back as functionResponse
        contents.push({
          role: "user",
          parts: [{ functionResponse: { name: toolName, response: { result: truncateResult(toolResult) } } }],
        });
      }
    }

    // If no function call was made, return the text
    if (!hasFunctionCall) {
      return finalText || "(empty response)";
    }

    // Otherwise loop continues — Gemini will process the functionResponse
  }

  // Exhausted tool chain
  return `Reached tool chain limit (${config.maxToolChain} steps).`;
}
