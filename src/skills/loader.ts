/**
 * Skill loader — registers built-in skills and provides a tool catalog for the LLM prompt.
 */
import { config } from "../config/env.js";
import { log } from "../utils/log.js";

export interface ToolSchema {
  type: "object";
  properties: Record<string, { type: string; description?: string }>;
  required?: string[];
}

export interface Skill {
  /** e.g. "notes.add" */
  name: string;
  /** Short human-readable description for the LLM catalog */
  description: string;
  /** JSON schema for args validation */
  argsSchema: ToolSchema;
  /** If true, only admin users can invoke this skill */
  adminOnly?: boolean;
  /** Execute the skill and return a text result */
  execute(args: Record<string, unknown>): Promise<string>;
}

const registry = new Map<string, Skill>();

export function registerSkill(skill: Skill): void {
  registry.set(skill.name, skill);
  log.debug(`Registered skill: ${skill.name}${skill.adminOnly ? " (admin)" : ""}`);
}

export function getSkill(name: string): Skill | undefined {
  return registry.get(name);
}

export function getAllSkills(): Skill[] {
  return Array.from(registry.values());
}

/**
 * Validate args against a simple JSON schema (top-level properties + required).
 * Auto-coerces types when safe (e.g. "10" → 10 for number fields).
 */
export function validateArgs(
  args: Record<string, unknown>,
  schema: ToolSchema
): string | null {
  if (schema.required) {
    for (const key of schema.required) {
      if (!(key in args)) {
        return `Missing required argument: ${key}`;
      }
    }
  }
  for (const [key, val] of Object.entries(args)) {
    const prop = schema.properties[key];
    if (!prop) continue; // extra keys are ignored

    // Auto-coerce string → number when schema expects number
    if (prop.type === "number" && typeof val === "string") {
      const num = Number(val);
      if (!Number.isNaN(num)) {
        args[key] = num;
        continue;
      }
      return `Argument "${key}" must be a number (got "${val}")`;
    }

    // Auto-coerce number → string when schema expects string
    if (prop.type === "string" && typeof val === "number") {
      args[key] = String(val);
      continue;
    }

    if (prop.type === "string" && typeof val !== "string") {
      return `Argument "${key}" must be a string`;
    }
    if (prop.type === "number" && typeof val !== "number") {
      return `Argument "${key}" must be a number`;
    }
  }
  return null; // valid
}

/**
 * Generate a text block describing all available tools for the LLM prompt.
 * Filters out admin-only tools when the user is not an admin.
 */
export function getToolCatalogPrompt(isAdmin: boolean = false): string {
  const skills = getAllSkills().filter((s) => !s.adminOnly || isAdmin);
  if (skills.length === 0) return "";
  const lines = skills.map((s) => {
    const params = Object.entries(s.argsSchema.properties)
      .map(([k, v]) => `${k}: ${v.type}${v.description ? ` — ${v.description}` : ""}`)
      .join(", ");
    const tag = s.adminOnly ? " [ADMIN]" : "";
    return `- ${s.name}(${params}): ${s.description}${tag}`;
  });
  return lines.join("\n");
}

/**
 * Compact tool catalog — groups skills by namespace, one line per namespace.
 * Reduces prompt from ~50KB to ~3-5KB. Used by Claude CLI path.
 * Format: `namespace: method(params), method2(params) — description`
 */
export function getCompactToolCatalog(isAdmin: boolean = false): string {
  const skills = getAllSkills().filter((s) => !s.adminOnly || isAdmin);
  if (skills.length === 0) return "";

  // Group by namespace (prefix before first dot, or skill name if no dot)
  const groups = new Map<string, string[]>();
  for (const s of skills) {
    const dotIdx = s.name.indexOf(".");
    const ns = dotIdx > 0 ? s.name.slice(0, dotIdx) : s.name;
    const method = dotIdx > 0 ? s.name.slice(dotIdx + 1) : s.name;
    const params = Object.entries(s.argsSchema.properties)
      .map(([k, v]) => `${k}:${v.type}`)
      .join(", ");
    const entry = `${method}(${params})`;
    if (!groups.has(ns)) groups.set(ns, []);
    groups.get(ns)!.push(entry);
  }

  const lines: string[] = [];
  for (const [ns, methods] of groups) {
    lines.push(`${ns}: ${methods.join(", ")}`);
  }
  return lines.join("\n");
}

/**
 * Get the full schema for a single skill — used in tool feedback loop.
 * Returns a one-line description with full param details.
 */
