/**
 * Workflow skills — create, run, list, and manage typed workflow pipelines.
 */
import { registerSkill } from "../loader.js";
import {
  loadWorkflow, listWorkflows, saveWorkflow, runWorkflow,
  resumeWorkflow, listRuns, loadRun,
  type WorkflowDefinition, type WorkflowStep,
} from "../../workflows/engine.js";

registerSkill({
  name: "workflow.create",
  description: "Create a new workflow pipeline from a JSON definition. Steps execute skills in sequence with variable passing.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Workflow name (alphanumeric + hyphens)" },
      definition: { type: "string", description: "JSON string of the workflow definition with name, description, steps[]" },
    },
    required: ["name", "definition"],
  },
  async execute(args): Promise<string> {
    const name = String(args.name).replace(/[^a-zA-Z0-9-_]/g, "");
    if (!name) return "Invalid workflow name.";

    try {
      const def = JSON.parse(String(args.definition)) as WorkflowDefinition;
      if (!def.steps || !Array.isArray(def.steps)) return "Definition must have a steps[] array.";
      if (def.steps.length === 0) return "Workflow must have at least one step.";

      // Validate steps have required fields
      for (let i = 0; i < def.steps.length; i++) {
        const step = def.steps[i];
        if (!step.skill && !step.parallel) {
          return `Step ${i} missing 'skill' field.`;
        }
        if (!step.id) step.id = `step-${i}`;
        if (!step.name) step.name = step.skill || `parallel-${i}`;
      }

      def.name = name;
      saveWorkflow(name, def);
      return `Workflow "${name}" created with ${def.steps.length} steps.`;
    } catch (err) {
      return `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

registerSkill({
  name: "workflow.run",
  description: "Execute a workflow by name. Pass input variables as JSON. Returns run status and results.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Workflow name to run" },
      inputs: { type: "string", description: "JSON string of input variables (optional)" },
    },
    required: ["name"],
  },
  async execute(args): Promise<string> {
    const name = String(args.name);
    const inputs = args.inputs ? JSON.parse(String(args.inputs)) : {};

    try {
      const run = await runWorkflow(name, inputs);
      const stepSummary = Object.entries(run.step_results)
        .map(([id, r]) => `  ${id}: ${r.status} (${r.duration_ms}ms)`)
        .join("\n");

      return (
        `Workflow "${name}" — ${run.status}\n` +
        `Run ID: ${run.id}\n` +
        (run.status === "paused" ? `Paused at: ${run.current_step} (use workflow.approve to continue)\n` : "") +
        (run.error ? `Error: ${run.error}\n` : "") +
        `Steps:\n${stepSummary || "  (none executed)"}`
      );
    } catch (err) {
      return `Failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

registerSkill({
  name: "workflow.approve",
  description: "Approve a paused workflow to continue past its approval gate.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      run_id: { type: "string", description: "Workflow run ID to approve" },
    },
    required: ["run_id"],
  },
  async execute(args): Promise<string> {
    try {
      const run = await resumeWorkflow(String(args.run_id));
      const stepSummary = Object.entries(run.step_results)
        .map(([id, r]) => `  ${id}: ${r.status} (${r.duration_ms}ms)`)
        .join("\n");

      return (
        `Workflow "${run.workflow_name}" resumed — ${run.status}\n` +
        (run.status === "paused" ? `Next approval gate: ${run.current_step}\n` : "") +
        (run.error ? `Error: ${run.error}\n` : "") +
        `Steps:\n${stepSummary}`
      );
    } catch (err) {
      return `Failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

registerSkill({
  name: "workflow.list",
  description: "List all available workflow definitions and recent runs.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      show_runs: { type: "string", description: "Set to 'true' to also show recent runs" },
    },
  },
  async execute(args): Promise<string> {
    const workflows = listWorkflows();
    const showRuns = String(args.show_runs) === "true";

    let output = "**Available Workflows:**\n";
    if (workflows.length === 0) {
      output += "  (none — use workflow.create to add one)\n";
    } else {
      for (const wf of workflows) {
        output += `  - **${wf.name}**: ${wf.description || "(no description)"}\n`;
      }
    }

    if (showRuns) {
      const runs = listRuns(5);
      output += "\n**Recent Runs:**\n";
      if (runs.length === 0) {
        output += "  (none)\n";
      } else {
        for (const run of runs) {
          const steps = Object.keys(run.step_results).length;
          output += `  - ${run.id} — "${run.workflow_name}" — ${run.status} (${steps} steps)\n`;
        }
      }
    }

    return output;
  },
});

registerSkill({
  name: "workflow.status",
  description: "Get detailed status of a specific workflow run.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      run_id: { type: "string", description: "Workflow run ID" },
    },
    required: ["run_id"],
  },
  async execute(args): Promise<string> {
    const run = loadRun(String(args.run_id));
    if (!run) return `Run not found: ${args.run_id}`;

    const stepSummary = Object.entries(run.step_results)
      .map(([id, r]) => `  ${id}: ${r.status} (${r.duration_ms}ms)\n    → ${r.result.slice(0, 200)}`)
      .join("\n");

    return (
      `**Workflow Run: ${run.id}**\n` +
      `Workflow: ${run.workflow_name}\n` +
      `Status: ${run.status}\n` +
      `Current step: ${run.current_step}\n` +
      (run.error ? `Error: ${run.error}\n` : "") +
      `Started: ${new Date(run.started_at * 1000).toLocaleString("fr-CA", { timeZone: "America/Toronto" })}\n` +
      (run.completed_at ? `Completed: ${new Date(run.completed_at * 1000).toLocaleString("fr-CA", { timeZone: "America/Toronto" })}\n` : "") +
      `\nVariables: ${JSON.stringify(run.variables).slice(0, 500)}\n` +
      `\nSteps:\n${stepSummary || "  (none)"}`
    );
  },
});
