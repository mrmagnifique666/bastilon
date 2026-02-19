/**
 * Tool Validation Pipeline — wraps every skill's execute() with:
 *   1. Input validation against argsSchema (JSON Schema)
 *   2. AbortSignal timeout (30s default, configurable per-skill)
 *   3. Error classification (input_error | execution_error | timeout_error)
 *   4. Execution metrics logging (duration, success/failure, tool name)
 *
 * Inspired by OpenClaw's tool execution patterns.
 * Applied automatically by registerSkill() in loader.ts.
 */
import { log } from "../utils/log.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ErrorClass = "input_error" | "execution_error" | "timeout_error";

export interface PipelineResult {
  /** Whether the skill succeeded */
  ok: boolean;
  /** The string result (either success output or formatted error message) */
  result: string;
  /** Error classification — only set when ok=false */
  errorClass?: ErrorClass;
  /** Wall-clock duration in milliseconds */
  durationMs: number;
  /** Skill name (for downstream logging) */
  skillName: string;
}

export interface PipelineOptions {
  /** Per-skill timeout in milliseconds (default 30 000) */
  timeoutMs?: number;
  /** Skip input validation (useful for internal/trusted callers) */
  skipValidation?: boolean;
}

/** Shape imported from loader.ts — duplicated here to avoid circular deps */
interface ToolSchema {
  type: "object";
  properties: Record<string, { type: string; description?: string }>;
  required?: string[];
}

