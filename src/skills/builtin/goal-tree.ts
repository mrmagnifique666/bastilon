/**
 * Goal Tree — Hierarchical goal execution with PEODC per node.
 *
 * Replaces the flat autonomous_goals system with a recursive tree:
 *   Root goal ("Make $150")
 *     ├── Sub-goal ("Sell t-shirts")
 *     │   ├── Leaf ("Get Shopify API keys")  ← FOCUS (deepest active)
 *     │   └── Leaf ("Create product")         ← BLOCKED
 *     └── Sub-goal ("AI consulting")          ← NOT STARTED (Plan B)
 *
 * Each node has:
 * - Its own PEODC phase (P→E→O→D→C)
 * - Multiple strategies (Plan A → B → C)
 * - Automatic fallback when a strategy fails
 * - Parent notification when completed
 *
 * Skills: goal.set, goal.focus, goal.advance, goal.complete,
 *         goal.fail, goal.tree, goal.decompose, goal.status
 */
import { registerSkill } from "../loader.js";
import { getDb } from "../../storage/store.js";
import fs from "node:fs";
import path from "node:path";
import { log } from "../../utils/log.js";
import { getBotSendFn } from "./telegram.js";
import { config } from "../../config/env.js";

/**
 * Send a proactive update to Nicolas via Telegram.
 * Fire-and-forget — never blocks goal execution.
 */
function notifyNicolas(message: string): void {
  const send = getBotSendFn();
  const chatId = config.adminChatId;
  if (send && chatId) {
    send(chatId, message).catch(() => {});
  }
}

/**
 * Trigger Mind agent to run immediately (bypasses 20min heartbeat).
 * Lazy-imported to avoid circular dependencies.
 */
function triggerMindNow(): void {
  import("../../agents/registry.js").then(({ triggerAgent }) => {
    const triggered = triggerAgent("mind");
    if (triggered) {
      log.info("[goal-tree] Triggered immediate Mind cycle for new goal");
    }
  }).catch(() => {});
}

// ── DB Schema ──

function ensureTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS goal_tree (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parent_id INTEGER REFERENCES goal_tree(id),
      root_id INTEGER,
      goal TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      depth INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,

      -- PEODC state
      peodc_phase TEXT DEFAULT 'P',
      plan_output TEXT,
      explore_output TEXT,
      organize_output TEXT,
      direct_output TEXT,
      control_output TEXT,

      -- Multi-strategy
      strategies TEXT DEFAULT '[]',
      current_strategy INTEGER DEFAULT 0,

      -- Tracking
      attempts INTEGER DEFAULT 0,
      max_attempts INTEGER DEFAULT 15,
      last_error TEXT,
      result TEXT,

      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_goal_tree_status ON goal_tree(status, root_id);
    CREATE INDEX IF NOT EXISTS idx_goal_tree_parent ON goal_tree(parent_id);
  `);
}

// ── Types ──

interface GoalNode {
  id: number;
  parent_id: number | null;
  root_id: number | null;
  goal: string;
  status: string;
  depth: number;
  sort_order: number;
  peodc_phase: string;
  plan_output: string | null;
  explore_output: string | null;
  organize_output: string | null;
  direct_output: string | null;
  control_output: string | null;
  strategies: string;
  current_strategy: number;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  result: string | null;
  created_at: number;
  updated_at: number;
}

const PHASES = ["P", "E", "O", "D", "C"] as const;
type Phase = typeof PHASES[number];

const PHASE_NAMES: Record<Phase, string> = {
  P: "Planification",
  E: "Exploration",
  O: "Organisation",
  D: "Direction",
  C: "Contrôle",
};

const PHASE_ICONS: Record<Phase, string> = {
  P: "📋", E: "🔍", O: "📐", D: "⚡", C: "✅",
};

const PHASE_INSTRUCTIONS: Record<Phase, string> = {
  P:
    `PHASE P — PLANIFICATION\n` +
    `Lis TOUTE la documentation existante. Comprends le contexte.\n` +
    `1. files.read_anywhere — fichiers pertinents\n` +
    `2. notes.list / memory.recall / kg.search — connaissances existantes\n` +
    `OUTPUT: Ce qu'on SAIT, ce qu'on NE SAIT PAS, les CONTRAINTES, les RESSOURCES.\n` +
    `Quand terminé → goal.advance(id, output) pour passer à E.`,

  E:
    `PHASE E — EXPLORATION\n` +
    `Va chercher TOUTES les informations manquantes identifiées en P.\n` +
    `1. web.search — chaque question ouverte (2+ reformulations si besoin)\n` +
    `2. web.fetch / api.call — lire les pages et APIs\n` +
    `3. shell.exec — vérifier l'état système si nécessaire\n` +
    `OUTPUT: Réponses aux questions, nouvelles données, blocages identifiés.\n` +
    `Quand terminé → goal.advance(id, output) pour passer à O.`,

  O:
    `PHASE O — ORGANISATION\n` +
    `Basé sur P + E, crée un PLAN d'action concret.\n` +
    `1. Décompose en sous-objectifs si nécessaire → goal.set(goal, parent_id=THIS)\n` +
    `2. Définis les stratégies (Plan A, B, C) pour chaque sous-objectif\n` +
    `3. Définis l'ordre d'exécution et les critères de succès\n` +
    `OUTPUT: Plan numéroté avec sous-goals créés.\n` +
    `Quand terminé → goal.advance(id, output) pour passer à D.`,

  D:
    `PHASE D — DIRECTION\n` +
    `EXÉCUTE le plan. Fais le travail toi-même.\n` +
    `1. Exécute les tâches via tool calls directs\n` +
    `2. Si une approche échoue → essaie Plan B immédiatement\n` +
    `3. Délègue via agents.delegate si nécessaire\n` +
    `4. Log chaque décision avec mind.decide\n` +
    `OUTPUT: Status de chaque action (done/failed/blocked).\n` +
    `Quand terminé → goal.advance(id, output) pour passer à C.`,

  C:
    `PHASE C — CONTRÔLE\n` +
    `VÉRIFIE que le résultat est RÉEL (pas hallucination).\n` +
    `1. Teste concrètement (API calls, web.fetch, vérifications)\n` +
    `2. Compare résultat vs objectif original\n` +
    `3. Si OK → goal.complete(id, result)\n` +
    `4. Si PAS OK → goal.fail(id, reason) pour essayer la prochaine stratégie\n` +
    `OUTPUT: Score de complétion, leçons apprises.`,
};

