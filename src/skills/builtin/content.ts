/**
 * Built-in skills: content.draft, content.list, content.schedule, content.publish, content.analytics
 * Content pipeline for multi-platform publishing.
 */
import { registerSkill } from "../loader.js";
import { getDb } from "../../storage/store.js";

interface ContentRow {
  id: number;
  topic: string;
  platform: string;
  content_type: string;
  body: string | null;
  status: string;
  scheduled_at: number | null;
  published_at: number | null;
  performance: string | null;
  created_at: number;
  updated_at: number;
}

registerSkill({
  name: "content.draft",
  description:
    "Create a content draft for a specific platform. Stores it in the content pipeline for review.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      topic: { type: "string", description: "Content topic or title" },
      platform: {
        type: "string",
        description: "Target platform: linkedin, moltbook, twitter, blog, email, general (default: general)",
      },
      content_type: {
        type: "string",
        description: "Type: post, article, email, proposal (default: post)",
      },
      body: { type: "string", description: "The content body/text" },
    },
    required: ["topic", "body"],
  },
  async execute(args): Promise<string> {
    const topic = String(args.topic);
    const platform = String(args.platform || "general");
    const contentType = String(args.content_type || "post");
    const body = String(args.body);

    const d = getDb();
    const info = d
      .prepare(
        "INSERT INTO content_items (topic, platform, content_type, body, status) VALUES (?, ?, ?, ?, 'draft')",
      )
      .run(topic, platform, contentType, body);

    return (
      `Content #${info.lastInsertRowid} created [draft]\n` +
      `Topic: ${topic}\n` +
      `Platform: ${platform} | Type: ${contentType}\n` +
      `Length: ${body.length} chars\n\n` +
      `Use content.schedule to plan publication.`
    );
  },
});

registerSkill({
  name: "content.list",
  description: "List content items, optionally filtered by status or platform.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      status: {
        type: "string",
        description: "Filter: draft, review, scheduled, published (default: all)",
      },
      platform: { type: "string", description: "Filter by platform" },
      limit: { type: "number", description: "Max results (default: 15)" },
    },
  },
  async execute(args): Promise<string> {
    const d = getDb();
    const limit = (args.limit as number) || 15;

    let query = "SELECT * FROM content_items WHERE 1=1";
    const params: unknown[] = [];

    if (args.status) {
      query += " AND status = ?";
      params.push(String(args.status));
    }
    if (args.platform) {
      query += " AND platform = ?";
      params.push(String(args.platform));
    }

    query += " ORDER BY updated_at DESC LIMIT ?";
    params.push(limit);

    const rows = d.prepare(query).all(...params) as ContentRow[];

    if (rows.length === 0) return "No content items found.";

    return rows
      .map((c) => {
        const scheduled = c.scheduled_at
          ? new Date(c.scheduled_at * 1000).toLocaleString("fr-CA", { timeZone: "America/Toronto" })
          : null;
        const preview = c.body ? c.body.slice(0, 80) + (c.body.length > 80 ? "..." : "") : "(empty)";
        return (
          `**#${c.id}** [${c.status}] ${c.topic}\n` +
          `  Platform: ${c.platform} | Type: ${c.content_type}\n` +
          (scheduled ? `  Programmé: ${scheduled}\n` : "") +
          `  ${preview}`
        );
      })
      .join("\n\n");
  },
});

