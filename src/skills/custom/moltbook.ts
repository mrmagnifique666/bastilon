/**
 * Custom skills: moltbook.*
 * Moltbook social network integration — post, comment, vote, search, follow.
 * API docs: https://www.moltbook.com/skill.md
 */
import { registerSkill } from "../loader.js";
import { log } from "../../utils/log.js";

const BASE = "https://www.moltbook.com/api/v1";

function getApiKey(): string {
  const key = process.env.MOLTBOOK_API_KEY;
  if (!key) throw new Error("MOLTBOOK_API_KEY not set in .env");
  return key;
}

async function api(
  method: string,
  path: string,
  body?: Record<string, unknown>
): Promise<{ ok: boolean; data?: any; error?: string; hint?: string; raw?: any }> {
  const url = `${BASE}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${getApiKey()}`,
    "Content-Type": "application/json",
  };

  try {
    const resp = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    const json = await resp.json().catch(() => null);

    if (!resp.ok || (json && json.success === false)) {
      const errMsg = json?.error || `HTTP ${resp.status}`;
      const hint = json?.hint ? ` (hint: ${json.hint})` : "";
      log.debug(`[moltbook] ${method} ${path} → ${errMsg}${hint}`);
      return { ok: false, error: errMsg, hint: json?.hint, raw: json };
    }

    // API returns data in various top-level keys: agent, posts, submolts, post, comment, etc.
    const data = json?.data ?? json?.agent ?? json?.post ?? json?.comment ?? json;
    return { ok: true, data, raw: json };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function formatError(r: { error?: string; hint?: string }): string {
  return `Error: ${r.error}${r.hint ? `\nHint: ${r.hint}` : ""}`;
}

// ── moltbook.status ──

registerSkill({
  name: "moltbook.status",
  description: "Check Moltbook agent claim/verification status and profile info",
  adminOnly: true,
  argsSchema: { type: "object", properties: {} },
  async execute() {
    const r = await api("GET", "/agents/me");
    if (!r.ok) return formatError(r);

    const a = r.data;
    const stats = a.stats || {};
    return [
      `Agent: ${a.name}`,
      `Claimed: ${a.is_claimed ? "yes" : "no"}`,
      a.description ? `Bio: ${a.description}` : null,
      a.karma !== undefined ? `Karma: ${a.karma}` : null,
      stats.posts !== undefined ? `Posts: ${stats.posts}` : null,
      stats.comments !== undefined ? `Comments: ${stats.comments}` : null,
      stats.subscriptions !== undefined ? `Subscriptions: ${stats.subscriptions}` : null,
    ]
      .filter(Boolean)
      .join("\n");
  },
});

// ── moltbook.feed ──

registerSkill({
  name: "moltbook.feed",
  description:
    "Get Moltbook feed (personalized from subscriptions + follows). Sort: hot/new/top/rising.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      sort: { type: "string", description: "Sort order: hot, new, top, rising (default: hot)" },
      limit: { type: "number", description: "Number of posts (default 10, max 50)" },
      submolt: { type: "string", description: "Filter by submolt name (optional)" },
    },
  },
  async execute(args) {
    const sort = (args.sort as string) || "hot";
    const limit = Math.min(Number(args.limit) || 10, 50);
    const submolt = args.submolt as string | undefined;

    const path = submolt
      ? `/submolts/${encodeURIComponent(submolt)}/feed?sort=${sort}&limit=${limit}`
      : `/feed?sort=${sort}&limit=${limit}`;

    const r = await api("GET", path);
    if (!r.ok) return formatError(r);

    const posts = Array.isArray(r.data) ? r.data : r.raw?.posts || r.data?.posts || [];
    if (posts.length === 0) return "No posts found.";

    return posts
      .map((p: any, i: number) => {
        const score = p.score !== undefined ? ` [${p.score}↑]` : "";
        const comments = p.comment_count !== undefined ? ` (${p.comment_count} comments)` : "";
        const sub = typeof p.submolt === "object" ? p.submolt?.name : p.submolt;
        const by = typeof p.author === "object" ? p.author?.name : p.author || "?";
        return `${i + 1}. ${p.title}${score}${comments}\n   by ${by} in s/${sub || "?"} — ID: ${p.id}`;
      })
      .join("\n\n");
  },
});

// ── moltbook.post ──

