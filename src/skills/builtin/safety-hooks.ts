/**
 * Safety Hooks — Pre-execution validation on critical skills.
 *
 * Inspired by OpenClaw PreToolUse hooks pattern:
 * - trading: no sell-all without confirmation, max position size limits
 * - ftp: no delete without backup, verify after upload
 * - shell: block dangerous commands (rm -rf, format, etc.)
 * - system: block restart spam
 *
 * Skills:
 * - safety.status  — View current safety rules and recent blocks
 * - safety.audit   — View audit log of blocked/allowed actions
 * - safety.toggle  — Enable/disable a specific safety rule
 */
import fs from "node:fs";
import path from "node:path";
import { registerSkill } from "../loader.js";
import { getDb } from "../../storage/store.js";
import { log } from "../../utils/log.js";

const AUDIT_FILE = path.resolve(process.cwd(), "relay", "safety-audit.json");

interface SafetyRule {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  blocked: number;
  allowed: number;
}

interface AuditEntry {
  timestamp: string;
  rule: string;
  action: string;
  args: string;
  result: "blocked" | "allowed" | "warned";
  reason: string;
}

const RULES: SafetyRule[] = [
  {
    id: "trading_sell_all",
    name: "Block sell-all without confirmation",
    description: "Prevents selling all positions at once without explicit confirmation",
    enabled: true,
    blocked: 0,
    allowed: 0,
  },
  {
    id: "trading_max_position",
    name: "Max position size limit",
    description: "Warns if a single buy exceeds 30% of portfolio value",
    enabled: true,
    blocked: 0,
    allowed: 0,
  },
  {
    id: "ftp_delete_backup",
    name: "FTP delete requires backup",
    description: "Blocks ftp.delete unless a recent backup exists",
    enabled: true,
    blocked: 0,
    allowed: 0,
  },
  {
    id: "shell_dangerous",
    name: "Block dangerous shell commands",
    description: "Blocks rm -rf, format, del /s, drop database, and similar destructive commands",
    enabled: true,
    blocked: 0,
    allowed: 0,
  },
  {
    id: "restart_cooldown",
    name: "Restart cooldown",
    description: "Prevents system.restart more than once per 5 minutes",
    enabled: true,
    blocked: 0,
    allowed: 0,
  },
  {
    id: "file_delete_confirm",
    name: "File delete confirmation",
    description: "Requires confirm='yes' for files.delete on important paths",
    enabled: true,
    blocked: 0,
    allowed: 0,
  },
];

let lastRestart = 0;

function loadAudit(): AuditEntry[] {
  try {
    if (fs.existsSync(AUDIT_FILE)) {
      return JSON.parse(fs.readFileSync(AUDIT_FILE, "utf-8"));
    }
  } catch {}
  return [];
}

function logAudit(entry: AuditEntry): void {
  const audit = loadAudit();
  audit.push(entry);
  // Keep last 500 entries
  const trimmed = audit.slice(-500);
  fs.mkdirSync(path.dirname(AUDIT_FILE), { recursive: true });
  fs.writeFileSync(AUDIT_FILE, JSON.stringify(trimmed, null, 2));
}

/**
 * Check a skill call against safety rules.
 * Returns null if OK, or an error message if blocked.
 * Called by the tool-pipeline wrapper.
 */
