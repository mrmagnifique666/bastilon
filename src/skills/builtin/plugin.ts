/**
 * Plugin management skills — list, info, enable, disable, create plugins.
 * Cowork-compatible plugin system for Kingston.
 */
import fs from "node:fs";
import path from "node:path";
import { registerSkill } from "../loader.js";
import { log } from "../../utils/log.js";
import {
  getAllPlugins,
  getPlugin,
  setPluginEnabled,
  getEnabledPlugins,
  getPluginExpertise,
  getPluginSummary,
} from "../../plugins/loader.js";

const PLUGINS_DIR = path.resolve(process.cwd(), "plugins");

// ─── plugin.list ────────────────────────────────────────────────────────

registerSkill({
  name: "plugin.list",
  description: "List all installed plugins with their status",
  argsSchema: {
    type: "object",
    properties: {
      enabled_only: { type: "string", description: "If 'true', show only enabled plugins" },
    },
  },
  execute: async (args) => {
    const enabledOnly = args.enabled_only === "true";
    const plugins = enabledOnly ? getEnabledPlugins() : getAllPlugins();

    if (plugins.length === 0) {
      return "No plugins installed. Create one with plugin.create or add a directory to plugins/.";
    }

    const lines = plugins.map(p => {
      const status = p.enabled ? "✅" : "❌";
      const skills = p.skills.map(s => s.name).join(", ");
      const cmds = p.commands.map(c => c.fullName).join(", ");
      return `${status} **${p.manifest.name}** v${p.manifest.version}\n   ${p.manifest.description}\n   Skills: ${skills || "none"}\n   Commands: ${cmds || "none"}`;
    });

    return `📦 Plugins (${plugins.length}):\n\n${lines.join("\n\n")}`;
  },
});

// ─── plugin.info ────────────────────────────────────────────────────────

registerSkill({
  name: "plugin.info",
  description: "Get detailed info about a specific plugin",
  argsSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Plugin name" },
    },
    required: ["name"],
  },
  execute: async (args) => {
    const name = args.name as string;
    const plugin = getPlugin(name);

    if (!plugin) {
      // Fuzzy match
      const all = getAllPlugins();
      const match = all.find(p => p.manifest.name.includes(name) || name.includes(p.manifest.name));
      if (match) {
        return `Plugin "${name}" not found. Did you mean "${match.manifest.name}"?`;
      }
      return `Plugin "${name}" not found. Available: ${all.map(p => p.manifest.name).join(", ")}`;
    }

    const m = plugin.manifest;
    const skills = plugin.skills.map(s => `  - **${s.name}**: ${s.description} (${s.keywords.length} keywords)`).join("\n");
    const commands = plugin.commands.map(c => `  - **${c.fullName}**: ${c.description}`).join("\n");
    const connectors = m.connectors
      ? Object.entries(m.connectors).map(([cat, impl]) => `  - ${cat} → ${impl}`).join("\n")
      : "  None";

    return `📦 Plugin: **${m.name}** v${m.version}
Status: ${plugin.enabled ? "✅ Enabled" : "❌ Disabled"}
Author: ${m.author?.name || "Unknown"}
Description: ${m.description}
Directory: ${plugin.dir}

📚 Skills (${plugin.skills.length}):
${skills || "  None"}

⚡ Commands (${plugin.commands.length}):
${commands || "  None"}

🔌 Connectors:
${connectors}`;
  },
});

// ─── plugin.enable ──────────────────────────────────────────────────────

registerSkill({
  name: "plugin.enable",
  description: "Enable a plugin so its expertise is injected into prompts",
  argsSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Plugin name to enable" },
    },
    required: ["name"],
  },
  execute: async (args) => {
    const name = args.name as string;
    const plugin = getPlugin(name);
    if (!plugin) return `Plugin "${name}" not found.`;
    if (plugin.enabled) return `Plugin "${name}" is already enabled.`;

    setPluginEnabled(name, true);
    log.info(`[plugin] Enabled: ${name}`);
    return `✅ Plugin "${name}" enabled. Its domain expertise will now be injected into prompts when context matches.`;
  },
});

// ─── plugin.disable ─────────────────────────────────────────────────────

registerSkill({
  name: "plugin.disable",
  description: "Disable a plugin to stop its expertise injection",
  argsSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Plugin name to disable" },
    },
    required: ["name"],
  },
  execute: async (args) => {
    const name = args.name as string;
    const plugin = getPlugin(name);
    if (!plugin) return `Plugin "${name}" not found.`;
    if (!plugin.enabled) return `Plugin "${name}" is already disabled.`;

    setPluginEnabled(name, false);
    log.info(`[plugin] Disabled: ${name}`);
    return `❌ Plugin "${name}" disabled.`;
  },
});

// ─── plugin.create ──────────────────────────────────────────────────────

registerSkill({
  name: "plugin.create",
  description: "Create a new Cowork-compatible plugin from scratch",
  argsSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Plugin name (lowercase, no spaces)" },
      description: { type: "string", description: "What this plugin does" },
      skills: { type: "string", description: "Comma-separated skill names to create" },
    },
    required: ["name", "description"],
  },
  execute: async (args) => {
    const name = (args.name as string).toLowerCase().replace(/\s+/g, "-");
    const description = args.description as string;
    const skillNames = (args.skills as string || "").split(",").map(s => s.trim()).filter(Boolean);

    const pluginDir = path.join(PLUGINS_DIR, name);
    if (fs.existsSync(pluginDir)) {
      return `Plugin "${name}" already exists at ${pluginDir}.`;
    }

    // Create directory structure
    fs.mkdirSync(path.join(pluginDir, "skills"), { recursive: true });
    fs.mkdirSync(path.join(pluginDir, "commands"), { recursive: true });

    // Create manifest
    const manifest = {
      name,
      description,
      version: "1.0.0",
      author: { name: "Kingston" },
      connectors: {},
    };
    fs.writeFileSync(path.join(pluginDir, "plugin.json"), JSON.stringify(manifest, null, 2));

    // Create skill stubs
    for (const skillName of skillNames) {
      const skillDir = path.join(pluginDir, "skills", skillName);
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, "SKILL.md"), `# ${skillName}\n\nkeywords: ${skillName}\n\n## Expertise\n\nAdd your domain knowledge here.\n`);
    }

    return `✅ Plugin "${name}" created at ${pluginDir}\n\nStructure:\n  plugin.json\n  skills/ (${skillNames.length} stubs)\n  commands/ (empty)\n\nEdit the SKILL.md files to add domain expertise, then restart to load.`;
  },
});

// ─── plugin.expertise ───────────────────────────────────────────────────

registerSkill({
  name: "plugin.expertise",
  description: "Get plugin expertise relevant to a query (for testing)",
  argsSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Query to match against plugin skills" },
    },
    required: ["query"],
  },
  execute: async (args) => {
    const query = args.query as string;
    const expertise = getPluginExpertise(query);
    if (!expertise) return "No matching plugin expertise for this query.";
    return expertise;
  },
});

log.info("[plugin] Registered 6 plugin management skills");
