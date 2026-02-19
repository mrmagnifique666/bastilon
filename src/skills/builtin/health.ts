/**
 * Built-in skill: system.health
 * Real observability — agents, LLM providers, crons, memory, errors.
 * Kingston's honest answer to "comment tu vas?"
 */
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { registerSkill } from "../loader.js";
import { getDb } from "../../storage/store.js";
import { getAllSkills } from "../loader.js";
import { log } from "../../utils/log.js";

const startTime = Date.now();

/** Safe DB query — returns default on error */
function safeCount(db: any, sql: string, params: any[] = [], fallback = 0): number {
  try {
    return (db.prepare(sql).get(...params) as any)?.c ?? fallback;
  } catch {
    return fallback;
  }
}

function safeRows(db: any, sql: string, params: any[] = []): any[] {
  try {
    return db.prepare(sql).all(...params);
  } catch {
    return [];
  }
}

registerSkill({
  name: "system.health",
  description:
    "Comprehensive health report: uptime, agents, LLM providers, cron jobs, memory quality, error rates, DB stats. Use this when asked 'comment tu vas?' or 'ça va Kingston?' to give a REAL data-backed answer.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {},
  },
  async execute(): Promise<string> {
    const db = getDb();
    const sections: string[] = [];
    const now = Date.now();
    const dayAgo = new Date(now - 86400000).toISOString();
    const hourAgo = new Date(now - 3600000).toISOString();

    // 1. Process info
    const uptimeMs = now - startTime;
    const uptimeH = (uptimeMs / 3600000).toFixed(1);
    const memUsage = process.memoryUsage();
    const heapMB = (memUsage.heapUsed / 1048576).toFixed(1);
    const rssMB = (memUsage.rss / 1048576).toFixed(1);
    const freeMem = (os.freemem() / 1073741824).toFixed(1);
    const totalMem = (os.totalmem() / 1073741824).toFixed(1);
    sections.push(
      `**Système**\n` +
        `  Uptime: ${uptimeH}h | PID: ${process.pid}\n` +
        `  Heap: ${heapMB} MB | RSS: ${rssMB} MB\n` +
        `  RAM: ${freeMem}/${totalMem} GB libre | Node ${process.version}`,
    );

    // 2. Agents status
    const agents = safeRows(
      db,
      `SELECT name, last_run, status, cycle_count, error_count FROM agents ORDER BY name`,
    );
    if (agents.length > 0) {
      const agentLines = agents.map((a: any) => {
        const lastRun = a.last_run ? timeSince(a.last_run) : "jamais";
        const errorRate =
          a.cycle_count > 0
            ? ((a.error_count / a.cycle_count) * 100).toFixed(1)
            : "0";
        const status = a.status === "active" ? "✅" : a.status === "paused" ? "⏸️" : "❌";
        return `  ${status} ${a.name}: dernière run ${lastRun}, ${a.cycle_count || 0} cycles, ${errorRate}% erreurs`;
      });
      sections.push(`**Agents (${agents.length})**\n${agentLines.join("\n")}`);
    }

    // 3. LLM provider health (from token_usage table if exists)
    const tokenStats = safeRows(
      db,
      `SELECT provider, SUM(input_tokens + output_tokens) as total_tokens, COUNT(*) as calls,
       MAX(timestamp) as last_call
       FROM token_usage WHERE timestamp > ? GROUP BY provider ORDER BY total_tokens DESC`,
      [dayAgo],
    );
    if (tokenStats.length > 0) {
      const llmLines = tokenStats.map((t: any) => {
        const lastCall = t.last_call ? timeSince(t.last_call) : "?";
        return `  ${t.provider}: ${t.calls} calls, ${(t.total_tokens / 1000).toFixed(1)}K tokens, dernier: ${lastCall}`;
      });
      sections.push(`**LLM Providers (24h)**\n${llmLines.join("\n")}`);
    }

    // 4. Cron jobs status
    const cronJobs = safeRows(
      db,
      `SELECT name, enabled, last_run, next_run, fail_count FROM cron_jobs ORDER BY name`,
    );
    if (cronJobs.length > 0) {
      const activeCrons = cronJobs.filter((c: any) => c.enabled);
      const failedCrons = cronJobs.filter((c: any) => c.fail_count > 0);
      const cronLines: string[] = [
        `  Total: ${cronJobs.length} | Actifs: ${activeCrons.length} | En erreur: ${failedCrons.length}`,
      ];
      if (failedCrons.length > 0) {
        for (const c of failedCrons.slice(0, 5)) {
          cronLines.push(`  ⚠️ ${c.name}: ${c.fail_count} failures`);
        }
      }
      sections.push(`**Cron Jobs**\n${cronLines.join("\n")}`);
    }

    // 5. Memory quality
    const memoryCount = safeCount(db, "SELECT COUNT(*) as c FROM memory_items");
    const recentMemories = safeCount(
      db,
      "SELECT COUNT(*) as c FROM memory_items WHERE created_at > ?",
      [dayAgo],
    );
    const kgEntities = safeCount(db, "SELECT COUNT(*) as c FROM kg_entities");
    const kgRelations = safeCount(db, "SELECT COUNT(*) as c FROM kg_relations");
    const episodicToday = safeCount(
      db,
      "SELECT COUNT(*) as c FROM episodic_events WHERE created_at > ?",
      [dayAgo],
    );
    const rulesActive = safeCount(
      db,
      "SELECT COUNT(*) as c FROM behavioral_rules WHERE status = 'active'",
    );
    const rulesPending = safeCount(
      db,
      "SELECT COUNT(*) as c FROM behavioral_rules WHERE status = 'pending'",
    );
    sections.push(
      `**Mémoire**\n` +
        `  Semantic: ${memoryCount} items (+${recentMemories} aujourd'hui)\n` +
        `  Knowledge Graph: ${kgEntities} entités, ${kgRelations} relations\n` +
        `  Épisodique: ${episodicToday} événements (24h)\n` +
        `  Rules: ${rulesActive} actives, ${rulesPending} en attente`,
    );

    // 6. Database
    const dbPath = path.resolve("relay.db");
    let dbSize = "?";
    try {
      dbSize = (fs.statSync(dbPath).size / 1048576).toFixed(1) + " MB";
    } catch (e) {
      log.debug(`[health] DB stat: ${e}`);
    }
    const turnCount = safeCount(db, "SELECT COUNT(*) as c FROM turns");
    const noteCount = safeCount(db, "SELECT COUNT(*) as c FROM notes");
    sections.push(
      `**Database** (${dbSize})\n` +
        `  Turns: ${turnCount} | Notes: ${noteCount}`,
    );

    // 7. Errors
    const totalErrors = safeCount(db, "SELECT COUNT(*) as c FROM error_log");
    const openErrors = safeCount(db, "SELECT COUNT(*) as c FROM error_log WHERE resolved = 0");
    const errors24h = safeCount(
      db,
      "SELECT COUNT(*) as c FROM error_log WHERE timestamp > ?",
      [Math.floor(now / 1000) - 86400],
    );
    const errors1h = safeCount(
      db,
      "SELECT COUNT(*) as c FROM error_log WHERE timestamp > ?",
      [Math.floor(now / 1000) - 3600],
    );

    // Top error sources (last 24h)
    const topErrors = safeRows(
      db,
      `SELECT context, COUNT(*) as cnt FROM error_log
       WHERE timestamp > ? GROUP BY context ORDER BY cnt DESC LIMIT 5`,
      [Math.floor(now / 1000) - 86400],
    );
    const errorLines = [
      `  Dernière heure: ${errors1h} | 24h: ${errors24h} | Open: ${openErrors} | Total: ${totalErrors}`,
    ];
    if (topErrors.length > 0) {
      errorLines.push(`  Top sources:`);
      for (const e of topErrors) {
        errorLines.push(`    ${e.context}: ${e.cnt}x`);
      }
    }
    sections.push(`**Erreurs**\n${errorLines.join("\n")}`);

    // 8. Skills
    const skills = getAllSkills();
    sections.push(`**Skills**: ${skills.length} enregistrés`);

    // 9. Goals
    const activeGoals = safeCount(
      db,
      "SELECT COUNT(*) as c FROM goals WHERE status IN ('active', 'in_progress')",
    );
    const completedGoals = safeCount(
      db,
      "SELECT COUNT(*) as c FROM goals WHERE status = 'completed'",
    );
    if (activeGoals + completedGoals > 0) {
      sections.push(
        `**Goals**: ${activeGoals} actifs, ${completedGoals} complétés`,
      );
    }

    // 10. Overall verdict
    let verdict = "🟢 Tout va bien";
    if (errors1h > 10) verdict = "🔴 Beaucoup d'erreurs cette heure";
    else if (errors1h > 3) verdict = "🟡 Quelques erreurs à surveiller";
    else if (Number(heapMB) > 500) verdict = "🟡 Mémoire heap élevée";

    return `Kingston Health Report\n${"═".repeat(30)}\n\n${verdict}\n\n${sections.join("\n\n")}`;
  },
});

/** Human-readable time since a timestamp */
function timeSince(ts: string): string {
  const ms = Date.now() - new Date(ts).getTime();
  if (ms < 60000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}min`;
  if (ms < 86400000) return `${(ms / 3600000).toFixed(1)}h`;
  return `${Math.floor(ms / 86400000)}j`;
}
