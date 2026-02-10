/**
 * Built-in skills: optimize.analyze, optimize.suggest, optimize.benchmark, optimize.refactor
 * Self-optimization tools for Kingston.
 */
import { registerSkill, getAllSkills } from "../loader.js";
import { getDb } from "../../storage/store.js";
import { log } from "../../utils/log.js";
import fs from "node:fs";
import path from "node:path";

const SKILLS_DIR = path.join(process.cwd(), "src", "skills", "builtin");

registerSkill({
  name: "optimize.analyze",
  description: "Analyze a skill file for potential improvements.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      skillName: { type: "string", description: "Skill name (e.g. 'market' for market.ts)" },
    },
    required: ["skillName"],
  },
  async execute(args): Promise<string> {
    const name = String(args.skillName).replace(/\.ts$/, "");
    const filePath = path.join(SKILLS_DIR, `${name}.ts`);

    if (!fs.existsSync(filePath)) return `Skill file not found: ${filePath}`;

    const code = fs.readFileSync(filePath, "utf-8");
    const lines = code.split("\n").length;

    const issues: string[] = [];

    // Check for error handling
    const tryCatchCount = (code.match(/try\s*\{/g) || []).length;
    const registerCount = (code.match(/registerSkill/g) || []).length;
    if (tryCatchCount < registerCount) {
      issues.push(`⚠️ ${registerCount - tryCatchCount} skill(s) may lack try-catch error handling`);
    }

    // Check for hardcoded values
    if (/https?:\/\/[^\s"']+/.test(code)) {
      const urls = code.match(/https?:\/\/[^\s"']+/g) || [];
      const unique = [...new Set(urls)];
      if (unique.length > 1) issues.push(`📌 ${unique.length} hardcoded URLs — consider extracting to constants`);
    }

    // Check for TODO/FIXME
    const todos = code.match(/\/\/\s*(TODO|FIXME|HACK|XXX)/gi) || [];
    if (todos.length) issues.push(`📝 ${todos.length} TODO/FIXME comments found`);

    // Check file size
    if (lines > 300) issues.push(`📏 Large file (${lines} lines) — consider splitting`);
    if (lines > 500) issues.push(`🔴 Very large file (${lines} lines) — strongly recommend splitting`);

    // Check for console.log (should use log utility)
    const consoleLogs = (code.match(/console\.(log|warn|error)/g) || []).length;
    if (consoleLogs) issues.push(`⚠️ ${consoleLogs} console.log calls — use log utility instead`);

    // Check for async operations without timeout
    if (/await fetch/.test(code) && !/timeout|AbortController|signal/.test(code)) {
      issues.push("⚠️ fetch calls without timeout — consider adding AbortController");
    }

    // Performance data from analytics
    try {
      const db = getDb();
      const since = Math.floor(Date.now() / 1000 - 7 * 86400);
      const perf = db.prepare(
        "SELECT skill, COUNT(*) as count, AVG(duration_ms) as avg_ms, SUM(CASE WHEN outcome='error' THEN 1 ELSE 0 END) as errors FROM performance_log WHERE timestamp > ? AND skill LIKE ? GROUP BY skill"
      ).all(since, `${name}.%`) as any[];

      if (perf.length) {
        issues.push("", "**Performance data (last 7 days):**");
        for (const p of perf) {
          issues.push(`  ${p.skill}: ${p.count} calls, avg ${Math.round(p.avg_ms || 0)}ms, ${p.errors} errors`);
        }
      }
    } catch { /* analytics table might not exist yet */ }

    return [
      `**Analysis: ${name}.ts** (${lines} lines, ${registerCount} skills)`,
      "",
      issues.length ? issues.join("\n") : "✅ No obvious issues found.",
    ].join("\n");
  },
});

registerSkill({
  name: "optimize.suggest",
  description: "Generate optimization suggestions for a skill.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      skillName: { type: "string", description: "Skill name to analyze" },
    },
    required: ["skillName"],
  },
  async execute(args): Promise<string> {
    const name = String(args.skillName).replace(/\.ts$/, "");
    const filePath = path.join(SKILLS_DIR, `${name}.ts`);

    if (!fs.existsSync(filePath)) return `Skill file not found: ${filePath}`;

    const code = fs.readFileSync(filePath, "utf-8");
    const suggestions: string[] = [];

    // Caching opportunities
    if (/await fetch/.test(code) && !/cache|Cache|cached/.test(code)) {
      suggestions.push("💡 **Add caching**: API responses could be cached (e.g. 5-minute TTL) to reduce latency and API calls");
    }

    // Parallel execution
    const fetchCount = (code.match(/await fetch/g) || []).length;
    if (fetchCount > 3 && !/Promise\.all/.test(code)) {
      suggestions.push("💡 **Parallelize requests**: Multiple sequential fetch calls could use Promise.all()");
    }

    // Rate limiting
    if (/await fetch/.test(code) && !/rate.?limit|throttle|delay/i.test(code)) {
      suggestions.push("💡 **Rate limiting**: Add request throttling to prevent API limits");
    }

    // Input validation
    if (/required:.*\[/.test(code) && !/\.trim\(\)|\.length/.test(code)) {
      suggestions.push("💡 **Input validation**: Add string length checks and trimming");
    }

    // Retry logic
    if (/await fetch/.test(code) && !/retry|attempt/i.test(code)) {
      suggestions.push("💡 **Retry logic**: Add automatic retry for transient failures (429, 503)");
    }

    return suggestions.length
      ? `**Optimization suggestions for ${name}.ts:**\n\n${suggestions.join("\n\n")}`
      : `✅ ${name}.ts looks well-optimized. No suggestions at this time.`;
  },
});

registerSkill({
  name: "optimize.benchmark",
  description: "Benchmark a skill's execution time.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      skillName: { type: "string", description: "Full skill name (e.g. 'weather.current')" },
      iterations: { type: "number", description: "Number of iterations (default 3, max 10)" },
    },
    required: ["skillName"],
  },
  async execute(args): Promise<string> {
    const skill = getAllSkills().find(s => s.name === String(args.skillName));
    if (!skill) return `Skill "${args.skillName}" not found.`;

    const iterations = Math.min(Number(args.iterations) || 3, 10);
    const times: number[] = [];

    for (let i = 0; i < iterations; i++) {
      const start = Date.now();
      try {
        await skill.execute({});
      } catch { /* benchmark ignores errors */ }
      times.push(Date.now() - start);
    }

    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const min = Math.min(...times);
    const max = Math.max(...times);

    return [
      `**Benchmark: ${args.skillName}** (${iterations} iterations)`,
      `  Avg: ${Math.round(avg)}ms`,
      `  Min: ${min}ms`,
      `  Max: ${max}ms`,
      `  Times: [${times.map(t => t + "ms").join(", ")}]`,
      ``,
      avg > 5000 ? "🔴 SLOW — needs optimization" :
      avg > 2000 ? "🟡 MODERATE — consider caching" :
      "🟢 FAST — no action needed",
    ].join("\n");
  },
});

registerSkill({
  name: "optimize.refactor",
  description: "Queue a code.request to refactor a skill.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      skillName: { type: "string", description: "Skill file to refactor" },
      approach: { type: "string", description: "Refactoring approach (e.g. 'add caching', 'split file', 'add retry logic')" },
    },
    required: ["skillName", "approach"],
  },
  async execute(args): Promise<string> {
    const codeRequestsPath = path.join(process.cwd(), "code-requests.json");
    try {
      const existing = fs.existsSync(codeRequestsPath)
        ? JSON.parse(fs.readFileSync(codeRequestsPath, "utf-8"))
        : [];

      existing.push({
        id: Date.now(),
        timestamp: new Date().toISOString(),
        task: `Refactor ${args.skillName}: ${args.approach}`,
        priority: "normal",
        files: [`src/skills/builtin/${String(args.skillName).replace(/\.ts$/, "")}.ts`],
        status: "pending",
        result: null,
      });

      fs.writeFileSync(codeRequestsPath, JSON.stringify(existing, null, 2));
      return `Code request queued: Refactor ${args.skillName} — ${args.approach}`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

log.debug("Registered 4 optimize.* skills");
