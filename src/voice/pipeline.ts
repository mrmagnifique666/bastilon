/**
 * Voice pipeline — orchestrates Twilio ↔ Deepgram ↔ Claude ↔ ElevenLabs.
 */
import type WebSocket from "ws";
import { connectDeepgram, sendAudio, closeDeepgram } from "./deepgram.js";
import { textToSpeechUlaw } from "./elevenlabs.js";
import { handleMessage } from "../orchestrator/router.js";
import { config } from "../config/env.js";
import { log } from "../utils/log.js";
import { logError } from "../storage/store.js";

const CHUNK_SIZE = 640; // 640 bytes = 80ms of mulaw 8kHz

export function handleTwilioStream(twilioWs: WebSocket): void {
  let streamSid: string | null = null;
  let deepgramWs: ReturnType<typeof connectDeepgram> | null = null;
  let utteranceBuffer = "";
  let isProcessing = false;
  let pendingUtterance: string | null = null;

  function cleanup() {
    if (deepgramWs) {
      closeDeepgram(deepgramWs);
      deepgramWs = null;
    }
  }

  async function processUtterance(text: string) {
    if (isProcessing) {
      pendingUtterance = text;
      return;
    }

    isProcessing = true;
    log.info(`[pipeline] Processing utterance: "${text}"`);

    try {
      // Barge-in: clear any audio currently playing
      if (streamSid && twilioWs.readyState === twilioWs.OPEN) {
        twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
      }

      // Send to Claude via the existing orchestrator
      const chatId = config.voiceChatId;
      const userId = config.voiceUserId;
      const response = await handleMessage(chatId, `[Appel vocal] ${text}`, userId);

      log.info(`[pipeline] Claude response: "${response.slice(0, 100)}..."`);

      // Convert response to speech
      const audioBuffer = await textToSpeechUlaw(response);

      // Send audio to Twilio in chunks
      if (streamSid && twilioWs.readyState === twilioWs.OPEN) {
        for (let offset = 0; offset < audioBuffer.length; offset += CHUNK_SIZE) {
          const chunk = audioBuffer.subarray(offset, offset + CHUNK_SIZE);
          const payload = {
            event: "media",
            streamSid,
            media: { payload: chunk.toString("base64") },
          };
          twilioWs.send(JSON.stringify(payload));
        }
        log.info(`[pipeline] Sent ${audioBuffer.length} bytes of audio to Twilio`);
      }
    } catch (err) {
      log.error(`[pipeline] Error processing utterance: ${err}`);
      logError(err instanceof Error ? err : String(err), "voice:pipeline:utterance");
    } finally {
      isProcessing = false;

      // Process any utterance that came in while we were busy
      if (pendingUtterance) {
        const next = pendingUtterance;
        pendingUtterance = null;
        processUtterance(next);
      }
    }
  }

  twilioWs.on("message", (data) => {
    let msg: any;
    try {
      msg = JSON.parse(data.toString());
    } catch (err) {
      log.warn(`[pipeline] Failed to parse Twilio message: ${err}`);
      return;
    }

    switch (msg.event) {
      case "connected":
        log.info("[pipeline] Twilio connected");
        break;

      case "start":
        streamSid = msg.start?.streamSid ?? null;
        log.info(`[pipeline] Stream started: ${streamSid}`);

        // Connect to Deepgram
        deepgramWs = connectDeepgram({
          onTranscript: (text, isFinal) => {
            log.debug(`[pipeline] Transcript (final=${isFinal}): ${text}`);
            if (isFinal) {
              // speech_final — accumulate and process
              utteranceBuffer += (utteranceBuffer ? " " : "") + text;
              const fullText = utteranceBuffer.trim();
              utteranceBuffer = "";
              if (fullText) {
                processUtterance(fullText);
              }
            } else {
              // Interim — accumulate
              utteranceBuffer += (utteranceBuffer ? " " : "") + text;
            }
          },
          onError: (err) => {
            log.error(`[pipeline] Deepgram error: ${err}`);
            logError(err instanceof Error ? err : String(err), "voice:deepgram");
            isProcessing = false;
            pendingUtterance = null;
          },
          onClose: () => log.info("[pipeline] Deepgram closed"),
        });
        break;

      case "media":
        if (msg.media?.payload && deepgramWs) {
          const audioBytes = Buffer.from(msg.media.payload, "base64");
          sendAudio(deepgramWs, audioBytes);
        }
        break;

      case "stop":
        log.info("[pipeline] Stream stopped");
        cleanup();
        break;
    }
  });

  twilioWs.on("close", () => {
    log.info("[pipeline] Twilio WebSocket closed");
    cleanup();
  });

  twilioWs.on("error", (err) => {
    log.error(`[pipeline] Twilio WebSocket error: ${err}`);
    cleanup();
  });
}