export function getSkillSchema(name: string): string | null {
  const skill = registry.get(name);
  if (!skill) return null;
  const params = Object.entries(skill.argsSchema.properties)
    .map(([k, v]) => `${k}: ${v.type}${v.description ? ` — ${v.description}` : ""}`)
    .join(", ");
  return `${skill.name}(${params}): ${skill.description}`;
}

// --- Gemini function declarations ---

/** Gemini type mapping: Kingston "string" → Gemini "STRING" */
function toGeminiType(t: string): string {
  const map: Record<string, string> = {
    string: "STRING",
    number: "NUMBER",
    boolean: "BOOLEAN",
    integer: "INTEGER",
    array: "ARRAY",
    object: "OBJECT",
  };
  return map[t] || "STRING";
}

interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: {
    type: string;
    properties: Record<string, { type: string; description?: string }>;
    required?: string[];
  };
}

/** Tier 1 namespaces: always included for admin users */
const TIER1_PREFIXES = [
  "help", "notes.", "files.", "shell.", "web.", "telegram.", "system.", "code.",
  "scheduler.", "errors.", "image.", "time.", "translate.", "git.", "memory.",
  "skills.", "ftp.", "contacts.", "gmail.", "calendar.", "phone.", "agents.",
  "config.", "weather.", "network.", "rss.", "math.", "hash.", "convert.",
  "trading.", "mood.", "soul.", "cron.", "mind.", "kg.", "episodic.", "rules.",
  "planner.", "revenue.", "client.", "selfimprove.", "content.",
  "news.", "forex.", "nlp.", "solutions.",
];

/** Tier 2 keywords: map keyword patterns to skill prefixes */
const TIER2_KEYWORDS: Array<{ keywords: string[]; prefix: string }> = [
  { keywords: ["twitter", "tweet", "x.com"], prefix: "twitter." },
  { keywords: ["linkedin", "professionnel"], prefix: "linkedin." },
  { keywords: ["reddit", "subreddit"], prefix: "reddit." },
  { keywords: ["discord", "serveur"], prefix: "discord." },
  { keywords: ["moltbook", "agent social"], prefix: "moltbook." },
  { keywords: ["stripe", "paiement", "payment", "facture"], prefix: "stripe." },
  { keywords: ["hubspot", "crm", "client"], prefix: "hubspot." },
  { keywords: ["browser", "navigateur", "page web", "screenshot", "puppeteer"], prefix: "browser." },
  { keywords: ["analytics", "analyse", "statistique"], prefix: "analytics." },
  { keywords: ["optimize", "optimis", "a/b test"], prefix: "optimize." },
  { keywords: ["learn", "apprendre", "api", "documentation"], prefix: "learn." },
  { keywords: ["market", "marché", "concurren"], prefix: "market." },
  { keywords: ["facebook", "meta", "fb"], prefix: "facebook." },
  { keywords: ["instagram", "insta", "ig"], prefix: "instagram." },
  { keywords: ["sms", "texto"], prefix: "sms." },
  { keywords: ["booking", "réservation", "rendez-vous"], prefix: "booking." },
  { keywords: ["whatsapp"], prefix: "whatsapp." },
  { keywords: ["experiment", "expérien"], prefix: "experiment." },
  { keywords: ["crypto", "bitcoin", "ethereum"], prefix: "crypto." },
  { keywords: ["stocks", "bourse", "action"], prefix: "stocks." },
  { keywords: ["trading", "trade", "picks", "day trading", "alpaca", "acheter", "vendre"], prefix: "trading." },
  { keywords: ["security", "sécurité", "scan"], prefix: "security." },
  { keywords: ["audit"], prefix: "audit." },
  { keywords: ["health", "santé"], prefix: "health." },
  { keywords: ["db", "database", "sqlite"], prefix: "db." },
  { keywords: ["api."], prefix: "api." },
];

/**
 * Convert skills to Gemini function declarations.
 * Respects the 128-tool Gemini limit using Tier 1 (always) + Tier 2 (keyword match).
 * Non-admin users have fewer skills and are always under 128.
 */
