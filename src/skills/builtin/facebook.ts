/**
 * Built-in skills: facebook.post, facebook.comment, facebook.insights
 * Uses Meta Graph API v19.0 via fetch.
 */
import { registerSkill } from "../loader.js";
import { log } from "../../utils/log.js";

const API = "https://graph.facebook.com/v19.0";

function getToken(): string | null {
  return process.env.FACEBOOK_PAGE_ACCESS_TOKEN || null;
}

function getPageId(): string | null {
  return process.env.FACEBOOK_PAGE_ID || null;
}

function checkConfig(): string | null {
  if (!getToken()) return "Facebook not configured. Set FACEBOOK_PAGE_ACCESS_TOKEN in .env";
  if (!getPageId()) return "Facebook page ID missing. Set FACEBOOK_PAGE_ID in .env";
  return null;
}

async function fbFetch(method: string, path: string, params?: Record<string, string>, body?: Record<string, string>): Promise<any> {
  const token = getToken()!;
  const queryParams = new URLSearchParams({ access_token: token, ...params });
  const url = `${API}${path}?${queryParams}`;

  const opts: RequestInit = { method };
  if (body) {
    opts.headers = { "Content-Type": "application/x-www-form-urlencoded" };
    opts.body = new URLSearchParams({ access_token: token, ...body });
  }

  const resp = await fetch(url, opts);
  const data = await resp.json();
  if (!resp.ok || data.error) {
    throw new Error(`Facebook API ${resp.status}: ${data.error?.message || JSON.stringify(data)}`);
  }
  return data;
}

// ── facebook.post ──
registerSkill({
  name: "facebook.post",
  description: "Post to a Facebook page. Supports text, images, and links.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "Post text/message" },
      imageUrl: { type: "string", description: "Image URL to attach (optional)" },
      link: { type: "string", description: "Link URL to share (optional)" },
    },
    required: ["text"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;
    const pageId = getPageId()!;

    try {
      const body: Record<string, string> = { message: String(args.text) };
      let endpoint = `/${pageId}/feed`;

      if (args.imageUrl) {
        body.url = String(args.imageUrl);
        endpoint = `/${pageId}/photos`;
      } else if (args.link) {
        body.link = String(args.link);
      }

      const data = await fbFetch("POST", endpoint, undefined, body);
      return `Facebook post published: id=${data.id || data.post_id || "success"}`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

// ── facebook.comment ──
registerSkill({
  name: "facebook.comment",
  description: "Comment on a Facebook post.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      postId: { type: "string", description: "Post ID to comment on" },
      text: { type: "string", description: "Comment text" },
    },
    required: ["postId", "text"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;

    try {
      const data = await fbFetch("POST", `/${args.postId}/comments`, undefined, {
        message: String(args.text),
      });
      return `Comment posted on ${args.postId}: id=${data.id || "success"}`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

// ── facebook.insights ──
registerSkill({
  name: "facebook.insights",
  description: "Get Facebook page analytics/insights.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      period: { type: "string", description: "Period: day, week, days_28 (default: week)" },
    },
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;
    const pageId = getPageId()!;
    const period = String(args.period || "week");

    try {
      const metrics = "page_impressions,page_engaged_users,page_fans,page_views_total,page_post_engagements";
      const data = await fbFetch("GET", `/${pageId}/insights`, {
        metric: metrics,
        period,
      });

      if (!data.data?.length) return "No insights data available.";

      const lines = data.data.map((metric: any) => {
        const latest = metric.values?.[metric.values.length - 1];
        return `**${metric.title || metric.name}:** ${latest?.value ?? "N/A"}`;
      });
      return `**Facebook Page Insights (${period}):**\n${lines.join("\n")}`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

log.debug("Registered 3 facebook.* skills");
