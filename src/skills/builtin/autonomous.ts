/**
 * Built-in skills: autonomous.goal, autonomous.attempt, autonomous.complete,
 * autonomous.escalate, autonomous.active, autonomous.mode
 *
 * Kingston Autonomous Goal Execution — multi-strategy goal pursuit with
 * automatic escalation to code.requests when all strategies fail.
 */
import { registerSkill } from "../loader.js";
import {
  createGoal,
  logGoalAttempt,
  completeGoal,
  escalateGoal,
  getActiveGoals,
  getGoal,
  getAllGoals,
  countEscalatedToday,
} from "../../storage/store.js";
import { log } from "../../utils/log.js";
import fs from "node:fs";
import path from "node:path";

const QUEUE_FILE = path.resolve(process.cwd(), "code-requests.json");
const MAX_ESCALATIONS_PER_DAY = 3;

/** Load existing code-requests queue */
function loadQueue(): any[] {
  try {
    if (!fs.existsSync(QUEUE_FILE)) return [];
    return JSON.parse(fs.readFileSync(QUEUE_FILE, "utf-8"));
  } catch {
    return [];
  }
}

/** Save code-requests queue */
function saveQueue(queue: any[]): void {
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));
}

// ── autonomous.goal ──

registerSkill({
  name: "autonomous.goal",
  description:
    "Create a new autonomous goal with optional strategy list. Kingston will try each strategy in sequence, escalating if all fail.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      goal: {
        type: "string",
        description: "The objective to achieve",
      },
      strategies: {
        type: "string",
        description: "Comma-separated list of strategies to try in order (e.g. 'web.search,api.call,shell.exec')",
      },
    },
    required: ["goal"],
  },
  async execute(args): Promise<string> {
    const goal = String(args.goal);
    const strategies = args.strategies
      ? String(args.strategies).split(",").map((s) => s.trim()).filter(Boolean)
      : [];

    const id = createGoal(goal, strategies);
    const stratInfo = strategies.length > 0
      ? `\nStratégies: ${strategies.join(" → ")}`
      : "\nAucune stratégie prédéfinie — Kingston choisira dynamiquement.";

    return `Objectif #${id} créé: ${goal}${stratInfo}`;
  },
});

// ── autonomous.attempt ──

registerSkill({
  name: "autonomous.attempt",
  description:
    "Log an attempt on an active goal. Records the strategy used, result, and whether it succeeded.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      goal_id: {
        type: "number",
        description: "ID of the goal",
      },
      strategy: {
        type: "string",
        description: "Strategy/approach tried",
      },
      result: {
        type: "string",
        description: "What happened (outcome description)",
      },
      success: {
        type: "string",
        description: "true or false",
      },
    },
    required: ["goal_id", "strategy", "result", "success"],
  },
  async execute(args): Promise<string> {
    const goalId = Number(args.goal_id);
    const strategy = String(args.strategy);
    const result = String(args.result);
    const success = String(args.success).toLowerCase() === "true";

    const goal = getGoal(goalId);
    if (!goal) return `Erreur: Objectif #${goalId} introuvable.`;
    if (goal.status !== "active") return `Erreur: Objectif #${goalId} n'est plus actif (status=${goal.status}).`;

    logGoalAttempt(goalId, strategy, result, success);

    if (success) {
      return `Tentative réussie sur #${goalId}: ${strategy} → ${result.slice(0, 100)}. Utilise autonomous.complete pour finaliser.`;
    }

    const attempts = goal.attempts.length + 1; // +1 for this new one
    const remaining = goal.strategies.filter(
      (s) => !goal.attempts.some((a) => a.strategy === s) && s !== strategy
    );

    return (
      `Tentative échouée sur #${goalId}: ${strategy} → ${result.slice(0, 100)}\n` +
      `Total tentatives: ${attempts}\n` +
      (remaining.length > 0
        ? `Stratégies restantes: ${remaining.join(", ")}`
        : `Toutes les stratégies épuisées. Utilise autonomous.escalate pour créer un code.request.`)
    );
  },
});

// ── autonomous.complete ──

registerSkill({
  name: "autonomous.complete",
  description:
    "Mark a goal as successfully completed. Logs the final result.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      goal_id: {
        type: "number",
        description: "ID of the goal",
      },
      result: {
        type: "string",
        description: "Final result/outcome description",
      },
    },
    required: ["goal_id", "result"],
  },
  async execute(args): Promise<string> {
    const goalId = Number(args.goal_id);
    const result = String(args.result);

    const goal = getGoal(goalId);
    if (!goal) return `Erreur: Objectif #${goalId} introuvable.`;

    completeGoal(goalId, result);
    return `Objectif #${goalId} accompli: ${goal.goal}\nRésultat: ${result.slice(0, 200)}`;
  },
});

// ── autonomous.escalate ──

