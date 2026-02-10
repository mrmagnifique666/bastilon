/**
 * Built-in skills: reddit.post, reddit.comment, reddit.search, reddit.hot,
 * reddit.subreddit, reddit.user, reddit.upvote, reddit.save
 * Uses Reddit OAuth2 API (script app type) via fetch.
 */
import { registerSkill } from "../loader.js";
import { log } from "../../utils/log.js";

const API = "https://oauth.reddit.com";
const AUTH_URL = "https://www.reddit.com/api/v1/access_token";
const UA = "Kingston/1.0 (by Kingston Bot)";

let cachedToken: { token: string; expiresAt: number } | null = null;

function getConfig() {
  const clientId = process.env.REDDIT_CLIENT_ID;
  const clientSecret = process.env.REDDIT_CLIENT_SECRET;
  const username = process.env.REDDIT_USERNAME;
  const password = process.env.REDDIT_PASSWORD;
  if (!clientId || !clientSecret || !username || !password) return null;
  return { clientId, clientSecret, username, password };
}

function checkConfig(): string | null {
  if (!getConfig()) return "Reddit not configured. Set REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_USERNAME, REDDIT_PASSWORD in .env";
  return null;
}

async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.token;

  const config = getConfig()!;
  const auth = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
  const body = new URLSearchParams({
    grant_type: "password",
    username: config.username,
    password: config.password,
  });

  const resp = await fetch(AUTH_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": UA,
    },
    body,
  });

  const data = await resp.json();
  if (!resp.ok || data.error) throw new Error(`Reddit auth failed: ${data.error || resp.status}`);

  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  };
  return cachedToken.token;
}

