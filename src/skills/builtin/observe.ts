/**
 * Observation skills — Kingston's feedback loop.
 * Skills: observe.schedule, observe.check, observe.pending, observe.results
 *
 * This is how Kingston learns from his own actions:
 * 1. After an action, schedule an observation (observe.schedule)
 * 2. The scheduler checks pending observations periodically
 * 3. Results are stored and fed back into context
 */
import { registerSkill, getSkill } from "../loader.js";
import {
  scheduleObservation,
  getPendingObservations,
  completeObservation,
  failObservation,
  getRecentObservations,
  ensureObservationTable,
} from "../../observe/observer.js";
import { log } from "../../utils/log.js";

// Ensure table exists on import
try { ensureObservationTable(); } catch { /* DB not ready yet */ }

registerSkill({
  name: "observe.schedule",
  description:
    "Schedule a follow-up observation after an action. Kingston will check the result later. " +
    "Example: After posting on Moltbook, observe engagement in 2h. After a trade, check P&L at EOD. " +
    "delay_minutes defaults to 120 (2h).",
  argsSchema: {
    type: "object",
    properties: {
      action_type: { type: "string", description: "Category: moltbook_post, trade, email, deploy, content, custom" },
      detail: { type: "string", description: "What was done (e.g. 'Posted article about AI trends')" },
      delay_minutes: { type: "number", description: "Minutes to wait before checking (default: 120)" },
      check_skill: { type: "string", description: "Skill to run for verification (e.g. 'moltbook.post_details')" },
      check_args: { type: "string", description: "JSON args for the check skill" },
      action_id: { type: "string", description: "ID to track (post ID, trade ID, etc.)" },
    },
    required: ["action_type", "detail"],
  },
  async execute(args): Promise<string> {
    const delayMs = (Number(args.delay_minutes) || 120) * 60_000;
    let checkArgs: Record<string, unknown> | undefined;
    if (args.check_args) {
      try { checkArgs = JSON.parse(String(args.check_args)); }
      catch { return "Invalid check_args JSON"; }
    }

    const id = scheduleObservation(
      String(args.action_type),
      String(args.detail),
      delayMs,
      args.check_skill ? String(args.check_skill) : undefined,
      checkArgs,
      args.action_id ? String(args.action_id) : undefined,
    );

    const checkTime = new Date(Date.now() + delayMs).toLocaleString("fr-CA", { timeZone: "America/Toronto" });
    return `Observation #${id} programmée: "${args.detail}"\nVérification: ${checkTime}\nSkill: ${args.check_skill || "aucun (vérification manuelle)"}`;
  },
});

registerSkill({
  name: "observe.check",
  description:
    "Run all pending observations that are due. Executes check skills, stores results, " +
    "and logs to episodic memory. Called automatically by the scheduler, but can be triggered manually.",
  argsSchema: { type: "object", properties: {} },
  adminOnly: true,
  async execute(): Promise<string> {
    const pending = getPendingObservations();
    if (pending.length === 0) return "Aucune observation en attente.";

    const results: string[] = [];
    for (const obs of pending) {
      try {
        let result: string;

        if (obs.check_skill) {
          // Run the check skill
          const skill = getSkill(obs.check_skill);
          if (!skill) {
            failObservation(obs.id, `Skill "${obs.check_skill}" introuvable`);
            results.push(`#${obs.id} ❌ Skill introuvable: ${obs.check_skill}`);
            continue;
          }

          const checkArgs = obs.check_args ? JSON.parse(obs.check_args) : {};
          result = await skill.execute(checkArgs);
        } else {
          // No check skill — mark as needing manual review
          result = "Vérification manuelle requise";
        }

        completeObservation(obs.id, result);

        // Log to episodic memory if available
        try {
          const episodicSkill = getSkill("episodic.log");
          if (episodicSkill) {
            await episodicSkill.execute({
              event: `Observation result: ${obs.action_type} — ${obs.action_detail}`,
              detail: result.slice(0, 500),
              importance: 6,
              valence: result.includes("error") || result.includes("Error") ? -1 : 1,
            });
          }
        } catch { /* episodic logging is best-effort */ }

        const preview = result.length > 100 ? result.slice(0, 97) + "..." : result;
        results.push(`#${obs.id} ✅ ${obs.action_type}: ${preview}`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        failObservation(obs.id, errMsg);
        results.push(`#${obs.id} ❌ ${obs.action_type}: ${errMsg}`);
      }
    }

    return `Observations vérifiées: ${results.length}\n\n${results.join("\n")}`;
  },
});

registerSkill({
  name: "observe.pending",
  description: "List all pending observations (scheduled but not yet checked).",
  argsSchema: { type: "object", properties: {} },
  async execute(): Promise<string> {
    const db = (await import("../../storage/store.js")).getDb();
    ensureObservationTable();
    const pending = db.prepare(
      "SELECT * FROM observations WHERE status = 'pending' ORDER BY check_at"
    ).all() as Array<{ id: number; action_type: string; action_detail: string; check_at: number; check_skill: string | null }>;

    if (pending.length === 0) return "Aucune observation en attente.";

    const lines = pending.map(o => {
      const checkTime = new Date(o.check_at * 1000).toLocaleString("fr-CA", { timeZone: "America/Toronto" });
      return `#${o.id} [${o.action_type}] ${o.action_detail.slice(0, 60)} → ${checkTime}${o.check_skill ? ` (${o.check_skill})` : ""}`;
    });

    return `**${pending.length} observation(s) en attente:**\n\n${lines.join("\n")}`;
  },
});

registerSkill({
  name: "observe.results",
  description: "Show recent observation results (completed and failed). Shows what Kingston learned from his actions.",
  argsSchema: {
    type: "object",
    properties: {
      limit: { type: "number", description: "Number of results (default: 10)" },
      action_type: { type: "string", description: "Filter by type (e.g. 'moltbook_post', 'trade')" },
    },
  },
  async execute(args): Promise<string> {
    const limit = Number(args.limit) || 10;
    const recent = getRecentObservations(limit);

    if (recent.length === 0) return "Aucune observation enregistrée.";

    const filtered = args.action_type
      ? recent.filter(o => o.action_type === String(args.action_type))
      : recent;

    const lines = filtered.map(o => {
      const status = o.status === "completed" ? "✅" : o.status === "failed" ? "❌" : "⏳";
      const date = new Date(o.created_at * 1000).toLocaleDateString("fr-CA", { timeZone: "America/Toronto" });
      const resultPreview = o.result ? o.result.slice(0, 80) : "en attente";
      return `${status} [${date}] ${o.action_type}: ${o.action_detail.slice(0, 50)}\n   → ${resultPreview}`;
    });

    return `**Observations récentes (${filtered.length}):**\n\n${lines.join("\n\n")}`;
  },
});

log.info("[skills] Registered observe.schedule/check/pending/results (4 observation skills)");
