/**
 * Built-in skills: selfimprove.analyze, selfimprove.benchmark, selfimprove.propose_skill
 * Self-improvement capabilities — Kingston analyzes his own performance and proposes improvements.
 */
import { registerSkill } from "../loader.js";
import { getDb } from "../../storage/store.js";
import fs from "node:fs";
import path from "node:path";
import { log } from "../../utils/log.js";

registerSkill({
  name: "selfimprove.analyze",
  description:
    "Analyze recent errors, find patterns, and suggest improvements. Kingston's self-diagnostic tool.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      hours: { type: "number", description: "Lookback period in hours (default: 24)" },
    },
  },
  async execute(args): Promise<string> {
    const hours = (args.hours as number) || 24;
    const cutoff = Math.floor(Date.now() / 1000) - hours * 3600;
    const d = getDb();

    // Error patterns
    const patterns = d
      .prepare(
        `SELECT pattern_key, tool_name, context, COUNT(*) as count,
                MAX(error_message) as last_message
         FROM error_log WHERE timestamp > ? AND resolved = 0
         GROUP BY pattern_key ORDER BY count DESC LIMIT 10`,
      )
      .all(cutoff) as Array<{
      pattern_key: string;
      tool_name: string | null;
      context: string | null;
      count: number;
      last_message: string;
    }>;

    // Agent performance
    const agentRuns = d
      .prepare(
        `SELECT agent_id, COUNT(*) as runs,
                SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) as successes,
                AVG(duration_ms) as avg_duration,
                MAX(error_msg) as last_error
         FROM agent_runs WHERE started_at > ? GROUP BY agent_id`,
      )
      .all(cutoff) as Array<{
      agent_id: string;
      runs: number;
      successes: number;
      avg_duration: number;
      last_error: string | null;
    }>;

    // Total errors
    const totalErrors = d
      .prepare("SELECT COUNT(*) as c FROM error_log WHERE timestamp > ? AND resolved = 0")
      .get(cutoff) as { c: number };

    let output = `**Auto-diagnostic Kingston — ${hours}h**\n\n`;

    // Error analysis
    output += `**Erreurs non résolues: ${totalErrors.c}**\n`;
    if (patterns.length > 0) {
      output += "\nPatterns récurrents:\n";
      for (const p of patterns) {
        output += `  ${p.count}x [${p.context || "?"}] ${p.tool_name || ""}: ${p.last_message.slice(0, 100)}\n`;
        // Suggest fix
        if (p.last_message.includes("timeout")) {
          output += `    💡 Suggestion: augmenter le timeout ou ajouter un retry\n`;
        } else if (p.last_message.includes("not configured") || p.last_message.includes("API_KEY")) {
          output += `    💡 Suggestion: configurer la clé API manquante\n`;
        } else if (p.last_message.includes("rate limit")) {
          output += `    💡 Suggestion: réduire la fréquence ou ajouter un backoff\n`;
        } else if (p.count >= 3) {
          output += `    💡 Suggestion: pattern récurrent — créer un code-request pour fix permanent\n`;
        }
      }
    } else {
      output += "  Aucun pattern d'erreur détecté.\n";
    }

    // Agent performance
    if (agentRuns.length > 0) {
      output += "\n**Performance agents:**\n";
      for (const a of agentRuns) {
        const successRate = a.runs > 0 ? Math.round((a.successes / a.runs) * 100) : 0;
        const avgSec = a.avg_duration ? (a.avg_duration / 1000).toFixed(1) : "?";
        const health = successRate >= 80 ? "✅" : successRate >= 50 ? "⚠️" : "❌";
        output += `  ${health} ${a.agent_id}: ${successRate}% succès (${a.runs} runs, ~${avgSec}s)\n`;
        if (a.last_error) {
          output += `    Dernière erreur: ${a.last_error.slice(0, 80)}\n`;
        }
      }
    }

    // Recommendations
    output += "\n**Recommandations:**\n";
    const recs: string[] = [];

    if (totalErrors.c > 10) {
      recs.push("Taux d'erreur élevé — prioriser les fixes des patterns récurrents");
    }
    for (const a of agentRuns) {
      const rate = a.runs > 0 ? (a.successes / a.runs) * 100 : 100;
      if (rate < 50) recs.push(`Agent ${a.agent_id} en difficulté (${Math.round(rate)}%) — investiguer`);
    }
    if (recs.length === 0) recs.push("Système en bonne santé — continuer la surveillance");

    output += recs.map((r) => `  • ${r}`).join("\n");

    return output;
  },
});

