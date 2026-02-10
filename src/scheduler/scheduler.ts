/**
 * Scheduler — tick loop (60s) that fires timed events and custom reminders.
 * Uses handleMessage() so Claude generates natural briefings.
 * Timezone: America/Toronto via Intl.DateTimeFormat.
 */
import fs from "node:fs";
import path from "node:path";
import { getDb } from "../storage/store.js";
import { handleMessage } from "../orchestrator/router.js";
import { log } from "../utils/log.js";

const TICK_MS = 60_000;
const TZ = "America/Toronto";

interface ScheduledEvent {
  key: string;
  type: "daily" | "interval";
  /** For daily: hour (0-23) to fire */
  hour?: number;
  /** For interval: interval in minutes */
  intervalMin?: number;
  /** Prompt sent to handleMessage, or null for silent events */
  prompt: string | null;
}

const EVENTS: ScheduledEvent[] = [
  {
    key: "morning_briefing",
    type: "daily",
    hour: 7,
    prompt: null, // dynamic — built at fire time with overnight agent data
  },
  {
    key: "evening_checkin",
    type: "daily",
    hour: 20,
    prompt:
      "[SCHEDULER] Check-in du soir. Fais un bilan rapide de la journée : ce qui a été fait, rappels manqués, et souhaite une bonne soirée.",
  },
  {
    key: "code_digest_morning",
    type: "daily",
    hour: 9,
    prompt: null, // dynamic — built at fire time
  },
  {
    key: "code_digest_evening",
    type: "daily",
    hour: 21,
    prompt: null, // dynamic — built at fire time
  },
  {
    key: "heartbeat",
    type: "interval",
    intervalMin: 30,
    prompt: null, // dynamic — proactive checks at fire time
  },
  {
    key: "moltbook_digest",
    type: "daily",
    hour: 15,
    prompt: null, // dynamic — built at fire time
  },
];

const CODE_REQUESTS_FILE = path.join(process.cwd(), "code-requests.json");

