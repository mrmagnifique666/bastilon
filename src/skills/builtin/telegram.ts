/**
 * Built-in skills: telegram.send, telegram.voice
 * Lets the bot proactively send messages and voice notes to Telegram chats.
 */
import { registerSkill } from "../loader.js";
import { config } from "../../config/env.js";
import { log } from "../../utils/log.js";

type SendFn = (chatId: number, text: string) => Promise<void>;
type VoiceFn = (chatId: number, audio: Buffer, filename: string) => Promise<void>;
type PhotoFn = (chatId: number, photo: string | Buffer, caption?: string) => Promise<void>;
type SendWithKeyboardFn = (chatId: number, text: string, keyboard: Array<Array<{ text: string; callback_data: string }>>) => Promise<number | null>;

let botSend: SendFn | null = null;
let botVoice: VoiceFn | null = null;
let botPhoto: PhotoFn | null = null;
let botSendWithKeyboard: SendWithKeyboardFn | null = null;

/** Called from telegram.ts after the Bot is created */
export function setBotSendFn(fn: SendFn): void {
  botSend = fn;
}

/** Called from telegram.ts after the Bot is created */
export function setBotVoiceFn(fn: VoiceFn): void {
  botVoice = fn;
}

/** Called from telegram.ts after the Bot is created */
export function setBotPhotoFn(fn: PhotoFn): void {
  botPhoto = fn;
}

export function getBotSendFn(): SendFn | null {
  return botSend;
}

export function getBotVoiceFn(): VoiceFn | null {
  return botVoice;
}

export function getBotPhotoFn(): PhotoFn | null {
  return botPhoto;
}

/** Called from telegram.ts after the Bot is created */
export function setBotSendWithKeyboardFn(fn: SendWithKeyboardFn): void {
  botSendWithKeyboard = fn;
}

export function getBotSendWithKeyboardFn(): SendWithKeyboardFn | null {
  return botSendWithKeyboard;
}

