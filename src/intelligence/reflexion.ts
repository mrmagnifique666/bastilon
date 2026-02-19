/**
 * Reflexion — Self-improvement through verbal self-critique.
 * After a failed goal or agent cycle, generates a reflection and stores it in episodic memory.
 * Future attempts retrieve relevant past reflections to avoid repeating mistakes.
 * Based on: Shinn et al., "Reflexion: Language Agents with Verbal Reinforcement Learning" (NeurIPS 2023)
 */
import { getDb } from "../storage/store.js";
import { logEpisodicEvent, recallEvents } from "../storage/store.js";
import { log } from "../utils/log.js";

/**
 * Generate a reflection after a failed goal/task.
 * Stores in episodic memory with type "reflection".
 */
export function logReflection(opts: {
  goalId?: number;
  agentId?: string;
  task: string;
  outcome: string;
  error?: string;
  strategy?: string;
}): number {
  const reflection = [
    `TÂCHE: ${opts.task}`,
    `RÉSULTAT: ${opts.outcome}`,
    opts.error ? `ERREUR: ${opts.error}` : null,
    opts.strategy ? `STRATÉGIE UTILISÉE: ${opts.strategy}` : null,
    `LEÇON: Éviter cette approche dans des situations similaires.`,
  ].filter(Boolean).join("\n");

  const id = logEpisodicEvent("reflection", reflection, {
    details: JSON.stringify({ goalId: opts.goalId, agentId: opts.agentId, strategy: opts.strategy }),
    participants: opts.agentId ? [opts.agentId] : [],
    importance: 0.8,  // Reflections are highly important
    emotionalValence: -0.3,  // Failures are slightly negative
  });

  log.info(`[reflexion] Logged reflection #${id} for ${opts.agentId || `goal #${opts.goalId}`}`);
  return id;
}

/**
 * Retrieve relevant past reflections for a given task/goal description.
 * Returns the 3 most relevant reflections as a formatted prompt block.
 */
export function getRelevantReflections(taskDescription: string, limit = 3): string {
  // Search for reflections matching keywords from the task
  const keywords = taskDescription
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w.length > 3)
    .slice(0, 5);

  const allReflections = recallEvents({
    eventType: "reflection",
    minImportance: 0.5,
    limit: 30,
  });

  if (allReflections.length === 0) return "";

  // Score reflections by keyword overlap with the task
  const scored = allReflections.map(r => {
    const text = (r.summary + " " + (r.details || "")).toLowerCase();
    const score = keywords.reduce((sum, kw) => sum + (text.includes(kw) ? 1 : 0), 0);
    return { ...r, score };
  });

  // Sort by score (desc), then by recency
  scored.sort((a, b) => b.score - a.score || b.created_at - a.created_at);

  const top = scored.slice(0, limit).filter(r => r.score > 0);
  if (top.length === 0) {
    // No keyword match — return most recent reflections instead
    const recent = allReflections.slice(0, limit);
    if (recent.length === 0) return "";

    const lines = recent.map(r => {
      const date = new Date(r.created_at * 1000).toISOString().slice(0, 10);
      return `- [${date}] ${r.summary.slice(0, 200)}`;
    });
    return `\n═══ RÉFLEXIONS PASSÉES (leçons apprises) ═══\n${lines.join("\n")}\n`;
  }

  const lines = top.map(r => {
    const date = new Date(r.created_at * 1000).toISOString().slice(0, 10);
    return `- [${date}] ${r.summary.slice(0, 200)}`;
  });

  return `\n═══ RÉFLEXIONS PASSÉES (leçons apprises) ═══\n${lines.join("\n")}\nUtilise ces leçons pour éviter de répéter les mêmes erreurs.\n`;
}

/**
 * Get past failed attempts for a similar goal (Cross-Trial Learning).
 * Searches autonomous_decisions and goal_tree for failures with similar descriptions.
 */
export function getCrossTrialLearnings(goalDescription: string, limit = 3): string {
  const db = getDb();
  const keywords = goalDescription
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w.length > 4)
    .slice(0, 3);

  if (keywords.length === 0) return "";

  try {
    // Search failed goals with similar descriptions
    const failedGoals = db.prepare(
      `SELECT goal, last_error, strategies, result
       FROM goal_tree
       WHERE status = 'failed' AND last_error IS NOT NULL
       ORDER BY updated_at DESC LIMIT 20`
    ).all() as Array<{ goal: string; last_error: string; strategies: string; result: string | null }>;

    const relevant = failedGoals.filter(g => {
      const text = g.goal.toLowerCase();
      return keywords.some(kw => text.includes(kw));
    }).slice(0, limit);

    if (relevant.length === 0) return "";

    const lines = relevant.map(g =>
      `- GOAL ÉCHOUÉ: "${g.goal.slice(0, 80)}"\n  ERREUR: ${(g.last_error || "inconnue").slice(0, 120)}`
    );

    return `\n═══ TENTATIVES PASSÉES ÉCHOUÉES (ne pas répéter) ═══\n${lines.join("\n")}\n`;
  } catch {
    return "";
  }
}