function buildCodeDigestPrompt(): string | null {
  try {
    if (!fs.existsSync(CODE_REQUESTS_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(CODE_REQUESTS_FILE, "utf-8")) as any[];
    const pending = data.filter(
      (r) => r.status === "pending" || r.status === "awaiting_execution"
    );
    if (pending.length === 0) return null;

    const summary = pending
      .map((r, i) => {
        const taskPreview = r.task.length > 150 ? r.task.slice(0, 150) + "..." : r.task;
        return `${i + 1}. [${r.priority}] ${taskPreview}`;
      })
      .join("\n");

    return (
      `[SCHEDULER] Code Request Digest — ${pending.length} demande(s) en attente.\n\n` +
      `${summary}\n\n` +
      `Présente ce digest à Nicolas de façon concise. Pour chaque demande, donne ton avis : ` +
      `utile/redondant/déjà fait/trop ambitieux. Demande-lui lesquelles exécuter. ` +
      `Utilise telegram.send pour envoyer le résumé.`
    );
  } catch (err) {
    log.error(`[scheduler] Error building code digest: ${err}`);
    return null;
  }
}

/**
 * Build morning briefing with overnight agent activity report.
 * Queries agent_runs table for runs since last evening (20h previous day).
 */
function buildMorningBriefingPrompt(): string {
  let agentSummary = "";
  try {
    const db = getDb();
    // Get runs from the last 12 hours (overnight)
    const cutoff = Math.floor(Date.now() / 1000) - 12 * 3600;
    const runs = db
      .prepare(
        `SELECT agent_id, cycle, outcome, duration_ms, error_msg, started_at
         FROM agent_runs WHERE started_at > ? ORDER BY started_at ASC`
      )
      .all(cutoff) as Array<{
        agent_id: string;
        cycle: number;
        outcome: string;
        duration_ms: number;
        error_msg: string | null;
        started_at: number;
      }>;

    if (runs.length > 0) {
      const byAgent: Record<string, { success: number; error: number; rateLimit: number; totalMs: number }> = {};
      for (const r of runs) {
        if (!byAgent[r.agent_id]) byAgent[r.agent_id] = { success: 0, error: 0, rateLimit: 0, totalMs: 0 };
        const a = byAgent[r.agent_id];
        if (r.outcome === "success") a.success++;
        else if (r.outcome === "rate_limit") a.rateLimit++;
        else a.error++;
        a.totalMs += r.duration_ms;
      }

      const lines: string[] = [];
      for (const [id, stats] of Object.entries(byAgent)) {
        lines.push(
          `- **${id}**: ${stats.success} succès, ${stats.error} erreurs, ${stats.rateLimit} rate limits, ${Math.round(stats.totalMs / 1000)}s total`
        );
      }
      agentSummary = `\n\n**Activité agents (dernières 12h):**\n${lines.join("\n")}`;
    }

    // Get current agent states
    const states = db
      .prepare("SELECT agent_id, cycle, total_runs, consecutive_errors FROM agent_state")
      .all() as Array<{ agent_id: string; cycle: number; total_runs: number; consecutive_errors: number }>;

    if (states.length > 0) {
      const stateLines = states.map(
        (s) => `- ${s.agent_id}: cycle ${s.cycle}, ${s.total_runs} runs total, ${s.consecutive_errors} erreurs consécutives`
      );
      agentSummary += `\n\n**État actuel agents:**\n${stateLines.join("\n")}`;
    }
  } catch (err) {
    log.debug(`[scheduler] Failed to build agent summary: ${err}`);
  }

  return (
    `[SCHEDULER] Briefing matinal (7h). Donne un résumé de la journée à Nicolas :\n` +
    `1. Rappels en attente (utilise scheduler.list)\n` +
    `2. Notes récentes (utilise notes.list)\n` +
    `3. Rapport des agents de la nuit ci-dessous\n` +
    `4. Un mot d'encouragement\n` +
    `${agentSummary}\n\n` +
    `Compile tout ça en un message concis et envoie via telegram.send. ` +
    `Mentionne les succès et problèmes des agents. Sois positif mais honnête.`
  );
}

/**
 * Build Moltbook digest — check trending posts and suggest engagement.
 */
function buildMoltbookDigestPrompt(): string {
  return (
    `[SCHEDULER] Moltbook daily digest. ` +
    `Utilise moltbook.feed avec sort=hot et limit=5 pour voir les posts tendance. ` +
    `Puis envoie un résumé concis à Nicolas via telegram.send avec les 3-5 posts les plus intéressants. ` +
    `Si tu vois un post pertinent pour Kingston ou Nicolas, mentionne pourquoi. ` +
    `Garde le message court et informatif.`
  );
}

/**
 * Proactive heartbeat — checks for unread emails and upcoming calendar events.
 * Returns a prompt for Claude if there's something worth notifying, null otherwise.
 */
async function buildHeartbeatPrompt(): Promise<string | null> {
  const alerts: string[] = [];

  // Check unread emails (last 30 minutes)
  try {
    const { getGmailClient } = await import("../gmail/auth.js");
    const gmail = getGmailClient();
    const res = await gmail.users.messages.list({
      userId: "me",
      q: "is:unread newer_than:30m",
      maxResults: 5,
    });
    const messages = res.data.messages;
    if (messages && messages.length > 0) {
      const details: string[] = [];
      for (const msg of messages.slice(0, 3)) {
        const detail = await gmail.users.messages.get({
          userId: "me",
          id: msg.id!,
          format: "metadata",
          metadataHeaders: ["From", "Subject"],
        });
        const headers = detail.data.payload?.headers || [];
        const from = headers.find((h: any) => h.name === "From")?.value || "?";
        const subject = headers.find((h: any) => h.name === "Subject")?.value || "(no subject)";
        details.push(`- ${from}: ${subject}`);
      }
      const extra = messages.length > 3 ? ` (+${messages.length - 3} more)` : "";
      alerts.push(`**Emails non lus (${messages.length}):**${extra}\n${details.join("\n")}`);
    }
  } catch (err) {
    log.debug(`[heartbeat] Gmail check failed: ${err instanceof Error ? err.message : err}`);
  }

  // Check upcoming calendar events (next 30 minutes)
  try {
    const { getCalendarClient } = await import("../gmail/auth.js");
    const calendar = getCalendarClient();
    const now = new Date();
    const in30min = new Date(now.getTime() + 30 * 60_000);
    const res = await calendar.events.list({
      calendarId: "primary",
      timeMin: now.toISOString(),
      timeMax: in30min.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
      timeZone: TZ,
    });
    const events = res.data.items;
    if (events && events.length > 0) {
      const details = events.map((e: any) => {
        const start = e.start?.dateTime
          ? new Date(e.start.dateTime).toLocaleTimeString("fr-CA", { timeZone: TZ, timeStyle: "short" })
          : "all-day";
        return `- ${start}: ${e.summary || "(sans titre)"}`;
      });
      alerts.push(`**Events dans les 30 prochaines minutes:**\n${details.join("\n")}`);
    }
  } catch (err) {
    log.debug(`[heartbeat] Calendar check failed: ${err instanceof Error ? err.message : err}`);
  }

  // Check pending code requests
  try {
    if (fs.existsSync(CODE_REQUESTS_FILE)) {
      const data = JSON.parse(fs.readFileSync(CODE_REQUESTS_FILE, "utf-8")) as any[];
      const pending = data.filter(
        (r) => r.status === "pending" || r.status === "awaiting_execution"
      );
      if (pending.length > 0) {
        alerts.push(`**Code requests en attente (${pending.length}):**\n${pending.map((r) => `- [${r.priority}] ${r.task.slice(0, 80)}...`).join("\n")}`);
      }
    }
  } catch (err) {
    log.debug(`[heartbeat] Code requests check failed: ${err instanceof Error ? err.message : err}`);
  }

  if (alerts.length === 0) return null;

  return (
    `[SCHEDULER] Heartbeat proactif — notifications:\n\n${alerts.join("\n\n")}\n\n` +
    `Notifie Nicolas de ces éléments de façon concise via telegram.send. ` +
    `Pour les emails, mentionne l'expéditeur et le sujet. Pour le calendrier, mentionne l'heure et le titre. ` +
    `Pour les code requests, mentionne le nombre et la priorité.`
  );
}

let timer: ReturnType<typeof setInterval> | null = null;
let schedulerChatId = 0;
let schedulerUserId = 0;

// Heartbeat restraint: track consecutive silent heartbeats
let consecutiveSilentHeartbeats = 0;
const SILENCE_STREAK_THRESHOLD = 10; // ~5 hours of stability
let silenceStreakNotified = false;


function ensureTables(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduler_runs (
      event_key TEXT PRIMARY KEY,
      last_run_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS scheduler_reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fire_at INTEGER NOT NULL,
      message TEXT NOT NULL,
      fired INTEGER NOT NULL DEFAULT 0
    );
  `);
}

function nowInTz(): { hour: number; dateStr: string } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    hour: "numeric",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(new Date());
  const hour = Number(parts.find((p) => p.type === "hour")!.value);
  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  const d = parts.find((p) => p.type === "day")!.value;
  return { hour, dateStr: `${y}-${m}-${d}` };
}

function getLastRun(key: string): number {
  const db = getDb();
  const row = db
    .prepare("SELECT last_run_at FROM scheduler_runs WHERE event_key = ?")
    .get(key) as { last_run_at: number } | undefined;
  return row?.last_run_at ?? 0;
}

function setLastRun(key: string, epoch: number): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO scheduler_runs (event_key, last_run_at) VALUES (?, ?)
     ON CONFLICT(event_key) DO UPDATE SET last_run_at = excluded.last_run_at`
  ).run(key, epoch);
}

