/**
 * Self-Improving SOUL.md — Nightly analysis + automatic SOUL rewrite.
 *
 * Inspired by Martin Alderson's "Self-improving CLAUDE.md files" pattern:
 * Analyze session logs, error patterns, and user corrections to identify
 * areas where Kingston can improve, then rewrite SOUL.md accordingly.
 *
 * Skills:
 * - soul.analyze    — Analyze recent errors, corrections, and patterns
 * - soul.improve    — Automatically propose + apply SOUL.md improvements
 * - soul.changelog  — View history of SOUL.md changes
 * - soul.rollback   — Revert to previous SOUL.md version
 */
import fs from "node:fs";
import path from "node:path";
import { registerSkill } from "../loader.js";
import { getDb } from "../../storage/store.js";
import { log } from "../../utils/log.js";

const SOUL_FILE = path.resolve(process.cwd(), "relay", "SOUL.md");
const CHANGELOG_FILE = path.resolve(process.cwd(), "relay", "soul-changelog.json");
const BACKUP_DIR = path.resolve(process.cwd(), "relay", "soul-backups");

interface SoulChange {
  timestamp: string;
  section: string;
  reason: string;
  before: string;
  after: string;
  source: string; // "auto" | "manual" | "nightly"
}

function loadChangelog(): SoulChange[] {
  try {
    if (fs.existsSync(CHANGELOG_FILE)) {
      return JSON.parse(fs.readFileSync(CHANGELOG_FILE, "utf-8"));
    }
  } catch {}
  return [];
}

function saveChangelog(changes: SoulChange[]): void {
  fs.writeFileSync(CHANGELOG_FILE, JSON.stringify(changes.slice(-100), null, 2));
}

function backupSoul(): string {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(BACKUP_DIR, `SOUL_${ts}.md`);
  if (fs.existsSync(SOUL_FILE)) {
    fs.copyFileSync(SOUL_FILE, backupPath);
  }
  return backupPath;
}

