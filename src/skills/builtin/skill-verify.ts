/**
 * Skill Verification management skills — admin tools for supply chain security.
 * Enables: scan code, approve/reject modified skills, view audit log.
 */
import { registerSkill } from "../loader.js";
import { log } from "../../utils/log.js";
import {
  scanCode,
  approveSkill,
  rejectSkill,
  listSkillHashes,
  getAuditLog,
  verifySkill,
  hashContent,
} from "../../security/skill-verify.js";
import fs from "node:fs";

// ─── verify.scan ────────────────────────────────────────────────────────

registerSkill({
  name: "verify.scan",
  description: "Scan code for dangerous patterns (supply chain protection)",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      code: { type: "string", description: "JavaScript code to scan" },
    },
    required: ["code"],
  },
  execute: async (args) => {
    const code = args.code as string;
    const result = scanCode(code);

    if (result.safe && result.warnings.length === 0) {
      return "✅ Code is clean — no dangerous patterns detected.";
    }

    const lines: string[] = [];
    if (result.blocked.length > 0) {
      lines.push("⛔ BLOCKED patterns:");
      result.blocked.forEach(b => lines.push(`  - ${b}`));
    }
    if (result.warnings.length > 0) {
      lines.push("⚠️ Warnings:");
      result.warnings.forEach(w => lines.push(`  - ${w}`));
    }

    return `${result.safe ? "⚠️" : "⛔"} Scan result:\n${lines.join("\n")}`;
  },
});

// ─── verify.approve ─────────────────────────────────────────────────────

registerSkill({
  name: "verify.approve",
  description: "Approve a pending/modified skill for execution",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Skill name to approve" },
    },
    required: ["name"],
  },
  execute: async (args) => {
    const name = args.name as string;
    const success = approveSkill(name);
    if (success) {
      return `✅ Skill "${name}" approved for execution.`;
    }
    return `❌ Skill "${name}" not found in verification registry.`;
  },
});

// ─── verify.reject ──────────────────────────────────────────────────────

registerSkill({
  name: "verify.reject",
  description: "Reject a pending skill to prevent execution",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Skill name to reject" },
    },
    required: ["name"],
  },
  execute: async (args) => {
    const name = args.name as string;
    const success = rejectSkill(name);
    if (success) {
      return `⛔ Skill "${name}" rejected.`;
    }
    return `❌ Skill "${name}" not found in verification registry.`;
  },
});

// ─── verify.status ──────────────────────────────────────────────────────

registerSkill({
  name: "verify.status",
  description: "Show verification status of all skills (hashes, approvals)",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      filter: { type: "string", description: "Filter by status: pending, approved, blocked, all" },
    },
  },
  execute: async (args) => {
    const filter = (args.filter as string) || "all";
    let skills = listSkillHashes();

    if (filter !== "all") {
      skills = skills.filter(s => s.status === filter);
    }

    if (skills.length === 0) {
      return `No skills found${filter !== "all" ? ` with status "${filter}"` : ""}.`;
    }

    const statusIcon: Record<string, string> = {
      approved: "✅",
      pending: "⏳",
      blocked: "⛔",
      rejected: "❌",
    };

    const lines = skills.map(s =>
      `${statusIcon[s.status] || "?"} **${s.name}** — ${s.status} (${s.hash.slice(0, 12)}...) [${s.updated_at}]`
    );

    return `🔐 Skill Verification Status (${skills.length}):\n\n${lines.join("\n")}`;
  },
});

// ─── verify.audit ───────────────────────────────────────────────────────

registerSkill({
  name: "verify.audit",
  description: "Show recent skill verification audit log",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      limit: { type: "number", description: "Number of entries (default 20)" },
    },
  },
  execute: async (args) => {
    const limit = (args.limit as number) || 20;
    const entries = getAuditLog(limit);

    if (entries.length === 0) {
      return "No audit log entries.";
    }

    const lines = entries.map(e =>
      `[${e.timestamp}] ${e.action}: **${e.skill_name}** — ${e.details}`
    );

    return `📋 Skill Audit Log (last ${entries.length}):\n\n${lines.join("\n")}`;
  },
});

log.info("[skill-verify] Registered 5 verification management skills");
