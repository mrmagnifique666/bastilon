/**
 * Inbound message debouncer.
 * Buffers rapid messages from the same chat for a configurable window
 * before sending the combined text to Claude.
 */
import { config } from "../config/env.js";
import { log } from "../utils/log.js";

interface PendingMessage {
  fragments: string[];
  timer: ReturnType<typeof setTimeout>;
  resolve: (combined: string) => void;
}

const pending = new Map<number, PendingMessage>();

/**
 * Debounce incoming text for a chat.
 * - First call for a chatId: returns a Promise that resolves with the combined text
 *   after the debounce window expires.
 * - Subsequent calls within the window: appends text, resets the timer, returns null.
 *   The caller should exit early when null is returned.
 */
export function debounce(chatId: number, text: string): Promise<string | null> {
  if (!config.debounceEnabled) {
    return Promise.resolve(text);
  }

  const existing = pending.get(chatId);

  if (existing) {
    // Append to existing buffer, reset timer
    existing.fragments.push(text);
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => flush(chatId), config.debounceMs);
    log.debug(`[debouncer] Buffered fragment for chat ${chatId} (${existing.fragments.length} total)`);
    return Promise.resolve(null);
  }

  // First message — create a new pending entry
  return new Promise<string>((resolve) => {
    const timer = setTimeout(() => flush(chatId), config.debounceMs);
    pending.set(chatId, { fragments: [text], timer, resolve });
    log.debug(`[debouncer] Started debounce window for chat ${chatId}`);
  }) as Promise<string | null>;
}

function flush(chatId: number): void {
  const entry = pending.get(chatId);
  if (!entry) return;
  pending.delete(chatId);
  const combined = entry.fragments.join("\n");
  log.debug(`[debouncer] Flushed ${entry.fragments.length} fragment(s) for chat ${chatId}`);
  entry.resolve(combined);
}
