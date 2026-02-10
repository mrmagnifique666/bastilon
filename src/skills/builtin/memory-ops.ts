/**
 * Built-in skills: memory & self-improvement (admin only).
 * memory.update — modify MEMORY.md sections
 * memory.query — search across all memory files
 * skills.create — create new skills dynamically
 */
import fs from "node:fs";
import path from "node:path";
import { registerSkill } from "../loader.js";
import { log } from "../../utils/log.js";

// Memory files live alongside the Claude project memory
// Auto-detect: env var > .claude/projects path derived from cwd > fallback
function resolveMemoryDir(): string {
  if (process.env.CLAUDE_MEMORY_DIR) return path.resolve(process.env.CLAUDE_MEMORY_DIR);
  // Derive from cwd: C:\Users\X\Documents\Claude → C:\Users\X\.claude\projects\C--Users-X-Documents-Claude\memory
  const cwd = process.cwd().replace(/\\/g, "/");
  const home = (process.env.HOME || process.env.USERPROFILE || "").replace(/\\/g, "/");
  if (home) {
    const projectSlug = cwd.replace(/\\/g, "/").replace(/[:/]/g, "-").replace(/^-+/, "");
    const candidate = path.join(home, ".claude", "projects", projectSlug, "memory");
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.resolve("memory");
}
const MEMORY_DIR = resolveMemoryDir();

// ── memory.update ──

registerSkill({
  name: "memory.update",
  description:
    "Update a section in a memory file (MEMORY.md, architecture.md, errors.md, nicolas.md, etc.). " +
    "Can append to a section, replace a section, or create a new file.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      file: { type: "string", description: "Memory filename (e.g. 'MEMORY.md', 'errors.md')" },
      action: {
        type: "string",
        description: "Action: append (add to end), replace_section (replace between headers), create (new file)",
      },
      section: {
        type: "string",
        description: "Section header to target (e.g. '## Quick Reference'). Required for replace_section.",
      },
      content: { type: "string", description: "Content to write" },
    },
    required: ["file", "action", "content"],
  },
  async execute(args): Promise<string> {
    const filename = path.basename(args.file as string); // prevent traversal
    const filePath = path.join(MEMORY_DIR, filename);
    const action = args.action as string;
    const content = args.content as string;

    // Safety: only allow .md files in the memory dir
    if (!filename.endsWith(".md")) {
      return "Error: only .md files allowed in memory directory.";
    }

    if (action === "create") {
      if (fs.existsSync(filePath)) {
        return `Error: ${filename} already exists. Use 'append' or 'replace_section' instead.`;
      }
      fs.writeFileSync(filePath, content, "utf-8");
      log.info(`[memory.update] Created ${filename}`);
      return `Created ${filename} (${content.length} chars)`;
    }

    if (!fs.existsSync(filePath)) {
      return `Error: ${filename} not found in memory directory.`;
    }

    const existing = fs.readFileSync(filePath, "utf-8");

    if (action === "append") {
      const updated = existing.trimEnd() + "\n\n" + content + "\n";
      fs.writeFileSync(filePath, updated, "utf-8");
      log.info(`[memory.update] Appended to ${filename}`);
      return `Appended ${content.length} chars to ${filename}`;
    }

    if (action === "replace_section") {
      const section = args.section as string;
      if (!section) return "Error: 'section' is required for replace_section.";

      // Find the section header and the next header at the same level
      const headerLevel = (section.match(/^#+/) || ["##"])[0];
      const lines = existing.split("\n");
      let startIdx = -1;
      let endIdx = lines.length;

      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() === section.trim()) {
          startIdx = i;
          continue;
        }
        if (startIdx >= 0 && i > startIdx) {
          // Check if this line is a header at the same or higher level
          const match = lines[i].match(/^(#+)\s/);
          if (match && match[1].length <= headerLevel.length) {
            endIdx = i;
            break;
          }
        }
      }

      if (startIdx === -1) {
        return `Error: section "${section}" not found in ${filename}. Available sections:\n${
          lines.filter((l) => l.match(/^#+\s/)).join("\n")
        }`;
      }

      // Replace section content (keep header, replace body)
      const before = lines.slice(0, startIdx + 1);
      const after = lines.slice(endIdx);
      const updated = [...before, content, ...after].join("\n");
      fs.writeFileSync(filePath, updated, "utf-8");
      log.info(`[memory.update] Replaced section "${section}" in ${filename}`);
      return `Replaced section "${section}" in ${filename}`;
    }

    return `Unknown action: ${action}. Use: append, replace_section, create.`;
  },
});

// ── memory.query ──

registerSkill({
  name: "memory.query",
  description:
    "Search across all memory files (.md) for keywords or patterns. Returns matching lines with context.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query (case-insensitive substring match)" },
      file: { type: "string", description: "Specific file to search (optional, searches all if omitted)" },
    },
    required: ["query"],
  },
  async execute(args): Promise<string> {
    const query = (args.query as string).toLowerCase();
    const targetFile = args.file as string | undefined;

    if (!fs.existsSync(MEMORY_DIR)) {
      return "Error: memory directory not found.";
    }

    const files = targetFile
      ? [path.join(MEMORY_DIR, path.basename(targetFile))]
      : fs.readdirSync(MEMORY_DIR)
          .filter((f) => f.endsWith(".md"))
          .map((f) => path.join(MEMORY_DIR, f));

    const results: string[] = [];

    for (const filePath of files) {
      if (!fs.existsSync(filePath)) continue;
      const content = fs.readFileSync(filePath, "utf-8");
      const lines = content.split("\n");
      const filename = path.basename(filePath);

      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(query)) {
          // Include 1 line of context before and after
          const before = i > 0 ? lines[i - 1] : "";
          const after = i < lines.length - 1 ? lines[i + 1] : "";
          results.push(
            `**${filename}:${i + 1}**\n${before ? "  " + before + "\n" : ""}  → ${lines[i]}${after ? "\n  " + after : ""}`
          );
        }
      }
    }

    if (results.length === 0) return `No matches for "${args.query}" in memory files.`;

    // Limit output
    const shown = results.slice(0, 20);
    const header = `Found ${results.length} match(es) for "${args.query}":`;
    const footer = results.length > 20 ? `\n...(${results.length - 20} more)` : "";
    return `${header}\n\n${shown.join("\n\n")}${footer}`;
  },
});

