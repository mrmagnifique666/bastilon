/**
 * Kingston XP — RESULTS-BASED motivation system.
 *
 * Philosophy: XP is earned ONLY from measurable external outcomes.
 * Process (writing code, making plans) earns NOTHING.
 * Only RESULTS that can be verified earn or lose points.
 *
 * RESULTS-BASED REWARDS:
 *   moltbook_comment_received    +5 per comment on your posts
 *   moltbook_upvote_received     +2 per upvote on your posts
 *   moltbook_reply_received      +3 someone replied to your comment
 *   trade_profit_realized        +1 per $1 realized profit
 *   trade_loss_realized          -1 per $1 realized loss
 *   client_signed                +100 new paying client
 *   client_meeting_booked        +25 meeting scheduled
 *   revenue_earned               +1 per $1 earned
 *   follower_gained              +5 new Moltbook/social follower
 *   nicolas_explicit_praise      +10 Nicolas says "nice/bon/bien joue"
 *   post_trending                +20 post reaches hot feed top 10
 *   comment_thread_started       +8 your comment spawned 3+ replies
 *
 * RESULTS-BASED PENALTIES:
 *   moltbook_post_zero_engagement -10 post with 0 comments after 24h
 *   trade_loss_realized           -1 per $1 lost
 *   nicolas_explicit_frustration  -15 Nicolas expresses frustration
 *   cron_failed_silently          -5 scheduled task failed without notification
 *   hallucination_caught_by_user  -20 Nicolas catches a false claim
 *   post_removed_or_flagged       -10 post removed/flagged
 *   missed_scheduled_action       -5 cron didn't fire
 *
 * Levels (hard to reach — results only):
 *   0-499:     Apprenti
 *   500-2500:  Operateur
 *   2501-10000: Autonome
 *   10001+:    Architecte
 */
import { registerSkill } from "../loader.js";
import { getDb } from "../../storage/store.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface XpRow {
  id: number;
  event_type: string;
  points: number;
  reason: string;
  source: string;
  created_at: number;
}

interface LeaderboardRow {
  event_type: string;
  total_points: number;
  event_count: number;
}

