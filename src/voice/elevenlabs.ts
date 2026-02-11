/**
 * TTS provider — XTTS v2 (cloned voices) → Edge TTS (fallback, free).
 * Priority: XTTS v2 custom voice → Edge TTS (free, unlimited).
 *
 * - textToSpeechMp3() → MP3 (XTTS if available, else Edge TTS)
 * - textToSpeechUlaw() → mulaw 8kHz for Twilio phone pipeline
 */
import { log } from "../utils/log.js";
import { edgeTtsToMp3 } from "./edgeTts.js";
import { xttsGenerate, wavToMp3, xttsHealthCheck } from "./xttsClient.js";

const DEFAULT_VOICE = "fr-FR-HenriNeural";

/**
 * Linear PCM sample → mu-law encoded byte.
 * Standard ITU-T G.711 mu-law companding.
 */
function linearToMulaw(sample: number): number {
  const BIAS = 0x84;
  const MAX = 32635;
  const sign = sample < 0 ? 0x80 : 0;
  if (sample < 0) sample = -sample;
  if (sample > MAX) sample = MAX;
  sample += BIAS;

  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; exponent--, mask >>= 1);

  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  const mulaw = ~(sign | (exponent << 4) | mantissa) & 0xff;
  return mulaw;
}

/**
 * Downsample PCM from sourceRate to 8000 Hz and encode as mu-law.
 */
function pcmToMulaw(pcm: Float32Array, sourceRate: number): Buffer {
  const ratio = sourceRate / 8000;
  const outLen = Math.floor(pcm.length / ratio);
  const out = Buffer.alloc(outLen);

  for (let i = 0; i < outLen; i++) {
    const srcIdx = Math.floor(i * ratio);
    const sample = Math.max(-1, Math.min(1, pcm[srcIdx]));
    const int16 = Math.round(sample * 32767);
    out[i] = linearToMulaw(int16);
  }

  return out;
}

/** TTS returning mu-law 8kHz — for Twilio phone pipeline. */
export async function textToSpeechUlaw(text: string): Promise<Buffer> {
  log.info(`[tts] Ulaw request via Edge TTS: "${text.slice(0, 80)}..."`);

  const mp3Buffer = await edgeTtsToMp3(text, DEFAULT_VOICE);

  // Decode MP3 to raw PCM using Web Audio-style decoding
  // Use AudioContext-like approach: spawn ffmpeg if available, else basic conversion
  try {
    const { execSync } = await import("node:child_process");
    // ffmpeg: MP3 → raw PCM 16-bit LE 8kHz mono → then encode to mulaw
    const pcmBuffer = execSync(
      `ffmpeg -i pipe:0 -f s16le -acodec pcm_s16le -ar 8000 -ac 1 pipe:1`,
      { input: mp3Buffer, maxBuffer: 10 * 1024 * 1024, stdio: ["pipe", "pipe", "ignore"] },
    );
    // Convert s16le PCM to mulaw
    const out = Buffer.alloc(pcmBuffer.length / 2);
    for (let i = 0; i < out.length; i++) {
      const sample = pcmBuffer.readInt16LE(i * 2);
      out[i] = linearToMulaw(sample);
    }
    log.info(`[tts] Got ${out.length} bytes of ulaw audio via ffmpeg`);
    return out;
  } catch {
    // ffmpeg not available — use raw MP3 and log warning
    log.warn(`[tts] ffmpeg not available — returning MP3 for Twilio (may not work for streaming)`);
    return mp3Buffer;
  }
}

/** TTS returning MP3 — for dashboard, Telegram voice messages, wake word.
 *  Priority: XTTS v2 (cloned voice) → Edge TTS (fallback). */
export async function textToSpeechMp3(text: string): Promise<Buffer> {
  // Try XTTS first (cloned voice)
  try {
    const wav = await xttsGenerate(text);
    if (wav) {
      const mp3 = await wavToMp3(wav);
      log.info(`[tts] MP3 via XTTS v2: ${mp3.length} bytes`);
      return mp3;
    }
  } catch (err) {
    log.warn(`[tts] XTTS failed, falling back to Edge TTS: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Fallback: Edge TTS
  log.info(`[tts] MP3 request via Edge TTS: "${text.slice(0, 80)}..."`);
  const mp3 = await edgeTtsToMp3(text, DEFAULT_VOICE);
  log.info(`[tts] Got ${mp3.length} bytes of MP3 audio`);
  return mp3;
}
