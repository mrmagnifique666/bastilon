# elevenlabs.speak

Convert text to speech using ElevenLabs API and send audio to Telegram.

```yaml
name: elevenlabs.speak
description: Text-to-speech via ElevenLabs. Generates MP3 audio and sends it as a Telegram voice message.
admin_only: false
args:
  text: {type: string, description: "Text to convert to speech (max 5000 chars)", required: true}
  voice_id: {type: string, description: "ElevenLabs voice ID (default: onwK4e9ZLuTAKqWW03F9 = Daniel)"}
  model: {type: string, description: "Model: eleven_turbo_v2_5 (fast) or eleven_multilingual_v2 (quality). Default: turbo."}
```

```javascript
const apiKey = secrets.get("ELEVENLABS_API_KEY");
if (!apiKey) return "Error: ELEVENLABS_API_KEY not configured";

const text = String(args.text).slice(0, 5000);
if (!text) return "Error: text is required";

const voiceId = args.voice_id || "onwK4e9ZLuTAKqWW03F9";
const model = args.model || "eleven_turbo_v2_5";

const resp = await fetch(
  "https://api.elevenlabs.io/v1/text-to-speech/" + voiceId,
  {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
      "Accept": "audio/mpeg",
    },
    body: JSON.stringify({
      text: text,
      model_id: model,
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
    signal: AbortSignal.timeout(30000),
  }
);

if (!resp.ok) {
  const err = await resp.text();
  return "ElevenLabs error: " + resp.status + " — " + err.slice(0, 300);
}

const audioBuffer = await resp.arrayBuffer();
const audioBlob = new Blob([audioBuffer], { type: "audio/ogg" });
const sizeKB = Math.round(audioBuffer.byteLength / 1024);

const sent = await telegram.sendVoice(audioBlob, text.slice(0, 100));
if (sent) {
  return "Audio sent (" + sizeKB + " KB, " + text.length + " chars, voice: " + voiceId + ")";
} else {
  return "Audio generated (" + sizeKB + " KB) but Telegram send failed.";
}
```