registerSkill({
  name: "moltbook.post",
  description:
    "Create a post on Moltbook. Either text post (content) or link post (url). Rate limit: 1 per 30 min.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      submolt: { type: "string", description: "Submolt (community) to post in" },
      title: { type: "string", description: "Post title" },
      content: { type: "string", description: "Text content (for text posts)" },
      url: { type: "string", description: "URL (for link posts, mutually exclusive with content)" },
    },
    required: ["submolt", "title"],
  },
  async execute(args) {
    const body: Record<string, unknown> = {
      submolt: args.submolt as string,
      title: args.title as string,
    };
    if (args.content) body.content = args.content as string;
    if (args.url) body.url = args.url as string;

    if (!body.content && !body.url) {
      return "Error: provide either 'content' (text post) or 'url' (link post).";
    }

    const r = await api("POST", "/posts", body);
    if (!r.ok) {
      if (r.raw?.retry_after_minutes) {
        return `Rate limited — try again in ${r.raw.retry_after_minutes} minutes.`;
      }
      return formatError(r);
    }

    const post = r.data;
    return `Post created: "${post.title}" (ID: ${post.id}) in s/${post.submolt}`;
  },
});

// ── moltbook.comment ──

registerSkill({
  name: "moltbook.comment",
  description:
    "Comment on a Moltbook post. Rate limit: 1 per 20s, 50/day.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      postId: { type: "string", description: "Post ID to comment on" },
      content: { type: "string", description: "Comment text" },
      parentId: {
        type: "string",
        description: "Parent comment ID for threaded replies (optional)",
      },
    },
    required: ["postId", "content"],
  },
  async execute(args) {
    const postId = args.postId as string;
    const body: Record<string, unknown> = { content: args.content as string };
    if (args.parentId) body.parent_id = args.parentId as string;

    const r = await api("POST", `/posts/${encodeURIComponent(postId)}/comments`, body);
    if (!r.ok) {
      if (r.raw?.retry_after_seconds) {
        return `Rate limited — try again in ${r.raw.retry_after_seconds}s (${r.raw.daily_remaining ?? "?"} remaining today).`;
      }
      return formatError(r);
    }

    return `Comment posted on post ${postId} (comment ID: ${r.data?.id || "ok"}).`;
  },
});

// ── moltbook.upvote ──

registerSkill({
  name: "moltbook.upvote",
  description: "Upvote a Moltbook post",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      postId: { type: "string", description: "Post ID to upvote" },
    },
    required: ["postId"],
  },
  async execute(args) {
    const postId = args.postId as string;
    const r = await api("POST", `/posts/${encodeURIComponent(postId)}/upvote`);
    if (!r.ok) return formatError(r);
    return `Upvoted post ${postId}.`;
  },
});

// ── moltbook.search ──

registerSkill({
  name: "moltbook.search",
  description:
    "Search Moltbook (AI-powered semantic search). Natural language queries work best.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query (max 500 chars)" },
      type: {
        type: "string",
        description: "Filter: posts, comments, or all (default: all)",
      },
      limit: { type: "number", description: "Max results (default 10, max 50)" },
    },
    required: ["query"],
  },
  async execute(args) {
    const q = encodeURIComponent((args.query as string).slice(0, 500));
    const type = (args.type as string) || "all";
    const limit = Math.min(Number(args.limit) || 10, 50);

    const r = await api("GET", `/search?q=${q}&type=${type}&limit=${limit}`);
    if (!r.ok) return formatError(r);

    const results = Array.isArray(r.data) ? r.data : r.raw?.results || r.data?.results || [];
    if (results.length === 0) return `No results for "${args.query}".`;

    return results
      .map((item: any, i: number) => {
        const by = typeof item.author === "object" ? item.author?.name : item.author || "?";
        if (item.title) {
          const score = item.score !== undefined ? ` [${item.score}↑]` : "";
          return `${i + 1}. [post] ${item.title}${score}\n   by ${by} — ID: ${item.id}`;
        }
        const preview =
          item.content?.length > 120 ? item.content.slice(0, 120) + "..." : item.content;
        return `${i + 1}. [comment] ${preview}\n   by ${by} — ID: ${item.id}`;
      })
      .join("\n\n");
  },
});

// ── moltbook.follow ──

registerSkill({
  name: "moltbook.follow",
  description: "Follow a Moltbook agent. Follow sparingly — only after seeing valuable content.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      agentName: { type: "string", description: "Agent name to follow" },
    },
    required: ["agentName"],
  },
  async execute(args) {
    const name = encodeURIComponent(args.agentName as string);
    const r = await api("POST", `/agents/${name}/follow`);
    if (!r.ok) return formatError(r);
    return `Now following ${args.agentName}.`;
  },
});

// ── moltbook.my_posts ──

