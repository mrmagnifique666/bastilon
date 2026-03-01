/**
 * Cron engine — OpenClaw-style scheduled jobs with isolated sessions.
 * Supports: one-shot (at), recurring (every), cron expressions (cron via croner).
 * Jobs run in isolated chatIds (200-249) or queue to main session.
 */
import crypto from "node:crypto";
import { Cron } from "croner";
import { getDb } from "../storage/store.js";
import { clearTurns, clearSession } from "../storage/store.js";
import { handleMessage } from "../orchestrator/router.js";
import { enqueueAdminAsync } from "../bot/chatLock.js";
import { config } from "../config/env.js";
import { log } from "../utils/log.js";

// --- Types ---

export type ScheduleType = "at" | "every" | "cron";
export type SessionTarget = "main" | "isolated";
export type DeliveryMode = "announce" | "none";

export interface CronJob {
  id: string;
  name: string;
  schedule_type: ScheduleType;
  schedule_value: string; // ISO8601 (at) | ms string (every) | cron expr (cron)
  timezone: string;
  prompt: string;
  session_target: SessionTarget;
  delivery_mode: DeliveryMode;
  model_override: string | null;
  skill_name: string | null;  // Direct skill execution (bypasses LLM)
  skill_args: string | null;  // JSON args for skill
  enabled: number;
  retry_count: number;
  max_retries: number;
  last_run_at: number | null;
  next_run_at: number | null;
  created_at: number;
  updated_at: number;
}

// --- Main session event queue (for session_target=main jobs) ---

interface QueuedEvent {
  jobId: string;
  jobName: string;
  prompt: string;
}

const mainSessionQueue: QueuedEvent[] = [];

export function queueMainSessionEvent(jobId: string, jobName: string, prompt: string): void {
  mainSessionQueue.push({ jobId, jobName, prompt });
  log.debug(`[cron] Queued main-session event for job "${jobName}" (${jobId})`);
}

export function drainMainSessionQueue(): QueuedEvent[] {
  const events = mainSessionQueue.splice(0, mainSessionQueue.length);
  return events;
}

// --- CRUD ---

export function addCronJob(params: {
  name: string;
  scheduleType: ScheduleType;
  scheduleValue: string;
  prompt: string;
  sessionTarget?: SessionTarget;
  deliveryMode?: DeliveryMode;
  modelOverride?: string | null;
  timezone?: string;
}): CronJob {
  const db = getDb();
  const id = crypto.randomUUID().slice(0, 8);
  const tz = params.timezone || "America/Toronto";
  const sessionTarget = params.sessionTarget || "isolated";
  const deliveryMode = params.deliveryMode || "announce";
  const maxRetries = config.cronMaxRetries || 3;

  // Compute first fire time
  const nextRun = computeNextRun(params.scheduleType, params.scheduleValue, tz);

  db.prepare(
    `INSERT INTO cron_jobs (id, name, schedule_type, schedule_value, timezone, prompt,
     session_target, delivery_mode, model_override, max_retries, next_run_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, params.name, params.scheduleType, params.scheduleValue, tz,
    params.prompt, sessionTarget, deliveryMode,
    params.modelOverride || null, maxRetries,
    nextRun ? Math.floor(nextRun / 1000) : null
  );

  log.info(`[cron] Created job "${params.name}" (${id}) — ${params.scheduleType}:${params.scheduleValue}, next=${nextRun ? new Date(nextRun).toISOString() : "immediate"}`);

  return getCronJob(id)!;
}

export function listCronJobs(): CronJob[] {
  const db = getDb();
  return db.prepare("SELECT * FROM cron_jobs ORDER BY created_at DESC").all() as CronJob[];
}

export function getCronJob(id: string): CronJob | null {
  const db = getDb();
  return (db.prepare("SELECT * FROM cron_jobs WHERE id = ?").get(id) as CronJob) || null;
}

export function removeCronJob(id: string): boolean {
  const db = getDb();
  const info = db.prepare("DELETE FROM cron_jobs WHERE id = ?").run(id);
  if (info.changes > 0) log.info(`[cron] Removed job ${id}`);
  return info.changes > 0;
}

export function pauseCronJob(id: string): boolean {
  const db = getDb();
  const info = db.prepare(
    "UPDATE cron_jobs SET enabled = 0, updated_at = unixepoch() WHERE id = ?"
  ).run(id);
  if (info.changes > 0) log.info(`[cron] Paused job ${id}`);
  return info.changes > 0;
}

export function resumeCronJob(id: string): boolean {
  const db = getDb();
  const job = getCronJob(id);
  if (!job) return false;

  // Reset retry count and recompute next run
  const nextRun = computeNextRun(job.schedule_type as ScheduleType, job.schedule_value, job.timezone);
  db.prepare(
    "UPDATE cron_jobs SET enabled = 1, retry_count = 0, next_run_at = ?, updated_at = unixepoch() WHERE id = ?"
  ).run(nextRun ? Math.floor(nextRun / 1000) : null, id);

  log.info(`[cron] Resumed job ${id}`);
  return true;
}

// --- Cron runs tracking ---

let _cronRunsTableReady = false;

function ensureCronRunsTable(): void {
  if (_cronRunsTableReady) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS cron_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      job_name TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      outcome TEXT NOT NULL DEFAULT 'running',
      error_msg TEXT,
      duration_ms INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_cron_runs_job ON cron_runs(job_id, started_at DESC);
  `);
  _cronRunsTableReady = true;
}

