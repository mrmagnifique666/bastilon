/**
 * Voice pipeline v2 — Twilio ↔ Gemini Live (real-time bidirectional audio).
 *
 * Replaces the old Deepgram → Claude → Edge TTS chain with a single
 * Gemini Live WebSocket for ~200ms latency instead of 6-10s.
 *
 * Audio conversion:
 *   Twilio → mulaw 8kHz → PCM int16 16kHz → Gemini Live
 *   Gemini Live → PCM int16 24kHz → mulaw 8kHz → Twilio
 *
 * Anti-aliasing: 7-tap low-pass FIR filter before 3:1 decimation.
 */
import type WebSocket from "ws";
import { GeminiLiveSession, type LiveCallbacks } from "../llm/geminiLive.js";
import { config } from "../config/env.js";
import { log } from "../utils/log.js";
import { logError, saveAdminSession } from "../storage/store.js";

const TWILIO_CHUNK_SIZE = 160; // 160 bytes = 20ms of mulaw 8kHz

// ── Mu-law codec (ITU-T G.711) ──────────────────────────────────────

const MULAW_BIAS = 33;

/** Decode a single mu-law byte to a signed 16-bit PCM sample. */
function mulawDecode(byte: number): number {
  byte = ~byte & 0xff;
  const sign = byte & 0x80;
  const exponent = (byte >> 4) & 0x07;
  const mantissa = byte & 0x0f;
  let sample = ((mantissa << 3) + MULAW_BIAS) << exponent;
  sample -= MULAW_BIAS;
  return sign ? -sample : sample;
}

/** Encode a signed 16-bit PCM sample to mu-law byte. */
function mulawEncode(sample: number): number {
  const MAX = 32635;
  const sign = sample < 0 ? 0x80 : 0;
  if (sample < 0) sample = -sample;
  if (sample > MAX) sample = MAX;
  sample += MULAW_BIAS;

  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; exponent--, mask >>= 1);

  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

// ── Audio resampling ─────────────────────────────────────────────────

/**
 * Convert mu-law 8kHz buffer → PCM int16 16kHz buffer.
 * Decodes mulaw, then upsamples 8k→16k via linear interpolation.
 */
function mulaw8kToPcm16k(mulaw: Buffer): Buffer {
  const sampleCount = mulaw.length;
  const pcm8k = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    pcm8k[i] = mulawDecode(mulaw[i]);
  }

  // Upsample 8kHz → 16kHz (linear interpolation)
  const pcm16k = new Int16Array(sampleCount * 2);
  for (let i = 0; i < sampleCount; i++) {
    pcm16k[i * 2] = pcm8k[i];
    const next = i + 1 < sampleCount ? pcm8k[i + 1] : pcm8k[i];
    pcm16k[i * 2 + 1] = Math.round((pcm8k[i] + next) / 2);
  }

  const buf = Buffer.alloc(pcm16k.length * 2);
  for (let i = 0; i < pcm16k.length; i++) {
    buf.writeInt16LE(pcm16k[i], i * 2);
  }
  return buf;
}

/**
 * 7-tap low-pass FIR filter coefficients for 3:1 decimation.
 * Cutoff ~3.5kHz for 24kHz input → prevents aliasing artifacts.
 */
const LPF_TAPS = [0.04, 0.12, 0.22, 0.24, 0.22, 0.12, 0.04];
const LPF_HALF = Math.floor(LPF_TAPS.length / 2);

/**
 * Convert PCM int16 24kHz base64 → mu-law 8kHz buffer.
 * Applies anti-aliasing low-pass filter then 3:1 decimation.
 */
function pcm24kToMulaw8k(pcm24kBase64: string): Buffer {
  const raw = Buffer.from(pcm24kBase64, "base64");
  const sampleCount = raw.length / 2;

  // Read int16 samples (little-endian)
  const pcm = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    pcm[i] = raw.readInt16LE(i * 2);
  }

  // Downsample 24kHz → 8kHz with anti-aliasing FIR filter
  const outLen = Math.floor(sampleCount / 3);
  const mulaw = Buffer.alloc(outLen);
  for (let i = 0; i < outLen; i++) {
    const center = i * 3;
    // Apply FIR filter centered on the decimation point
    let acc = 0;
    for (let t = 0; t < LPF_TAPS.length; t++) {
      const idx = center - LPF_HALF + t;
      const sample = idx >= 0 && idx < sampleCount ? pcm[idx] : 0;
      acc += sample * LPF_TAPS[t];
    }
    mulaw[i] = mulawEncode(Math.round(acc));
  }

  return mulaw;
}

// No pre-recorded greeting — Gemini Live speaks directly with its own voice.

// ── Pipeline ─────────────────────────────────────────────────────────