async function fireEvent(event: ScheduledEvent): Promise<void> {
  const nowEpoch = Math.floor(Date.now() / 1000);
  setLastRun(event.key, nowEpoch);

  // Morning briefing with overnight agent report
  if (event.key === "morning_briefing") {
    log.info(`[scheduler] Firing morning briefing with overnight agent report`);
    try {
      const prompt = buildMorningBriefingPrompt();
      await handleMessage(schedulerChatId, prompt, schedulerUserId, "scheduler");
    } catch (err) {
      log.error(`[scheduler] Morning briefing error: ${err}`);
    }
    return;
  }

  // Moltbook daily digest
  if (event.key === "moltbook_digest") {
    log.info(`[scheduler] Firing Moltbook daily digest`);
    try {
      const prompt = buildMoltbookDigestPrompt();
      await handleMessage(schedulerChatId, prompt, schedulerUserId, "scheduler");
    } catch (err) {
      log.error(`[scheduler] Moltbook digest error: ${err}`);
    }
    return;
  }

  // Dynamic digest events — build prompt at fire time
  if (event.key.startsWith("code_digest_")) {
    const digestPrompt = buildCodeDigestPrompt();
    if (!digestPrompt) {
      log.info(`[scheduler] ${event.key}: no pending code requests — skipping`);
      return;
    }
    log.info(`[scheduler] Firing code digest: ${event.key}`);
    try {
      await handleMessage(schedulerChatId, digestPrompt, schedulerUserId, "scheduler");
    } catch (err) {
      log.error(`[scheduler] Error firing ${event.key}: ${err}`);
    }
    return;
  }

  // Proactive heartbeat — check emails + calendar (with restraint)
  if (event.key === "heartbeat") {
    log.debug(`[scheduler] Heartbeat tick — checking proactive alerts (silent streak: ${consecutiveSilentHeartbeats})`);
    try {
      const heartbeatPrompt = await buildHeartbeatPrompt();
      if (heartbeatPrompt) {
        // Something to report — reset silence streak
        consecutiveSilentHeartbeats = 0;
        silenceStreakNotified = false;
        log.info(`[scheduler] Heartbeat found alerts — notifying`);
        await handleMessage(schedulerChatId, heartbeatPrompt, schedulerUserId, "scheduler");
      } else {
        // Nothing to report — increment silence streak
        consecutiveSilentHeartbeats++;
        log.debug(`[scheduler] Heartbeat — nothing to report (streak: ${consecutiveSilentHeartbeats})`);

        // After 10 consecutive silent heartbeats (~5h), surface stability message once
        if (consecutiveSilentHeartbeats >= SILENCE_STREAK_THRESHOLD && !silenceStreakNotified) {
          silenceStreakNotified = true;
          const hours = Math.round((consecutiveSilentHeartbeats * 30) / 60);
          const stabilityMsg =
            `[SCHEDULER] Stability report: tout est stable depuis ~${hours}h. ` +
            `${consecutiveSilentHeartbeats} heartbeats consécutifs sans alertes. ` +
            `Envoie un bref message de stabilité à Nicolas via telegram.send — pas d'urgence, juste un signal de confiance.`;
          await handleMessage(schedulerChatId, stabilityMsg, schedulerUserId, "scheduler");
        }
      }
    } catch (err) {
      log.error(`[scheduler] Heartbeat error: ${err}`);
    }
    return;
  }

  if (event.prompt) {
    log.info(`[scheduler] Firing ${event.type} event: ${event.key}`);
    try {
      await handleMessage(schedulerChatId, event.prompt, schedulerUserId, "scheduler");
    } catch (err) {
      log.error(`[scheduler] Error firing ${event.key}: ${err}`);
    }
  }
}