// ── Helpers ──

function getStrategies(node: GoalNode): string[] {
  try { return JSON.parse(node.strategies || "[]"); } catch { return []; }
}

function getChildren(db: any, parentId: number): GoalNode[] {
  return db.prepare(
    "SELECT * FROM goal_tree WHERE parent_id = ? ORDER BY sort_order, id"
  ).all(parentId) as GoalNode[];
}

function getRootId(db: any, nodeId: number, node?: GoalNode): number {
  const n = node || db.prepare("SELECT * FROM goal_tree WHERE id = ?").get(nodeId) as GoalNode | undefined;
  if (!n) return nodeId;
  if (!n.parent_id) return n.id;
  return getRootId(db, n.parent_id);
}

/**
 * Find the deepest active leaf in the tree.
 * This is what Kingston should work on NOW.
 */
function findFocus(db: any, rootId: number): GoalNode | null {
  // Get all active nodes for this root, ordered by depth DESC (deepest first)
  const active = db.prepare(
    `SELECT * FROM goal_tree
     WHERE (root_id = ? OR id = ?) AND status = 'active'
     ORDER BY depth DESC, sort_order, id`
  ).all(rootId, rootId) as GoalNode[];

  if (active.length === 0) return null;

  // Find deepest active leaf (no active children)
  for (const node of active) {
    const activeChildren = db.prepare(
      "SELECT COUNT(*) as c FROM goal_tree WHERE parent_id = ? AND status = 'active'"
    ).get(node.id) as { c: number };

    if (activeChildren.c === 0) {
      return node; // This is a leaf — it's the focus
    }
  }

  return active[0]; // Fallback: deepest active node
}

/**
 * Build a visual tree representation.
 */
function buildTreeView(db: any, nodeId: number, prefix = "", isLast = true, focusId?: number): string {
  const node = db.prepare("SELECT * FROM goal_tree WHERE id = ?").get(nodeId) as GoalNode | undefined;
  if (!node) return "";

  const strategies = getStrategies(node);
  const phase = node.peodc_phase as Phase;
  const phaseIcon = PHASE_ICONS[phase] || "❓";

  let statusIcon: string;
  switch (node.status) {
    case "active": statusIcon = node.id === focusId ? "👉" : "🔄"; break;
    case "completed": statusIcon = "✅"; break;
    case "failed": statusIcon = "❌"; break;
    case "blocked": statusIcon = "⏳"; break;
    default: statusIcon = "◻️";
  }

  const connector = prefix ? (isLast ? "└── " : "├── ") : "";
  const childPrefix = prefix ? prefix + (isLast ? "    " : "│   ") : "";

  let line = `${prefix}${connector}${statusIcon} #${node.id}: ${node.goal.slice(0, 55)}`;

  if (node.status === "active") {
    line += ` [${phaseIcon}${phase}]`;
    if (node.id === focusId) line += " ← FOCUS";
  }
  if (node.status === "completed" && node.result) {
    line += ` → ${node.result.slice(0, 40)}`;
  }
  if (node.status === "failed" && node.last_error) {
    line += ` (${node.last_error.slice(0, 30)})`;
  }

  // Show strategies for active nodes
  if (node.status === "active" && strategies.length > 0) {
    for (let i = 0; i < strategies.length; i++) {
      const marker = i < node.current_strategy ? "✗" : i === node.current_strategy ? "→" : "·";
      line += `\n${childPrefix}    ${marker} Strategy ${String.fromCharCode(65 + i)}: ${strategies[i].slice(0, 50)}`;
    }
  }

  const lines = [line];

  // Recurse into children
  const children = getChildren(db, node.id);
  for (let i = 0; i < children.length; i++) {
    lines.push(buildTreeView(db, children[i].id, childPrefix, i === children.length - 1, focusId));
  }

  return lines.join("\n");
}

