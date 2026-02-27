/**
 * Noah Bridge — persistent Kingston ↔ Noah communication via JSONL files.
 *
 * Instead of stateless `openclaw agent` calls (which lose context every time),
 * this bridge accumulates messages in JSONL files so Noah can read the full
 * conversation history before responding.
 *
 * Flow:
 *   Kingston writes to INBOX  (data/kingston-to-noah.jsonl)
 *   Noah    writes to OUTBOX  (data/noah-to-kingston.jsonl)
 *   Kingston polls OUTBOX for replies matching the request ID.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "../config/env.js";
import { log } from "../utils/log.js";

export interface BridgeMessage {
  id: string;
  from: "Kingston" | "Noah";
  type: "voice_turn" | "text" | "system" | "context";
  ts: number; // Unix seconds
  msg: string;
  callSid?: string | null;
  lang?: string;
  inReplyTo?: string;
  thread?: string;
}

function nowTs(): number {
  return Math.floor(Date.now() / 1000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function genId(prefix: string = "bridge"): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function ensureDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Append a message to a JSONL file.
 */
function appendToFile(filePath: string, message: BridgeMessage): void {
  ensureDir(filePath);
  fs.appendFileSync(filePath, JSON.stringify(message) + "\n", "utf8");
}

/**
 * Read all messages from a JSONL file.
 */
function readFile(filePath: string): BridgeMessage[] {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, "utf8");
  return content
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as BridgeMessage;
      } catch {
        return null;
      }
    })
    .filter((m): m is BridgeMessage => m !== null);
}

/**
 * Get recent conversation context (last N messages from both files).
 */
export function getConversationHistory(limit: number = 20): BridgeMessage[] {
  const inbox = config.noahBridgeInbox || "data/kingston-to-noah.jsonl";
  const outbox = config.noahBridgeOutbox || "data/noah-to-kingston.jsonl";

  const all = [...readFile(inbox), ...readFile(outbox)];
  all.sort((a, b) => a.ts - b.ts);
  return all.slice(-limit);
}

/**
 * Send a message to Noah and wait for a reply.
 * This writes to the INBOX and polls the OUTBOX for a matching reply.
 */
export async function askNoah(
  text: string,
  opts: {
    type?: BridgeMessage["type"];
    callSid?: string;
    lang?: string;
    thread?: string;
    timeoutMs?: number;
  } = {}
): Promise<string> {
  const inbox = config.noahBridgeInbox || "data/kingston-to-noah.jsonl";
  const outbox = config.noahBridgeOutbox || "data/noah-to-kingston.jsonl";
  const timeoutMs = opts.timeoutMs || config.noahBridgeTimeoutMs || 12000;

  const reqId = genId(opts.type || "text");

  const message: BridgeMessage = {
    id: reqId,
    from: "Kingston",
    type: opts.type || "text",
    ts: nowTs(),
    msg: text,
    callSid: opts.callSid || null,
    lang: opts.lang || config.voiceLanguage || "fr",
    thread: opts.thread,
  };

  appendToFile(inbox, message);
  log.info(`[noah-bridge] Sent to Noah: ${reqId} — "${text.slice(0, 80)}..."`);

  // Poll outbox for a reply
  const started = Date.now();
  let lastLineCount = 0;

  while (Date.now() - started < timeoutMs) {
    if (fs.existsSync(outbox)) {
      const lines = fs
        .readFileSync(outbox, "utf8")
        .split(/\r?\n/)
        .filter(Boolean);

      // Only scan new lines since last check
      for (let i = lastLineCount; i < lines.length; i++) {
        try {
          const row = JSON.parse(lines[i]) as BridgeMessage;
          if (row.inReplyTo === reqId) {
            log.info(`[noah-bridge] Got reply from Noah: "${(row.msg || "").slice(0, 80)}..."`);
            return row.msg || "";
          }
        } catch {
          // skip malformed lines
        }
      }
      lastLineCount = lines.length;
    }
    await sleep(350);
  }

  log.warn(`[noah-bridge] Timeout waiting for Noah reply to ${reqId}`);
  return "Noah n'a pas r\u00e9pondu \u00e0 temps. R\u00e9essaie dans un instant.";
}

/**
 * Send a message to Noah without waiting for a reply (fire-and-forget).
 */
export function notifyNoah(text: string, type: BridgeMessage["type"] = "system"): void {
  const inbox = config.noahBridgeInbox || "data/kingston-to-noah.jsonl";

  const message: BridgeMessage = {
    id: genId("notify"),
    from: "Kingston",
    type,
    ts: nowTs(),
    msg: text,
  };

  appendToFile(inbox, message);
  log.debug(`[noah-bridge] Notified Noah: "${text.slice(0, 60)}"`);
}

/**
 * Send context to Noah (personality, memory, current state).
 * Call this once at startup or periodically to keep Noah informed.
 */
export function sendContext(context: string): void {
  const inbox = config.noahBridgeInbox || "data/kingston-to-noah.jsonl";

  const message: BridgeMessage = {
    id: genId("ctx"),
    from: "Kingston",
    type: "context",
    ts: nowTs(),
    msg: context,
  };

  appendToFile(inbox, message);
  log.info(`[noah-bridge] Sent context to Noah (${context.length} chars)`);
}

/**
 * Check if Noah bridge is enabled and configured.
 */
export function isBridgeEnabled(): boolean {
  return config.noahBridgeEnabled === true;
}