async function redditFetch(method: string, path: string, body?: Record<string, string>): Promise<any> {
  const token = await getAccessToken();
  const opts: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded",
    },
  };
  if (body) opts.body = new URLSearchParams(body);

  const resp = await fetch(`${API}${path}`, opts);
  const data = await resp.json();
  if (!resp.ok) throw new Error(`Reddit API ${resp.status}: ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}

// ── reddit.post ──
registerSkill({
  name: "reddit.post",
  description: "Submit a post to a subreddit. Supports text (self) or link posts.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      subreddit: { type: "string", description: "Subreddit name (without r/)" },
      title: { type: "string", description: "Post title" },
      text: { type: "string", description: "Post body text (for self posts)" },
      url: { type: "string", description: "URL to share (for link posts, mutually exclusive with text)" },
    },
    required: ["subreddit", "title"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;

    try {
      const body: Record<string, string> = {
        sr: String(args.subreddit),
        title: String(args.title),
        kind: args.url ? "link" : "self",
      };
      if (args.text) body.text = String(args.text);
      if (args.url) body.url = String(args.url);

      const data = await redditFetch("POST", "/api/submit", body);
      if (data.json?.errors?.length) return `Error: ${data.json.errors.map((e: any) => e[1]).join(", ")}`;
      const url = data.json?.data?.url;
      return `Post submitted to r/${args.subreddit}: ${url || "success"}`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

// ── reddit.comment ──
registerSkill({
  name: "reddit.comment",
  description: "Comment on a Reddit post or reply to a comment.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      thingId: { type: "string", description: "Fullname of post (t3_xxx) or comment (t1_xxx) to reply to" },
      text: { type: "string", description: "Comment text (markdown supported)" },
    },
    required: ["thingId", "text"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;

    try {
      const data = await redditFetch("POST", "/api/comment", {
        thing_id: String(args.thingId),
        text: String(args.text),
      });
      if (data.json?.errors?.length) return `Error: ${data.json.errors.map((e: any) => e[1]).join(", ")}`;
      return `Comment posted on ${args.thingId}`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

// ── reddit.search ──
registerSkill({
  name: "reddit.search",
  description: "Search Reddit posts.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      subreddit: { type: "string", description: "Limit to subreddit (optional)" },
      sort: { type: "string", description: "Sort: relevance, hot, top, new, comments (default: relevance)" },
      limit: { type: "number", description: "Number of results (default 10, max 25)" },
    },
    required: ["query"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;
    const limit = Math.min(Number(args.limit) || 10, 25);
    const sort = String(args.sort || "relevance");
    const sub = args.subreddit ? `/r/${args.subreddit}` : "";

    try {
      const data = await redditFetch("GET", `${sub}/search?q=${encodeURIComponent(String(args.query))}&sort=${sort}&limit=${limit}&restrict_sr=${args.subreddit ? "on" : "off"}`);
      const posts = data.data?.children || [];
      if (!posts.length) return `No results for "${args.query}"`;
      const lines = posts.map((p: any) => {
        const d = p.data;
        return `[${d.name}] r/${d.subreddit}: ${d.title}\n  Score:${d.score} Comments:${d.num_comments} | u/${d.author}`;
      });
      return `**Reddit search "${args.query}"** (${posts.length} results):\n\n${lines.join("\n\n")}`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

// ── reddit.hot ──
registerSkill({
  name: "reddit.hot",
  description: "Get hot posts from a subreddit or frontpage.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      subreddit: { type: "string", description: "Subreddit name (without r/). Omit for frontpage." },
      limit: { type: "number", description: "Number of posts (default 10, max 25)" },
    },
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;
    const limit = Math.min(Number(args.limit) || 10, 25);
    const sub = args.subreddit ? `/r/${args.subreddit}` : "";

    try {
      const data = await redditFetch("GET", `${sub}/hot?limit=${limit}`);
      const posts = data.data?.children || [];
      if (!posts.length) return "No posts found.";
      const lines = posts.map((p: any, i: number) => {
        const d = p.data;
        return `${i + 1}. [${d.name}] ${d.title}\n   Score:${d.score} Comments:${d.num_comments} | u/${d.author}`;
      });
      return `**Hot${args.subreddit ? ` r/${args.subreddit}` : " (frontpage)"}:**\n\n${lines.join("\n\n")}`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

// ── reddit.subreddit ──
registerSkill({
  name: "reddit.subreddit",
  description: "Get info about a subreddit.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Subreddit name (without r/)" },
    },
    required: ["name"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;

    try {
      const data = await redditFetch("GET", `/r/${args.name}/about`);
      const d = data.data;
      return [
        `**r/${d.display_name}** — ${d.title || ""}`,
        `Subscribers: ${(d.subscribers || 0).toLocaleString()}`,
        `Active: ${(d.accounts_active || 0).toLocaleString()}`,
        `Created: ${new Date((d.created_utc || 0) * 1000).toISOString().split("T")[0]}`,
        `Type: ${d.subreddit_type || "public"}`,
        `Description: ${(d.public_description || "").slice(0, 300)}`,
      ].join("\n");
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

// ── reddit.user ──
registerSkill({
  name: "reddit.user",
  description: "Get info about a Reddit user.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      username: { type: "string", description: "Reddit username (without u/)" },
    },
    required: ["username"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;

    try {
      const data = await redditFetch("GET", `/user/${args.username}/about`);
      const d = data.data;
      return [
        `**u/${d.name}**`,
        `Karma: ${(d.link_karma || 0).toLocaleString()} link / ${(d.comment_karma || 0).toLocaleString()} comment`,
        `Created: ${new Date((d.created_utc || 0) * 1000).toISOString().split("T")[0]}`,
        `Verified: ${d.has_verified_email ? "yes" : "no"}`,
      ].join("\n");
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

// ── reddit.upvote ──
registerSkill({
  name: "reddit.upvote",
  description: "Upvote a Reddit post or comment.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      thingId: { type: "string", description: "Fullname (t3_xxx for post, t1_xxx for comment)" },
    },
    required: ["thingId"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;

    try {
      await redditFetch("POST", "/api/vote", { id: String(args.thingId), dir: "1" });
      return `Upvoted ${args.thingId}`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

// ── reddit.save ──
registerSkill({
  name: "reddit.save",
  description: "Save a Reddit post or comment.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      thingId: { type: "string", description: "Fullname (t3_xxx or t1_xxx)" },
    },
    required: ["thingId"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;

    try {
      await redditFetch("POST", "/api/save", { id: String(args.thingId) });
      return `Saved ${args.thingId}`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

log.debug("Registered 8 reddit.* skills");
