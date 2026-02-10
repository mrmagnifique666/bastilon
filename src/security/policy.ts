/**
 * Security policy: user allowlist, tool allowlist, and tool profiles.
 * Never execute arbitrary shell commands — only allowlisted tools.
 *
 * Tool profiles (OpenClaw-like):
 *   "default"    — safe tools only (notes, help, web, data)
 *   "coding"     — + files, code, git, shell
 *   "automation" — + browser, api, ftp, agents, scheduler
 *   "full"       — all tools (no profile filtering)
 */
import { config } from "../config/env.js";
import { getSkill } from "../skills/loader.js";
import { log } from "../utils/log.js";
import { saveAdminSession, isAdminSession, clearAdminSession } from "../storage/store.js";

// ── Tool Profiles ──────────────────────────────────────────

type ToolProfile = "default" | "coding" | "automation" | "full";

/** Namespace prefixes allowed per profile (cumulative). */
const PROFILE_NAMESPACES: Record<ToolProfile, string[]> = {
  default: [
    "help", "notes.", "memory.", "system.",
    "web.", "weather.", "crypto.", "stocks.", "time.", "market.",
    "translate.", "math.", "hash.", "convert.",
    "telegram.", "calendar.", "contacts.",
    "rss.", "errors.", "config.",
    "office.", "desktop.system_info", "desktop.notify",
  ],
  coding: [
    // default + coding tools
    "help", "notes.", "memory.", "system.",
    "web.", "weather.", "crypto.", "stocks.", "time.", "market.",
    "translate.", "math.", "hash.", "convert.",
    "telegram.", "calendar.", "contacts.",
    "rss.", "errors.", "config.",
    // coding extras
    "files.", "code.", "git.", "shell.", "learn.",
    "office.", "desktop.", "process.",
  ],
  automation: [
    // coding + automation tools
    "help", "notes.", "memory.", "system.",
    "web.", "weather.", "crypto.", "stocks.", "time.", "market.",
    "translate.", "math.", "hash.", "convert.",
    "telegram.", "calendar.", "contacts.",
    "rss.", "errors.", "config.",
    "files.", "code.", "git.", "shell.", "learn.",
    // automation extras
    "browser.", "api.", "ftp.", "agents.", "scheduler.",
    "gmail.", "sms.", "whatsapp.", "phone.",
    "stripe.", "booking.", "hubspot.",
    "twitter.", "linkedin.", "reddit.", "discord.", "facebook.", "instagram.",
    "moltbook.", "analytics.", "experiment.", "optimize.",
    "network.", "security.", "image.",
  ],
  full: [], // empty = no filtering
};

/** Check if a tool name is allowed by the active profile. */
function isToolInProfile(toolName: string): boolean {
  const profile = config.toolProfile as ToolProfile;
  if (profile === "full") return true;

  const allowed = PROFILE_NAMESPACES[profile];
  if (!allowed) return true; // unknown profile = full access

  for (const prefix of allowed) {
    if (toolName === prefix) return true;          // exact match (e.g. "help")
    if (toolName.startsWith(prefix)) return true;  // namespace match (e.g. "notes.add")
  }

  log.debug(`[policy] Tool "${toolName}" blocked by profile "${profile}"`);
  return false;
}

/** Get the current active profile name. */
export function getActiveProfile(): string {
  return config.toolProfile || "full";
}

// ── User & Admin ───────────────────────────────────────────

/**
 * Returns true if the Telegram user ID is in the allowlist.
 * An empty allowlist means nobody is allowed (secure default).
 */
export function isUserAllowed(userId: number): boolean {
  if (config.allowedUsers.length === 0) {
    log.warn("TELEGRAM_ALLOWED_USERS is empty — all users are blocked.");
    return false;
  }
  return config.allowedUsers.includes(userId);
}

export function isAdmin(userId: number): boolean {
  return isAdminSession(userId);
}

export function tryAdminAuth(userId: number, passphrase: string): boolean {
  if (!config.adminPassphrase) return false;
  if (passphrase === config.adminPassphrase) {
    saveAdminSession(userId);
    log.info(`User ${userId} authenticated as admin (persisted to DB).`);
    return true;
  }
  return false;
}

export function revokeAdmin(userId: number): void {
  clearAdminSession(userId);
  log.info(`Revoked admin for user ${userId}.`);
}

// ── Tool Permission ────────────────────────────────────────

/**
 * Checks whether a tool name is permitted by the env allowlist.
 * Supports wildcards: "notes.*" matches "notes.add", "notes.list", etc.
 */
export function isToolAllowed(toolName: string): boolean {
  for (const pattern of config.allowedTools) {
    if (pattern === toolName) return true;
    if (pattern.endsWith(".*")) {
      const prefix = pattern.slice(0, -1); // "notes."
      if (toolName.startsWith(prefix)) return true;
    }
  }
  log.warn(`Blocked disallowed tool: ${toolName}`);
  return false;
}

/**
 * Combined permission check:
 * 1. Tool must pass the active profile filter
 * 2. Tool must be on the env allowlist
 * 3. If adminOnly, user must be authenticated admin
 */
export function isToolPermitted(toolName: string, userId: number): boolean {
  // Profile check (first gate)
  if (!isToolInProfile(toolName)) {
    log.warn(`Tool "${toolName}" blocked by profile "${config.toolProfile}"`);
    return false;
  }

  // Allowlist check (second gate)
  if (!isToolAllowed(toolName)) return false;

  // Admin check (third gate)
  const skill = getSkill(toolName);
  if (skill?.adminOnly) {
    const adminStatus = isAdmin(userId);
    if (!adminStatus) {
      log.warn(`Non-admin user ${userId} blocked from admin tool: ${toolName}`);
      return false;
    }
    log.debug(`Admin user ${userId} permitted for admin tool: ${toolName}`);
  }

  return true;
}
