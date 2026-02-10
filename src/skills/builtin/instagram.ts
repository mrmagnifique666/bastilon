/**
 * Built-in skills: instagram.post, instagram.story, instagram.comment
 * Uses Instagram Graph API (via Meta Graph API v19.0).
 * Requires a Facebook Page connected to an Instagram Business/Creator account.
 */
import { registerSkill } from "../loader.js";
import { log } from "../../utils/log.js";

const API = "https://graph.facebook.com/v19.0";

function getToken(): string | null {
  return process.env.FACEBOOK_PAGE_ACCESS_TOKEN || null;
}

function getIgAccountId(): string | null {
  return process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID || null;
}

function checkConfig(): string | null {
  if (!getToken()) return "Instagram not configured. Set FACEBOOK_PAGE_ACCESS_TOKEN in .env (same token as Facebook, needs instagram_basic + instagram_content_publish permissions)";
  if (!getIgAccountId()) return "Instagram account ID missing. Set INSTAGRAM_BUSINESS_ACCOUNT_ID in .env";
  return null;
}

async function igFetch(method: string, path: string, params?: Record<string, string>, body?: Record<string, string>): Promise<any> {
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
    throw new Error(`Instagram API ${resp.status}: ${data.error?.message || JSON.stringify(data)}`);
  }
  return data;
}

// ── instagram.post ──
registerSkill({
  name: "instagram.post",
  description: "Post a photo to Instagram. Requires a publicly accessible image URL.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      imageUrl: { type: "string", description: "Public URL of the image to post" },
      caption: { type: "string", description: "Post caption" },
      hashtags: { type: "string", description: "Space-separated hashtags to append (optional)" },
    },
    required: ["imageUrl", "caption"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;
    const igId = getIgAccountId()!;

    try {
      let caption = String(args.caption);
      if (args.hashtags) caption += "\n\n" + String(args.hashtags).split(/\s+/).map(h => h.startsWith("#") ? h : `#${h}`).join(" ");

      // Step 1: Create media container
      const container = await igFetch("POST", `/${igId}/media`, undefined, {
        image_url: String(args.imageUrl),
        caption,
      });

      if (!container.id) return "Error: Failed to create media container";

      // Step 2: Publish — may need to wait for processing
      let published = false;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const result = await igFetch("POST", `/${igId}/media_publish`, undefined, {
            creation_id: container.id,
          });
          if (result.id) {
            return `Instagram post published: id=${result.id}`;
          }
        } catch (e: any) {
          if (e.message?.includes("not ready") && attempt < 4) {
            await new Promise(r => setTimeout(r, 3000));
            continue;
          }
          throw e;
        }
      }
      return "Error: Media processing timed out. Try again in a few seconds.";
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

// ── instagram.story ──
registerSkill({
  name: "instagram.story",
  description: "Post a story to Instagram. Requires a publicly accessible image URL.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      imageUrl: { type: "string", description: "Public URL of the image for the story" },
    },
    required: ["imageUrl"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;
    const igId = getIgAccountId()!;

    try {
      // Create story container
      const container = await igFetch("POST", `/${igId}/media`, undefined, {
        image_url: String(args.imageUrl),
        media_type: "STORIES",
      });

      if (!container.id) return "Error: Failed to create story container";

      // Publish
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const result = await igFetch("POST", `/${igId}/media_publish`, undefined, {
            creation_id: container.id,
          });
          if (result.id) return `Instagram story published: id=${result.id}`;
        } catch (e: any) {
          if (e.message?.includes("not ready") && attempt < 4) {
            await new Promise(r => setTimeout(r, 3000));
            continue;
          }
          throw e;
        }
      }
      return "Error: Story processing timed out.";
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

// ── instagram.comment ──
registerSkill({
  name: "instagram.comment",
  description: "Comment on an Instagram post.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      mediaId: { type: "string", description: "Instagram media ID to comment on" },
      text: { type: "string", description: "Comment text" },
    },
    required: ["mediaId", "text"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;

    try {
      const data = await igFetch("POST", `/${args.mediaId}/comments`, undefined, {
        message: String(args.text),
      });
      return `Instagram comment posted: id=${data.id || "success"}`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

log.debug("Registered 3 instagram.* skills");
