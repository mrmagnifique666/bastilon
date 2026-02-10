/**
 * Built-in skill: files (list / read)
 * Sandboxed file operations — ONLY inside SANDBOX_DIR.
 * Never allows writing, deleting, or escaping the sandbox.
 */
import fs from "node:fs";
import { registerSkill } from "../loader.js";
import { safeSandboxPath } from "../../utils/paths.js";

registerSkill({
  name: "files.list",
  description: "List files in the sandbox directory (optionally in a subdirectory).",
  argsSchema: {
    type: "object",
    properties: {
      dir: { type: "string", description: "Subdirectory inside sandbox (default: root)" },
    },
  },
  async execute(args): Promise<string> {
    const dir = safeSandboxPath((args.dir as string) || ".");
    if (!dir) return "Error: path is outside the sandbox.";
    if (!fs.existsSync(dir)) return "Directory does not exist.";
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    if (entries.length === 0) return "(empty directory)";
    return entries
      .map((e) => `${e.isDirectory() ? "[dir] " : ""}${e.name}`)
      .join("\n");
  },
});

registerSkill({
  name: "files.read",
  description: "Read the contents of a file inside the sandbox (max 10 KB).",
  argsSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to sandbox" },
    },
    required: ["path"],
  },
  async execute(args): Promise<string> {
    const filePath = safeSandboxPath(args.path as string);
    if (!filePath) return "Error: path is outside the sandbox.";
    if (!fs.existsSync(filePath)) return "File not found.";
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) return "Error: path is a directory, not a file.";
    if (stat.size > 10 * 1024) return "Error: file exceeds 10 KB limit.";
    return fs.readFileSync(filePath, "utf-8");
  },
});
