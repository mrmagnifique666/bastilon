/**
 * Telegram bot setup using grammY with long polling.
 * Handles text messages, photos, documents, user allowlist checks, and rate limiting.
 * Features: reactions, debouncing, dedup, streaming, chat lock, advanced formatting.
 */
import { Bot, InputFile, InlineKeyboard, GrammyError, HttpError } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config/env.js";
import { isUserAllowed, tryAdminAuth, isAdmin } from "../security/policy.js";
import { consumeToken } from "../security/rateLimit.js";
import { handleMessage, handleMessageStreaming, setProgressCallback } from "../orchestrator/router.js";
import { clearTurns, clearSession, getTurns, getSession, logError } from "../storage/store.js";
import { setBotSendFn, setBotVoiceFn, setBotPhotoFn, setBotSendWithKeyboardFn, setBotPollFn } from "../skills/builtin/telegram.js";
import { handleVetoCallback } from "../skills/builtin/mind.js";
import { setBotVideoFn } from "../skills/builtin/video.js";
import { setBotPhotoFnForCU } from "../skills/builtin/computer-use.js";
import { setShadowrunBotFns } from "../skills/builtin/shadowrun-player.js";
import { log } from "../utils/log.js";
import { debounce } from "./debouncer.js";
import { enqueueAdmin, interruptCurrent, isAdminBusy } from "./chatLock.js";
import { sendFormatted } from "./formatting.js";
import { createDraftController } from "./draftMessage.js";
import { compactContext } from "../orchestrator/compaction.js";
import { emitHook, emitHookAsync } from "../hooks/hooks.js";
import { getDashboardPublicUrl } from "../dashboard/server.js";
import { getBridgeContext, notifyPartner, hasBridgePartner, setBridgeResponseHandler } from "../bridge/bridge.js";
import { debateWithPeer, isPeerConnected, notifyPeer } from "../bridge/wsBridge.js";

const startTime = Date.now();

// --- Finisher: detect and fix incomplete responses ---

/** Patterns that indicate an incomplete/lazy response */
const INCOMPLETE_PATTERNS = [
  /^J'ai exécuté \d+ outils?\. Résultats:\n/,  // Just echoing tool results
  /^• \w+\.\w+: OK$/m,                          // Single "tool: OK" line
];

