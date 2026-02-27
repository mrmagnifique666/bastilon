/**
 * Built-in skills: bridge.peers, bridge.send, bridge.status
 * Inter-agent WebSocket bridge communication.
 */
import { registerSkill } from "../loader.js";
import { listPeers, sendToPeer, notifyPeer, isPeerConnected } from "../../bridge/wsBridge.js";

registerSkill({
  name: "bridge.peers",
  description: "List all connected bridge peers (external agents like Antigravity).",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {},
  },
  async execute(): Promise<string> {
    const peers = listPeers();
    if (peers.length === 0) return "No bridge peers connected.";

    const lines = peers.map((p) => {
      const uptime = Math.round((Date.now() - p.connectedAt) / 60_000);
      const idle = Math.round((Date.now() - p.lastActivity) / 1_000);
      return `**${p.agent}** (chatId: ${p.chatId}) — connected ${uptime}min ago, idle ${idle}s`;
    });
    return `Connected peers (${peers.length}):\n${lines.join("\n")}`;
  },
});

registerSkill({
  name: "bridge.send",
  description:
    "Send a message to a connected bridge peer and wait for their response. " +
    "Use this to ask questions or delegate tasks to external agents like Antigravity.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      agent: {
        type: "string",
        description: 'The agent name to send to (e.g., "antigravity")',
      },
      text: {
        type: "string",
        description: "The message to send",
      },
      timeout: {
        type: "number",
        description: "Timeout in seconds (default: 30)",
      },
    },
    required: ["agent", "text"],
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const agent = String(args.agent);
    const text = String(args.text);
    const timeout = Number(args.timeout || 30) * 1000;

    if (!isPeerConnected(agent)) {
      return `Peer "${agent}" is not connected. Use bridge.peers to see connected peers.`;
    }

    try {
      const response = await sendToPeer(agent, text, { timeout });
      return `Response from ${agent}:\n${response}`;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

registerSkill({
  name: "bridge.notify",
  description:
    "Send a fire-and-forget message to a bridge peer (no response expected). " +
    "Use for notifications, alerts, or one-way updates.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      agent: {
        type: "string",
        description: 'The agent name to notify (e.g., "antigravity")',
      },
      text: {
        type: "string",
        description: "The message to send",
      },
    },
    required: ["agent", "text"],
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const agent = String(args.agent);
    const text = String(args.text);
    const sent = notifyPeer(agent, text);
    return sent
      ? `Notification sent to ${agent}.`
      : `Peer "${agent}" is not connected.`;
  },
});

registerSkill({
  name: "bridge.status",
  description: "Check the bridge connection status and configuration.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {},
  },
  async execute(): Promise<string> {
    const { config } = await import("../../config/env.js");
    const peers = listPeers();
    const hasToken = !!config.bridgeWsToken;

    return [
      `**WebSocket Bridge Status**`,
      `Token configured: ${hasToken ? "yes" : "NO — set BRIDGE_WS_TOKEN in .env"}`,
      `Endpoint: ws://localhost:${process.env.DASHBOARD_PORT || 3200}/ws/bridge`,
      `Connected peers: ${peers.length}`,
      ...peers.map((p) => `  - ${p.agent} (chatId: ${p.chatId})`),
    ].join("\n");
  },
});
