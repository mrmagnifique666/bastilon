/**
 * Ralph Wiggum Loop — Overnight autonomous coding engine.
 *
 * Inspired by the OpenClaw community pattern: a loop that picks code.requests,
 * executes them via Claude Code CLI, runs tests, commits if passing, and moves
 * to the next task. Runs overnight while Nicolas sleeps.
 *
 * Skills:
 * - ralph.start  — Start the overnight loop (processes all pending code.requests)
 * - ralph.stop   — Stop the loop gracefully
 * - ralph.status — Check loop state + progress
 * - ralph.history — View completed tasks from last run
 */
import fs from "node:fs";
import path from "node:path";
import { registerSkill } from "../loader.js";
import { getDb } from "../../storage/store.js";
import { log } from "../../utils/log.js";
import { config } from "../../config/env.js";

const QUEUE_FILE = path.resolve(process.cwd(), "code-requests.json");
const STATE_FILE = path.resolve(process.cwd(), "relay", "ralph-state.json");

interface RalphState {
  running: boolean;
  startedAt: string | null;
  tasksCompleted: number;
  tasksFailed: number;
  tasksSkipped: number;
  currentTask: string | null;
  lastError: string | null;
  stoppedAt: string | null;
}

function getState(): RalphState {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
    }
  } catch {}
  return {
    running: false,
    startedAt: null,
    tasksCompleted: 0,
    tasksFailed: 0,
    tasksSkipped: 0,
    currentTask: null,
    lastError: null,
    stoppedAt: null,
  };
}

function saveState(state: RalphState): void {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

interface CodeRequest {
  id: number;
  timestamp: string;
  task: string;
  priority: string;
  files: string[];
  status: string;
  result: string | null;
}

function loadQueue(): CodeRequest[] {
  try {
    if (!fs.existsSync(QUEUE_FILE)) return [];
    return JSON.parse(fs.readFileSync(QUEUE_FILE, "utf-8"));
  } catch { return []; }
}

function saveQueue(queue: CodeRequest[]): void {
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));
}

// ── ralph.start ──────────────────────────────────────────────────────
registerSkill({
  name: "ralph.start",
  description: "Start the Ralph Wiggum overnight coding loop — processes all pending code.requests autonomously",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      max_tasks: { type: "string", description: "Max tasks to process (default: all)" },
      priority: { type: "string", description: "Only process tasks of this priority (low/normal/high)" },
      dry_run: { type: "string", description: "If 'true', only report what would be done without executing" },
    },
    required: [],
  },
  async execute(args) {
    const state = getState();
    if (state.running) {
      return `Ralph Loop is already running since ${state.startedAt}. ${state.tasksCompleted} completed, ${state.tasksFailed} failed. Current: ${state.currentTask || "idle"}`;
    }

    const queue = loadQueue();
    const pending = queue.filter(r => r.status === "pending" || r.status === "awaiting_execution");

    if (pending.length === 0) {
      return "No pending code requests. Queue is empty. Ralph has nothing to do.";
    }

    const maxTasks = args.max_tasks ? parseInt(args.max_tasks as string) : pending.length;
    const priorityFilter = args.priority as string | undefined;
    const dryRun = args.dry_run === "true";

    let filtered = pending;
    if (priorityFilter) {
      filtered = pending.filter(r => r.priority === priorityFilter);
    }
    filtered = filtered.slice(0, maxTasks);

    if (dryRun) {
      const summary = filtered.map((r, i) => {
        const taskPreview = r.task.length > 100 ? r.task.slice(0, 100) + "..." : r.task;
        return `${i + 1}. [${r.priority}] ${taskPreview}`;
      }).join("\n");
      return `DRY RUN — Ralph would process ${filtered.length} tasks:\n\n${summary}\n\nRun ralph.start without dry_run to execute.`;
    }

    // Mark as running
    const newState: RalphState = {
      running: true,
      startedAt: new Date().toISOString(),
      tasksCompleted: 0,
      tasksFailed: 0,
      tasksSkipped: 0,
      currentTask: null,
      lastError: null,
      stoppedAt: null,
    };
    saveState(newState);

    // Build the task manifest for the executor
    const manifest = filtered.map(r => ({
      id: r.id,
      task: r.task,
      priority: r.priority,
      files: r.files,
    }));

    // Queue each task as an agent_task for the executor to process
    const db = getDb();
    let queued = 0;
    for (const task of manifest) {
      try {
        db.prepare(
          `INSERT INTO agent_tasks (from_agent, to_agent, instruction, status, created_at)
           VALUES ('ralph', 'executor', ?, 'pending', ?)`
        ).run(
          `[RALPH WIGGUM LOOP] Process code request #${task.id}:\n\n${task.task}\n\nFiles: ${(task.files || []).join(", ") || "auto-detect"}\nPriority: ${task.priority}\n\nAfter completing, mark the code request as done in code-requests.json.`,
          Math.floor(Date.now() / 1000)
        );
        queued++;

        // Mark the code request as in_progress
        const q = loadQueue();
        const item = q.find(r => r.id === task.id);
        if (item) {
          item.status = "in_progress";
          saveQueue(q);
        }
      } catch (err) {
        log.error(`[ralph] Failed to queue task ${task.id}: ${err}`);
      }
    }

    newState.currentTask = `Queued ${queued} tasks for executor`;
    saveState(newState);

    // Log to analytics
    try {
      const analyticsSkill = (await import("../loader.js")).getSkill("analytics.log");
      if (analyticsSkill) {
        await analyticsSkill.execute({
          skill: "ralph.start",
          action: "loop_started",
          outcome: `Queued ${queued} tasks`,
        });
      }
    } catch {}

    return `Ralph Wiggum Loop STARTED.\n\n` +
      `Tasks queued: ${queued}/${filtered.length}\n` +
      `Priority filter: ${priorityFilter || "all"}\n` +
      `Started at: ${newState.startedAt}\n\n` +
      `The Executor agent will process these tasks on its 5-minute heartbeat cycle. ` +
      `Use ralph.status to monitor progress.`;
  },
});