interface DailyRow {
  day: string;
  total_points: number;
  event_count: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LEVELS: Array<{ threshold: number; name: string }> = [
  { threshold: 10001, name: "Architecte" },
  { threshold: 2501, name: "Autonome" },
  { threshold: 500, name: "Operateur" },
  { threshold: 0, name: "Apprenti" },
];

const VALID_EARN_EVENTS = new Set([
  "moltbook_comment_received",
  "moltbook_upvote_received",
  "moltbook_reply_received",
  "trade_profit_realized",
  "client_signed",
  "client_meeting_booked",
  "revenue_earned",
  "follower_gained",
  "nicolas_explicit_praise",
  "post_trending",
  "comment_thread_started",
]);

const VALID_PAIN_EVENTS = new Set([
  "moltbook_post_zero_engagement",
  "trade_loss_realized",
  "nicolas_explicit_frustration",
  "cron_failed_silently",
  "hallucination_caught_by_user",
  "post_removed_or_flagged",
  "missed_scheduled_action",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getLevelName(totalXp: number): string {
  for (const level of LEVELS) {
    if (totalXp >= level.threshold) return level.name;
  }
  return "Apprenti";
}

function getNextLevel(totalXp: number): { name: string; threshold: number; remaining: number } | null {
  for (let i = 0; i < LEVELS.length; i++) {
    if (totalXp >= LEVELS[i].threshold) {
      if (i === 0) return null;
      const next = LEVELS[i - 1];
      return { name: next.name, threshold: next.threshold, remaining: next.threshold - totalXp };
    }
  }
  const next = LEVELS[LEVELS.length - 1];
  return { name: next.name, threshold: next.threshold, remaining: next.threshold - totalXp };
}

function getTotalXp(): number {
  const db = getDb();
  const row = db.prepare("SELECT COALESCE(SUM(points), 0) AS total FROM kingston_xp").get() as { total: number };
  return row.total;
}

function getTodayXp(): number {
  const db = getDb();
  const todayStart = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
  const row = db.prepare("SELECT COALESCE(SUM(points), 0) AS total FROM kingston_xp WHERE created_at >= ?").get(todayStart) as { total: number };
  return row.total;
}

function formatTimestamp(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().replace("T", " ").slice(0, 19);
}

// ---------------------------------------------------------------------------
// Ensure table exists
// ---------------------------------------------------------------------------

function ensureTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS kingston_xp (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      points INTEGER NOT NULL,
      reason TEXT NOT NULL,
      source TEXT DEFAULT 'system',
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_xp_created ON kingston_xp(created_at);
    CREATE INDEX IF NOT EXISTS idx_xp_type ON kingston_xp(event_type);
  `);
}

ensureTable();

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

registerSkill({
  name: "xp.earn",
  description: `Award XP for a VERIFIED external result. Process actions earn NOTHING — only measurable outcomes.
Valid events: ${[...VALID_EARN_EVENTS].join(", ")}`,
  argsSchema: {
    type: "object",
    properties: {
      event: {
        type: "string",
        description: "Result event type. MUST be one of the valid earn events.",
      },
      points: { type: "number", description: "Points (e.g. +5 per comment, +2 per upvote, +1 per $1 profit)" },
      reason: { type: "string", description: "What SPECIFICALLY happened — include numbers, post IDs, trade symbols" },
    },
    required: ["event", "points", "reason"],
  },
  async execute(args): Promise<string> {
    const event = args.event as string;
    const points = Math.abs(args.points as number);
    const reason = args.reason as string;

    if (!VALID_EARN_EVENTS.has(event)) {
      return `REJECTED: "${event}" is not a results-based event.\nValid: ${[...VALID_EARN_EVENTS].join(", ")}\n\nXP = RESULTS only. Did a post get comments? Did a trade close in profit? Did Nicolas say "nice"?`;
    }

    const db = getDb();
    const info = db
      .prepare("INSERT INTO kingston_xp (event_type, points, reason, source) VALUES (?, ?, ?, 'result')")
      .run(event, points, reason);

    const total = getTotalXp();
    const level = getLevelName(total);
    const next = getNextLevel(total);
    const todayXp = getTodayXp();
    const nextStr = next ? ` | Next: ${next.name} in ${next.remaining} XP` : " | MAX LEVEL";

    return `+${points} XP (${event}): ${reason}\n#${info.lastInsertRowid} | Total: ${total} | Today: ${todayXp > 0 ? "+" : ""}${todayXp} | Level: ${level}${nextStr}`;
  },
});

registerSkill({
  name: "xp.pain",
  description: `Record a penalty for a VERIFIED negative outcome. Not for internal errors — only for outcomes.
Valid events: ${[...VALID_PAIN_EVENTS].join(", ")}`,
  argsSchema: {
    type: "object",
    properties: {
      event: {
        type: "string",
        description: "Pain event type. MUST be one of the valid pain events.",
      },
      points: { type: "number", description: "Points to deduct (stored as negative)" },
      reason: { type: "string", description: "What SPECIFICALLY went wrong — include evidence" },
    },
    required: ["event", "points", "reason"],
  },
  async execute(args): Promise<string> {
    const event = args.event as string;
    const points = -Math.abs(args.points as number);
    const reason = args.reason as string;

    if (!VALID_PAIN_EVENTS.has(event)) {
      return `REJECTED: "${event}" is not a results-based pain event.\nValid: ${[...VALID_PAIN_EVENTS].join(", ")}`;
    }

    const db = getDb();
    const info = db
      .prepare("INSERT INTO kingston_xp (event_type, points, reason, source) VALUES (?, ?, ?, 'result')")
      .run(event, points, reason);

    const total = getTotalXp();
    const level = getLevelName(total);
    const todayXp = getTodayXp();

    return `${points} XP (${event}): ${reason}\n#${info.lastInsertRowid} | Total: ${total} | Today: ${todayXp > 0 ? "+" : ""}${todayXp} | Level: ${level}`;
  },
});

registerSkill({
  name: "xp.status",
  description: "Show current XP total, level, today's performance, 7-day trend, and recent results.",
  argsSchema: {
    type: "object",
    properties: {},
  },
  async execute(): Promise<string> {
    const db = getDb();
    const total = getTotalXp();
    const level = getLevelName(total);
    const next = getNextLevel(total);
    const todayXp = getTodayXp();

    const recent = db
      .prepare("SELECT id, event_type, points, reason, created_at FROM kingston_xp ORDER BY created_at DESC, id DESC LIMIT 10")
      .all() as XpRow[];

    const daily = db.prepare(`
      SELECT date(created_at, 'unixepoch') AS day, SUM(points) AS total_points, COUNT(*) AS event_count
      FROM kingston_xp
      WHERE created_at >= strftime('%s', 'now', '-7 days')
      GROUP BY day ORDER BY day DESC
    `).all() as DailyRow[];

    const lines: string[] = [
      `Kingston XP — Results Dashboard`,
      `Total: ${total} XP | Level: ${level}`,
      `Today: ${todayXp > 0 ? "+" : ""}${todayXp} XP`,
    ];

    if (next) {
      lines.push(`Next: ${next.name} (need ${next.remaining} more XP)`);
    } else {
      lines.push(`MAX LEVEL (Architecte)`);
    }

    if (daily.length > 0) {
      lines.push(`\n7-day trend:`);
      for (const d of daily) {
        const sign = d.total_points >= 0 ? "+" : "";
        lines.push(`  ${d.day}: ${sign}${d.total_points} XP (${d.event_count} events)`);
      }
    }

    if (recent.length > 0) {
      lines.push(`\nRecent results:`);
      for (const r of recent) {
        const sign = r.points >= 0 ? "+" : "";
        lines.push(`  ${sign}${r.points} (${r.event_type}): ${r.reason}`);
      }
    }

    return lines.join("\n");
  },
});

registerSkill({
  name: "xp.history",
  description: "Show XP result history (most recent first).",
  argsSchema: {
    type: "object",
    properties: {
      limit: { type: "number", description: "Number of events to show (default 20)" },
    },
  },
  async execute(args): Promise<string> {
    const limit = (args.limit as number) || 20;

    const db = getDb();
    const rows = db
      .prepare("SELECT id, event_type, points, reason, source, created_at FROM kingston_xp ORDER BY created_at DESC, id DESC LIMIT ?")
      .all(limit) as XpRow[];

    if (rows.length === 0) return "No XP events recorded yet.";

    const lines = [`XP History (last ${rows.length}):`];
    for (const r of rows) {
      const sign = r.points >= 0 ? "+" : "";
      const ts = formatTimestamp(r.created_at);
      lines.push(`#${r.id} [${ts}] ${sign}${r.points} (${r.event_type}) [${r.source}]: ${r.reason}`);
    }

    const total = getTotalXp();
    lines.push(`\nCurrent total: ${total} XP (${getLevelName(total)})`);

    return lines.join("\n");
  },
});

registerSkill({
  name: "xp.leaderboard",
  description: "Show XP breakdown by result type — which outcomes generate the most value.",
  argsSchema: {
    type: "object",
    properties: {},
  },
  async execute(): Promise<string> {
    const db = getDb();
    const rows = db
      .prepare(`
        SELECT event_type, SUM(points) AS total_points, COUNT(*) AS event_count
        FROM kingston_xp
        GROUP BY event_type
        ORDER BY total_points DESC
      `)
      .all() as LeaderboardRow[];

    if (rows.length === 0) return "No XP events recorded yet.";

    const total = getTotalXp();
    const lines = [
      `XP Leaderboard — Results by Category`,
      `Total: ${total} XP (${getLevelName(total)})`,
      ``,
    ];

    for (const r of rows) {
      const sign = r.total_points >= 0 ? "+" : "";
      lines.push(`  ${r.event_type}: ${sign}${r.total_points} XP (${r.event_count}x)`);
    }

    return lines.join("\n");
  },
});
