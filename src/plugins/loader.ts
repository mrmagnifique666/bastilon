/**
 * Plugin Loader — Cowork-compatible plugin system for Kingston.
 *
 * Plugins are directories under plugins/ with:
 *   plugin.json     — manifest (name, description, version, author, enabled)
 *   skills/         — SKILL.md files (domain expertise, auto-activated via system prompt)
 *   commands/       — command .md files (explicit slash commands → registered as tools)
 *
 * Skills are KNOWLEDGE — injected into system prompts when context matches.
 * Commands are ACTIONS — registered as callable tool_call skills.
 */
import fs from "node:fs";
import path from "node:path";
import { log } from "../utils/log.js";
import { registerSkill } from "../skills/loader.js";
import { getDb } from "../storage/store.js";

const PLUGINS_DIR = path.resolve(process.cwd(), "plugins");

// ─── Types ──────────────────────────────────────────────────────────────

export interface PluginManifest {
  name: string;
  description: string;
  version: string;
  author?: { name: string };
  connectors?: Record<string, string>; // e.g. { "~~crm": "hubspot" }
}

export interface PluginSkill {
  name: string;         // e.g. "prospection"
  description: string;  // first line after # title
  content: string;      // full Markdown body (the expertise)
  keywords: string[];   // auto-extracted for context matching
}

export interface PluginCommand {
  name: string;         // e.g. "call-prep"
  fullName: string;     // e.g. "sales:call-prep"
  description: string;
  template: string;     // Markdown template with $ARGUMENTS
}

export interface Plugin {
  manifest: PluginManifest;
  dir: string;
  skills: PluginSkill[];
  commands: PluginCommand[];
  enabled: boolean;
}

// ─── Registry ───────────────────────────────────────────────────────────

const plugins = new Map<string, Plugin>();

export function getPlugin(name: string): Plugin | undefined {
  return plugins.get(name);
}

export function getAllPlugins(): Plugin[] {
  return Array.from(plugins.values());
}

export function getEnabledPlugins(): Plugin[] {
  return Array.from(plugins.values()).filter(p => p.enabled);
}

// ─── Persistence ────────────────────────────────────────────────────────

function ensureTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS plugins (
      name TEXT PRIMARY KEY,
      enabled INTEGER DEFAULT 1,
      installed_at TEXT DEFAULT (datetime('now')),
      config TEXT DEFAULT '{}'
    )
  `);
}

function isPluginEnabled(name: string): boolean {
  const db = getDb();
  const row = db.prepare("SELECT enabled FROM plugins WHERE name = ?").get(name) as { enabled: number } | undefined;
  if (!row) {
    // New plugin — enable by default
    db.prepare("INSERT OR IGNORE INTO plugins (name, enabled) VALUES (?, 1)").run(name);
    return true;
  }
  return row.enabled === 1;
}

export function setPluginEnabled(name: string, enabled: boolean): void {
  const db = getDb();
  db.prepare("INSERT OR REPLACE INTO plugins (name, enabled) VALUES (?, ?)").run(name, enabled ? 1 : 0);
  const plugin = plugins.get(name);
  if (plugin) plugin.enabled = enabled;
}

// ─── Parsing ────────────────────────────────────────────────────────────

/** Extract keywords from SKILL.md content for context matching */
function extractKeywords(content: string, name: string): string[] {
  const kws = new Set<string>();
  kws.add(name.toLowerCase());

  // Extract from ## headers
  const headers = content.match(/^##\s+(.+)/gm);
  if (headers) {
    for (const h of headers) {
      const words = h.replace(/^##\s+/, "").toLowerCase().split(/\s+/);
      words.forEach(w => { if (w.length > 3) kws.add(w); });
    }
  }

  // Extract from keywords: line if present
  const kwLine = content.match(/keywords?:\s*(.+)/i);
  if (kwLine) {
    kwLine[1].split(/[,;]+/).forEach(k => kws.add(k.trim().toLowerCase()));
  }

  return Array.from(kws);
}

/** Parse a SKILL.md file */
function parseSkillMd(filePath: string): PluginSkill | null {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const name = path.basename(path.dirname(filePath)); // directory name = skill name
    const firstLine = content.match(/^#\s+(.+)/m);
    const description = firstLine?.[1] || name;

    return {
      name,
      description,
      content,
      keywords: extractKeywords(content, name),
    };
  } catch {
    return null;
  }
}

/** Parse a command .md file */
function parseCommandMd(filePath: string, pluginName: string): PluginCommand | null {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const baseName = path.basename(filePath, ".md");
    const firstLine = content.match(/^#\s+(.+)/m);
    const description = firstLine?.[1] || baseName;

    return {
      name: baseName,
      fullName: `${pluginName}:${baseName}`,
      description,
      template: content,
    };
  } catch {
    return null;
  }
}

// ─── Context Matching ───────────────────────────────────────────────────

/**
 * Get relevant plugin expertise for the current context.
 * Returns Markdown text to inject into system prompt.
 * Matches plugin skills against user message keywords.
 */
export function getPluginExpertise(userMessage: string, maxTokenBudget: number = 1500): string {
  const enabled = getEnabledPlugins();
  if (enabled.length === 0) return "";

  const lower = userMessage.toLowerCase();
  const scored: Array<{ plugin: Plugin; skill: PluginSkill; score: number }> = [];

  for (const plugin of enabled) {
    for (const skill of plugin.skills) {
      let score = 0;
      for (const kw of skill.keywords) {
        if (lower.includes(kw)) score += 2;
      }
      // Plugin name match
      if (lower.includes(plugin.manifest.name)) score += 3;
      if (score > 0) {
        scored.push({ plugin, skill, score });
      }
    }
  }

  if (scored.length === 0) return "";

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Build expertise block within token budget (~4 chars per token)
  const charBudget = maxTokenBudget * 4;
  const sections: string[] = [];
  let totalChars = 0;

  for (const { plugin, skill } of scored) {
    const section = `### [${plugin.manifest.name}] ${skill.description}\n${skill.content.slice(0, 800)}`;
    if (totalChars + section.length > charBudget) break;
    sections.push(section);
    totalChars += section.length;
  }

  if (sections.length === 0) return "";

  return `\n## Domain Expertise (Plugins)\n${sections.join("\n\n")}`;
}

