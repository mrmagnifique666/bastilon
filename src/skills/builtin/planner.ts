/**
 * Built-in skills: planner.create, planner.list, planner.execute, planner.adapt
 * Autonomous goal decomposition and execution tracking.
 */
import { registerSkill } from "../loader.js";
import { getDb } from "../../storage/store.js";

interface PlanStep {
  description: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  result?: string;
}

interface PlanRow {
  id: number;
  goal: string;
  steps: string;
  status: string;
  current_step: number;
  created_by: string;
  created_at: number;
  updated_at: number;
}

registerSkill({
  name: "planner.create",
  description:
    "Create a new plan by decomposing a goal into ordered steps. Returns the plan ID for tracking.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      goal: { type: "string", description: "The goal to achieve" },
      steps: {
        type: "string",
        description:
          'JSON array of step descriptions, e.g. ["Research competitors","Draft proposal","Send email"]',
      },
      created_by: {
        type: "string",
        description: "Who created this plan (default: kingston)",
      },
    },
    required: ["goal", "steps"],
  },
  async execute(args): Promise<string> {
    const goal = String(args.goal);
    const createdBy = String(args.created_by || "kingston");

    let stepDescs: string[];
    try {
      stepDescs = JSON.parse(String(args.steps));
      if (!Array.isArray(stepDescs)) throw new Error("not an array");
    } catch {
      return 'Error: steps must be a JSON array of strings, e.g. ["step1","step2"]';
    }

    const steps: PlanStep[] = stepDescs.map((d) => ({
      description: String(d),
      status: "pending" as const,
    }));

    const d = getDb();
    const info = d
      .prepare(
        "INSERT INTO plans (goal, steps, created_by) VALUES (?, ?, ?)",
      )
      .run(goal, JSON.stringify(steps), createdBy);

    return (
      `Plan #${info.lastInsertRowid} created: "${goal}"\n` +
      `${steps.length} steps:\n` +
      steps.map((s, i) => `  ${i + 1}. ${s.description}`).join("\n")
    );
  },
});

registerSkill({
  name: "planner.list",
  description: "List all plans with their status and progress.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      status: {
        type: "string",
        description: "Filter by status: pending, in_progress, completed, failed (default: all)",
      },
    },
  },
  async execute(args): Promise<string> {
    const d = getDb();
    const status = args.status as string | undefined;

    let rows: PlanRow[];
    if (status) {
      rows = d
        .prepare("SELECT * FROM plans WHERE status = ? ORDER BY created_at DESC LIMIT 20")
        .all(status) as PlanRow[];
    } else {
      rows = d
        .prepare("SELECT * FROM plans ORDER BY created_at DESC LIMIT 20")
        .all() as PlanRow[];
    }

    if (rows.length === 0) return "No plans found.";

    return rows
      .map((p) => {
        const steps: PlanStep[] = JSON.parse(p.steps);
        const done = steps.filter((s) => s.status === "completed").length;
        return (
          `**#${p.id}** [${p.status}] ${p.goal}\n` +
          `  Progress: ${done}/${steps.length} steps | By: ${p.created_by}\n` +
          `  Created: ${new Date(p.created_at * 1000).toLocaleString("fr-CA", { timeZone: "America/Toronto" })}`
        );
      })
      .join("\n\n");
  },
});

