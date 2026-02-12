/**
 * Built-in skills: autofix.monitor, autofix.diagnose, autofix.pipeline
 * Auto-Fix Pipeline — monitor site/bot health, detect issues, spawn fix tasks.
 * Inspired by OpenClaw: detect → analyze → spawn agent → fix → test → deploy → notify.
 */
import { registerSkill, getSkill } from "../loader.js";
import { getDb, logError } from "../../storage/store.js";
import { log } from "../../utils/log.js";

interface HealthCheck {
  name: string;
  status: "ok" | "warning" | "critical";
  message: string;
  value?: number;
}

function runHealthChecks(): HealthCheck[] {
  const d = getDb();
  const checks: HealthCheck[] = [];
  const now = Math.floor(Date.now() / 1000);
  const h1 = now - 3600;
  const h24 = now - 86400;

  // 1. Error rate (last hour)
  try {
    const errors = (d.prepare("SELECT COUNT(*) as c FROM error_log WHERE timestamp > ?").get(h1) as any).c;
    checks.push({
      name: "Error Rate (1h)",
      status: errors > 20 ? "critical" : errors > 5 ? "warning" : "ok",
      message: `${errors} errors in last hour`,
      value: errors,
    });
  } catch { checks.push({ name: "Error Rate", status: "ok", message: "No data" }); }

  // 2. Agent health (any agent with >3 consecutive errors)
  try {
    const failingAgents = d.prepare(
      "SELECT agent_id, consecutive_errors FROM agent_state WHERE consecutive_errors >= 3"
    ).all() as any[];
    if (failingAgents.length > 0) {
      checks.push({
        name: "Agent Health",
        status: "critical",
        message: `${failingAgents.length} agent(s) failing: ${failingAgents.map(a => `${a.agent_id}(${a.consecutive_errors})`).join(", ")}`,
      });
    } else {
      checks.push({ name: "Agent Health", status: "ok", message: "All agents healthy" });
    }
  } catch { checks.push({ name: "Agent Health", status: "ok", message: "No data" }); }

  // 3. DB size check
  try {
    const tables = ["turns", "error_log", "agent_runs", "memory_items", "llm_cache"] as const;
    for (const table of tables) {
      const count = (d.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as any).c;
      if (count > 50000) {
        checks.push({
          name: `DB: ${table}`,
          status: count > 100000 ? "warning" : "ok",
          message: `${count.toLocaleString()} rows`,
          value: count,
        });
      }
    }
  } catch { /* skip */ }

  // 4. Cron job health
  try {
    const failedCrons = d.prepare(
      "SELECT name, retry_count FROM cron_jobs WHERE retry_count >= 2 AND enabled = 1"
    ).all() as any[];
    if (failedCrons.length > 0) {
      checks.push({
        name: "Cron Jobs",
        status: "warning",
        message: `${failedCrons.length} job(s) with retries: ${failedCrons.map(c => c.name).join(", ")}`,
      });
    } else {
      checks.push({ name: "Cron Jobs", status: "ok", message: "All healthy" });
    }
  } catch { checks.push({ name: "Cron Jobs", status: "ok", message: "No data" }); }

  // 5. Memory pressure
  try {
    const memUsage = process.memoryUsage();
    const heapMB = Math.round(memUsage.heapUsed / 1024 / 1024);
    checks.push({
      name: "Memory",
      status: heapMB > 500 ? "warning" : "ok",
      message: `Heap: ${heapMB}MB`,
      value: heapMB,
    });
  } catch { /* skip */ }

  return checks;
}

registerSkill({
  name: "autofix.monitor",
  description: "Run health checks on the system: error rates, agent health, DB size, cron jobs, memory.",
  adminOnly: true,
  argsSchema: { type: "object", properties: {} },
  async execute(): Promise<string> {
    const checks = runHealthChecks();
    const critical = checks.filter(c => c.status === "critical");
    const warnings = checks.filter(c => c.status === "warning");
    const ok = checks.filter(c => c.status === "ok");

    const lines = ["**System Health Monitor**\n"];

    if (critical.length > 0) {
      lines.push("🔴 **CRITICAL:**");
      for (const c of critical) lines.push(`  ${c.name}: ${c.message}`);
    }
    if (warnings.length > 0) {
      lines.push("🟡 **WARNINGS:**");
      for (const c of warnings) lines.push(`  ${c.name}: ${c.message}`);
    }
    if (ok.length > 0) {
      lines.push("🟢 **OK:**");
      for (const c of ok) lines.push(`  ${c.name}: ${c.message}`);
    }

    const overallStatus = critical.length > 0 ? "CRITICAL" : warnings.length > 0 ? "DEGRADED" : "HEALTHY";
    lines.push(`\n**Status global: ${overallStatus}**`);

    return lines.join("\n");
  },
});

