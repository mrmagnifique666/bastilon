/**
 * Deepgram STT WebSocket client.
 * Streams mulaw 8kHz audio and receives transcription events.
 */
import WebSocket from "ws";
import { config } from "../config/env.js";
import { log } from "../utils/log.js";

export interface DeepgramCallbacks {
  onTranscript: (text: string, isFinal: boolean) => void;
  onError: (err: Error) => void;
  onClose: () => void;
}

export function connectDeepgram(callbacks: DeepgramCallbacks): WebSocket {
  const lang = config.voiceLanguage || "fr";
  const params = new URLSearchParams({
    encoding: "mulaw",
    sample_rate: "8000",
    channels: "1",
    model: "nova-2",
    language: lang,
    punctuate: "true",
    endpointing: "300",
    smart_format: "true",
  });

  // Boost real estate vocabulary
  const keywords = [
    "immobilier", "hypothèque", "MLS", "courtier", "notaire",
    "mise de fonds", "copropriété", "promesse d'achat", "acte de vente",
  ];
  for (const kw of keywords) {
    params.append("keywords", kw);
  }

  const url = `wss://api.deepgram.com/v1/listen?${params}`;
  const ws = new WebSocket(url, {
    headers: { Authorization: `Token ${config.deepgramApiKey}` },
  });

  ws.on("open", () => log.info("[deepgram] Connected"));

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "Results" && msg.channel?.alternatives?.[0]) {
        const alt = msg.channel.alternatives[0];
        const text = alt.transcript as string;
        if (text) {
          const isFinal = !!msg.speech_final;
          callbacks.onTranscript(text, isFinal);
        }
      }
    } catch (err) {
      log.warn("[deepgram] Failed to parse message:", String(err));
    }
  });

  ws.on("error", (err) => {
    log.error("[deepgram] WebSocket error:", String(err));
    callbacks.onError(err);
  });

  ws.on("close", () => {
    log.info("[deepgram] Connection closed");
    callbacks.onClose();
  });

  return ws;
}

export function sendAudio(ws: WebSocket, buffer: Buffer): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(buffer);
  }
}

export function closeDeepgram(ws: WebSocket): void {
  if (ws.readyState === WebSocket.OPEN) {
    // Send close message per Deepgram protocol
    ws.send(JSON.stringify({ type: "CloseStream" }));
    ws.close();
  }
}
