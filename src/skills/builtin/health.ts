/**
 * Built-in skill: system.health
 * Observability dashboard — aggregate stats about Kingston's operations.
 */
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { registerSkill } from "../loader.js";
import { getDb } from "../../storage/store.js";
import { getAllSkills } from "../loader.js";

const startTime = Date.now();

registerSkill({
  name: "system.health",
  description:
    "Comprehensive health report: uptime, memory, DB stats, error rates, skill count, scheduler status.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {},
  },
  async execute(): Promise<string> {
    const db = getDb();
    const sections: string[] = [];

    // 1. Process info
    const uptimeMs = Date.now() - startTime;
    const uptimeH = (uptimeMs / 3600000).toFixed(1);
    const memUsage = process.memoryUsage();
    const heapMB = (memUsage.heapUsed / 1048576).toFixed(1);
    const rssMB = (memUsage.rss / 1048576).toFixed(1);
    sections.push(
      `**Process**\n` +
        `  Uptime: ${uptimeH}h\n` +
        `  PID: ${process.pid}\n` +
        `  Heap: ${heapMB} MB / RSS: ${rssMB} MB\n` +
        `  Node: ${process.version}`
    );

    // 2. System
    const freeMem = (os.freemem() / 1073741824).toFixed(1);
    const totalMem = (os.totalmem() / 1073741824).toFixed(1);
    const loadAvg = os.loadavg().map((l) => l.toFixed(2)).join(", ");
    sections.push(
      `**System**\n` +
        `  Memory: ${freeMem} GB free / ${totalMem} GB total\n` +
        `  Load: ${loadAvg}\n` +
        `  OS Uptime: ${(os.uptime() / 3600).toFixed(1)}h`
    );

    // 3. Database
    const dbPath = path.resolve("relay.db");
    let dbSize = "?";
    try {
      const stat = fs.statSync(dbPath);
      dbSize = (stat.size / 1048576).toFixed(1) + " MB";
    } catch { /* */ }

    const turnCount = (db.prepare("SELECT COUNT(*) as c FROM turns").get() as any).c;
    const noteCount = (db.prepare("SELECT COUNT(*) as c FROM notes").get() as any).c;
    const errorCount = (db.prepare("SELECT COUNT(*) as c FROM error_log WHERE resolved = 0").get() as any).c;
    const totalErrors = (db.prepare("SELECT COUNT(*) as c FROM error_log").get() as any).c;

    // Check if contacts table exists
    let contactCount = 0;
    try {
      contactCount = (db.prepare("SELECT COUNT(*) as c FROM contacts").get() as any).c;
    } catch { /* table may not exist yet */ }

    // Check reminders
    let pendingReminders = 0;
    try {
      pendingReminders = (db.prepare("SELECT COUNT(*) as c FROM scheduler_reminders WHERE fired = 0").get() as any).c;
    } catch { /* */ }

    sections.push(
      `**Database** (${dbSize})\n` +
        `  Turns: ${turnCount}\n` +
        `  Notes: ${noteCount}\n` +
        `  Contacts: ${contactCount}\n` +
        `  Errors: ${errorCount} open / ${totalErrors} total\n` +
        `  Reminders pending: ${pendingReminders}`
    );

    // 4. Skills
    const skills = getAllSkills();
    const adminSkills = skills.filter((s) => s.adminOnly).length;
    sections.push(
      `**Skills**\n` +
        `  Total: ${skills.length}\n` +
        `  Admin-only: ${adminSkills}\n` +
        `  Public: ${skills.length - adminSkills}`
    );

    // 5. Recent errors (last 24h)
    const dayAgo = Math.floor(Date.now() / 1000) - 86400;
    const recentErrors = (
      db.prepare("SELECT COUNT(*) as c FROM error_log WHERE timestamp > ?").get(dayAgo) as any
    ).c;
    sections.push(
      `**Errors (24h)**\n` +
        `  Count: ${recentErrors}\n` +
        `  Open: ${errorCount}`
    );

    // 6. Learned rules
    const rulesPath = path.resolve("relay", "learned-rules.md");
    let ruleCount = 0;
    try {
      if (fs.existsSync(rulesPath)) {
        const content = fs.readFileSync(rulesPath, "utf-8");
        ruleCount = (content.match(/^## /gm) || []).length;
      }
    } catch { /* */ }

    const patternsPath = path.resolve("relay", "self-review.json");
    let patternCount = 0;
    try {
      if (fs.existsSync(patternsPath)) {
        const data = JSON.parse(fs.readFileSync(patternsPath, "utf-8"));
        patternCount = Object.keys(data).length;
      }
    } catch { /* */ }

    sections.push(
      `**Learning**\n` +
        `  Error patterns tracked: ${patternCount}\n` +
        `  Graduated rules: ${ruleCount}`
    );

    return `Kingston Health Report\n${"=".repeat(30)}\n\n${sections.join("\n\n")}`;
  },
});