registerSkill({
  name: "autofix.diagnose",
  description: "Diagnose a specific error pattern. Analyzes recent errors and suggests fixes.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Error pattern to diagnose (keyword or pattern_key)" },
      hours: { type: "number", description: "Lookback hours (default: 24)" },
    },
    required: ["pattern"],
  },
  async execute(args): Promise<string> {
    const pattern = String(args.pattern);
    const hours = Number(args.hours) || 24;
    const d = getDb();
    const cutoff = Math.floor(Date.now() / 1000) - hours * 3600;

    const errors = d.prepare(
      `SELECT error_message, context, tool_name, COUNT(*) as c
       FROM error_log WHERE timestamp > ? AND (error_message LIKE ? OR pattern_key LIKE ? OR context LIKE ?)
       GROUP BY error_message ORDER BY c DESC LIMIT 10`
    ).all(cutoff, `%${pattern}%`, `%${pattern}%`, `%${pattern}%`) as any[];

    if (errors.length === 0) return `Aucune erreur trouvée pour "${pattern}" (${hours}h).`;

    const lines = [`**Diagnostic: "${pattern}"** (${hours}h)\n`];
    let totalOccurrences = 0;

    for (const e of errors) {
      totalOccurrences += e.c;
      lines.push(`**${e.c}x** — ${e.error_message.slice(0, 150)}`);
      if (e.context) lines.push(`  Context: ${e.context}`);
      if (e.tool_name) lines.push(`  Tool: ${e.tool_name}`);
      lines.push("");
    }

    lines.push(`**Total: ${totalOccurrences} occurrence(s)**`);
    lines.push(`\nPour corriger: utilise autofix.pipeline pattern="${pattern}" pour lancer une correction automatique.`);

    return lines.join("\n");
  },
});

registerSkill({
  name: "autofix.pipeline",
  description:
    "Run the full auto-fix pipeline: diagnose → create code request → notify. " +
    "Creates an agent_task for the Executor agent to handle the fix.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Error pattern to fix" },
      instruction: { type: "string", description: "Specific fix instruction (optional — auto-generated if omitted)" },
    },
    required: ["pattern"],
  },
  async execute(args): Promise<string> {
    const pattern = String(args.pattern);
    const d = getDb();

    // Get error context
    const errors = d.prepare(
      `SELECT error_message, context, tool_name FROM error_log
       WHERE error_message LIKE ? OR pattern_key LIKE ?
       ORDER BY id DESC LIMIT 5`
    ).all(`%${pattern}%`, `%${pattern}%`) as any[];

    if (errors.length === 0) return `Aucune erreur trouvée pour "${pattern}".`;

    const errorContext = errors.map(e =>
      `${e.error_message}${e.context ? ` (ctx: ${e.context})` : ""}${e.tool_name ? ` [tool: ${e.tool_name}]` : ""}`
    ).join("\n");

    const instruction = args.instruction
      ? String(args.instruction)
      : `Auto-fix for error pattern "${pattern}". Recent errors:\n${errorContext}\n\nAnalyze the root cause and propose a fix.`;

    // Create agent task for Executor
    try {
      d.prepare(
        "INSERT INTO agent_tasks (from_agent, to_agent, instruction, status) VALUES (?, ?, ?, 'pending')"
      ).run("autofix", "executor", instruction);

      const taskId = (d.prepare("SELECT last_insert_rowid() as id").get() as any).id;

      // Also log as autonomous decision
      d.prepare(
        "INSERT INTO autonomous_decisions (category, action, reasoning, status) VALUES (?, ?, ?, 'pending')"
      ).run("autofix", `Auto-fix task #${taskId} for: ${pattern}`, errorContext.slice(0, 500));

      return (
        `**Auto-Fix Pipeline lancé**\n\n` +
        `Pattern: "${pattern}"\n` +
        `Erreurs analysées: ${errors.length}\n` +
        `Task #${taskId} créée pour l'agent Executor.\n\n` +
        `L'Executor va analyser et proposer une correction.`
      );
    } catch (err) {
      return `Erreur pipeline: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

log.debug("Registered 3 autofix.* skills");
