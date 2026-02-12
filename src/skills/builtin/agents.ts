/**
 * Built-in skills: agents.list, agents.status, agents.start, agents.stop
 * Admin-only management of autonomous agents.
 */
import { registerSkill } from "../loader.js";
import { listAgents, getAgent } from "../../agents/registry.js";
import { isRateLimited, getRateLimitReset } from "../../agents/base.js";
import { getDb } from "../../storage/store.js";

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

// --- Inter-agent task delegation ---

registerSkill({
  name: "agents.delegate",
  description:
    "Delegate a task to another agent. The target agent will see it in its inbox on next cycle.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      from: { type: "string", description: "Sender agent ID (e.g. 'analyst')" },
      to: { type: "string", description: "Target agent ID (e.g. 'scout')" },
      instruction: {
        type: "string",
        description: "Task instruction for the target agent",
      },
    },
    required: ["from", "to", "instruction"],
  },
  async execute(args): Promise<string> {
    const from = String(args.from);
    const to = String(args.to);
    const instruction = String(args.instruction);

    // Validate target agent exists
    const target = getAgent(to);
    if (!target) return `Agent "${to}" not found.`;

    const d = getDb();
    const info = d
      .prepare(
        "INSERT INTO agent_tasks (from_agent, to_agent, instruction) VALUES (?, ?, ?)",
      )
      .run(from, to, instruction);

    return `Task #${info.lastInsertRowid} delegated to ${to}: "${instruction.slice(0, 80)}${instruction.length > 80 ? "..." : ""}"`;
  },
});

registerSkill({
  name: "agents.inbox",
  description:
    "Check pending tasks delegated to a specific agent. Returns tasks waiting to be processed.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      agent_id: {
        type: "string",
        description: "Agent ID to check inbox for (e.g. 'scout')",
      },
      complete_id: {
        type: "number",
        description: "Optional: mark a task as completed by its ID",
      },
      result: {
        type: "string",
        description: "Optional: result text when completing a task",
      },
    },
    required: ["agent_id"],
  },
  async execute(args): Promise<string> {
    const agentId = String(args.agent_id);
    const completeId = args.complete_id as number | undefined;
    const result = args.result as string | undefined;
    const d = getDb();

    // Complete a task if requested
    if (completeId) {
      const info = d
        .prepare(
          "UPDATE agent_tasks SET status = 'completed', result = ?, completed_at = unixepoch() WHERE id = ? AND to_agent = ?",
        )
        .run(result || "done", completeId, agentId);
      if (info.changes === 0) return `Task #${completeId} not found or not assigned to ${agentId}.`;
      return `Task #${completeId} marked as completed.`;
    }

    // List pending tasks
    const tasks = d
      .prepare(
        "SELECT id, from_agent, instruction, created_at FROM agent_tasks WHERE to_agent = ? AND status = 'pending' ORDER BY created_at ASC",
      )
      .all(agentId) as Array<{
      id: number;
      from_agent: string;
      instruction: string;
      created_at: number;
    }>;

    if (tasks.length === 0) return `No pending tasks for ${agentId}.`;

    return tasks
      .map(
        (t) =>
          `#${t.id} from **${t.from_agent}** (${new Date(t.created_at * 1000).toLocaleString("fr-CA", { timeZone: "America/Toronto" })}):\n  ${t.instruction}`,
      )
      .join("\n\n");
  },
});

// --- Dynamic Subordinate Spawning ---

registerSkill({
  name: "agents.spawn",
  description: "Spawn a temporary subordinate agent for a subtask. Runs the task through Ollama with a custom system prompt, returns result, then disposes. Used for breaking down complex tasks.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      task: { type: "string", description: "The task/question for the subordinate to handle" },
      role: { type: "string", description: "Role/persona for the subordinate (e.g., 'market researcher', 'copywriter')" },
      context: { type: "string", description: "Additional context to include in the system prompt (optional)" },
    },
    required: ["task"],
  },
  async execute(args): Promise<string> {
    const task = args.task as string;
    const role = (args.role as string) || "assistant";
    const context = (args.context as string) || "";

    // Use a high chatId range (300-399) for subordinate sessions
    const subChatId = 300 + Math.floor(Math.random() * 100);

    try {
      // Try to use Ollama chat with the task
      const { runOllamaChat } = await import("../../llm/ollamaClient.js");

      // Build the prompt with role and context
      const prompt = context
        ? `[SUBORDINATE AGENT — Role: ${role}]\nContext: ${context}\n\nTask: ${task}`
        : `[SUBORDINATE AGENT — Role: ${role}]\nTask: ${task}`;

      const result = await runOllamaChat({
        chatId: subChatId,
        userMessage: prompt,
        isAdmin: true,
        userId: 0,
      });

      // Clean up turns for this temporary session
      const { clearTurns } = await import("../../storage/store.js");
      clearTurns(subChatId);

      return `[Subordinate: ${role}]\n${result}`;
    } catch (err) {
      // Fallback: try Groq
      try {
        const { runGroq } = await import("../../llm/groqClient.js");
        const result = await runGroq(
          `You are a ${role}. ${context ? "Context: " + context + "\n" : ""}Task: ${task}`,
          "llama-3.3-70b-versatile"
        );
        return `[Subordinate: ${role} via Groq]\n${result}`;
      } catch (err2) {
        return `Subordinate spawn failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  },
});
