/**
 * Agent Profile System — loads per-agent configuration from relay/agents/{id}/.
 *
 * Each agent can have a profile folder with:
 *   config.json   — heartbeat, enabled, cycle count, quiet hours, tool rules
 *   prompts/      — cycle prompt files (cycle-0.md, cycle-1.md, ...)
 *   rules.json    — tool allowlist/blocklist (optional)
 *
 * Profiles work alongside existing hardcoded definitions.
 * An agent with a profile folder uses file-based prompts; others keep their code-based buildPrompt.
 */
import fs from "node:fs";
import path from "node:path";
import { log } from "../utils/log.js";

const PROFILES_DIR = path.resolve("relay/agents");

// ── Types ────────────────────────────────────────────────────────────

export interface AgentProfile {
  id: string;
  name: string;
  role: string;
  heartbeatMs: number;
  enabled: boolean;
  chatId: number;
  cycleCount: number;
  quietHours?: { start: number; end: number };
  tools?: {
    allowlist?: string[];
    blocklist?: string[];
  };
  variables?: Record<string, string>;
}

export interface ProfilePrompt {
  cycle: number;
  content: string;
}

// ── Cache ────────────────────────────────────────────────────────────

const profileCache = new Map<string, { profile: AgentProfile; mtime: number }>();
const promptCache = new Map<string, { prompts: Map<number, string>; mtime: number }>();

// ── Loaders ──────────────────────────────────────────────────────────

/** Check if a profile folder exists for an agent */
export function hasProfile(agentId: string): boolean {
  const configPath = path.join(PROFILES_DIR, agentId, "config.json");
  return fs.existsSync(configPath);
}

/** Load agent profile from relay/agents/{id}/config.json */
export function loadProfile(agentId: string): AgentProfile | null {
  const configPath = path.join(PROFILES_DIR, agentId, "config.json");
  if (!fs.existsSync(configPath)) return null;

  try {
    const stat = fs.statSync(configPath);
    const cached = profileCache.get(agentId);
    if (cached && cached.mtime === stat.mtimeMs) return cached.profile;

    const raw = fs.readFileSync(configPath, "utf-8");
    const profile = JSON.parse(raw) as AgentProfile;
    profile.id = agentId; // ensure ID matches folder name
    profileCache.set(agentId, { profile, mtime: stat.mtimeMs });
    log.debug(`[profiles] Loaded profile for ${agentId}`);
    return profile;
  } catch (err) {
    log.warn(`[profiles] Failed to load profile for ${agentId}: ${err}`);
    return null;
  }
}

/** Load cycle prompts from relay/agents/{id}/prompts/ */
export function loadPrompts(agentId: string): Map<number, string> {
  const promptsDir = path.join(PROFILES_DIR, agentId, "prompts");
  if (!fs.existsSync(promptsDir)) return new Map();

  try {
    const stat = fs.statSync(promptsDir);
    const cached = promptCache.get(agentId);
    if (cached && cached.mtime === stat.mtimeMs) return cached.prompts;

    const prompts = new Map<number, string>();
    const files = fs.readdirSync(promptsDir).filter(f => f.endsWith(".md"));

    for (const file of files) {
      const match = file.match(/^cycle-(\d+)\.md$/);
      if (match) {
        const cycle = parseInt(match[1], 10);
        const content = fs.readFileSync(path.join(promptsDir, file), "utf-8").trim();
        if (content) prompts.set(cycle, content);
      }
    }

    promptCache.set(agentId, { prompts, mtime: stat.mtimeMs });
    log.debug(`[profiles] Loaded ${prompts.size} prompts for ${agentId}`);
    return prompts;
  } catch (err) {
    log.warn(`[profiles] Failed to load prompts for ${agentId}: ${err}`);
    return new Map();
  }
}

/** Render a prompt template with variables */
export function renderPrompt(template: string, variables: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(variables)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
  }
  return result;
}

/** Build prompt function from profile (replaces hardcoded buildPrompt) */
export function buildProfilePrompt(agentId: string): ((cycle: number) => string | null) {
  return (cycle: number): string | null => {
    const profile = loadProfile(agentId);
    if (!profile) return null;

    // Check quiet hours
    if (profile.quietHours) {
      const h = getCurrentHourET();
      const { start, end } = profile.quietHours;
      if (start > end) {
        // e.g. 22-8 = quiet from 22 to 8
        if (h >= start || h < end) return null;
      } else {
        if (h >= start && h < end) return null;
      }
    }

    const prompts = loadPrompts(agentId);
    const rotation = cycle % (profile.cycleCount || prompts.size || 1);
    const template = prompts.get(rotation);
    if (!template) return null;

    // Merge variables
    const vars: Record<string, string> = {
      "agent.id": profile.id,
      "agent.name": profile.name,
      "agent.role": profile.role,
      ...profile.variables,
    };

    // Add tool rules as variables
    if (profile.tools?.allowlist) {
      vars["tools.allowed"] = profile.tools.allowlist.join(", ");
    }
    if (profile.tools?.blocklist) {
      vars["tools.blocked"] = profile.tools.blocklist.join(", ");
    }

    return renderPrompt(template, vars);
  };
}

/** List all agent profile IDs */
export function listProfiles(): string[] {
  if (!fs.existsSync(PROFILES_DIR)) return [];
  return fs.readdirSync(PROFILES_DIR).filter(dir => {
    const configPath = path.join(PROFILES_DIR, dir, "config.json");
    return fs.existsSync(configPath);
  });
}

/** Save a profile config */
export function saveProfile(agentId: string, profile: AgentProfile): void {
  const dir = path.join(PROFILES_DIR, agentId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(profile, null, 2));
  profileCache.delete(agentId); // invalidate cache
  log.info(`[profiles] Saved profile for ${agentId}`);
}

/** Save a cycle prompt */
export function savePrompt(agentId: string, cycle: number, content: string): void {
  const dir = path.join(PROFILES_DIR, agentId, "prompts");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `cycle-${cycle}.md`), content);
  promptCache.delete(agentId); // invalidate cache
  log.info(`[profiles] Saved prompt cycle-${cycle} for ${agentId}`);
}

/** Get tool rules for an agent (allowlist/blocklist) */
export function getToolRules(agentId: string): { allowlist?: string[]; blocklist?: string[] } | null {
  const profile = loadProfile(agentId);
  return profile?.tools ?? null;
}

/** Check if a tool is allowed for an agent */
export function isToolAllowed(agentId: string, toolName: string): boolean {
  const rules = getToolRules(agentId);
  if (!rules) return true; // no rules = all allowed

  // Check blocklist first
  if (rules.blocklist) {
    for (const pattern of rules.blocklist) {
      if (pattern.endsWith(".*")) {
        if (toolName.startsWith(pattern.slice(0, -2))) return false;
      } else if (toolName === pattern) return false;
    }
  }

  // If allowlist exists, tool must match
  if (rules.allowlist && rules.allowlist.length > 0) {
    for (const pattern of rules.allowlist) {
      if (pattern.endsWith(".*")) {
        if (toolName.startsWith(pattern.slice(0, -2))) return true;
      } else if (toolName === pattern) return true;
    }
    return false; // not in allowlist
  }

  return true;
}

// ── Helpers ──────────────────────────────────────────────────────────

function getCurrentHourET(): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    hour: "numeric",
    hour12: false,
  }).formatToParts(new Date());
  return Number(parts.find((p) => p.type === "hour")!.value);
}
