/**
 * Per-chat sequential processing lock + global admin delivery queue.
 *
 * KEY FEATURE: Message interruption system.
 * When a new user message arrives while one is processing, the current
 * processing is interrupted (AbortSignal) and the new message takes over.
 * This prevents Kingston from getting stuck in infinite loops and lets
 * Nicolas send multiple messages without breaking the bot.
 *
 * Architecture:
 * - Admin queue: serializes ALL deliveries to Nicolas's chat
 * - Interrupt signal: allows new user messages to abort current processing
 * - Task timeout: prevents queue deadlock if a task hangs
 * - Pending messages: buffer new messages during processing
 */
import { log } from "../utils/log.js";

type Task = () => Promise<void>;

// ── Per-Chat Queues (for non-admin tasks) ───────────────────

const queues = new Map<number, Task[]>();
const active = new Set<number>();

export function enqueue(chatId: number, task: Task): void {
  const queue = queues.get(chatId) || [];
  queue.push(task);
  queues.set(chatId, queue);
  if (!active.has(chatId)) drain(chatId);
}

async function drain(chatId: number): Promise<void> {
  active.add(chatId);
  while (true) {
    const queue = queues.get(chatId);
    if (!queue || queue.length === 0) {
      queues.delete(chatId);
      active.delete(chatId);
      return;
    }
    const task = queue.shift()!;
    try {
      await task();
    } catch (err) {
      log.error(`[chatLock] Task error in chat ${chatId}:`, err);
    }
  }
}

// ── Interrupt Signal System ─────────────────────────────────

let currentAbortController: AbortController | null = null;
let currentTaskType: "user" | "system" = "system";

/**
 * Get an AbortSignal for the current user message processing.
 * The signal fires when a new user message arrives.
 */
export function getInterruptSignal(): AbortSignal | null {
  return currentAbortController?.signal ?? null;
}

/**
 * Check if the current processing has been interrupted.
 */
export function isInterrupted(): boolean {
  return currentAbortController?.signal?.aborted ?? false;
}

/**
 * Interrupt the current user message processing.
 * Called when a new user message arrives while one is being processed.
 * Returns true if there was something to interrupt.
 */
export function interruptCurrent(): boolean {
  if (currentAbortController && currentTaskType === "user") {
    log.info("[chatLock] Interrupting current user message processing — new message arrived");
    currentAbortController.abort(new Error("interrupted:new_message"));
    return true;
  }
  return false;
}

// ── Global Admin Delivery Queue ─────────────────────────────

let adminBusy = false;
const adminQueue: Array<{ task: Task; type: "user" | "system"; enqueueTime: number }> = [];

/** Max time a single task can run before being killed (8 minutes) */
const TASK_TIMEOUT_MS = 480_000;

/** Max time a task can sit in queue before being skipped (10 minutes) */
const QUEUE_STALE_MS = 600_000;

/**
 * Enqueue a task in the global admin delivery queue.
 * @param task The async task to run
 * @param type "user" for user messages (interruptible), "system" for agents/cron (not interruptible)
 */
export function enqueueAdmin(task: Task, type: "user" | "system" = "system"): void {
  adminQueue.push({ task, type, enqueueTime: Date.now() });
  if (!adminBusy) drainAdmin();
}

async function drainAdmin(): Promise<void> {
  adminBusy = true;
  while (adminQueue.length > 0) {
    const entry = adminQueue.shift()!;

    // Skip stale tasks that waited too long in queue
    const queueWait = Date.now() - entry.enqueueTime;
    if (queueWait > QUEUE_STALE_MS) {
      log.warn(`[chatLock] Skipping stale task (waited ${Math.round(queueWait / 1000)}s in queue)`);
      continue;
    }

    // Set up interrupt controller for user tasks
    if (entry.type === "user") {
      currentAbortController = new AbortController();
      currentTaskType = "user";
    } else {
      currentAbortController = null;
      currentTaskType = "system";
    }

    try {
      // Run with timeout to prevent deadlock
      await Promise.race([
        entry.task(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Admin task timeout (${TASK_TIMEOUT_MS / 1000}s)`)), TASK_TIMEOUT_MS)
        ),
      ]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("interrupted:new_message")) {
        log.info("[chatLock] Task interrupted by new user message — moving on");
      } else if (msg.includes("Admin task timeout")) {
        log.error(`[chatLock] Task timed out after ${TASK_TIMEOUT_MS / 1000}s — killing`);
      } else {
        log.error("[chatLock] Admin task error:", e);
      }
    } finally {
      currentAbortController = null;
      currentTaskType = "system";
    }
  }
  adminBusy = false;
}

/**
 * Check how many tasks are waiting in the admin queue.
 */
export function getAdminQueueLength(): number {
  return adminQueue.length;
}

/**
 * Check if the admin queue is currently processing.
 */
export function isAdminBusy(): boolean {
  return adminBusy;
}

/**
 * Enqueue a task and return a promise that resolves with its result.
 * Useful for callers that need the return value of handleMessage().
 */
export function enqueueAdminAsync<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    enqueueAdmin(async () => {
      try {
        resolve(await task());
      } catch (e) {
        reject(e);
      }
    });
  });
}