export function getSkillsForGemini(
  isAdmin: boolean,
  userMessage?: string,
): GeminiFunctionDeclaration[] {
  const skills = getAllSkills().filter((s) => !s.adminOnly || isAdmin);

  // Non-admin: all skills fit under 128
  if (!isAdmin) {
    return skills.map(skillToGeminiDecl);
  }

  // Admin: Tier 1 always included
  const tier1: Skill[] = [];
  const tier2Pool: Skill[] = [];

  for (const s of skills) {
    const isTier1 = s.name === "help" || TIER1_PREFIXES.some((p) => s.name.startsWith(p));
    if (isTier1) {
      tier1.push(s);
    } else {
      tier2Pool.push(s);
    }
  }

  // Tier 2: match by keywords in user message
  const lowerMessage = (userMessage || "").toLowerCase();
  const matchedPrefixes = new Set<string>();

  for (const { keywords, prefix } of TIER2_KEYWORDS) {
    if (keywords.some((kw) => lowerMessage.includes(kw))) {
      matchedPrefixes.add(prefix);
    }
  }

  const tier2Matched = tier2Pool.filter((s) =>
    Array.from(matchedPrefixes).some((p) => s.name.startsWith(p))
  );

  const selected = [...tier1, ...tier2Matched];

  // Safety: cap at 128
  const capped = selected.slice(0, 128);
  log.debug(`[loader] Gemini tools: ${capped.length} (tier1=${tier1.length}, tier2=${tier2Matched.length}, cap=128)`);

  return capped.map(skillToGeminiDecl);
}

/** Convert a single Kingston skill to a Gemini function declaration */
function skillToGeminiDecl(skill: Skill): GeminiFunctionDeclaration {
  const properties: Record<string, { type: string; description?: string }> = {};
  for (const [key, prop] of Object.entries(skill.argsSchema.properties)) {
    properties[key] = {
      type: toGeminiType(prop.type),
      ...(prop.description ? { description: prop.description } : {}),
    };
  }

  return {
    name: skill.name,
    description: skill.description,
    parameters: {
      type: "OBJECT",
      properties,
      ...(skill.argsSchema.required?.length ? { required: skill.argsSchema.required } : {}),
    },
  };
}

// --- Ollama function declarations ---

/** Ollama tool declaration — uses lowercase types (unlike Gemini's UPPERCASE) */
interface OllamaFunctionDeclaration {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, { type: string; description?: string }>;
      required?: string[];
    };
  };
}

/** Tier 1 for Ollama: agent-focused essentials (smaller set than Gemini) */
const OLLAMA_TIER1_PREFIXES = [
  "help", "notes.", "files.read", "files.list", "files.write",
  "shell.exec", "web.search", "web.fetch", "telegram.",
  "system.status", "code.", "memory.", "analytics.",
  "contacts.", "errors.", "ftp.", "git.", "time.", "cron.", "mind.",
  "kg.", "episodic.", "rules.",
  "planner.", "selfimprove.", "client.", "revenue.", "content.",
];

/**
 * Convert skills to Ollama function declarations.
 * Agent-focused: smaller Tier 1 + keyword Tier 2, capped at ollamaMaxTools.
 */
export function getSkillsForOllama(
  userMessage?: string,
): OllamaFunctionDeclaration[] {
  const skills = getAllSkills(); // agents are always admin

  // Tier 1: agent essentials
  const tier1: Skill[] = [];
  const tier2Pool: Skill[] = [];

  for (const s of skills) {
    const isTier1 = s.name === "help" || OLLAMA_TIER1_PREFIXES.some((p) => s.name.startsWith(p));
    if (isTier1) {
      tier1.push(s);
    } else {
      tier2Pool.push(s);
    }
  }

  // Tier 2: keyword matching (reuses TIER2_KEYWORDS from Gemini)
  const lowerMessage = (userMessage || "").toLowerCase();
  const matchedPrefixes = new Set<string>();

  for (const { keywords, prefix } of TIER2_KEYWORDS) {
    if (keywords.some((kw) => lowerMessage.includes(kw))) {
      matchedPrefixes.add(prefix);
    }
  }

  const tier2Matched = tier2Pool.filter((s) =>
    Array.from(matchedPrefixes).some((p) => s.name.startsWith(p))
  );

  // Prioritize tools mentioned in the prompt (agent-aware selection)
  const combined = [...tier1, ...tier2Matched];
  const cap = config.ollamaMaxTools || 40;

  if (combined.length > cap && lowerMessage.length > 0) {
    // Tools whose name appears in the message get priority
    const mentioned: Skill[] = [];
    const rest: Skill[] = [];
    for (const s of combined) {
      if (lowerMessage.includes(s.name)) {
        mentioned.push(s);
      } else {
        rest.push(s);
      }
    }
    const capped = [...mentioned, ...rest].slice(0, cap);
    log.debug(`[loader] Ollama tools: ${capped.length} (tier1=${tier1.length}, tier2=${tier2Matched.length}, mentioned=${mentioned.length}, cap=${cap})`);
    return capped.map(skillToOllamaDecl);
  }

  const capped = combined.slice(0, cap);
  log.debug(`[loader] Ollama tools: ${capped.length} (tier1=${tier1.length}, tier2=${tier2Matched.length}, cap=${cap})`);

  return capped.map(skillToOllamaDecl);
}

