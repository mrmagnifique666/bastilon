/**
 * Subordinate Agent System — on-demand child agents with typed delegation.
 *
 * A subordinate agent:
 * 1. Is spawned by a parent agent/Kingston with a specific task
 * 2. Runs once (single cycle), executes the task
 * 3. Returns the result to the parent
 * 4. Self-destructs after completion
 *
 * Supports hierarchy: parent → child, with result tracking in agent_tasks table.
 */
import { handleMessage } from "../orchestrator/router.js";
import { getDb, clearTurns, clearSession } from "../storage/store.js";
import { log } from "../utils/log.js";
import { config } from "../config/env.js";

// Subordinate chatId range: 300-399 (isolated from agents 100-106 and cron 200-249)
const SUB_CHAT_BASE = 300;
const SUB_CHAT_MAX = 399;
let nextSubChatId = SUB_CHAT_BASE;

/** Get next available subordinate chatId */
function allocateSubChatId(): number {
  const id = nextSubChatId;
  nextSubChatId = nextSubChatId >= SUB_CHAT_MAX ? SUB_CHAT_BASE : nextSubChatId + 1;
  return id;
}

export interface SubordinateTask {
  /** Parent agent/user who spawned this */
  parentId: string;
  /** Task instruction */
  instruction: string;
  /** Expected output type for structured results */
  outputType?: "text" | "json" | "boolean" | "number";
  /** Tool restrictions for this subordinate */
  allowedTools?: string[];
  /** Timeout in ms (default: 120s) */
  timeoutMs?: number;
}

export interface SubordinateResult {
  taskId: number;
  status: "completed" | "error" | "timeout";
  result: string;
  durationMs: number;
  chatId: number;
}

/**
 * Spawn a subordinate agent, run a single task, return the result.
 * The subordinate gets a fresh session, executes, and returns.
 */
export async function spawnSubordinate(task: SubordinateTask): Promise<SubordinateResult> {
  const chatId = allocateSubChatId();
  const startTime = Date.now();
  const timeoutMs = task.timeoutMs || 120_000;

  // Create task record in DB
  const db = getDb();
  const info = db.prepare(
    `INSERT INTO agent_tasks (from_agent, to_agent, instruction, status)
     VALUES (?, ?, ?, 'in_progress')`
  ).run(task.parentId, `sub-${chatId}`, task.instruction);
  const taskId = Number(info.lastInsertRowid);

  log.info(`[subordinate] Spawned sub-${chatId} for ${task.parentId} (task #${taskId})`);

  // Build the subordinate prompt
  const toolRestriction = task.allowedTools
    ? `\nOUTILS AUTORISÉS: ${task.allowedTools.join(", ")}\n`
    : "";

  const outputInstruction = task.outputType === "json"
    ? "\nRÉPONDS EN JSON VALIDE uniquement."
    : task.outputType === "boolean"
    ? "\nRÉPONDS par 'true' ou 'false' uniquement."
    : task.outputType === "number"
    ? "\nRÉPONDS par un nombre uniquement."
    : "";

  const prompt =
    `[SUBORDINATE AGENT] (spawned by ${task.parentId})\n` +
    `Tu es un agent subordiné. Exécute cette tâche et retourne le résultat.\n` +
    `IMPORTANT: Sois concis et direct. Pas de bavardage.\n` +
    toolRestriction +
    outputInstruction +
    `\n--- TÂCHE ---\n${task.instruction}`;

  // Fresh session
  clearTurns(chatId);
  clearSession(chatId);

  try {
    // Execute with timeout
    const resultPromise = handleMessage(chatId, prompt, config.adminUserId, "scheduler");
    const timeoutPromise = new Promise<string>((_, reject) =>
      setTimeout(() => reject(new Error("Subordinate timeout")), timeoutMs)
    );

    const result = await Promise.race([resultPromise, timeoutPromise]);
    const durationMs = Date.now() - startTime;

    // Update task record
    db.prepare(
      `UPDATE agent_tasks SET status = 'completed', result = ?, completed_at = unixepoch()
       WHERE id = ?`
    ).run(String(result).slice(0, 10000), taskId);

    log.info(`[subordinate] sub-${chatId} completed in ${durationMs}ms`);

    // Cleanup
    clearTurns(chatId);
    clearSession(chatId);

    return { taskId, status: "completed", result: String(result), durationMs, chatId };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const errorMsg = err instanceof Error ? err.message : String(err);
    const status = errorMsg.includes("timeout") ? "timeout" : "error";

    db.prepare(
      `UPDATE agent_tasks SET status = ?, result = ?, completed_at = unixepoch()
       WHERE id = ?`
    ).run(status, errorMsg, taskId);

    log.warn(`[subordinate] sub-${chatId} ${status}: ${errorMsg}`);

    clearTurns(chatId);
    clearSession(chatId);

    return { taskId, status, result: errorMsg, durationMs, chatId };
  }
}

/**
 * Spawn multiple subordinates in parallel and collect all results.
 */
export async function spawnParallel(
  parentId: string,
  tasks: Array<{ instruction: string; outputType?: SubordinateTask["outputType"]; allowedTools?: string[] }>,
): Promise<SubordinateResult[]> {
  const promises = tasks.map(t => spawnSubordinate({
    parentId,
    instruction: t.instruction,
    outputType: t.outputType,
    allowedTools: t.allowedTools,
  }));
  return Promise.all(promises);
}
