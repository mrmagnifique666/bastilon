/**
 * Built-in skills: twitter.post, twitter.search, twitter.timeline, twitter.follow,
 * twitter.like, twitter.retweet, twitter.dm, twitter.mentions, twitter.trends
 * Uses Twitter API v2 with OAuth 1.0a (user context).
 */
import { registerSkill } from "../loader.js";
import { log } from "../../utils/log.js";
import crypto from "node:crypto";

const API = "https://api.twitter.com/2";
const API_V1 = "https://api.twitter.com/1.1";

function getConfig() {
  const apiKey = process.env.TWITTER_API_KEY;
  const apiSecret = process.env.TWITTER_API_SECRET;
  const accessToken = process.env.TWITTER_ACCESS_TOKEN;
  const accessSecret = process.env.TWITTER_ACCESS_SECRET;
  if (!apiKey || !apiSecret || !accessToken || !accessSecret) return null;
  return { apiKey, apiSecret, accessToken, accessSecret };
}

function checkConfig(): string | null {
  if (!getConfig()) return "Twitter not configured. Set TWITTER_API_KEY, TWITTER_API_SECRET, TWITTER_ACCESS_TOKEN, TWITTER_ACCESS_SECRET in .env";
  return null;
}

/** Generate OAuth 1.0a signature for Twitter API */
function oauthSign(method: string, url: string, params: Record<string, string>, config: NonNullable<ReturnType<typeof getConfig>>): string {
  const nonce = crypto.randomBytes(16).toString("hex");
  const timestamp = Math.floor(Date.now() / 1000).toString();

  const oauthParams: Record<string, string> = {
    oauth_consumer_key: config.apiKey,
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: timestamp,
    oauth_token: config.accessToken,
    oauth_version: "1.0",
    ...params,
  };

  const sortedKeys = Object.keys(oauthParams).sort();
  const paramString = sortedKeys.map(k => `${encodeURIComponent(k)}=${encodeURIComponent(oauthParams[k])}`).join("&");
  const baseString = `${method}&${encodeURIComponent(url)}&${encodeURIComponent(paramString)}`;
  const signingKey = `${encodeURIComponent(config.apiSecret)}&${encodeURIComponent(config.accessSecret)}`;
  const signature = crypto.createHmac("sha1", signingKey).update(baseString).digest("base64");

  return `OAuth oauth_consumer_key="${encodeURIComponent(config.apiKey)}", oauth_nonce="${nonce}", oauth_signature="${encodeURIComponent(signature)}", oauth_signature_method="HMAC-SHA1", oauth_timestamp="${timestamp}", oauth_token="${encodeURIComponent(config.accessToken)}", oauth_version="1.0"`;
}

