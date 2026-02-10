/**
 * Executor Agent — processes Kingston's code requests queue.
 * Polls code-requests.json every 5 minutes.
 * When pending requests are found:
 *   1. Marks them as "in_progress"
 *   2. Creates a note with full task details
 *   3. Sends a Telegram notification
 *
 * This bridges Kingston (Telegram bot) ↔ Émile (Claude Code CLI).
 * Kingston queues requests via code.request skill → Executor picks them up.
 */
import fs from "node:fs";
import path from "node:path";
import type { AgentConfig } from "../base.js";
import { config } from "../../config/env.js";
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

function buildExecutorPrompt(cycle: number): string | null {
  // Read the queue directly to check for pending requests
  const queue = loadQueue();
  const pending = queue.filter((r) => r.status === "pending");

  if (pending.length === 0) {
    // Nothing to do — skip this cycle
    return null;
  }

  // Mark all pending as in_progress
  for (const req of pending) {
    req.status = "in_progress";
  }
  saveQueue(queue);

  // Build a prompt with all pending requests
  const requestDetails = pending
    .map((r) => {
      const files = r.files.length > 0 ? `\nFichiers: ${r.files.join(", ")}` : "";
      return `### Request #${r.id} (${r.priority})\n${r.task}${files}`;
    })
    .join("\n\n---\n\n");

  return (
    `Cycle ${cycle} — Executor: ${pending.length} code request(s) pending\n\n` +
    `Tu es l'agent Executor de Kingston. Tu traites les demandes de modification de code.\n\n` +
    `## Requests à traiter\n\n${requestDetails}\n\n` +
    `## Instructions\n` +
    `Pour CHAQUE request ci-dessus :\n` +
    `1. Crée une note via notes.add avec le contenu "CODE REQUEST #[id]: [résumé de la tâche]"\n` +
    `2. Envoie un message via telegram.send à Nicolas pour l'informer:\n` +
    `   "📋 Code request #[id] prise en charge: [résumé court]"\n` +
    `3. Si la tâche est simple (< 50 lignes de code), essaie de la résoudre directement:\n` +
    `   - Lis les fichiers concernés via files.read\n` +
    `   - Modifie-les via files.write\n` +
    `   - Informe Nicolas du résultat\n` +
    `4. Si la tâche est complexe, note les détails et laisse Émile (Claude Code) s'en charger\n\n` +
    `Log chaque action via analytics.log(skill='executor.process', outcome='success')`
  );
}

export function createExecutorConfig(): AgentConfig {
  return {
    id: "executor",
    name: "Executor",
    role: "Code request processor — Kingston↔Émile bridge",
    heartbeatMs: config.agentExecutorHeartbeatMs,
    enabled: config.agentExecutorEnabled,
    chatId: 103, // Session isolation ID — router rewrites to adminChatId for telegram.send
    userId: config.voiceUserId,
    buildPrompt: buildExecutorPrompt,
    cycleCount: 1, // Every heartbeat checks the queue
  };
}
