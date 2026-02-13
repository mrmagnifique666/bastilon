/**
 * Skill creation/management skills — Kingston can create new skills at runtime.
 * Uses the SKILL.md standard for dynamic skill loading.
 * Skills: skills.create, skills.reload, skills.md_list, skills.list, skills.search, skills.info
 */
import fs from "node:fs";
import path from "node:path";
import { registerSkill, getAllSkills, getSkill } from "../loader.js";
import { loadMarkdownSkills, createSkillFile } from "../markdown/loader.js";
import { log } from "../../utils/log.js";

const SKILLS_DIR = path.resolve(process.cwd(), "relay", "skills");

registerSkill({
  name: "skills.create",
  description:
    "Create a new skill dynamically using the SKILL.md format. " +
    "Kingston can generate new capabilities at runtime. " +
    "The skill code runs as an async function with access to: args, fetch, log, db, JSON, Date, Math.",
  argsSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Skill name in namespace.method format (e.g. 'utils.uuid')" },
      description: { type: "string", description: "What the skill does" },
      args_yaml: {
        type: "string",
        description:
          'YAML-formatted args, one per line. Example: \'  query: {type: string, description: "Search query", required: true}\'',
      },
      code: {
        type: "string",
        description:
          "JavaScript code (async context). Must return a string. " +
          "Available: args, fetch, log, db, JSON, Date, Math, URL, URLSearchParams",
      },
    },
    required: ["name", "description", "code"],
  },
  adminOnly: true,
  async execute(args): Promise<string> {
    const name = String(args.name);
    const description = String(args.description);
    const argsYaml = args.args_yaml ? String(args.args_yaml) : "";
    const code = String(args.code);

    // Validate name format
    if (!name.includes(".") || name.length < 3) {
      return "Error: name must be in namespace.method format (e.g. 'utils.uuid')";
    }

    // Basic security: block dangerous patterns
    const blocked = ["process.exit", "require(", "import(", "child_process", "eval(", "fs.unlink", "fs.rmdir"];
    for (const pattern of blocked) {
      if (code.includes(pattern)) {
        return `Error: code contains blocked pattern: ${pattern}`;
      }
    }

    try {
      const filePath = createSkillFile(name, description, argsYaml, code);

      // Reload markdown skills to register the new one
      const count = loadMarkdownSkills();

      return `Skill "${name}" created at ${filePath}\n${count} markdown skill(s) loaded.`;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

registerSkill({
  name: "skills.reload",
  description: "Reload all SKILL.md files from relay/skills/. Use after editing skill files.",
  argsSchema: { type: "object", properties: {} },
  adminOnly: true,
  async execute(): Promise<string> {
    try {
      const count = loadMarkdownSkills();
      return `Reloaded: ${count} markdown skill(s) loaded from ${SKILLS_DIR}`;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

registerSkill({
  name: "skills.md_list",
  description: "List all SKILL.md files in relay/skills/.",
  argsSchema: { type: "object", properties: {} },
  async execute(): Promise<string> {
    if (!fs.existsSync(SKILLS_DIR)) {
      return "No skills directory found. Create skills with skills.create.";
    }

    const files = fs.readdirSync(SKILLS_DIR).filter((f) => f.endsWith(".skill.md"));
    if (files.length === 0) return "No SKILL.md files found. Create skills with skills.create.";

    return files
      .map((f) => {
        const stat = fs.statSync(path.join(SKILLS_DIR, f));
        const size = `${(stat.size / 1024).toFixed(1)}KB`;
        const date = stat.mtime.toISOString().split("T")[0];
        return `  ${f} (${size}, ${date})`;
      })
      .join("\n");
  },
});

// --- Skill Store lite: list, search, info ---

registerSkill({
  name: "skills.list",
  description:
    "List all registered skills, optionally filtered by namespace. " +
    "Returns skill name, description preview, and admin flag.",
  argsSchema: {
    type: "object",
    properties: {
      namespace: {
        type: "string",
        description: "Filter by namespace prefix (e.g. 'trading', 'moltbook'). Omit for all.",
      },
      admin_only: {
        type: "boolean",
        description: "If true, show only admin skills. If false, show only non-admin. Omit for all.",
      },
    },
  },
  async execute(args): Promise<string> {
    let skills = getAllSkills();

    // Filter by namespace
    if (args.namespace) {
      const ns = String(args.namespace).toLowerCase();
      skills = skills.filter((s) => s.name.toLowerCase().startsWith(ns + ".") || s.name.toLowerCase().startsWith(ns));
    }

    // Filter by admin flag
    if (args.admin_only !== undefined) {
      const wantAdmin = Boolean(args.admin_only);
      skills = skills.filter((s) => Boolean(s.adminOnly) === wantAdmin);
    }

    if (skills.length === 0) {
      return args.namespace
        ? `No skills found in namespace "${args.namespace}".`
        : "No skills registered.";
    }

    // Group by namespace
    const grouped: Record<string, string[]> = {};
    for (const s of skills) {
      const ns = s.name.split(".")[0];
      if (!grouped[ns]) grouped[ns] = [];
      const desc = s.description.length > 60 ? s.description.slice(0, 57) + "..." : s.description;
      const tag = s.adminOnly ? " [admin]" : "";
      grouped[ns].push(`  ${s.name}${tag} — ${desc}`);
    }

    const lines: string[] = [`**${skills.length} skills** (${Object.keys(grouped).length} namespaces)\n`];
    for (const [ns, entries] of Object.entries(grouped).sort((a, b) => a[0].localeCompare(b[0]))) {
      lines.push(`**${ns}.*** (${entries.length})`);
      lines.push(...entries);
    }

    return lines.join("\n");
  },
});

registerSkill({
  name: "skills.search",
  description:
    "Search skills by keyword in name or description. " +
    "Returns matching skills ranked by relevance.",
  argsSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query (keyword or phrase)" },
      limit: { type: "number", description: "Max results (default: 20)" },
    },
    required: ["query"],
  },
  async execute(args): Promise<string> {
    const query = String(args.query).toLowerCase();
    const limit = Math.min(Number(args.limit) || 20, 50);
    const terms = query.split(/\s+/).filter((t) => t.length > 1);

    if (terms.length === 0) return "Please provide a search query.";

    const skills = getAllSkills();
    const scored: Array<{ skill: typeof skills[0]; score: number }> = [];

    for (const s of skills) {
      const nameLower = s.name.toLowerCase();
      const descLower = s.description.toLowerCase();
      let score = 0;

      for (const term of terms) {
        // Exact name match (highest weight)
        if (nameLower === term) score += 10;
        // Name contains term
        else if (nameLower.includes(term)) score += 5;
        // Description contains term
        if (descLower.includes(term)) score += 2;
      }

      // Full query match in description
      if (descLower.includes(query)) score += 3;

      if (score > 0) scored.push({ skill: s, score });
    }

    scored.sort((a, b) => b.score - a.score);
    const results = scored.slice(0, limit);

    if (results.length === 0) {
      return `No skills matching "${args.query}". Try broader terms or use skills.list to browse by namespace.`;
    }

    const lines = results.map((r) => {
      const desc = r.skill.description.length > 80 ? r.skill.description.slice(0, 77) + "..." : r.skill.description;
      const tag = r.skill.adminOnly ? " [admin]" : "";
      return `  ${r.skill.name}${tag} — ${desc}`;
    });

    return `**${results.length} result(s) for "${args.query}":**\n\n${lines.join("\n")}`;
  },
});

registerSkill({
  name: "skills.info",
  description:
    "Get detailed info about a specific skill: full description, args schema, admin flag, and namespace.",
  argsSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Skill name (e.g. 'trading.buy', 'moltbook.post')" },
    },
    required: ["name"],
  },
  async execute(args): Promise<string> {
    const name = String(args.name);
    const skill = getSkill(name);

    if (!skill) {
      // Try fuzzy match
      const all = getAllSkills();
      const nameLower = name.toLowerCase();
      const close = all
        .filter((s) => s.name.toLowerCase().includes(nameLower) || nameLower.includes(s.name.split(".")[1] || ""))
        .slice(0, 5);

      if (close.length > 0) {
        return `Skill "${name}" not found. Did you mean:\n${close.map((s) => `  - ${s.name}`).join("\n")}`;
      }
      return `Skill "${name}" not found. Use skills.search to find skills.`;
    }

    const ns = skill.name.split(".")[0];
    const schema = skill.argsSchema;

    // Extract args info
    let argsInfo = "  (no arguments)";
    const props = schema?.properties || (schema as any)?.properties;
    if (props && typeof props === "object") {
      const required = new Set<string>(
        (schema as any)?.required || (skill as any).required || []
      );
      const entries = Object.entries(props as Record<string, any>);
      if (entries.length > 0) {
        argsInfo = entries
          .map(([k, v]) => {
            const req = required.has(k) ? " *required*" : "";
            const type = v.type || "any";
            const desc = v.description || "";
            return `  - **${k}** (${type}${req}): ${desc}`;
          })
          .join("\n");
      }
    }

    return (
      `**${skill.name}**\n` +
      `Namespace: ${ns}\n` +
      `Admin only: ${skill.adminOnly ? "yes" : "no"}\n\n` +
      `${skill.description}\n\n` +
      `**Arguments:**\n${argsInfo}`
    );
  },
});