/**
 * Check if all children of a parent are completed. If so, bubble up.
 */
function checkParentCompletion(db: any, parentId: number): void {
  const parent = db.prepare("SELECT * FROM goal_tree WHERE id = ?").get(parentId) as GoalNode | undefined;
  if (!parent || parent.status !== "active") return;

  const children = getChildren(db, parentId);
  if (children.length === 0) return;

  const allDone = children.every(c => c.status === "completed");
  const anyFailed = children.some(c => c.status === "failed");

  if (allDone) {
    // All children completed — advance parent's PEODC if it was in D (Direction)
    if (parent.peodc_phase === "D") {
      const results = children.map(c => `#${c.id}: ${(c.result || "done").slice(0, 50)}`).join("; ");
      db.prepare(
        `UPDATE goal_tree SET direct_output = ?, peodc_phase = 'C', updated_at = unixepoch() WHERE id = ?`
      ).run(`Sous-objectifs complétés: ${results}`, parentId);
      log.info(`[goal-tree] Parent #${parentId} auto-advanced to C (all children done)`);
    }
  } else if (anyFailed && children.every(c => c.status === "completed" || c.status === "failed")) {
    // Some failed, all resolved — try next strategy on parent
    const strategies = getStrategies(parent);
    if (parent.current_strategy < strategies.length - 1) {
      db.prepare(
        `UPDATE goal_tree SET current_strategy = current_strategy + 1, peodc_phase = 'P', attempts = attempts + 1, last_error = ?, updated_at = unixepoch() WHERE id = ?`
      ).run("Sub-goals partially failed", parentId);
      log.info(`[goal-tree] Parent #${parentId} trying next strategy (sub-goals partially failed)`);
    }
  }
}

// ── Skills ──

// ── goal.set ──
registerSkill({
  name: "goal.set",
  description:
    "Create a new goal in the goal tree. Can be a root goal or a sub-goal of an existing goal. " +
    "Each goal gets its own PEODC cycle and multi-strategy fallback.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      goal: { type: "string", description: "The goal description" },
      parent_id: { type: "number", description: "Parent goal ID (omit for root goal)" },
      strategies: { type: "string", description: "Comma-separated strategies: 'Plan A, Plan B, Plan C'" },
    },
    required: ["goal"],
  },
  async execute(args): Promise<string> {
    ensureTable();
    const db = getDb();
    const goal = String(args.goal);
    const parentId = args.parent_id ? Number(args.parent_id) : null;
    const strategies = args.strategies
      ? String(args.strategies).split(",").map(s => s.trim()).filter(Boolean)
      : [];

    let depth = 0;
    let rootId: number | null = null;
    let sortOrder = 0;

    if (parentId) {
      const parent = db.prepare("SELECT * FROM goal_tree WHERE id = ?").get(parentId) as GoalNode | undefined;
      if (!parent) return `Erreur: Parent #${parentId} introuvable.`;
      if (parent.status !== "active") return `Erreur: Parent #${parentId} n'est pas actif (${parent.status}).`;
      depth = parent.depth + 1;
      rootId = parent.root_id || parent.id;
      // Count existing siblings for sort order
      const siblingCount = (db.prepare(
        "SELECT COUNT(*) as c FROM goal_tree WHERE parent_id = ?"
      ).get(parentId) as { c: number }).c;
      sortOrder = siblingCount;
    }

    const info = db.prepare(
      `INSERT INTO goal_tree (parent_id, root_id, goal, depth, sort_order, strategies)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(parentId, rootId, goal, depth, sortOrder, JSON.stringify(strategies));

    const id = info.lastInsertRowid as number;

    // If root goal, set root_id to self
    if (!parentId) {
      db.prepare("UPDATE goal_tree SET root_id = ? WHERE id = ?").run(id, id);
    }

    log.info(`[goal-tree] Goal #${id} created: ${goal.slice(0, 60)} (depth=${depth}, parent=${parentId || "root"})`);

    // ROOT goal created → trigger Mind agent immediately + notify Nicolas
    if (!parentId) {
      notifyNicolas(`🎯 Nouveau goal créé: ${goal.slice(0, 80)}\nJe commence à travailler dessus maintenant.`);
      // Trigger Mind in 3 seconds (let current tool chain finish first)
      setTimeout(() => triggerMindNow(), 3000);
    }

    const strategyText = strategies.length > 0
      ? `\nStratégies: ${strategies.map((s, i) => `${String.fromCharCode(65 + i)}) ${s}`).join(", ")}`
      : "\n(Pas de stratégies définies — ajoute-en via la phase O)";

    return (
      `Goal #${id} créé${parentId ? ` (sous-goal de #${parentId})` : " (ROOT)"}.\n` +
      `🎯 ${goal}${strategyText}\n` +
      `Phase: P — Planification\n\n` +
      `--- INSTRUCTIONS ---\n` +
      `GOAL: ${goal}\n\n` +
      PHASE_INSTRUCTIONS.P
    );
  },
});

