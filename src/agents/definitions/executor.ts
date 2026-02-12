/**
 * Executor Agent — the workhorse that DOES things.
 *
 * Two task sources:
 * 1. code-requests.json — Kingston's code modification requests (Kingston↔Émile bridge)
 * 2. agent_tasks table — inter-agent task queue (trade/post/research/notify/general)
 *
 * Features:
 * - Task type routing with specialized prompts
 * - Task chaining: output of one task feeds into the next (via chain_to)
 * - Result logging: all results stored in agent_tasks.result
 * - Auto-notification: completed tasks notify Nicolas via telegram.send
 */
import fs from "node:fs";
import path from "node:path";
import type { AgentConfig } from "../base.js";
import { config } from "../../config/env.js";
import { getDb } from "../../storage/store.js";
import { log } from "../../utils/log.js";

const QUEUE_FILE = path.resolve(process.cwd(), "code-requests.json");

interface CodeRequest {
  id: number;
  timestamp: string;
  task: string;
  priority: string;
  files: string[];
  status: string;
  result: string | null;
}

interface AgentTask {
  id: number;
  from_agent: string;
  to_agent: string;
  instruction: string;
  status: string;
  result: string | null;
  created_at: number;
  completed_at: number | null;
}

function loadQueue(): CodeRequest[] {
  try {
    if (!fs.existsSync(QUEUE_FILE)) return [];
    return JSON.parse(fs.readFileSync(QUEUE_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function saveQueue(queue: CodeRequest[]): void {
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));
}

/** Get pending agent_tasks assigned to executor */
function getPendingAgentTasks(limit = 5): AgentTask[] {
  try {
    const db = getDb();
    return db.prepare(
      `SELECT * FROM agent_tasks
       WHERE to_agent = 'executor' AND status = 'pending'
       ORDER BY created_at ASC LIMIT ?`
    ).all(limit) as AgentTask[];
  } catch {
    return [];
  }
}

/** Mark an agent_task as in_progress */
function markTaskInProgress(taskId: number): void {
  try {
    const db = getDb();
    db.prepare("UPDATE agent_tasks SET status = 'in_progress' WHERE id = ?").run(taskId);
  } catch (err) {
    log.warn(`[executor] Failed to mark task ${taskId} in_progress: ${err}`);
  }
}

/** Detect task type from instruction keywords */
function detectTaskType(instruction: string): string {
  const lower = instruction.toLowerCase();
  if (lower.includes("trading") || lower.includes("trade") || lower.includes("buy") || lower.includes("sell") || lower.includes("position")) return "trade";
  if (lower.includes("moltbook") || lower.includes("post") || lower.includes("publish") || lower.includes("content")) return "post";
  if (lower.includes("research") || lower.includes("search") || lower.includes("analyze") || lower.includes("scan")) return "research";
  if (lower.includes("notify") || lower.includes("alert") || lower.includes("send") || lower.includes("telegram")) return "notify";
  return "general";
}

/** Build type-specific tool suggestions */
function getToolsForType(taskType: string): string {
  switch (taskType) {
    case "trade":
      return "Tools: trading.account, trading.positions, trading.buy, trading.sell, trading.autoscan, trading.watchlist, mind.decide";
    case "post":
      return "Tools: moltbook.post, moltbook.comment, moltbook.feed, content.draft, content.publish";
    case "research":
      return "Tools: web.search, web.fetch, moltbook.search, trading.autoscan, memory.search, kg.query";
    case "notify":
      return "Tools: telegram.send, notes.add";
    default:
      return "Tools: utilise tous les outils nécessaires";
  }
}

function buildExecutorPrompt(cycle: number): string | null {
  const parts: string[] = [];

  // Source 1: code-requests.json
  const queue = loadQueue();
  const pendingCode = queue.filter((r) => r.status === "pending");
  if (pendingCode.length > 0) {
    for (const req of pendingCode) {
      req.status = "in_progress";
    }
    saveQueue(queue);

    const codeDetails = pendingCode
      .map((r) => {
        const files = r.files.length > 0 ? `\nFichiers: ${r.files.join(", ")}` : "";
        return `### Code Request #${r.id} (${r.priority})\n${r.task}${files}`;
      })
      .join("\n\n---\n\n");

    parts.push(`## Code Requests (${pendingCode.length})\n\n${codeDetails}`);
  }

  // Source 2: agent_tasks table
  const agentTasks = getPendingAgentTasks(5);
  if (agentTasks.length > 0) {
    for (const task of agentTasks) {
      markTaskInProgress(task.id);
    }

    const taskDetails = agentTasks
      .map((t) => {
        const taskType = detectTaskType(t.instruction);
        const tools = getToolsForType(taskType);
        return (
          `### Task #${t.id} [${taskType.toUpperCase()}] (de ${t.from_agent})\n` +
          `${t.instruction}\n${tools}`
        );
      })
      .join("\n\n---\n\n");

    parts.push(`## Agent Tasks (${agentTasks.length})\n\n${taskDetails}`);
  }

  // Nothing to do — skip this cycle
  if (parts.length === 0) return null;

  const totalTasks = pendingCode.length + agentTasks.length;

  return (
    `Cycle ${cycle} — Executor: ${totalTasks} tâche(s) à traiter\n\n` +
    `Tu es l'agent Executor de Kingston. Tu es le BRAS EXÉCUTANT — tu FAIS les choses.\n\n` +
    parts.join("\n\n") +
    `\n\n## Instructions\n` +
    `Pour CHAQUE tâche ci-dessus :\n` +
    `1. Identifie le type de tâche et utilise les tools appropriés\n` +
    `2. EXÉCUTE la tâche directement — ne te contente pas de noter, AGIS\n` +
    `3. Pour les code requests:\n` +
    `   - Lis les fichiers via files.read\n` +
    `   - Modifie-les via files.write si simple (<50 lignes)\n` +
    `   - Sinon note via notes.add pour Émile (Claude Code)\n` +
    `4. Pour les agent tasks (trade/post/research/notify):\n` +
    `   - TRADE: Appelle trading.* pour exécuter\n` +
    `   - POST: Appelle moltbook.post/content.publish pour publier\n` +
    `   - RESEARCH: Appelle web.search/memory.search et stocke via notes.add\n` +
    `   - NOTIFY: Appelle telegram.send\n` +
    `5. Après chaque tâche, log le résumé dans notes.add — telegram.send UNIQUEMENT si Nicolas doit agir\n` +
    `6. Log via analytics.log(skill='executor.process', outcome='success/fail')\n\n` +
    `RÈGLES:\n` +
    `- Si un tool échoue, essaie une alternative (INGÉNIOSITÉ)\n` +
    `- Pas de placeholders [DONNÉES] — utilise les vraies données\n` +
    `- Trades > $500 → utilise mind.ask au lieu d'exécuter directement\n`
  );
}

export function createExecutorConfig(): AgentConfig {
  return {
    id: "executor",
    name: "Executor",
    role: "Workhorse agent — executes tasks from code-requests.json and agent_tasks queue",
    heartbeatMs: config.agentExecutorHeartbeatMs,
    enabled: config.agentExecutorEnabled,
    chatId: 103, // Session isolation ID — router rewrites to adminChatId for telegram.send
    userId: config.voiceUserId,
    buildPrompt: buildExecutorPrompt,
    cycleCount: 1, // Every heartbeat checks the queue
  };
}