interface WrappableSkill {
  name: string;
  description: string;
  argsSchema: ToolSchema;
  adminOnly?: boolean;
  /** Original execute — gets replaced by the pipeline wrapper */
  execute(args: Record<string, unknown>): Promise<string>;
  /** Optional per-skill timeout override */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Metrics store — lightweight in-memory ring buffer
// ---------------------------------------------------------------------------

const METRICS_BUFFER_SIZE = 500;

export interface SkillMetric {
  skillName: string;
  ok: boolean;
  errorClass?: ErrorClass;
  durationMs: number;
  timestamp: number; // Date.now()
}

const metricsBuffer: SkillMetric[] = [];

/** Get recent execution metrics (most recent first). */
export function getSkillMetrics(count = 100): SkillMetric[] {
  return metricsBuffer.slice(-count).reverse();
}

/** Get aggregated stats for a skill (or all skills). */
export function getSkillStats(skillName?: string): {
  total: number;
  successes: number;
  failures: number;
  avgDurationMs: number;
  timeouts: number;
  inputErrors: number;
  executionErrors: number;
} {
  const filtered = skillName
    ? metricsBuffer.filter((m) => m.skillName === skillName)
    : metricsBuffer;

  const total = filtered.length;
  if (total === 0) {
    return { total: 0, successes: 0, failures: 0, avgDurationMs: 0, timeouts: 0, inputErrors: 0, executionErrors: 0 };
  }

  const successes = filtered.filter((m) => m.ok).length;
  const failures = total - successes;
  const avgDurationMs = Math.round(filtered.reduce((s, m) => s + m.durationMs, 0) / total);
  const timeouts = filtered.filter((m) => m.errorClass === "timeout_error").length;
  const inputErrors = filtered.filter((m) => m.errorClass === "input_error").length;
  const executionErrors = filtered.filter((m) => m.errorClass === "execution_error").length;

  return { total, successes, failures, avgDurationMs, timeouts, inputErrors, executionErrors };
}

function recordMetric(metric: SkillMetric): void {
  metricsBuffer.push(metric);
  if (metricsBuffer.length > METRICS_BUFFER_SIZE) {
    metricsBuffer.shift();
  }
}

/** Get per-skill health scores. Returns skills sorted by health (worst first). */
export function getSkillHealthReport(): Array<{
  name: string;
  total: number;
  successRate: number;
  avgMs: number;
  lastError?: string;
  health: "healthy" | "degraded" | "broken";
}> {
  // Group metrics by skill
  const bySkill = new Map<string, SkillMetric[]>();
  for (const m of metricsBuffer) {
    if (!bySkill.has(m.skillName)) bySkill.set(m.skillName, []);
    bySkill.get(m.skillName)!.push(m);
  }

  const report: Array<{
    name: string;
    total: number;
    successRate: number;
    avgMs: number;
    lastError?: string;
    health: "healthy" | "degraded" | "broken";
  }> = [];

  for (const [name, metrics] of bySkill) {
    const total = metrics.length;
    if (total < 2) continue; // Skip skills with < 2 calls
    const successes = metrics.filter(m => m.ok).length;
    const successRate = Math.round((successes / total) * 100);
    const avgMs = Math.round(metrics.reduce((s, m) => s + m.durationMs, 0) / total);
    const lastFail = metrics.filter(m => !m.ok).pop();

    let health: "healthy" | "degraded" | "broken" = "healthy";
    if (successRate < 50) health = "broken";
    else if (successRate < 80) health = "degraded";

    report.push({
      name,
      total,
      successRate,
      avgMs,
      lastError: lastFail?.errorClass,
      health,
    });
  }

  // Sort: broken first, then degraded, then healthy
  const order = { broken: 0, degraded: 1, healthy: 2 };
  report.sort((a, b) => order[a.health] - order[b.health] || a.successRate - b.successRate);
  return report;
}

// ---------------------------------------------------------------------------
// Default timeout
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Input validation (JSON Schema — top-level properties + required + type check)
// ---------------------------------------------------------------------------

/**
 * Validate args against argsSchema. Returns null if valid, error string otherwise.
 * Also performs safe type coercion (string -> number, number -> string, string -> boolean).
 * This mirrors the existing validateArgs in loader.ts but adds boolean coercion.
 */
function validateInput(
  args: Record<string, unknown>,
  schema: ToolSchema,
  skillName: string,
): string | null {
  // Check required fields
  if (schema.required) {
    for (const key of schema.required) {
      if (!(key in args) || args[key] === undefined || args[key] === null) {
        return `Missing required argument "${key}" for ${skillName}`;
      }
    }
  }

  // Type-check and auto-coerce each provided arg
  for (const [key, val] of Object.entries(args)) {
    const prop = schema.properties[key];
    if (!prop) continue; // extra keys are allowed (LLMs sometimes add extra)

    const expected = prop.type;

    // Auto-coerce string -> number
    if (expected === "number" && typeof val === "string") {
      const num = Number(val);
      if (!Number.isNaN(num)) {
        args[key] = num;
        continue;
      }
      return `Argument "${key}" must be a number (got "${val}") for ${skillName}`;
    }

    // Auto-coerce number -> string
    if (expected === "string" && typeof val === "number") {
      args[key] = String(val);
      continue;
    }

    // Auto-coerce string -> boolean
    if (expected === "boolean" && typeof val === "string") {
      args[key] = val === "true" || val === "1";
      continue;
    }

    // Auto-coerce boolean -> string
    if (expected === "string" && typeof val === "boolean") {
      args[key] = String(val);
      continue;
    }

    // Strict type checks for non-coercible mismatches
    if (expected === "string" && typeof val !== "string") {
      return `Argument "${key}" must be a string for ${skillName}`;
    }
    if (expected === "number" && typeof val !== "number") {
      return `Argument "${key}" must be a number for ${skillName}`;
    }
    if (expected === "boolean" && typeof val !== "boolean") {
      return `Argument "${key}" must be a boolean for ${skillName}`;
    }
    if (expected === "array" && !Array.isArray(val)) {
      return `Argument "${key}" must be an array for ${skillName}`;
    }
    if (expected === "object" && (typeof val !== "object" || val === null || Array.isArray(val))) {
      return `Argument "${key}" must be an object for ${skillName}`;
    }
  }

  return null; // valid
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

function classifyError(err: unknown): { errorClass: ErrorClass; message: string } {
  if (err instanceof Error) {
    const msg = err.message;

    // Timeout detection (AbortSignal or manual timeout)
    if (
      err.name === "AbortError" ||
      msg.includes("aborted") ||
      msg.includes("timeout") ||
      msg.includes("timed out") ||
      msg.includes("TimeoutError")
    ) {
      return { errorClass: "timeout_error", message: `Timeout: ${msg}` };
    }

    // Everything else is an execution error
    return { errorClass: "execution_error", message: msg };
  }

  return { errorClass: "execution_error", message: String(err) };
}

// ---------------------------------------------------------------------------
// Core wrapper
// ---------------------------------------------------------------------------

/**
 * Wrap a skill's execute() method with the full validation pipeline.
 * Returns the same skill object with execute() replaced by the wrapped version.
 *
 * The wrapped execute() still returns Promise<string> to maintain compatibility
 * with the existing skill interface. Errors are thrown with a prefixed message
 * so the caller (router, toolExecutor, etc.) can handle them.
 *
 * Metrics are always logged regardless of success/failure.
 */
export function wrapSkillExecution<T extends WrappableSkill>(
  skill: T,
  opts?: PipelineOptions,
): T {
  const originalExecute = skill.execute.bind(skill);
  const skillTimeoutMs = skill.timeoutMs ?? opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const shouldValidate = !(opts?.skipValidation);

  // Tag to detect double-wrapping
  const WRAPPED_TAG = "__pipeline_wrapped__";
  if ((originalExecute as any)[WRAPPED_TAG]) {
    // Already wrapped — return as-is
    return skill;
  }

  const wrappedExecute = async function pipelineExecute(
    args: Record<string, unknown>,
  ): Promise<string> {
    const start = Date.now();

    // --- Step 1: Input validation ---
    if (shouldValidate) {
      const validationError = validateInput(args, skill.argsSchema, skill.name);
      if (validationError) {
        const durationMs = Date.now() - start;
        recordMetric({
          skillName: skill.name,
          ok: false,
          errorClass: "input_error",
          durationMs,
          timestamp: Date.now(),
        });
        log.warn(`[pipeline] Input validation failed for ${skill.name}: ${validationError} (${durationMs}ms)`);
        throw new Error(`[input_error] ${validationError}`);
      }
    }

    // --- Step 2: Execute with AbortSignal timeout ---
    let abortController: AbortController | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    try {
      abortController = new AbortController();
      const signal = abortController.signal;

      // Create a timeout that aborts the signal
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          abortController!.abort();
          reject(new Error(`Skill "${skill.name}" timed out after ${skillTimeoutMs}ms`));
        }, skillTimeoutMs);
      });