const STALE_THRESHOLD_MS = 2 * 3600_000; // 2 hours

export function detectStaleRuns(): number {
  const db = getDb();
  ensureCronRunsTable();
  const cutoff = Math.floor((Date.now() - STALE_THRESHOLD_MS) / 1000);

  // Find runs that started > 2h ago and never completed
  const stale = db.prepare(
    "SELECT id, job_id, job_name, started_at FROM cron_runs WHERE outcome = 'running' AND started_at < ?"
  ).all(cutoff) as Array<{ id: number; job_id: string; job_name: string; started_at: number }>;

  for (const run of stale) {
    db.prepare(
      "UPDATE cron_runs SET outcome = 'stale', completed_at = ? WHERE id = ?"
    ).run(Math.floor(Date.now() / 1000), run.id);
    log.warn(`[cron] Stale run detected: job "${run.job_name}" (${run.job_id}) started ${Math.round((Date.now() / 1000 - run.started_at) / 3600)}h ago — marking stale`);
  }

  return stale.length;
}

export function getCronHealth(): {
  totalJobs: number;
  enabledJobs: number;
  recentRuns: number;
  recentErrors: number;
  staleRuns: number;
  topFailingJobs: Array<{ name: string; errors: number }>;
} {
  const db = getDb();
  ensureCronRunsTable();

  const totalJobs = (db.prepare("SELECT COUNT(*) as c FROM cron_jobs").get() as { c: number }).c;
  const enabledJobs = (db.prepare("SELECT COUNT(*) as c FROM cron_jobs WHERE enabled = 1").get() as { c: number }).c;

  const cutoff24h = Math.floor(Date.now() / 1000) - 86400;
  const recentRuns = (db.prepare("SELECT COUNT(*) as c FROM cron_runs WHERE started_at > ?").get(cutoff24h) as { c: number }).c;
  const recentErrors = (db.prepare("SELECT COUNT(*) as c FROM cron_runs WHERE started_at > ? AND outcome IN ('error', 'stale')").get(cutoff24h) as { c: number }).c;
  const staleRuns = (db.prepare("SELECT COUNT(*) as c FROM cron_runs WHERE outcome = 'stale'").get() as { c: number }).c;

  const topFailingJobs = db.prepare(
    `SELECT job_name as name, COUNT(*) as errors FROM cron_runs
     WHERE outcome IN ('error', 'stale') AND started_at > ?
     GROUP BY job_id ORDER BY errors DESC LIMIT 5`
  ).all(cutoff24h) as Array<{ name: string; errors: number }>;

  return { totalJobs, enabledJobs, recentRuns, recentErrors, staleRuns, topFailingJobs };
}

// --- Next run computation ---

function computeNextRun(type: ScheduleType, value: string, timezone: string): number | null {
  const now = Date.now();

  switch (type) {
    case "at": {
      // ISO8601 datetime — one-shot
      const fireAt = new Date(value).getTime();
      return fireAt > now ? fireAt : null;
    }
    case "every": {
      // Interval in milliseconds
      const ms = Number(value);
      if (isNaN(ms) || ms < 60_000) {
        log.warn(`[cron] Invalid interval: ${value}ms (min 60s)`);
        return null;
      }
      return now + ms;
    }
    case "cron": {
      // 5-field cron expression via croner
      try {
        const job = new Cron(value, { timezone });
        const next = job.nextRun();
        return next ? next.getTime() : null;
      } catch (err) {
        log.error(`[cron] Invalid cron expression "${value}": ${err}`);
        return null;
      }
    }
    default:
      return null;
  }
}

