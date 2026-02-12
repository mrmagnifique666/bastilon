/**
 * Per-chat sequential processing lock.
 * Ensures messages in the same chat are processed one at a time,
 * while different chats run in parallel.
 *
 * Also provides a global admin delivery queue (enqueueAdmin) that
 * serializes ALL tasks that ultimately deliver to Nicolas's chat —
 * user messages, scheduler events, agent cycles, and cron jobs.
 * This prevents race conditions where concurrent handleMessage() calls
 * from different sources collide on the same Telegram delivery target.
 */
import { log } from "../utils/log.js";

type Task = () => Promise<void>;

const queues = new Map<number, Task[]>();
const active = new Set<number>();

/**
 * Enqueue a task for a specific chat.
 * Tasks for the same chatId run sequentially; different chats run in parallel.
 */
export function enqueue(chatId: number, task: Task): void {
  const queue = queues.get(chatId) || [];
  queue.push(task);
  queues.set(chatId, queue);

  if (!active.has(chatId)) {
    drain(chatId);
  }
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

// --- Global admin delivery queue ---
// Serializes everything that delivers to Nicolas's Telegram chat:
// user messages, scheduler events, agent cycles, cron jobs.

let adminBusy = false;
const adminQueue: Task[] = [];

/**
 * Enqueue a task in the global admin delivery queue.
 * All tasks run sequentially regardless of source chatId.
 */
export function enqueueAdmin(task: Task): void {
  adminQueue.push(task);
  if (!adminBusy) drainAdmin();
}

async function drainAdmin(): Promise<void> {
  adminBusy = true;
  while (adminQueue.length > 0) {
    const t = adminQueue.shift()!;
    try {
      await t();
    } catch (e) {
      log.error("[chatLock] Admin task error:", e);
    }
  }
  adminBusy = false;
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
