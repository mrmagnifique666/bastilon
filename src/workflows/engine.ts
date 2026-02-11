/**
 * Typed Workflow Engine — Lobster-style YAML pipelines with approval gates.
 *
 * Workflows are multi-step pipelines defined in YAML with:
 * - Sequential and parallel step execution
 * - Conditional branching (if/unless)
 * - Approval gates (pause until human approves)
 * - Variable passing between steps
 * - Error handling (retry, on_error)
 *
 * Storage: workflows in relay/workflows/ as .yaml files + state in SQLite.
 */
import fs from "node:fs";
import path from "node:path";
import { getDb } from "../storage/store.js";
import { getSkill } from "../skills/loader.js";
import { log } from "../utils/log.js";

const WORKFLOWS_DIR = path.resolve("relay/workflows");

// ── Types ────────────────────────────────────────────────────────────

export interface WorkflowStep {
  id: string;
  name: string;
  /** Skill to execute (e.g. "web.search") */
  skill: string;
  /** Arguments for the skill — supports {{variable}} interpolation */
  args: Record<string, unknown>;
  /** Condition: only run if truthy */
  if?: string;
  /** Steps to run in parallel within this step */
  parallel?: WorkflowStep[];
  /** Wait for human approval before executing */
  approval?: boolean;
  /** Number of retries on failure */
  retries?: number;
  /** Step to jump to on error */
  on_error?: string;
  /** Store result in this variable name */
  output?: string;
  /** Sub-pipeline: execute another workflow by name */
  pipeline?: string;
  /** Wait for external callback (webhook/event) before continuing */
  wait_callback?: boolean;
  /** Timeout in ms for wait_callback (default: 1h) */
  wait_timeout?: number;
  /** Merge strategy for parallel results: "all" | "first" | "concat" */
  merge?: MergeStrategy;
}

export interface WorkflowDefinition {
  name: string;
  description: string;
  /** Input variables the workflow expects */
  inputs?: Record<string, { type: string; default?: string; description?: string }>;
  steps: WorkflowStep[];
  /** Notification on completion */
  notify?: string;
  /** Error workflow to run if this workflow fails */
  on_error_workflow?: string;
  /** Webhook triggers that start this workflow */
  webhook_id?: string;
}

export type WorkflowStatus = "pending" | "running" | "paused" | "completed" | "failed";

export interface WorkflowRun {
  id: string;
  workflow_name: string;
  status: WorkflowStatus;
  current_step: string;
  variables: Record<string, unknown>;
  step_results: Record<string, { status: string; result: string; duration_ms: number }>;
  started_at: number;
  completed_at: number | null;
  error: string | null;
}

// ── DB Schema ────────────────────────────────────────────────────────

function ensureTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_runs (
      id TEXT PRIMARY KEY,
      workflow_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      current_step TEXT DEFAULT '',
      variables TEXT DEFAULT '{}',
      step_results TEXT DEFAULT '{}',
      started_at INTEGER DEFAULT (unixepoch()),
      completed_at INTEGER,
      error TEXT,
      created_at INTEGER DEFAULT (unixepoch())
    )
  `);
}

// ── YAML Parser (lightweight, no dependency) ─────────────────────────

/**
 * Parse a simple YAML workflow definition.
 * Supports nested objects, arrays, strings, numbers, booleans.
 * For complex YAML, use the JSON format alternative.
 */
export function parseWorkflow(content: string): WorkflowDefinition {
  // Try JSON first (workflows can be JSON too)
  if (content.trim().startsWith("{")) {
    return JSON.parse(content) as WorkflowDefinition;
  }

  // Simple YAML parser for workflow format
  const lines = content.split("\n");
  const wf: Partial<WorkflowDefinition> = {};
  const steps: WorkflowStep[] = [];
  let currentStep: Partial<WorkflowStep> | null = null;
  let inArgs = false;
  let currentArgs: Record<string, unknown> = {};

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    // Top-level fields
    if (!line.startsWith(" ") && !line.startsWith("\t")) {
      if (trimmed.startsWith("name:")) wf.name = trimmed.slice(5).trim().replace(/^["']|["']$/g, "");
      else if (trimmed.startsWith("description:")) wf.description = trimmed.slice(12).trim().replace(/^["']|["']$/g, "");
      else if (trimmed.startsWith("notify:")) wf.notify = trimmed.slice(7).trim().replace(/^["']|["']$/g, "");
      continue;
    }

    // Step definition (starts with "- ")
    if (trimmed.startsWith("- id:") || trimmed.startsWith("- name:")) {
      // Save previous step
      if (currentStep) {
        if (inArgs) currentStep.args = currentArgs;
        steps.push(currentStep as WorkflowStep);
      }
      currentStep = { args: {} };
      currentArgs = {};
      inArgs = false;

      const key = trimmed.startsWith("- id:") ? "id" : "name";
      const val = trimmed.slice(trimmed.indexOf(":") + 1).trim().replace(/^["']|["']$/g, "");
      (currentStep as Record<string, unknown>)[key] = val;
      continue;
    }

    // Step fields
    if (currentStep && trimmed.includes(":")) {
      const colonIdx = trimmed.indexOf(":");
      const key = trimmed.slice(0, colonIdx).trim();
      const val = trimmed.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, "");

      if (key === "args") {
        inArgs = true;
        continue;
      }

      if (inArgs && line.match(/^\s{4,}/)) {
        // Nested arg
        currentArgs[key] = parseValue(val);
        continue;
      } else {
        inArgs = false;
        if (Object.keys(currentArgs).length > 0) {
          currentStep.args = currentArgs;
          currentArgs = {};
        }
      }

      switch (key) {
        case "id": currentStep.id = val; break;
        case "name": currentStep.name = val; break;
        case "skill": currentStep.skill = val; break;
        case "if": currentStep.if = val; break;
        case "approval": currentStep.approval = val === "true"; break;
        case "retries": currentStep.retries = parseInt(val, 10); break;
        case "on_error": currentStep.on_error = val; break;
        case "output": currentStep.output = val; break;
        default:
          if (inArgs) currentArgs[key] = parseValue(val);
      }
    }
  }

  // Save last step
  if (currentStep) {
    if (inArgs) currentStep.args = currentArgs;
    steps.push(currentStep as WorkflowStep);
  }

  wf.steps = steps;
  if (!wf.name) wf.name = "unnamed";
  if (!wf.description) wf.description = "";

  return wf as WorkflowDefinition;
}

function parseValue(val: string): unknown {
  if (val === "true") return true;
  if (val === "false") return false;
  if (val === "null") return null;
  const num = Number(val);
  if (!isNaN(num) && val.length > 0) return num;
  return val;
}

// ── Variable Interpolation ───────────────────────────────────────────

function interpolate(template: unknown, vars: Record<string, unknown>): unknown {
  if (typeof template !== "string") return template;
  return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_, key) => {
    const val = vars[key];
    return val !== undefined ? String(val) : `{{${key}}}`;
  });
}

function interpolateArgs(args: Record<string, unknown>, vars: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(args)) {
    result[key] = interpolate(val, vars);
  }
  return result;
}

// ── Condition Evaluation ─────────────────────────────────────────────

function evaluateCondition(condition: string, vars: Record<string, unknown>): boolean {
  // Simple conditions: variable_name, !variable_name, var == "value", var != "value"
  const trimmed = condition.trim();

  if (trimmed.startsWith("!")) {
    const varName = trimmed.slice(1).trim();
    return !vars[varName];
  }

  if (trimmed.includes("==")) {
    const [left, right] = trimmed.split("==").map(s => s.trim().replace(/^["']|["']$/g, ""));
    return String(vars[left] ?? left) === right;
  }

  if (trimmed.includes("!=")) {
    const [left, right] = trimmed.split("!=").map(s => s.trim().replace(/^["']|["']$/g, ""));
    return String(vars[left] ?? left) !== right;
  }

  return !!vars[trimmed];
}

// ── Workflow Execution ───────────────────────────────────────────────

/** Load a workflow definition from file */
export function loadWorkflow(name: string): WorkflowDefinition | null {
  // Try .json first, then .yaml
  for (const ext of [".json", ".yaml", ".yml"]) {
    const filePath = path.join(WORKFLOWS_DIR, name + ext);
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, "utf-8");
      return parseWorkflow(content);
    }
  }
  return null;
}

/** List all available workflows */
export function listWorkflows(): Array<{ name: string; description: string; webhook_id?: string }> {
  if (!fs.existsSync(WORKFLOWS_DIR)) return [];
  const files = fs.readdirSync(WORKFLOWS_DIR).filter(f =>
    f.endsWith(".json") || f.endsWith(".yaml") || f.endsWith(".yml")
  );
  return files.map(f => {
    const name = f.replace(/\.(json|yaml|yml)$/, "");
    try {
      const content = fs.readFileSync(path.join(WORKFLOWS_DIR, f), "utf-8");
      const wf = parseWorkflow(content);
      return { name, description: wf.description, webhook_id: wf.webhook_id };
    } catch {
      return { name, description: "" };
    }
  });
}

/** Load all workflows and register their webhooks */
export function initWebhooks(): void {
  const workflows = listWorkflows();
  for (const wf of workflows) {
    if (wf.webhook_id) {
      registerWebhook(wf.webhook_id, wf.name);
    }
  }
  if (webhookTriggers.size > 0) {
    log.info(`[workflow] Registered ${webhookTriggers.size} webhook trigger(s)`);
  }
}

/** Save a workflow definition */
export function saveWorkflow(name: string, definition: WorkflowDefinition): void {
  fs.mkdirSync(WORKFLOWS_DIR, { recursive: true });
  const filePath = path.join(WORKFLOWS_DIR, name + ".json");
  fs.writeFileSync(filePath, JSON.stringify(definition, null, 2));
  log.info(`[workflow] Saved workflow: ${name}`);
}

/** Execute a single workflow step */
async function executeStep(
  step: WorkflowStep,
  vars: Record<string, unknown>,
  runId?: string,
): Promise<{ status: string; result: string; duration_ms: number }> {
  const startTime = Date.now();

  // Check condition
  if (step.if && !evaluateCondition(step.if, vars)) {
    return { status: "skipped", result: "Condition not met", duration_ms: 0 };
  }

  // Handle sub-pipeline
  if (step.pipeline) {
    const pipelineName = String(interpolate(step.pipeline, vars));
    log.info(`[workflow] Step ${step.id}: executing sub-pipeline "${pipelineName}"`);
    return executeSubPipeline(pipelineName, vars);
  }

  // Handle parallel steps with merge
  if (step.parallel && step.parallel.length > 0) {
    const results = await Promise.all(
      step.parallel.map(s => executeStep(s, vars, runId))
    );
    if (step.merge) {
      return mergeResults(results, step.merge);
    }
    const combined = results.map((r, i) =>
      `[${step.parallel![i].id || i}] ${r.status}: ${r.result}`
    ).join("\n");
    return { status: "completed", result: combined, duration_ms: Date.now() - startTime };
  }

  // Handle wait/callback
  if (step.wait_callback && runId) {
    const timeoutMs = step.wait_timeout || 3600000;
    log.info(`[workflow] Step ${step.id}: waiting for callback (timeout: ${timeoutMs / 1000}s)`);
    try {
      const callbackData = await waitForCallback(runId, timeoutMs);
      // Merge callback data into vars
      Object.assign(vars, callbackData);
      return { status: "completed", result: JSON.stringify(callbackData), duration_ms: Date.now() - startTime };
    } catch (err) {
      return { status: "error", result: err instanceof Error ? err.message : String(err), duration_ms: Date.now() - startTime };
    }
  }

  // Execute skill
  const skill = getSkill(step.skill);
  if (!skill) {
    return { status: "error", result: `Unknown skill: ${step.skill}`, duration_ms: Date.now() - startTime };
  }

  const args = interpolateArgs(step.args || {}, vars);
  let lastError = "";

  const maxAttempts = (step.retries || 0) + 1;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const result = await skill.execute(args);
      return { status: "completed", result, duration_ms: Date.now() - startTime };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt < maxAttempts - 1) {
        log.debug(`[workflow] Step ${step.id} attempt ${attempt + 1} failed, retrying...`);
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
  }

  return { status: "error", result: lastError, duration_ms: Date.now() - startTime };
}

/**
 * Run a complete workflow.
 * Returns when all steps complete or an approval gate is hit.
 */
export async function runWorkflow(
  name: string,
  inputs?: Record<string, unknown>,
): Promise<WorkflowRun> {
  ensureTable();
  const db = getDb();

  const definition = loadWorkflow(name);
  if (!definition) throw new Error(`Workflow not found: ${name}`);

  const runId = `wf-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const vars: Record<string, unknown> = { ...inputs };
  const stepResults: Record<string, { status: string; result: string; duration_ms: number }> = {};

  // Initialize run
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_name, status, variables, step_results, started_at)
     VALUES (?, ?, 'running', ?, '{}', unixepoch())`
  ).run(runId, name, JSON.stringify(vars));

  log.info(`[workflow] Starting workflow "${name}" (run: ${runId})`);

  let finalStatus: WorkflowStatus = "completed";
  let error: string | null = null;

  for (const step of definition.steps) {
    const stepId = step.id || step.name || step.skill;

    // Update current step
    db.prepare("UPDATE workflow_runs SET current_step = ? WHERE id = ?")
      .run(stepId, runId);

    // Approval gate
    if (step.approval) {
      finalStatus = "paused";
      db.prepare(
        "UPDATE workflow_runs SET status = 'paused', current_step = ?, variables = ?, step_results = ? WHERE id = ?"
      ).run(stepId, JSON.stringify(vars), JSON.stringify(stepResults), runId);

      log.info(`[workflow] Paused at approval gate: ${stepId}`);
      return loadRun(runId)!;
    }

    // Execute step
    const result = await executeStep(step, vars, runId);
    stepResults[stepId] = result;

    // Store output variable
    if (step.output && result.status === "completed") {
      vars[step.output] = result.result;
    }

    // Update state after each step (enables crash recovery)
    db.prepare(
      "UPDATE workflow_runs SET variables = ?, step_results = ? WHERE id = ?"
    ).run(JSON.stringify(vars), JSON.stringify(stepResults), runId);

    // Handle error
    if (result.status === "error") {
      if (step.on_error) {
        // Jump to error handler step
        log.warn(`[workflow] Step ${stepId} failed, jumping to ${step.on_error}`);
        vars["error"] = result.result;
        vars["error_step"] = stepId;
        continue;
      }
      finalStatus = "failed";
      error = `Step ${stepId} failed: ${result.result}`;
      break;
    }

    log.debug(`[workflow] Step ${stepId}: ${result.status} (${result.duration_ms}ms)`);
  }

  // Finalize
  db.prepare(
    `UPDATE workflow_runs SET status = ?, variables = ?, step_results = ?,
     completed_at = unixepoch(), error = ? WHERE id = ?`
  ).run(finalStatus, JSON.stringify(vars), JSON.stringify(stepResults), error, runId);

  log.info(`[workflow] Workflow "${name}" ${finalStatus} (run: ${runId})`);

  const finalRun = loadRun(runId)!;

  // Trigger error workflow if failed
  if (finalStatus === "failed" && definition.on_error_workflow) {
    // Fire and forget — don't block the caller
    runErrorWorkflow(definition.on_error_workflow, finalRun).catch(() => {});
  }

  return finalRun;
}

/** Resume a paused workflow (after approval) */
export async function resumeWorkflow(runId: string): Promise<WorkflowRun> {
  ensureTable();
  const db = getDb();

  const run = loadRun(runId);
  if (!run) throw new Error(`Workflow run not found: ${runId}`);
  if (run.status !== "paused") throw new Error(`Workflow is not paused (status: ${run.status})`);

  const definition = loadWorkflow(run.workflow_name);
  if (!definition) throw new Error(`Workflow definition not found: ${run.workflow_name}`);

  // Find the paused step and continue from there
  const vars = run.variables;
  const stepResults = run.step_results;
  let found = false;
  let finalStatus: WorkflowStatus = "completed";
  let error: string | null = null;

  db.prepare("UPDATE workflow_runs SET status = 'running' WHERE id = ?").run(runId);

  for (const step of definition.steps) {
    const stepId = step.id || step.name || step.skill;

    // Skip already completed steps
    if (stepResults[stepId] && !found) continue;

    // Found the paused step — execute it (approval was granted)
    if (stepId === run.current_step) {
      found = true;
      // Remove the approval flag for this execution
      step.approval = false;
    }

    if (!found) continue;

    // Check for next approval gate
    if (step.approval && stepId !== run.current_step) {
      finalStatus = "paused";
      db.prepare(
        "UPDATE workflow_runs SET status = 'paused', current_step = ?, variables = ?, step_results = ? WHERE id = ?"
      ).run(stepId, JSON.stringify(vars), JSON.stringify(stepResults), runId);
      return loadRun(runId)!;
    }

    // Execute step
    const result = await executeStep(step, vars, runId);
    stepResults[stepId] = result;

    if (step.output && result.status === "completed") {
      vars[step.output] = result.result;
    }

    // Persist state after each step
    db.prepare(
      "UPDATE workflow_runs SET variables = ?, step_results = ? WHERE id = ?"
    ).run(JSON.stringify(vars), JSON.stringify(stepResults), runId);

    if (result.status === "error") {
      if (step.on_error) {
        vars["error"] = result.result;
        continue;
      }
      finalStatus = "failed";
      error = `Step ${stepId} failed: ${result.result}`;
      break;
    }
  }

  db.prepare(
    `UPDATE workflow_runs SET status = ?, variables = ?, step_results = ?,
     completed_at = unixepoch(), error = ? WHERE id = ?`
  ).run(finalStatus, JSON.stringify(vars), JSON.stringify(stepResults), error, runId);

  return loadRun(runId)!;
}

/** Load a workflow run from DB */
export function loadRun(runId: string): WorkflowRun | null {
  ensureTable();
  const db = getDb();
  const row = db.prepare("SELECT * FROM workflow_runs WHERE id = ?").get(runId) as {
    id: string; workflow_name: string; status: string; current_step: string;
    variables: string; step_results: string; started_at: number;
    completed_at: number | null; error: string | null;
  } | undefined;

  if (!row) return null;

  return {
    id: row.id,
    workflow_name: row.workflow_name,
    status: row.status as WorkflowStatus,
    current_step: row.current_step,
    variables: JSON.parse(row.variables || "{}"),
    step_results: JSON.parse(row.step_results || "{}"),
    started_at: row.started_at,
    completed_at: row.completed_at,
    error: row.error,
  };
}

// ── Sub-Pipeline Support ──────────────────────────────────────────────

/**
 * Execute a sub-pipeline (another workflow) as a step.
 * Supports passing variables between parent and child workflows.
 */
async function executeSubPipeline(
  pipelineRef: string,
  vars: Record<string, unknown>,
): Promise<{ status: string; result: string; duration_ms: number }> {
  const startTime = Date.now();
  try {
    const run = await runWorkflow(pipelineRef, { ...vars });
    const resultStr = run.status === "completed"
      ? JSON.stringify(run.variables).slice(0, 2000)
      : run.error || `Sub-pipeline ${run.status}`;
    return { status: run.status === "completed" ? "completed" : "error", result: resultStr, duration_ms: Date.now() - startTime };
  } catch (err) {
    return { status: "error", result: err instanceof Error ? err.message : String(err), duration_ms: Date.now() - startTime };
  }
}

// ── Wait/Callback Support ─────────────────────────────────────────────

/** Pending callbacks: runId → { resolve, timer } */
const pendingCallbacks = new Map<string, {
  resolve: (data: Record<string, unknown>) => void;
  timer: ReturnType<typeof setTimeout>;
}>();

/**
 * Pause workflow execution and wait for an external callback.
 * The workflow resumes when `triggerCallback(runId, data)` is called.
 */
function waitForCallback(runId: string, timeoutMs: number = 3600000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCallbacks.delete(runId);
      reject(new Error(`Callback timeout after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    pendingCallbacks.set(runId, { resolve, timer });
  });
}

