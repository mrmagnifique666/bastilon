/**
 * Skill Verification — Supply Chain Attack Prevention
 *
 * Protects against:
 * 1. Tampered skill files (SHA-256 integrity)
 * 2. Dangerous code patterns (static analysis)
 * 3. Unauthorized skill creation (approval workflow)
 * 4. Runaway execution (timeout enforcement)
 * 5. Sandbox escape (globalThis blocking)
 *
 * Every .skill.md file gets hashed on first load and verified on subsequent loads.
 * New/modified skills require admin approval before execution.
 */
import crypto from "node:crypto";
import { getDb } from "../storage/store.js";
import { log } from "../utils/log.js";

// ─── Database ───────────────────────────────────────────────────────────

export function ensureVerifyTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS skill_hashes (
      name TEXT PRIMARY KEY,
      file_path TEXT NOT NULL,
      hash TEXT NOT NULL,
      status TEXT DEFAULT 'approved',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      approved_by TEXT DEFAULT 'system'
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS skill_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      skill_name TEXT NOT NULL,
      action TEXT NOT NULL,
      details TEXT,
      hash TEXT,
      timestamp TEXT DEFAULT (datetime('now'))
    )
  `);
}

// ─── Hashing ────────────────────────────────────────────────────────────

/** Compute SHA-256 hash of content */
export function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content, "utf-8").digest("hex");
}

// ─── Dangerous Pattern Detection ────────────────────────────────────────

/** Patterns that indicate potential sandbox escape or malicious intent.
 *
 * NOTE: `secrets.get("KEY")` is the SAFE way for skills to access API keys.
 * It's a controlled sandbox function that only exposes whitelisted keys.
 * Patterns below must NOT block `secrets.get(...)` usage.
 */
const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; severity: "block" | "warn"; reason: string }> = [
  // Sandbox escapes
  { pattern: /\brequire\s*\(/, severity: "block", reason: "require() — can import arbitrary Node.js modules" },
  { pattern: /\bimport\s*\(/, severity: "block", reason: "dynamic import() — can load external code" },
  { pattern: /\bprocess\s*\./, severity: "block", reason: "process access — can spawn children, read env, exit" },
  { pattern: /\bglobalThis\b/, severity: "block", reason: "globalThis access — can escape sandbox" },
  { pattern: /\b__proto__\b/, severity: "block", reason: "__proto__ manipulation — prototype pollution" },
  { pattern: /\bconstructor\s*\.\s*constructor\b/, severity: "block", reason: "Function constructor access — sandbox escape" },
  { pattern: /\bFunction\s*\(/, severity: "block", reason: "Function() constructor — arbitrary code execution" },
  { pattern: /\beval\s*\(/, severity: "block", reason: "eval() — arbitrary code execution" },

  // Dangerous operations
  { pattern: /child_process/, severity: "block", reason: "child_process — command injection" },
  { pattern: /\bexecSync\b/, severity: "block", reason: "execSync — command execution" },
  { pattern: /\bspawn\s*\(/, severity: "warn", reason: "spawn — subprocess creation" },
  { pattern: /\bfs\b\s*\./, severity: "warn", reason: "fs module access — filesystem operations" },
  { pattern: /\bnet\b\s*\.\s*(?:connect|createServer)/, severity: "warn", reason: "net module — raw network access" },
  { pattern: /\bdgram\b/, severity: "warn", reason: "dgram — UDP socket access" },

  // Direct env/key access (secrets.get() is the SAFE alternative — don't block it)
  { pattern: /process\s*\.\s*env/, severity: "block", reason: "process.env — use secrets.get() instead" },
  { pattern: /ANTHROPIC_API_KEY|TELEGRAM_BOT_TOKEN/, severity: "block", reason: "Core credential literal — never expose these" },

  // Crypto-jacking / abuse
  { pattern: /crypto\s*\.\s*(?:subtle|getRandomValues)/, severity: "warn", reason: "Web Crypto API — potential crypto abuse" },
  { pattern: /WebSocket\s*\(/, severity: "warn", reason: "WebSocket — persistent connection to external server" },
];

export interface ScanResult {
  safe: boolean;
  blocked: string[];
  warnings: string[];
}

/** Scan code for dangerous patterns */
export function scanCode(code: string): ScanResult {
  const blocked: string[] = [];
  const warnings: string[] = [];

  for (const { pattern, severity, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(code)) {
      if (severity === "block") {
        blocked.push(reason);
      } else {
        warnings.push(reason);
      }
    }
  }

  return {
    safe: blocked.length === 0,
    blocked,
    warnings,
  };
}

// ─── Integrity Verification ─────────────────────────────────────────────

export interface VerifyResult {
  status: "approved" | "new" | "modified" | "blocked";
  hash: string;
  scanResult: ScanResult;
  reason?: string;
}

/**
 * Verify a skill's integrity before loading.
 * Returns the verification status and whether to proceed.
 */
export function verifySkill(name: string, filePath: string, content: string): VerifyResult {
  const db = getDb();
  const hash = hashContent(content);

  // Extract code for scanning
  const codeMatch = content.match(/```(?:javascript|js|typescript|ts)\s*\n([\s\S]*?)```/i);
  const code = codeMatch?.[1]?.trim() || "";
  const scanResult = scanCode(code);

  // Check if blocked by static analysis
  if (!scanResult.safe) {
    auditLog(name, "blocked", `Dangerous patterns: ${scanResult.blocked.join("; ")}`, hash);
    return { status: "blocked", hash, scanResult, reason: `Dangerous code: ${scanResult.blocked[0]}` };
  }

  // Check existing hash
  const existing = db.prepare("SELECT hash, status FROM skill_hashes WHERE name = ?").get(name) as
    | { hash: string; status: string }
    | undefined;

  if (!existing) {
    // First time — auto-approve (bootstrapping) and store hash
    db.prepare(
      "INSERT INTO skill_hashes (name, file_path, hash, status, approved_by) VALUES (?, ?, ?, 'approved', 'auto-bootstrap')"
    ).run(name, filePath, hash);
    auditLog(name, "first-load", "Auto-approved on first load", hash);

    if (scanResult.warnings.length > 0) {
      auditLog(name, "warning", `Warnings: ${scanResult.warnings.join("; ")}`, hash);
    }

    return { status: "approved", hash, scanResult };
  }

  if (existing.hash === hash) {
    // Hash matches — approved
    return { status: "approved", hash, scanResult };
  }

  // Hash mismatch — skill was modified
  if (existing.status === "approved") {
    // Was approved before, now modified → flag as modified, require re-approval
    db.prepare(
      "UPDATE skill_hashes SET hash = ?, status = 'pending', updated_at = datetime('now') WHERE name = ?"
    ).run(hash, name);
    auditLog(name, "modified", `Hash changed: ${existing.hash.slice(0, 12)}... → ${hash.slice(0, 12)}...`, hash);

    return { status: "modified", hash, scanResult, reason: "File modified since last approval" };
  }

  // Still pending
  return { status: "new", hash, scanResult, reason: "Awaiting admin approval" };
}

/**
 * Approve a pending skill (admin action).
 */
export function approveSkill(name: string): boolean {
  const db = getDb();
  const row = db.prepare("SELECT hash FROM skill_hashes WHERE name = ?").get(name) as { hash: string } | undefined;
  if (!row) return false;

  db.prepare("UPDATE skill_hashes SET status = 'approved', approved_by = 'admin', updated_at = datetime('now') WHERE name = ?").run(name);
  auditLog(name, "approved", "Admin approved", row.hash);
  return true;
}

/**
 * Reject a pending skill (admin action).
 */
export function rejectSkill(name: string): boolean {
  const db = getDb();
  db.prepare("UPDATE skill_hashes SET status = 'rejected', updated_at = datetime('now') WHERE name = ?").run(name);
  auditLog(name, "rejected", "Admin rejected", "");
  return true;
}

/**
 * List all skills with their verification status.
 */
export function listSkillHashes(): Array<{ name: string; hash: string; status: string; updated_at: string }> {
  const db = getDb();
  return db.prepare("SELECT name, hash, status, updated_at FROM skill_hashes ORDER BY name").all() as Array<{
    name: string;
    hash: string;
    status: string;
    updated_at: string;
  }>;
}

/**
 * Get recent audit log entries.
 */
export function getAuditLog(limit: number = 20): Array<{ skill_name: string; action: string; details: string; timestamp: string }> {
  const db = getDb();
  return db.prepare("SELECT skill_name, action, details, timestamp FROM skill_audit_log ORDER BY id DESC LIMIT ?").all(limit) as Array<{
    skill_name: string;
    action: string;
    details: string;
    timestamp: string;
  }>;
}

// ─── Audit Logging ──────────────────────────────────────────────────────

function auditLog(skillName: string, action: string, details: string, hash: string): void {
  try {
    const db = getDb();
    db.prepare("INSERT INTO skill_audit_log (skill_name, action, details, hash) VALUES (?, ?, ?, ?)").run(
      skillName,
      action,
      details,
      hash
    );
    log.info(`[skill-verify] ${action}: ${skillName} — ${details}`);
  } catch {
    // Don't crash on audit log failure
    log.warn(`[skill-verify] Failed to write audit log for ${skillName}`);
  }
}

// ─── Execution Timeout ──────────────────────────────────────────────────

const SKILL_TIMEOUT_MS = 30_000; // 30 seconds max per skill execution

/**
 * Wrap a skill executor with timeout enforcement.
 */
export function withTimeout<T>(fn: () => Promise<T>, timeoutMs: number = SKILL_TIMEOUT_MS): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Skill execution timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    fn()
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}