async function twitterFetch(method: string, url: string, body?: unknown, queryParams?: Record<string, string>): Promise<any> {
  const config = getConfig()!;
  const fullUrl = queryParams ? `${url}?${new URLSearchParams(queryParams)}` : url;
  const authHeader = oauthSign(method, url, queryParams || {}, config);

  const opts: RequestInit = {
    method,
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const resp = await fetch(fullUrl, opts);
  const data = await resp.json();
  if (!resp.ok) {
    const errMsg = data?.detail || data?.errors?.[0]?.message || JSON.stringify(data);
    throw new Error(`Twitter API ${resp.status}: ${errMsg}`);
  }
  return data;
}

// ── twitter.post ──
registerSkill({
  name: "twitter.post",
  description: "Post a tweet (max 280 chars). Supports replies via replyToId.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "Tweet text (max 280 chars)" },
      replyToId: { type: "string", description: "Tweet ID to reply to (optional)" },
    },
    required: ["text"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;
    const text = String(args.text);
    if (text.length > 280) return `Error: Tweet too long (${text.length}/280 chars)`;

    try {
      const body: any = { text };
      if (args.replyToId) body.reply = { in_reply_to_tweet_id: String(args.replyToId) };
      const data = await twitterFetch("POST", `${API}/tweets`, body);
      return `Tweet posted: id=${data.data?.id}\n"${text}"`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

// ── twitter.search ──
registerSkill({
  name: "twitter.search",
  description: "Search recent tweets by keyword.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      count: { type: "number", description: "Number of results (default 10, max 100)" },
    },
    required: ["query"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;
    const count = Math.min(Number(args.count) || 10, 100);

    try {
      const data = await twitterFetch("GET", `${API}/tweets/search/recent`, undefined, {
        query: String(args.query),
        max_results: String(count),
        "tweet.fields": "author_id,created_at,public_metrics",
      });
      if (!data.data?.length) return `No tweets found for "${args.query}"`;
      const lines = data.data.map((t: any) => {
        const metrics = t.public_metrics;
        return `[${t.id}] ${t.text.slice(0, 200)}${t.text.length > 200 ? "..." : ""}\n  Likes:${metrics?.like_count || 0} RT:${metrics?.retweet_count || 0} | ${t.created_at}`;
      });
      return `**Search: "${args.query}"** (${data.data.length} results)\n\n${lines.join("\n\n")}`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

// ── twitter.timeline ──
registerSkill({
  name: "twitter.timeline",
  description: "Get a user's recent tweets.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      username: { type: "string", description: "Twitter username (without @). If omitted, shows your timeline." },
      count: { type: "number", description: "Number of tweets (default 10, max 100)" },
    },
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;
    const count = Math.min(Number(args.count) || 10, 100);

    try {
      let userId: string;
      if (args.username) {
        const user = await twitterFetch("GET", `${API}/users/by/username/${String(args.username)}`);
        userId = user.data?.id;
        if (!userId) return `User @${args.username} not found`;
      } else {
        const me = await twitterFetch("GET", `${API}/users/me`);
        userId = me.data?.id;
      }
      const data = await twitterFetch("GET", `${API}/users/${userId}/tweets`, undefined, {
        max_results: String(count),
        "tweet.fields": "created_at,public_metrics",
      });
      if (!data.data?.length) return "No tweets found.";
      const lines = data.data.map((t: any) =>
        `[${t.id}] ${t.text.slice(0, 200)} | ${t.created_at}`
      );
      return `**Timeline${args.username ? ` @${args.username}` : ""}:**\n${lines.join("\n")}`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

// ── twitter.follow ──
registerSkill({
  name: "twitter.follow",
  description: "Follow a Twitter user.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      username: { type: "string", description: "Username to follow (without @)" },
    },
    required: ["username"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;

    try {
      const me = await twitterFetch("GET", `${API}/users/me`);
      const target = await twitterFetch("GET", `${API}/users/by/username/${String(args.username)}`);
      if (!target.data?.id) return `User @${args.username} not found`;
      await twitterFetch("POST", `${API}/users/${me.data.id}/following`, { target_user_id: target.data.id });
      return `Now following @${args.username}`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

// ── twitter.like ──
registerSkill({
  name: "twitter.like",
  description: "Like a tweet.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      tweetId: { type: "string", description: "ID of the tweet to like" },
    },
    required: ["tweetId"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;

    try {
      const me = await twitterFetch("GET", `${API}/users/me`);
      await twitterFetch("POST", `${API}/users/${me.data.id}/likes`, { tweet_id: String(args.tweetId) });
      return `Liked tweet ${args.tweetId}`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

// ── twitter.retweet ──
registerSkill({
  name: "twitter.retweet",
  description: "Retweet a tweet.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      tweetId: { type: "string", description: "ID of the tweet to retweet" },
    },
    required: ["tweetId"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;

    try {
      const me = await twitterFetch("GET", `${API}/users/me`);
      await twitterFetch("POST", `${API}/users/${me.data.id}/retweets`, { tweet_id: String(args.tweetId) });
      return `Retweeted tweet ${args.tweetId}`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

// ── twitter.dm ──
registerSkill({
  name: "twitter.dm",
  description: "Send a direct message to a user.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      username: { type: "string", description: "Username to DM (without @)" },
      message: { type: "string", description: "Message text" },
    },
    required: ["username", "message"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;

    try {
      const target = await twitterFetch("GET", `${API}/users/by/username/${String(args.username)}`);
      if (!target.data?.id) return `User @${args.username} not found`;
      await twitterFetch("POST", `${API}/dm_conversations/with/${target.data.id}/messages`, {
        text: String(args.message),
      });
      return `DM sent to @${args.username}`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

// ── twitter.mentions ──
registerSkill({
  name: "twitter.mentions",
  description: "Get recent mentions of your account.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      count: { type: "number", description: "Number of mentions (default 10)" },
    },
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;
    const count = Math.min(Number(args.count) || 10, 100);

    try {
      const me = await twitterFetch("GET", `${API}/users/me`);
      const data = await twitterFetch("GET", `${API}/users/${me.data.id}/mentions`, undefined, {
        max_results: String(count),
        "tweet.fields": "author_id,created_at,public_metrics",
      });
      if (!data.data?.length) return "No recent mentions.";
      const lines = data.data.map((t: any) =>
        `[${t.id}] ${t.text.slice(0, 200)} | ${t.created_at}`
      );
      return `**Recent mentions (${data.data.length}):**\n${lines.join("\n")}`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

// ── twitter.trends ──
registerSkill({
  name: "twitter.trends",
  description: "Get trending topics (uses v1.1 API).",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      woeid: { type: "string", description: "WOEID location (default: 1 = worldwide, 23424775 = Canada)" },
    },
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;
    const woeid = String(args.woeid || "1");

    try {
      const config = getConfig()!;
      const url = `${API_V1}/trends/place.json`;
      const authHeader = oauthSign("GET", url, { id: woeid }, config);
      const resp = await fetch(`${url}?id=${woeid}`, {
        headers: { Authorization: authHeader },
      });
      if (!resp.ok) return `Error: HTTP ${resp.status}`;
      const data = await resp.json();
      const trends = data[0]?.trends?.slice(0, 20) || [];
      if (!trends.length) return "No trends found.";
      const lines = trends.map((t: any, i: number) => {
        const vol = t.tweet_volume ? ` (${(t.tweet_volume / 1000).toFixed(0)}K tweets)` : "";
        return `${i + 1}. ${t.name}${vol}`;
      });
      return `**Trending${woeid === "1" ? " (Worldwide)" : ""}:**\n${lines.join("\n")}`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

log.debug("Registered 9 twitter.* skills");