/**
 * Trigger a pending callback for a workflow run.
 * Called by webhook or external event.
 */
export function triggerCallback(runId: string, data: Record<string, unknown> = {}): boolean {
  const pending = pendingCallbacks.get(runId);
  if (!pending) return false;
  clearTimeout(pending.timer);
  pendingCallbacks.delete(runId);
  pending.resolve(data);
  log.info(`[workflow] Callback triggered for run ${runId}`);
  return true;
}

// ── Merge Pattern ─────────────────────────────────────────────────────

type MergeStrategy = "all" | "first" | "concat";

function mergeResults(
  results: Array<{ status: string; result: string; duration_ms: number }>,
  strategy: MergeStrategy = "all",
): { status: string; result: string; duration_ms: number } {
  const startTime = Date.now();
  switch (strategy) {
    case "first":
      return results[0] || { status: "error", result: "No results", duration_ms: 0 };
    case "concat":
      return {
        status: results.every(r => r.status === "completed") ? "completed" : "error",
        result: results.map(r => r.result).join("\n---\n"),
        duration_ms: Math.max(...results.map(r => r.duration_ms)),
      };
    case "all":
    default:
      return {
        status: results.every(r => r.status === "completed") ? "completed" : "error",
        result: JSON.stringify(results.map(r => ({ status: r.status, result: r.result.slice(0, 500) }))),
        duration_ms: Math.max(...results.map(r => r.duration_ms)),
      };
  }
}

