/**
 * Parallel execution engine — Level 2: Task Splitter + Parallel Dispatch.
 *
 * Detects multi-task user messages via regex heuristic, splits them using
 * Groq (fast, $0), then dispatches each sub-task to a separate Gemini
 * session concurrently via Promise.allSettled.
 *
 * Flow:
 *   User message → looksMultiTask() → splitTasks(Groq) → Promise.allSettled(runGemini[]) → merge
 */
import { runGroq } from "./groqClient.js";
import { runGemini } from "./gemini.js";
import { log } from "../utils/log.js";

interface SubTask {
  task: string;
  tools_hint: string[];
}

export interface ParallelResult {
  attempted: boolean;
  results?: string[];
  merged?: string;
}

/**
 * Quick regex heuristic — detect messages that likely contain multiple independent tasks.
 * Avoids an LLM call for obvious single tasks.
 */
function looksMultiTask(msg: string): boolean {
  if (msg.length < 20) return false;

  const patterns = [
    // French conjunctions connecting independent clauses
    /\bet\s+(aussi|ensuite|après|puis)\b/i,
    // Period followed by uppercase = new sentence with new intent
    /\.\s*[A-ZÀ-Ü]/,
    // Semicolons separating tasks
    /;\s/,
    // "puis" as standalone connector
    /\bpuis\b/i,
    // Explicit parallel request
    /\ben même temps\b/i,
    // Two imperative verbs connected by "et"
    /\b(fais|check|vérifie|regarde|cherche|écris|poste|envoie|dis|donne|montre|trouve|analyse|résume|calcule).+\bet\s+(fais|check|vérifie|regarde|cherche|écris|poste|envoie|dis|donne|montre|trouve|analyse|résume|calcule)/i,
  ];

  return patterns.some(p => p.test(msg));
}

/**
 * Use Groq to split a message into independent sub-tasks (fast, $0).
 * Returns null if the message is a single task or splitting fails.
 */
async function splitTasks(userMessage: string): Promise<SubTask[] | null> {
  try {
    const response = await runGroq(
      `Tu es un analyseur de requêtes. L'utilisateur envoie un message qui peut contenir PLUSIEURS tâches indépendantes.
Réponds UNIQUEMENT en JSON array. Chaque élément: {"task": "la tâche reformulée clairement", "tools_hint": ["namespace1"]}.
Si c'est UNE SEULE tâche ou si les tâches DÉPENDENT l'une de l'autre (le résultat de l'une est nécessaire pour l'autre), réponds [].
IMPORTANT: Seulement les tâches INDÉPENDANTES (qui n'ont pas besoin du résultat l'une de l'autre).
Exemples de tâches dépendantes (NE PAS séparer): "cherche X et envoie-le à Y", "résume cet article et poste-le".
Exemples de tâches indépendantes (SÉPARER): "dis-moi la météo et check mes positions", "écris un post et vérifie mes emails".`,
      userMessage,
      { temperature: 0, maxTokens: 500 },
    );

    // Extract JSON from response (handle markdown code blocks)
    let jsonStr = response.trim();
    const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      jsonStr = codeBlockMatch[1].trim();
    }

    const parsed = JSON.parse(jsonStr);
    if (!Array.isArray(parsed) || parsed.length < 2) return null;

    // Validate structure and cap at 4 tasks
    const valid = parsed
      .filter((t: any) => t && typeof t.task === "string" && t.task.length > 0)
      .slice(0, 4) as SubTask[];

    return valid.length >= 2 ? valid : null;
  } catch (err) {
    log.debug(`[parallel] Split failed (safe): ${err instanceof Error ? err.message : String(err)}`);
    return null; // Parsing failed — fall through to normal path
  }
}

/**
 * Main entry point — called from router before normal LLM dispatch.
 * Detects multi-task messages, splits them, and dispatches in parallel.
 * Returns { attempted: false } if the message is not multi-task.
 */
export async function tryParallelDispatch(
  chatId: number,
  userMessage: string,
  userId: number,
  isAdmin: boolean,
  onProgress?: (chatId: number, msg: string) => Promise<void>,
): Promise<ParallelResult> {
  // Quick heuristic check — no LLM cost
  if (!looksMultiTask(userMessage)) return { attempted: false };

  // Use Groq to split into independent sub-tasks
  const subtasks = await splitTasks(userMessage);
  if (!subtasks || subtasks.length < 2) return { attempted: false };

  log.info(`[parallel] ⚡ Splitting into ${subtasks.length} sub-tasks: ${subtasks.map(s => s.task).join(" | ")}`);

  // Progressive update to user
  if (onProgress) {
    await onProgress(chatId, `⚡ ${subtasks.length} tâches en parallèle...`);
  }

  // Dispatch each sub-task to Gemini concurrently
  const results = await Promise.allSettled(
    subtasks.map(st =>
      runGemini({
        chatId,
        userMessage: st.task,
        isAdmin,
        userId,
        onToolProgress: onProgress,
      })
    ),
  );

  // Collect results
  const outputs: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === "fulfilled") {
      outputs.push(r.value);
    } else {
      outputs.push(`❌ ${subtasks[i].task}: ${r.reason?.message || "erreur"}`);
    }
  }

  const merged = outputs.join("\n\n---\n\n");
  log.info(`[parallel] ✅ ${outputs.length} sub-tasks completed (${merged.length} chars total)`);

  return { attempted: true, results: outputs, merged };
}
