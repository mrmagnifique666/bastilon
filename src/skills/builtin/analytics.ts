/**
 * Built-in skills: analytics.log, analytics.report, analytics.compare, analytics.bottlenecks
 * Performance tracking and self-analysis for Kingston.
 */
import { registerSkill } from "../loader.js";
import { getDb } from "../../storage/store.js";
import { log } from "../../utils/log.js";

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

log.debug("Registered 4 analytics.* skills");