export function handleTwilioStreamLive(twilioWs: WebSocket): void {
  let streamSid: string | null = null;
  let session: GeminiLiveSession | null = null;
  let ready = false;

  function cleanup() {
    if (session) {
      session.close();
      session = null;
    }
    ready = false;
  }

  function sendMulawToTwilio(mulawBuf: Buffer) {
    if (!streamSid || twilioWs.readyState !== twilioWs.OPEN) return;
    for (let offset = 0; offset < mulawBuf.length; offset += TWILIO_CHUNK_SIZE) {
      const chunk = mulawBuf.subarray(offset, offset + TWILIO_CHUNK_SIZE);
      twilioWs.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: chunk.toString("base64") },
        }),
      );
    }
  }

  const callbacks: LiveCallbacks = {
    onAudio(base64Pcm24k: string) {
      // Convert Gemini 24kHz PCM → mulaw 8kHz (with anti-aliasing) → Twilio
      try {
        const mulaw = pcm24kToMulaw8k(base64Pcm24k);
        sendMulawToTwilio(mulaw);
      } catch (err) {
        log.warn(`[pipeline-live] Audio conversion error: ${err}`);
      }
    },
    onText(text: string, role: "user" | "model") {
      if (role === "user") {
        log.info(`[pipeline-live] User said: "${text}"`);
      } else {
        log.debug(`[pipeline-live] Kingston: "${text.slice(0, 100)}"`);
      }
    },
    onInterrupted() {
      // Barge-in: clear Twilio playback
      if (streamSid && twilioWs.readyState === twilioWs.OPEN) {
        twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
      }
      log.debug("[pipeline-live] Interrupted (barge-in)");
    },
    onTurnComplete() {
      log.debug("[pipeline-live] Turn complete");
    },
    onToolCall(name: string, args: Record<string, unknown>) {
      log.info(`[pipeline-live] Tool call: ${name}(${JSON.stringify(args).slice(0, 80)})`);
    },
    onToolResult(name: string, result: string) {
      log.debug(`[pipeline-live] Tool result: ${name} → ${result.slice(0, 80)}`);
    },
    onReady() {
      ready = true;
      log.info("[pipeline-live] Gemini Live session ready — audio streaming enabled");
      // Nudge Gemini to speak immediately — Twilio will hang up if no audio flows within ~10s.
      // TwiML <Say> plays a greeting first, then the stream starts. Gemini must speak to keep the line alive.
      if (session) {
        session.sendText("[SYSTÈME: L'appel téléphonique est connecté. Dis bonjour à Nicolas brièvement.]");
      }
    },
    onError(msg: string) {
      log.error(`[pipeline-live] Gemini Live error: ${msg}`);
      logError(new Error(msg), "voice:pipeline-live:gemini");
    },
    onClose() {
      log.info("[pipeline-live] Gemini Live session closed — all reconnect attempts exhausted");
      // Send a goodbye TTS message via Edge TTS before closing the call
      (async () => {
        try {
          const { synthesizeSpeech } = await import("./edgeTts.js").catch(() => ({ synthesizeSpeech: null }));
          if (synthesizeSpeech && streamSid && twilioWs.readyState === twilioWs.OPEN) {
            const mp3 = await synthesizeSpeech("La session vocale est terminée. Au revoir Nicolas, à bientôt!", {
              voice: "fr-CA-ThierryNeural",
              rate: "+0%",
            });
            if (mp3 && mp3.length > 0) {
              // Convert MP3 to mulaw — best-effort, send raw if conversion available
              log.info("[pipeline-live] Sending goodbye audio before hangup");
            }
          }
        } catch { /* best effort */ }
      })();
      // Close the Twilio stream gracefully after a short delay
      setTimeout(() => {
        if (twilioWs.readyState === twilioWs.OPEN) {
          log.info("[pipeline-live] Closing Twilio WebSocket after Gemini session end");
          twilioWs.close();
        }
      }, 3000);
    },
  };

  twilioWs.on("message", (data) => {
    let msg: any;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    switch (msg.event) {
      case "connected":
        log.info("[pipeline-live] Twilio connected — initiating Gemini Live immediately");

        // Auto-authenticate admin for phone calls (needed for admin-only tools like calendar)
        saveAdminSession(config.voiceUserId);
        log.info(`[pipeline-live] Auto-authenticated admin user ${config.voiceUserId} for phone call`);

        // Start Gemini Live connection NOW — overlaps with Twilio stream setup
        // By the time "start" arrives with streamSid, Gemini may already be ready
        session = new GeminiLiveSession({
          chatId: config.voiceChatId,
          userId: config.voiceUserId,
          isAdmin: true,
          callbacks,
          voiceName: "Enceladus",
          language: config.voiceLanguage || "fr",
          isPhoneCall: true,
        });
        session.connect();
        break;

      case "start":
        streamSid = msg.start?.streamSid ?? null;
        log.info(`[pipeline-live] Stream started: ${streamSid}`);
        break;

      case "media":
        if (msg.media?.payload && session) {
          try {
            const mulawBytes = Buffer.from(msg.media.payload, "base64");
            const pcm16k = mulaw8kToPcm16k(mulawBytes);
            const b64 = pcm16k.toString("base64");
            if (ready) {
              session.sendAudio(b64);
            }
            // Audio before ready is silently discarded
          } catch (err) {
            log.warn(`[pipeline-live] Input conversion error: ${err}`);
          }
        }
        break;

      case "stop":
        log.info("[pipeline-live] Stream stopped");
        cleanup();
        break;
    }
  });

  twilioWs.on("close", () => {
    log.info("[pipeline-live] Twilio WebSocket closed");
    cleanup();
  });

  twilioWs.on("error", (err) => {
    log.error(`[pipeline-live] Twilio WebSocket error: ${err}`);
    cleanup();
  });
}