/**
 * Get ALL active plugin expertise (for general context, not keyword-matched).
 * Returns a compact summary of enabled plugins.
 */
export function getPluginSummary(): string {
  const enabled = getEnabledPlugins();
  if (enabled.length === 0) return "";

  const lines = enabled.map(p => {
    const skillNames = p.skills.map(s => s.name).join(", ");
    const cmdNames = p.commands.map(c => c.fullName).join(", ");
    return `- **${p.manifest.name}** v${p.manifest.version}: ${p.manifest.description} [skills: ${skillNames}]${cmdNames ? ` [commands: ${cmdNames}]` : ""}`;
  });

  return `\n## Active Plugins (${enabled.length})\n${lines.join("\n")}`;
}

// ─── Loading ────────────────────────────────────────────────────────────

/** Load a single plugin directory */
function loadPlugin(pluginDir: string): Plugin | null {
  const manifestPath = path.join(pluginDir, "plugin.json");
  if (!fs.existsSync(manifestPath)) {
    // Also check .claude-plugin/plugin.json (Cowork compat)
    const altPath = path.join(pluginDir, ".claude-plugin", "plugin.json");
    if (!fs.existsSync(altPath)) return null;
    return loadPluginFromManifest(altPath, pluginDir);
  }
  return loadPluginFromManifest(manifestPath, pluginDir);
}

function loadPluginFromManifest(manifestPath: string, pluginDir: string): Plugin | null {
  try {
    const manifest: PluginManifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    if (!manifest.name || !manifest.description) {
      log.warn(`[plugin] Invalid manifest in ${pluginDir}`);
      return null;
    }

    const skills: PluginSkill[] = [];
    const commands: PluginCommand[] = [];

    // Load skills/ directory
    const skillsDir = path.join(pluginDir, "skills");
    if (fs.existsSync(skillsDir)) {
      const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          // Cowork format: skills/skill-name/SKILL.md
          const skillMdPath = path.join(skillsDir, entry.name, "SKILL.md");
          if (fs.existsSync(skillMdPath)) {
            const skill = parseSkillMd(skillMdPath);
            if (skill) skills.push(skill);
          }
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
          // Also support flat: skills/skill-name.md
          const content = fs.readFileSync(path.join(skillsDir, entry.name), "utf-8");
          const name = entry.name.replace(".md", "");
          const firstLine = content.match(/^#\s+(.+)/m);
          skills.push({
            name,
            description: firstLine?.[1] || name,
            content,
            keywords: extractKeywords(content, name),
          });
        }
      }
    }

    // Load commands/ directory
    const commandsDir = path.join(pluginDir, "commands");
    if (fs.existsSync(commandsDir)) {
      const files = fs.readdirSync(commandsDir).filter(f => f.endsWith(".md"));
      for (const file of files) {
        const cmd = parseCommandMd(path.join(commandsDir, file), manifest.name);
        if (cmd) commands.push(cmd);
      }
    }

    const enabled = isPluginEnabled(manifest.name);

    const plugin: Plugin = { manifest, dir: pluginDir, skills, commands, enabled };
    return plugin;
  } catch (err) {
    log.warn(`[plugin] Error loading ${pluginDir}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Register plugin commands as Kingston skills (tool_call compatible) */
function registerPluginCommands(plugin: Plugin): void {
  for (const cmd of plugin.commands) {
    registerSkill({
      name: `plugin.${cmd.fullName.replace(":", ".")}`,
      description: `[Plugin:${plugin.manifest.name}] ${cmd.description}`,
      argsSchema: {
        type: "object",
        properties: {
          input: { type: "string", description: "Arguments for this command" },
        },
        required: [],
      },
      execute: async (args) => {
        const input = (args.input as string) || "";
        const result = cmd.template.replace(/\$ARGUMENTS/g, input);
        return `[${cmd.fullName}]\n\n${result}`;
      },
    });
  }
}

// ─── Main Loader ────────────────────────────────────────────────────────

/**
 * Load all plugins from plugins/ directory.
 * Called at startup after skill loader.
 */
export function loadPlugins(): number {
  ensureTable();

  if (!fs.existsSync(PLUGINS_DIR)) {
    fs.mkdirSync(PLUGINS_DIR, { recursive: true });
    log.info(`[plugin] Created ${PLUGINS_DIR}`);
  }

  const dirs = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => path.join(PLUGINS_DIR, d.name));

  let loaded = 0;

  for (const dir of dirs) {
    const plugin = loadPlugin(dir);
    if (plugin) {
      plugins.set(plugin.manifest.name, plugin);
      if (plugin.enabled) {
        registerPluginCommands(plugin);
      }
      loaded++;
      log.info(`[plugin] Loaded ${plugin.manifest.name} v${plugin.manifest.version} (${plugin.skills.length} skills, ${plugin.commands.length} commands, ${plugin.enabled ? "enabled" : "disabled"})`);
    }
  }

  return loaded;
}