// ── soul.analyze ─────────────────────────────────────────────────────
registerSkill({
  name: "soul.analyze",
  description: "Analyze recent errors, corrections, and patterns to identify SOUL.md improvement opportunities",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      hours: { type: "string", description: "Hours to look back (default: 24)" },
    },
    required: [],
  },
  async execute(args) {
    const hours = args.hours ? parseInt(args.hours as string) : 24;
    const cutoff = Math.floor(Date.now() / 1000) - hours * 3600;
    const db = getDb();
    const findings: string[] = [];

    // 1. Error patterns
    try {
      const errors = db.prepare(
        `SELECT error, model, COUNT(*) as c FROM error_log
         WHERE timestamp > ? GROUP BY error ORDER BY c DESC LIMIT 10`
      ).all(cutoff) as { error: string; model: string; c: number }[];

      if (errors.length > 0) {
        findings.push(`ERROR PATTERNS (last ${hours}h):`);
        for (const e of errors) {
          const preview = e.error.slice(0, 100).replace(/\n/g, " ");
          findings.push(`  [${e.c}x] ${preview}`);
        }
      }
    } catch {}

    // 2. Agent failures
    try {
      const failures = db.prepare(
        `SELECT agent_id, COUNT(*) as c, GROUP_CONCAT(DISTINCT error_msg) as errors
         FROM agent_runs WHERE started_at > ? AND outcome != 'success'
         GROUP BY agent_id ORDER BY c DESC`
      ).all(cutoff) as { agent_id: string; c: number; errors: string }[];

      if (failures.length > 0) {
        findings.push(`\nAGENT FAILURES:`);
        for (const f of failures) {
          const errPreview = (f.errors || "unknown").slice(0, 80);
          findings.push(`  ${f.agent_id}: ${f.c} failures — ${errPreview}`);
        }
      }
    } catch {}

    // 3. User corrections (from semantic memory)
    try {
      const corrections = db.prepare(
        `SELECT content FROM memory_items
         WHERE category = 'correction' AND created_at > ?
         ORDER BY created_at DESC LIMIT 10`
      ).all(cutoff) as { content: string }[];

      if (corrections.length > 0) {
        findings.push(`\nUSER CORRECTIONS:`);
        for (const c of corrections) {
          findings.push(`  - ${c.content.slice(0, 100)}`);
        }
      }
    } catch {}

    // 4. Learning patterns from learn.admit
    try {
      const learnings = db.prepare(
        `SELECT topic, what_happened, fix FROM ignorance_log
         WHERE logged_at > datetime(?, 'unixepoch') AND resolved = 0
         ORDER BY severity DESC LIMIT 10`
      ).all(cutoff) as { topic: string; what_happened: string; fix: string }[];

      if (learnings.length > 0) {
        findings.push(`\nUNRESOLVED LEARNINGS:`);
        for (const l of learnings) {
          findings.push(`  [${l.topic}] ${l.what_happened.slice(0, 80)} → Fix: ${l.fix.slice(0, 60)}`);
        }
      }
    } catch {}

    // 5. Causal patterns with negative valence
    try {
      const negative = db.prepare(
        `SELECT action, context, outcome FROM causal_log
         WHERE timestamp > ? AND valence < 0
         ORDER BY valence ASC LIMIT 10`
      ).all(cutoff) as { action: string; context: string; outcome: string }[];

      if (negative.length > 0) {
        findings.push(`\nNEGATIVE OUTCOMES:`);
        for (const n of negative) {
          findings.push(`  Action: ${n.action.slice(0, 50)} → ${n.outcome.slice(0, 50)}`);
        }
      }
    } catch {}

    // 6. Current SOUL.md stats
    let soulStats = "";
    try {
      if (fs.existsSync(SOUL_FILE)) {
        const content = fs.readFileSync(SOUL_FILE, "utf-8");
        const lines = content.split("\n").length;
        const sections = content.match(/^## /gm)?.length || 0;
        const lastModified = fs.statSync(SOUL_FILE).mtime.toISOString();
        soulStats = `\nSOUL.md: ${lines} lines, ${sections} sections, last modified: ${lastModified}`;
      }
    } catch {}

    if (findings.length === 0) {
      return `No significant patterns found in the last ${hours}h. Kingston is performing well.${soulStats}`;
    }

    return `SOUL ANALYSIS (last ${hours}h):\n\n${findings.join("\n")}${soulStats}\n\n` +
      `Use soul.improve to automatically apply improvements based on this analysis.`;
  },
});

// ── soul.improve ─────────────────────────────────────────────────────
registerSkill({
  name: "soul.improve",
  description: "Propose and apply SOUL.md improvements based on error analysis. Creates backup first.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      section: { type: "string", description: "SOUL.md section to improve (e.g., 'What I\\'ve Learned')" },
      lesson: { type: "string", description: "New lesson or rule to add" },
      reason: { type: "string", description: "Why this improvement matters" },
    },
    required: ["lesson", "reason"],
  },
  async execute(args) {
    const section = (args.section as string) || "What I've Learned (living lessons)";
    const lesson = args.lesson as string;
    const reason = args.reason as string;

    // Backup first
    const backupPath = backupSoul();

    try {
      if (!fs.existsSync(SOUL_FILE)) {
        return "SOUL.md not found. Cannot improve.";
      }

      let content = fs.readFileSync(SOUL_FILE, "utf-8");

      // Find the section
      const sectionRegex = new RegExp(`## ${section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i");
      const sectionMatch = content.match(sectionRegex);

      if (sectionMatch && sectionMatch.index !== undefined) {
        // Find the end of the section (next ## or end of file)
        const afterSection = content.slice(sectionMatch.index + sectionMatch[0].length);
        const nextSection = afterSection.search(/\n## /);
        const insertPoint = nextSection === -1
          ? content.length
          : sectionMatch.index + sectionMatch[0].length + nextSection;

        // Add the lesson before the next section
        const newLesson = `\n- ${lesson}`;
        content = content.slice(0, insertPoint) + newLesson + content.slice(insertPoint);

        fs.writeFileSync(SOUL_FILE, content);

        // Log the change
        const changelog = loadChangelog();
        changelog.push({
          timestamp: new Date().toISOString(),
          section,
          reason,
          before: "(appended)",
          after: lesson,
          source: "auto",
        });
        saveChangelog(changelog);

        return `SOUL.md improved!\n\nSection: ${section}\nAdded: "${lesson}"\nReason: ${reason}\nBackup: ${path.basename(backupPath)}\n\n` +
          `Change logged to soul-changelog.json. Use soul.rollback to revert if needed.`;
      } else {
        // Section not found — append at the end
        content += `\n\n## ${section}\n- ${lesson}`;
        fs.writeFileSync(SOUL_FILE, content);

        const changelog = loadChangelog();
        changelog.push({
          timestamp: new Date().toISOString(),
          section,
          reason,
          before: "(new section)",
          after: lesson,
          source: "auto",
        });
        saveChangelog(changelog);

        return `SOUL.md improved (new section created)!\n\nSection: ${section}\nAdded: "${lesson}"\nReason: ${reason}\nBackup: ${path.basename(backupPath)}`;
      }
    } catch (err) {
      return `Error improving SOUL.md: ${err}\nBackup saved at: ${backupPath}`;
    }
  },
});