// ── Error Workflows ───────────────────────────────────────────────────

/** Run an error handler workflow when a pipeline fails */
async function runErrorWorkflow(
  errorWorkflowName: string,
  failedRun: WorkflowRun,
): Promise<void> {
  try {
    const errorInputs = {
      failed_workflow: failedRun.workflow_name,
      failed_run_id: failedRun.id,
      error: failedRun.error || "Unknown error",
      failed_step: failedRun.current_step,
    };
    log.info(`[workflow] Running error workflow "${errorWorkflowName}" for failed run ${failedRun.id}`);
    await runWorkflow(errorWorkflowName, errorInputs);
  } catch (err) {
    log.warn(`[workflow] Error workflow "${errorWorkflowName}" failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Webhook Triggers ──────────────────────────────────────────────────

/** Registry of webhook-triggered workflows */
const webhookTriggers = new Map<string, { workflowName: string; inputMapping?: Record<string, string> }>();

/** Register a webhook trigger for a workflow */
export function registerWebhook(
  webhookId: string,
  workflowName: string,
  inputMapping?: Record<string, string>,
): void {
  webhookTriggers.set(webhookId, { workflowName, inputMapping });
  log.info(`[workflow] Registered webhook "${webhookId}" → workflow "${workflowName}"`);
}

/** Handle an incoming webhook trigger */
export async function handleWebhookTrigger(
  webhookId: string,
  payload: Record<string, unknown>,
): Promise<WorkflowRun | null> {
  const trigger = webhookTriggers.get(webhookId);
  if (!trigger) return null;

  // Map payload to workflow inputs
  const inputs: Record<string, unknown> = {};
  if (trigger.inputMapping) {
    for (const [inputKey, payloadKey] of Object.entries(trigger.inputMapping)) {
      inputs[inputKey] = payload[payloadKey] ?? payload[inputKey];
    }
  } else {
    Object.assign(inputs, payload);
  }

  log.info(`[workflow] Webhook "${webhookId}" triggered workflow "${trigger.workflowName}"`);
  return runWorkflow(trigger.workflowName, inputs);
}

/** List all registered webhook triggers */
export function listWebhooks(): Array<{ webhookId: string; workflowName: string }> {
  return Array.from(webhookTriggers.entries()).map(([webhookId, t]) => ({
    webhookId,
    workflowName: t.workflowName,
  }));
}

/** List recent workflow runs */
export function listRuns(limit = 10): WorkflowRun[] {
  ensureTable();
  const db = getDb();
  const rows = db.prepare(
    "SELECT * FROM workflow_runs ORDER BY started_at DESC LIMIT ?"
  ).all(limit) as Array<{
    id: string; workflow_name: string; status: string; current_step: string;
    variables: string; step_results: string; started_at: number;
    completed_at: number | null; error: string | null;
  }>;

  return rows.map(row => ({
    id: row.id,
    workflow_name: row.workflow_name,
    status: row.status as WorkflowStatus,
    current_step: row.current_step,
    variables: JSON.parse(row.variables || "{}"),
    step_results: JSON.parse(row.step_results || "{}"),
    started_at: row.started_at,
    completed_at: row.completed_at,
    error: row.error,
  }));
}
