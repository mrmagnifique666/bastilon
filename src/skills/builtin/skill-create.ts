/**
 * Skill creation/management skills — Kingston can create new skills at runtime.
 * Uses the SKILL.md standard for dynamic skill loading.
 * Skills: skills.create, skills.reload, skills.md_list
 */
import fs from "node:fs";
import path from "node:path";
import { registerSkill } from "../loader.js";
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
