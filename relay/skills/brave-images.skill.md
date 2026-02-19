# brave.images

Search for images using the Brave Search Images API.

```yaml
name: brave.images
description: Search for images via Brave Search API. Returns image URLs, thumbnails, sources.
admin_only: false
args:
  query: {type: string, description: "Image search query", required: true}
  count: {type: number, description: "Number of results (default 5, max 20)"}
  safesearch: {type: string, description: "Safe search: off, moderate, strict (default: moderate)"}
```

```javascript
const apiKey = secrets.get("BRAVE_SEARCH_API_KEY");
if (!apiKey) return "Error: BRAVE_SEARCH_API_KEY not configured";

const count = Math.min(parseInt(args.count) || 5, 20);
const url = new URL("https://api.search.brave.com/res/v1/images/search");
url.searchParams.set("q", args.query);
url.searchParams.set("count", String(count));
if (args.safesearch) url.searchParams.set("safesearch", args.safesearch);

const resp = await fetch(url.toString(), {
  headers: { "X-Subscription-Token": apiKey, "Accept": "application/json" },
  signal: AbortSignal.timeout(10000),
});

if (!resp.ok) return "Brave Images error: HTTP " + resp.status;

const data = await resp.json();
const results = data.results || [];
if (results.length === 0) return "No images found for: " + args.query;

const lines = results.map((r, i) => {
  const size = r.properties ? r.properties.width + "x" + r.properties.height : "";
  return (i + 1) + ". " + r.title + "\n   " + r.url + (size ? " (" + size + ")" : "") + "\n   Source: " + (r.source || r.page_fetched || "");
});

return "Image results for \"" + args.query + "\":\n\n" + lines.join("\n\n");
```
