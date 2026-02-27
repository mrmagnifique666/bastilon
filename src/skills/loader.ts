/**
 * Skill loader — registers built-in skills and provides a tool catalog for the LLM prompt.
 */
import { config } from "../config/env.js";
import { log } from "../utils/log.js";
import { wrapSkillExecution } from "./tool-pipeline.js";

// Re-export pipeline utilities for consumers (e.g. analytics, dashboard)
export { getSkillMetrics, getSkillStats } from "./tool-pipeline.js";
export type { SkillMetric, PipelineResult, ErrorClass } from "./tool-pipeline.js";

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
  /** Per-skill timeout override in ms (default 30s from pipeline) */
  timeoutMs?: number;
  /** Execute the skill and return a text result */
  execute(args: Record<string, unknown>): Promise<string>;
}

const registry = new Map<string, Skill>();

/**
 * Register a skill with the global registry.
 * Automatically wraps execute() with the tool validation pipeline
 * (input validation, timeout, error classification, metrics logging).
 */
export function registerSkill(skill: Skill): void {
  // Wrap execute() with the validation pipeline before registration
  wrapSkillExecution(skill);
  registry.set(skill.name, skill);
  log.debug(`Registered skill: ${skill.name}${skill.adminOnly ? " (admin)" : ""}`);
}

export function getSkill(name: string): Skill | undefined {
  return registry.get(name);
}