/** Check if a response looks incomplete and re-prompt if needed */
async function finishResponse(
  response: string,
  chatId: number,
  userId: number,
  originalMessage: string,
): Promise<string> {
  const trimmed = response.trim();

  // Skip if response is already substantial (>200 chars) or empty
  if (!trimmed || trimmed.length > 200) return response;

  // Check for incomplete patterns
  const isIncomplete =
    INCOMPLETE_PATTERNS.some(p => p.test(trimmed)) ||
    (trimmed.length < 80 && /^(• \w+\.\w+: (OK|Error)[^\n]*\n?)+$/.test(trimmed));

  if (!isIncomplete) return response;

  log.warn(`[finisher] Incomplete response detected (${trimmed.length} chars): "${trimmed.slice(0, 80)}..."`);

  // Re-prompt Claude to elaborate
  const finisherPrompt =
    `[FINISHER — RÉPONSE INCOMPLÈTE]\n` +
    `Tu viens de répondre ceci à Nicolas:\n"${trimmed}"\n\n` +
    `C'est insuffisant. Nicolas attend une vraie réponse qui EXPLIQUE ce que tu as trouvé/fait.\n` +
    `Message original de Nicolas: "${originalMessage.slice(0, 200)}"\n\n` +
    `Rédige maintenant une réponse complète, naturelle et utile. Pas de tool_call, juste du texte.`;

  try {
    const better = await handleMessage(chatId, finisherPrompt, userId);
    if (better && better.trim().length > trimmed.length) {
      log.info(`[finisher] Re-prompted: ${trimmed.length} → ${better.trim().length} chars`);
      return better;
    }
  } catch (err) {
    log.warn(`[finisher] Re-prompt failed: ${err}`);
  }

  return response; // fallback to original if re-prompt fails
}

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
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 60 }));
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
      await sendFormatted(
        (chunk, parseMode) => bot.api.sendMessage(chatId, chunk, parseMode ? { parse_mode: parseMode as any } : undefined),
        message
      );
    } catch (err) {
      log.error("Failed to send progress update:", err);
    }
  });

  // Wire bot API into telegram.send skill — uses sendFormatted for auto-splitting
  setBotSendFn(async (chatId, text) => {
    const now = new Date();
    const timeStr = now.toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      timeZone: "America/Toronto"
    });
    const textWithTime = `[${timeStr}] ${text}`;
    await sendFormatted(
      (chunk, parseMode) => bot.api.sendMessage(chatId, chunk, parseMode ? { parse_mode: parseMode as any } : undefined),
      textWithTime
    );
  });

  // Wire bot API into telegram.voice skill
  setBotVoiceFn(async (chatId, audio, filename) => {
    await bot.api.sendVoice(chatId, new InputFile(audio, filename));
  });

  // Wire bot API into telegram.photo / image.generate skill
  setBotPhotoFn(async (chatId, photo, caption) => {
    // If photo is a string URL (http/https), pass it directly to Telegram Bot API
    // which natively supports sending photos by URL without downloading.
    if (typeof photo === "string" && (photo.startsWith("http://") || photo.startsWith("https://"))) {
      await bot.api.sendPhoto(chatId, photo, caption ? { caption } : undefined);
    } else {
      const source = typeof photo === "string" ? new InputFile(photo) : new InputFile(photo, "image.png");
      await bot.api.sendPhoto(chatId, source, caption ? { caption } : undefined);
    }
  });

  // Wire bot API into video.generate skill
  setBotVideoFn(async (chatId, videoPath, caption) => {
    await bot.api.sendVideo(chatId, new InputFile(videoPath), caption ? { caption } : undefined);
  });

  // Wire bot API into computer.use skill (desktop screenshots)
  setBotPhotoFnForCU(async (chatId, photo, caption) => {
    const source = new InputFile(photo, "desktop.png");
    await bot.api.sendPhoto(chatId, source, caption ? { caption } : undefined);
  });

  // Wire bot API into Shadowrun player
  setShadowrunBotFns(
    async (chatId, photo, caption) => {
      const source = new InputFile(photo, "shadowrun.png");
      await bot.api.sendPhoto(chatId, source, caption ? { caption } : undefined);
    },
    async (chatId, text) => {
      await bot.api.sendMessage(chatId, text, { parse_mode: "Markdown" });
    },
  );

  // Wire bot API for inline keyboard messages (veto system)
  setBotSendWithKeyboardFn(async (chatId, text, keyboard) => {
    const kb = new InlineKeyboard();
    for (const row of keyboard) {
      for (const btn of row) {
        kb.text(btn.text, btn.callback_data);
      }
      kb.row();
    }
    const msg = await bot.api.sendMessage(chatId, text, { reply_markup: kb });
    return msg.message_id;
  });

  // Wire bot API for polls
  setBotPollFn(async (chatId, question, options, opts) => {
    const msg = await bot.api.sendPoll(chatId, question, options, {
      is_anonymous: opts?.is_anonymous ?? true,
      allows_multiple_answers: opts?.allows_multiple_answers ?? false,
      ...(opts?.open_period ? { open_period: opts.open_period } : {}),
    });
    return msg.message_id;
  });

  // --- Callback Query Handler (veto/approve buttons) ---

  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    const match = data.match(/^(approve|veto)_(\d+)$/);
    if (!match) {
      await ctx.answerCallbackQuery({ text: "Action inconnue" });
      return;
    }
    const [, action, idStr] = match;
    const decisionId = Number(idStr);
    const approved = action === "approve";

    const result = handleVetoCallback(decisionId, approved);
    await ctx.answerCallbackQuery({ text: result.slice(0, 200) });

    // Edit the original message to show the result
    try {
      const icon = approved ? "✅" : "❌";
      const statusText = approved ? "APPROUVÉ par Nicolas" : "VETO par Nicolas";
      await ctx.editMessageText(
        `${ctx.callbackQuery.message?.text}\n\n${icon} ${statusText}`,
      );
    } catch { /* message may have been deleted */ }
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
        "/app — open dashboard Mini App\n" +
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

  bot.command("app", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId || !isUserAllowed(userId)) {
      await ctx.reply("You are not authorised to use this bot.");
      return;
    }
    const url = getDashboardPublicUrl();
    if (!url) {
      await ctx.reply("Dashboard non disponible — tunnel Cloudflare non actif.\nLe tunnel demarre automatiquement au boot. Reessaie dans quelques secondes.");
      return;
    }
    const webappUrl = url + "/webapp.html";
    const kb = new InlineKeyboard().webApp("Ouvrir Dashboard", webappUrl);
    await ctx.reply("Ton dashboard Kingston:", { reply_markup: kb });
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
    emitHookAsync("message:received", { chatId, userId, messageType: "text" });

    // Debounce: buffer rapid messages
    const combined = await debounce(chatId, text);
    if (combined === null) {
      log.debug(`[telegram] Message buffered by debouncer for chat ${chatId}`);
      return; // Another message will carry the combined payload
    }

    // INTERRUPT: If Kingston is currently processing a user message, interrupt it
    // so the new message gets handled promptly instead of waiting in queue
    if (isAdminBusy()) {
      const wasInterrupted = interruptCurrent();
      if (wasInterrupted) {
        log.info(`[telegram] Interrupted current processing — new message from user ${userId}`);
      }
    }

    // Enqueue via global admin lock — serializes user messages, scheduler, agents
    // Type "user" = interruptible by new user messages
    enqueueAdmin(async () => {
      const reaction = createReactionHandle(bot, chatId, messageId);
      try { await Promise.race([reaction.ack(), new Promise((_, r) => setTimeout(r, 5000))]); } catch { /* timeout ok */ }

      // Show typing indicator
      try { await bot.api.sendChatAction(chatId, "typing"); } catch { /* ignore */ }

      // Prepend message metadata for Claude context
      const msgTime = new Date(ctx.message.date * 1000).toISOString();
      const fromName = ctx.from.first_name + (ctx.from.last_name ? ` ${ctx.from.last_name}` : "");
      const fromTag = ctx.from.username ? ` @${ctx.from.username}` : "";
      const replyInfo = ctx.message.reply_to_message ? ` replyTo=#${ctx.message.reply_to_message.message_id}` : "";
      const meta = `[msg:${messageId} time:${msgTime} from:${fromName}${fromTag}${replyInfo}]`;
      let messageWithMeta = `${meta}\n${combined}`;

      // Bridge context injection for group chats (real Telegram groups have chatId > 1000 or negative)
      if (hasBridgePartner() && (chatId > 1000 || chatId < 0)) {
        const bridgeCtx = getBridgeContext(chatId);
        if (bridgeCtx) {
          messageWithMeta = `${bridgeCtx}\n\n${messageWithMeta}`;
          log.debug(`[bridge] Injected bridge context for group chat ${chatId}`);
        }
      }

      // Dungeon strategy phase intercept
      try {
        const { tryDungeonStrategyIntercept } = await import("../skills/builtin/dungeon.js");
        const dungeonReply = await tryDungeonStrategyIntercept(chatId, combined);
        if (dungeonReply) {
          await sendFormatted(
            (chunk, parseMode) => bot.api.sendMessage(chatId, chunk, parseMode ? { parse_mode: parseMode as any } : undefined),
            dungeonReply
          );
          await reaction.done();
          return;
        }
      } catch (err) {
        log.debug(`[telegram] Dungeon strategy intercept skipped: ${err}`);
      }

      let bridgeResponseText = ""; // Captured for bridge notification
      let debateHandled = false;
      const isGroupChat = chatId > 1000 || chatId < 0;
      const debatePeer = config.bridgeDebatePeer;
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
          const GLOBAL_STREAMING_TIMEOUT_MS = 720_000; // 12 minutes (above CLI_TIMEOUT to let CLI finish first)
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

          // ── Finisher: detect incomplete responses and re-prompt ──
          response = await finishResponse(response, chatId, userId, combined);
          bridgeResponseText = response;

          const draftMsgId = draft.getMessageId();
          log.info(`[telegram] Streaming done: response=${response.length} chars, draftMsgId=${draftMsgId}, timedOut=${timedOut}`);

          // ── Debate: notify peer BEFORE posting (streaming path, not yet streamed) ──
          if (isGroupChat && !draftMsgId && isPeerConnected(debatePeer)) {
            debateHandled = await debateWithPeer(debatePeer, {
              chatId,
              humanMessage: combined,
              kingstonResponse: response,
            });
          }

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
          bridgeResponseText = response;

          // ── Debate: notify peer BEFORE posting (batch path) ──
          if (isGroupChat && isPeerConnected(debatePeer)) {
            debateHandled = await debateWithPeer(debatePeer, {
              chatId,
              humanMessage: combined,
              kingstonResponse: response,
            });
          }

          await sendLong(ctx, response);
        }
        await reaction.done();
        emitHookAsync("message:sent", { chatId, userId });

        // Bridge: notify partner bot for group chats
        if (isGroupChat && bridgeResponseText) {
          if (isPeerConnected(debatePeer) && !debateHandled) {
            // WS peer connected but debate wasn't triggered (e.g. streaming draft already posted)
            notifyPeer(debatePeer, JSON.stringify({
              type: "notify",
              chatId,
              kingstonResponse: bridgeResponseText,
            }));
          } else if (!isPeerConnected(debatePeer) && hasBridgePartner()) {
            // Fallback: HTTP bridge (legacy)
            notifyPartner(bridgeResponseText, chatId);
          }
        }
      } catch (err) {
        log.error("Error handling message:", err);
        logError(err instanceof Error ? err : String(err), "telegram:text_handler");
        await reaction.error();
        emitHookAsync("error:unhandled", { chatId, component: "telegram", error: String(err) });
        try {
          await ctx.reply("Désolé, une erreur s'est produite. Réessaie.");
        } catch { /* if even this fails, we can't do more */ }
      }
    }, "user");
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

    enqueueAdmin(async () => {
      const reaction = createReactionHandle(bot, chatId, messageId);
      try { await Promise.race([reaction.ack(), new Promise((_, r) => setTimeout(r, 5000))]); } catch { /* timeout ok */ }
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
    }, "user");
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

    enqueueAdmin(async () => {
      const reaction = createReactionHandle(bot, chatId, messageId);
      try { await Promise.race([reaction.ack(), new Promise((_, r) => setTimeout(r, 5000))]); } catch { /* timeout ok */ }
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
    }, "user");
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

  // ── Débat Permanent: respond to partner's bridge messages ──
  if (hasBridgePartner()) {
    setBridgeResponseHandler(async (from, text, chatId) => {
      log.info(`[bridge] Débat Permanent: responding to ${from} in chat ${chatId}`);

      // Small delay for natural conversation flow
      await new Promise((r) => setTimeout(r, 3000));

      try {
        await bot.api.sendChatAction(Number(chatId), "typing");
      } catch { /* group may not allow it */ }

      const bridgeCtx = getBridgeContext(chatId);
      let messageForClaude = `[${from} vient de poster dans le groupe]: ${text}`;
      if (bridgeCtx) {
        messageForClaude = `${bridgeCtx}\n\n${messageForClaude}`;
      }
      messageForClaude += `\n\n[INSTRUCTION: ${from} a répondu dans le groupe. Donne ta propre perspective en 2-3 phrases max. Ne répète pas ce qu'il/elle a dit — ajoute de la valeur ou exprime un désaccord respectueux.]`;

      try {
        const response = await handleMessage(Number(chatId), messageForClaude, config.adminChatId);

        await sendFormatted(
          (chunk, parseMode) => bot.api.sendMessage(Number(chatId), chunk, parseMode ? { parse_mode: parseMode as any } : undefined),
          response
        );

        // Notify partner — marked as bridge reply to prevent infinite loop
        notifyPartner(response, chatId, true);
        log.info(`[bridge] Débat Permanent: sent response (${response.length} chars)`);
      } catch (err) {
        log.error(`[bridge] Débat Permanent failed: ${err}`);
      }
    });
    log.info("[bridge] Débat Permanent handler registered");
  }

  // Error handler — distinguish error types to avoid unnecessary crashes
  bot.catch((err) => {
    const e = err.error;

    if (e instanceof GrammyError) {
      if (e.error_code === 409) {
        log.error("[bot] 409 Conflict — another bot instance is polling. Will stop.");
        return; // Don't crash, let the other instance handle it
      }
      if (e.error_code === 429) {
        log.warn(`[bot] Rate limited. Retry after ${e.parameters?.retry_after ?? "?"}s`);
        return; // grammY handles retry internally
      }
      log.error(`[bot] Telegram API error ${e.error_code}: ${e.description}`);
    } else if (e instanceof HttpError) {
      log.error(`[bot] Network error: ${e.message}`);
    } else {
      log.error("[bot] Unknown error:", e);
    }
  });

  return bot;
}