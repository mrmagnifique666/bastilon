/**
 * Supervisor Skills — Kingston can query/interact with the supervisor.
 *
 * Skills:
 * - supervisor.status — View supervisor health report
 * - supervisor.commit — Track a commitment/promise
 * - supervisor.commitments — List pending commitments
 * - supervisor.resolve — Mark a commitment as resolved
 */
import { registerSkill } from "../loader.js";

registerSkill({
  name: "supervisor.status",
  description: "View the supervisor accountability report — task success rates, failures, overdue commitments.",
  adminOnly: true,
  argsSchema: { type: "object", properties: {} },
  async execute(): Promise<string> {
    const { buildStatusReport } = await import("../../supervisor/supervisor.js");
    return buildStatusReport();
  },
});

registerSkill({
  name: "supervisor.commit",
  description: "Track a commitment — something Kingston promised to do. The supervisor will follow up if it's not resolved by the deadline.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      source: { type: "string", description: "Who/what made the commitment (e.g. 'Kingston', 'Mind agent', 'Nicolas')" },
      promise: { type: "string", description: "What was promised (e.g. 'Review trading strategy by end of week')" },
      deadline_minutes: { type: "number", description: "Deadline in minutes from now (e.g. 60 for 1 hour, 1440 for 1 day)" },
    },
    required: ["source", "promise"],
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const { addCommitment } = await import("../../supervisor/supervisor.js");
    const source = String(args.source || "Kingston");
    const promise = String(args.promise);
    const deadlineMin = args.deadline_minutes ? Number(args.deadline_minutes) : undefined;
    const id = addCommitment(source, promise, deadlineMin);
    const deadlineStr = deadlineMin
      ? ` (deadline: ${deadlineMin >= 60 ? `${Math.round(deadlineMin / 60)}h` : `${deadlineMin}min`})`
      : " (no deadline)";
    return `Commitment #${id} tracked: "${promise}"${deadlineStr}. Supervisor will follow up.`;
  },
});

registerSkill({
  name: "supervisor.commitments",
  description: "List pending commitments tracked by the supervisor.",
  adminOnly: true,
  argsSchema: { type: "object", properties: {} },
  async execute(): Promise<string> {
    const { default: Database } = await import("better-sqlite3");
    const path = await import("node:path");
    const db = new Database(path.resolve("relay.db"));
    const rows = db.prepare(
      "SELECT id, source, promise, deadline, follow_up_count, created_at FROM supervisor_commitments WHERE status = 'pending' ORDER BY created_at DESC LIMIT 20"
    ).all() as Array<{ id: number; source: string; promise: string; deadline: number | null; follow_up_count: number; created_at: number }>;
    db.close();

    if (rows.length === 0) return "No pending commitments.";

    const now = Math.floor(Date.now() / 1000);
    const lines = rows.map(r => {
      const age = Math.round((now - r.created_at) / 3600);
      const deadlineStr = r.deadline
        ? r.deadline < now
          ? ` OVERDUE (${Math.round((now - r.deadline) / 3600)}h)`
          : ` (due in ${Math.round((r.deadline - now) / 3600)}h)`
        : "";
      return `#${r.id} [${r.source}] ${r.promise}${deadlineStr} — ${age}h ago, ${r.follow_up_count} follow-ups`;
    });

    return `Pending commitments (${rows.length}):\n${lines.join("\n")}`;
  },
});

registerSkill({
  name: "supervisor.resolve",
  description: "Mark a commitment as resolved.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      id: { type: "number", description: "Commitment ID to resolve" },
      resolution: { type: "string", description: "What was done to resolve it" },
    },
    required: ["id", "resolution"],
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const { resolveCommitment } = await import("../../supervisor/supervisor.js");
    const id = Number(args.id);
    const resolution = String(args.resolution);
    resolveCommitment(id, resolution);
    return `Commitment #${id} resolved: "${resolution}"`;
  },
});
