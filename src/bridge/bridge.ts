/**
 * Bridge module — enables bot-to-bot communication via HTTP.
 * Stores recent messages in memory and provides context injection
 * for shared Telegram group conversations.
 */
import { config } from "../config/env.js";
import { log } from "../utils/log.js";

// ── Types ───────────────────────────────────────────────────

interface BridgeMessage {
  from: string;
  text: string;
  chatId: string;
  timestamp: number;
  isBridgeReply?: boolean;
}

// ── In-memory message store (last 20 messages) ─────────────

const MAX_MESSAGES = 20;
const messages: BridgeMessage[] = [];

// ── Débat Permanent: response handler ──────────────────────

type BridgeResponseHandler = (from: string, text: string, chatId: string) => Promise<void>;
let bridgeResponseHandler: BridgeResponseHandler | null = null;

export function setBridgeResponseHandler(handler: BridgeResponseHandler): void {
  bridgeResponseHandler = handler;
}

// ── Public API ──────────────────────────────────────────────

/**
 * Returns true if a bridge partner URL is configured.
 */
export function hasBridgePartner(): boolean {
  return !!config.bridgePartnerUrl;
}

/**
 * Notify the partner bot about a message Kingston sent.
 * Fire-and-forget — does not block the caller.
 */
let partnerFailCount = 0;
const PARTNER_MAX_SILENT_FAILS = 3; // Stop logging after N consecutive failures

export function notifyPartner(text: string, chatId: string | number, isBridgeReply: boolean = false): void {
  if (!config.bridgePartnerUrl) return;

  // After repeated failures, skip silently (partner is probably offline)
  if (partnerFailCount >= PARTNER_MAX_SILENT_FAILS) return;

  const url = config.bridgePartnerUrl;
  const body = JSON.stringify({
    from: "Kingston",
    text,
    chatId: String(chatId),
    isBridgeReply,
  });

  // Fire-and-forget — no await
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal: AbortSignal.timeout(5000),
  })
    .then((resp) => {
      if (!resp.ok) {
        partnerFailCount++;
        if (partnerFailCount <= PARTNER_MAX_SILENT_FAILS) {
          log.debug(`[bridge] Partner responded ${resp.status} at ${url}`);
        }
      } else {
        partnerFailCount = 0; // Reset on success
        log.debug(`[bridge] Notified partner (chat ${chatId}, ${text.length} chars)`);
      }
    })
    .catch((err) => {
      partnerFailCount++;
      if (partnerFailCount <= PARTNER_MAX_SILENT_FAILS) {
        log.debug(`[bridge] Partner offline: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
}

/**
 * Store a message received from the partner bot.
 * If it's not a bridge reply and a response handler is set, triggers the Débat Permanent.
 */
export function receiveBridgeMessage(from: string, text: string, chatId: string, isBridgeReply: boolean = false): void {
  messages.push({ from, text, chatId, timestamp: Date.now() });

  // Trim to max size
  while (messages.length > MAX_MESSAGES) {
    messages.shift();
  }

  log.debug(`[bridge] Received message from ${from} in chat ${chatId} (${text.length} chars, reply=${isBridgeReply}, ${messages.length} stored)`);

  // Débat Permanent: trigger response if this is NOT a bridge reply (anti-loop)
  if (!isBridgeReply && bridgeResponseHandler) {
    bridgeResponseHandler(from, text, chatId).catch((err) => {
      log.error(`[bridge] Response handler error: ${err}`);
    });
  }
}

/**
 * Get formatted bridge context for a specific chat — last 5 partner messages.
 * Returns an empty string if there are no bridge messages for this chat.
 */
export function getBridgeContext(chatId: string | number): string {
  const chatStr = String(chatId);
  const relevant = messages
    .filter((m) => m.chatId === chatStr)
    .slice(-5);

  if (relevant.length === 0) return "";

  const partnerName = config.bridgePartnerName || "Partner";
  const lines = relevant.map((m) => `[${m.from || partnerName} said]: ${m.text}`);
  return (
    `--- Bridge context (messages from ${partnerName} in this group) ---\n` +
    lines.join("\n") +
    "\n--- End bridge context ---"
  );
}
