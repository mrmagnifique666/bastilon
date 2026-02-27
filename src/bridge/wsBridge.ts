/**
 * WebSocket Bridge — bidirectional real-time communication between Kingston
 * and external Claude CLI agents (e.g., Antigravity).
 *
 * Protocol:
 * ─── Handshake ───
 * Peer → Kingston: { type: "auth", token: "...", agent: "antigravity" }
 * Kingston → Peer: { type: "auth_ok", agent: "kingston", chatId: 400 }
 *
 * ─── Messages ───
 * Either → Either: { type: "message", text: "...", requestId?: "uuid" }
 * Either → Either: { type: "response", requestId: "uuid", text: "..." }
 *
 * ─── Keepalive ───
 * Peer → Kingston: { type: "ping" }
 * Kingston → Peer: { type: "pong" }
 *
 * ─── Errors ───
 * Kingston → Peer: { type: "error", message: "..." }
 *
 * ChatId range: 400-499 (external agent bridges)
 */
import { config } from "../config/env.js";
import { log } from "../utils/log.js";

// ── Types ────────────────────────────────────────────────────

export interface BridgePeer {
  ws: import("ws").WebSocket;
  agent: string;
  chatId: number;
  authenticated: boolean;
  connectedAt: number;
  lastActivity: number;
}