/** Convert a single Kingston skill to an Ollama function declaration */
function skillToOllamaDecl(skill: Skill): OllamaFunctionDeclaration {
  const properties: Record<string, { type: string; description?: string }> = {};
  for (const [key, prop] of Object.entries(skill.argsSchema.properties)) {
    properties[key] = {
      type: prop.type, // lowercase: "string", "number", etc.
      ...(prop.description ? { description: prop.description } : {}),
    };
  }

  return {
    type: "function",
    function: {
      name: skill.name,
      description: skill.description,
      parameters: {
        type: "object",
        properties,
        ...(skill.argsSchema.required?.length ? { required: skill.argsSchema.required } : {}),
      },
    },
  };
}

/**
 * Load all built-in skills.
 */
export async function loadBuiltinSkills(): Promise<void> {
  // Dynamic imports to keep this file dependency-light
  await import("./builtin/help.js");
  await import("./builtin/notes.js");
  await import("./builtin/files.js");
  await import("./builtin/filewrite.js");
  await import("./builtin/files-advanced.js");
  await import("./builtin/shell.js");
  await import("./builtin/web.js");
  await import("./builtin/system.js");
  await import("./builtin/code.js");
  await import("./builtin/api.js");
  await import("./builtin/db.js");
  await import("./builtin/telegram.js");
  await import("./builtin/scheduler.js");
  await import("./builtin/errors.js");
  await import("./builtin/config.js");
  await import("./builtin/audit.js");
  await import("./builtin/phone.js");
  await import("./builtin/image.js");
  await import("./builtin/browser.js");
  await import("./builtin/gmail.js");
  await import("./builtin/calendar.js");
  await import("./builtin/time.js");
  await import("./builtin/crypto.js");
  await import("./builtin/stocks.js");
  await import("./builtin/weather.js");
  await import("./builtin/contacts.js");
  await import("./builtin/security-scan.js");
  await import("./builtin/network.js");
  await import("./builtin/rss.js");
  await import("./builtin/translate.js");
  await import("./builtin/utils.js");
  await import("./builtin/health.js");
  await import("./builtin/market.js");
  await import("./builtin/trading.js");
  await import("./builtin/twitter.js");
  await import("./builtin/linkedin.js");
  await import("./builtin/reddit.js");
  await import("./builtin/discord.js");
  await import("./builtin/facebook.js");
  await import("./builtin/instagram.js");
  await import("./builtin/stripe.js");
  await import("./builtin/sms.js");
  await import("./builtin/booking.js");
  await import("./builtin/hubspot.js");
  await import("./builtin/whatsapp.js");
  await import("./builtin/analytics.js");
  await import("./builtin/experiment.js");
  await import("./builtin/optimize.js");
  await import("./builtin/learn.js");
  await import("./builtin/learnApi.js");
  await import("./builtin/agents.js");
  await import("./builtin/git.js");
  await import("./builtin/memory-ops.js");
  await import("./builtin/semantic-memory.js");
  await import("./builtin/ftp.js");
  await import("./builtin/office.js");
  await import("./builtin/desktop.js");
  await import("./builtin/system-control.js");
  await import("./builtin/app-control.js");
  await import("./builtin/files-power.js");
  await import("./builtin/package-manager.js");
  await import("./builtin/pdf.js");
  await import("./builtin/image-ops.js");
  await import("./builtin/ollama.js");
  await import("./builtin/tunnel.js");
  await import("./builtin/clipboard.js");
  await import("./builtin/power-tools.js");
  await import("./builtin/soul.js");
  await import("./builtin/mood.js");
  await import("./builtin/cron.js");
  await import("./builtin/mind.js");
  await import("./builtin/knowledge-graph.js");
  await import("./builtin/episodic.js");
  await import("./builtin/rules.js");
  await import("./builtin/wakeword.js");
  await import("./builtin/planner.js");
  await import("./builtin/revenue.js");
  await import("./builtin/client.js");
  await import("./builtin/selfimprove.js");
  await import("./builtin/content.js");
  await import("./builtin/youtube.js");
  await import("./builtin/printful.js");
  await import("./builtin/voice-clone.js");
  await import("./builtin/news.js");
  await import("./builtin/forex.js");
  await import("./builtin/huggingface.js");
  await import("./builtin/solutions.js");
  await import("./custom/code-request.js");
  await import("./custom/moltbook.js");
  await import("./custom/openweather.js");

  log.info(`Loaded ${registry.size} built-in skills.`);
}
