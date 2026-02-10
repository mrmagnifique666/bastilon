/**
 * Built-in skills: cron.add, cron.list, cron.remove, cron.pause, cron.resume
 * OpenClaw-style cron job management for Kingston.
 */
import { registerSkill } from "../loader.js";
import {
  addCronJob,
  listCronJobs,
  removeCronJob,
  pauseCronJob,
  resumeCronJob,
  type ScheduleType,
  type SessionTarget,
  type DeliveryMode,
} from "../../scheduler/cron.js";

registerSkill({
  name: "cron.add",
  description:
    "Create a scheduled cron job. scheduleType: 'at' (one-shot ISO datetime), 'every' (interval in ms), 'cron' (5-field cron expr). sessionTarget: 'isolated' (fresh session) or 'main' (context-aware heartbeat). deliveryMode: 'announce' (telegram.send) or 'none'.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Job name" },
      scheduleType: { type: "string", description: "'at' | 'every' | 'cron'" },
      scheduleValue: {
        type: "string",
        description: "ISO8601 datetime | interval ms | cron expression",
      },
      prompt: { type: "string", description: "Prompt to execute when job fires" },
      sessionTarget: { type: "string", description: "'isolated' (default) or 'main'" },
      deliveryMode: { type: "string", description: "'announce' (default) or 'none'" },
      modelOverride: { type: "string", description: "Optional: 'ollama' | 'haiku' | 'sonnet'" },
      timezone: { type: "string", description: "IANA timezone (default America/Toronto)" },
    },
    required: ["name", "scheduleType", "scheduleValue", "prompt"],
  },
  async execute(args): Promise<string> {
    const validTypes = ["at", "every", "cron"];
    if (!validTypes.includes(String(args.scheduleType))) {
      return `Invalid scheduleType "${args.scheduleType}". Use: ${validTypes.join(", ")}`;
    }

    const job = addCronJob({
      name: String(args.name),
      scheduleType: String(args.scheduleType) as ScheduleType,
      scheduleValue: String(args.scheduleValue),
      prompt: String(args.prompt),
      sessionTarget: (String(args.sessionTarget || "isolated")) as SessionTarget,
      deliveryMode: (String(args.deliveryMode || "announce")) as DeliveryMode,
      modelOverride: args.modelOverride ? String(args.modelOverride) : null,
      timezone: args.timezone ? String(args.timezone) : undefined,
    });

    const nextRun = job.next_run_at
      ? new Date(job.next_run_at * 1000).toLocaleString("fr-CA", { timeZone: job.timezone })
      : "immédiat";

    return (
      `Cron job créé:\n` +
      `- ID: ${job.id}\n` +
      `- Nom: ${job.name}\n` +
      `- Type: ${job.schedule_type} (${job.schedule_value})\n` +
      `- Session: ${job.session_target}\n` +
      `- Delivery: ${job.delivery_mode}\n` +
      `- Prochain: ${nextRun}`
    );
  },
});

registerSkill({
  name: "cron.list",
  description: "List all cron jobs (active and paused).",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {},
  },
  async execute(): Promise<string> {
    const jobs = listCronJobs();
    if (jobs.length === 0) return "Aucun cron job.";

    const lines = jobs.map((j) => {
      const status = j.enabled ? "✅ actif" : "⏸️ en pause";
      const nextRun = j.next_run_at
        ? new Date(j.next_run_at * 1000).toLocaleString("fr-CA", { timeZone: j.timezone })
        : "—";
      const lastRun = j.last_run_at
        ? new Date(j.last_run_at * 1000).toLocaleString("fr-CA", { timeZone: j.timezone })
        : "jamais";
      return (
        `**${j.name}** (${j.id}) — ${status}\n` +
        `  ${j.schedule_type}: ${j.schedule_value} | ${j.session_target}\n` +
        `  Dernier: ${lastRun} | Prochain: ${nextRun}\n` +
        `  Retries: ${j.retry_count}/${j.max_retries}`
      );
    });

    return `**${jobs.length} cron job(s):**\n\n${lines.join("\n\n")}`;
  },
});

registerSkill({
  name: "cron.remove",
  description: "Remove a cron job by ID.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Job ID" },
    },
    required: ["id"],
  },
  async execute(args): Promise<string> {
    const ok = removeCronJob(String(args.id));
    return ok ? `Cron job ${args.id} supprimé.` : `Cron job "${args.id}" introuvable.`;
  },
});

registerSkill({
  name: "cron.pause",
  description: "Pause a cron job by ID.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Job ID" },
    },
    required: ["id"],
  },
  async execute(args): Promise<string> {
    const ok = pauseCronJob(String(args.id));
    return ok ? `Cron job ${args.id} mis en pause.` : `Cron job "${args.id}" introuvable.`;
  },
});

registerSkill({
  name: "cron.resume",
  description: "Resume a paused cron job by ID.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Job ID" },
    },
    required: ["id"],
  },
  async execute(args): Promise<string> {
    const ok = resumeCronJob(String(args.id));
    return ok ? `Cron job ${args.id} repris.` : `Cron job "${args.id}" introuvable.`;
  },
});
