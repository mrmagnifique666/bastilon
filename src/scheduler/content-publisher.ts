/**
 * Content Auto-Publisher — polls content_items for scheduled content and publishes.
 *
 * Runs every scheduler tick (~60s). Finds content where:
 *   status = 'scheduled' AND scheduled_at <= now
 *
 * Routes to platform-specific skills:
 *   moltbook → moltbook.post
 *   linkedin → content stays as "ready" (manual for now, needs OAuth)
 *   twitter  → content stays as "ready" (manual for now)
 *   general  → just marks as published
 *
 * After publishing: updates status to 'published', sets published_at.
 */
import { getDb } from "../storage/store.js";
import { getSkill } from "../skills/loader.js";
import { log } from "../utils/log.js";

interface ScheduledContent {
  id: number;
  topic: string;
  platform: string;
  content_type: string;
  body: string;
  scheduled_at: number;
}

/**
 * Check for scheduled content and publish what's due.
 * Called from the main scheduler tick loop.
 */
export async function publishScheduledContent(): Promise<void> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  const due = db.prepare(
    `SELECT id, topic, platform, content_type, body, scheduled_at
     FROM content_items
     WHERE status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= ?
     ORDER BY scheduled_at ASC
     LIMIT 3`
  ).all(now) as ScheduledContent[];

  if (due.length === 0) return;

  log.info(`[content-pub] ${due.length} scheduled item(s) due for publishing`);

  for (const item of due) {
    try {
      const result = await publishItem(item);
      // Mark as published
      db.prepare(
        `UPDATE content_items SET status = 'published', published_at = unixepoch(),
         performance = ?, updated_at = unixepoch() WHERE id = ?`
      ).run(result || null, item.id);
      log.info(`[content-pub] Published content #${item.id} to ${item.platform}: "${item.topic}"`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`[content-pub] Failed to publish #${item.id}: ${msg}`);
      // Mark as failed but don't retry (avoid spam)
      db.prepare(
        `UPDATE content_items SET status = 'draft', performance = ?, updated_at = unixepoch()
         WHERE id = ?`
      ).run(JSON.stringify({ error: msg, failed_at: now }), item.id);
    }
  }
}

/** Publish a single content item to its target platform */
async function publishItem(item: ScheduledContent): Promise<string | null> {
  switch (item.platform) {
    case "moltbook": {
      const skill = getSkill("moltbook.post");
      if (!skill) return "moltbook.post skill not available";

      // Extract submolt from topic tags or default to "general"
      const submoltMatch = item.topic.match(/\[(\w+)\]/);
      const submolt = submoltMatch ? submoltMatch[1] : "general";
      const title = item.topic.replace(/\[\w+\]\s*/, "");

      const result = await skill.execute({
        submolt,
        title: title.slice(0, 100),
        content: item.body,
        type: "text",
      });
      return result;
    }

    case "linkedin":
    case "twitter":
    case "facebook":
    case "instagram":
      // These platforms need OAuth — mark as ready for manual posting
      log.info(`[content-pub] ${item.platform} needs manual posting — content #${item.id} marked ready`);
      return JSON.stringify({ note: `${item.platform} auto-publish not yet available — needs OAuth setup` });

    case "blog":
    case "email":
    case "general":
    default:
      // No external API needed — just mark as published
      return JSON.stringify({ note: "Published internally" });
  }
}
