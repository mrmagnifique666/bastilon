/**
 * Edge TTS — Free unlimited text-to-speech via Microsoft Edge's TTS engine.
 * No API key required. Supports French, English, and 300+ voices.
 *
 * Uses msedge-tts npm package (WebSocket to Microsoft's public TTS service).
 */
import { log } from "../utils/log.js";

// Voice presets for common languages
const VOICE_MAP: Record<string, string> = {
  "fr-male": "fr-FR-RemyMultilingualNeural",
  "fr-male-classic": "fr-FR-HenriNeural",
  "fr-female": "fr-FR-VivienneMultilingualNeural",
  "fr-female-classic": "fr-FR-DeniseNeural",
  "en-male": "en-US-AndrewMultilingualNeural",
  "en-male-classic": "en-US-GuyNeural",
  "en-female": "en-US-JennyNeural",
  "fr-vivienne": "fr-FR-VivienneMultilingualNeural",
  "fr-claude": "fr-FR-HenriNeural",
  "es-male": "es-ES-AlvaroNeural",
  "es-female": "es-ES-ElviraNeural",
};

const DEFAULT_VOICE = "fr-FR-RemyMultilingualNeural";

// Cache TTS instances per voice to avoid WebSocket reconnection latency (~1-2s per call)
const ttsCache = new Map<string, { tts: any; lastUsed: number }>();
const TTS_CACHE_TTL_MS = 5 * 60 * 1000; // Evict after 5min idle

async function getOrCreateTTS(voice: string): Promise<any> {
  const cached = ttsCache.get(voice);
  if (cached) {
    cached.lastUsed = Date.now();
    return cached.tts;
  }

  const { MsEdgeTTS } = await import("msedge-tts");
  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice, "audio-24khz-96kbitrate-mono-mp3");
  ttsCache.set(voice, { tts, lastUsed: Date.now() });

  // Evict stale entries
  for (const [k, v] of ttsCache) {
    if (Date.now() - v.lastUsed > TTS_CACHE_TTL_MS) ttsCache.delete(k);
  }

  return tts;
}

/**
 * Convert text to speech using Microsoft Edge TTS (free, unlimited).
 * Returns an MP3 buffer. Reuses WebSocket connections for speed.
 */
export async function edgeTtsToMp3(
  text: string,
  voice?: string,
): Promise<Buffer> {
  const selectedVoice = voice || DEFAULT_VOICE;

  let tts: any;
  try {
    tts = await getOrCreateTTS(selectedVoice);
  } catch (err) {
    // Connection stale — evict and retry once
    ttsCache.delete(selectedVoice);
    tts = await getOrCreateTTS(selectedVoice);
  }

  try {
    const { audioStream } = tts.toStream(text);

    return await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      audioStream.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      audioStream.on("end", () => {
        const result = Buffer.concat(chunks);
        if (result.length === 0) {
          reject(new Error("Edge TTS returned empty audio buffer"));
        } else {
          resolve(result);
        }
      });
      audioStream.on("error", (err: Error) => {
        reject(err);
      });
    });
  } catch (err) {
    // WebSocket died mid-stream — evict cache and retry once
    log.debug(`[edge-tts] Stream error, retrying with fresh connection: ${err}`);
    ttsCache.delete(selectedVoice);
    tts = await getOrCreateTTS(selectedVoice);
    const { audioStream } = tts.toStream(text);
    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      audioStream.on("data", (chunk: Buffer) => chunks.push(chunk));
      audioStream.on("end", () => {
        const result = Buffer.concat(chunks);
        if (result.length === 0) reject(new Error("Edge TTS returned empty audio buffer"));
        else resolve(result);
      });
      audioStream.on("error", reject);
    });
  }
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