// ── goal.focus ──
registerSkill({
  name: "goal.focus",
  description:
    "Get the current focus node — the deepest active leaf in the goal tree. " +
    "This is what Kingston should work on RIGHT NOW. Returns the goal, its PEODC phase, " +
    "and instructions for the current phase.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      root_id: { type: "number", description: "Optional: specific root goal to focus on (default: most recent active root)" },
    },
  },
  async execute(args): Promise<string> {
    ensureTable();
    const db = getDb();

    let rootId: number;
    if (args.root_id) {
      rootId = Number(args.root_id);
    } else {
      // Find most recent active root
      const root = db.prepare(
        "SELECT id FROM goal_tree WHERE parent_id IS NULL AND status = 'active' ORDER BY updated_at DESC LIMIT 1"
      ).get() as { id: number } | undefined;

      if (!root) return "Aucun goal actif. Utilise goal.set(goal=...) pour en créer un.";
      rootId = root.id;
    }

    const focus = findFocus(db, rootId);
    if (!focus) return "Aucun noeud actif dans cet arbre. Le goal est peut-être complété ou échoué.";

    const phase = focus.peodc_phase as Phase;
    const strategies = getStrategies(focus);
    const currentStrat = strategies[focus.current_strategy];

    // Build breadcrumb: root → ... → current
    const breadcrumbs: string[] = [];
    let cursor: GoalNode | undefined = focus;
    while (cursor) {
      breadcrumbs.unshift(`#${cursor.id}: ${cursor.goal.slice(0, 40)}`);
      cursor = cursor.parent_id
        ? db.prepare("SELECT * FROM goal_tree WHERE id = ?").get(cursor.parent_id) as GoalNode | undefined
        : undefined;
    }

    // Build context from completed phases
    const phaseContext: string[] = [];
    if (focus.plan_output) phaseContext.push(`[P] ${focus.plan_output.slice(0, 200)}`);
    if (focus.explore_output) phaseContext.push(`[E] ${focus.explore_output.slice(0, 200)}`);
    if (focus.organize_output) phaseContext.push(`[O] ${focus.organize_output.slice(0, 200)}`);
    if (focus.direct_output) phaseContext.push(`[D] ${focus.direct_output.slice(0, 200)}`);

    const lines = [
      `🎯 FOCUS: Goal #${focus.id}`,
      `Chemin: ${breadcrumbs.join(" → ")}`,
      `Phase: ${PHASE_ICONS[phase]} ${PHASE_NAMES[phase]}`,
      `Tentatives: ${focus.attempts}/${focus.max_attempts}`,
    ];

    if (currentStrat) {
      lines.push(`Stratégie actuelle: ${String.fromCharCode(65 + focus.current_strategy)}) ${currentStrat}`);
    }
    if (focus.last_error) {
      lines.push(`Dernière erreur: ${focus.last_error.slice(0, 100)}`);
    }

    if (phaseContext.length > 0) {
      lines.push("", "--- PHASES PRÉCÉDENTES ---", ...phaseContext);
    }

    // Inject scratchpad if it exists
    const scratchRootId = focus.root_id || focus.id;
    try {
      const scratchFile = path.join(path.resolve("relay/goals"), `${scratchRootId}.md`);
      if (fs.existsSync(scratchFile)) {
        const scratch = fs.readFileSync(scratchFile, "utf-8").trim();
        if (scratch) {
          lines.push("", "--- SCRATCHPAD (mémoire de travail) ---", scratch.slice(0, 1500), "---");
        }
      }
    } catch { /* ignore */ }

    lines.push(
      "",
      "--- INSTRUCTIONS ---",
      `GOAL: ${focus.goal}`,
      currentStrat ? `STRATÉGIE: ${currentStrat}` : "",
      "",
      PHASE_INSTRUCTIONS[phase],
    );

    return lines.filter(Boolean).join("\n");
  },
});