registerSkill({
  name: "planner.execute",
  description:
    "Advance a plan by marking the current step as completed (with result) or failed. Auto-advances to next step.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      plan_id: { type: "number", description: "Plan ID" },
      outcome: {
        type: "string",
        description: "Step outcome: 'completed' or 'failed' (default: completed)",
      },
      result: {
        type: "string",
        description: "Result or output of the completed step",
      },
    },
    required: ["plan_id"],
  },
  async execute(args): Promise<string> {
    const planId = args.plan_id as number;
    const outcome = (args.outcome as string) || "completed";
    const result = args.result as string | undefined;
    const d = getDb();

    const row = d
      .prepare("SELECT * FROM plans WHERE id = ?")
      .get(planId) as PlanRow | undefined;
    if (!row) return `Plan #${planId} not found.`;

    const steps: PlanStep[] = JSON.parse(row.steps);
    const idx = row.current_step;

    if (idx >= steps.length) return `Plan #${planId} has no more steps to execute.`;

    // Update current step
    steps[idx].status = outcome === "failed" ? "failed" : "completed";
    if (result) steps[idx].result = result;

    const nextStep = outcome === "failed" ? idx : idx + 1;
    const allDone = nextStep >= steps.length;
    const planStatus = outcome === "failed"
      ? "failed"
      : allDone
        ? "completed"
        : "in_progress";

    d.prepare(
      "UPDATE plans SET steps = ?, current_step = ?, status = ?, updated_at = unixepoch() WHERE id = ?",
    ).run(JSON.stringify(steps), nextStep, planStatus, planId);

    let response = `Plan #${planId} step ${idx + 1}: "${steps[idx].description}" → **${outcome}**`;
    if (result) response += `\n  Result: ${result}`;

    if (allDone) {
      response += `\n\nPlan **completed** — all ${steps.length} steps done.`;
    } else if (outcome !== "failed" && nextStep < steps.length) {
      response += `\n\nNext step ${nextStep + 1}: "${steps[nextStep].description}"`;
    } else if (outcome === "failed") {
      response += `\n\nPlan **failed** at step ${idx + 1}. Use planner.adapt to adjust.`;
    }

    return response;
  },
});

registerSkill({
  name: "planner.adapt",
  description:
    "Adapt a plan: replace remaining steps, reset a failed plan, or add new steps.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      plan_id: { type: "number", description: "Plan ID" },
      action: {
        type: "string",
        description: "'reset' to retry from current step, 'replace_remaining' to set new steps, 'add' to append steps",
      },
      steps: {
        type: "string",
        description: 'JSON array of new step descriptions (for replace_remaining or add)',
      },
    },
    required: ["plan_id", "action"],
  },
  async execute(args): Promise<string> {
    const planId = args.plan_id as number;
    const action = String(args.action);
    const d = getDb();

    const row = d
      .prepare("SELECT * FROM plans WHERE id = ?")
      .get(planId) as PlanRow | undefined;
    if (!row) return `Plan #${planId} not found.`;

    const steps: PlanStep[] = JSON.parse(row.steps);
    let currentStep = row.current_step;

    switch (action) {
      case "reset": {
        // Reset current failed step to pending
        if (currentStep < steps.length) {
          steps[currentStep].status = "pending";
          steps[currentStep].result = undefined;
        }
        d.prepare(
          "UPDATE plans SET steps = ?, status = 'in_progress', updated_at = unixepoch() WHERE id = ?",
        ).run(JSON.stringify(steps), planId);
        return `Plan #${planId} reset — step ${currentStep + 1} ready for retry.`;
      }

      case "replace_remaining": {
        let newDescs: string[];
        try {
          newDescs = JSON.parse(String(args.steps));
        } catch {
          return "Error: steps must be a JSON array.";
        }
        // Keep completed steps, replace everything from current_step onward
        const kept = steps.slice(0, currentStep);
        const newSteps: PlanStep[] = newDescs.map((d) => ({
          description: String(d),
          status: "pending" as const,
        }));
        const merged = [...kept, ...newSteps];

        d.prepare(
          "UPDATE plans SET steps = ?, status = 'in_progress', updated_at = unixepoch() WHERE id = ?",
        ).run(JSON.stringify(merged), planId);
        return `Plan #${planId} adapted — ${kept.length} completed + ${newSteps.length} new steps.`;
      }

      case "add": {
        let addDescs: string[];
        try {
          addDescs = JSON.parse(String(args.steps));
        } catch {
          return "Error: steps must be a JSON array.";
        }
        const added: PlanStep[] = addDescs.map((d) => ({
          description: String(d),
          status: "pending" as const,
        }));
        steps.push(...added);

        d.prepare(
          "UPDATE plans SET steps = ?, updated_at = unixepoch() WHERE id = ?",
        ).run(JSON.stringify(steps), planId);
        return `Plan #${planId}: added ${added.length} steps (now ${steps.length} total).`;
      }

      default:
        return `Unknown action "${action}". Use: reset, replace_remaining, or add.`;
    }
  },
});