registerSkill({
  name: "autonomous.escalate",
  description:
    "All strategies failed — auto-create a code.request for the Executor agent to implement a new capability. Capped at 3 escalations/day.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      goal_id: {
        type: "number",
        description: "ID of the goal",
      },
      reason: {
        type: "string",
        description: "Why all strategies failed and what capability is needed",
      },
    },
    required: ["goal_id", "reason"],
  },
  async execute(args): Promise<string> {
    const goalId = Number(args.goal_id);
    const reason = String(args.reason);

    const goal = getGoal(goalId);
    if (!goal) return `Erreur: Objectif #${goalId} introuvable.`;

    // Daily cap check
    const todayCount = countEscalatedToday();
    if (todayCount >= MAX_ESCALATIONS_PER_DAY) {
      return `Limite atteinte: ${todayCount}/${MAX_ESCALATIONS_PER_DAY} escalations aujourd'hui. Réessaie demain ou demande à Nicolas via mind.ask.`;
    }

    // Mark goal as escalated
    escalateGoal(goalId, reason);

    // Build detailed code.request from goal + all attempts
    const attemptsSummary = goal.attempts
      .map((a, i) => `  ${i + 1}. ${a.strategy}: ${a.result.slice(0, 100)} (${a.success ? "OK" : "FAIL"})`)
      .join("\n");

    const taskDescription =
      `[AUTO-ESCALATION] Objectif: ${goal.goal}\n\n` +
      `Raison de l'escalation: ${reason}\n\n` +
      `Tentatives précédentes:\n${attemptsSummary || "  (aucune)"}\n\n` +
      `Action requise: Implémenter la capacité manquante pour atteindre cet objectif.\n` +
      `Contraintes: Pas d'actions destructives, pas de modifications > $500.`;

    // Create code.request with auto_approve flag
    const queue = loadQueue();
    const newId = queue.length > 0 ? Math.max(...queue.map((r: any) => r.id || 0)) + 1 : 1;
    const codeRequest = {
      id: newId,
      timestamp: new Date().toISOString(),
      task: taskDescription,
      priority: "high",
      files: [],
      status: "pending",
      result: null,
      auto_approve: true,
      safety: "no-destructive",
      source: `autonomous_goal_${goalId}`,
    };
    queue.push(codeRequest);
    saveQueue(queue);

    log.info(`[autonomous] Goal #${goalId} escalated → code.request #${newId}`);

    return (
      `Objectif #${goalId} escaladé → code.request #${newId} créé pour auto-exécution.\n` +
      `L'Executor traitera cette demande au prochain cycle via Gemini.\n` +
      `Escalations aujourd'hui: ${todayCount + 1}/${MAX_ESCALATIONS_PER_DAY}`
    );
  },
});

// ── autonomous.active ──

registerSkill({
  name: "autonomous.active",
  description:
    "List all active autonomous goals. Optionally filter by agent.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      agent: {
        type: "string",
        description: "Filter by creator agent (e.g. 'mind', 'scout')",
      },
      all: {
        type: "string",
        description: "Set to 'true' to show all goals (not just active)",
      },
    },
  },
  async execute(args): Promise<string> {
    const agent = args.agent ? String(args.agent) : undefined;
    const showAll = String(args.all || "false").toLowerCase() === "true";

    const goals = showAll ? getAllGoals(20) : getActiveGoals(agent);

    if (goals.length === 0) {
      return showAll
        ? "Aucun objectif enregistré."
        : "Aucun objectif actif." + (agent ? ` (filtre: ${agent})` : "");
    }

    const lines = goals.map((g) => {
      const statusIcon = g.status === "active" ? "🎯"
        : g.status === "succeeded" ? "✅"
        : g.status === "escalated" ? "🔄"
        : "❌";
      const attemptCount = g.attempts.length;
      const remaining = g.strategies.filter(
        (s) => !g.attempts.some((a) => a.strategy === s)
      );
      const ago = Math.round((Date.now() / 1000 - g.created_at) / 60);
      return (
        `${statusIcon} #${g.id} [${g.status}] ${g.goal.slice(0, 80)}\n` +
        `   Par: ${g.created_by} | ${attemptCount} tentative(s) | il y a ${ago}min\n` +
        (remaining.length > 0 ? `   Stratégies restantes: ${remaining.join(", ")}\n` : "")
      );
    });

    return `**Objectifs${showAll ? " (tous)" : " actifs"}:**\n\n${lines.join("\n")}`;
  },
});

// ── autonomous.mode ──

registerSkill({
  name: "autonomous.mode",
  description:
    "Toggle autonomous goal execution mode on/off. When off, Mind agent won't auto-pursue goals.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      enabled: {
        type: "string",
        description: "true or false",
      },
    },
    required: ["enabled"],
  },
  async execute(args): Promise<string> {
    const enabled = String(args.enabled).toLowerCase() === "true";
    const flagFile = path.resolve("relay/autonomous-mode.flag");

    if (enabled) {
      fs.writeFileSync(flagFile, "enabled", "utf-8");
      return "Mode autonome ACTIVÉ. Kingston Mind poursuivra les objectifs actifs à chaque cycle.";
    } else {
      try { fs.unlinkSync(flagFile); } catch { /* file may not exist */ }
      return "Mode autonome DÉSACTIVÉ. Kingston Mind ignorera les objectifs actifs.";
    }
  },
});

/** Check if autonomous mode is enabled (used by mind.ts) */
export function isAutonomousModeEnabled(): boolean {
  const flagFile = path.resolve("relay/autonomous-mode.flag");
  try {
    return fs.existsSync(flagFile);
  } catch {
    return false;
  }
}