      // Race: execution vs timeout
      const result = await Promise.race([
        originalExecute(args),
        timeoutPromise,
      ]);

      // --- Step 3: Success ---
      const durationMs = Date.now() - start;
      recordMetric({
        skillName: skill.name,
        ok: true,
        durationMs,
        timestamp: Date.now(),
      });

      // Log slow executions at info level, fast ones at debug
      if (durationMs > 5000) {
        log.info(`[pipeline] ${skill.name} OK (${durationMs}ms) [slow]`);
      } else {
        log.debug(`[pipeline] ${skill.name} OK (${durationMs}ms)`);
      }

      return result;
    } catch (err) {
      // --- Step 4: Error classification ---
      const durationMs = Date.now() - start;
      const { errorClass, message } = classifyError(err);

      recordMetric({
        skillName: skill.name,
        ok: false,
        errorClass,
        durationMs,
        timestamp: Date.now(),
      });

      log.warn(`[pipeline] ${skill.name} FAILED [${errorClass}] (${durationMs}ms): ${message}`);

      // Re-throw with classification prefix so callers can parse it if needed
      const classifiedError = new Error(`[${errorClass}] ${message}`);
      classifiedError.name = errorClass;
      throw classifiedError;
    } finally {
      // Always clear the timeout to prevent leaks
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    }
  };

  // Mark as wrapped to prevent double-wrapping
  (wrappedExecute as any)[WRAPPED_TAG] = true;

  skill.execute = wrappedExecute;
  return skill;
}

// ---------------------------------------------------------------------------
// Bulk wrapper — apply to all skills in a registry
// ---------------------------------------------------------------------------

/**
 * Wrap all skills in a Map registry. Mutates the skills in-place.
 * Useful for applying the pipeline after all skills have been registered.
 */
export function wrapAllSkills(
  registry: Map<string, WrappableSkill>,
  opts?: PipelineOptions,
): void {
  let count = 0;
  for (const [, skill] of registry) {
    wrapSkillExecution(skill, opts);
    count++;
  }
  log.info(`[pipeline] Wrapped ${count} skills with validation pipeline (timeout=${opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms)`);
}
