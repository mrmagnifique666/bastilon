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
  const nowEpoch = Math.floor(Date.now() / 1000);

  const dueJobs = db.prepare(
    "SELECT * FROM cron_jobs WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?"
  ).all(nowEpoch) as CronJob[];

  if (dueJobs.length === 0) return;

  log.info(`[cron] ${dueJobs.length} job(s) due`);

  for (const job of dueJobs) {
    try {
      if (job.session_target === "main") {
        // Queue for next heartbeat (context-aware)
        queueMainSessionEvent(job.id, job.name, job.prompt);
        updateAfterRun(job);
      } else {
        // Execute in isolated session
        await executeIsolatedJob(job, userId);
        updateAfterRun(job);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error(`[cron] Job "${job.name}" (${job.id}) failed: ${errMsg}`);
      handleRetry(job);
    }
  }
}

async function executeIsolatedJob(job: CronJob, userId: number): Promise<void> {
  // Assign a stable chatId based on job id hash
  const base = config.cronChatIdBase || 200;
  const hash = parseInt(job.id, 16) || 0;
  const jobChatId = base + (Math.abs(hash) % 50);

  // Fresh session
  clearTurns(jobChatId);
  clearSession(jobChatId);

  // Build prompt with metadata
  let prompt = `[CRON:${job.id}] ${job.prompt}`;
  if (job.delivery_mode === "announce") {
    prompt += `\n\nEnvoie le résultat à Nicolas via telegram.send.`;
  }

  log.info(`[cron] Executing job "${job.name}" (${job.id}) in chatId=${jobChatId}`);

  await handleMessage(jobChatId, prompt, userId, "scheduler");

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
