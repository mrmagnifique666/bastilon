/**
 * Kingston Supervisor — Outcome Verification & Accountability
 *
 * The supervisor sits ABOVE Kingston and ensures tasks actually produce results.
 * It doesn't rely on the LLM to "decide" to do things — it checks directly.
 *
 * Three pillars:
 * 1. DIRECT EXECUTION — Tasks that don't need LLM run deterministically
 * 2. OUTCOME VERIFICATION — After LLM tasks, check if expected results exist
 * 3. ACCOUNTABILITY — Track promises, retry failures, escalate to Nicolas
 */
import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

const DB_PATH = path.resolve("relay.db");
const TZ = "America/Toronto";

// ─── Types ───

export interface SupervisorTask {
  id: string;
  name: string;
  type: "direct" | "verified" | "llm";  // direct = no LLM, verified = LLM + check, llm = LLM only
  schedule: { hour?: number; intervalMin?: number; weekdayOnly?: boolean; dayOfWeek?: number };
  /** For direct tasks: skill to call */
  skillName?: string;
  skillArgs?: Record<string, unknown>;
  /** For verified tasks: how to check if the task produced results */
  verify?: (db: Database.Database) => VerifyResult;
  /** Human-readable description */
  description: string;
  /** Is this task currently enabled? */
  enabled: boolean;
}

export interface VerifyResult {
  success: boolean;
  message: string;
}

export interface TaskRun {
  taskId: string;
  startedAt: number;
  outcome: "success" | "failed" | "no_result" | "skipped";
  duration_ms: number;
  message: string;
}

// ─── DB Setup ───

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma("journal_mode = WAL");
    ensureTables(_db);
  }
  return _db;
}

function ensureTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS supervisor_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      task_name TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      outcome TEXT NOT NULL DEFAULT 'running',
      message TEXT DEFAULT '',
      duration_ms INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS supervisor_commitments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      source TEXT NOT NULL,
      promise TEXT NOT NULL,
      deadline INTEGER,
      chat_id INTEGER,
      turn_id_at_creation INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      follow_up_count INTEGER DEFAULT 0,
      last_follow_up_at INTEGER,
      verified_tool_call INTEGER DEFAULT 0,
      verified_response INTEGER DEFAULT 0,
      resolved_at INTEGER,
      resolution TEXT
    );
    CREATE TABLE IF NOT EXISTS supervisor_quality_issues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      category TEXT NOT NULL,
      source TEXT NOT NULL,
      detail TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'warning'
    );
    CREATE INDEX IF NOT EXISTS idx_supervisor_runs_task ON supervisor_runs(task_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_supervisor_commitments_status ON supervisor_commitments(status);
    CREATE INDEX IF NOT EXISTS idx_quality_issues_created ON supervisor_quality_issues(created_at);
  `);

  // Migration: add new columns if table already exists
  try {
    const cols = db.prepare("PRAGMA table_info(supervisor_commitments)").all() as Array<{ name: string }>;
    const colNames = new Set(cols.map(c => c.name));
    if (!colNames.has("chat_id")) db.exec("ALTER TABLE supervisor_commitments ADD COLUMN chat_id INTEGER");
    if (!colNames.has("turn_id_at_creation")) db.exec("ALTER TABLE supervisor_commitments ADD COLUMN turn_id_at_creation INTEGER DEFAULT 0");
    if (!colNames.has("verified_tool_call")) db.exec("ALTER TABLE supervisor_commitments ADD COLUMN verified_tool_call INTEGER DEFAULT 0");
    if (!colNames.has("verified_response")) db.exec("ALTER TABLE supervisor_commitments ADD COLUMN verified_response INTEGER DEFAULT 0");
  } catch { /* columns may already exist */ }
}

// ─── Time Helpers ───

function nowET(): { hour: number; minute: number; dayOfWeek: number; dateStr: string } {
  const d = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    hour: "numeric",
    minute: "numeric",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);

  return {
    hour: Number(parts.find(p => p.type === "hour")!.value),
    minute: Number(parts.find(p => p.type === "minute")!.value),
    dayOfWeek: new Date(new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d)).getDay() || d.getDay(),
    dateStr: `${parts.find(p => p.type === "year")!.value}-${parts.find(p => p.type === "month")!.value}-${parts.find(p => p.type === "day")!.value}`,
  };
}

// ─── Direct Telegram Send ───

async function sendTelegram(text: string): Promise<boolean> {
  const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID || process.env.ADMIN_CHAT_ID;
  const token = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
  if (!chatId || !token) return false;

  for (const parseMode of ["Markdown", undefined] as const) {
    try {
      const body: Record<string, unknown> = { chat_id: chatId, text };
      if (parseMode) body.parse_mode = parseMode;
      const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      if (resp.ok) return true;
      if (parseMode && resp.status === 400) continue;
      return false;
    } catch {
      if (parseMode) continue;
      return false;
    }
  }
  return false;
}

// ─── Outcome Verifiers ───

/** Check if a note was created in the last N minutes */
function verifyNoteCreated(titlePattern: string, withinMinutes = 30) {
  return (db: Database.Database): VerifyResult => {
    const cutoff = Math.floor(Date.now() / 1000) - withinMinutes * 60;
    const row = db.prepare(
      "SELECT id, title FROM notes WHERE title LIKE ? AND created_at > ? ORDER BY created_at DESC LIMIT 1"
    ).get(`%${titlePattern}%`, cutoff) as { id: number; title: string } | undefined;
    return row
      ? { success: true, message: `Note trouvée: "${row.title}" (#${row.id})` }
      : { success: false, message: `Aucune note "${titlePattern}" créée depuis ${withinMinutes}min` };
  };
}

