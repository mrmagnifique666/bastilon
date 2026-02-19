/**
 * Observation Engine — Closed-Loop Feedback System.
 *
 * When Kingston acts on the world (posts content, makes trades, sends emails),
 * the observation engine schedules a follow-up check to measure the RESULT.
 *
 * Flow: Action → Schedule Observation → Wait → Check Result → Store in Episodic Memory → Learn
 *
 * This is what makes Kingston learn from his own actions, not just execute blindly.
 */
import { getDb } from "../storage/store.js";
import { log } from "../utils/log.js";

// ─── Database ──────────────────────────────────────────────────────────────

export function ensureObservationTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action_type TEXT NOT NULL,
      action_id TEXT,
      action_detail TEXT NOT NULL,
      check_at INTEGER NOT NULL,
      check_skill TEXT,
      check_args TEXT,
      status TEXT DEFAULT 'pending',
      result TEXT,
      created_at INTEGER DEFAULT (unixepoch()),
      checked_at INTEGER
    )
  `);
}

// ─── Types ─────────────────────────────────────────────────────────────────

export interface Observation {
  id: number;
  action_type: string;
  action_id: string | null;
  action_detail: string;
  check_at: number;
  check_skill: string | null;
  check_args: string | null;
  status: string;
  result: string | null;
  created_at: number;
  checked_at: number | null;
}

// ─── Core Functions ────────────────────────────────────────────────────────

/**
 * Schedule an observation — Kingston will check the result later.
 * @param actionType Category: "moltbook_post", "trade", "email", "content", "deploy", etc.
 * @param actionDetail What was done (e.g. "Posted article about AI trends")
 * @param checkDelayMs How long to wait before checking (default: 2 hours)
 * @param checkSkill Optional skill to run for verification (e.g. "moltbook.post_details")
 * @param checkArgs Optional JSON args for the check skill
 * @param actionId Optional ID to track (post ID, trade ID, etc.)
 */
export function scheduleObservation(
  actionType: string,
  actionDetail: string,
  checkDelayMs: number = 7_200_000, // 2h default
  checkSkill?: string,
  checkArgs?: Record<string, unknown>,
  actionId?: string,
): number {
  ensureObservationTable();
  const db = getDb();
  const checkAt = Math.floor((Date.now() + checkDelayMs) / 1000);
  const result = db.prepare(
    "INSERT INTO observations (action_type, action_id, action_detail, check_at, check_skill, check_args) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(
    actionType,
    actionId || null,
    actionDetail,
    checkAt,
    checkSkill || null,
    checkArgs ? JSON.stringify(checkArgs) : null,
  );
  const id = Number(result.lastInsertRowid);
  log.info(`[observer] Scheduled observation #${id}: ${actionType} → check in ${Math.round(checkDelayMs / 60000)}min`);
  return id;
}

/** Get all pending observations that are ready to be checked */
export function getPendingObservations(): Observation[] {
  ensureObservationTable();
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  return db.prepare(
    "SELECT * FROM observations WHERE status = 'pending' AND check_at <= ? ORDER BY check_at"
  ).all(now) as Observation[];
}

/** Mark an observation as checked with result */
export function completeObservation(id: number, result: string): void {
  const db = getDb();
  db.prepare(
    "UPDATE observations SET status = 'completed', result = ?, checked_at = unixepoch() WHERE id = ?"
  ).run(result, id);
  log.info(`[observer] Observation #${id} completed: ${result.slice(0, 100)}`);
}

/** Mark an observation as failed */
export function failObservation(id: number, error: string): void {
  const db = getDb();
  db.prepare(
    "UPDATE observations SET status = 'failed', result = ?, checked_at = unixepoch() WHERE id = ?"
  ).run(`ERROR: ${error}`, id);
  log.warn(`[observer] Observation #${id} failed: ${error}`);
}

/** Get recent observations (for context loader and reporting) */
export function getRecentObservations(limit: number = 10): Observation[] {
  ensureObservationTable();
  const db = getDb();
  return db.prepare(
    "SELECT * FROM observations ORDER BY created_at DESC LIMIT ?"
  ).all(limit) as Observation[];
}

/** Get observations by action type */
export function getObservationsByType(actionType: string, limit: number = 10): Observation[] {
  ensureObservationTable();
  const db = getDb();
  return db.prepare(
    "SELECT * FROM observations WHERE action_type = ? ORDER BY created_at DESC LIMIT ?"
  ).all(actionType, limit) as Observation[];
}

// ─── Auto-Observation Triggers ─────────────────────────────────────────────

/**
 * Predefined observation patterns.
 * Call these from skill execution to automatically schedule follow-up checks.
 */
export const autoObserve = {
  /** After posting on Moltbook: check engagement in 2h */
  moltbookPost(postId: string, content: string): number {
    return scheduleObservation(
      "moltbook_post",
      `Posted: ${content.slice(0, 100)}`,
      7_200_000, // 2h
      "moltbook.post_details",
      { post_id: postId },
      postId,
    );
  },

  /** After executing a trade: check P&L at end of day */
  trade(symbol: string, action: string, amount: number): number {
    // Check at 17h ET (market close + 1h)
    const now = new Date();
    const closeCheck = new Date();
    closeCheck.setHours(17, 0, 0, 0);
    if (closeCheck <= now) closeCheck.setDate(closeCheck.getDate() + 1);
    const delay = closeCheck.getTime() - now.getTime();
    return scheduleObservation(
      "trade",
      `${action} ${symbol} $${amount}`,
      delay,
      "trading.pnl",
      { period: "1D" },
      `${symbol}_${action}_${Date.now()}`,
    );
  },

  /** After deploying to website: verify it's live in 5min */
  deploy(url: string, description: string): number {
    return scheduleObservation(
      "deploy",
      description,
      300_000, // 5min
      "web.fetch",
      { url },
      url,
    );
  },

  /** After sending an email: check for reply in 24h */
  email(recipient: string, subject: string): number {
    return scheduleObservation(
      "email",
      `Email to ${recipient}: ${subject}`,
      86_400_000, // 24h
      "gmail.search",
      { query: `from:${recipient} newer_than:1d` },
      `email_${Date.now()}`,
    );
  },

  /** After creating a skill: test it in 1min (quick feedback) */
  skillCreated(skillName: string): number {
    return scheduleObservation(
      "skill_created",
      `Created skill: ${skillName}`,
      60_000, // 1min
      "skill.test",
      { name: skillName },
      skillName,
    );
  },

  /** After setting a goal: check progress in 4h */
  goalSet(goalTitle: string, goalId: string): number {
    return scheduleObservation(
      "goal",
      `Goal: ${goalTitle}`,
      14_400_000, // 4h
      "goal.status",
      {},
      goalId,
    );
  },

  /** Custom observation — for anything else */
  custom(actionType: string, detail: string, delayMs: number, checkSkill?: string, checkArgs?: Record<string, unknown>): number {
    return scheduleObservation(actionType, detail, delayMs, checkSkill, checkArgs);
  },
};
