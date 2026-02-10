/**
 * Telegram bot setup using grammY with long polling.
 * Handles text messages, photos, documents, user allowlist checks, and rate limiting.
 * Features: reactions, debouncing, dedup, streaming, chat lock, advanced formatting.
 */
import { Bot, InputFile } from "grammy";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config/env.js";
import { isUserAllowed, tryAdminAuth, isAdmin } from "../security/policy.js";
import { consumeToken } from "../security/rateLimit.js";
import { handleMessage, handleMessageStreaming, setProgressCallback } from "../orchestrator/router.js";
import { clearTurns, clearSession, getTurns, getSession, logError } from "../storage/store.js";
import { setBotSendFn, setBotVoiceFn, setBotPhotoFn } from "../skills/builtin/telegram.js";
import { log } from "../utils/log.js";
import { debounce } from "./debouncer.js";
import { enqueue } from "./chatLock.js";
import { sendFormatted } from "./formatting.js";
import { createDraftController } from "./draftMessage.js";
import { compactContext } from "../orchestrator/compaction.js";
import { emitHook } from "../hooks/hooks.js";

const startTime = Date.now();

// --- Reaction Handles ---

interface ReactionHandle {
  ack(): Promise<void>;
  done(): Promise<void>;
  error(): Promise<void>;
}

function createReactionHandle(bot: Bot, chatId: number, messageId: number): ReactionHandle {
  const set = async (emoji: string) => {
    if (!config.reactionsEnabled) return;
    try {
      await bot.api.setMessageReaction(chatId, messageId, [{ type: "emoji", emoji }]);
    } catch { /* non-fatal — reactions may not be supported in all chats */ }
  };
  return {
    ack: () => set("👀"),
    done: () => set("✅"),
    error: () => set("❌"),
  };
}

// --- Update Dedup ---

const recentUpdateIds = new Set<number>();
const MAX_DEDUP_SIZE = 200;

function isDuplicate(updateId: number): boolean {
  if (recentUpdateIds.has(updateId)) return true;
  recentUpdateIds.add(updateId);
  // Prune if too large
  if (recentUpdateIds.size > MAX_DEDUP_SIZE) {
    const iter = recentUpdateIds.values();
    for (let i = 0; i < 50; i++) iter.next();
    // Delete oldest entries
    const arr = Array.from(recentUpdateIds);
    for (let i = 0; i < 50; i++) recentUpdateIds.delete(arr[i]);
  }
  return false;
}

// --- File Download ---

