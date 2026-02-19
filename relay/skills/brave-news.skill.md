# brave.news

Search for recent news using the Brave Search News API.

```yaml
name: brave.news
description: Search for recent news articles via Brave Search News API. Returns headlines, sources, and URLs.
admin_only: false
args:
  query: {type: string, description: "News search query", required: true}
  count: {type: number, description: "Number of results (default 5, max 20)"}
  freshness: {type: string, description: "Time filter: pd (past day), pw (past week), pm (past month)"}
```

```javascript
const apiKey = secrets.get("BRAVE_SEARCH_API_KEY");
if (!apiKey) return "Error: BRAVE_SEARCH_API_KEY not configured";

const count = Math.min(parseInt(args.count) || 5, 20);
const url = new URL("https://api.search.brave.com/res/v1/news/search");
url.searchParams.set("q", args.query);
url.searchParams.set("count", String(count));
if (args.freshness) url.searchParams.set("freshness", args.freshness);

const resp = await fetch(url.toString(), {
  headers: { "X-Subscription-Token": apiKey, "Accept": "application/json" },
  signal: AbortSignal.timeout(10000),
});

if (!resp.ok) return "Brave News error: HTTP " + resp.status;

const data = await resp.json();
const results = data.results || [];
if (results.length === 0) return "No news found for: " + args.query;

const lines = results.map((r, i) => {
  const age = r.age || "";
  return (i + 1) + ". **" + r.title + "**\n   " + (r.description || "").slice(0, 150) + "\n   " + r.url + (age ? " (" + age + ")" : "");
});

return "News results for \"" + args.query + "\":\n\n" + lines.join("\n\n");
```
