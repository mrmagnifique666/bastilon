/**
 * WebSocket Channel — allows external clients to connect to Kingston.
 * Messages sent over WS are routed through the same orchestrator as Telegram.
 *
 * Protocol:
 * Client → Server: { type: "auth", token: "..." }
 * Client → Server: { type: "message", text: "...", chatId?: number }
 * Server → Client: { type: "response", text: "...", chatId: number }
 * Server → Client: { type: "typing", chatId: number }
 * Server → Client: { type: "error", message: "..." }
 */
import type { Channel, ChannelType } from "./channel.js";
import { config } from "../config/env.js";
import { log } from "../utils/log.js";

interface WsClient {
  ws: import("ws").WebSocket;
  authenticated: boolean;
  chatId: number;
  userId: number;
}

const clients = new Map<import("ws").WebSocket, WsClient>();
let connected = false;

/** The WebSocket channel for Kingston gateway */
export const wsChannel: Channel = {
  type: "websocket" as ChannelType,
  name: "WebSocket Gateway",

  isConnected() {
    return connected;
  },

  async sendText(chatId: number, text: string, _parseMode?: string) {
    for (const client of clients.values()) {
      if (client.authenticated && client.chatId === chatId) {
        try {
          client.ws.send(JSON.stringify({ type: "response", text, chatId, ts: Date.now() }));
        } catch { /* client disconnected */ }
      }
    }
  },

  async sendTyping(chatId: number) {
    for (const client of clients.values()) {
      if (client.authenticated && client.chatId === chatId) {
        try {
          client.ws.send(JSON.stringify({ type: "typing", chatId }));
        } catch { /* ignore */ }
      }
    }
  },

  async sendVoice(chatId: number, audio: Buffer, filename: string) {
    for (const client of clients.values()) {
      if (client.authenticated && client.chatId === chatId) {
        try {
          client.ws.send(JSON.stringify({
            type: "voice",
            chatId,
            audio: audio.toString("base64"),
            filename,
          }));
        } catch { /* ignore */ }
      }
    }
  },

  async start() {
    connected = true;
    log.info("[ws-channel] WebSocket channel ready");
  },

  async stop() {
    for (const client of clients.values()) {
      try { client.ws.close(); } catch { /* ignore */ }
    }
    clients.clear();
    connected = false;
    log.info("[ws-channel] WebSocket channel stopped");
  },
};

/** Handle a new WebSocket connection (called from dashboard server) */
export function handleWsGatewayConnection(ws: import("ws").WebSocket): void {
  const client: WsClient = {
    ws,
    authenticated: false,
    chatId: 500, // Default chatId for WS clients (500+)
    userId: 0,
  };
  clients.set(ws, client);

  ws.on("message", async (data) => {
    try {
      const msg = JSON.parse(data.toString());

      // Auth handshake
      if (msg.type === "auth") {
        if (msg.token === config.dashboardToken || msg.token === config.adminPassphrase) {
          client.authenticated = true;
          client.userId = Number(msg.userId) || config.voiceUserId;
          client.chatId = Number(msg.chatId) || 500 + clients.size;
          ws.send(JSON.stringify({ type: "auth_ok", chatId: client.chatId }));
          log.info(`[ws-channel] Client authenticated (chatId: ${client.chatId})`);
        } else {
          ws.send(JSON.stringify({ type: "error", message: "Authentication failed" }));
          ws.close();
        }
        return;
      }

      if (!client.authenticated) {
        ws.send(JSON.stringify({ type: "error", message: "Not authenticated. Send { type: 'auth', token: '...' } first." }));
        return;
      }

      // Message handling — dispatch to gateway
      if (msg.type === "message" && msg.text) {
        const { dispatchMessage } = await import("./channel.js");
        await dispatchMessage({
          messageId: `ws-${Date.now()}`,
          channel: "websocket",
          userId: String(client.userId),
          numericUserId: client.userId,
          chatId: client.chatId,
          text: String(msg.text),
          timestamp: Date.now(),
        });
      }
    } catch (err) {
      log.debug(`[ws-channel] Message error: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    log.debug("[ws-channel] Client disconnected");
  });
}

/** Get the number of connected WS gateway clients */
export function getWsClientCount(): number {
  return Array.from(clients.values()).filter((c) => c.authenticated).length;
}
