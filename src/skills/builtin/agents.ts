/**
 * Built-in skills: agents.list, agents.status, agents.start, agents.stop
 * Admin-only management of autonomous agents.
 */
import { registerSkill } from "../loader.js";
import { listAgents, getAgent } from "../../agents/registry.js";
import { isRateLimited, getRateLimitReset } from "../../agents/base.js";

registerSkill({
  name: "agents.list",
  description: "List all agents with their current status and stats.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {},
  },
  async execute(): Promise<string> {
    const agents = listAgents();
    if (agents.length === 0) return "No agents registered.";

    let header = "";
    if (isRateLimited()) {
      const reset = new Date(getRateLimitReset()).toLocaleString("fr-CA", { timeZone: "America/Toronto" });
      header = `**RATE LIMITED** — tous les agents en pause jusqu'à ${reset}\n\n`;
    }

    const lines = agents.map((a) => {
      const uptime = a.lastRunAt
        ? `${Math.round((Date.now() - a.createdAt) / 60_000)}min`
        : "never run";
      return (
        `**${a.name}** (${a.id}) — ${a.status}\n` +
        `  Role: ${a.role}\n` +
        `  Enabled: ${a.enabled} | Heartbeat: ${a.heartbeatMs / 1000}s\n` +
        `  Cycle: ${a.cycle} | Total runs: ${a.totalRuns} | Uptime: ${uptime}\n` +
        `  Consecutive errors: ${a.consecutiveErrors}\n` +
        `  Last run: ${a.lastRunAt ? new Date(a.lastRunAt).toLocaleString("fr-CA", { timeZone: "America/Toronto" }) : "never"}\n` +
        `  Last error: ${a.lastError || "none"}`
      );
    });
    return header + lines.join("\n\n");
  },
});

registerSkill({
  name: "agents.status",
  description: "Get detailed status of a specific agent by ID.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Agent ID (e.g. 'scout', 'analyst')" },
    },
    required: ["id"],
  },
  async execute(args): Promise<string> {
    const agent = getAgent(String(args.id));
    if (!agent) return `Agent "${args.id}" not found.`;

    const stats = agent.getStats();
    return (
      `**${stats.name}** (${stats.id})\n` +
      `Status: ${stats.status}\n` +
      `Role: ${stats.role}\n` +
      `Enabled: ${stats.enabled}\n` +
      `Heartbeat: ${stats.heartbeatMs / 1000}s\n` +
      `Current cycle: ${stats.cycle}\n` +
      `Total runs: ${stats.totalRuns}\n` +
      `Consecutive errors: ${stats.consecutiveErrors}\n` +
      `Created: ${new Date(stats.createdAt).toLocaleString("fr-CA", { timeZone: "America/Toronto" })}\n` +
      `Last run: ${stats.lastRunAt ? new Date(stats.lastRunAt).toLocaleString("fr-CA", { timeZone: "America/Toronto" }) : "never"}\n` +
      `Last error: ${stats.lastError || "none"}`
    );
  },
});

registerSkill({
  name: "agents.start",
  description: "Start or restart a specific agent by ID.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Agent ID (e.g. 'scout', 'analyst')" },
    },
    required: ["id"],
  },
  async execute(args): Promise<string> {
    const agent = getAgent(String(args.id));
    if (!agent) return `Agent "${args.id}" not found.`;

    agent.setEnabled(true);
    agent.start();
    return `Agent "${args.id}" started.`;
  },
});

registerSkill({
  name: "agents.stop",
  description: "Stop a specific agent by ID.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Agent ID (e.g. 'scout', 'analyst')" },
    },
    required: ["id"],
  },
  async execute(args): Promise<string> {
    const agent = getAgent(String(args.id));
    if (!agent) return `Agent "${args.id}" not found.`;

    agent.stop();
    return `Agent "${args.id}" stopped.`;
  },
});