registerSkill({
  name: "moltbook.my_posts",
  description: "List MY posts (authored by Kingston). Use to verify what actually exists.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      limit: { type: "number", description: "Number of posts (default 10, max 50)" },
    },
  },
  async execute(args) {
    const limit = Math.min(Number(args.limit) || 10, 50);
    const r = await api("GET", `/agents/me/posts?limit=${limit}`);
    if (!r.ok) return formatError(r);

    const posts = Array.isArray(r.data) ? r.data : r.raw?.posts || r.data?.posts || [];
    if (posts.length === 0) return "No posts found.";

    return posts
      .map((p: any, i: number) => {
        const score = p.score !== undefined ? ` [${p.score}↑]` : "";
        const comments = p.comment_count !== undefined ? ` (${p.comment_count} comments)` : "";
        const sub = typeof p.submolt === "object" ? p.submolt?.name : p.submolt;
        const date = p.created_at ? new Date(p.created_at).toLocaleDateString("fr-CA") : "";
        return `${i + 1}. ${p.title}${score}${comments}\n   s/${sub || "?"} — ${date} — ID: ${p.id}`;
      })
      .join("\n\n");
  },
});

// ── moltbook.my_comments ──

registerSkill({
  name: "moltbook.my_comments",
  description: "List MY comments (authored by Kingston). Use to verify engagement history.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      limit: { type: "number", description: "Number of comments (default 10, max 50)" },
    },
  },
  async execute(args) {
    const limit = Math.min(Number(args.limit) || 10, 50);
    const r = await api("GET", `/agents/me/comments?limit=${limit}`);
    if (!r.ok) return formatError(r);

    const comments = Array.isArray(r.data) ? r.data : r.raw?.comments || r.data?.comments || [];
    if (comments.length === 0) return "No comments found.";

    return comments
      .map((c: any, i: number) => {
        const score = c.score !== undefined ? ` [${c.score}↑]` : "";
        const preview = c.content?.length > 100 ? c.content.slice(0, 100) + "..." : c.content;
        const date = c.created_at ? new Date(c.created_at).toLocaleDateString("fr-CA") : "";
        return `${i + 1}. ${preview}${score}\n   post: ${c.post_id || "?"} — ${date} — ID: ${c.id}`;
      })
      .join("\n\n");
  },
});

// ── moltbook.post_details ──

registerSkill({
  name: "moltbook.post_details",
  description: "Get full post details with all comments. Use to see replies received.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      postId: { type: "string", description: "Post ID to get details for" },
    },
    required: ["postId"],
  },
  async execute(args) {
    const postId = encodeURIComponent(args.postId as string);
    const r = await api("GET", `/posts/${postId}`);
    if (!r.ok) return formatError(r);

    const post = r.data;
    const by = typeof post.author === "object" ? post.author?.name : post.author || "?";
    const sub = typeof post.submolt === "object" ? post.submolt?.name : post.submolt;
    const score = post.score !== undefined ? ` [${post.score}↑]` : "";

    const lines = [
      `Title: ${post.title}${score}`,
      `By: ${by} in s/${sub || "?"}`,
      post.content ? `\n${post.content}` : post.url ? `Link: ${post.url}` : "",
    ];

    const comments = post.comments || r.raw?.comments || [];
    if (comments.length > 0) {
      lines.push(`\n--- ${comments.length} comment(s) ---`);
      for (const c of comments) {
        const cBy = typeof c.author === "object" ? c.author?.name : c.author || "?";
        const cScore = c.score !== undefined ? ` [${c.score}↑]` : "";
        const indent = c.parent_id ? "  ↳ " : "";
        lines.push(`${indent}${cBy}${cScore}: ${c.content}`);
      }
    } else {
      lines.push("\nNo comments yet.");
    }

    return lines.filter(Boolean).join("\n");
  },
});

// ── moltbook.submolts ──

registerSkill({
  name: "moltbook.submolts",
  description: "List all Moltbook submolts (communities)",
  adminOnly: true,
  argsSchema: { type: "object", properties: {} },
  async execute() {
    const r = await api("GET", "/submolts");
    if (!r.ok) return formatError(r);

    const subs = Array.isArray(r.data) ? r.data : r.data?.submolts || [];
    if (subs.length === 0) return "No submolts found.";

    return subs
      .map((s: any) => {
        const members = s.subscriber_count !== undefined ? ` (${s.subscriber_count} members)` : "";
        const desc = s.description ? `\n   ${s.description.slice(0, 100)}` : "";
        return `s/${s.name}${members}${desc}`;
      })
      .join("\n\n");
  },
});
