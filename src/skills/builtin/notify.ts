/**
 * Built-in skills: notify.send, notify.digest, notify.config, notify.flush
 * Notification Tiering System — Critical/Important/General routing.
 *
 * CRITICAL: immediate Telegram alert (trading signals, errors, security)
 * IMPORTANT: batched in daily digest at 20h (agent reports, content updates)
 * GENERAL: weekly digest Sunday 10h (stats, low-priority info)
 */
import { registerSkill, getSkill } from "../loader.js";
import { getDb } from "../../storage/store.js";
import { log } from "../../utils/log.js";

export type NotificationLevel = "critical" | "important" | "general";

// --- Classification rules ---

const CRITICAL_KEYWORDS = [
  "error", "erreur", "fail", "crash", "security", "sécurité", "urgent",
  "trade", "achat", "vente", "stop-loss", "alert", "alerte", "down",
];

const IMPORTANT_KEYWORDS = [
  "agent", "report", "rapport", "content", "contenu", "client", "lead",
  "prospect", "decision", "décision", "completed", "terminé", "published",
];

/**
 * Auto-classify notification level based on source and content.
 */
export function classifyNotification(source: string, body: string): NotificationLevel {
  const lower = `${source} ${body}`.toLowerCase();

  if (CRITICAL_KEYWORDS.some(kw => lower.includes(kw))) return "critical";
  if (IMPORTANT_KEYWORDS.some(kw => lower.includes(kw))) return "important";
  return "general";
}

/**
 * Queue a notification. Critical ones are sent immediately via telegram.send.
 * Important/General are stored for digest delivery.
 */
export async function queueNotification(
  source: string,
  title: string,
  body: string,
  level?: NotificationLevel,
): Promise<void> {
  const resolvedLevel = level || classifyNotification(source, body);
  const d = getDb();

  if (resolvedLevel === "critical") {
    // Send immediately via telegram
    const telegramSkill = getSkill("telegram.send");
    if (telegramSkill) {
      try {
        await telegramSkill.execute({
          message: `🚨 **${title}**\n\n${body}\n\n_Source: ${source}_`,
        });
      } catch (err) {
        log.debug(`[notify] Failed to send critical alert: ${err}`);
      }
    }
    // Also store for record
    d.prepare(
      "INSERT INTO notification_queue (level, source, title, body, delivered) VALUES (?, ?, ?, ?, 1)"
    ).run("critical", source, title, body);
    return;
  }

  // Queue for digest
  d.prepare(
    "INSERT INTO notification_queue (level, source, title, body) VALUES (?, ?, ?, ?)"
  ).run(resolvedLevel, source, title, body);
  log.debug(`[notify] Queued ${resolvedLevel}: ${title}`);
}

/**
 * Build and send a digest of queued notifications.
 */
export async function sendDigest(level: NotificationLevel): Promise<string> {
  const d = getDb();
  const rows = d.prepare(
    "SELECT * FROM notification_queue WHERE level = ? AND delivered = 0 ORDER BY created_at ASC"
  ).all(level) as Array<{
    id: number; source: string; title: string; body: string; created_at: number;
  }>;

  if (rows.length === 0) return `Aucune notification ${level} en attente.`;

  const icon = level === "important" ? "📋" : "📝";
  const label = level === "important" ? "Digest quotidien" : "Digest hebdomadaire";
  const lines = [`${icon} **${label}** — ${rows.length} notification(s)\n`];

  // Group by source
  const bySource: Record<string, typeof rows> = {};
  for (const r of rows) {
    if (!bySource[r.source]) bySource[r.source] = [];
    bySource[r.source].push(r);
  }

  for (const [source, notifs] of Object.entries(bySource)) {
    lines.push(`**${source}** (${notifs.length}):`);
    for (const n of notifs) {
      const preview = n.body.length > 120 ? n.body.slice(0, 120) + "..." : n.body;
      lines.push(`  - ${n.title}: ${preview}`);
    }
    lines.push("");
  }

  // Mark as delivered
  const ids = rows.map(r => r.id);
  d.prepare(
    `UPDATE notification_queue SET delivered = 1 WHERE id IN (${ids.map(() => "?").join(",")})`
  ).run(...ids);

  return lines.join("\n");
}

// --- Skills ---

registerSkill({
  name: "notify.send",
  description:
    "Send a notification through the tiering system. Critical = immediate, Important = daily digest, General = weekly digest.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Notification title" },
      body: { type: "string", description: "Notification body" },
      source: { type: "string", description: "Source (e.g. agent name, skill name)" },
      level: { type: "string", description: "Level: critical, important, general (auto-detected if omitted)" },
    },
    required: ["title", "body"],
  },
  async execute(args): Promise<string> {
    const title = String(args.title);
    const body = String(args.body);
    const source = String(args.source || "manual");
    const level = args.level ? String(args.level) as NotificationLevel : undefined;

    await queueNotification(source, title, body, level);
    const resolvedLevel = level || classifyNotification(source, body);

    if (resolvedLevel === "critical") {
      return `🚨 Notification critique envoyée immédiatement.`;
    }
    return `${resolvedLevel === "important" ? "📋" : "📝"} Notification ${resolvedLevel} mise en file — sera livrée au prochain digest.`;
  },
});

registerSkill({
  name: "notify.digest",
  description: "Generate and send the notification digest. Use level=important for daily, level=general for weekly.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      level: { type: "string", description: "Digest level: important (daily) or general (weekly)" },
    },
  },
  async execute(args): Promise<string> {
    const level = (args.level as NotificationLevel) || "important";
    return sendDigest(level);
  },
});

registerSkill({
  name: "notify.status",
  description: "Show notification queue status — pending counts by level.",
  adminOnly: true,
  argsSchema: { type: "object", properties: {} },
  async execute(): Promise<string> {
    const d = getDb();
    const counts = d.prepare(
      "SELECT level, COUNT(*) as c FROM notification_queue WHERE delivered = 0 GROUP BY level"
    ).all() as Array<{ level: string; c: number }>;

    const today = d.prepare(
      "SELECT level, COUNT(*) as c FROM notification_queue WHERE delivered = 1 AND created_at > unixepoch() - 86400 GROUP BY level"
    ).all() as Array<{ level: string; c: number }>;

    const lines = ["**Notification Queue Status:**\n"];
    lines.push("**En attente:**");
    if (counts.length === 0) {
      lines.push("  (vide)");
    } else {
      for (const c of counts) {
        const icon = c.level === "critical" ? "🚨" : c.level === "important" ? "📋" : "📝";
        lines.push(`  ${icon} ${c.level}: ${c.c}`);
      }
    }

    lines.push("\n**Livrées (24h):**");
    if (today.length === 0) {
      lines.push("  (aucune)");
    } else {
      for (const c of today) lines.push(`  ${c.level}: ${c.c}`);
    }

    return lines.join("\n");
  },
});

log.debug("Registered 3 notify.* skills");
