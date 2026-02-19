/**
 * Built-in skill: social.post — end-to-end social media posting pipeline.
 *
 * Generates an AI image (Pollinations.ai) + posts to Facebook and/or Instagram
 * in a single command. This is the "real world" skill that Kingston needs to
 * be a proper social media manager.
 *
 * Pipeline: topic → AI caption → AI image → upload → post to FB/IG
 */
import { registerSkill, getSkill } from "../loader.js";
import { config } from "../../config/env.js";
import { log } from "../../utils/log.js";

const FB_API = "https://graph.facebook.com/v22.0";

// ── Helpers ──

function getFbToken(): string | null {
  return config.facebookPageAccessToken || null;
}

function getFbPageId(): string | null {
  return config.facebookPageId || null;
}

/**
 * Generate an image via Pollinations.ai (free, no API key).
 * Returns a public URL that Facebook/Instagram can fetch.
 */
function generateImageUrl(prompt: string, width = 1024, height = 1024): string {
  const encoded = encodeURIComponent(prompt);
  // Pollinations returns a direct image URL — no API key needed
  return `https://image.pollinations.ai/prompt/${encoded}?width=${width}&height=${height}&nologo=true&seed=${Date.now()}`;
}

/**
 * Post a photo to Facebook Page via Graph API.
 */