registerSkill({
  name: "content.schedule",
  description:
    "Schedule a content item for publication at a specific date/time.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      id: { type: "number", description: "Content item ID" },
      datetime: {
        type: "string",
        description: "Publication date/time in ISO format (e.g. 2026-02-15T10:00:00)",
      },
      platform: {
        type: "string",
        description: "Override platform if needed",
      },
    },
    required: ["id", "datetime"],
  },
  async execute(args): Promise<string> {
    const contentId = args.id as number;
    const d = getDb();

    const row = d.prepare("SELECT * FROM content_items WHERE id = ?").get(contentId) as ContentRow | undefined;
    if (!row) return `Content #${contentId} not found.`;

    let scheduledAt: number;
    try {
      scheduledAt = Math.floor(new Date(String(args.datetime)).getTime() / 1000);
      if (isNaN(scheduledAt)) throw new Error("Invalid date");
    } catch {
      return "Error: invalid datetime format. Use ISO format (e.g. 2026-02-15T10:00:00).";
    }

    const updates: string[] = ["status = 'scheduled'", "scheduled_at = ?", "updated_at = unixepoch()"];
    const params: unknown[] = [scheduledAt];

    if (args.platform) {
      updates.push("platform = ?");
      params.push(String(args.platform));
    }

    params.push(contentId);
    d.prepare(`UPDATE content_items SET ${updates.join(", ")} WHERE id = ?`).run(...params);

    const dateStr = new Date(scheduledAt * 1000).toLocaleString("fr-CA", {
      timeZone: "America/Toronto",
    });

    return `Content #${contentId} scheduled for ${dateStr} on ${args.platform || row.platform}.`;
  },
});

registerSkill({
  name: "content.publish",
  description:
    "Mark a content item as published. Use after actually posting on the platform.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      id: { type: "number", description: "Content item ID" },
      url: { type: "string", description: "URL of the published content (optional)" },
    },
    required: ["id"],
  },
  async execute(args): Promise<string> {
    const contentId = args.id as number;
    const d = getDb();

    const row = d.prepare("SELECT * FROM content_items WHERE id = ?").get(contentId) as ContentRow | undefined;
    if (!row) return `Content #${contentId} not found.`;

    d.prepare(
      "UPDATE content_items SET status = 'published', published_at = unixepoch(), updated_at = unixepoch() WHERE id = ?",
    ).run(contentId);

    let result = `Content #${contentId} marked as published on ${row.platform}.`;
    if (args.url) result += `\nURL: ${args.url}`;
    return result;
  },
});

registerSkill({
  name: "content.analytics",
  description:
    "Content performance analytics: published items, platform distribution, scheduling stats.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      days: { type: "number", description: "Lookback period in days (default: 30)" },
    },
  },
  async execute(args): Promise<string> {
    const days = (args.days as number) || 30;
    const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
    const d = getDb();

    // Overall stats
    const total = d
      .prepare("SELECT COUNT(*) as c FROM content_items")
      .get() as { c: number };

    const byStatus = d
      .prepare("SELECT status, COUNT(*) as c FROM content_items GROUP BY status")
      .all() as Array<{ status: string; c: number }>;

    // Recent published
    const recentPublished = d
      .prepare(
        `SELECT platform, COUNT(*) as c FROM content_items
         WHERE status = 'published' AND published_at > ?
         GROUP BY platform ORDER BY c DESC`,
      )
      .all(cutoff) as Array<{ platform: string; c: number }>;

    // Upcoming scheduled
    const upcoming = d
      .prepare(
        `SELECT * FROM content_items WHERE status = 'scheduled' AND scheduled_at > ?
         ORDER BY scheduled_at ASC LIMIT 5`,
      )
      .all(Math.floor(Date.now() / 1000)) as ContentRow[];

    let output = `**Content Analytics — ${days} jours**\n\n`;
    output += `**Total:** ${total.c} items\n`;
    output += `**Par statut:** ${byStatus.map((s) => `${s.c} ${s.status}`).join(", ")}\n\n`;

    if (recentPublished.length > 0) {
      output += `**Publié (${days}j) par plateforme:**\n`;
      for (const p of recentPublished) {
        output += `  ${p.platform}: ${p.c} publication(s)\n`;
      }
      output += "\n";
    }

    if (upcoming.length > 0) {
      output += `**Prochaines publications:**\n`;
      for (const c of upcoming) {
        const date = c.scheduled_at
          ? new Date(c.scheduled_at * 1000).toLocaleString("fr-CA", { timeZone: "America/Toronto" })
          : "?";
        output += `  ${date} — ${c.topic} (${c.platform})\n`;
      }
    } else {
      output += "Aucune publication programmée.\n";
    }

    return output;
  },
});