// ── goal.advance ──
registerSkill({
  name: "goal.advance",
  description:
    "Advance a goal to the next PEODC phase. Saves the output of the current phase " +
    "and returns instructions for the next phase. P→E→O→D→C.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      id: { type: "number", description: "Goal ID to advance" },
      output: { type: "string", description: "Summary of what was accomplished in the current phase" },
    },
    required: ["id", "output"],
  },
  async execute(args): Promise<string> {
    ensureTable();
    const db = getDb();
    const goalId = Number(args.id);
    const output = String(args.output);

    const node = db.prepare("SELECT * FROM goal_tree WHERE id = ? AND status = 'active'").get(goalId) as GoalNode | undefined;
    if (!node) return `Erreur: Goal #${goalId} introuvable ou pas actif.`;

    const currentPhase = node.peodc_phase as Phase;
    const currentIdx = PHASES.indexOf(currentPhase);

    // Save current phase output
    const colMap: Record<Phase, string> = { P: "plan_output", E: "explore_output", O: "organize_output", D: "direct_output", C: "control_output" };
    db.prepare(
      `UPDATE goal_tree SET ${colMap[currentPhase]} = ?, updated_at = unixepoch() WHERE id = ?`
    ).run(output, goalId);

    // If at C (last phase) → goal should be completed via goal.complete
    if (currentIdx >= PHASES.length - 1) {
      return (
        `Phase C terminée pour goal #${goalId}.\n` +
        `Tu es à la fin du cycle PEODC.\n\n` +
        `→ Si le goal est RÉUSSI: goal.complete(id=${goalId}, result="...")\n` +
        `→ Si le goal a ÉCHOUÉ: goal.fail(id=${goalId}, reason="...")\n`
      );
    }

    // Advance to next phase
    const nextPhase = PHASES[currentIdx + 1];
    db.prepare(
      `UPDATE goal_tree SET peodc_phase = ?, updated_at = unixepoch() WHERE id = ?`
    ).run(nextPhase, goalId);

    log.info(`[goal-tree] Goal #${goalId} advanced: ${currentPhase} → ${nextPhase}`);

    // Notify Nicolas on phase transitions
    notifyNicolas(`📊 Goal #${goalId}: ${PHASE_NAMES[currentPhase]} → ${PHASE_NAMES[nextPhase as Phase]}\n${node.goal.slice(0, 60)}`);

    return (
      `Goal #${goalId}: ${PHASE_NAMES[currentPhase]} → ${PHASE_NAMES[nextPhase as Phase]}\n\n` +
      `--- INSTRUCTIONS ---\n` +
      `GOAL: ${node.goal}\n\n` +
      PHASE_INSTRUCTIONS[nextPhase as Phase]
    );
  },
});

// ── goal.complete ──
registerSkill({
  name: "goal.complete",
  description:
    "Mark a goal as completed with a result summary. If the goal has a parent, " +
    "checks if all sibling goals are done to auto-advance the parent.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      id: { type: "number", description: "Goal ID to complete" },
      result: { type: "string", description: "Summary of what was achieved" },
    },
    required: ["id", "result"],
  },
  async execute(args): Promise<string> {
    ensureTable();
    const db = getDb();
    const goalId = Number(args.id);
    const result = String(args.result);

    const node = db.prepare("SELECT * FROM goal_tree WHERE id = ?").get(goalId) as GoalNode | undefined;
    if (!node) return `Erreur: Goal #${goalId} introuvable.`;

    db.prepare(
      `UPDATE goal_tree SET status = 'completed', result = ?, updated_at = unixepoch() WHERE id = ?`
    ).run(result, goalId);

    log.info(`[goal-tree] Goal #${goalId} COMPLETED: ${result.slice(0, 80)}`);

    // Notify Nicolas
    notifyNicolas(`✅ Goal #${goalId} complété!\n${node.goal.slice(0, 60)}\n→ ${result.slice(0, 80)}`);

    // Check if parent can be auto-advanced
    if (node.parent_id) {
      checkParentCompletion(db, node.parent_id);
    }

    // Find next focus
    const rootId = node.root_id || node.id;
    const nextFocus = findFocus(db, rootId);

    let response = `✅ Goal #${goalId} complété: ${result.slice(0, 100)}\n`;

    if (nextFocus) {
      const phase = nextFocus.peodc_phase as Phase;
      response += `\n🎯 Prochain focus: #${nextFocus.id} — ${nextFocus.goal.slice(0, 50)} [${PHASE_ICONS[phase]}${phase}]\n`;
      response += `Utilise goal.focus() pour les instructions détaillées.`;
    } else {
      // Check if root is completed
      const root = db.prepare("SELECT * FROM goal_tree WHERE id = ?").get(rootId) as GoalNode | undefined;
      if (root && root.status === "active") {
        const children = getChildren(db, rootId);
        const allDone = children.length === 0 || children.every(c => c.status === "completed");
        if (allDone) {
          response += `\n🎉 TOUS les sous-objectifs sont complétés! Le ROOT goal #${rootId} peut être finalisé.\n`;
          response += `→ goal.complete(id=${rootId}, result="...") pour fermer le goal racine.`;
        }
      } else {
        response += `\n🎉 Arbre de goals entièrement complété!`;
      }
    }

    return response;
  },
});

