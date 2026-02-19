# removebg.remove

Remove the background from an image using the Remove.bg API. Accepts an image URL and returns the processed image URL or binary data info.

```yaml
name: removebg.remove
description: Remove background from an image URL using Remove.bg API. Returns base64 PNG data info.
admin_only: false
args:
  image_url: {type: string, description: "URL of the image to process", required: true}
  size: {type: string, description: "Output size: auto, preview, small, medium, hd, full (default: auto)"}
  bg_color: {type: string, description: "Background color hex (e.g. 'ffffff' for white). Omit for transparent."}
```

```javascript
const apiKey = secrets.get("REMOVEBG_API_KEY");
if (!apiKey) return "Error: REMOVEBG_API_KEY not configured";

const body = {
  image_url: args.image_url,
  size: args.size || "auto",
  format: "png",
};
if (args.bg_color) body.bg_color = args.bg_color;

const resp = await fetch("https://api.remove.bg/v1.0/removebg", {
  method: "POST",
  headers: {
    "X-Api-Key": apiKey,
    "Content-Type": "application/json",
    "Accept": "application/json",
  },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(30000),
});

if (!resp.ok) {
  const err = await resp.text();
  return "Remove.bg error: " + resp.status + " — " + err.slice(0, 500);
}

const data = await resp.json();
if (data.data && data.data.result_b64) {
  const sizeKB = Math.round(data.data.result_b64.length * 0.75 / 1024);
  return "Background removed successfully!\nSize: " + sizeKB + " KB (base64 PNG)\nForeground: " + (data.data.foreground_top || "auto") + "," + (data.data.foreground_left || "auto") + " " + (data.data.foreground_width || "auto") + "x" + (data.data.foreground_height || "auto");
}

return JSON.stringify(data, null, 2).slice(0, 2000);
```
