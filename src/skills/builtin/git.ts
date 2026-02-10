/**
 * Built-in skills: git operations (admin only).
 * git.status, git.diff, git.commit, git.push, git.branch
 * Runs inside the project root directory.
 */
import { spawn } from "node:child_process";
import { registerSkill } from "../loader.js";
import { log } from "../../utils/log.js";

const PROJECT_ROOT = process.cwd();

function runGit(args: string[]): Promise<string> {
  return new Promise<string>((resolve) => {
    const proc = spawn("git", args, {
      cwd: PROJECT_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    proc.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));

    proc.on("error", (err) => resolve(`Error: ${err.message}`));
    proc.on("close", (code) => {
      const output = (stdout + (stderr ? `\n[stderr]\n${stderr}` : "")).trim();
      const truncated =
        output.length > 8000 ? output.slice(0, 8000) + "\n...(truncated)" : output;
      const exitLine = code !== 0 ? `\n[exit code: ${code}]` : "";
      resolve(truncated + exitLine || "(no output)");
    });
  });
}

// ── git.status ──

registerSkill({
  name: "git.status",
  description: "Show git working tree status (staged, unstaged, untracked files).",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      short: { type: "string", description: "Use short format: yes/no (default: no)" },
    },
  },
  async execute(args): Promise<string> {
    const flags = args.short === "yes" ? ["-sb"] : [];
    return runGit(["status", ...flags]);
  },
});

// ── git.diff ──

registerSkill({
  name: "git.diff",
  description: "Show git diff (changes not yet staged, or staged with staged=yes).",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      staged: { type: "string", description: "Show staged changes: yes/no (default: no)" },
      file: { type: "string", description: "Specific file to diff (optional)" },
      stat: { type: "string", description: "Show only file stats: yes/no (default: no)" },
    },
  },
  async execute(args): Promise<string> {
    const flags: string[] = [];
    if (args.staged === "yes") flags.push("--cached");
    if (args.stat === "yes") flags.push("--stat");
    if (args.file) flags.push("--", args.file as string);
    return runGit(["diff", ...flags]);
  },
});

// ── git.commit ──

registerSkill({
  name: "git.commit",
  description:
    "Stage files and create a git commit. Specify files to add, or use addAll='yes' to stage everything.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      message: { type: "string", description: "Commit message" },
      files: { type: "string", description: "Files to stage (comma-separated paths, or '.' for all)" },
      addAll: { type: "string", description: "Stage all changes: yes/no (default: no)" },
    },
    required: ["message"],
  },
  async execute(args): Promise<string> {
    const message = args.message as string;
    if (!message.trim()) return "Error: commit message cannot be empty.";

    // Stage files
    if (args.addAll === "yes") {
      const addResult = await runGit(["add", "-A"]);
      if (addResult.includes("Error:")) return `Staging failed: ${addResult}`;
    } else if (args.files) {
      const files = (args.files as string).split(",").map((f) => f.trim());
      const addResult = await runGit(["add", ...files]);
      if (addResult.includes("Error:")) return `Staging failed: ${addResult}`;
    }

    // Check if there's anything to commit
    const status = await runGit(["status", "--porcelain"]);
    if (!status.trim()) return "Nothing to commit — working tree clean.";

    const result = await runGit(["commit", "-m", message]);
    log.info(`[git.commit] ${message}`);
    return result;
  },
});

// ── git.push ──

registerSkill({
  name: "git.push",
  description: "Push commits to remote. Requires explicit confirmation.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      remote: { type: "string", description: "Remote name (default: origin)" },
      branch: { type: "string", description: "Branch name (default: current branch)" },
      confirm: { type: "string", description: "Must be 'yes' to confirm push" },
    },
  },
  async execute(args): Promise<string> {
    if (args.confirm !== "yes") {
      return "Error: set confirm='yes' to confirm push. This sends code to the remote.";
    }

    const remote = (args.remote as string) || "origin";
    const flags: string[] = [remote];
    if (args.branch) flags.push(args.branch as string);

    log.info(`[git.push] Pushing to ${remote}${args.branch ? `/${args.branch}` : ""}`);
    return runGit(["push", ...flags]);
  },
});

// ── git.branch ──

registerSkill({
  name: "git.branch",
  description:
    "Manage git branches. List branches, create new, switch, or delete. No force-delete allowed.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "Action: list, create, switch, delete (default: list)",
      },
      name: { type: "string", description: "Branch name (required for create/switch/delete)" },
    },
  },
  async execute(args): Promise<string> {
    const action = (args.action as string) || "list";
    const name = args.name as string;

    switch (action) {
      case "list":
        return runGit(["branch", "-a"]);

      case "create":
        if (!name) return "Error: branch name required for 'create'.";
        return runGit(["checkout", "-b", name]);

      case "switch":
        if (!name) return "Error: branch name required for 'switch'.";
        return runGit(["checkout", name]);

      case "delete":
        if (!name) return "Error: branch name required for 'delete'.";
        if (name === "main" || name === "master") {
          return "Error: cannot delete main/master branch.";
        }
        // Safe delete only (not force)
        return runGit(["branch", "-d", name]);

      default:
        return `Unknown action: ${action}. Use: list, create, switch, delete.`;
    }
  },
});

// ── git.log ──

registerSkill({
  name: "git.log",
  description: "Show recent git commit history.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      limit: { type: "number", description: "Number of commits (default 10, max 50)" },
      oneline: { type: "string", description: "Compact one-line format: yes/no (default: yes)" },
    },
  },
  async execute(args): Promise<string> {
    const limit = Math.min(Number(args.limit) || 10, 50);
    const oneline = args.oneline !== "no";
    const flags = oneline
      ? ["--oneline", `--max-count=${limit}`]
      : [`--max-count=${limit}`, "--format=%h %an %ar%n  %s"];
    return runGit(["log", ...flags]);
  },
});

log.debug("Registered 6 git.* skills");
