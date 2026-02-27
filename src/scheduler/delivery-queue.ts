/**
 * Delivery Queue — Inspired by OpenClaw's delivery system.
 *
 * Instead of sending Telegram messages directly (and losing them on failure),
 * all briefings and scheduled messages go through this queue.
 *
 * Features:
 * - Retry with exponential backoff (3 attempts)
 * - Failed messages persist to disk for manual replay
 * - Audit trail of all deliveries
 * - Markdown → plain text fallback
 *
 * Pattern learned from OpenClaw: Cron → Queue → Retry → Channel
 * Kingston's old pattern: Cron → Direct send (lost on failure)
 */
import fs from "node:fs";
import path from "node:path";
import { log } from "../utils/log.js";

const DATA_DIR = path.resolve("data");
const QUEUE_DIR = path.join(DATA_DIR, "delivery-queue");
const FAILED_DIR = path.join(QUEUE_DIR, "failed");
const SENT_LOG = path.join(QUEUE_DIR, "sent.jsonl");

// Ensure directories exist
for (const dir of [QUEUE_DIR, FAILED_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

interface DeliveryItem {
  id: string;
  channel: "telegram";
  chatId: string;
  text: string;
  photo?: { buffer: string; caption: string }; // base64 buffer
  parseMode?: "Markdown" | "HTML";
  source: string; // e.g. "morning_briefing", "noon_briefing", "alert"
  createdAt: number;
  attempts: number;
  lastError?: string;
  status: "pending" | "sent" | "failed";
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Queue a text message for delivery with retry.
 */
export function queueMessage(opts: {
  chatId: string;
  text: string;
  source: string;
  parseMode?: "Markdown" | "HTML";
}): string {
  const item: DeliveryItem = {
    id: generateId(),
    channel: "telegram",
    chatId: opts.chatId,
    text: opts.text,
    parseMode: opts.parseMode || "Markdown",
    source: opts.source,
    createdAt: Date.now(),
    attempts: 0,
    status: "pending",
  };

  const filePath = path.join(QUEUE_DIR, `${item.id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(item, null, 2));
  log.info(`[delivery] Queued ${item.id} from ${item.source}`);
  return item.id;
}

/**
 * Queue a photo message for delivery with retry.
 */
export function queuePhoto(opts: {
  chatId: string;
  photo: Buffer;
  caption: string;
  source: string;
}): string {
  const item: DeliveryItem = {
    id: generateId(),
    channel: "telegram",
    chatId: opts.chatId,
    text: opts.caption,
    photo: { buffer: opts.photo.toString("base64"), caption: opts.caption },
    source: opts.source,
    createdAt: Date.now(),
    attempts: 0,
    status: "pending",
  };

  const filePath = path.join(QUEUE_DIR, `${item.id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(item, null, 2));
  log.info(`[delivery] Queued photo ${item.id} from ${item.source}`);
  return item.id;
}

/**
 * Process all pending items in the queue.
 * Call this from the heartbeat loop.
 */
export async function processQueue(): Promise<{ sent: number; failed: number }> {
  const files = fs.readdirSync(QUEUE_DIR).filter(f => f.endsWith(".json"));
  let sent = 0;
  let failed = 0;

  for (const file of files) {
    const filePath = path.join(QUEUE_DIR, file);
    let item: DeliveryItem;
    try {
      item = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    } catch {
      continue;
    }

    if (item.status !== "pending") continue;

    const success = item.photo
      ? await sendPhoto(item)
      : await sendText(item);

    if (success) {
      item.status = "sent";
      item.attempts++;
      // Log to sent.jsonl and remove from queue
      fs.appendFileSync(SENT_LOG, JSON.stringify({
        id: item.id,
        source: item.source,
        sentAt: Date.now(),
        attempts: item.attempts,
      }) + "\n");
      fs.unlinkSync(filePath);
      sent++;
      log.info(`[delivery] Sent ${item.id} (${item.source}) after ${item.attempts} attempt(s)`);
    } else {
      item.attempts++;
      if (item.attempts >= 3) {
        // Move to failed directory for audit
        item.status = "failed";
        const failPath = path.join(FAILED_DIR, file);
        fs.writeFileSync(failPath, JSON.stringify(item, null, 2));
        fs.unlinkSync(filePath);
        failed++;
        log.error(`[delivery] FAILED permanently ${item.id} (${item.source}) after 3 attempts: ${item.lastError}`);
      } else {
        // Update attempts and keep in queue for retry
        fs.writeFileSync(filePath, JSON.stringify(item, null, 2));
        log.warn(`[delivery] Retry ${item.attempts}/3 for ${item.id}: ${item.lastError}`);
      }
    }
  }

  return { sent, failed };
}

/**
 * Get queue stats for dashboards/diagnostics.
 */
export function queueStats(): { pending: number; failed: number; sentToday: number } {
  const pending = fs.readdirSync(QUEUE_DIR).filter(f => f.endsWith(".json")).length;
  const failed = fs.existsSync(FAILED_DIR)
    ? fs.readdirSync(FAILED_DIR).filter(f => f.endsWith(".json")).length
    : 0;

  let sentToday = 0;
  if (fs.existsSync(SENT_LOG)) {
    try {
      const lines = fs.readFileSync(SENT_LOG, "utf-8").split("\n").filter(Boolean);
      const todayStart = new Date().setHours(0, 0, 0, 0);
      sentToday = lines.filter(l => {
        try { return JSON.parse(l).sentAt >= todayStart; } catch { return false; }
      }).length;
    } catch { /* ok */ }
  }

  return { pending, failed, sentToday };
}

/**
 * Replay a failed message (manual recovery).
 */
export function replayFailed(id: string): boolean {
  const failPath = path.join(FAILED_DIR, `${id}.json`);
  if (!fs.existsSync(failPath)) return false;

  const item: DeliveryItem = JSON.parse(fs.readFileSync(failPath, "utf-8"));
  item.status = "pending";
  item.attempts = 0;
  item.lastError = undefined;

  const queuePath = path.join(QUEUE_DIR, `${id}.json`);
  fs.writeFileSync(queuePath, JSON.stringify(item, null, 2));
  fs.unlinkSync(failPath);
  log.info(`[delivery] Replayed failed message ${id}`);
  return true;
}

// ─── Internal Telegram senders ───

async function sendText(item: DeliveryItem): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
  if (!token) {
    item.lastError = "No TELEGRAM_BOT_TOKEN";
    return false;
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  // Try with parseMode first, then plain text
  for (const parseMode of [item.parseMode, undefined] as const) {
    try {
      const body: Record<string, unknown> = { chat_id: item.chatId, text: item.text };
      if (parseMode) body.parse_mode = parseMode;

      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });

      if (resp.ok) return true;

      const err = await resp.text();
      if (parseMode && resp.status === 400) {
        // Markdown failed, try plain
        continue;
      }

      item.lastError = `HTTP ${resp.status}: ${err.slice(0, 200)}`;
      return false;
    } catch (e) {
      item.lastError = e instanceof Error ? e.message : String(e);
      if (parseMode) continue;
      return false;
    }
  }
  return false;
}

async function sendPhoto(item: DeliveryItem): Promise<boolean> {
  if (!item.photo) return false;
  const token = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
  if (!token) {
    item.lastError = "No TELEGRAM_BOT_TOKEN";
    return false;
  }

  try {
    const photoBuffer = Buffer.from(item.photo.buffer, "base64");
    const form = new FormData();
    form.append("chat_id", item.chatId);
    form.append("caption", item.photo.caption);
    form.append("photo", new Blob([new Uint8Array(photoBuffer)], { type: "image/png" }), "photo.png");

    const resp = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(20_000),
    });

    if (resp.ok) return true;

    const err = await resp.text();
    item.lastError = `HTTP ${resp.status}: ${err.slice(0, 200)}`;
    return false;
  } catch (e) {
    item.lastError = e instanceof Error ? e.message : String(e);
    return false;
  }
}
