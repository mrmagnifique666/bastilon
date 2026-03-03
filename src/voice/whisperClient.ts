/**
 * Node.js client for the Whisper STT microservice.
 * Mirrors xttsClient.ts pattern — HTTP + WebSocket.
 */
import WebSocket from "ws";
import { config } from "../config/env.js";
import { log } from "../utils/log.js";

const BASE_URL = () => `http://localhost:${config.whisperPort}`;
const WS_URL = () => `ws://localhost:${config.whisperPort}/ws/transcribe`;

// ─── HTTP Client ─────────────────────────────────────────────────────────────

/** Health check — returns server status + model info. */
export async function whisperHealth(): Promise<{
  ok: boolean;
  model?: string;
  model_loaded?: boolean;
  device?: string;
  vram_used_gb?: number;
  vram_total_gb?: number;
}> {
  try {
    const res = await fetch(`${BASE_URL()}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { ok: false };
    return await res.json();
  } catch {
    return { ok: false };
  }
}

/** One-shot transcription from PCM or WAV buffer. */
export async function whisperTranscribe(
  buffer: Buffer,
  opts: {
    language?: string;
    rpgMode?: string;
    contentType?: string;
  } = {},
): Promise<{
  text: string;
  segments?: Array<{ start: number; end: number; text: string }>;
  language?: string;
  duration_ms?: number;
} | null> {
  try {
    const health = await whisperHealth();
    if (!health.ok) {
      log.info("[whisper] Server not available");
      return null;
    }

    const headers: Record<string, string> = {
      "Content-Type": opts.contentType || "application/octet-stream",
    };
    if (opts.language) headers["X-Language"] = opts.language;
    if (opts.rpgMode) headers["X-RPG-Mode"] = opts.rpgMode;

    const res = await fetch(`${BASE_URL()}/transcribe`, {
      method: "POST",
      headers,
      body: new Uint8Array(buffer),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      log.warn(`[whisper] Transcribe failed: ${res.status}`);
      return null;
    }

    return await res.json();
  } catch (err) {
    log.warn(`[whisper] Transcribe error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ─── WebSocket Client ────────────────────────────────────────────────────────

export interface WhisperWsOptions {
  token?: string;
  sampleRate?: number;
  language?: string;
  rpgMode?: string;
  onTranscript?: (data: { text: string; is_final: boolean; speech_final: boolean }) => void;
  onUtteranceEnd?: () => void;
  onReady?: () => void;
  onError?: (msg: string) => void;
  onClose?: () => void;
}

export interface WhisperWsConnection {
  send: (pcmData: Buffer) => void;
  finalize: () => void;
  close: () => void;
  isOpen: () => boolean;
}

/** Connect to Whisper WebSocket for streaming STT. */
export function connectWhisperWs(opts: WhisperWsOptions): WhisperWsConnection {
  const ws = new WebSocket(WS_URL());
  let ready = false;

  ws.on("open", () => {
    // Send auth message
    ws.send(JSON.stringify({
      type: "auth",
      token: opts.token || config.dashboardToken,
      sampleRate: opts.sampleRate || 16000,
      language: opts.language || config.whisperLanguage || "fr",
      rpgMode: opts.rpgMode || config.whisperRpgMode || "shadowrun",
    }));
  });

  ws.on("message", (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString());
      switch (msg.type) {
        case "authenticated":
          log.debug("[whisper-ws] Authenticated");
          break;
        case "ready":
          ready = true;
          opts.onReady?.();
          break;
        case "transcript":
          opts.onTranscript?.({
            text: msg.text,
            is_final: !!msg.is_final,
            speech_final: !!msg.speech_final,
          });
          break;
        case "utterance_end":
          opts.onUtteranceEnd?.();
          break;
        case "error":
          opts.onError?.(msg.message || "Unknown error");
          break;
        case "closed":
          opts.onClose?.();
          break;
      }
    } catch {
      // Non-JSON message — ignore
    }
  });

  ws.on("error", (err) => {
    log.warn(`[whisper-ws] Error: ${err.message}`);
    opts.onError?.(err.message);
  });

  ws.on("close", () => {
    ready = false;
    opts.onClose?.();
  });

  return {
    send(pcmData: Buffer) {
      if (ws.readyState === WebSocket.OPEN && ready) {
        ws.send(pcmData);
      }
    },
    finalize() {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "finalize" }));
      }
    },
    close() {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    },
    isOpen() {
      return ws.readyState === WebSocket.OPEN && ready;
    },
  };
}
