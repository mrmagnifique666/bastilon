/**
 * Voice cloning skills for Kingston.
 * Uses the XTTS v2 Python microservice for voice cloning and custom TTS.
 *
 * Skills:
 *   voice.clone   — Clone a voice from an audio file
 *   voice.list    — List available voice profiles
 *   voice.use     — Set the active voice for TTS
 *   voice.extract — Extract audio from a video file
 *   voice.status  — Check XTTS server status
 *   voice.speak   — Generate speech with a cloned voice
 */
import { registerSkill } from "../loader.js";
import { log } from "../../utils/log.js";
import {
  xttsHealthCheck,
  xttsList,
  xttsUse,
  xttsClone,
  xttsExtractAudio,
  xttsGenerate,
  wavToMp3,
} from "../../voice/xttsClient.js";
import { getBotSendFn, getBotPhotoFn } from "./telegram.js";
import { config } from "../../config/env.js";
import path from "node:path";
import fs from "node:fs";

// ── voice.status ──────────────────────────────────────────────────────
registerSkill({
  name: "voice.status",
  description:
    "Check the XTTS voice cloning server status. Shows if the model is loaded, " +
    "active voice, VRAM usage, and available voices.",
  argsSchema: { type: "object", properties: {}, required: [] },
  async execute(): Promise<string> {
    const health = await xttsHealthCheck();
    if (!health.ok) {
      return (
        "XTTS server is **offline**.\n" +
        "Start it with: `python src/voice/xtts/server.py`\n" +
        "Or use Edge TTS (free, unlimited) as fallback."
      );
    }
    return [
      `**XTTS Server**: online`,
      `**Model loaded**: ${health.model_loaded ? "yes" : "no (will load on first use)"}`,
      `**Device**: ${health.device}`,
      `**Active voice**: ${health.active_voice || "none"}`,
      `**Voices available**: ${health.voices}`,
      `**VRAM used**: ${health.vram_used_gb} GB`,
    ].join("\n");
  },
});