// ── goal.fail ──
registerSkill({
  name: "goal.fail",
  description:
    "Mark the current strategy as failed and automatically try the next strategy. " +
    "If all strategies are exhausted, marks the goal as failed and notifies the parent. " +
    "NEVER GIVE UP — always try the next plan!",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      id: { type: "number", description: "Goal ID that failed" },
      reason: { type: "string", description: "Why this strategy failed" },
    },
    required: ["id", "reason"],
  },
  async execute(args): Promise<string> {
    ensureTable();
    const db = getDb();
    const goalId = Number(args.id);
    const reason = String(args.reason);

    const node = db.prepare("SELECT * FROM goal_tree WHERE id = ?").get(goalId) as GoalNode | undefined;
    if (!node) return `Erreur: Goal #${goalId} introuvable.`;

    const strategies = getStrategies(node);
    const nextStrategy = node.current_strategy + 1;

    if (nextStrategy < strategies.length) {
      // Try next strategy — reset PEODC to P
      db.prepare(
        `UPDATE goal_tree SET
          current_strategy = ?,
          peodc_phase = 'P',
          attempts = attempts + 1,
          last_error = ?,
          plan_output = NULL, explore_output = NULL, organize_output = NULL, direct_output = NULL, control_output = NULL,
          updated_at = unixepoch()
        WHERE id = ?`
      ).run(nextStrategy, reason, goalId);

      const nextName = strategies[nextStrategy];
      log.info(`[goal-tree] Goal #${goalId} strategy failed (${reason.slice(0, 50)}), trying: ${nextName}`);

      // Notify Nicolas of strategy change
      notifyNicolas(`🔄 Goal #${goalId}: Plan ${String.fromCharCode(65 + node.current_strategy)} échoué → Plan ${String.fromCharCode(65 + nextStrategy)}\n${node.goal.slice(0, 50)}\nRaison: ${reason.slice(0, 60)}`);

      return (
        `❌ Stratégie ${String.fromCharCode(65 + node.current_strategy)} échouée: ${reason.slice(0, 100)}\n\n` +
        `🔄 Passage au Plan ${String.fromCharCode(65 + nextStrategy)}: ${nextName}\n` +
        `Phase reset à P — Planification\n\n` +
        `--- INSTRUCTIONS ---\n` +
        `GOAL: ${node.goal}\n` +
        `NOUVELLE STRATÉGIE: ${nextName}\n\n` +
        PHASE_INSTRUCTIONS.P
      );
    }

    // All strategies exhausted
    db.prepare(
      `UPDATE goal_tree SET status = 'failed', last_error = ?, attempts = attempts + 1, updated_at = unixepoch() WHERE id = ?`
    ).run(`All strategies failed. Last: ${reason}`, goalId);

    log.info(`[goal-tree] Goal #${goalId} FAILED (all strategies exhausted): ${reason.slice(0, 50)}`);

    // Alert Nicolas — all strategies failed
    notifyNicolas(`❌ Goal #${goalId} ÉCHOUÉ — toutes les stratégies épuisées\n${node.goal.slice(0, 60)}\nDernière erreur: ${reason.slice(0, 80)}\n\nJ'ai besoin de ton aide.`);

    // Notify parent
    if (node.parent_id) {
      checkParentCompletion(db, node.parent_id);
    }

    // Check for siblings or parent fallback
    const rootId = node.root_id || node.id;
    const nextFocus = findFocus(db, rootId);

    let response =
      `❌ Goal #${goalId} ÉCHOUÉ — toutes les stratégies épuisées.\n` +
      `Dernière erreur: ${reason.slice(0, 100)}\n`;

    if (nextFocus) {
      response += `\n🎯 Prochain focus: #${nextFocus.id} — ${nextFocus.goal.slice(0, 50)}\n`;
      response += `Utilise goal.focus() pour continuer.`;
    } else {
      response += `\n💡 Aucun goal actif restant. Considère:\n`;
      response += `1. Créer de nouvelles stratégies pour les goals échoués\n`;
      response += `2. Reformuler le goal parent différemment\n`;
      response += `3. Escalader à Nicolas via mind.ask`;
    }

    return response;
  },
});

// ── goal.tree ──
registerSkill({
  name: "goal.tree",
  description:
    "Display the full goal tree with visual hierarchy, PEODC phases, strategies, and focus indicator. " +
    "Shows all root goals or a specific root goal's tree.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      root_id: { type: "number", description: "Optional: show tree for a specific root goal" },
      show_completed: { type: "string", description: "Show completed trees too? (yes/no, default: no)" },
    },
  },
  async execute(args): Promise<string> {
    ensureTable();
    const db = getDb();

    if (args.root_id) {
      const rootId = Number(args.root_id);
      const focus = findFocus(db, rootId);
      return `🌳 Goal Tree #${rootId}\n\n${buildTreeView(db, rootId, "", true, focus?.id)}`;
    }

    // List all root goals
    const showCompleted = String(args.show_completed || "no").toLowerCase() === "yes";
    const statusFilter = showCompleted ? "" : "AND status = 'active'";
    const roots = db.prepare(
      `SELECT * FROM goal_tree WHERE parent_id IS NULL ${statusFilter} ORDER BY updated_at DESC LIMIT 10`
    ).all() as GoalNode[];

    if (roots.length === 0) {
      return "Aucun goal actif. Utilise goal.set(goal=...) pour en créer un.";
    }

    const trees: string[] = [`🌳 Goal Trees (${roots.length} actif${roots.length > 1 ? "s" : ""})\n`];

    for (const root of roots) {
      const focus = findFocus(db, root.id);
      trees.push(buildTreeView(db, root.id, "", true, focus?.id));
      trees.push(""); // spacer
    }

    return trees.join("\n");
  },
});

