/**
 * Shared tool execution logic — used by Groq-chat and Ollama-chat.
 * Handles: validation, security, arg normalization, browser blocks,
 * placeholder detection, and execution.
 */
import { config } from "../../config/env.js";
import { log } from "../../utils/log.js";
import { isToolPermitted } from "../../security/policy.js";
import { getSkill, validateArgs } from "../../skills/loader.js";
import { normalizeArgs } from "../gemini.js";

const MAX_TOOL_RESULT_LENGTH = 4000;
const PLACEHOLDER_RE = /\[[A-ZÀ-ÜÉÈ][A-ZÀ-ÜÉÈ\s_\-]{2,}\]/;

export const AGENT_BROWSER_ALLOWED = ["browser.navigate", "browser.snapshot", "browser.extract", "browser.status"];

const OUTBOUND_TOOLS = ["telegram.send", "mind.ask", "moltbook.post", "moltbook.comment", "content.publish"];

export function truncateResult(result: string): string {
  if (result.length <= MAX_TOOL_RESULT_LENGTH) return result;
  return result.slice(0, MAX_TOOL_RESULT_LENGTH) + `\n... [truncated, ${result.length} chars total]`;
}

export interface ToolCallInput {
  toolName: string;
  rawArgs: Record<string, unknown>;
  callId?: string; // Groq has tool_call_id, Ollama doesn't
}

export interface ToolCallResult {
  content: string;
  tool_call_id?: string;
}

export interface ToolExecOptions {
  chatId: number;
  userId: number;
  provider: string; // "groq-chat" | "ollama-chat" for logging
  onToolProgress?: (chatId: number, msg: string) => Promise<void>;
  step: number;
  maxSteps: number;
}

/**
 * Execute a single tool call with full validation, security checks, and error handling.
 * Returns the result content to be fed back to the LLM.
 */
export async function executeToolCall(tc: ToolCallInput, opts: ToolExecOptions): Promise<ToolCallResult> {
  const { toolName, rawArgs, callId } = tc;
  const { chatId, userId, provider, onToolProgress, step, maxSteps } = opts;
  const tag = `[${provider}]`;

  log.info(`${tag} Tool call (step ${step + 1}): ${toolName}(${JSON.stringify(rawArgs).slice(0, 200)})`);

  // Progress callback (only for real Telegram chats)
  if (onToolProgress && chatId > 1000) {
    onToolProgress(chatId, `🔧 ${toolName}...`).catch(() => {});
  }

  // 1. Validate tool exists
  const skill = getSkill(toolName);
  if (!skill) {
    log.warn(`${tag} Unknown tool "${toolName}" — feeding error back`);
    return { content: `Error: Unknown tool "${toolName}". Check the tool catalog and try again.`, tool_call_id: callId };
  }

  // 2. Browser block for internal chatIds (agents 100-106, cron 200-249)
  const isInternal = chatId === 1 || (chatId >= 100 && chatId <= 106) || (chatId >= 200 && chatId <= 249);
  if (isInternal && toolName.startsWith("browser.") && !AGENT_BROWSER_ALLOWED.includes(toolName)) {
    log.warn(`${tag} Internal session chatId=${chatId} tried to call ${toolName} — blocked`);
    return { content: `Error: Tool "${toolName}" is blocked for agents/cron — use web.search instead.`, tool_call_id: callId };
  }

  // 3. Permission check
  if (!isToolPermitted(toolName, userId)) {
    const errMsg = `Error: Tool "${toolName}" is not permitted${skill.adminOnly ? " (admin only)" : ""}.`;
    log.warn(`${tag} ${errMsg}`);
    return { content: errMsg, tool_call_id: callId };
  }

  // 4. Normalize args (snake_case → camelCase, auto-inject chatId, type coercion)
  const safeArgs = normalizeArgs(toolName, rawArgs, chatId, skill);

  // 5. Rewrite telegram chatId for internal sessions
  if (isInternal && toolName.startsWith("telegram.") && config.adminChatId > 0) {
    safeArgs.chatId = String(config.adminChatId);
    log.debug(`${tag} Internal session ${chatId}: rewrote chatId to admin ${config.adminChatId} for ${toolName}`);
  }

  // 6. Validate args schema
  const validationError = validateArgs(safeArgs, skill.argsSchema);
  if (validationError) {
    log.warn(`${tag} Arg validation failed for ${toolName}: ${validationError}`);
    return { content: `Error: ${validationError}. Fix the arguments and try again.`, tool_call_id: callId };
  }

  // 7. Block placeholder hallucinations in outbound messages
  if (OUTBOUND_TOOLS.includes(toolName)) {
    const textArg = String(safeArgs.text || safeArgs.content || safeArgs.question || "");
    if (PLACEHOLDER_RE.test(textArg)) {
      log.warn(`${tag} Blocked ${toolName} — placeholder detected: "${textArg.slice(0, 120)}"`);
      return { content: `Error: Replace placeholders like [RÉSUMÉ] with real data before sending.`, tool_call_id: callId };
    }
  }

  // 8. Execute
  try {
    log.info(`${tag} Executing tool (step ${step + 1}/${maxSteps}): ${toolName}`);
    const result = await skill.handler(safeArgs);
    const resultStr = truncateResult(typeof result === "string" ? result : JSON.stringify(result));
    log.debug(`${tag} Tool result (${toolName}): ${resultStr.slice(0, 200)}`);
    return { content: resultStr, tool_call_id: callId };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.warn(`${tag} Tool ${toolName} failed: ${errMsg}`);
    return { content: `Error: ${errMsg}`, tool_call_id: callId };
  }
}