// ── voice.list ────────────────────────────────────────────────────────
registerSkill({
  name: "voice.list",
  description:
    "List all available cloned voice profiles. Shows name, description, language, " +
    "and which voice is currently active.",
  argsSchema: { type: "object", properties: {}, required: [] },
  async execute(): Promise<string> {
    try {
      const { voices, active } = await xttsList();
      if (voices.length === 0) {
        return "No voice profiles found. Use `voice.clone` to create one from an audio file.";
      }
      const lines = voices.map((v) => {
        const marker = v.name === active ? " ← active" : "";
        return `• **${v.name}**${marker} — ${v.description || "no description"} (${v.language}, ${v.audio_files} files)`;
      });
      return `**Voice Profiles** (${voices.length}):\n${lines.join("\n")}`;
    } catch (err) {
      return `Error: XTTS server unavailable — ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

// ── voice.use ─────────────────────────────────────────────────────────
registerSkill({
  name: "voice.use",
  description:
    "Set the active voice for text-to-speech. The voice must have been cloned first.",
  argsSchema: {
    type: "object",
    properties: {
      voice: {
        type: "string",
        description: "Name of the voice profile to activate",
      },
    },
    required: ["voice"],
  },
  async execute(args): Promise<string> {
    const voice = args.voice as string;
    try {
      const active = await xttsUse(voice);
      return `Voice switched to **${active}**. All TTS will now use this voice.`;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

// ── voice.clone ───────────────────────────────────────────────────────
registerSkill({
  name: "voice.clone",
  description:
    "Clone a voice from an audio file (WAV, MP3, etc). Only 6 seconds of clean speech needed. " +
    "The audio should contain a single speaker with minimal background noise.",
  argsSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Name for the voice profile (e.g., 'morgan-freeman', 'nicolas')",
      },
      audio_path: {
        type: "string",
        description: "Path to the audio file on disk",
      },
      description: {
        type: "string",
        description: "Optional description of the voice",
      },
      language: {
        type: "string",
        description: "Language code (default: fr). Supports: fr, en, es, de, it, pt, pl, tr, ru, nl, cs, ar, zh, ja, ko, hu",
      },
    },
    required: ["name", "audio_path"],
  },
  async execute(args): Promise<string> {
    const name = args.name as string;
    const audioPath = args.audio_path as string;
    const description = (args.description as string) || "";
    const language = (args.language as string) || "fr";

    if (!fs.existsSync(audioPath)) {
      return `Error: file not found — ${audioPath}`;
    }

    try {
      const result = await xttsClone(name, audioPath, description, language);
      return [
        `Voice **${result.name}** cloned successfully!`,
        `Set as active: ${result.active}`,
        `Use \`voice.speak\` to test it or \`voice.use\` to switch voices.`,
      ].join("\n");
    } catch (err) {
      return `Error cloning voice: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

// ── voice.extract ─────────────────────────────────────────────────────
registerSkill({
  name: "voice.extract",
  description:
    "Extract audio from a video/movie file and create a voice profile. " +
    "Specify start time and duration to get a clean speech segment.",
  argsSchema: {
    type: "object",
    properties: {
      video_path: {
        type: "string",
        description: "Path to the video file",
      },
      voice_name: {
        type: "string",
        description: "Name for the voice profile",
      },
      start_time: {
        type: "string",
        description: "Start time in seconds or HH:MM:SS (default: 0)",
      },
      duration: {
        type: "string",
        description: "Duration in seconds (default: 30, recommended: 10-60)",
      },
    },
    required: ["video_path", "voice_name"],
  },
  async execute(args): Promise<string> {
    const videoPath = args.video_path as string;
    const voiceName = args.voice_name as string;
    const startTime = (args.start_time as string) || "0";
    const duration = (args.duration as string) || "30";

    if (!fs.existsSync(videoPath)) {
      return `Error: file not found — ${videoPath}`;
    }

    try {
      const result = await xttsExtractAudio(videoPath, voiceName, startTime, duration);
      return [
        `Audio extracted and voice **${result.name}** created!`,
        `Reference audio: ${result.size_kb} KB`,
        `Set as active: ${result.active}`,
      ].join("\n");
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

// ── voice.speak ───────────────────────────────────────────────────────
registerSkill({
  name: "voice.speak",
  description:
    "Generate speech using a cloned voice (XTTS v2). Falls back to Edge TTS if XTTS is unavailable. " +
    "Sends the audio as a Telegram voice message.",
  argsSchema: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description: "Text to speak",
      },
      voice: {
        type: "string",
        description: "Voice profile name (optional, uses active voice if not set)",
      },
      language: {
        type: "string",
        description: "Language code (default: fr)",
      },
      chatId: {
        type: "string",
        description: "Telegram chat ID (optional, defaults to admin)",
      },
    },
    required: ["text"],
  },
  async execute(args): Promise<string> {
    const text = (args.text ?? args.message) as string;
    const voice = args.voice as string | undefined;
    const language = (args.language as string) || "fr";
    const chatIdStr = (args.chatId ?? args.chat_id) as string | undefined;
    const chatId = chatIdStr ? Number(chatIdStr) : config.adminChatId;

    if (!text || text.trim().length === 0) return "Error: text is empty.";
    if (text.length > 5000) return `Error: text too long (${text.length} chars, max 5000).`;

    // Try XTTS first
    const wavBuffer = await xttsGenerate(text, voice, language);

    if (wavBuffer) {
      const mp3Buffer = await wavToMp3(wavBuffer);

      // Send via Telegram if real chat
      if (chatId && chatId > 1000) {
        try {
          const { getBotVoiceFn } = await import("./telegram.js");
          const botVoice = getBotVoiceFn();
          if (botVoice) {
            await botVoice(chatId, mp3Buffer, `voice_${Date.now()}.mp3`);
            log.info(`[voice.speak] Sent XTTS voice to Telegram chat ${chatId}`);
            return `Voice message sent with cloned voice${voice ? ` (${voice})` : ""}.`;
          }
        } catch {}
      }

      // Save to uploads for dashboard display
      const uploadsDir = path.resolve(process.cwd(), "relay", "uploads");
      if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
      const filename = `voice_${Date.now()}.mp3`;
      fs.writeFileSync(path.join(uploadsDir, filename), mp3Buffer);

      log.info(`[voice.speak] Generated with XTTS: ${mp3Buffer.length} bytes`);
      return `Voice generated with cloned voice${voice ? ` (${voice})` : ""}. Audio: http://localhost:3200/uploads/${filename}`;
    }

    // Fallback to Edge TTS
    try {
      const { edgeTtsToMp3 } = await import("../../voice/edgeTts.js");
      const mp3 = await edgeTtsToMp3(text.slice(0, 2000));

      const uploadsDir = path.resolve(process.cwd(), "relay", "uploads");
      if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
      const filename = `voice_${Date.now()}.mp3`;
      fs.writeFileSync(path.join(uploadsDir, filename), mp3);

      return `XTTS unavailable — used Edge TTS fallback. Audio: http://localhost:3200/uploads/${filename}`;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});