// --- Cron tick (called from scheduler every 60s) ---

export async function cronTick(chatId: number, userId: number): Promise<void> {
  const db = getDb();

  // Ensure tracking table exists (idempotent, runs once)
  ensureCronRunsTable();

  // Detect and mark stale runs from previous ticks
  detectStaleRuns();

  const nowEpoch = Math.floor(Date.now() / 1000);

  // Auto-fix: if any enabled job has NULL next_run_at, compute it now
  // This prevents jobs from being silently stuck forever (e.g. manual DB inserts)
  const orphanJobs = db.prepare(
    "SELECT * FROM cron_jobs WHERE enabled = 1 AND next_run_at IS NULL"
  ).all() as CronJob[];
  for (const orphan of orphanJobs) {
    const nextRun = computeNextRun(orphan.schedule_type as ScheduleType, orphan.schedule_value, orphan.timezone || "America/Toronto");
    if (nextRun) {
      db.prepare("UPDATE cron_jobs SET next_run_at = ? WHERE id = ?").run(Math.floor(nextRun / 1000), orphan.id);
      log.warn(`[cron] Auto-fixed NULL next_run_at for "${orphan.name}" (${orphan.id}) → ${new Date(nextRun).toISOString()}`);
    }
  }

  const dueJobs = db.prepare(
    "SELECT * FROM cron_jobs WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?"
  ).all(nowEpoch) as CronJob[];

  if (dueJobs.length === 0) return;

  log.info(`[cron] ${dueJobs.length} job(s) due`);

  for (const job of dueJobs) {
    // Guard: skip jobs with missing id (prevents NOT NULL constraint crash)
    if (!job.id) {
      log.error(`[cron] Skipping job "${job.name}" — missing id`);
      continue;
    }

    // FIX #1: Anti-double-run lock — skip if this job already has a 'running' entry
    const alreadyRunning = db.prepare(
      "SELECT COUNT(*) as c FROM cron_runs WHERE job_id = ? AND outcome = 'running'"
    ).get(job.id) as { c: number };
    if (alreadyRunning.c > 0) {
      log.warn(`[cron] Skipping job "${job.name}" (${job.id}) — already running`);
      continue;
    }

    // FIX #1b: Update next_run_at BEFORE execution to prevent re-selection on next tick
    updateAfterRun(job);

    // Insert tracking row
    const startTime = Date.now();
    const runId = db.prepare(
      "INSERT INTO cron_runs (job_id, job_name, started_at, outcome) VALUES (?, ?, ?, 'running')"
    ).run(job.id, job.name, Math.floor(startTime / 1000)).lastInsertRowid;

    try {
      if (job.session_target === "main") {
        // Queue for next heartbeat (context-aware)
        queueMainSessionEvent(job.id, job.name, job.prompt);
      } else {
        // Execute in isolated session
        await executeIsolatedJob(job, userId);
      }

      // Mark run as success
      const durationMs = Date.now() - startTime;
      db.prepare(
        "UPDATE cron_runs SET outcome = 'success', completed_at = ?, duration_ms = ? WHERE id = ?"
      ).run(Math.floor(Date.now() / 1000), durationMs, runId);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const durationMs = Date.now() - startTime;

      // Mark run as error
      db.prepare(
        "UPDATE cron_runs SET outcome = 'error', completed_at = ?, error_msg = ?, duration_ms = ? WHERE id = ?"
      ).run(Math.floor(Date.now() / 1000), errMsg, durationMs, runId);

      log.error(`[cron] Job "${job.name}" (${job.id}) failed: ${errMsg}`);
      handleRetry(job);
    }
  }

  // Prune old cron_runs (keep last 7 days)
  try {
    const pruneCutoff = Math.floor(Date.now() / 1000) - 7 * 86400;
    db.prepare("DELETE FROM cron_runs WHERE started_at < ?").run(pruneCutoff);
  } catch { /* ignore prune errors */ }
}