async function downloadTelegramFile(
  bot: Bot,
  fileId: string,
  filename: string
): Promise<string> {
  const file = await bot.api.getFile(fileId);
  const filePath = file.file_path;
  if (!filePath) throw new Error("Telegram returned no file_path");

  // Sanitize filename: strip path separators to prevent directory traversal
  const safeName = path.basename(filename).replace(/[\\/:*?"<>|]/g, "_");
  if (!safeName || safeName === "." || safeName === "..") {
    throw new Error("Invalid filename after sanitization");
  }

  const url = `https://api.telegram.org/file/bot${config.telegramToken}/${filePath}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) throw new Error(`Failed to download file: ${resp.status}`);

    const buffer = Buffer.from(await resp.arrayBuffer());
    const localPath = path.resolve(config.uploadsDir, safeName);

    // Final guard: ensure resolved path is inside uploadsDir
    if (!localPath.startsWith(path.resolve(config.uploadsDir))) {
      throw new Error("Path traversal blocked");
    }

    fs.writeFileSync(localPath, buffer);
    return localPath;
  } finally {
    clearTimeout(timeout);
  }
}

// --- sendLong (legacy fallback, used for non-streaming paths) ---

async function sendLong(
  ctx: { reply: (text: string, options?: { parse_mode?: string }) => Promise<unknown> },
  text: string
) {
  await sendFormatted(
    (chunk, parseMode) => ctx.reply(chunk, parseMode ? { parse_mode: parseMode } : undefined),
    text
  );
}

// --- Bot Creation ---

export function createBot(): Bot {
  const bot = new Bot(config.telegramToken);
  const bootTime = Math.floor(Date.now() / 1000);

  // Middleware: drop stale messages from before boot
  bot.use(async (ctx, next) => {
    const msgDate = ctx.message?.date ?? ctx.editedMessage?.date ?? 0;
    if (msgDate > 0 && msgDate < bootTime) {
      log.debug(`Dropping stale message (date=${msgDate}, boot=${bootTime})`);
      return;
    }
    await next();
  });

  // Middleware: update deduplication
  bot.use(async (ctx, next) => {
    if (ctx.update.update_id && isDuplicate(ctx.update.update_id)) {
      log.debug(`Dropping duplicate update ${ctx.update.update_id}`);
      return;
    }
    await next();
  });

  // Setup progress callback for heartbeat messages
  setProgressCallback(async (chatId, message) => {
    try {
      await bot.api.sendMessage(chatId, message, { parse_mode: "Markdown" });
    } catch {
      try {
        await bot.api.sendMessage(chatId, message);
      } catch (err) {
        log.error("Failed to send progress update:", err);
      }
    }
  });

  // Wire bot API into telegram.send skill
  setBotSendFn(async (chatId, text) => {
    // Prepend timestamp to all messages
    const now = new Date();
    const timeStr = now.toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
    const textWithTime = `[${timeStr}] ${text}`;
    try {
      await bot.api.sendMessage(chatId, textWithTime, { parse_mode: "Markdown" });
    } catch {
      // Fallback: send without Markdown if parsing fails (e.g. unescaped special chars)
      await bot.api.sendMessage(chatId, textWithTime);
    }
  });

  // Wire bot API into telegram.voice skill
  setBotVoiceFn(async (chatId, audio, filename) => {
    await bot.api.sendVoice(chatId, new InputFile(audio, filename));
  });

  // Wire bot API into telegram.photo / image.generate skill
  setBotPhotoFn(async (chatId, photo, caption) => {
    const source = typeof photo === "string" ? new InputFile(photo) : new InputFile(photo, "image.png");
    await bot.api.sendPhoto(chatId, source, caption ? { caption } : undefined);
  });

  // --- Commands ---

  bot.command("start", async (ctx) => {
    await ctx.reply(
      "Hello! I'm an OpenClaw relay bot. Send me a message and I'll pass it to Claude.\n\n" +
        "Commands:\n" +
        "/clear — reset conversation history\n" +
        "/new — start a new conversation\n" +
        "/status — show session info\n" +
        "/compact — compact context history\n" +
        "/help — list available tools\n" +
        "/admin &lt;passphrase&gt; — unlock admin tools",
      { parse_mode: "HTML" }
    );
  });

  bot.command("clear", async (ctx) => {
    const chatId = ctx.chat.id;
    const userId = ctx.from?.id;
    await emitHook("session:reset", { chatId, userId });
    clearTurns(chatId);
    clearSession(chatId);
    await ctx.reply("Conversation history and session cleared.");
  });

  bot.command("new", async (ctx) => {
    const chatId = ctx.chat.id;
    const userId = ctx.from?.id;
    await emitHook("session:new", { chatId, userId });
    clearTurns(chatId);
    clearSession(chatId);
    await ctx.reply("Nouvelle conversation. Comment puis-je t'aider ?");
  });

  bot.command("status", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId || !isUserAllowed(userId)) {
      await ctx.reply("You are not authorised to use this bot.");
      return;
    }
    const chatId = ctx.chat.id;
    const turns = getTurns(chatId);
    const session = getSession(chatId);
    const adminStatus = isAdmin(userId);
    const uptimeMs = Date.now() - startTime;
    const uptimeMin = Math.floor(uptimeMs / 60000);
    const uptimeH = Math.floor(uptimeMin / 60);
    const uptimeStr = uptimeH > 0 ? `${uptimeH}h ${uptimeMin % 60}m` : `${uptimeMin}m`;

    const lines = [
      `<b>Status</b>`,
      ``,
      `<b>Model:</b> ${config.claudeModel}`,
      `<b>Session:</b> ${session ? session.slice(0, 12) + "..." : "none"}`,
      `<b>Turns:</b> ${turns.length}`,
      `<b>Uptime:</b> ${uptimeStr}`,
      `<b>Streaming:</b> ${config.streamingEnabled ? "on" : "off"}`,
      `<b>Admin:</b> ${adminStatus ? "yes" : "no"}`,
      `<b>Reactions:</b> ${config.reactionsEnabled ? "on" : "off"}`,
      `<b>Debounce:</b> ${config.debounceEnabled ? `on (${config.debounceMs}ms)` : "off"}`,
    ];
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  });

  bot.command("compact", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId || !isUserAllowed(userId)) {
      await ctx.reply("You are not authorised to use this bot.");
      return;
    }
    const chatId = ctx.chat.id;
    await ctx.replyWithChatAction("typing");
    const result = await compactContext(chatId, userId);
    await ctx.reply(result);
  });

  bot.command("help", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId || !isUserAllowed(userId)) {
      await ctx.reply("You are not authorised to use this bot.");
      return;
    }
    const response = await handleMessage(
      ctx.chat.id,
      "/help — list all available tools",
      userId
    );
    await sendLong(ctx, response);
  });

  bot.command("admin", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const passphrase = ctx.match?.trim();
    if (!passphrase) {
      await ctx.reply("Usage: /admin <passphrase>");
      return;
    }
    if (tryAdminAuth(userId, passphrase)) {
      await ctx.reply("Admin mode activated for this session.");
    } else {
      await ctx.reply("Invalid passphrase.");
    }
  });

  // --- Text message handler (with debouncing, reactions, streaming, chat lock) ---

  bot.on("message:text", async (ctx) => {
    const userId = ctx.from.id;
    const chatId = ctx.chat.id;
    const text = ctx.message.text;
    const messageId = ctx.message.message_id;

    // Allowlist check
    if (!isUserAllowed(userId)) {
      log.warn(`Blocked message from unauthorised user ${userId}`);
      await ctx.reply("You are not authorised to use this bot.");
      return;
    }

    // Rate limit
    if (!consumeToken(userId)) {
      await ctx.reply("Slow down! Please wait a moment before sending another message.");
      return;
    }

    log.info(`Message from user ${userId} in chat ${chatId}: ${text.slice(0, 80)}...`);

    // Debounce: buffer rapid messages
    const combined = await debounce(chatId, text);
    if (combined === null) {
      log.debug(`[telegram] Message buffered by debouncer for chat ${chatId}`);
      return; // Another message will carry the combined payload
    }

    // Enqueue via chat lock for sequential processing
    enqueue(chatId, async () => {
      const reaction = createReactionHandle(bot, chatId, messageId);
      await reaction.ack();

      // Show typing indicator
      try { await bot.api.sendChatAction(chatId, "typing"); } catch { /* ignore */ }

      // Prepend message metadata for Claude context
      const msgTime = new Date(ctx.message.date * 1000).toISOString();
      const fromName = ctx.from.first_name + (ctx.from.last_name ? ` ${ctx.from.last_name}` : "");
      const fromTag = ctx.from.username ? ` @${ctx.from.username}` : "";
      const replyInfo = ctx.message.reply_to_message ? ` replyTo=#${ctx.message.reply_to_message.message_id}` : "";
      const meta = `[msg:${messageId} time:${msgTime} from:${fromName}${fromTag}${replyInfo}]`;
      const messageWithMeta = `${meta}\n${combined}`;

      try {
        if (config.streamingEnabled) {
          const draft = createDraftController(bot, chatId);
          let response: string;

          // Periodic typing indicator + "working on it" message for long responses
          let timedOut = false;
          let timeoutMsgId: number | undefined;
          const interimTimer = setTimeout(async () => {
            timedOut = true;
            try {
              await bot.api.sendChatAction(chatId, "typing");
              const msg = await bot.api.sendMessage(chatId, "Je travaille sur ta demande, ça prend un peu plus de temps que prévu...");
              timeoutMsgId = msg.message_id;
            } catch { /* ignore */ }
          }, 30_000);

          // Keep sending "typing" every 8s so Telegram shows the indicator
          const typingInterval = setInterval(async () => {
            try { await bot.api.sendChatAction(chatId, "typing"); } catch { /* ignore */ }
          }, 8_000);

          // Global timeout: prevents the chat lock from blocking forever
          // if the streaming + tool chain hangs.
          const GLOBAL_STREAMING_TIMEOUT_MS = 660_000; // 11 minutes (above CLI_TIMEOUT to let CLI finish first)
          const globalTimeout = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Global streaming timeout (${GLOBAL_STREAMING_TIMEOUT_MS / 1000}s)`)), GLOBAL_STREAMING_TIMEOUT_MS)
          );

          try {
            response = await Promise.race([
              handleMessageStreaming(chatId, messageWithMeta, userId, draft),
              globalTimeout,
            ]);
          } catch (streamErr) {
            log.warn(`[telegram] Streaming/tool-chain failed, falling back to batch: ${streamErr}`);
            await draft.cancel();
            try {
              response = await handleMessage(chatId, messageWithMeta, userId);
            } catch (batchErr) {
              log.error(`[telegram] Batch fallback also failed: ${batchErr}`);
              response = "Désolé, je n'ai pas pu traiter ta demande. Réessaie avec /new pour repartir à zéro.";
            }
          } finally {
            clearTimeout(interimTimer);
            clearInterval(typingInterval);
          }

          // Clean up the "working on it" message
          if (timedOut && timeoutMsgId) {
            try { await bot.api.deleteMessage(chatId, timeoutMsgId); } catch { /* ignore */ }
          }

          const draftMsgId = draft.getMessageId();
          log.info(`[telegram] Streaming done: response=${response.length} chars, draftMsgId=${draftMsgId}, timedOut=${timedOut}`);
          // Draft controller already sent/edited the message if streaming worked.
          // If draft has no message (e.g. tool call path), send the response normally.
          if (!draftMsgId) {
            if (!response || response.trim().length === 0) {
              log.warn(`[telegram] Empty response from streaming — sending fallback`);
              await bot.api.sendMessage(chatId, "Je n'ai pas pu générer de réponse. Réessaie.");
            } else {
              log.info(`[telegram] Sending response via bot.api.sendMessage (${response.length} chars)...`);
              try {
                await sendFormatted(
                  (chunk, parseMode) => bot.api.sendMessage(chatId, chunk, parseMode ? { parse_mode: parseMode as any } : undefined),
                  response
                );
                log.info(`[telegram] Response sent successfully`);
              } catch (sendErr) {
                log.error(`[telegram] sendFormatted failed: ${sendErr}`);
                // Last resort — send plain text directly
                try {
                  const plain = response.slice(0, 4000);
                  await bot.api.sendMessage(chatId, plain);
                  log.info(`[telegram] Sent plain fallback`);
                } catch (plainErr) {
                  log.error(`[telegram] Even plain fallback failed: ${plainErr}`);
                }
              }
            }
          }
        } else {
          const response = await handleMessage(chatId, messageWithMeta, userId);
          await sendLong(ctx, response);
        }
        await reaction.done();
      } catch (err) {
        log.error("Error handling message:", err);
        logError(err instanceof Error ? err : String(err), "telegram:text_handler");
        await reaction.error();
        try {
          await ctx.reply("Désolé, une erreur s'est produite. Réessaie.");
        } catch { /* if even this fails, we can't do more */ }
      }
    });
  });

  // --- Photo handler ---

  bot.on("message:photo", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId || !isUserAllowed(userId)) {
      await ctx.reply("You are not authorised to use this bot.");
      return;
    }
    if (!consumeToken(userId)) {
      await ctx.reply("Slow down! Please wait a moment before sending another message.");
      return;
    }

    const chatId = ctx.chat.id;
    const messageId = ctx.message.message_id;
    const caption = ctx.message.caption || "";
    const photos = ctx.message.photo;
    const largest = photos[photos.length - 1];

    enqueue(chatId, async () => {
      const reaction = createReactionHandle(bot, chatId, messageId);
      await reaction.ack();
      try { await bot.api.sendChatAction(chatId, "typing"); } catch { /* ignore */ }

      let localPath: string | undefined;
      try {
        const filename = `photo_${chatId}_${Date.now()}.jpg`;
        localPath = await downloadTelegramFile(bot, largest.file_id, filename);
        log.info(`Downloaded photo to ${localPath}`);

        // Analyze image with Gemini vision
        const { describeImage } = await import("../llm/vision.js");
        const description = await describeImage(localPath, caption || "Que vois-tu dans cette image?");
        log.info(`[telegram] Vision analysis: ${description.slice(0, 100)}...`);

        // Keep the image file so Kingston can reference it for image.edit
        // Include the file path so Kingston can use image.edit if needed
        const message = [
          `[L'utilisateur a envoyé une photo.]`,
          `[Fichier sauvegardé: ${localPath}]`,
          `[Analyse de l'image:]\n${description}`,
          caption ? `[Légende:] ${caption}` : "",
          `[Note: Tu peux utiliser image.edit avec imagePath="${localPath}" pour modifier cette image.]`,
        ].filter(Boolean).join("\n");
        const response = await handleMessage(chatId, message, userId);
        await sendLong(ctx, response);
        await reaction.done();
      } catch (err) {
        log.error("Error handling photo:", err);
        logError(err instanceof Error ? err : String(err), "telegram:photo_handler");
        await reaction.error();
        await ctx.reply("Sorry, something went wrong processing your photo.");
      } finally {
        // Don't delete — keep for image.edit. Files are cleaned up on next upload cycle.
      }
    });
  });

  // --- Document handler ---

  bot.on("message:document", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId || !isUserAllowed(userId)) {
      await ctx.reply("You are not authorised to use this bot.");
      return;
    }
    if (!consumeToken(userId)) {
      await ctx.reply("Slow down! Please wait a moment before sending another message.");
      return;
    }

    const chatId = ctx.chat.id;
    const messageId = ctx.message.message_id;
    const caption = ctx.message.caption || "";
    const doc = ctx.message.document;
    const rawName = doc.file_name || `file_${Date.now()}`;
    const originalName = path.basename(rawName).replace(/[\\/:*?"<>|]/g, "_");

    enqueue(chatId, async () => {
      const reaction = createReactionHandle(bot, chatId, messageId);
      await reaction.ack();
      try { await bot.api.sendChatAction(chatId, "typing"); } catch { /* ignore */ }

      let localPath: string | undefined;
      try {
        const filename = `doc_${chatId}_${Date.now()}_${originalName}`;
        localPath = await downloadTelegramFile(bot, doc.file_id, filename);
        log.info(`Downloaded document to ${localPath}`);

        const message = `[File: ${localPath}]\n${caption}`.trim();
        const response = await handleMessage(chatId, message, userId);
        await sendLong(ctx, response);
        await reaction.done();
      } catch (err) {
        log.error("Error handling document:", err);
        logError(err instanceof Error ? err : String(err), "telegram:document_handler");
        await reaction.error();
        await ctx.reply("Sorry, something went wrong processing your file.");
      } finally {
        if (localPath && fs.existsSync(localPath)) {
          fs.unlinkSync(localPath);
        }
      }
    });
  });

  // --- Voice message handler ---

  bot.on("message:voice", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId || !isUserAllowed(userId)) return;
    if (!consumeToken(userId)) {
      await ctx.reply("Slow down! Please wait a moment before sending another message.");
      return;
    }
    await ctx.reply(
      "Voice message received. Transcription is not yet implemented — please send text instead."
    );
  });

  // Error handler
  bot.catch((err) => {
    log.error("Bot error:", err.message || err);
  });

  return bot;
}