// ── memory.list ──

registerSkill({
  name: "memory.list",
  description: "List all memory files with sizes and last-modified dates.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {},
  },
  async execute(): Promise<string> {
    if (!fs.existsSync(MEMORY_DIR)) {
      return "Error: memory directory not found.";
    }

    const files = fs.readdirSync(MEMORY_DIR).filter((f) => f.endsWith(".md"));
    if (files.length === 0) return "No memory files found.";

    const entries = files.map((f) => {
      const stat = fs.statSync(path.join(MEMORY_DIR, f));
      const size = stat.size < 1024
        ? `${stat.size}B`
        : `${(stat.size / 1024).toFixed(1)}KB`;
      const mtime = stat.mtime.toISOString().replace("T", " ").slice(0, 16);
      return `  ${f}  (${size}, ${mtime})`;
    });

    return `Memory directory: ${MEMORY_DIR}\n\n${entries.join("\n")}`;
  },
});

// ── skills.create ──

registerSkill({
  name: "skills.create",
  description:
    "Create a new custom skill. Writes a TypeScript file to src/skills/custom/. " +
    "Requires bot restart (via system.restart) to take effect.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Skill name (e.g. 'myutil.hello'). Must use dot notation.",
      },
      description: { type: "string", description: "What the skill does" },
      args: {
        type: "string",
        description:
          "JSON string defining args: [{\"name\":\"query\",\"type\":\"string\",\"required\":true,\"description\":\"...\"}]",
      },
      code: {
        type: "string",
        description:
          "TypeScript function body. Receives 'args' object. Must return a string. " +
          "Has access to: fs, path, fetch. Example: 'return `Hello ${args.name}`;'",
      },
      confirm: { type: "string", description: "Must be 'yes' to confirm creation" },
    },
    required: ["name", "description", "code", "confirm"],
  },
  async execute(args): Promise<string> {
    if (args.confirm !== "yes") {
      return "Error: set confirm='yes' to confirm skill creation.";
    }

    const skillName = args.name as string;
    const description = args.description as string;
    const code = args.code as string;

    // Validate name
    if (!skillName.includes(".")) {
      return "Error: skill name must use dot notation (e.g. 'myutil.hello').";
    }
    if (/[^a-zA-Z0-9._]/.test(skillName)) {
      return "Error: skill name can only contain letters, numbers, dots, underscores.";
    }

    // Safety: block dangerous patterns in code
    const dangerousPatterns = [
      /process\.exit/i,
      /child_process/i,
      /exec\s*\(/i,
      /spawn\s*\(/i,
      /eval\s*\(/i,
      /Function\s*\(/i,
      /require\s*\(/i,
      /import\s*\(/i,
      /\.env/i,
      /TELEGRAM_BOT_TOKEN/i,
      /ANTHROPIC_API_KEY/i,
    ];

    for (const pattern of dangerousPatterns) {
      if (pattern.test(code)) {
        return `Error: code blocked by safety filter (matched: ${pattern.source}). Custom skills cannot use child_process, eval, require, import, or access secrets.`;
      }
    }

    // Parse args schema
    let argsDef: Array<{ name: string; type: string; required?: boolean; description?: string }> = [];
    if (args.args) {
      try {
        argsDef = JSON.parse(args.args as string);
      } catch {
        return "Error: 'args' must be valid JSON array.";
      }
    }

    // Build properties and required arrays
    const properties = argsDef
      .map(
        (a) =>
          `      ${a.name}: { type: "${a.type}"${a.description ? `, description: "${a.description.replace(/"/g, '\\"')}"` : ""} }`
      )
      .join(",\n");
    const required = argsDef
      .filter((a) => a.required)
      .map((a) => `"${a.name}"`)
      .join(", ");

    // Generate file
    const safeName = skillName.replace(/\./g, "-");
    const filePath = path.resolve(process.cwd(), "src", "skills", "custom", `${safeName}.ts`);

    if (fs.existsSync(filePath)) {
      return `Error: skill file already exists: ${safeName}.ts. Delete it first if you want to recreate.`;
    }

    const fileContent = `/**
 * Custom skill: ${skillName}
 * Auto-generated by Kingston via skills.create
 * Created: ${new Date().toISOString()}
 */
import { registerSkill } from "../loader.js";

registerSkill({
  name: "${skillName}",
  description: "${description.replace(/"/g, '\\"')}",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
${properties}
    },${required ? `\n    required: [${required}],` : ""}
  },
  async execute(args): Promise<string> {
    ${code}
  },
});
`;

    // Ensure custom directory exists
    const customDir = path.dirname(filePath);
    if (!fs.existsSync(customDir)) {
      fs.mkdirSync(customDir, { recursive: true });
    }

    fs.writeFileSync(filePath, fileContent, "utf-8");
    log.info(`[skills.create] Created custom skill: ${skillName} → ${safeName}.ts`);

    // Also add import to loader.ts so it loads on restart
    const loaderPath = path.resolve(process.cwd(), "src", "skills", "loader.ts");
    if (fs.existsSync(loaderPath)) {
      const loader = fs.readFileSync(loaderPath, "utf-8");
      const importLine = `  await import("./custom/${safeName}.js");`;
      if (!loader.includes(importLine)) {
        const updated = loader.replace(
          /(\s*log\.info\(`Loaded)/,
          `${importLine}\n$1`
        );
        fs.writeFileSync(loaderPath, updated, "utf-8");
        log.info(`[skills.create] Added import to loader.ts`);
      }
    }

    return `Skill "${skillName}" created at src/skills/custom/${safeName}.ts.\nRestart the bot (system.restart) to load it.`;
  },
});

log.debug("Registered 4 memory/skills.* skills");