async function tick(): Promise<void> {
  const nowEpoch = Math.floor(Date.now() / 1000);
  const { hour, dateStr } = nowInTz();

  for (const event of EVENTS) {
    const lastRun = getLastRun(event.key);

    if (event.type === "daily" && event.hour !== undefined) {
      // Fire if current hour matches and we haven't fired today
      const lastDate = lastRun
        ? new Intl.DateTimeFormat("en-CA", {
            timeZone: TZ,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          }).format(new Date(lastRun * 1000))
        : "";
      if (hour === event.hour && lastDate !== dateStr) {
        await fireEvent(event);
      }
    } else if (event.type === "interval" && event.intervalMin !== undefined) {
      // Fire if enough time has elapsed since last run
      const elapsedMin = (nowEpoch - lastRun) / 60;
      if (elapsedMin >= event.intervalMin) {
        await fireEvent(event);
      }
    }
  }

  // Check custom reminders
  const db = getDb();
  const dueReminders = db
    .prepare(
      "SELECT id, message FROM scheduler_reminders WHERE fire_at <= ? AND fired = 0"
    )
    .all(nowEpoch) as { id: number; message: string }[];

  for (const rem of dueReminders) {
    log.info(`[scheduler] Firing reminder #${rem.id}`);
    db.prepare("UPDATE scheduler_reminders SET fired = 1 WHERE id = ?").run(
      rem.id
    );
    try {
      const prompt = `[SCHEDULER] Rappel: ${rem.message}`;
      await handleMessage(schedulerChatId, prompt, schedulerUserId, "scheduler");
    } catch (err) {
      log.error(`[scheduler] Error firing reminder #${rem.id}: ${err}`);
    }
  }
}

// --- Public API ---

export function startScheduler(chatId: number, userId: number): void {
  if (!chatId || !userId) {
    log.warn(
      "[scheduler] Missing chatId or userId — scheduler disabled. Set VOICE_CHAT_ID and VOICE_USER_ID."
    );
    return;
  }

  ensureTables();
  schedulerChatId = chatId;
  schedulerUserId = userId;

  // Run first tick after a short delay (let bot finish starting)
  setTimeout(() => tick().catch((e) => log.error(`[scheduler] tick error: ${e}`)), 5_000);

  timer = setInterval(
    () => tick().catch((e) => log.error(`[scheduler] tick error: ${e}`)),
    TICK_MS
  );

  log.info(`[scheduler] Started (chatId=${chatId}, userId=${userId}, tick=${TICK_MS}ms)`);
}

export function stopScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    log.info("[scheduler] Stopped");
  }
}

export function addReminder(fireAt: number, message: string): number {
  const db = getDb();
  ensureTables();
  const info = db
    .prepare("INSERT INTO scheduler_reminders (fire_at, message) VALUES (?, ?)")
    .run(fireAt, message);
  log.info(
    `[scheduler] Added reminder #${info.lastInsertRowid} for ${new Date(fireAt * 1000).toISOString()}`
  );
  return Number(info.lastInsertRowid);
}

export function listReminders(): {
  id: number;
  fire_at: number;
  message: string;
  fired: number;
}[] {
  const db = getDb();
  ensureTables();
  return db
    .prepare(
      "SELECT id, fire_at, message, fired FROM scheduler_reminders WHERE fired = 0 ORDER BY fire_at ASC"
    )
    .all() as { id: number; fire_at: number; message: string; fired: number }[];
}

export function cancelReminder(id: number): boolean {
  const db = getDb();
  ensureTables();
  const info = db
    .prepare("DELETE FROM scheduler_reminders WHERE id = ? AND fired = 0")
    .run(id);
  return info.changes > 0;
}