registerSkill({
  name: "telegram.send",
  description:
    "Send a message to a Telegram chat. Use this to notify the user or send results proactively.",
  argsSchema: {
    type: "object",
    properties: {
      chatId: {
        type: "string",
        description: "Telegram chat ID to send to (optional, defaults to TELEGRAM_ADMIN_CHAT_ID)",
      },
      text: {
        type: "string",
        description: "Message text to send (supports Markdown)",
      },
    },
    required: ["text"],
  },
  async execute(args): Promise<string> {
    // Accept both chatId and chat_id, both text and message
    const chatIdStr = (args.chatId ?? args.chat_id) as string | undefined;
    const text = (args.text ?? args.message) as string;

    // Fall back to adminChatId if not provided (for scheduled/autonomous tasks)
    const chatId = chatIdStr ? Number(chatIdStr) : config.adminChatId;
    if (!chatId || isNaN(chatId)) {
      return "Error: invalid chat_id — must be a number. Set TELEGRAM_ADMIN_CHAT_ID in .env for autonomous tasks.";
    }

    if (!botSend) {
      return "Error: bot API not available (bot not started yet).";
    }

    try {
      await botSend(chatId, text);
      log.info(`telegram.send: sent message to chat ${chatId}`);
      return `Message sent to chat ${chatId}.`;
    } catch (err) {
      return `Error sending message: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

const MAX_VOICE_CHARS = 5000;

registerSkill({
  name: "telegram.voice",
  description:
    "Send a voice message to a Telegram chat using text-to-speech (Edge TTS, free). " +
    "Use this when the user asks for a vocal/audio response. Max 5000 characters.",
  argsSchema: {
    type: "object",
    properties: {
      chatId: {
        type: "string",
        description: "Telegram chat ID to send to (optional, defaults to TELEGRAM_ADMIN_CHAT_ID)",
      },
      text: {
        type: "string",
        description: "Text to convert to speech and send as voice message",
      },
    },
    required: ["text"],
  },
  async execute(args): Promise<string> {
    const chatIdStr = (args.chatId ?? args.chat_id) as string | undefined;
    const text = (args.text ?? args.message) as string;

    const chatId = chatIdStr ? Number(chatIdStr) : config.adminChatId;
    if (!chatId || isNaN(chatId)) {
      return "Error: invalid chat_id — must be a number. Set TELEGRAM_ADMIN_CHAT_ID in .env for autonomous tasks.";
    }

    if (!text || text.trim().length === 0) {
      return "Error: text is empty.";
    }

    if (text.length > MAX_VOICE_CHARS) {
      return `Error: text too long (${text.length} chars). Maximum is ${MAX_VOICE_CHARS}.`;
    }

    if (!botVoice) {
      return "Error: bot API not available (bot not started yet).";
    }

    try {
      const { edgeTtsToMp3 } = await import("../../voice/edgeTts.js");
      const buffer = await edgeTtsToMp3(text.slice(0, 2000));
      const filename = `voice_${chatId}_${Date.now()}.mp3`;

      await botVoice(chatId, buffer, filename);
      log.info(`telegram.voice: sent voice message to chat ${chatId} (${buffer.length} bytes)`);
      return `Voice message sent to chat ${chatId}.`;
    } catch (err) {
      return `Error generating voice: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

// ─── telegram.call ──────────────────────────────────────────────────────
// Voice call via CallMeBot API — rings the user on Telegram with TTS or MP3.
// Setup: user must message @CallMeBot_txtbot with /start first.
// Limitation: max 256 chars TTS, one-way (notification style), iOS may not play audio.

registerSkill({
  name: "telegram.call",
  description:
    "Call the user on Telegram with a voice message (via CallMeBot). " +
    "Rings their phone and speaks the text. Max 256 chars. User must have activated @CallMeBot_txtbot first.",
  argsSchema: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description: "Message to speak (max 256 characters)",
      },
      username: {
        type: "string",
        description: "Telegram username (e.g. @nicolas). Defaults to CALLMEBOT_USER env var.",
      },
      lang: {
        type: "string",
        description: "Voice language code (e.g. fr-FR-Standard-A for French, en-US-Standard-B for English). Default: fr-FR-Standard-A",
      },
    },
    required: ["text"],
  },
  async execute(args): Promise<string> {
    const text = (args.text as string || "").slice(0, 256);
    const username = (args.username as string) || process.env.CALLMEBOT_USER || "";
    const lang = (args.lang as string) || "fr-FR-Standard-A";

    if (!username) {
      return "Error: No username. Set CALLMEBOT_USER in .env (e.g. @nicolas) or pass username arg.";
    }

    if (!text.trim()) {
      return "Error: text is empty.";
    }

    try {
      const url = `http://api.callmebot.com/start.php?user=${encodeURIComponent(username)}&text=${encodeURIComponent(text)}&lang=${encodeURIComponent(lang)}&rpt=2`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });

      if (resp.ok) {
        log.info(`telegram.call: called ${username} with "${text.slice(0, 50)}..."`);
        return `📞 Call initiated to ${username}. The phone should ring within seconds.`;
      }

      const body = await resp.text().catch(() => "no body");
      return `Error: CallMeBot returned ${resp.status} — ${body.slice(0, 200)}`;
    } catch (err) {
      return `Error calling: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

// ─── telegram.call_mp3 ─────────────────────────────────────────────────
// Call with a custom MP3 file (e.g. ElevenLabs-generated voice).

registerSkill({
  name: "telegram.call_mp3",
  description:
    "Call the user on Telegram playing an MP3 file (via CallMeBot). " +
    "Use for custom voice (e.g. ElevenLabs). User must have activated @CallMeBot_txtbot first.",
  argsSchema: {
    type: "object",
    properties: {
      mp3_url: {
        type: "string",
        description: "Public URL of the MP3 file to play",
      },
      username: {
        type: "string",
        description: "Telegram username (e.g. @nicolas). Defaults to CALLMEBOT_USER env var.",
      },
    },
    required: ["mp3_url"],
  },
  async execute(args): Promise<string> {
    const mp3Url = args.mp3_url as string;
    const username = (args.username as string) || process.env.CALLMEBOT_USER || "";

    if (!username) {
      return "Error: No username. Set CALLMEBOT_USER in .env or pass username arg.";
    }

    if (!mp3Url.startsWith("http")) {
      return "Error: mp3_url must be a public HTTP/HTTPS URL.";
    }

    try {
      const url = `http://api.callmebot.com/start.php?user=${encodeURIComponent(username)}&file=${encodeURIComponent(mp3Url)}`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });

      if (resp.ok) {
        log.info(`telegram.call_mp3: called ${username} with MP3: ${mp3Url.slice(0, 80)}`);
        return `📞 MP3 call initiated to ${username}.`;
      }

      const body = await resp.text().catch(() => "no body");
      return `Error: CallMeBot returned ${resp.status} — ${body.slice(0, 200)}`;
    } catch (err) {
      return `Error calling: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});


// ─── telegram.send_photo ─────────────────────────────────────────────────────
// Send a photo/image to a Telegram chat (URL or local file path).

registerSkill({
  name: "telegram.send_photo",
  description:
    "Send a photo or image to a Telegram chat. Accepts a public URL or absolute local file path. " +
    "Optional caption text supports Markdown. Used by briefings, trading charts, meme generation.",
  argsSchema: {
    type: "object",
    properties: {
      chatId: {
        type: "string",
        description: "Telegram chat ID (optional, defaults to TELEGRAM_ADMIN_CHAT_ID)",
      },
      photo: {
        type: "string",
        description: "Public URL or absolute local file path of the image to send",
      },
      caption: {
        type: "string",
        description: "Optional caption text (supports Markdown)",
      },
    },
    required: ["photo"],
  },
  async execute(args): Promise<string> {
    const chatIdStr = (args.chatId ?? args.chat_id) as string | undefined;
    const photo = args.photo as string;
    const caption = (args.caption as string | undefined) ?? undefined;

    const chatId = chatIdStr ? Number(chatIdStr) : config.adminChatId;
    if (!chatId || isNaN(chatId)) {
      return "Error: invalid chat_id — must be a number. Set TELEGRAM_ADMIN_CHAT_ID in .env.";
    }

    if (!photo || !photo.trim()) {
      return "Error: photo is required (URL or local file path).";
    }

    if (!botPhoto) {
      return "Error: bot photo API not available (bot not started yet).";
    }

    try {
      await botPhoto(chatId, photo.trim(), caption);
      log.info(`telegram.send_photo: sent photo to chat ${chatId}${caption ? " with caption" : ""}`);
      return `Photo sent to chat ${chatId}.`;
    } catch (err) {
      return `Error sending photo: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});