async function executeIsolatedJob(job: CronJob, userId: number): Promise<void> {
  // ─── Direct skill execution (no LLM needed) ───
  if (job.skill_name) {
    log.info(`[cron] Executing skill "${job.skill_name}" for job "${job.name}" (${job.id}) — DIRECT`);
    try {
      const { getSkill, loadBuiltinSkills } = await import("../skills/loader.js");
      // Ensure all builtin skills are registered before direct execution
      await loadBuiltinSkills();
      const skill = getSkill(job.skill_name);
      if (!skill) {
        throw new Error(`Skill "${job.skill_name}" not found`);
      }
      const args = job.skill_args ? JSON.parse(job.skill_args) : {};
      const result = await skill.execute(args);
      log.info(`[cron] Skill "${job.skill_name}" completed: ${String(result).slice(0, 200)}`);
    } catch (err) {
      log.error(`[cron] Skill "${job.skill_name}" failed: ${err}`);
      throw err; // Let handleRetry catch it
    }
    return;
  }

  // ─── LLM-based execution via handleMessage ───
  // Assign a stable chatId based on job id hash
  const base = config.cronChatIdBase || 200;
  const hash = parseInt(job.id, 16) || 0;
  const jobChatId = base + (Math.abs(hash) % 50);

  // Fresh session
  clearTurns(jobChatId);
  clearSession(jobChatId);

  // Build prompt with metadata
  let prompt = `[CRON:${job.id}] ${job.prompt}`;
  // Inject model override into prompt so modelSelector respects it
  if (job.model_override) {
    prompt = `[MODEL:${job.model_override}] ${prompt}`;
    log.debug(`[cron] Model override "${job.model_override}" → job "${job.name}"`);
  }
  if (job.delivery_mode === "announce") {
    prompt += `\n\nEnvoie le résultat à Nicolas via telegram.send.`;
  }

  log.info(`[cron] Executing job "${job.name}" (${job.id}) via LLM in chatId=${jobChatId}`);

  await enqueueAdminAsync(() => handleMessage(jobChatId, prompt, userId, "scheduler"));

  log.info(`[cron] Job "${job.name}" (${job.id}) completed`);
}

function updateAfterRun(job: CronJob): void {
  const db = getDb();
  const nowEpoch = Math.floor(Date.now() / 1000);

  // Compute next run
  const type = job.schedule_type as ScheduleType;
  let nextRun: number | null = null;

  if (type === "at") {
    // One-shot: disable after fire
    db.prepare(
      "UPDATE cron_jobs SET last_run_at = ?, next_run_at = NULL, enabled = 0, retry_count = 0, updated_at = unixepoch() WHERE id = ?"
    ).run(nowEpoch, job.id);
    log.info(`[cron] One-shot job "${job.name}" (${job.id}) completed — disabled`);
    return;
  }

  nextRun = computeNextRun(type, job.schedule_value, job.timezone);

  db.prepare(
    "UPDATE cron_jobs SET last_run_at = ?, next_run_at = ?, retry_count = 0, updated_at = unixepoch() WHERE id = ?"
  ).run(nowEpoch, nextRun ? Math.floor(nextRun / 1000) : null, job.id);
}

function handleRetry(job: CronJob): void {
  const db = getDb();
  const newRetryCount = job.retry_count + 1;
  const maxRetries = job.max_retries || config.cronMaxRetries || 3;

  if (newRetryCount >= maxRetries) {
    // Auto-pause after max retries
    db.prepare(
      "UPDATE cron_jobs SET enabled = 0, retry_count = ?, updated_at = unixepoch() WHERE id = ?"
    ).run(newRetryCount, job.id);
    log.warn(`[cron] Job "${job.name}" (${job.id}) auto-paused after ${newRetryCount} failures`);
    return;
  }

  // Exponential backoff: 1min, 2min, 4min... cap 1h
  const backoffMs = Math.min(60_000 * Math.pow(2, newRetryCount - 1), 3_600_000);
  const nextRetry = Math.floor((Date.now() + backoffMs) / 1000);

  db.prepare(
    "UPDATE cron_jobs SET retry_count = ?, next_run_at = ?, updated_at = unixepoch() WHERE id = ?"
  ).run(newRetryCount, nextRetry, job.id);
  log.info(`[cron] Job "${job.name}" (${job.id}) retry ${newRetryCount}/${maxRetries} in ${backoffMs / 1000}s`);
}

// ── Seed default cron jobs (content calendar + weekly synthesis) ──