// ── goal.decompose ──
registerSkill({
  name: "goal.decompose",
  description:
    "Manually decompose a goal into sub-goals with strategies. Creates child goals in the tree. " +
    "Use this in Phase O (Organisation) to structure the work.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      parent_id: { type: "number", description: "Parent goal to decompose" },
      subgoals: {
        type: "string",
        description: "JSON array of sub-goals: [{\"goal\":\"...\",\"strategies\":[\"Plan A\",\"Plan B\"]}]",
      },
    },
    required: ["parent_id", "subgoals"],
  },
  async execute(args): Promise<string> {
    ensureTable();
    const db = getDb();
    const parentId = Number(args.parent_id);

    const parent = db.prepare("SELECT * FROM goal_tree WHERE id = ?").get(parentId) as GoalNode | undefined;
    if (!parent) return `Erreur: Goal #${parentId} introuvable.`;

    let subgoals: Array<{ goal: string; strategies?: string[] }>;
    try {
      subgoals = JSON.parse(String(args.subgoals));
    } catch {
      return "Erreur: subgoals doit être un JSON array valide. Format: [{\"goal\":\"...\",\"strategies\":[\"A\",\"B\"]}]";
    }

    if (!Array.isArray(subgoals) || subgoals.length === 0) {
      return "Erreur: au moins un sous-goal requis.";
    }

    const rootId = parent.root_id || parent.id;
    const depth = parent.depth + 1;
    const created: number[] = [];

    for (let i = 0; i < subgoals.length; i++) {
      const sg = subgoals[i];
      const strategies = sg.strategies || [];
      const info = db.prepare(
        `INSERT INTO goal_tree (parent_id, root_id, goal, depth, sort_order, strategies)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(parentId, rootId, sg.goal, depth, i, JSON.stringify(strategies));
      created.push(info.lastInsertRowid as number);
    }

    log.info(`[goal-tree] Decomposed #${parentId} into ${created.length} sub-goals: ${created.join(", ")}`);

    const lines = [`Décomposé goal #${parentId} en ${created.length} sous-objectifs:\n`];
    for (let i = 0; i < subgoals.length; i++) {
      const sg = subgoals[i];
      lines.push(`  #${created[i]}: ${sg.goal}`);
      if (sg.strategies && sg.strategies.length > 0) {
        lines.push(`    Stratégies: ${sg.strategies.join(", ")}`);
      }
    }

    lines.push("", `Premier focus: #${created[0]} — utilise goal.focus() pour les instructions.`);

    return lines.join("\n");
  },
});

// ── goal.status ──
registerSkill({
  name: "goal.status",
  description:
    "Quick status overview of all goal trees — active count, focus nodes, progress percentage.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      id: { type: "number", description: "Optional: detailed status for a specific goal" },
    },
  },
  async execute(args): Promise<string> {
    ensureTable();
    const db = getDb();

    if (args.id) {
      const node = db.prepare("SELECT * FROM goal_tree WHERE id = ?").get(Number(args.id)) as GoalNode | undefined;
      if (!node) return `Goal #${args.id} introuvable.`;

      const strategies = getStrategies(node);
      const phase = node.peodc_phase as Phase;
      const children = getChildren(db, node.id);
      const completedChildren = children.filter(c => c.status === "completed").length;

      const lines = [
        `**Goal #${node.id}**: ${node.goal}`,
        `Status: ${node.status} | Phase: ${PHASE_ICONS[phase]} ${PHASE_NAMES[phase]}`,
        `Profondeur: ${node.depth} | Tentatives: ${node.attempts}/${node.max_attempts}`,
      ];

      if (strategies.length > 0) {
        lines.push(`Stratégie: ${String.fromCharCode(65 + node.current_strategy)}/${strategies.length} — ${strategies[node.current_strategy] || "N/A"}`);
      }
      if (children.length > 0) {
        lines.push(`Sous-goals: ${completedChildren}/${children.length} complétés`);
      }
      if (node.last_error) lines.push(`Dernière erreur: ${node.last_error.slice(0, 100)}`);
      if (node.result) lines.push(`Résultat: ${node.result.slice(0, 100)}`);

      // Show phase outputs
      if (node.plan_output) lines.push(`\n[P] ${node.plan_output.slice(0, 150)}`);
      if (node.explore_output) lines.push(`[E] ${node.explore_output.slice(0, 150)}`);
      if (node.organize_output) lines.push(`[O] ${node.organize_output.slice(0, 150)}`);
      if (node.direct_output) lines.push(`[D] ${node.direct_output.slice(0, 150)}`);
      if (node.control_output) lines.push(`[C] ${node.control_output.slice(0, 150)}`);

      return lines.join("\n");
    }

    // Overview
    const totalActive = (db.prepare("SELECT COUNT(*) as c FROM goal_tree WHERE status = 'active'").get() as { c: number }).c;
    const totalCompleted = (db.prepare("SELECT COUNT(*) as c FROM goal_tree WHERE status = 'completed'").get() as { c: number }).c;
    const totalFailed = (db.prepare("SELECT COUNT(*) as c FROM goal_tree WHERE status = 'failed'").get() as { c: number }).c;

    const roots = db.prepare(
      "SELECT * FROM goal_tree WHERE parent_id IS NULL AND status = 'active' ORDER BY updated_at DESC LIMIT 5"
    ).all() as GoalNode[];

    const lines = [
      `**Goal Trees**: ${totalActive} actifs, ${totalCompleted} complétés, ${totalFailed} échoués\n`,
    ];

    for (const root of roots) {
      const focus = findFocus(db, root.id);
      const descendants = db.prepare(
        "SELECT status, COUNT(*) as c FROM goal_tree WHERE root_id = ? OR id = ? GROUP BY status"
      ).all(root.id, root.id) as Array<{ status: string; c: number }>;

      const done = descendants.find(d => d.status === "completed")?.c || 0;
      const total = descendants.reduce((sum, d) => sum + d.c, 0);
      const pct = total > 0 ? Math.round(done / total * 100) : 0;

      lines.push(`🎯 #${root.id}: ${root.goal.slice(0, 50)} — ${pct}% (${done}/${total})`);
      if (focus) {
        lines.push(`   Focus: #${focus.id} ${focus.goal.slice(0, 40)} [${PHASE_ICONS[focus.peodc_phase as Phase]}${focus.peodc_phase}]`);
      }
    }

    if (roots.length === 0) {
      lines.push("Aucun goal actif. Utilise goal.set(goal=...) pour commencer.");
    }

    return lines.join("\n");
  },
});

