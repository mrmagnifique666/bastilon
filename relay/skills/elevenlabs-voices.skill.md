# elevenlabs.voices

List available ElevenLabs voices.

```yaml
name: elevenlabs.voices
description: List all available ElevenLabs voices with IDs, names, and languages.
admin_only: false
args:
```

```javascript
const apiKey = secrets.get("ELEVENLABS_API_KEY");
if (!apiKey) return "Error: ELEVENLABS_API_KEY not configured";

const resp = await fetch("https://api.elevenlabs.io/v1/voices", {
  headers: { "xi-api-key": apiKey },
  signal: AbortSignal.timeout(10000),
});

if (!resp.ok) return "ElevenLabs error: " + resp.status;

const data = await resp.json();
const voices = data.voices || [];

const lines = voices.slice(0, 30).map(v => {
  const labels = v.labels || {};
  const accent = labels.accent || "";
  const gender = labels.gender || "";
  const desc = labels.description || "";
  return "- **" + v.name + "** (`" + v.voice_id + "`)\n  " + [gender, accent, desc].filter(Boolean).join(", ");
});

return "ElevenLabs Voices (" + voices.length + " total):\n\n" + lines.join("\n");
```
