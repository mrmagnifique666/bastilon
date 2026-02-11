/**
 * Edge TTS — Free unlimited text-to-speech via Microsoft Edge's TTS engine.
 * No API key required. Supports French, English, and 300+ voices.
 *
 * Uses msedge-tts npm package (WebSocket to Microsoft's public TTS service).
 */
import { log } from "../utils/log.js";

// Voice presets for common languages
const VOICE_MAP: Record<string, string> = {
  "fr-male": "fr-FR-HenriNeural",
  "fr-female": "fr-FR-DeniseNeural",
  "en-male": "en-US-GuyNeural",
  "en-female": "en-US-JennyNeural",
  "es-male": "es-ES-AlvaroNeural",
  "es-female": "es-ES-ElviraNeural",
};

const DEFAULT_VOICE = "fr-FR-HenriNeural";

/**
 * Convert text to speech using Microsoft Edge TTS (free, unlimited).
 * Returns an MP3 buffer.
 */
export async function edgeTtsToMp3(
  text: string,
  voice?: string,
): Promise<Buffer> {
  const { MsEdgeTTS } = await import("msedge-tts");

  const tts = new MsEdgeTTS();
  const selectedVoice = voice || DEFAULT_VOICE;

  await tts.setMetadata(selectedVoice, MsEdgeTTS.OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);

  const readable = tts.toStream(text);

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    readable.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    readable.on("end", () => {
      resolve(Buffer.concat(chunks));
    });
    readable.on("error", (err: Error) => {
      reject(err);
    });
  });
}

/**
 * Resolve a voice shorthand to a full voice name.
 * Accepts: "fr-male", "fr-female", "en-male", etc. or a full voice name.
 */
export function resolveVoice(input?: string): string {
  if (!input) return DEFAULT_VOICE;
  if (VOICE_MAP[input]) return VOICE_MAP[input];
  // If it looks like a full voice name (contains "Neural"), use as-is
  if (input.includes("Neural") || input.includes("-")) return input;
  return DEFAULT_VOICE;
}

/**
 * List commonly available voices.
 */
export async function listVoices(): Promise<string[]> {
  try {
    const { MsEdgeTTS } = await import("msedge-tts");
    const tts = new MsEdgeTTS();
    const voices = await tts.getVoices();
    return voices
      .filter((v: any) => v.Locale?.startsWith("fr") || v.Locale?.startsWith("en"))
      .map((v: any) => `${v.ShortName} (${v.Locale}, ${v.Gender})`)
      .slice(0, 30);
  } catch (err) {
    log.debug(`[edge-tts] Failed to list voices: ${err}`);
    return Object.entries(VOICE_MAP).map(([k, v]) => `${k} → ${v}`);
  }
}
