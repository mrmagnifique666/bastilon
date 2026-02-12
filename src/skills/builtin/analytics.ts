/**
 * Built-in skills: analytics.log, analytics.report, analytics.compare, analytics.bottlenecks
 * Performance tracking and self-analysis for Kingston.
 */
import { registerSkill } from "../loader.js";
import { getDb } from "../../storage/store.js";
import { log } from "../../utils/log.js";
import { getTodayUsage, getUsageSummary, getUsageTrend, PRICING_TABLE } from "../../llm/tokenTracker.js";

function ensureTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS performance_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      skill TEXT NOT NULL,
      action TEXT,
      outcome TEXT NOT NULL DEFAULT 'success',
      duration_ms INTEGER DEFAULT 0,
      error_msg TEXT,
      metadata TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_perf_skill ON performance_log(skill);
    CREATE INDEX IF NOT EXISTS idx_perf_ts ON performance_log(timestamp);
  `);
}

registerSkill({
  name: "analytics.log",
  description: "Log a skill execution for performance tracking.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      skill: { type: "string", description: "Skill name that was executed" },
      action: { type: "string", description: "Action description" },
      outcome: { type: "string", description: "success or error" },
      durationMs: { type: "number", description: "Execution time in milliseconds" },
      errorMsg: { type: "string", description: "Error message if failed (optional)" },
    },
    required: ["skill", "outcome"],
  },
  async execute(args): Promise<string> {
    ensureTable();
    const db = getDb();
    db.prepare(
      "INSERT INTO performance_log (timestamp, skill, action, outcome, duration_ms, error_msg) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(
      Math.floor(Date.now() / 1000),
      String(args.skill),
      args.action ? String(args.action) : null,
      String(args.outcome),
      Number(args.durationMs) || 0,
      args.errorMsg ? String(args.errorMsg) : null,
    );
    return `Logged: ${args.skill} → ${args.outcome}`;
  },
});

registerSkill({
  name: "analytics.report",
  description: "Generate a performance report for a time period.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      timeframe: { type: "string", description: "Timeframe: today, week, month, all (default: week)" },
    },
  },
  async execute(args): Promise<string> {
    ensureTable();
    const db = getDb();
    const tf = String(args.timeframe || "week");
    const since = tf === "today" ? Date.now() / 1000 - 86400
      : tf === "week" ? Date.now() / 1000 - 7 * 86400
      : tf === "month" ? Date.now() / 1000 - 30 * 86400
      : 0;

    const total = db.prepare("SELECT COUNT(*) as c FROM performance_log WHERE timestamp > ?").get(Math.floor(since)) as any;
    const successes = db.prepare("SELECT COUNT(*) as c FROM performance_log WHERE timestamp > ? AND outcome = 'success'").get(Math.floor(since)) as any;
    const errors = db.prepare("SELECT COUNT(*) as c FROM performance_log WHERE timestamp > ? AND outcome = 'error'").get(Math.floor(since)) as any;
    const avgDuration = db.prepare("SELECT AVG(duration_ms) as avg FROM performance_log WHERE timestamp > ? AND duration_ms > 0").get(Math.floor(since)) as any;

    // Most used skills
    const topSkills = db.prepare(
      "SELECT skill, COUNT(*) as count, AVG(duration_ms) as avg_ms FROM performance_log WHERE timestamp > ? GROUP BY skill ORDER BY count DESC LIMIT 10"
    ).all(Math.floor(since)) as any[];

    // Error-prone skills
    const errorSkills = db.prepare(
      "SELECT skill, COUNT(*) as errors FROM performance_log WHERE timestamp > ? AND outcome = 'error' GROUP BY skill ORDER BY errors DESC LIMIT 5"
    ).all(Math.floor(since)) as any[];

    const lines = [
      `**Performance Report (${tf})**`,
      ``,
      `Total executions: ${total.c}`,
      `Success: ${successes.c} (${total.c > 0 ? ((successes.c / total.c) * 100).toFixed(1) : 0}%)`,
      `Errors: ${errors.c} (${total.c > 0 ? ((errors.c / total.c) * 100).toFixed(1) : 0}%)`,
      `Avg response time: ${avgDuration.avg ? Math.round(avgDuration.avg) + "ms" : "N/A"}`,
    ];

    if (topSkills.length) {
      lines.push("", "**Most used skills:**");
      for (const s of topSkills) {
        lines.push(`  ${s.skill}: ${s.count}x (avg ${Math.round(s.avg_ms || 0)}ms)`);
      }
    }

    if (errorSkills.length) {
      lines.push("", "**Error-prone skills:**");
      for (const s of errorSkills) {
        lines.push(`  ${s.skill}: ${s.errors} errors`);
      }
    }

    return lines.join("\n");
  },
});

registerSkill({
  name: "analytics.compare",
  description: "Compare performance between two periods.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      period1: { type: "string", description: "First period: last_week, last_month" },
      period2: { type: "string", description: "Second period: this_week, this_month" },
    },
  },
  async execute(args): Promise<string> {
    ensureTable();
    const db = getDb();
    const now = Date.now() / 1000;

    function getPeriod(name: string): [number, number] {
      switch (name) {
        case "this_week": return [now - 7 * 86400, now];
        case "last_week": return [now - 14 * 86400, now - 7 * 86400];
        case "this_month": return [now - 30 * 86400, now];
        case "last_month": return [now - 60 * 86400, now - 30 * 86400];
        default: return [now - 7 * 86400, now];
      }
    }

    const [s1, e1] = getPeriod(String(args.period1 || "last_week"));
    const [s2, e2] = getPeriod(String(args.period2 || "this_week"));

    const stats = (start: number, end: number) => {
      const total = (db.prepare("SELECT COUNT(*) as c FROM performance_log WHERE timestamp BETWEEN ? AND ?").get(Math.floor(start), Math.floor(end)) as any).c;
      const errs = (db.prepare("SELECT COUNT(*) as c FROM performance_log WHERE timestamp BETWEEN ? AND ? AND outcome='error'").get(Math.floor(start), Math.floor(end)) as any).c;
      const avg = (db.prepare("SELECT AVG(duration_ms) as a FROM performance_log WHERE timestamp BETWEEN ? AND ? AND duration_ms > 0").get(Math.floor(start), Math.floor(end)) as any).a;
      return { total, errs, avg: Math.round(avg || 0), successRate: total > 0 ? ((total - errs) / total * 100).toFixed(1) : "0" };
    };

    const p1 = stats(s1, e1);
    const p2 = stats(s2, e2);

    return [
      `**Performance Comparison**`,
      ``,
      `| Metric | ${args.period1 || "last_week"} | ${args.period2 || "this_week"} | Δ |`,
      `|--------|-------|-------|---|`,
      `| Executions | ${p1.total} | ${p2.total} | ${p2.total - p1.total > 0 ? "+" : ""}${p2.total - p1.total} |`,
      `| Success rate | ${p1.successRate}% | ${p2.successRate}% | ${(Number(p2.successRate) - Number(p1.successRate)).toFixed(1)} |`,
      `| Avg time | ${p1.avg}ms | ${p2.avg}ms | ${p2.avg - p1.avg > 0 ? "+" : ""}${p2.avg - p1.avg}ms |`,
      `| Errors | ${p1.errs} | ${p2.errs} | ${p2.errs - p1.errs > 0 ? "+" : ""}${p2.errs - p1.errs} |`,
    ].join("\n");
  },
});

registerSkill({
  name: "analytics.bottlenecks",
  description: "Identify slowest skills and operations.",
  adminOnly: true,
  argsSchema: { type: "object", properties: {} },
  async execute(): Promise<string> {
    ensureTable();
    const db = getDb();
    const since = Math.floor(Date.now() / 1000 - 7 * 86400);

    const slowest = db.prepare(
      "SELECT skill, AVG(duration_ms) as avg_ms, MAX(duration_ms) as max_ms, COUNT(*) as count FROM performance_log WHERE timestamp > ? AND duration_ms > 0 GROUP BY skill ORDER BY avg_ms DESC LIMIT 10"
    ).all(since) as any[];

    if (!slowest.length) return "No performance data available. Skills need to call analytics.log during execution.";

    const lines = ["**Bottleneck Analysis (last 7 days):**", ""];
    for (const s of slowest) {
      const flag = s.avg_ms > 5000 ? "🔴" : s.avg_ms > 2000 ? "🟡" : "🟢";
      lines.push(`${flag} ${s.skill}: avg ${Math.round(s.avg_ms)}ms, max ${Math.round(s.max_ms)}ms (${s.count} calls)`);
    }
    return lines.join("\n");
  },
});

// ── Token Usage Skills ──

registerSkill({
  name: "analytics.tokens",
  description: "Show token usage per LLM provider (today or last N days). Tracks: ollama, groq, gemini, claude, haiku.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      days: { type: "number", description: "Number of days to show (default: 1 = today)" },
    },
  },
  async execute(args): Promise<string> {
    const days = Number(args.days) || 1;

    if (days === 1) {
      const today = getTodayUsage();
      if (Object.keys(today).length === 0) return "Pas de données token pour aujourd'hui.";

      let totalIn = 0, totalOut = 0, totalReqs = 0;
      const lines = ["**Token Usage (aujourd'hui):**\n"];

      for (const [provider, stats] of Object.entries(today)) {
        totalIn += stats.input;
        totalOut += stats.output;
        totalReqs += stats.requests;
        const totalK = ((stats.input + stats.output) / 1000).toFixed(1);
        lines.push(
          `**${provider}**: ${totalK}K tokens (${stats.input.toLocaleString()} in / ${stats.output.toLocaleString()} out) — ${stats.requests} requests — $${stats.cost.toFixed(4)}`
        );
      }

      const grandTotalK = ((totalIn + totalOut) / 1000).toFixed(1);
      lines.push(`\n**Total**: ${grandTotalK}K tokens, ${totalReqs} requests`);
      return lines.join("\n");
    }

    // Multi-day view
    const rows = getUsageSummary(days);
    if (rows.length === 0) return `Pas de données token pour les ${days} derniers jours.`;

    const byDate: Record<string, Record<string, { in: number; out: number; reqs: number }>> = {};
    for (const r of rows) {
      if (!byDate[r.date]) byDate[r.date] = {};
      byDate[r.date][r.provider] = { in: r.input_tokens, out: r.output_tokens, reqs: r.requests };
    }

    const lines = [`**Token Usage (${days} derniers jours):**\n`];
    for (const [date, providers] of Object.entries(byDate)) {
      const dayTotal = Object.values(providers).reduce((s, p) => s + p.in + p.out, 0);
      const dayReqs = Object.values(providers).reduce((s, p) => s + p.reqs, 0);
      lines.push(`**${date}**: ${(dayTotal / 1000).toFixed(1)}K tokens, ${dayReqs} requests`);
      for (const [p, s] of Object.entries(providers)) {
        lines.push(`  ${p}: ${((s.in + s.out) / 1000).toFixed(1)}K (${s.reqs} req)`);
      }
    }

    return lines.join("\n");
  },
});

// ── Cost Intelligence ──

registerSkill({
  name: "analytics.costs",
  description: "Cost report by provider with daily trend. Shows theoretical cost (most providers are free-tier).",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      days: { type: "number", description: "Number of days to analyze (default: 7)" },
    },
  },
  async execute(args): Promise<string> {
    const days = Number(args.days) || 7;
    const trend = getUsageTrend(days);
    if (trend.length === 0) return `Pas de données de coûts pour les ${days} derniers jours.`;

    // Aggregate by provider
    const byProvider: Record<string, { input: number; output: number; reqs: number; cost: number }> = {};
    const byDate: Record<string, number> = {};

    for (const row of trend) {
      if (!byProvider[row.provider]) byProvider[row.provider] = { input: 0, output: 0, reqs: 0, cost: 0 };
      byProvider[row.provider].input += row.input_tokens;
      byProvider[row.provider].output += row.output_tokens;
      byProvider[row.provider].reqs += row.requests;
      byProvider[row.provider].cost += row.cost;
      byDate[row.date] = (byDate[row.date] || 0) + row.cost;
    }

    const lines = [`**Rapport de coûts — ${days} derniers jours**\n`];
    lines.push(`| Provider | Requests | Input | Output | Coût théorique |`);
    lines.push(`|----------|----------|-------|--------|----------------|`);

    let totalCost = 0;
    for (const [prov, stats] of Object.entries(byProvider).sort((a, b) => b[1].cost - a[1].cost)) {
      totalCost += stats.cost;
      lines.push(
        `| ${prov} | ${stats.reqs} | ${(stats.input / 1000).toFixed(1)}K | ${(stats.output / 1000).toFixed(1)}K | $${stats.cost.toFixed(4)} |`
      );
    }

    lines.push(`\n**Total théorique**: $${totalCost.toFixed(4)} (coût réel: $0 — free tiers + Max plan)\n`);

    lines.push(`**Tendance journalière:**`);
    for (const [date, cost] of Object.entries(byDate).sort()) {
      const bar = "█".repeat(Math.min(20, Math.round(cost * 100)));
      lines.push(`  ${date}: $${cost.toFixed(4)} ${bar}`);
    }

    return lines.join("\n");
  },
});

registerSkill({
  name: "analytics.optimize",
  description: "Suggest token usage optimizations: flag expensive providers, tasks that could use cheaper models.",
  adminOnly: true,
  argsSchema: { type: "object", properties: {} },
  async execute(): Promise<string> {
    const trend = getUsageTrend(7);
    if (trend.length === 0) return "Pas assez de données pour optimiser (besoin d'au moins 1 jour).";

    const byProvider: Record<string, { reqs: number; tokens: number; cost: number }> = {};
    let totalReqs = 0;

    for (const row of trend) {
      if (!byProvider[row.provider]) byProvider[row.provider] = { reqs: 0, tokens: 0, cost: 0 };
      byProvider[row.provider].reqs += row.requests;
      byProvider[row.provider].tokens += row.input_tokens + row.output_tokens;
      byProvider[row.provider].cost += row.cost;
      totalReqs += row.requests;
    }

    const suggestions: string[] = [];

    // Flag providers with >25% of total requests
    for (const [prov, stats] of Object.entries(byProvider)) {
      const pct = totalReqs > 0 ? (stats.reqs / totalReqs) * 100 : 0;
      if (pct > 25 && prov !== "ollama") {
        suggestions.push(
          `**${prov}** utilise ${pct.toFixed(0)}% des requêtes (${stats.reqs}). ` +
          `Considérer migrer plus de tâches vers Ollama (gratuit, local).`
        );
      }
    }

    // Check if expensive providers handle many small requests
    for (const [prov, stats] of Object.entries(byProvider)) {
      const pricing = PRICING_TABLE[prov as keyof typeof PRICING_TABLE];
      if (!pricing) continue;
      const avgTokens = stats.reqs > 0 ? stats.tokens / stats.reqs : 0;
      if (pricing.inputPer1M > 1 && avgTokens < 500 && stats.reqs > 10) {
        suggestions.push(
          `**${prov}** traite ${stats.reqs} requêtes avec avg ${Math.round(avgTokens)} tokens/req. ` +
          `Petites requêtes → utiliser Groq ou Ollama au lieu de ${prov}.`
        );
      }
    }

    // Check Ollama utilization
    const ollamaStats = byProvider["ollama"];
    if (ollamaStats) {
      const ollamaPct = totalReqs > 0 ? (ollamaStats.reqs / totalReqs) * 100 : 0;
      if (ollamaPct > 60) {
        suggestions.push(`Ollama gère ${ollamaPct.toFixed(0)}% du trafic — excellente utilisation du modèle local.`);
      }
    } else {
      suggestions.push(`Ollama n'est pas utilisé. Activer le routing Ollama-first pour réduire les coûts API.`);
    }

    if (suggestions.length === 0) {
      return "Utilisation optimale — aucune suggestion d'amélioration.";
    }

    return `**Suggestions d'optimisation (7 derniers jours):**\n\n` + suggestions.map((s, i) => `${i + 1}. ${s}`).join("\n\n");
  },
});

log.debug("Registered 7 analytics.* skills");
