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

let botSend: SendFn | null = null;
let botVoice: VoiceFn | null = null;
let botPhoto: PhotoFn | null = null;

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

export function getBotPhotoFn(): PhotoFn | null {
  return botPhoto;
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
const ELEVENLABS_TIMEOUT_MS = 30_000;

registerSkill({
  name: "telegram.voice",
  description:
    "Send a voice message to a Telegram chat using text-to-speech (ElevenLabs). " +
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

    // Fall back to adminChatId if not provided (for scheduled/autonomous tasks)
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

    if (!config.elevenlabsApiKey) {
      return "Error: ELEVENLABS_API_KEY is not configured.";
    }

    if (!botVoice) {
      return "Error: bot API not available (bot not started yet).";
    }

    const voiceId = config.elevenlabsVoiceId;
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ELEVENLABS_TIMEOUT_MS);

      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "xi-api-key": config.elevenlabsApiKey,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text,
          model_id: "eleven_multilingual_v2",
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        return `Error: ElevenLabs API returned ${resp.status}: ${body.slice(0, 200)}`;
      }

      const buffer = Buffer.from(await resp.arrayBuffer());
      const filename = `voice_${chatId}_${Date.now()}.mp3`;

      await botVoice(chatId, buffer, filename);
      log.info(`telegram.voice: sent voice message to chat ${chatId} (${buffer.length} bytes)`);
      return `Voice message sent to chat ${chatId}.`;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return "Error: ElevenLabs API request timed out (30s).";
      }
      return `Error generating voice: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});