/** Check if a Telegram message was sent (via turns table) in the last N minutes */
function verifyTelegramSent(withinMinutes = 15) {
  return (db: Database.Database): VerifyResult => {
    const cutoff = Math.floor(Date.now() / 1000) - withinMinutes * 60;
    try {
      const row = db.prepare(
        "SELECT id FROM turns WHERE role = 'assistant' AND created_at > ? AND chat_id NOT BETWEEN 100 AND 300 ORDER BY created_at DESC LIMIT 1"
      ).get(cutoff) as { id: number } | undefined;
      return row
        ? { success: true, message: `Message envoyé (turn #${row.id})` }
        : { success: false, message: `Aucun message envoyé depuis ${withinMinutes}min` };
    } catch {
      return { success: false, message: "Cannot check turns table" };
    }
  };
}

/** Check if a cron job ran successfully in the last N minutes */
function verifyCronRan(jobName: string, withinMinutes = 15) {
  return (db: Database.Database): VerifyResult => {
    const cutoff = Math.floor(Date.now() / 1000) - withinMinutes * 60;
    const row = db.prepare(
      "SELECT id, outcome FROM cron_runs WHERE job_name = ? AND started_at > ? ORDER BY started_at DESC LIMIT 1"
    ).get(jobName, cutoff) as { id: number; outcome: string } | undefined;
    if (!row) return { success: false, message: `Job "${jobName}" n'a pas tourné depuis ${withinMinutes}min` };
    return row.outcome === "success" || row.outcome === "running"
      ? { success: true, message: `Job "${jobName}" OK (${row.outcome})` }
      : { success: false, message: `Job "${jobName}" failed: ${row.outcome}` };
  };
}

/** Check if an episodic event was logged */
function verifyEpisodicLogged(eventType: string, withinMinutes = 60) {
  return (db: Database.Database): VerifyResult => {
    const cutoff = Math.floor(Date.now() / 1000) - withinMinutes * 60;
    try {
      const row = db.prepare(
        "SELECT id FROM episodic_events WHERE event_type = ? AND created_at > ? LIMIT 1"
      ).get(eventType, cutoff) as { id: number } | undefined;
      return row
        ? { success: true, message: `Event "${eventType}" logged` }
        : { success: false, message: `No "${eventType}" event since ${withinMinutes}min` };
    } catch {
      return { success: false, message: `episodic_events table not accessible` };
    }
  };
}

