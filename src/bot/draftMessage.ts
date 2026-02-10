/**
 * Draft message controller for streaming responses.
 * Manages a Telegram message that updates in real-time as Claude streams.
 * Throttles edits to respect Telegram API rate limits.
 */
import { Bot } from "grammy";
import { log } from "../utils/log.js";
import { config } from "../config/env.js";
import { mdToHtml } from "./formatting.js";

const CURSOR = "█";
const MIN_DIFF_CHARS = 40;

export interface DraftController {
  /** Append streamed text and update the Telegram message */
  update(fullText: string): Promise<void>;
  /** Finalize the message (remove cursor, last edit) */
  finalize(): Promise<void>;
  /** Cancel — delete the draft message if it exists */
  cancel(): Promise<void>;
  /** Get the sent message ID (null if not yet sent) */
  getMessageId(): number | null;
}

export function createDraftController(bot: Bot, chatId: number): DraftController {
  let messageId: number | null = null;
  let lastEditedText = "";
  let lastEditTime = 0;
  let pendingUpdate: ReturnType<typeof setTimeout> | null = null;
  let currentFullText = "";

  const editInterval = config.draftEditIntervalMs;

  async function doSend(text: string): Promise<void> {
    const html = mdToHtml(text + CURSOR);
    try {
      const msg = await bot.api.sendMessage(chatId, html, { parse_mode: "HTML" });
      messageId = msg.message_id;
      lastEditedText = text;
      lastEditTime = Date.now();
    } catch (err) {
      // Fallback: try plain text
      log.warn(`[draft] HTML send failed, trying plain: ${err}`);
      const msg = await bot.api.sendMessage(chatId, text + CURSOR);
      messageId = msg.message_id;
      lastEditedText = text;
      lastEditTime = Date.now();
    }
  }

  async function doEdit(text: string, withCursor = true): Promise<void> {
    if (!messageId) return;
    const display = withCursor ? text + CURSOR : text;
    const html = mdToHtml(display);
    try {
      await bot.api.editMessageText(chatId, messageId, html, { parse_mode: "HTML" });
      lastEditedText = text;
      lastEditTime = Date.now();
    } catch (err: any) {
      // "message is not modified" is expected when text hasn't changed enough
      if (err?.description?.includes("message is not modified")) return;
      log.warn(`[draft] HTML edit failed, trying plain: ${err}`);
      try {
        await bot.api.editMessageText(chatId, messageId, display);
        lastEditedText = text;
        lastEditTime = Date.now();
      } catch { /* give up silently */ }
    }
  }

  async function scheduleOrEdit(text: string): Promise<void> {
    currentFullText = text;
    const now = Date.now();
    const elapsed = now - lastEditTime;

    // Not enough change
    if (text.length - lastEditedText.length < MIN_DIFF_CHARS && elapsed < editInterval) {
      // Schedule a deferred update if not already pending
      if (!pendingUpdate) {
        pendingUpdate = setTimeout(async () => {
          pendingUpdate = null;
          if (currentFullText !== lastEditedText) {
            await doEdit(currentFullText);
          }
        }, editInterval - elapsed);
      }
      return;
    }

    // Clear pending if we're editing now
    if (pendingUpdate) {
      clearTimeout(pendingUpdate);
      pendingUpdate = null;
    }

    await doEdit(text);
  }

  return {
    async update(fullText: string): Promise<void> {
      if (!messageId) {
        // First chunk — send a new message
        if (fullText.length >= config.draftStartThreshold) {
          await doSend(fullText);
        }
        return;
      }
      await scheduleOrEdit(fullText);
    },

    async finalize(): Promise<void> {
      if (pendingUpdate) {
        clearTimeout(pendingUpdate);
        pendingUpdate = null;
      }
      if (messageId && currentFullText) {
        try {
          await doEdit(currentFullText, false);
        } catch (err) {
          log.warn(`[draft] finalize edit failed: ${err}`);
        }
      }
    },

    async cancel(): Promise<void> {
      if (pendingUpdate) {
        clearTimeout(pendingUpdate);
        pendingUpdate = null;
      }
      if (messageId) {
        try {
          await bot.api.deleteMessage(chatId, messageId);
        } catch { /* non-fatal */ }
        messageId = null;
      }
    },

    getMessageId(): number | null {
      return messageId;
    },
  };
}
