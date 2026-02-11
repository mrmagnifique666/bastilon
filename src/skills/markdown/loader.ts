/**
 * Markdown Skill Loader — loads SKILL.md files as executable skills.
 * Kingston can create new skills by writing .skill.md files to relay/skills/.
 *
 * Format:
 * ```yaml
 * name: my-namespace.my-skill
 * description: What this skill does
 * admin_only: false
 * args:
 *   query: { type: string, description: "Search query", required: true }
 *   limit: { type: number, description: "Max results" }
 * ```
 * ```javascript
 * // Code block is executed as an async function.
 * // Available: args, fetch, config, log, db
 * const res = await fetch(`https://api.example.com?q=${args.query}`);
 * const data = await res.json();
 * return JSON.stringify(data, null, 2);
 * ```
 *
 * Skills are hot-reloaded when files change.
 */
import fs from "node:fs";
import path from "node:path";
import { registerSkill } from "../loader.js";
import { config } from "../../config/env.js";
import { log } from "../../utils/log.js";
import { getDb } from "../../storage/store.js";

const SKILLS_DIR = path.resolve(process.cwd(), "relay", "skills");

interface ParsedSkillMd {
  name: string;
  description: string;
  adminOnly: boolean;
  args: Record<string, { type: string; description: string; required?: boolean }>;
  code: string;
}

/** Parse a .skill.md file into a structured skill definition */
function parseSkillMd(content: string): ParsedSkillMd | null {
  // Extract YAML front matter (between ```yaml and ```)
  const yamlMatch = content.match(/```ya?ml\s*\n([\s\S]*?)```/i);
  if (!yamlMatch) return null;

  const yaml = yamlMatch[1];

  // Simple YAML-like parsing (no external dep needed)
  const name = yaml.match(/name:\s*(.+)/)?.[1]?.trim();
  const description = yaml.match(/description:\s*(.+)/)?.[1]?.trim();
  const adminOnly = yaml.match(/admin_only:\s*(true|false)/)?.[1] === "true";

  if (!name || !description) return null;

  // Parse args section
  const args: Record<string, { type: string; description: string; required?: boolean }> = {};
  const argsSection = yaml.match(/args:\s*\n((?:\s+.+\n)*)/);
  if (argsSection) {
    const lines = argsSection[1].split("\n").filter((l) => l.trim());
    for (const line of lines) {
      const m = line.match(/^\s+(\w+):\s*\{(.+)\}/);
      if (m) {
        const argName = m[1];
        const props = m[2];
        const type = props.match(/type:\s*(\w+)/)?.[1] || "string";
        const desc = props.match(/description:\s*"([^"]+)"/)?.[1] || "";
        const required = props.includes("required: true");
        args[argName] = { type, description: desc, required };
      }
    }
  }

  // Extract code block (javascript/js/typescript/ts)
  const codeMatch = content.match(/```(?:javascript|js|typescript|ts)\s*\n([\s\S]*?)```/i);
  const code = codeMatch?.[1]?.trim() || "";

  if (!code) return null;

  return { name, description, adminOnly, args, code };
}

/** Create an executable function from skill code */
function createExecutor(code: string): (args: Record<string, unknown>) => Promise<string> {
  return async (args: Record<string, unknown>): Promise<string> => {
    // Build a sandboxed-ish execution context
    const context = {
      args,
      fetch: globalThis.fetch,
      config: {
        // Expose only safe config values
        ollamaUrl: config.ollamaUrl,
        ollamaModel: config.ollamaModel,
        groqApiKey: config.groqApiKey ? "***" : "",
        newsApiKey: config.newsApiKey ? "***" : "",
      },
      log: {
        info: (msg: string) => log.info(`[skill:md] ${msg}`),
        warn: (msg: string) => log.warn(`[skill:md] ${msg}`),
        debug: (msg: string) => log.debug(`[skill:md] ${msg}`),
      },
      db: getDb(),
      JSON,
      Date,
      Math,
      parseInt,
      parseFloat,
      encodeURIComponent,
      decodeURIComponent,
      URL,
      URLSearchParams,
      AbortSignal,
    };

    const contextKeys = Object.keys(context);
    const contextValues = Object.values(context);

    try {
      const fn = new Function(...contextKeys, `return (async () => { ${code} })()`) as (...a: unknown[]) => Promise<unknown>;
      const result = await fn(...contextValues);
      return typeof result === "string" ? result : JSON.stringify(result, null, 2);
    } catch (err) {
      return `Skill error: ${err instanceof Error ? err.message : String(err)}`;
    }
  };
}

/** Load all .skill.md files from relay/skills/ */
export function loadMarkdownSkills(): number {
  if (!fs.existsSync(SKILLS_DIR)) {
    fs.mkdirSync(SKILLS_DIR, { recursive: true });
    log.info(`[skill:md] Created ${SKILLS_DIR}`);
  }

  const files = fs.readdirSync(SKILLS_DIR).filter((f) => f.endsWith(".skill.md"));
  let loaded = 0;

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(SKILLS_DIR, file), "utf-8");
      const parsed = parseSkillMd(content);

      if (!parsed) {
        log.warn(`[skill:md] Failed to parse ${file} — skipping`);
        continue;
      }

      // Build argsSchema from parsed args
      const properties: Record<string, { type: string; description: string }> = {};
      const required: string[] = [];
      for (const [argName, argDef] of Object.entries(parsed.args)) {
        properties[argName] = { type: argDef.type, description: argDef.description };
        if (argDef.required) required.push(argName);
      }

      registerSkill({
        name: parsed.name,
        description: `[MD] ${parsed.description}`,
        adminOnly: parsed.adminOnly,
        argsSchema: { type: "object", properties, required },
        execute: createExecutor(parsed.code),
      });

      loaded++;
      log.info(`[skill:md] Loaded ${parsed.name} from ${file}`);
    } catch (err) {
      log.warn(`[skill:md] Error loading ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return loaded;
}

/** Create a new skill from code (used by skills.create) */
export function createSkillFile(name: string, description: string, args: string, code: string): string {
  if (!fs.existsSync(SKILLS_DIR)) {
    fs.mkdirSync(SKILLS_DIR, { recursive: true });
  }

  const fileName = `${name.replace(/\./g, "-")}.skill.md`;
  const filePath = path.join(SKILLS_DIR, fileName);

  const content = `# ${name}

${description}

\`\`\`yaml
name: ${name}
description: ${description}
admin_only: false
args:
${args || "  # no args"}
\`\`\`

\`\`\`javascript
${code}
\`\`\`
`;

  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}
