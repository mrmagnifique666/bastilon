/**
 * Agent profile skills — view, edit, and manage per-agent configuration profiles.
 * Also includes subordinate agent spawning for typed delegation.
 */
import { registerSkill } from "../loader.js";
import {
  loadProfile, listProfiles, saveProfile, loadPrompts,
  savePrompt, hasProfile, isToolAllowed,
} from "../../agents/profiles.js";
import { spawnSubordinate, spawnParallel } from "../../agents/subordinate.js";

// ── Profile Management ───────────────────────────────────────────────

registerSkill({
  name: "agents.profile",
  description: "View an agent's profile configuration (heartbeat, tools, quiet hours, variables).",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Agent ID (e.g. 'scout', 'mind')" },
    },
    required: ["id"],
  },
  async execute(args): Promise<string> {
    const id = String(args.id);
    const profile = loadProfile(id);
    if (!profile) return `No profile found for "${id}". Available: ${listProfiles().join(", ") || "none"}`;

    const prompts = loadPrompts(id);
    return (
      `**${profile.name}** (${profile.id})\n` +
      `Role: ${profile.role}\n` +
      `Heartbeat: ${profile.heartbeatMs / 1000}s\n` +
      `Enabled: ${profile.enabled}\n` +
      `ChatId: ${profile.chatId}\n` +
      `Cycles: ${profile.cycleCount}\n` +
      (profile.quietHours ? `Quiet hours: ${profile.quietHours.start}h-${profile.quietHours.end}h\n` : "") +
      (profile.tools?.allowlist ? `Allowed tools: ${profile.tools.allowlist.join(", ")}\n` : "") +
      (profile.tools?.blocklist ? `Blocked tools: ${profile.tools.blocklist.join(", ")}\n` : "") +
      (profile.variables ? `Variables: ${JSON.stringify(profile.variables)}\n` : "") +
      `Prompts loaded: ${prompts.size} cycle(s)`
    );
  },
});

registerSkill({
  name: "agents.profiles",
  description: "List all available agent profiles from relay/agents/ folder.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {},
  },
  async execute(): Promise<string> {
    const ids = listProfiles();
    if (ids.length === 0) return "No agent profiles found in relay/agents/.";

    const lines = ids.map(id => {
      const profile = loadProfile(id);
      if (!profile) return `- ${id}: (invalid config)`;
      const prompts = loadPrompts(id);
      return `- **${profile.name}** (${id}) — ${profile.role} | chatId:${profile.chatId} | ${prompts.size} prompts | ${profile.enabled ? "enabled" : "disabled"}`;
    });

    return `**Agent Profiles (${ids.length}):**\n${lines.join("\n")}`;
  },
});

registerSkill({
  name: "agents.profile_edit",
  description: "Edit an agent profile field. Changes saved to relay/agents/{id}/config.json.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Agent ID" },
      field: { type: "string", description: "Field to edit (heartbeatMs, enabled, cycleCount, variables, tools.allowlist, tools.blocklist)" },
      value: { type: "string", description: "New value (JSON for objects/arrays, plain for strings/numbers)" },
    },
    required: ["id", "field", "value"],
  },
  async execute(args): Promise<string> {
    const id = String(args.id);
    const field = String(args.field);
    const rawValue = String(args.value);

    const profile = loadProfile(id);
    if (!profile) return `No profile for "${id}".`;

    let value: unknown;
    try {
      value = JSON.parse(rawValue);
    } catch {
      value = rawValue;
    }

    // Handle nested fields
    if (field.startsWith("tools.")) {
      if (!profile.tools) profile.tools = {};
      const subField = field.slice(6) as "allowlist" | "blocklist";
      (profile.tools as Record<string, unknown>)[subField] = value;
    } else if (field === "variables") {
      profile.variables = { ...profile.variables, ...value as Record<string, string> };
    } else if (field === "quietHours") {
      profile.quietHours = value as { start: number; end: number };
    } else {
      (profile as Record<string, unknown>)[field] = value;
    }

    saveProfile(id, profile);
    return `Profile "${id}" updated: ${field} = ${JSON.stringify(value)}`;
  },
});

registerSkill({
  name: "agents.prompt_edit",
  description: "Edit a cycle prompt for an agent. Saved to relay/agents/{id}/prompts/cycle-N.md.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Agent ID" },
      cycle: { type: "number", description: "Cycle number (0-based)" },
      content: { type: "string", description: "Full prompt content (Markdown)" },
    },
    required: ["id", "cycle", "content"],
  },
  async execute(args): Promise<string> {
    const id = String(args.id);
    const cycle = Number(args.cycle);
    const content = String(args.content);

    if (content.length < 10) return "Prompt too short (min 10 chars).";

    savePrompt(id, cycle, content);
    return `Prompt cycle-${cycle} saved for "${id}" (${content.length} chars).`;
  },
});

// ── Subordinate Agents ───────────────────────────────────────────────

registerSkill({
  name: "agents.spawn",
  description: "Spawn a one-shot subordinate agent to execute a specific task. Returns the result directly.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      instruction: { type: "string", description: "Task instruction for the subordinate" },
      parent: { type: "string", description: "Parent agent/entity ID (default: 'kingston')" },
      output_type: { type: "string", description: "Expected output: text, json, boolean, number (default: text)" },
      allowed_tools: { type: "string", description: "Comma-separated tool names to restrict (optional)" },
      timeout_seconds: { type: "number", description: "Timeout in seconds (default: 120)" },
    },
    required: ["instruction"],
  },
  async execute(args): Promise<string> {
    const result = await spawnSubordinate({
      parentId: String(args.parent || "kingston"),
      instruction: String(args.instruction),
      outputType: (String(args.output_type || "text")) as "text" | "json" | "boolean" | "number",
      allowedTools: args.allowed_tools ? String(args.allowed_tools).split(",").map(s => s.trim()) : undefined,
      timeoutMs: args.timeout_seconds ? Number(args.timeout_seconds) * 1000 : undefined,
    });

    return (
      `**Subordinate Result** (task #${result.taskId})\n` +
      `Status: ${result.status}\n` +
      `Duration: ${result.durationMs}ms\n` +
      `Result:\n${result.result.slice(0, 5000)}`
    );
  },
});

registerSkill({
  name: "agents.spawn_parallel",
  description: "Spawn multiple subordinate agents in parallel. Each gets a separate task. Returns all results.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      tasks: { type: "string", description: "JSON array of task objects: [{instruction, output_type?, allowed_tools?}]" },
      parent: { type: "string", description: "Parent agent/entity ID (default: 'kingston')" },
    },
    required: ["tasks"],
  },
  async execute(args): Promise<string> {
    const parentId = String(args.parent || "kingston");
    let tasks: Array<{ instruction: string; output_type?: string; allowed_tools?: string }>;

    try {
      tasks = JSON.parse(String(args.tasks));
    } catch {
      return "Invalid JSON for tasks array.";
    }

    if (!Array.isArray(tasks) || tasks.length === 0) return "Tasks must be a non-empty array.";
    if (tasks.length > 5) return "Max 5 parallel subordinates.";

    const results = await spawnParallel(
      parentId,
      tasks.map(t => ({
        instruction: t.instruction,
        outputType: (t.output_type || "text") as "text" | "json" | "boolean" | "number",
        allowedTools: t.allowed_tools ? t.allowed_tools.split(",").map(s => s.trim()) : undefined,
      })),
    );

    return results.map((r, i) =>
      `**Sub #${i + 1}** (task #${r.taskId}) — ${r.status} (${r.durationMs}ms)\n${r.result.slice(0, 1000)}`
    ).join("\n\n");
  },
});