// ── soul.changelog ───────────────────────────────────────────────────
registerSkill({
  name: "soul.changelog",
  description: "View history of SOUL.md automatic changes",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      limit: { type: "string", description: "Number of entries (default: 10)" },
    },
    required: [],
  },
  async execute(args) {
    const limit = args.limit ? parseInt(args.limit as string) : 10;
    const changelog = loadChangelog();

    if (changelog.length === 0) {
      return "No SOUL.md changes recorded yet.";
    }

    const recent = changelog.slice(-limit);
    const lines = recent.map(c => {
      const date = c.timestamp.slice(0, 16);
      return `[${date}] [${c.source}] ${c.section}\n  Added: "${c.after.slice(0, 80)}"\n  Reason: ${c.reason.slice(0, 80)}`;
    });

    return `SOUL.md CHANGELOG (last ${limit}):\n\n${lines.join("\n\n")}\n\nTotal changes: ${changelog.length}`;
  },
});

// ── soul.rollback ────────────────────────────────────────────────────
registerSkill({
  name: "soul.rollback",
  description: "Revert SOUL.md to a previous backup version",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      backup: { type: "string", description: "Backup filename (from soul.changelog). If empty, uses most recent backup." },
    },
    required: [],
  },
  async execute(args) {
    const backupName = args.backup as string | undefined;

    if (!fs.existsSync(BACKUP_DIR)) {
      return "No backups found. BACKUP_DIR does not exist.";
    }

    const backups = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith("SOUL_") && f.endsWith(".md"))
      .sort()
      .reverse();

    if (backups.length === 0) {
      return "No backup files found.";
    }

    const target = backupName
      ? backups.find(b => b.includes(backupName))
      : backups[0];

    if (!target) {
      return `Backup "${backupName}" not found. Available: ${backups.slice(0, 5).join(", ")}`;
    }

    const backupPath = path.join(BACKUP_DIR, target);

    // Safety: backup current before rollback
    const preRollbackBackup = backupSoul();

    try {
      fs.copyFileSync(backupPath, SOUL_FILE);

      const changelog = loadChangelog();
      changelog.push({
        timestamp: new Date().toISOString(),
        section: "FULL ROLLBACK",
        reason: `Rolled back to ${target}`,
        before: "current",
        after: target,
        source: "manual",
      });
      saveChangelog(changelog);

      return `SOUL.md rolled back to: ${target}\nPre-rollback backup: ${path.basename(preRollbackBackup)}\n\nAvailable backups: ${backups.length}`;
    } catch (err) {
      return `Error during rollback: ${err}`;
    }
  },
});