registerSkill({
  name: "selfimprove.benchmark",
  description:
    "Measure system performance: response times, agent success rates, memory usage.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      period: { type: "string", description: "Period: day, week, month (default: day)" },
    },
  },
  async execute(args): Promise<string> {
    const period = String(args.period || "day");
    const daysMap: Record<string, number> = { day: 1, week: 7, month: 30 };
    const days = daysMap[period] || 1;
    const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
    const d = getDb();

    // Conversation stats
    const turnCount = d
      .prepare("SELECT COUNT(*) as c FROM turns WHERE created_at > ?")
      .get(cutoff) as { c: number };

    const uniqueChats = d
      .prepare("SELECT COUNT(DISTINCT chat_id) as c FROM turns WHERE created_at > ?")
      .get(cutoff) as { c: number };

    // Agent stats
    const agentStats = d
      .prepare(
        `SELECT agent_id,
                COUNT(*) as runs,
                SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) as ok,
                AVG(duration_ms) as avg_ms,
                MIN(duration_ms) as min_ms,
                MAX(duration_ms) as max_ms
         FROM agent_runs WHERE started_at > ? GROUP BY agent_id`,
      )
      .all(cutoff) as Array<{
      agent_id: string;
      runs: number;
      ok: number;
      avg_ms: number;
      min_ms: number;
      max_ms: number;
    }>;

    // Error stats
    const errorCount = d
      .prepare("SELECT COUNT(*) as c FROM error_log WHERE timestamp > ?")
      .get(cutoff) as { c: number };
    const resolvedCount = d
      .prepare("SELECT COUNT(*) as c FROM error_log WHERE timestamp > ? AND resolved = 1")
      .get(cutoff) as { c: number };

    // Memory stats
    const memoryCount = d
      .prepare("SELECT COUNT(*) as c FROM memory_items")
      .get() as { c: number };

    // Plan stats
    const planStats = d
      .prepare(
        `SELECT status, COUNT(*) as c FROM plans GROUP BY status`,
      )
      .all() as Array<{ status: string; c: number }>;

    let output = `**Benchmark Kingston — ${period} (${days}j)**\n\n`;

    output += `**Conversations:**\n`;
    output += `  Messages: ${turnCount.c} | Chats actifs: ${uniqueChats.c}\n\n`;

    output += `**Agents:**\n`;
    if (agentStats.length > 0) {
      for (const a of agentStats) {
        output += `  ${a.agent_id}: ${a.ok}/${a.runs} OK (${(a.avg_ms / 1000).toFixed(1)}s avg, ${(a.min_ms / 1000).toFixed(1)}s min, ${(a.max_ms / 1000).toFixed(1)}s max)\n`;
      }
    } else {
      output += "  Aucun run d'agent dans la période.\n";
    }

    output += `\n**Erreurs:** ${errorCount.c} total, ${resolvedCount.c} résolues\n`;
    output += `**Mémoire:** ${memoryCount.c} items\n`;

    if (planStats.length > 0) {
      output += `**Plans:** ${planStats.map((p) => `${p.c} ${p.status}`).join(", ")}\n`;
    }

    // Process memory
    const mem = process.memoryUsage();
    output += `\n**Système:**\n`;
    output += `  RAM: ${Math.round(mem.rss / 1024 / 1024)} MB (heap: ${Math.round(mem.heapUsed / 1024 / 1024)}/${Math.round(mem.heapTotal / 1024 / 1024)} MB)\n`;
    output += `  Uptime: ${Math.round(process.uptime() / 60)} min\n`;

    return output;
  },
});

registerSkill({
  name: "selfimprove.propose_skill",
  description:
    "Propose a new skill or improvement by creating a code-request for the Executor agent to process.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Short title for the improvement" },
      description: { type: "string", description: "Detailed description of what to build or fix" },
      priority: { type: "string", description: "Priority: low, medium, high (default: medium)" },
    },
    required: ["title", "description"],
  },
  async execute(args): Promise<string> {
    const title = String(args.title);
    const description = String(args.description);
    const priority = String(args.priority || "medium");

    const requestsPath = path.resolve("code-requests.json");

    let requests: Array<Record<string, unknown>> = [];
    try {
      const raw = fs.readFileSync(requestsPath, "utf-8");
      requests = JSON.parse(raw);
      if (!Array.isArray(requests)) requests = [];
    } catch {
      // File doesn't exist or invalid — start fresh
    }

    const newRequest = {
      id: `auto-${Date.now()}`,
      title,
      description,
      priority,
      status: "pending",
      proposed_by: "kingston-selfimprove",
      created_at: new Date().toISOString(),
    };

    requests.push(newRequest);
    fs.writeFileSync(requestsPath, JSON.stringify(requests, null, 2), "utf-8");

    log.info(`[selfimprove] Proposed: ${title} (${priority})`);
    return `Code-request created: "${title}" [${priority}]\nID: ${newRequest.id}\nThe Executor agent will process this on its next cycle.`;
  },
});