export function getRegistry(): Map<string, Skill> {
  return registry;
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

/** Example calls for top skills — helps LLMs understand expected arg formats */
const SKILL_EXAMPLES: Record<string, string> = {
  "binance.price": 'symbol:"bitcoin"',
  "binance.top": 'direction:"gainers"',
  "binance.buy": 'symbol:"ETH", amount:500, reasoning:"support bounce"',
  "binance.sell": 'symbol:"bitcoin", quantity:"all", reasoning:"take profit"',
  "binance.klines": 'symbol:"SOLUSDT", interval:"1h"',
  "crypto_paper.buy": 'symbol:"bitcoin", amount:1000, reasoning:"momentum breakout"',
  "crypto_paper.sell": 'symbol:"ethereum", quantity:"all", reasoning:"target hit"',
  "crypto_paper.scan": "",
  "web.search": 'query:"latest AI news 2026"',
  "web.fetch": 'url:"https://example.com"',
  "notes.add": 'text:"Important finding about..."',
  "notes.list": "",
  "files.read_anywhere": 'path:"/path/to/file.txt"',
  "files.write_anywhere": 'path:"/path/to/file.txt", content:"..."',
  "telegram.send": 'text:"Message à envoyer"',
  "shell.exec": 'command:"npm run build"',
  "ftp.upload_dir": 'localPath:"./dist", remotePath:"/public_html"',
  "ftp.verify": 'remotePath:"/public_html/index.html", search:"expected text"',
  "image.generate": 'prompt:"a sunset over mountains"',
  "memory.search": 'query:"trading strategy"',
  "code.request": 'description:"Add error handling to X"',
  "dungeon.start": 'system:"shadowrun", mode:"co-op"',
  "dungeon.play": 'action:"I search the room for traps"',
  "trading.positions": "",
  "content.draft": 'text:"Post about...", channel:"moltbook"',
  "weather.now": 'city:"Gatineau"',
  "calendar.auto_schedule": 'task:"Meeting with client", duration:60',
  "goals.set": 'title:"Launch MVP", description:"..."',
  "cron.list": "",
};

/**
 * Compact tool catalog — groups skills by namespace, one line per namespace.
 * Reduces prompt from ~50KB to ~3-5KB. Used by Claude CLI path.
 * Top skills include example args to help the LLM understand expected formats.
 * Format: `namespace: method(params), method2(params)`
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
    const example = SKILL_EXAMPLES[s.name];
    let entry: string;
    if (example !== undefined) {
      // Has example: show it instead of bare types
      entry = example ? `${method}(${example})` : `${method}()`;
    } else {
      const params = Object.entries(s.argsSchema.properties)
        .map(([k, v]) => `${k}:${v.type}`)
        .join(", ");
      entry = `${method}(${params})`;
    }
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
  "skills.", "ftp.", "contacts.", "phone.", "agents.", "config.", "weather.",
  "math.", "hash.", "convert.", "trading.", "cron.", "mind.", "kg.",
  "episodic.", "rules.", "content.", "dungeon.", "forex.", "nlp.",
  "notify.", "goals.", "goal.", "autonomous.", "train.", "sms.",
  "crypto.", "crypto_paper.", "binance.", "stocks.", "analytics.", "learn.",
  "social.", "facebook.", "instagram.",
  "reflect.", "crag.", "mnemosyne.",
  "printful.", "shopify.",
  "site.",
];

/** Tier 2 keywords: map keyword patterns to skill prefixes */
const TIER2_KEYWORDS: Array<{ keywords: string[]; prefix: string }> = [
  { keywords: ["moltbook", "agent social"], prefix: "moltbook." },
  { keywords: ["facebook", "fb", "meta", "page facebook"], prefix: "facebook." },
  { keywords: ["instagram", "ig", "insta", "story"], prefix: "instagram." },
  { keywords: ["social media", "réseau social", "poster", "publier", "réseaux sociaux"], prefix: "social." },
  { keywords: ["browser", "navigateur", "page web", "screenshot", "playwright"], prefix: "browser." },
  { keywords: ["sms", "texto"], prefix: "sms." },
  { keywords: ["crypto", "bitcoin", "ethereum", "btc", "eth"], prefix: "crypto." },
  { keywords: ["binance", "usdt"], prefix: "binance." },
  { keywords: ["stocks", "bourse", "action"], prefix: "stocks." },
  { keywords: ["trading", "trade", "picks", "day trading", "alpaca", "acheter", "vendre"], prefix: "trading." },
  { keywords: ["dungeon", "d&d", "donjons", "dragons", "campagne", "personnage"], prefix: "dungeon." },
  { keywords: ["shadowrun", "returns", "jouer", "game", "jeu vidéo"], prefix: "shadowrun." },
  { keywords: ["computer", "desktop", "screen", "souris", "mouse", "écran"], prefix: "computer." },
  { keywords: ["site", "website", "poster sur", "publier sur", "facebook post", "naviguer", "web action", "chrome"], prefix: "site." },
  { keywords: ["ingest", "rag", "knowledge base", "ingérer", "recall"], prefix: "memory." },
  { keywords: ["reflect", "réflexion", "lesson", "leçon", "mistake", "erreur passée"], prefix: "reflect." },
  { keywords: ["crag", "grade", "relevance", "pertinence", "document quality"], prefix: "crag." },
  { keywords: ["mnemosyne", "decay", "memory health", "archive", "duplicat"], prefix: "mnemosyne." },
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

  // Training mode: extract namespace from [TRAINING: S_namespace_*] and force-include it
  const trainingMatch = (userMessage || "").match(/\[TRAINING:\s*S_([a-zA-Z]+)_/);
  if (trainingMatch) {
    const trainNs = trainingMatch[1] + ".";
    // Force-include the namespace being tested
    const forced: Skill[] = [];
    const remaining: Skill[] = [];
    for (const s of tier2Pool) {
      if (s.name.startsWith(trainNs)) {
        forced.push(s);
      } else {
        remaining.push(s);
      }
    }
    if (forced.length > 0) {
      tier1.push(...forced);
      tier2Pool.length = 0;
      tier2Pool.push(...remaining);
    }
  }
  // Also force-include skill mentioned explicitly in message (e.g. "Appelle le skill X.Y")
  const explicitSkillMatch = (userMessage || "").match(/skill\s+([a-zA-Z_]+\.[a-zA-Z_]+)/i);
  if (explicitSkillMatch) {
    const explicitNs = explicitSkillMatch[1].split(".")[0] + ".";
    for (const s of tier2Pool) {
      if (s.name.startsWith(explicitNs) && !tier1.includes(s)) {
        tier1.push(s);
      }
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

  let selected = [...tier1, ...tier2Matched];

  // For training: ensure the tested skill's namespace is at the FRONT (survives 128 cap)
  if (trainingMatch) {
    const trainNs = trainingMatch[1] + ".";
    const prioritized = selected.filter(s => s.name.startsWith(trainNs));
    const rest = selected.filter(s => !s.name.startsWith(trainNs));
    selected = [...prioritized, ...rest];
  }

  // Safety: cap at 128
  const capped = selected.slice(0, 128);
  log.debug(`[loader] Gemini tools: ${capped.length} (tier1=${tier1.length}, tier2=${tier2Matched.length}, cap=128)`);

  return capped.map(skillToGeminiDecl);
}

/** Convert a single Kingston skill to a Gemini function declaration */
function skillToGeminiDecl(skill: Skill): GeminiFunctionDeclaration {
  const properties: Record<string, { type: string; description?: string; items?: { type: string } }> = {};
  for (const [key, prop] of Object.entries(skill.argsSchema.properties)) {
    properties[key] = {
      type: toGeminiType(prop.type),
      ...(prop.description ? { description: prop.description } : {}),
      ...(prop.type === "array" && (prop as any).items ? { items: { type: toGeminiType((prop as any).items.type || "string") } } : {}),
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
  "shell.exec", "web.search", "web.fetch",
  "system.status", "code.", "memory.", "analytics.",
  "contacts.", "errors.", "ftp.", "git.", "time.", "cron.", "mind.",
  "kg.", "episodic.", "rules.",
  "content.", "nlp.",
  "notify.", "goals.", "goal.",
  "autonomous.", "learn.",
  "social.", "facebook.", "instagram.",
  "reflect.", "crag.", "mnemosyne.",
  "site.",
  "trading.", "stocks.",
  // NOTE: telegram.* excluded — agents use sendAlert(), not telegram.send
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
  // ═══ CORE — Platform essentials ═══
  await import("./builtin/help.js");
  await import("./builtin/notes.js");
  await import("./builtin/files.js");
  await import("./builtin/filewrite.js");
  await import("./builtin/files-advanced.js");
  await import("./builtin/shell.js");
  await import("./builtin/web.js");
  await import("./builtin/system.js");
  await import("./builtin/code.js");
  await import("./builtin/telegram.js");
  await import("./builtin/scheduler.js");
  await import("./builtin/errors.js");
  await import("./builtin/config.js");
  await import("./builtin/config-control.js");
  await import("./builtin/time.js");
  await import("./builtin/translate.js");
  await import("./builtin/utils.js");

  // ═══ MEMORY — Knowledge systems ═══
  await import("./builtin/memory-ops.js");
  await import("./builtin/semantic-memory.js");
  await import("./builtin/knowledge-graph.js");
  await import("./builtin/episodic.js");
  await import("./builtin/rules.js");
  await import("./builtin/knowledge-ingest.js");
  await import("./builtin/ignorance.js");

  // ═══ AGENTS — Autonomous systems ═══
  await import("./builtin/noah-bridge.js");
  await import("./builtin/bridge-ws.js");
  await import("./builtin/agents.js");
  await import("./builtin/mind.js");
  await import("./builtin/cron.js");
  await import("./builtin/goals.js");
  await import("./builtin/goal-tree.js");
  await import("./builtin/autonomous.js");
  await import("./builtin/peodc.js");
  await import("./builtin/observe.js");
  await import("./builtin/notify.js");
  await import("./builtin/analytics.js");
  await import("./builtin/agent-memory.js");

  // ═══ TRADING — Financial monitoring ═══
  await import("./builtin/trading.js");
  await import("./builtin/stocks.js");
  await import("./builtin/crypto.js");
  await import("./builtin/crypto-paper.js");
  await import("./builtin/crypto-autonomous.js");
  await import("./builtin/crypto-swing.js");
  await import("./builtin/stocks-autonomous.js");
  await import("./builtin/binance.js");
  await import("./builtin/forex.js");
  await import("./builtin/trading-advanced.js");
  await import("./builtin/trading-alerts.js");
  await import("./builtin/trading-screener.js");

  // ═══ COGNITION — Debate, trends, relationship ═══
  await import("./builtin/debate.js");
  await import("./builtin/trend-detect.js");
  await import("./builtin/relationship-pulse.js");

  // ═══ CONTENT — Moltbook + creation ═══
  await import("./builtin/content.js");
  await import("./builtin/humanize.js");
  await import("./builtin/image.js");
  await import("./custom/moltbook.js");

  // ═══ TOOLS — Actually used utilities ═══
  await import("./builtin/git.js");
  await import("./builtin/ftp.js");
  await import("./builtin/weather.js");
  await import("./builtin/contacts.js");
  await import("./builtin/sms.js");
  await import("./builtin/phone.js");
  await import("./builtin/skill-create.js");
  await import("./builtin/browser.js");
  await import("./builtin/googleAuth.js");
  await import("./builtin/anyWebsite.js");
  await import("./builtin/accountTraining.js");
  await import("./builtin/freeapis.js");

  // ═══ FUN — D&D + Games ═══
  await import("./builtin/dungeon.js");
  await import("./builtin/computer-use.js");
  await import("./builtin/site-act.js");
  await import("./builtin/shadowrun-player.js");

  // ═══ RECEPTIONIST — Email, Office, Desktop, Calendar ═══
  await import("./builtin/gmail.js");
  await import("./builtin/calendar.js");
  await import("./builtin/office.js");
  await import("./builtin/desktop.js");

  // ═══ SOCIAL — Facebook, Instagram, Social Pipeline ═══
  await import("./builtin/facebook.js");
  await import("./builtin/instagram.js");
  await import("./builtin/social-pipeline.js");

  // ═══ INTELLIGENCE — Reflexion, CRAG, Mnemosyne ═══
  await import("./builtin/intelligence.js");

  // ═══ BRAIN — Smart escalation to Claude ═══
  await import("./builtin/brain.js");

  // ═══ SUPERVISOR — Accountability & outcome verification ═══
  await import("./builtin/supervisor-skills.js");

  // ═══ PRINTFUL + SHOPIFY — Print-on-demand & E-commerce ═══
  await import("./builtin/printful.js");
  await import("./builtin/shopify.js");

  // ═══ AUTOFIX — Health watchdog & diagnostics ═══
  await import("./builtin/autofix.js");

  // ═══ TRAINING — Self-improvement ═══
  await import("../training/trainer.js");
  await import("./custom/code-request.js");

  // ═══ IDENTITY — Soul & self-awareness ═══
  await import("./builtin/soul.js");
  await import("./builtin/mood.js");

  // ═══ COGNITION — Advanced reasoning ═══
  await import("./builtin/metacognition.js");
  await import("./builtin/theory-of-mind.js");
  await import("./builtin/self-modify.js");
  await import("./builtin/causal.js");
  await import("./builtin/world-model.js");

  // ═══ LEARNING — Self-improvement ═══
  await import("./builtin/learn.js");
  await import("./builtin/learnApi.js");
  await import("./builtin/selfimprove.js");
  await import("./builtin/planner.js");

  // ═══ POWER TOOLS — Extended capabilities ═══
  await import("./builtin/power-tools.js");
  await import("./builtin/files-power.js");
  await import("./builtin/pdf.js");
  await import("./builtin/image-ops.js");
  await import("./builtin/video.js");
  await import("./builtin/clipboard.js");

  // ═══ WEB & API — Extended connectivity ═══
  await import("./builtin/api.js");
  await import("./builtin/rss.js");
  await import("./builtin/news.js");

  // ═══ BUSINESS — Revenue & clients ═══
  await import("./builtin/revenue.js");
  await import("./builtin/client.js");
  await import("./builtin/leads.js");
  await import("./builtin/landing.js");
  await import("./builtin/marketing.js");
  await import("./builtin/invoice.js");
  await import("./builtin/pipeline.js");
  await import("./builtin/revenue-dashboard.js");

  // ═══ WORKFLOW — Orchestration ═══
  await import("./builtin/workflow.js");
  await import("./builtin/agent-profiles.js");
  await import("./builtin/hooks.js");
  await import("./builtin/secrets.js");
  await import("./builtin/skill-verify.js");
  await import("./builtin/plugin.js");

  // ═══ MONITORING — Price & market tracking ═══
  await import("./builtin/price-tracker.js");
  await import("./builtin/knowledge-vault.js");

  // ═══ EXTENDED APIS — Free tier services ═══
  await import("./builtin/freeapis-tier2.js");
  await import("./builtin/freeapis-tier3.js");

  // ═══ OPENCLAW-INSPIRED — Ralph Wiggum, Soul Improve, Safety, Growth ═══
  await import("./builtin/ralph-wiggum.js");
  await import("./builtin/soul-improve.js");
  await import("./builtin/safety-hooks.js");
  await import("./builtin/moltbook-growth.js");
  await import("./builtin/memory-maintain.js");

  // ═══ STILL CUT — Truly unused (no API keys / no demand) ═══
  // twitter, linkedin, reddit, discord, stripe, booking, hubspot,
  // whatsapp, experiment, optimize, db, audit, security-scan, network,
  // health, market, system-control, app-control, package-manager,
  // ollama, tunnel, cohere, mistral, together, replicate, serper,
  // abstract-api, huggingface, solutions, mcp, xp, game,
  // briefing-council, calendar-scheduler, brand-voice, youtube,
  // youtube-tracker, voice-clone, language-tutor, job-scout, travel,
  // health-wearable, wakeword, openweather, training

  log.info(`Loaded ${registry.size} built-in skills.`);
}
