/**
 * Built-in skill: code.run
 * Execute Python, Node.js, or shell code snippets (admin only).
 */
import { spawn } from "node:child_process";
import { registerSkill } from "../loader.js";
import { config } from "../../config/env.js";

const BLOCKED_PATTERNS = [
  /rm\s+(-[a-z]*)?r.*\//i,
  /mkfs/i,
  /dd\s+.*of=\/dev/i,
  /format\s+[a-z]:/i,
  /shutdown/i,
  /reboot/i,
  /init\s+0/i,
  /:(){ :\|:& };:/,
];

const MAX_OUTPUT = 8000;

type Language = "python" | "node" | "shell";

function getRunner(language: Language): { cmd: string; args: string[] } {
  switch (language) {
    case "python":
      return { cmd: "python", args: ["-c"] };
    case "node":
      return { cmd: "node", args: ["-e"] };
    case "shell": {
      const isWindows = process.platform === "win32";
      return {
        cmd: isWindows ? "cmd.exe" : "/bin/sh",
        args: [isWindows ? "/c" : "-c"],
      };
    }
  }
}

registerSkill({
  name: "code.run",
  description:
    "Execute a code snippet in Python, Node.js, or shell and return its output (admin only).",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      language: {
        type: "string",
        description: 'Language: "python", "node", or "shell"',
      },
      code: { type: "string", description: "Code to execute" },
    },
    required: ["language", "code"],
  },
  async execute(args): Promise<string> {
    const language = (args.language as string).toLowerCase() as Language;
    const code = args.code as string;

    if (!["python", "node", "shell"].includes(language)) {
      return 'Error: language must be "python", "node", or "shell".';
    }

    // Check blocked patterns for shell code
    if (language === "shell") {
      for (const pattern of BLOCKED_PATTERNS) {
        if (pattern.test(code)) {
          return `Error: code blocked by safety filter (matched: ${pattern.source}).`;
        }
      }
    }

    const { cmd, args: runArgs } = getRunner(language);

    return new Promise<string>((resolve) => {
      const proc = spawn(cmd, [...runArgs, code], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: config.codeTimeout,
        cwd: config.sandboxDir,
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      proc.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on("error", (err) => {
        resolve(`Error: ${err.message}`);
      });

      proc.on("close", (code) => {
        const output = (
          stdout + (stderr ? `\n[stderr]\n${stderr}` : "")
        ).trim();
        const truncated =
          output.length > MAX_OUTPUT
            ? output.slice(0, MAX_OUTPUT) + "\n...(truncated)"
            : output;
        const exitLine = code !== 0 ? `\n[exit code: ${code}]` : "";
        resolve(truncated + exitLine || "(no output)");
      });
    });
  },
});