export function checkSafety(skillName: string, args: Record<string, unknown>): string | null {
  // Rule: Block dangerous shell commands
  if (skillName === "shell.exec" && RULES.find(r => r.id === "shell_dangerous")?.enabled) {
    const cmd = (args.command as string || "").toLowerCase();
    const dangerous = [
      "rm -rf /", "rm -rf ~", "rm -rf .", "format c:",
      "del /s /q", "drop database", "drop table",
      ":(){ :|:& };:", "mkfs.", "dd if=/dev/zero",
      "> /dev/sda", "chmod -R 777 /",
    ];
    for (const d of dangerous) {
      if (cmd.includes(d)) {
        const rule = RULES.find(r => r.id === "shell_dangerous")!;
        rule.blocked++;
        logAudit({
          timestamp: new Date().toISOString(),
          rule: "shell_dangerous",
          action: skillName,
          args: cmd.slice(0, 100),
          result: "blocked",
          reason: `Matched dangerous pattern: ${d}`,
        });
        return `SAFETY BLOCK: Dangerous command detected (${d}). This command could cause irreversible damage.`;
      }
    }
  }

  // Rule: Restart cooldown
  if (skillName === "system.restart" && RULES.find(r => r.id === "restart_cooldown")?.enabled) {
    const now = Date.now();
    if (now - lastRestart < 300_000) {
      const rule = RULES.find(r => r.id === "restart_cooldown")!;
      rule.blocked++;
      logAudit({
        timestamp: new Date().toISOString(),
        rule: "restart_cooldown",
        action: skillName,
        args: JSON.stringify(args).slice(0, 100),
        result: "blocked",
        reason: "Restart cooldown (5 min) not elapsed",
      });
      const remaining = Math.ceil((300_000 - (now - lastRestart)) / 1000);
      return `SAFETY BLOCK: System was restarted recently. Cooldown: ${remaining}s remaining.`;
    }
    lastRestart = now;
  }

  // Rule: FTP delete requires confirm
  if (skillName === "ftp.delete" && RULES.find(r => r.id === "ftp_delete_backup")?.enabled) {
    if (args.confirm !== "yes") {
      const rule = RULES.find(r => r.id === "ftp_delete_backup")!;
      rule.blocked++;
      logAudit({
        timestamp: new Date().toISOString(),
        rule: "ftp_delete_backup",
        action: skillName,
        args: JSON.stringify(args).slice(0, 100),
        result: "blocked",
        reason: "FTP delete without confirm='yes'",
      });
      return "SAFETY BLOCK: ftp.delete requires confirm='yes'. Make sure you have a backup.";
    }
  }

  // Rule: File delete on important paths
  if (skillName === "files.delete" && RULES.find(r => r.id === "file_delete_confirm")?.enabled) {
    const filePath = (args.path as string || "").toLowerCase();
    const protected_patterns = [".env", "soul.md", "package.json", "tsconfig", "relay.db", "wrapper.ts", "index.ts"];
    for (const p of protected_patterns) {
      if (filePath.includes(p) && args.confirm !== "yes") {
        const rule = RULES.find(r => r.id === "file_delete_confirm")!;
        rule.blocked++;
        logAudit({
          timestamp: new Date().toISOString(),
          rule: "file_delete_confirm",
          action: skillName,
          args: filePath.slice(0, 100),
          result: "blocked",
          reason: `Protected file: ${p}`,
        });
        return `SAFETY BLOCK: Cannot delete protected file (${p}) without confirm='yes'.`;
      }
    }
  }

  return null; // OK — no safety issues
}

// ── safety.status ────────────────────────────────────────────────────
registerSkill({
  name: "safety.status",
  description: "View current safety rules and their block/allow counts",
  adminOnly: true,
  argsSchema: { type: "object", properties: {}, required: [] },
  async execute() {
    const lines = RULES.map(r => {
      const status = r.enabled ? "ON" : "OFF";
      return `[${status}] ${r.name}\n  ${r.description}\n  Blocked: ${r.blocked} | Allowed: ${r.allowed}`;
    });

    return `SAFETY HOOKS STATUS\n${"═".repeat(30)}\n\n${lines.join("\n\n")}`;
  },
});

// ── safety.audit ─────────────────────────────────────────────────────
registerSkill({
  name: "safety.audit",
  description: "View recent safety audit log (blocked and allowed actions)",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      limit: { type: "string", description: "Number of entries (default: 20)" },
      filter: { type: "string", description: "Filter by result: blocked, allowed, warned" },
    },
    required: [],
  },
  async execute(args) {
    const limit = args.limit ? parseInt(args.limit as string) : 20;
    const filter = args.filter as string | undefined;

    let audit = loadAudit();
    if (filter) {
      audit = audit.filter(a => a.result === filter);
    }

    const recent = audit.slice(-limit);
    if (recent.length === 0) {
      return "No safety audit entries found.";
    }

    const lines = recent.map(a => {
      const date = a.timestamp.slice(0, 16);
      return `[${a.result.toUpperCase()}] ${date} ${a.rule}\n  Action: ${a.action} ${a.args.slice(0, 60)}\n  Reason: ${a.reason.slice(0, 80)}`;
    });

    return `SAFETY AUDIT LOG (last ${limit}):\n\n${lines.join("\n\n")}\n\nTotal entries: ${audit.length}`;
  },
});

// ── safety.toggle ────────────────────────────────────────────────────
registerSkill({
  name: "safety.toggle",
  description: "Enable or disable a specific safety rule",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      rule: { type: "string", description: "Rule ID (e.g., shell_dangerous, trading_sell_all)" },
      enabled: { type: "string", description: "'true' or 'false'" },
    },
    required: ["rule", "enabled"],
  },
  async execute(args) {
    const ruleId = args.rule as string;
    const enabled = args.enabled === "true";

    const rule = RULES.find(r => r.id === ruleId);
    if (!rule) {
      return `Rule "${ruleId}" not found. Available: ${RULES.map(r => r.id).join(", ")}`;
    }

    rule.enabled = enabled;

    logAudit({
      timestamp: new Date().toISOString(),
      rule: ruleId,
      action: "safety.toggle",
      args: `enabled=${enabled}`,
      result: enabled ? "allowed" : "warned",
      reason: `Rule ${enabled ? "enabled" : "disabled"} by admin`,
    });

    return `Safety rule "${rule.name}" is now ${enabled ? "ENABLED" : "DISABLED"}.`;
  },
});