async function postToFacebook(imageUrl: string, caption: string): Promise<{ ok: boolean; id?: string; error?: string }> {
  const token = getFbToken();
  const pageId = getFbPageId();
  if (!token || !pageId) return { ok: false, error: "Facebook not configured (missing token or page ID)" };

  try {
    const params = new URLSearchParams({
      url: imageUrl,
      message: caption,
      published: "true",
      access_token: token,
    });

    const resp = await fetch(`${FB_API}/${pageId}/photos`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    const data = await resp.json() as { id?: string; post_id?: string; error?: { message: string } };
    if (data.error) return { ok: false, error: data.error.message };
    return { ok: true, id: data.post_id || data.id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Post a photo to Instagram via Graph API (2-step container flow).
 */
async function postToInstagram(imageUrl: string, caption: string): Promise<{ ok: boolean; id?: string; error?: string }> {
  const token = getFbToken();
  const pageId = getFbPageId();
  if (!token || !pageId) return { ok: false, error: "Facebook token not configured" };

  try {
    // Step 0: Get Instagram Business Account ID
    let igId = process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID || "";
    if (!igId) {
      const pageResp = await fetch(
        `${FB_API}/${pageId}?fields=instagram_business_account&access_token=${token}`
      );
      const pageData = await pageResp.json() as { instagram_business_account?: { id: string } };
      if (!pageData.instagram_business_account?.id) {
        return { ok: false, error: "No Instagram Business Account linked to this Facebook Page" };
      }
      igId = pageData.instagram_business_account.id;
    }

    // Step 1: Create media container
    const containerParams = new URLSearchParams({
      image_url: imageUrl,
      caption,
      access_token: token,
    });

    const containerResp = await fetch(`${FB_API}/${igId}/media`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: containerParams.toString(),
    });

    const containerData = await containerResp.json() as { id?: string; error?: { message: string } };
    if (containerData.error || !containerData.id) {
      return { ok: false, error: containerData.error?.message || "Failed to create IG container" };
    }

    // Step 2: Poll until ready, then publish
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise(r => setTimeout(r, 3000)); // wait 3s

      // Check status
      const statusResp = await fetch(
        `${FB_API}/${containerData.id}?fields=status_code&access_token=${token}`
      );
      const statusData = await statusResp.json() as { status_code?: string };

      if (statusData.status_code === "FINISHED") {
        // Publish
        const publishParams = new URLSearchParams({
          creation_id: containerData.id,
          access_token: token,
        });

        const publishResp = await fetch(`${FB_API}/${igId}/media_publish`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: publishParams.toString(),
        });

        const publishData = await publishResp.json() as { id?: string; error?: { message: string } };
        if (publishData.error) return { ok: false, error: publishData.error.message };
        return { ok: true, id: publishData.id };
      }

      if (statusData.status_code === "ERROR") {
        return { ok: false, error: "Instagram media processing failed" };
      }
    }

    return { ok: false, error: "Instagram media processing timed out (30s)" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── social.post — The main pipeline skill ──

registerSkill({
  name: "social.post",
  description:
    "End-to-end social media posting: generates an AI image + posts to Facebook and/or Instagram in one command. " +
    "Just provide a topic and optionally a caption — Kingston handles image generation, upload, and posting automatically. " +
    "Platforms: facebook, instagram, or both (default: facebook).",
  adminOnly: true,
  timeoutMs: 60_000, // 60s — image gen + upload + posting takes time
  argsSchema: {
    type: "object",
    properties: {
      topic: {
        type: "string",
        description: "Topic or description for the image and post (e.g. 'AI trading bot making money')",
      },
      caption: {
        type: "string",
        description: "Post caption/text. If not provided, will be generated from the topic.",
      },
      platforms: {
        type: "string",
        description: "Where to post: 'facebook', 'instagram', or 'both' (default: facebook)",
      },
      imagePrompt: {
        type: "string",
        description: "Custom image generation prompt. If not provided, generates from topic.",
      },
      imageStyle: {
        type: "string",
        description: "Image style: 'photo', 'illustration', 'digital-art', 'corporate', 'meme' (default: photo)",
      },
    },
    required: ["topic"],
  },
  async execute(args): Promise<string> {
    const topic = String(args.topic);
    const platforms = String(args.platforms || "facebook").toLowerCase();
    const style = String(args.imageStyle || "photo");

    // Build caption
    const caption = args.caption
      ? String(args.caption)
      : `${topic}\n\n#AI #Kingston #Bastilon`;

    // Build image prompt
    const styleMap: Record<string, string> = {
      photo: "professional high-quality photograph, realistic, 4k",
      illustration: "modern digital illustration, clean design, vibrant colors",
      "digital-art": "digital art, creative, artistic, detailed",
      corporate: "professional corporate photography, business, clean, modern",
      meme: "funny meme style, internet humor, bold text",
    };

    const imagePrompt = args.imagePrompt
      ? String(args.imagePrompt)
      : `${topic}, ${styleMap[style] || styleMap.photo}`;

    log.info(`[social.post] Pipeline starting: topic="${topic}", platforms=${platforms}`);

    // Step 1: Generate image URL
    const imageUrl = generateImageUrl(imagePrompt);
    log.info(`[social.post] Image URL generated: ${imageUrl.slice(0, 100)}...`);

    // Step 2: Verify image is accessible (Pollinations generates on first request)
    try {
      const probe = await fetch(imageUrl, { method: "HEAD" });
      if (!probe.ok) {
        // Pollinations needs a GET to generate — do a full fetch
        const genResp = await fetch(imageUrl);
        if (!genResp.ok) {
          return `Erreur: Image generation failed (HTTP ${genResp.status})`;
        }
        log.info(`[social.post] Image generated (${genResp.headers.get("content-length") || "?"} bytes)`);
      }
    } catch (err) {
      return `Erreur: Impossible de générer l'image — ${err instanceof Error ? err.message : String(err)}`;
    }

    const results: string[] = [];

    // Step 3: Post to Facebook
    if (platforms === "facebook" || platforms === "both") {
      log.info("[social.post] Posting to Facebook...");
      const fbResult = await postToFacebook(imageUrl, caption);
      if (fbResult.ok) {
        results.push(`Facebook: Post publié (id=${fbResult.id})`);
        log.info(`[social.post] Facebook OK: ${fbResult.id}`);
      } else {
        results.push(`Facebook: ERREUR — ${fbResult.error}`);
        log.warn(`[social.post] Facebook failed: ${fbResult.error}`);
      }
    }

    // Step 4: Post to Instagram
    if (platforms === "instagram" || platforms === "both") {
      log.info("[social.post] Posting to Instagram...");
      const igResult = await postToInstagram(imageUrl, caption);
      if (igResult.ok) {
        results.push(`Instagram: Post publié (id=${igResult.id})`);
        log.info(`[social.post] Instagram OK: ${igResult.id}`);
      } else {
        results.push(`Instagram: ERREUR — ${igResult.error}`);
        log.warn(`[social.post] Instagram failed: ${igResult.error}`);
      }
    }

    const summary = [
      `**Social Post Pipeline**`,
      `Topic: ${topic}`,
      `Image: ${imageUrl.slice(0, 80)}...`,
      ``,
      ...results,
    ].join("\n");

    return summary;
  },
});

// ── social.post_multi — Multi-photo Facebook post ──

registerSkill({
  name: "social.post_multi",
  description:
    "Post multiple photos to Facebook in a single album-style post. " +
    "Provide multiple image URLs or image prompts. Max 10 images.",
  adminOnly: true,
  timeoutMs: 90_000,
  argsSchema: {
    type: "object",
    properties: {
      caption: { type: "string", description: "Post caption/text" },
      imageUrls: {
        type: "string",
        description: "Comma-separated list of image URLs to post",
      },
      imagePrompts: {
        type: "string",
        description: "Comma-separated list of image prompts (generates via AI if no URLs provided)",
      },
    },
    required: ["caption"],
  },
  async execute(args): Promise<string> {
    const token = getFbToken();
    const pageId = getFbPageId();
    if (!token || !pageId) return "Facebook not configured";

    const caption = String(args.caption);
    let urls: string[] = [];

    if (args.imageUrls) {
      urls = String(args.imageUrls).split(",").map(u => u.trim()).filter(Boolean);
    } else if (args.imagePrompts) {
      const prompts = String(args.imagePrompts).split(",").map(p => p.trim()).filter(Boolean);
      urls = prompts.map(p => generateImageUrl(p));
    } else {
      return "Erreur: Fournis imageUrls ou imagePrompts";
    }

    if (urls.length < 1) return "Erreur: Au moins 1 image requise";
    if (urls.length > 10) urls = urls.slice(0, 10);

    try {
      // Step 1: Upload each photo as unpublished
      const photoIds: string[] = [];
      for (const url of urls) {
        const params = new URLSearchParams({
          url,
          published: "false",
          access_token: token,
        });

        const resp = await fetch(`${FB_API}/${pageId}/photos`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: params.toString(),
        });
        const data = await resp.json() as { id?: string; error?: { message: string } };
        if (data.error) return `Erreur upload photo: ${data.error.message}`;
        if (data.id) photoIds.push(data.id);
      }

      // Step 2: Create feed post with all photos
      const feedParams = new URLSearchParams({
        message: caption,
        published: "true",
        access_token: token,
      });

      photoIds.forEach((id, i) => {
        feedParams.append(`attached_media[${i}]`, JSON.stringify({ media_fbid: id }));
      });

      const feedResp = await fetch(`${FB_API}/${pageId}/feed`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: feedParams.toString(),
      });

      const feedData = await feedResp.json() as { id?: string; error?: { message: string } };
      if (feedData.error) return `Erreur post multi-photo: ${feedData.error.message}`;

      return `Facebook multi-photo post publié: id=${feedData.id}, ${photoIds.length} photos`;
    } catch (err) {
      return `Erreur: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

// ── social.verify — Check if Facebook/Instagram tokens work ──

registerSkill({
  name: "social.verify",
  description: "Verify that Facebook and Instagram API access is working. Checks token validity, permissions, and account linking.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {},
  },
  async execute(): Promise<string> {
    const token = getFbToken();
    const pageId = getFbPageId();
    const results: string[] = [];

    // Check Facebook
    if (!token || !pageId) {
      results.push("Facebook: NON CONFIGURÉ (manque FACEBOOK_PAGE_ACCESS_TOKEN ou FACEBOOK_PAGE_ID)");
    } else {
      try {
        // Get page info
        const pageResp = await fetch(
          `${FB_API}/${pageId}?fields=name,id,fan_count&access_token=${token}`
        );
        const pageData = await pageResp.json() as { name?: string; id?: string; fan_count?: number; error?: { message: string } };
        if (pageData.error) {
          results.push(`Facebook: ERREUR — ${pageData.error.message}`);
        } else {
          results.push(`Facebook: OK — Page "${pageData.name}" (id=${pageData.id}, ${pageData.fan_count || 0} fans)`);
        }

        // Check token permissions
        const appId = config.facebookAppId;
        const appSecret = config.facebookAppSecret;
        if (appId && appSecret) {
          const debugResp = await fetch(
            `${FB_API}/debug_token?input_token=${token}&access_token=${appId}|${appSecret}`
          );
          const debugData = await debugResp.json() as { data?: { is_valid: boolean; scopes: string[]; expires_at: number } };
          if (debugData.data) {
            const d = debugData.data;
            results.push(`  Token valide: ${d.is_valid}`);
            results.push(`  Scopes: ${d.scopes?.join(", ") || "N/A"}`);
            results.push(`  Expire: ${d.expires_at === 0 ? "Jamais" : new Date(d.expires_at * 1000).toISOString()}`);

            // Check required permissions
            const required = ["pages_manage_posts", "pages_read_engagement"];
            const missing = required.filter(p => !d.scopes?.includes(p));
            if (missing.length > 0) {
              results.push(`  PERMISSIONS MANQUANTES: ${missing.join(", ")}`);
            }
          }
        }

        // Check Instagram linking
        const igResp = await fetch(
          `${FB_API}/${pageId}?fields=instagram_business_account&access_token=${token}`
        );
        const igData = await igResp.json() as { instagram_business_account?: { id: string } };
        if (igData.instagram_business_account?.id) {
          results.push(`Instagram: LIÉ — Business Account ID: ${igData.instagram_business_account.id}`);
        } else {
          results.push(`Instagram: NON LIÉ — Aucun compte Instagram Business associé à cette Page`);
        }
      } catch (err) {
        results.push(`Facebook: ERREUR RÉSEAU — ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return results.join("\n");
  },
});

log.debug("Registered 3 social.* skills (post, post_multi, verify)");