export function seedDefaultCronJobs(): void {
  const db = getDb();

  // Clean up any leftover 'running' state from previous process crash
  ensureCronRunsTable();
  const leftover = detectStaleRuns();
  if (leftover > 0) {
    log.warn(`[cron] Cleaned up ${leftover} stale runs from previous session`);
  }

  // Check if jobs already exist (by name) to avoid duplicates
  const existing = db.prepare(
    "SELECT name FROM cron_jobs WHERE name IN (?, ?, ?, ?, ?)"
  ).all(
    "content-calendar-weekly", "weekly-synthesis", "nightly-self-review", "nightly-tech-watch",
    "mnemosyne_nightly_decay"
  ) as Array<{ name: string }>;
  const existingNames = new Set(existing.map(r => r.name));

  // Content calendar: every Monday at 9h — generate weekly content plan
  if (!existingNames.has("content-calendar-weekly")) {
    try {
      addCronJob({
        name: "content-calendar-weekly",
        scheduleType: "cron",
        scheduleValue: "0 9 * * 1", // Monday 9:00
        prompt: "Utilise content.calendar avec create_drafts=true et posts_per_day=2 pour generer le calendrier de contenu de la semaine. Envoie le résultat à Nicolas via telegram.send.",
        sessionTarget: "isolated",
        deliveryMode: "announce",
        modelOverride: "haiku",
      });
      log.info("[cron] Seeded: content-calendar-weekly (Monday 9h)");
    } catch (err) {
      log.debug(`[cron] Failed to seed content-calendar-weekly: ${err}`);
    }
  }

  // Weekly synthesis: every Friday at 20h — comprehensive report
  if (!existingNames.has("weekly-synthesis")) {
    try {
      addCronJob({
        name: "weekly-synthesis",
        scheduleType: "cron",
        scheduleValue: "0 20 * * 5", // Friday 20:00
        prompt: "Utilise content.weekly_synthesis pour generer le rapport hebdomadaire complet. Envoie le résultat à Nicolas via telegram.send.",
        sessionTarget: "isolated",
        deliveryMode: "announce",
        modelOverride: "haiku",
      });
      log.info("[cron] Seeded: weekly-synthesis (Friday 20h)");
    } catch (err) {
      log.debug(`[cron] Failed to seed weekly-synthesis: ${err}`);
    }
  }

  // Nightly self-review: every day at 21h ET — Kingston introspection + 3 code-requests
  if (!existingNames.has("nightly-self-review")) {
    try {
      addCronJob({
        name: "nightly-self-review",
        scheduleType: "cron",
        scheduleValue: "0 21 * * *", // Every day 21:00 ET
        prompt:
          "[CRON:nightly-self-review] Tu es Kingston en mode INTROSPECTION. Fais une analyse honnête de ta journée.\n\n" +
          "1. INTERACTIONS NICOLAS\n" +
          "   - Appelle memory.search(query='conversation', limit=20) pour les conversations récentes\n" +
          "   - Identifie: Nicolas satisfait ou frustré? Quels types de demandes gères-tu bien vs mal?\n\n" +
          "2. AGENTS\n" +
          "   - Appelle analytics.tokens() pour le coût par provider\n" +
          "   - Quels agents ont produit de la valeur aujourd'hui? Lesquels tournent dans le vide?\n\n" +
          "3. SKILLS\n" +
          "   - Identifie les skills les plus utilisés et les moins utilisés\n" +
          "   - Y a-t-il des skills manquants que Nicolas demande souvent?\n\n" +
          "4. CRONS\n" +
          "   - Quels crons échouent? Lesquels produisent de la valeur vs du bruit?\n\n" +
          "5. PROPOSITIONS (OBLIGATOIRE)\n" +
          "   Génère EXACTEMENT 3 améliorations concrètes, classées par impact.\n" +
          "   Pour chaque: titre, description, fichiers à modifier.\n" +
          "   Écris-les dans code-requests.json via files.write_anywhere.\n\n" +
          "6. PERSONNALITÉ\n" +
          "   - Si tu as observé de nouveaux patterns chez Nicolas, mets à jour relay/KINGSTON_PERSONALITY.md section 'Patterns observés'\n" +
          "   - Utilise personality.update si disponible, sinon files.write_anywhere\n\n" +
          "7. RAPPORT À NICOLAS (telegram.send)\n" +
          "   \"📊 Rétro du soir Kingston:\n" +
          "   ✅ Ce qui marche: [2-3 points]\n" +
          "   ⚠️ À améliorer: [2-3 points]\n" +
          "   💡 3 améliorations proposées (code-requests)\n" +
          "   Score global: X/10\"\n\n" +
          "8. LOG ÉPISODIQUE\n" +
          "   - Log la review dans episodic.log(event_type='nightly_review', importance=8)\n\n" +
          "RÈGLES: Sois HONNÊTE. Si quelque chose ne marche pas, dis-le. L'objectif est de s'améliorer CHAQUE JOUR.",
        sessionTarget: "isolated",
        deliveryMode: "announce",
        modelOverride: "haiku",
      });
      log.info("[cron] Seeded: nightly-self-review (Daily 21h)");
    } catch (err) {
      log.debug(`[cron] Failed to seed nightly-self-review: ${err}`);
    }
  }

  // Nightly tech watch: every day at 22h ET — scan repos for useful skills
  if (!existingNames.has("nightly-tech-watch")) {
    try {
      addCronJob({
        name: "nightly-tech-watch",
        scheduleType: "cron",
        scheduleValue: "0 22 * * *", // Every day 22:00 ET
        prompt:
          "[CRON:nightly-tech-watch] Tu es Kingston en mode VEILLE TECHNOLOGIQUE.\n\n" +
          "MISSION: Scanner les repos open-source pour trouver des skills, patterns, et idées utiles.\n\n" +
          "1. SCAN REPOS (utilise web.fetch pour chaque URL):\n" +
          "   - https://github.com/VoltAgent/awesome-openclaw-skills (README principal)\n" +
          "   - https://github.com/topics/openclaw-skill (GitHub topic)\n" +
          "   - https://github.com/topics/ai-agent (nouveautés)\n" +
          "   - https://github.com/trending?since=daily (trending du jour)\n\n" +
          "2. ANALYSE:\n" +
          "   Pour chaque repo/skill intéressant trouvé:\n" +
          "   - Nom + description + URL\n" +
          "   - Est-ce que ça pourrait être utile pour Kingston/Bastilon?\n" +
          "   - Difficulté d'intégration (facile/moyen/complexe)\n" +
          "   - Score de pertinence (1-10)\n\n" +
          "3. RECHERCHE CIBLÉE:\n" +
          "   - web.search('new AI agent tools 2026') — nouveaux outils\n" +
          "   - web.search('Claude Code plugins latest') — extensions Claude\n" +
          "   - web.search('telegram bot AI integration new') — intégrations Telegram\n\n" +
          "4. RÉSULTATS:\n" +
          "   - Si score >= 7: crée un code-request dans code-requests.json\n" +
          "   - Sauvegarde le résumé dans notes.add(title='Tech Watch', content=...)\n" +
          "   - Log dans episodic.log(event_type='tech_watch', importance=5)\n\n" +
          "5. RAPPORT:\n" +
          "   Si tu trouves quelque chose de vraiment intéressant (score >= 8), envoie un message court à Nicolas:\n" +
          "   telegram.send(text='🔍 Veille tech: [trouvaille]')\n" +
          "   Sinon, log silencieusement.\n\n" +
          "RÈGLES: Ne spamme PAS Nicolas. Seulement les trouvailles vraiment pertinentes. Qualité > quantité.",
        sessionTarget: "isolated",
        deliveryMode: "none", // Silent by default — only telegram.send on high-value finds
        modelOverride: "haiku",
      });
      log.info("[cron] Seeded: nightly-tech-watch (Daily 22h)");
    } catch (err) {
      log.debug(`[cron] Failed to seed nightly-tech-watch: ${err}`);
    }
  }

  // Mnemosyne nightly decay: every day at 23h ET — score & archive memories
  if (!existingNames.has("mnemosyne_nightly_decay")) {
    try {
      addCronJob({
        name: "mnemosyne_nightly_decay",
        scheduleType: "cron",
        scheduleValue: "0 23 * * *", // Every day 23:00 ET
        prompt:
          "[CRON] Run Mnemosyne memory decay: score all memories, archive low-scoring ones, prune old episodic events.",
        sessionTarget: "isolated",
        deliveryMode: "none",
        modelOverride: "haiku",
      });
      log.info("[cron] Seeded: mnemosyne_nightly_decay (Daily 23h)");
    } catch (err) {
      log.debug(`[cron] Failed to seed mnemosyne_nightly_decay: ${err}`);
    }
  }
}