// ── ralph.stop ───────────────────────────────────────────────────────
registerSkill({
  name: "ralph.stop",
  description: "Stop the Ralph Wiggum loop gracefully — pending queued tasks will still complete",
  adminOnly: true,
  argsSchema: { type: "object", properties: {}, required: [] },
  async execute() {
    const state = getState();
    if (!state.running) {
      return "Ralph Loop is not running.";
    }

    state.running = false;
    state.stoppedAt = new Date().toISOString();
    saveState(state);

    // Cancel pending ralph tasks in agent_tasks
    try {
      const db = getDb();
      const cancelled = db.prepare(
        "UPDATE agent_tasks SET status = 'cancelled' WHERE from_agent = 'ralph' AND status = 'pending'"
      ).run();
      return `Ralph Loop STOPPED.\n\nCompleted: ${state.tasksCompleted}\nFailed: ${state.tasksFailed}\nCancelled remaining: ${cancelled.changes} tasks`;
    } catch (err) {
      return `Ralph Loop stopped but error cancelling tasks: ${err}`;
    }
  },
});

// ── ralph.status ─────────────────────────────────────────────────────
registerSkill({
  name: "ralph.status",
  description: "Check Ralph Wiggum loop status and progress",
  adminOnly: true,
  argsSchema: { type: "object", properties: {}, required: [] },
  async execute() {
    const state = getState();

    // Count remaining ralph tasks in agent_tasks
    let pending = 0;
    let inProgress = 0;
    let completed = 0;
    let failed = 0;
    try {
      const db = getDb();
      const stats = db.prepare(
        `SELECT status, COUNT(*) as c FROM agent_tasks
         WHERE from_agent = 'ralph'
         GROUP BY status`
      ).all() as { status: string; c: number }[];
      for (const s of stats) {
        if (s.status === "pending") pending = s.c;
        else if (s.status === "in_progress") inProgress = s.c;
        else if (s.status === "completed") completed = s.c;
        else if (s.status === "failed") failed = s.c;
      }
    } catch {}

    // Count code-requests queue
    const queue = loadQueue();
    const queuePending = queue.filter(r => r.status === "pending" || r.status === "awaiting_execution").length;
    const queueInProgress = queue.filter(r => r.status === "in_progress").length;
    const queueDone = queue.filter(r => r.status === "completed" || r.status === "done").length;

    return `RALPH WIGGUM LOOP STATUS\n` +
      `═══════════════════════\n` +
      `Running: ${state.running ? "YES" : "NO"}\n` +
      `Started: ${state.startedAt || "never"}\n` +
      `Stopped: ${state.stoppedAt || "n/a"}\n\n` +
      `AGENT TASKS (ralph → executor):\n` +
      `  Pending: ${pending}\n` +
      `  In Progress: ${inProgress}\n` +
      `  Completed: ${completed}\n` +
      `  Failed: ${failed}\n\n` +
      `CODE REQUESTS QUEUE:\n` +
      `  Pending: ${queuePending}\n` +
      `  In Progress: ${queueInProgress}\n` +
      `  Done: ${queueDone}\n` +
      `  Total: ${queue.length}\n\n` +
      `Last error: ${state.lastError || "none"}`;
  },
});

// ── ralph.history ────────────────────────────────────────────────────
registerSkill({
  name: "ralph.history",
  description: "View completed tasks from Ralph Wiggum loop runs",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      limit: { type: "string", description: "Number of results (default: 10)" },
    },
    required: [],
  },
  async execute(args) {
    const limit = args.limit ? parseInt(args.limit as string) : 10;

    try {
      const db = getDb();
      const tasks = db.prepare(
        `SELECT id, instruction, status, result, created_at, completed_at
         FROM agent_tasks
         WHERE from_agent = 'ralph'
         ORDER BY created_at DESC
         LIMIT ?`
      ).all(limit) as {
        id: number;
        instruction: string;
        status: string;
        result: string | null;
        created_at: number;
        completed_at: number | null;
      }[];

      if (tasks.length === 0) {
        return "No Ralph Wiggum tasks found. Run ralph.start to begin processing code requests.";
      }

      const lines = tasks.map(t => {
        const date = new Date(t.created_at * 1000).toISOString().slice(0, 16);
        const taskPreview = t.instruction.slice(0, 80).replace(/\n/g, " ");
        const resultPreview = t.result ? t.result.slice(0, 60).replace(/\n/g, " ") : "no result";
        return `[${t.status}] ${date} — ${taskPreview}...\n  Result: ${resultPreview}`;
      });

      return `RALPH WIGGUM HISTORY (last ${limit}):\n\n${lines.join("\n\n")}`;
    } catch (err) {
      return `Error fetching history: ${err}`;
    }
  },
});