interface BridgeRequest {
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ── State ────────────────────────────────────────────────────

const peers = new Map<import("ws").WebSocket, BridgePeer>();
const pendingRequests = new Map<string, BridgeRequest>();
let nextChatId = 400;

// ── Incoming message handler (set by skill registration) ────

type IncomingHandler = (agent: string, text: string, chatId: number) => Promise<string>;
let incomingHandler: IncomingHandler | null = null;

export function setBridgeIncomingHandler(handler: IncomingHandler): void {
  incomingHandler = handler;
}

// ── Public API ───────────────────────────────────────────────

/**
 * Handle a new WebSocket connection on /ws/bridge.
 * Called from dashboard server upgrade handler.
 */
export function handleBridgeConnection(ws: import("ws").WebSocket): void {
  const peer: BridgePeer = {
    ws,
    agent: "",
    chatId: 0,
    authenticated: false,
    connectedAt: Date.now(),
    lastActivity: Date.now(),
  };
  peers.set(ws, peer);

  ws.on("message", async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      peer.lastActivity = Date.now();

      // ── Auth handshake ──
      if (msg.type === "auth") {
        const token = config.bridgeWsToken;
        if (!token) {
          wsSend(ws, { type: "error", message: "Bridge not configured (BRIDGE_WS_TOKEN not set)" });
          ws.close();
          return;
        }
        if (msg.token !== token) {
          wsSend(ws, { type: "error", message: "Authentication failed" });
          ws.close();
          return;
        }
        if (!msg.agent || typeof msg.agent !== "string") {
          wsSend(ws, { type: "error", message: "Missing agent name" });
          ws.close();
          return;
        }

        // Disconnect existing peer with same agent name (reconnect)
        for (const [existingWs, existingPeer] of peers) {
          if (existingPeer.agent === msg.agent && existingWs !== ws) {
            log.info(`[ws-bridge] Disconnecting stale ${existingPeer.agent} (reconnect)`);
            try { existingWs.close(); } catch { /* ignore */ }
            peers.delete(existingWs);
          }
        }

        peer.authenticated = true;
        peer.agent = String(msg.agent).toLowerCase();
        peer.chatId = nextChatId++;
        if (nextChatId > 499) nextChatId = 400; // Wrap around

        wsSend(ws, { type: "auth_ok", agent: "kingston", chatId: peer.chatId });
        log.info(`[ws-bridge] Peer "${peer.agent}" authenticated (chatId: ${peer.chatId})`);
        return;
      }

      // ── Require auth ──
      if (!peer.authenticated) {
        wsSend(ws, { type: "error", message: "Not authenticated. Send { type: 'auth', token: '...', agent: '...' } first." });
        return;
      }

      // ── Ping/Pong ──
      if (msg.type === "ping") {
        wsSend(ws, { type: "pong" });
        return;
      }

      // ── Incoming message from peer ──
      if (msg.type === "message" && msg.text) {
        const text = String(msg.text);
        const requestId = msg.requestId ? String(msg.requestId) : undefined;

        log.info(`[ws-bridge] Message from ${peer.agent}: ${text.slice(0, 100)}${text.length > 100 ? "..." : ""}`);

        if (incomingHandler) {
          try {
            const response = await incomingHandler(peer.agent, text, peer.chatId);
            if (requestId) {
              wsSend(ws, { type: "response", requestId, text: response });
            } else {
              wsSend(ws, { type: "message", text: response });
            }
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            log.error(`[ws-bridge] Handler error for ${peer.agent}: ${errMsg}`);
            if (requestId) {
              wsSend(ws, { type: "response", requestId, text: `[error] ${errMsg}` });
            } else {
              wsSend(ws, { type: "error", message: errMsg });
            }
          }
        } else {
          wsSend(ws, { type: "error", message: "No message handler configured" });
        }
        return;
      }

      // ── Response to a request Kingston sent ──
      if (msg.type === "response" && msg.requestId) {
        const pending = pendingRequests.get(msg.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          pendingRequests.delete(msg.requestId);
          pending.resolve(String(msg.text || ""));
        }
        return;
      }
    } catch (err) {
      log.debug(`[ws-bridge] Parse error: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  ws.on("close", () => {
    if (peer.authenticated) {
      log.info(`[ws-bridge] Peer "${peer.agent}" disconnected`);
    }
    peers.delete(ws);
  });

  ws.on("error", (err) => {
    log.debug(`[ws-bridge] WebSocket error: ${err.message}`);
  });
}

/**
 * Send a message to a connected peer agent.
 * Returns the peer's response if requestId is used (with timeout).
 */
export async function sendToPeer(
  agent: string,
  text: string,
  options?: { timeout?: number },
): Promise<string> {
  const peer = findPeer(agent);
  if (!peer) {
    throw new Error(`Peer "${agent}" not connected`);
  }

  const requestId = crypto.randomUUID();
  const timeout = options?.timeout ?? 30_000;

  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error(`Timeout waiting for response from "${agent}" (${timeout}ms)`));
    }, timeout);

    pendingRequests.set(requestId, { resolve, reject, timer });
    wsSend(peer.ws, { type: "message", text, requestId });
  });
}

/**
 * Send a fire-and-forget message to a peer (no response expected).
 */
export function notifyPeer(agent: string, text: string): boolean {
  const peer = findPeer(agent);
  if (!peer) return false;
  wsSend(peer.ws, { type: "message", text });
  return true;
}

/**
 * Send a debate payload to a peer before posting Kingston's response.
 * The peer receives the human message + Kingston's draft, generates its own reply,
 * and sends back an ack. Returns true if the peer acknowledged.
 */
export async function debateWithPeer(
  agent: string,
  payload: { chatId: number; humanMessage: string; kingstonResponse: string },
  options?: { timeout?: number },
): Promise<boolean> {
  const peer = findPeer(agent);
  if (!peer) return false;

  const debatePayload = JSON.stringify({
    type: "debate",
    chatId: payload.chatId,
    humanMessage: payload.humanMessage,
    kingstonResponse: payload.kingstonResponse,
  });

  try {
    log.info(`[debate] Sending to ${agent} before posting (chat ${payload.chatId})`);
    await sendToPeer(agent, debatePayload, { timeout: options?.timeout ?? 60_000 });
    log.info(`[debate] Ack received from ${agent}`);
    return true;
  } catch (err) {
    log.warn(`[debate] Failed for ${agent}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * List all connected bridge peers.
 */
export function listPeers(): Array<{
  agent: string;
  chatId: number;
  connectedAt: number;
  lastActivity: number;
}> {
  return Array.from(peers.values())
    .filter((p) => p.authenticated)
    .map((p) => ({
      agent: p.agent,
      chatId: p.chatId,
      connectedAt: p.connectedAt,
      lastActivity: p.lastActivity,
    }));
}

/**
 * Check if a specific peer is connected.
 */
export function isPeerConnected(agent: string): boolean {
  return !!findPeer(agent);
}

// ── Internals ────────────────────────────────────────────────

function findPeer(agent: string): BridgePeer | undefined {
  const name = agent.toLowerCase();
  for (const peer of peers.values()) {
    if (peer.authenticated && peer.agent === name) return peer;
  }
  return undefined;
}

function wsSend(ws: import("ws").WebSocket, obj: Record<string, unknown>): void {
  try {
    ws.send(JSON.stringify(obj));
  } catch { /* client disconnected */ }
}
