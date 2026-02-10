/**
 * Per-chat sequential processing lock.
 * Ensures messages in the same chat are processed one at a time,
 * while different chats run in parallel.
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
