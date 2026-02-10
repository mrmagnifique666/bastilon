/**
 * ElevenLabs TTS — returns raw mulaw 8kHz audio bytes.
 */
import { config } from "../config/env.js";
import { log } from "../utils/log.js";

export async function textToSpeechUlaw(text: string): Promise<Buffer> {
  const voiceId = config.elevenlabsVoiceId;
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=ulaw_8000`;

  log.info(`[elevenlabs] TTS request: "${text.slice(0, 80)}..."`);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": config.elevenlabsApiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text,
      model_id: "eleven_multilingual_v2",
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ElevenLabs TTS failed (${res.status}): ${body}`);
  }

  const arrayBuf = await res.arrayBuffer();
  log.info(`[elevenlabs] Got ${arrayBuf.byteLength} bytes of ulaw audio`);
  return Buffer.from(arrayBuf);
}
