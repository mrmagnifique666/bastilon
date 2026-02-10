/**
 * code.request skill — Queue a code modification request.
 * Bridges Kingston (Telegram bot) → Executor agent → Émile (Claude Code CLI).
 * Uses code-requests.json as the shared queue file.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { registerSkill } from "../loader.js";

const QUEUE_FILE = path.join(process.cwd(), "code-requests.json");

interface CodeRequest {
  id: number;
  timestamp: string;
  task: string;
  priority: string;
  files: string[];
  status: string;
  result: string | null;
}

async function loadQueue(): Promise<CodeRequest[]> {
  try {
    const data = await fs.readFile(QUEUE_FILE, "utf-8");
    return JSON.parse(data);
  } catch {
    return [];
  }
}

async function saveQueue(queue: CodeRequest[]): Promise<void> {
  await fs.writeFile(QUEUE_FILE, JSON.stringify(queue, null, 2));
}

registerSkill({
  name: "code.request",
  description:
    "Queue a code modification request for the Executor agent to process.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      task: {
        type: "string",
        description: "Detailed description of the code change needed",
      },
      priority: {
        type: "string",
        description: 'low | normal | high (default: "normal")',
      },
      files: {
        type: "string",
        description: "Comma-separated list of files to modify (optional)",
      },
    },
    required: ["task"],
  },
  async execute(args): Promise<string> {
    const task = args.task as string;
    const priority = (args.priority as string) || "normal";
    const filesRaw = args.files as string | undefined;

    if (!["low", "normal", "high"].includes(priority)) {
      return 'Error: priority must be "low", "normal", or "high".';
    }

    const queue = await loadQueue();

    const request: CodeRequest = {
      id: Date.now(),
      timestamp: new Date().toISOString(),
      task,
      priority,
      files: filesRaw ? filesRaw.split(",").map((f) => f.trim()) : [],
      status: "pending",
      result: null,
    };

    queue.push(request);
    await saveQueue(queue);

    return (
      `✅ Code request queued (ID: ${request.id})\n` +
      `Priority: ${priority}\n` +
      `Task: ${task}\n` +
      `\nThe Executor agent will pick this up within 5 minutes.`
    );
  },
});
