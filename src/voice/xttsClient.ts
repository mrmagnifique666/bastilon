/**
 * XTTS v2 Voice Cloning Client.
 * Talks to the Python XTTS microservice (default port 3300).
 * Falls back to Edge TTS if XTTS server is down.
 */
import { config } from "../config/env.js";
import { log } from "../utils/log.js";
import fs from "node:fs";
import path from "node:path";

const XTTS_BASE = `http://localhost:${config.xttsPort || 3300}`;
const TIMEOUT = 60_000; // 60s for TTS generation

/** Check if XTTS server is running. */
export async function xttsHealthCheck(): Promise<{
  ok: boolean;
  model_loaded?: boolean;
  device?: string;
  active_voice?: string | null;
  voices?: number;
  vram_used_gb?: number;
}> {
  try {
    const res = await fetch(`${XTTS_BASE}/health`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { ok: false };
    const data = await res.json();
    return { ok: true, ...data };
  } catch {
    return { ok: false };
  }
}

/** List available voice profiles. */
export async function xttsList(): Promise<{
  voices: Array<{
    name: string;
    description: string;
    language: string;
    audio_files: number;
    created: string;
  }>;
  active: string | null;
}> {
  const res = await fetch(`${XTTS_BASE}/voices`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`XTTS /voices failed: ${res.status}`);
  return res.json();
}

/** Set the active voice. */
export async function xttsUse(voice: string): Promise<string> {
  const form = new URLSearchParams({ voice });
  const res = await fetch(`${XTTS_BASE}/use`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`XTTS /use failed: ${err}`);
  }
  const data = await res.json();
  return data.active;
}

/**
 * Generate TTS audio using XTTS v2.
 * Returns a WAV buffer, or null if XTTS is unavailable.
 */
export async function xttsGenerate(
  text: string,
  voice?: string,
  language: string = "fr",
): Promise<Buffer | null> {
  try {
    const health = await xttsHealthCheck();
    if (!health.ok) {
      log.info("[xtts] Server not available, falling back to Edge TTS");
      return null;
    }

    const form = new URLSearchParams({ text, language });
    if (voice) form.set("voice", voice);

    log.info(`[xtts] Generating TTS: voice=${voice || "active"}, text="${text.slice(0, 60)}..."`);
    const res = await fetch(`${XTTS_BASE}/tts`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(TIMEOUT),
    });

    if (!res.ok) {
      const err = await res.text();
      log.warn(`[xtts] TTS failed: ${err}`);
      return null;
    }

    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const genTime = res.headers.get("X-Generation-Time") || "?";
    log.info(`[xtts] Generated ${buffer.length} bytes in ${genTime}s`);
    return buffer;
  } catch (err) {
    log.warn(`[xtts] Error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Clone a voice from an audio file.
 * @param name Voice profile name
 * @param audioPath Path to the audio file
 * @param description Optional description
 * @param language Language code (default: fr)
 */
export async function xttsClone(
  name: string,
  audioPath: string,
  description: string = "",
  language: string = "fr",
): Promise<{ name: string; active: boolean }> {
  const audioBuffer = fs.readFileSync(audioPath);
  const filename = path.basename(audioPath);

  const form = new FormData();
  form.set("name", name);
  form.set("description", description);
  form.set("language", language);
  form.set("audio", new Blob([audioBuffer]), filename);

  const res = await fetch(`${XTTS_BASE}/clone`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`XTTS /clone failed: ${err}`);
  }

  return res.json();
}

/**
 * Extract audio from a video file and create a voice profile.
 * @param videoPath Path to the video file
 * @param voiceName Name for the voice profile
 * @param startTime Start time in seconds
 * @param duration Duration in seconds
 */
export async function xttsExtractAudio(
  videoPath: string,
  voiceName: string,
  startTime: string = "0",
  duration: string = "30",
): Promise<{ name: string; size_kb: number; active: boolean }> {
  const videoBuffer = fs.readFileSync(videoPath);
  const filename = path.basename(videoPath);

  const form = new FormData();
  form.set("video", new Blob([videoBuffer]), filename);
  form.set("voice_name", voiceName);
  form.set("start_time", startTime);
  form.set("duration", duration);

  const res = await fetch(`${XTTS_BASE}/extract-audio`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`XTTS /extract-audio failed: ${err}`);
  }

  return res.json();
}

/**
 * Convert WAV buffer to MP3 using ffmpeg.
 * Needed because Telegram and most clients prefer MP3.
 */
export async function wavToMp3(wavBuffer: Buffer): Promise<Buffer> {
  try {
    const { execSync } = await import("node:child_process");
    return execSync(
      "ffmpeg -i pipe:0 -f mp3 -ab 128k -ar 24000 -ac 1 pipe:1",
      { input: wavBuffer, maxBuffer: 20 * 1024 * 1024, stdio: ["pipe", "pipe", "ignore"] },
    );
  } catch {
    log.warn("[xtts] ffmpeg WAV→MP3 conversion failed, returning WAV");
    return wavBuffer;
  }
}
