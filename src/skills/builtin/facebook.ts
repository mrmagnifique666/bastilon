/**
 * Built-in skills: facebook.auth, facebook.post, facebook.comment, facebook.insights
 * Uses Meta Graph API v21.0 via fetch.
 *
 * Auth flow (facebook.auth):
 *   1. User provides short-lived user token from Graph Explorer
 *   2. We exchange it for a long-lived user token (60 days)
 *   3. We fetch all managed pages and their never-expiring page tokens
 *   4. We save the page token + page ID to .env and hot-reload config
 */
import fs from "node:fs";
import path from "node:path";
import { registerSkill } from "../loader.js";
import { config, reloadEnv } from "../../config/env.js";
import { log } from "../../utils/log.js";

const API = "https://graph.facebook.com/v21.0";

function getToken(): string | null {
  return config.facebookPageAccessToken || null;
}

function getPageId(): string | null {
  return config.facebookPageId || null;
}

function checkConfig(): string | null {
  if (!getToken()) return "Facebook not configured. Run facebook.auth with a short-lived user token from Graph Explorer.";
  if (!getPageId()) return "Facebook page ID missing. Run facebook.auth to set it automatically.";
  return null;
}

async function fbFetch(method: string, apiPath: string, params?: Record<string, string>, body?: Record<string, string>): Promise<any> {
  const token = getToken()!;
  const queryParams = new URLSearchParams({ access_token: token, ...params });
  const url = `${API}${apiPath}?${queryParams}`;

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

/**
 * Write a key=value pair into .env (update existing or append).
 */
function setEnvVar(key: string, value: string): void {
  const envPath = path.resolve(".env");
  if (!fs.existsSync(envPath)) return;

  let content = fs.readFileSync(envPath, "utf-8");
  const regex = new RegExp(`^${key}=.*$`, "m");

  if (regex.test(content)) {
    content = content.replace(regex, `${key}=${value}`);
  } else {
    content = content.trimEnd() + `\n${key}=${value}\n`;
  }

  fs.writeFileSync(envPath, content, "utf-8");
}

// ── facebook.auth ──
registerSkill({
  name: "facebook.auth",
  description:
    "Exchange a short-lived Facebook user token for a long-lived Page Access Token. " +
    "Get the short-lived token from https://developers.facebook.com/tools/explorer/ — " +
    "select your app, request pages_manage_posts + pages_read_engagement permissions, and generate a token.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      userToken: {
        type: "string",
        description: "Short-lived user access token from Graph Explorer",
      },
      pageIndex: {
        type: "number",
        description: "If you manage multiple pages, select by index (0-based, default 0)",
      },
    },
    required: ["userToken"],
  },
  async execute(args): Promise<string> {
    const shortToken = String(args.userToken).trim();
    const pageIndex = Number(args.pageIndex) || 0;
    const appId = config.facebookAppId;
    const appSecret = config.facebookAppSecret;

    if (!appId || !appSecret) {
      return "Error: FACEBOOK_APP_ID and FACEBOOK_APP_SECRET must be set in .env first.";
    }

    try {
      // Step 1: Exchange short-lived token for long-lived user token
      log.info("[facebook.auth] Exchanging short-lived token for long-lived token...");
      const exchangeUrl = `${API}/oauth/access_token?` + new URLSearchParams({
        grant_type: "fb_exchange_token",
        client_id: appId,
        client_secret: appSecret,
        fb_exchange_token: shortToken,
      });

      const exchangeResp = await fetch(exchangeUrl);
      const exchangeData = await exchangeResp.json() as {
        access_token?: string;
        token_type?: string;
        expires_in?: number;
        error?: { message: string };
      };

      if (exchangeData.error || !exchangeData.access_token) {
        return `Error exchanging token: ${exchangeData.error?.message || "No access_token returned"}`;
      }

      const longLivedUserToken = exchangeData.access_token;
      const expiresIn = exchangeData.expires_in;
      log.info(`[facebook.auth] Got long-lived user token (expires in ${expiresIn ? Math.round(expiresIn / 86400) + " days" : "unknown"})`);

      // Step 2: Get list of managed pages with their tokens
      log.info("[facebook.auth] Fetching managed pages...");
      const pagesUrl = `${API}/me/accounts?` + new URLSearchParams({
        access_token: longLivedUserToken,
        fields: "id,name,access_token,category",
      });

      const pagesResp = await fetch(pagesUrl);
      const pagesData = await pagesResp.json() as {
        data?: Array<{ id: string; name: string; access_token: string; category: string }>;
        error?: { message: string };
      };

      if (pagesData.error) {
        return `Error fetching pages: ${pagesData.error.message}`;
      }

      const pages = pagesData.data || [];
      if (pages.length === 0) {
        return "No Facebook pages found. Make sure your app has pages_manage_posts permission and you manage at least one page.";
      }

      // Step 3: Select page
      if (pageIndex >= pages.length) {
        return `Invalid page index ${pageIndex}. You manage ${pages.length} page(s):\n` +
          pages.map((p, i) => `  ${i}: ${p.name} (${p.category}) — id=${p.id}`).join("\n");
      }

      const selected = pages[pageIndex];
      const pageToken = selected.access_token;

      // Page tokens from long-lived user tokens are already long-lived (never expire)
      log.info(`[facebook.auth] Selected page: ${selected.name} (${selected.id})`);

      // Step 4: Verify the token works
      const debugUrl = `${API}/debug_token?` + new URLSearchParams({
        input_token: pageToken,
        access_token: `${appId}|${appSecret}`,
      });
      const debugResp = await fetch(debugUrl);
      const debugData = await debugResp.json() as {
        data?: { is_valid: boolean; expires_at: number; scopes: string[] };
      };
      const tokenInfo = debugData.data;
      const neverExpires = tokenInfo?.expires_at === 0;

      // Step 5: Save to .env and reload
      setEnvVar("FACEBOOK_PAGE_ACCESS_TOKEN", pageToken);
      setEnvVar("FACEBOOK_PAGE_ID", selected.id);
      reloadEnv();

      log.info(`[facebook.auth] Saved page token for "${selected.name}" to .env`);

      const result = [
        `**Facebook auth OK!**`,
        ``,
        `**Page:** ${selected.name}`,
        `**Category:** ${selected.category}`,
        `**Page ID:** ${selected.id}`,
        `**Token expires:** ${neverExpires ? "Never (permanent)" : tokenInfo?.expires_at ? new Date(tokenInfo.expires_at * 1000).toISOString() : "Unknown"}`,
        `**Scopes:** ${tokenInfo?.scopes?.join(", ") || "N/A"}`,
        ``,
        `Token saved to .env and config reloaded. You can now use facebook.post, facebook.comment, and facebook.insights.`,
      ];

      if (pages.length > 1) {
        result.push(``, `**Other pages you manage:**`);
        pages.forEach((p, i) => {
          if (i !== pageIndex) result.push(`  ${i}: ${p.name} (${p.category}) — id=${p.id}`);
        });
        result.push(`Re-run facebook.auth with pageIndex to switch.`);
      }

      return result.join("\n");
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

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

log.debug("Registered 4 facebook.* skills");