// ── Goal Scratchpad ──
// Persistent working memory per goal — survives across cycles.
// Stored as files in relay/goals/<root_id>.md

const GOALS_DIR = path.resolve("relay/goals");

function ensureGoalsDir(): void {
  try { fs.mkdirSync(GOALS_DIR, { recursive: true }); } catch { /* exists */ }
}

function scratchPath(goalId: number): string {
  return path.join(GOALS_DIR, `${goalId}.md`);
}

function readScratch(goalId: number): string {
  try { return fs.readFileSync(scratchPath(goalId), "utf-8"); } catch { return ""; }
}

registerSkill({
  name: "goal.scratch",
  description:
    "Read or write the scratchpad for a goal. The scratchpad is a persistent working memory " +
    "that survives across cycles. Use it to save intermediate results, URLs found, API keys, " +
    "partial work, next steps — anything you need to remember between cycles.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      id: { type: "number", description: "Goal ID (uses root goal's scratchpad)" },
      action: { type: "string", description: "'read' to read, 'write' to overwrite, 'append' to add content" },
      content: { type: "string", description: "Content to write/append (required for write/append)" },
    },
    required: ["id", "action"],
  },
  async execute(args): Promise<string> {
    ensureGoalsDir();
    const goalId = Number(args.id);
    const action = String(args.action).toLowerCase();

    // Resolve to root goal's scratchpad
    ensureTable();
    const db = getDb();
    const node = db.prepare("SELECT * FROM goal_tree WHERE id = ?").get(goalId) as GoalNode | undefined;
    const rootId = node ? (node.root_id || node.id) : goalId;
    const filePath = scratchPath(rootId);

    if (action === "read") {
      const content = readScratch(rootId);
      return content || `(Scratchpad #${rootId} vide — utilise goal.scratch(id=${rootId}, action="write", content="...") pour écrire)`;
    }

    if (action === "write") {
      const content = String(args.content || "");
      fs.writeFileSync(filePath, content, "utf-8");
      log.info(`[goal-tree] Scratchpad #${rootId} written (${content.length} chars)`);
      return `Scratchpad #${rootId} sauvegardé (${content.length} chars).`;
    }

    if (action === "append") {
      const existing = readScratch(rootId);
      const newContent = String(args.content || "");
      const timestamp = new Date().toLocaleString("fr-CA", { timeZone: "America/Toronto" });
      const appended = existing + `\n\n--- ${timestamp} ---\n${newContent}`;
      fs.writeFileSync(filePath, appended, "utf-8");
      log.info(`[goal-tree] Scratchpad #${rootId} appended (${newContent.length} chars)`);
      return `Ajouté au scratchpad #${rootId} (${newContent.length} chars, total: ${appended.length}).`;
    }

    return `Action invalide: "${action}". Utilise "read", "write", ou "append".`;
  },
});

log.info(`[goal-tree] 9 goal tree skills registered (set, focus, advance, complete, fail, tree, decompose, status, scratch)`);