// ─── Run Logging ───

function logRun(taskId: string, taskName: string, outcome: TaskRun["outcome"], durationMs: number, message: string): void {
  try {
    const db = getDb();
    db.prepare(
      "INSERT INTO supervisor_runs (task_id, task_name, started_at, ended_at, outcome, duration_ms, message) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(taskId, taskName, Math.floor(Date.now() / 1000) - Math.floor(durationMs / 1000), Math.floor(Date.now() / 1000), outcome, durationMs, message);
  } catch (err) {
    console.error(`[supervisor] Failed to log run: ${err}`);
  }
}

// ─── Quality Issue Logging ───

export type QualityCategory = "n/a_data" | "missing_briefing" | "missing_meme" | "tool_failure" | "incomplete_report";

/**
 * Log a quality issue — called from briefings, agents, or launcher
 * when Kingston's output is degraded (N/A, missing meme, tool unavailable, etc.)
 */
export function logQualityIssue(
  category: QualityCategory,
  source: string,
  detail: string,
  severity: "warning" | "error" = "warning"
): void {
  try {
    const db = getDb();
    db.prepare(
      "INSERT INTO supervisor_quality_issues (category, source, detail, severity) VALUES (?, ?, ?, ?)"
    ).run(category, source, detail, severity);
    console.log(`[supervisor:quality] ${severity.toUpperCase()} [${category}] ${source}: ${detail}`);
  } catch (err) {
    console.error(`[supervisor:quality] Failed to log: ${err}`);
  }
}

/**
 * Get quality issues since a given epoch timestamp.
 */
export function getQualityIssues(since: number): Array<{
  id: number; created_at: number; category: string; source: string; detail: string; severity: string;
}> {
  try {
    const db = getDb();
    return db.prepare(
      "SELECT * FROM supervisor_quality_issues WHERE created_at > ? ORDER BY created_at DESC"
    ).all(since) as any[];
  } catch {
    return [];
  }
}

/**
 * Build a quality report section for the daily supervisor report.
 * Also writes relay/QUALITY_LOG.md for Claude to read.
 */
function buildQualitySection(): string {
  const db = getDb();
  const last24h = Math.floor(Date.now() / 1000) - 86400;
  const issues = getQualityIssues(last24h);

  if (issues.length === 0) return "";

  // Group by category
  const byCategory: Record<string, typeof issues> = {};
  for (const issue of issues) {
    if (!byCategory[issue.category]) byCategory[issue.category] = [];
    byCategory[issue.category].push(issue);
  }

  const categoryLabels: Record<string, string> = {
    "n/a_data": "Données N/A",
    "missing_briefing": "Briefings manquants",
    "missing_meme": "Memes manquants",
    "tool_failure": "Outils indisponibles",
    "incomplete_report": "Rapports incomplets",
  };

  const lines: string[] = [
    ``,
    `*Problèmes de qualité (24h): ${issues.length}*`,
  ];

  for (const [cat, catIssues] of Object.entries(byCategory)) {
    const label = categoryLabels[cat] || cat;
    lines.push(`  ${label}: ${catIssues.length}`);
    for (const issue of catIssues.slice(0, 3)) {
      const time = new Date(issue.created_at * 1000).toLocaleTimeString("fr-CA", {
        timeZone: "America/Toronto", hour: "2-digit", minute: "2-digit", hour12: false,
      });
      lines.push(`    - ${time} [${issue.source}] ${issue.detail}`);
    }
    if (catIssues.length > 3) {
      lines.push(`    ... et ${catIssues.length - 3} autres`);
    }
  }

  // Write QUALITY_LOG.md for Claude to read
  writeQualityLog(issues);

  return lines.join("\n");
}

/**
 * Write relay/QUALITY_LOG.md — a persistent log for Claude's reference.
 */
function writeQualityLog(issues: Array<{ created_at: number; category: string; source: string; detail: string; severity: string }>): void {
  try {
    const logPath = path.resolve("relay", "QUALITY_LOG.md");
    const header = `# Kingston Quality Log\n\n> Auto-generated by the supervisor. Last updated: ${new Date().toISOString()}\n> ${issues.length} issues in the last 24h.\n\n`;

    const lines: string[] = [];
    for (const issue of issues) {
      const dt = new Date(issue.created_at * 1000).toLocaleString("fr-CA", { timeZone: "America/Toronto" });
      lines.push(`- **${dt}** [${issue.severity}] \`${issue.category}\` — ${issue.source}: ${issue.detail}`);
    }

    fs.writeFileSync(logPath, header + lines.join("\n") + "\n", "utf-8");
  } catch (err) {
    console.error(`[supervisor:quality] Failed to write QUALITY_LOG.md: ${err}`);
  }
}

// ─── Commitment Tracker — Aggressive Verification ───
//
// When Kingston says "je vais vérifier", the supervisor:
// 1. At +3 min: checks if there's been a tool call (new turns after promise)
// 2. At +5 min: checks if there's been a real response (not just another promise)
// 3. If neither: alerts Nicolas that Kingston didn't follow through
//

export function addCommitment(source: string, promise: string, deadlineMinutes?: number): number {
  const db = getDb();
  const deadline = deadlineMinutes
    ? Math.floor(Date.now() / 1000) + deadlineMinutes * 60
    : Math.floor(Date.now() / 1000) + 180; // 3 min default
  const info = db.prepare(
    "INSERT INTO supervisor_commitments (source, promise, deadline) VALUES (?, ?, ?)"
  ).run(source, promise, deadline);
  return Number(info.lastInsertRowid);
}

export function resolveCommitment(id: number, resolution: string): void {
  const db = getDb();
  db.prepare(
    "UPDATE supervisor_commitments SET status = 'resolved', resolved_at = unixepoch(), resolution = ? WHERE id = ?"
  ).run(resolution, id);
}

interface PendingCommitment {
  id: number;
  source: string;
  promise: string;
  deadline: number;
  chat_id: number | null;
  turn_id_at_creation: number;
  follow_up_count: number;
  verified_tool_call: number;
  verified_response: number;
  created_at: number;
}

/**
 * Core verification loop — called every 60s from the launcher.
 * Checks each pending commitment for actual follow-through.
 */
export function verifyCommitments(): string[] {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const alerts: string[] = [];

  const pending = db.prepare(
    "SELECT * FROM supervisor_commitments WHERE status = 'pending' ORDER BY created_at ASC"
  ).all() as PendingCommitment[];

  for (const c of pending) {
    const ageSec = now - c.created_at;

    // Skip very fresh commitments (< 60s old — give Kingston time to start working)
    if (ageSec < 60) continue;

    // If we have a chat_id, check for actual activity since the promise
    if (c.chat_id && c.turn_id_at_creation) {
      const newTurns = db.prepare(
        "SELECT id, role, content FROM turns WHERE chat_id = ? AND id > ? ORDER BY id ASC"
      ).all(c.chat_id, c.turn_id_at_creation) as Array<{ id: number; role: string; content: string }>;

      // Check 1: Were there any tool calls? (assistant turns containing tool-like patterns)
      const hasToolCall = newTurns.some(t =>
        t.role === "assistant" && (
          t.content.includes("tool_call") ||
          t.content.includes("(") && t.content.includes(")") && t.content.length > 50 ||
          // Gemini/Ollama tool patterns
          /\w+\.\w+\(/.test(t.content)
        )
      );

      // Check 2: Was there a substantive response? (not just another promise or short ack)
      const hasRealResponse = newTurns.some(t =>
        t.role === "assistant" &&
        t.content.length > 100 &&
        !PROMISE_REDETECT.some(p => p.test(t.content))
      );

      // Update verification flags
      if (hasToolCall && !c.verified_tool_call) {
        db.prepare("UPDATE supervisor_commitments SET verified_tool_call = 1 WHERE id = ?").run(c.id);
        c.verified_tool_call = 1;
      }
      if (hasRealResponse && !c.verified_response) {
        db.prepare("UPDATE supervisor_commitments SET verified_response = 1 WHERE id = ?").run(c.id);
        c.verified_response = 1;
      }

      // Auto-resolve if both checks pass
      if (c.verified_tool_call && c.verified_response) {
        db.prepare(
          "UPDATE supervisor_commitments SET status = 'resolved', resolved_at = ?, resolution = 'Auto-verified: tool call + response detected' WHERE id = ?"
        ).run(now, c.id);
        alerts.push(`[VERIFIED] #${c.id} "${c.promise.slice(0, 50)}" — tool call + response OK`);
        continue;
      }

      // Auto-resolve if there's a real response even without explicit tool call
      if (c.verified_response && ageSec > 300) {
        db.prepare(
          "UPDATE supervisor_commitments SET status = 'resolved', resolved_at = ?, resolution = 'Auto-verified: substantive response detected' WHERE id = ?"
        ).run(now, c.id);
        alerts.push(`[VERIFIED] #${c.id} "${c.promise.slice(0, 50)}" — response OK`);
        continue;
      }
    }

    // ─── Deadline checks ───

    if (!c.deadline || c.deadline > now) continue; // Not overdue yet

    const overdueMin = Math.round((now - c.deadline) / 60);

    // Phase 1: 3 min — check for tool call
    if (overdueMin <= 3 && !c.verified_tool_call) {
      if (c.follow_up_count === 0) {
        alerts.push(`[NO TOOL CALL] #${c.id} "${c.promise.slice(0, 60)}" — ${overdueMin}min, aucun tool call détecté`);
        db.prepare(
          "UPDATE supervisor_commitments SET follow_up_count = 1, last_follow_up_at = ? WHERE id = ?"
        ).run(now, c.id);
      }
      continue;
    }

    // Phase 2: 5 min — check for real response
    if (overdueMin <= 5 && !c.verified_response) {
      if (c.follow_up_count <= 1) {
        alerts.push(`[NO RESPONSE] #${c.id} "${c.promise.slice(0, 60)}" — ${overdueMin}min, pas de réponse réelle`);
        db.prepare(
          "UPDATE supervisor_commitments SET follow_up_count = 2, last_follow_up_at = ? WHERE id = ?"
        ).run(now, c.id);
      }
      continue;
    }

    // Phase 3: 5+ min — FAILED. Alert Nicolas.
    if (overdueMin > 5 && c.follow_up_count < 3) {
      alerts.push(`[BROKEN PROMISE] #${c.id} "${c.promise.slice(0, 60)}" — ${overdueMin}min sans action`);
      db.prepare(
        "UPDATE supervisor_commitments SET follow_up_count = 3, last_follow_up_at = ?, status = 'failed', resolution = ? WHERE id = ?"
      ).run(now, `Failed: no follow-through after ${overdueMin} min`, c.id);
    }

    // Phase 4: 15+ min — auto-expire stale commitments silently
    if (overdueMin > 15 && c.status === "pending") {
      db.prepare(
        "UPDATE supervisor_commitments SET status = 'expired', resolved_at = ?, resolution = 'Auto-expired after 15 min' WHERE id = ?"
      ).run(now, c.id);
    }
  }

  return alerts;
}

// Patterns to re-detect if a "response" is actually just another promise
const PROMISE_REDETECT = [
  /je vais (?:vérifier|checker|regarder|m'en occuper|analyser)/i,
  /je m'en (occupe|charge)/i,
  /laisse[- ]moi/i,
  /i(?:'|')ll (?:check|look into|handle)/i,
];

/** Legacy: check overdue (used by status report) */
function getCommitmentStats(): { pending: number; verified: number; failed: number; avgResponseMin: number } {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const last24h = now - 86400;

  const pending = (db.prepare(
    "SELECT COUNT(*) as c FROM supervisor_commitments WHERE status = 'pending'"
  ).get() as any).c;
  const verified = (db.prepare(
    "SELECT COUNT(*) as c FROM supervisor_commitments WHERE status = 'resolved' AND resolved_at > ?"
  ).get(last24h) as any).c;
  const failed = (db.prepare(
    "SELECT COUNT(*) as c FROM supervisor_commitments WHERE status = 'failed' AND resolved_at > ?"
  ).get(last24h) as any).c;

  // Average time to resolution
  const avgRow = db.prepare(
    "SELECT AVG(resolved_at - created_at) as avg_sec FROM supervisor_commitments WHERE status = 'resolved' AND resolved_at > ?"
  ).get(last24h) as { avg_sec: number | null };
  const avgResponseMin = avgRow.avg_sec ? Math.round(avgRow.avg_sec / 60) : 0;

  return { pending, verified, failed, avgResponseMin };
}

function getPendingCommitments(): Array<{ id: number; source: string; promise: string; deadline: number | null }> {
  const db = getDb();
  return db.prepare(
    "SELECT id, source, promise, deadline FROM supervisor_commitments WHERE status = 'pending' ORDER BY created_at DESC LIMIT 10"
  ).all() as any[];
}

// ─── Supervisor Report ───

export function buildStatusReport(): string {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const last24h = now - 86400;

  // Run stats
  const stats = db.prepare(`
    SELECT outcome, COUNT(*) as cnt
    FROM supervisor_runs WHERE started_at > ?
    GROUP BY outcome
  `).all(last24h) as Array<{ outcome: string; cnt: number }>;

  const successCount = stats.find(s => s.outcome === "success")?.cnt ?? 0;
  const failedCount = stats.find(s => s.outcome === "failed")?.cnt ?? 0;
  const noResultCount = stats.find(s => s.outcome === "no_result")?.cnt ?? 0;

  // Commitment stats
  const cStats = getCommitmentStats();

  // Recent failures
  const failures = db.prepare(
    "SELECT task_name, message FROM supervisor_runs WHERE outcome IN ('failed', 'no_result') AND started_at > ? ORDER BY started_at DESC LIMIT 5"
  ).all(last24h) as Array<{ task_name: string; message: string }>;

  // Recent broken promises
  const brokenPromises = db.prepare(
    "SELECT promise, created_at FROM supervisor_commitments WHERE status = 'failed' AND resolved_at > ? ORDER BY resolved_at DESC LIMIT 5"
  ).all(last24h) as Array<{ promise: string; created_at: number }>;

  const lines: string[] = [
    `*Kingston Supervisor Report*`,
    ``,
    `*Tâches vérifiées (24h):* ${successCount} OK, ${failedCount} failed, ${noResultCount} no result`,
    `*Promesses:* ${cStats.verified} tenues, ${cStats.failed} brisées, ${cStats.pending} en attente`,
    cStats.avgResponseMin > 0 ? `*Temps moyen de suivi:* ${cStats.avgResponseMin} min` : ``,
  ].filter(Boolean);

  if (brokenPromises.length > 0) {
    lines.push(``, `*Promesses non tenues:*`);
    for (const bp of brokenPromises) {
      lines.push(`  - "${bp.promise.slice(0, 60)}"`);
    }
  }

  if (failures.length > 0) {
    lines.push(``, `*Échecs tâches:*`);
    for (const f of failures) {
      lines.push(`  - ${f.task_name}: ${f.message.slice(0, 80)}`);
    }
  }

  // Quality issues section
  const qualitySection = buildQualitySection();
  if (qualitySection) {
    lines.push(qualitySection);
  }

  return lines.join("\n");
}

// ─── Skill Direct Execution ───

let _skillLoader: { getSkill: (name: string) => any } | null = null;

async function executeSkillDirect(skillName: string, args: Record<string, unknown> = {}): Promise<{ success: boolean; result: string }> {
  if (!_skillLoader) {
    try {
      _skillLoader = await import("../skills/loader.js");
    } catch (err) {
      return { success: false, result: `Cannot load skill system: ${err}` };
    }
  }

  const skill = _skillLoader!.getSkill(skillName);
  if (!skill) {
    return { success: false, result: `Skill "${skillName}" not found` };
  }

  try {
    const result = await skill.execute(args);
    return { success: true, result: String(result).slice(0, 500) };
  } catch (err) {
    return { success: false, result: `${err}` };
  }
}

// ─── Supervisor Tick ───

interface TickState {
  lastRun: Record<string, number>;  // taskId -> epoch of last run
  taskRuns: TaskRun[];
}

const state: TickState = {
  lastRun: {},
  taskRuns: [],
};

/**
 * Main supervisor tick — called every 5 minutes from the launcher.
 * Returns a list of actions taken for logging.
 */
export async function supervisorTick(tasks: SupervisorTask[]): Promise<string[]> {
  const { hour, minute, dayOfWeek } = nowET();
  const actions: string[] = [];
  const now = Math.floor(Date.now() / 1000);

  for (const task of tasks) {
    if (!task.enabled) continue;

    // Schedule check
    if (!shouldRun(task, hour, minute, dayOfWeek, now)) continue;

    // Mark as running
    state.lastRun[task.id] = now;
    const startTime = Date.now();

    try {
      if (task.type === "direct" && task.skillName) {
        // Direct skill execution — no LLM
        const { success, result } = await executeSkillDirect(task.skillName, task.skillArgs || {});
        const duration = Date.now() - startTime;
        const outcome = success ? "success" : "failed";
        logRun(task.id, task.name, outcome, duration, result);
        actions.push(`[DIRECT] ${task.name}: ${outcome} (${duration}ms)`);

      } else if (task.type === "verified" && task.verify) {
        // After LLM ran the task, verify the outcome
        const db = getDb();
        const result = task.verify(db);
        const duration = Date.now() - startTime;
        const outcome = result.success ? "success" : "no_result";
        logRun(task.id, task.name, outcome, duration, result.message);

        if (!result.success) {
          actions.push(`[VERIFY FAIL] ${task.name}: ${result.message}`);
        } else {
          actions.push(`[VERIFIED] ${task.name}: ${result.message}`);
        }
      }
    } catch (err) {
      const duration = Date.now() - startTime;
      logRun(task.id, task.name, "failed", duration, String(err));
      actions.push(`[ERROR] ${task.name}: ${err}`);
    }
  }

  // NOTE: Commitment verification is handled separately by the launcher (every 60s).
  // The supervisorTick only handles task-level verification (every 5 min).

  return actions;
}

function shouldRun(task: SupervisorTask, hour: number, minute: number, dayOfWeek: number, now: number): boolean {
  const sched = task.schedule;

  // Weekday filter
  if (sched.weekdayOnly && (dayOfWeek === 0 || dayOfWeek === 6)) return false;
  // Specific day filter
  if (sched.dayOfWeek !== undefined && dayOfWeek !== sched.dayOfWeek) return false;

  // Hour-based (daily tasks)
  if (sched.hour !== undefined) {
    if (hour !== sched.hour) return false;
    // Only run once per hour
    const lastRun = state.lastRun[task.id] || 0;
    const lastRunHour = new Date(lastRun * 1000).getHours();
    if (lastRun > 0 && now - lastRun < 3600) return false;
    return true;
  }

  // Interval-based
  if (sched.intervalMin !== undefined) {
    const lastRun = state.lastRun[task.id] || 0;
    const elapsed = (now - lastRun) / 60;
    return elapsed >= sched.intervalMin;
  }

  return false;
}

// ─── Task Definitions ───

/**
 * Build the supervisor task manifest.
 * These define WHAT the supervisor monitors and HOW it verifies outcomes.
 */
export function buildTaskManifest(): SupervisorTask[] {
  return [
    // ─── Cron Verification (these run inside Kingston via cron engine — supervisor checks they ran) ───
    {
      id: "sv_verify_crypto",
      name: "Crypto Trading Cron",
      type: "verified",
      schedule: { intervalMin: 15 },  // Verify every 15 min that 5-min cron ran
      verify: verifyCronRan("crypto_autonomous_trader", 15),
      description: "Verify crypto auto-trader cron is running",
      enabled: true,
    },
    {
      id: "sv_verify_stocks",
      name: "Stocks Trading Cron",
      type: "verified",
      schedule: { intervalMin: 15 },
      verify: verifyCronRan("stocks_autonomous_trader", 15),
      description: "Verify stocks auto-trader cron is running",
      enabled: true,
    },
    {
      id: "sv_verify_watchdog",
      name: "Watchdog Cron",
      type: "verified",
      schedule: { intervalMin: 60 },
      verify: verifyCronRan("kingston_watchdog", 60),
      description: "Verify health watchdog cron is running",
      enabled: true,
    },

    // ─── LLM Task Outcome Verification (scheduler fires LLM tasks — supervisor checks results) ───
    {
      id: "sv_verify_premarket",
      name: "Pre-market Research",
      type: "verified",
      schedule: { hour: 8, weekdayOnly: true },  // Check at 8h if 7h premarket ran
      verify: verifyNoteCreated("Premarket Research", 120),
      description: "Verify pre-market research note was created",
      enabled: true,
    },
    {
      id: "sv_verify_evening_journal",
      name: "Evening Journal",
      type: "verified",
      schedule: { hour: 18, weekdayOnly: true },  // Check at 18h if 17h journal ran
      verify: verifyEpisodicLogged("trading_journal", 120),
      description: "Verify evening trading journal was logged",
      enabled: true,
    },
    {
      id: "sv_verify_moltbook_ideas",
      name: "Moltbook Ideation",
      type: "verified",
      schedule: { hour: 8 },  // Check at 8h if 7h ideation ran
      verify: verifyNoteCreated("Moltbook Ideas", 120),
      description: "Verify Moltbook ideation notes were created",
      enabled: true,
    },
    {
      id: "sv_verify_weekly_retro",
      name: "Weekly Retro",
      type: "verified",
      schedule: { hour: 19, dayOfWeek: 5 },  // Friday 19h, check if 18h retro ran
      verify: verifyEpisodicLogged("trading_weekly_retro", 120),
      description: "Verify weekly trading retrospective was logged",
      enabled: true,
    },

    // ─── Supervisor Report ───
    {
      id: "sv_daily_report",
      name: "Supervisor Daily Report",
      type: "direct",
      schedule: { hour: 21 },  // 21h daily report
      skillName: "__supervisor_report__",  // Special: handled internally
      description: "Send daily supervisor accountability report to Nicolas",
      enabled: true,
    },
  ];
}

/**
 * Initialize the supervisor — called once at startup.
 */
export function initSupervisor(): void {
  getDb(); // Ensure tables exist
  console.log(`[supervisor] Initialized — ${buildTaskManifest().filter(t => t.enabled).length} tasks configured`);
}

/**
 * Run a full supervisor cycle. Called from wrapper.ts every 5 minutes.
 */
export async function runSupervisorCycle(): Promise<string[]> {
  const tasks = buildTaskManifest();
  const actions: string[] = [];

  // Handle the special supervisor report task
  const reportTask = tasks.find(t => t.id === "sv_daily_report");
  if (reportTask) {
    const { hour } = nowET();
    const now = Math.floor(Date.now() / 1000);
    if (shouldRun(reportTask, hour, 0, new Date().getDay(), now)) {
      state.lastRun[reportTask.id] = now;
      const report = buildStatusReport();
      const sent = await sendTelegram(report);
      actions.push(`[REPORT] Daily supervisor report ${sent ? "sent" : "FAILED"}`);
    }
  }

  // Run all other tasks
  const otherTasks = tasks.filter(t => t.id !== "sv_daily_report");
  const taskActions = await supervisorTick(otherTasks);
  actions.push(...taskActions);

  return actions;
}
