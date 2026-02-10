/**
 * Built-in skills: advanced file operations (admin only).
 * files.search — search files by name or content
 * files.move — move/rename files
 * files.delete — delete files (with safety guards)
 * files.watch — snapshot a directory to detect changes
 */
import fs from "node:fs";
import path from "node:path";
import { registerSkill } from "../loader.js";
import { log } from "../../utils/log.js";

// ── Safety: paths that must never be deleted ──
const PROTECTED_PATTERNS = [
  /node_modules/,
  /\.git[\\/]/,
  /\.env/,
  /package\.json$/,
  /package-lock\.json$/,
  /tsconfig\.json$/,
];

function isProtected(filePath: string): boolean {
  return PROTECTED_PATTERNS.some((p) => p.test(filePath));
}

// ── files.search ──

function walkDir(dir: string, maxDepth: number, depth = 0): string[] {
  if (depth > maxDepth) return [];
  const results: string[] = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      if (entry.isDirectory()) {
        results.push(...walkDir(full, maxDepth, depth + 1));
      } else {
        results.push(full);
      }
    }
  } catch {
    // Permission denied or similar — skip
  }
  return results;
}

registerSkill({
  name: "files.search",
  description:
    "Search files by name pattern and/or content (like grep). Admin only. Skips node_modules/.git.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      dir: { type: "string", description: "Root directory to search (absolute path)" },
      namePattern: {
        type: "string",
        description: "Filename pattern (supports * and ? wildcards, e.g. '*.ts')",
      },
      contentPattern: {
        type: "string",
        description: "Search file contents for this text (case-insensitive substring match)",
      },
      maxDepth: { type: "number", description: "Max directory depth (default 5)" },
      limit: { type: "number", description: "Max results (default 30)" },
    },
    required: ["dir"],
  },
  async execute(args): Promise<string> {
    const dir = path.resolve(args.dir as string);
    if (!fs.existsSync(dir)) return "Error: directory not found.";
    if (!fs.statSync(dir).isDirectory()) return "Error: path is not a directory.";

    const maxDepth = Math.min(Number(args.maxDepth) || 5, 10);
    const limit = Math.min(Number(args.limit) || 30, 100);
    const namePattern = args.namePattern as string | undefined;
    const contentPattern = args.contentPattern as string | undefined;

    if (!namePattern && !contentPattern) {
      return "Error: provide at least namePattern or contentPattern.";
    }

    // Build name regex from glob-like pattern
    let nameRe: RegExp | null = null;
    if (namePattern) {
      const escaped = namePattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".");
      nameRe = new RegExp(`^${escaped}$`, "i");
    }

    const allFiles = walkDir(dir, maxDepth);
    const matches: string[] = [];

    for (const filePath of allFiles) {
      if (matches.length >= limit) break;

      const basename = path.basename(filePath);

      // Filter by name
      if (nameRe && !nameRe.test(basename)) continue;

      // Filter by content
      if (contentPattern) {
        try {
          const stat = fs.statSync(filePath);
          if (stat.size > 512 * 1024) continue; // Skip files > 512KB
          const content = fs.readFileSync(filePath, "utf-8");
          if (!content.toLowerCase().includes(contentPattern.toLowerCase())) continue;
        } catch {
          continue;
        }
      }

      // Show relative path from search root
      matches.push(path.relative(dir, filePath));
    }

    if (matches.length === 0) return "No files matched.";

    const header = `Found ${matches.length} file(s) in ${dir}:`;
    return `${header}\n${matches.join("\n")}`;
  },
});

// ── files.move ──

registerSkill({
  name: "files.move",
  description: "Move or rename a file (admin only).",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      from: { type: "string", description: "Source file path (absolute)" },
      to: { type: "string", description: "Destination file path (absolute)" },
    },
    required: ["from", "to"],
  },
  async execute(args): Promise<string> {
    const from = path.resolve(args.from as string);
    const to = path.resolve(args.to as string);

    if (!fs.existsSync(from)) return "Error: source file not found.";
    if (fs.existsSync(to)) return "Error: destination already exists. Delete it first or choose another name.";

    if (isProtected(from)) {
      return `Error: ${path.basename(from)} is a protected file and cannot be moved.`;
    }

    // Ensure destination directory exists
    const destDir = path.dirname(to);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    try {
      fs.renameSync(from, to);
      log.info(`[files.move] ${from} → ${to}`);
      return `Moved: ${from} → ${to}`;
    } catch (err) {
      return `Error moving file: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

// ── files.delete ──

registerSkill({
  name: "files.delete",
  description:
    "Delete a file (admin only). Cannot delete protected files (.env, package.json, etc.) or directories.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute file path to delete" },
      confirm: {
        type: "string",
        description: "Must be 'yes' to confirm deletion",
      },
    },
    required: ["path", "confirm"],
  },
  async execute(args): Promise<string> {
    if (args.confirm !== "yes") {
      return "Error: set confirm='yes' to confirm deletion.";
    }

    const filePath = path.resolve(args.path as string);

    if (!fs.existsSync(filePath)) return "Error: file not found.";

    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      return "Error: cannot delete directories. Use shell.exec with rm -r if absolutely necessary.";
    }

    if (isProtected(filePath)) {
      return `Error: ${path.basename(filePath)} is a protected file and cannot be deleted.`;
    }

    try {
      fs.unlinkSync(filePath);
      log.info(`[files.delete] Deleted: ${filePath}`);
      return `Deleted: ${filePath}`;
    } catch (err) {
      return `Error deleting file: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

// ── files.watch ──
// Since tool calls are synchronous request/response, files.watch takes a snapshot
// of a directory (files + sizes + modified times). Call it twice to detect changes.

registerSkill({
  name: "files.watch",
  description:
    "Snapshot a directory — lists files with sizes and modification times. Call twice to detect changes between snapshots. Admin only.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      dir: { type: "string", description: "Directory to snapshot (absolute path)" },
      maxDepth: { type: "number", description: "Max depth (default 3)" },
      namePattern: { type: "string", description: "Optional filename filter (glob: *.ts)" },
    },
    required: ["dir"],
  },
  async execute(args): Promise<string> {
    const dir = path.resolve(args.dir as string);
    if (!fs.existsSync(dir)) return "Error: directory not found.";
    if (!fs.statSync(dir).isDirectory()) return "Error: path is not a directory.";

    const maxDepth = Math.min(Number(args.maxDepth) || 3, 8);
    const namePattern = args.namePattern as string | undefined;

    let nameRe: RegExp | null = null;
    if (namePattern) {
      const escaped = namePattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".");
      nameRe = new RegExp(`^${escaped}$`, "i");
    }

    const allFiles = walkDir(dir, maxDepth);
    const entries: string[] = [];

    for (const filePath of allFiles) {
      if (entries.length >= 100) break;

      if (nameRe && !nameRe.test(path.basename(filePath))) continue;

      try {
        const stat = fs.statSync(filePath);
        const rel = path.relative(dir, filePath);
        const size =
          stat.size < 1024
            ? `${stat.size}B`
            : stat.size < 1048576
              ? `${(stat.size / 1024).toFixed(1)}KB`
              : `${(stat.size / 1048576).toFixed(1)}MB`;
        const mtime = stat.mtime.toISOString().replace("T", " ").slice(0, 19);
        entries.push(`${rel}  ${size}  ${mtime}`);
      } catch {
        // Skip unreadable files
      }
    }

    if (entries.length === 0) return "No files found.";

    const header = `Snapshot of ${dir} (${entries.length} files):`;
    return `${header}\n${"─".repeat(60)}\n${entries.join("\n")}`;
  },
});
