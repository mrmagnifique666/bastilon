/**
 * Goal Runner — Autonomous continuous execution engine.
 *
 * Unlike the Mind agent (reactive, 20min heartbeat), the Goal Runner is
 * a continuous agentic loop that:
 *   1. Takes a root goal
 *   2. Auto-decomposes it into sub-goals via LLM
 *   3. Executes each sub-goal through PEODC phases iteratively
 *   4. Sends progress updates to Nicolas via Telegram
 *   5. Only stops when done, stuck, or cancelled
 *
 * Architecture:
 *   - Dedicated chatId 107 (isolated from user and agents)
 *   - Uses handleMessage() through the admin queue (user messages take priority)
 *   - Ollama-first ($0) with Gemini/Groq fallback
 *   - Max 20 iterations per sub-goal, 10min timeout per sub-goal
 *   - Context summarized every 5 iterations to prevent overflow
 *   - Cancellable via stopGoalRunner()
 */
import { handleMessage } from "../orchestrator/router.js";
import { enqueueAdminAsync } from "../bot/chatLock.js";
import { getDb } from "../storage/store.js";
import { clearTurns, clearSession } from "../storage/store.js";
import { log } from "../utils/log.js";
import { getBotSendFn } from "../skills/builtin/telegram.js";
import { config } from "../config/env.js";
import { diagnoseFailure } from "../skills/builtin/ignorance.js";
import { logReflection, getRelevantReflections, getCrossTrialLearnings } from "../intelligence/reflexion.js";
import fs from "node:fs";
import path from "node:path";

// ── Constants ────────────────────────────────────────────────

const RUNNER_CHAT_ID = 107;
const MAX_ITERATIONS_PER_SUBGOAL = 20;
const SUBGOAL_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const STUCK_THRESHOLD = 3;
const DELAY_BETWEEN_ITERATIONS_MS = 2000;
const DELAY_BETWEEN_SUBGOALS_MS = 3000;
const SUMMARIZE_EVERY = 5;

const PHASE_NAMES: Record<string, string> = {
  P: "Planification", E: "Exploration", O: "Organisation", D: "Direction", C: "Contrôle",
};

// ── State ────────────────────────────────────────────────────

const activeRunners = new Map<number, { cancel: () => void; startedAt: number }>();
// Expose to globalThis for sync access from mind.ts and base.ts (avoids async import in sync functions)
(globalThis as any).__activeGoalRunners = activeRunners;

// ── Types ────────────────────────────────────────────────────

interface GoalNode {
  id: number;
  parent_id: number | null;
  root_id: number | null;
  goal: string;
  status: string;
  depth: number;
  sort_order: number;
  peodc_phase: string;
  strategies: string;
  current_strategy: number;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  result: string | null;
}

// ── Exports ──────────────────────────────────────────────────

/**
 * Start the Goal Runner for a root goal.
 * Runs in the background — returns immediately.
 */
export function startGoalRunner(rootGoalId: number): { success: boolean; message: string } {
  if (activeRunners.has(rootGoalId)) {
    return { success: false, message: `Goal Runner déjà actif pour goal #${rootGoalId}` };
  }

  const goal = getGoal(rootGoalId);
  if (!goal) return { success: false, message: `Goal #${rootGoalId} introuvable` };
  if (goal.status !== "active") return { success: false, message: `Goal #${rootGoalId} n'est pas actif (${goal.status})` };

  let cancelled = false;
  activeRunners.set(rootGoalId, {
    cancel: () => { cancelled = true; },
    startedAt: Date.now(),
  });

  // Launch in background — fire and forget
  runGoalLoop(rootGoalId, () => cancelled)
    .catch(err => {
      log.error(`[goal-runner] Fatal error for goal #${rootGoalId}: ${err}`);
      notify(`❌ Goal Runner crash pour #${rootGoalId}: ${err instanceof Error ? err.message : String(err)}`);
      diagnoseFailure({
        what_failed: `Goal Runner crash — goal #${rootGoalId}`,
        error_message: err instanceof Error ? err.message : String(err),
        context: `Goal Runner fatal error during execution of root goal #${rootGoalId}`,
        source: "goal-runner",
      });
    })
    .finally(() => {
      activeRunners.delete(rootGoalId);
      log.info(`[goal-runner] Runner stopped for goal #${rootGoalId}`);
    });

  log.info(`[goal-runner] Started for goal #${rootGoalId}: ${goal.goal.slice(0, 60)}`);
  return { success: true, message: `Goal Runner démarré pour #${rootGoalId}` };
}

/** Stop the Goal Runner for a specific goal. */
export function stopGoalRunner(goalId: number): boolean {
  const runner = activeRunners.get(goalId);
  if (!runner) return false;
  runner.cancel();
  activeRunners.delete(goalId);
  log.info(`[goal-runner] Cancelled for goal #${goalId}`);
  return true;
}

/** Check if any runner is currently active. */
export function isAnyRunnerActive(): boolean {
  return activeRunners.size > 0;
}

/** Get all active goal runners. */
export function getActiveRunners(): Array<{ goalId: number; startedAt: number; elapsed: string }> {
  return Array.from(activeRunners.entries()).map(([goalId, r]) => ({
    goalId,
    startedAt: r.startedAt,
    elapsed: `${Math.round((Date.now() - r.startedAt) / 60000)}min`,
  }));
}

// ── Helpers ──────────────────────────────────────────────────

function notify(message: string): void {
  // DÉSACTIVÉ — notifications consolidées dans briefings (7h/12h/20h)
  // Les updates importants sont loggés dans notes.add
  log.info(`[goal-runner] (silent notification) ${message.slice(0, 100)}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getGoal(id: number): GoalNode | null {
  try {
    return getDb().prepare("SELECT * FROM goal_tree WHERE id = ?").get(id) as GoalNode | undefined ?? null;
  } catch { return null; }
}

function getActiveChildren(parentId: number): GoalNode[] {
  try {
    return getDb().prepare(
      "SELECT * FROM goal_tree WHERE parent_id = ? AND status = 'active' ORDER BY sort_order, id"
    ).all(parentId) as GoalNode[];
  } catch { return []; }
}

function findFocusNode(rootId: number): GoalNode | null {
  try {
    const db = getDb();
    const active = db.prepare(
      `SELECT * FROM goal_tree
       WHERE (root_id = ? OR id = ?) AND status = 'active'
       ORDER BY depth DESC, sort_order, id`
    ).all(rootId, rootId) as GoalNode[];

    for (const node of active) {
      const children = db.prepare(
        "SELECT COUNT(*) as c FROM goal_tree WHERE parent_id = ? AND status = 'active'"
      ).get(node.id) as { c: number };
      if (children.c === 0) return node; // Leaf node — this is the focus
    }
    return active[0] ?? null;
  } catch { return null; }
}

function buildQuickTree(rootId: number): string {
  try {
    const db = getDb();
    const nodes = db.prepare(
      "SELECT * FROM goal_tree WHERE root_id = ? OR id = ? ORDER BY depth, sort_order, id"
    ).all(rootId, rootId) as GoalNode[];

    return nodes.map(n => {
      const indent = "  ".repeat(n.depth);
      const icon = n.status === "completed" ? "✅" : n.status === "failed" ? "❌" : "🔄";
      const phaseTag = n.status === "active" ? ` [${n.peodc_phase}]` : "";
      return `${indent}${icon} #${n.id}: ${n.goal.slice(0, 50)}${phaseTag}`;
    }).join("\n");
  } catch { return "(erreur)"; }
}

function getProgress(rootId: number): { done: number; total: number; pct: number } {
  try {
    const db = getDb();
    const stats = db.prepare(
      "SELECT status, COUNT(*) as c FROM goal_tree WHERE root_id = ? OR id = ? GROUP BY status"
    ).all(rootId, rootId) as Array<{ status: string; c: number }>;
    const done = stats.find(s => s.status === "completed")?.c ?? 0;
    const total = stats.reduce((sum, s) => sum + s.c, 0);
    return { done, total, pct: total > 0 ? Math.round(done / total * 100) : 0 };
  } catch { return { done: 0, total: 0, pct: 0 }; }
}

function readScratchpad(rootId: number): string {
  try {
    const scratchFile = path.resolve(`relay/goals/${rootId}.md`);
    if (fs.existsSync(scratchFile)) {
      return fs.readFileSync(scratchFile, "utf-8").trim().slice(0, 1500);
    }
  } catch { /* ignore */ }
  return "";
}

function getStrategies(node: GoalNode): string[] {
  try { return JSON.parse(node.strategies || "[]"); } catch { return []; }
}

// ── Prompt Builder ───────────────────────────────────────────

function buildIterationPrompt(
  focus: GoalNode,
  rootGoal: GoalNode,
  iteration: number,
  iterationContext: string,
): string {
  const strategies = getStrategies(focus);
  const currentStrat = strategies[focus.current_strategy] || "";
  const scratchpad = readScratchpad(rootGoal.id);

  const lines = [
    `[GOAL-RUNNER] Itération ${iteration}/${MAX_ITERATIONS_PER_SUBGOAL}`,
    ``,
    `Tu es Kingston, l'IA autonome de Nicolas. Tu exécutes un goal via le Goal Runner.`,
    `EXÉCUTE le travail toi-même en utilisant tes outils. Ne fais pas que planifier.`,
    ``,
    `═══ ROOT GOAL ═══`,
    `#${rootGoal.id}: ${rootGoal.goal}`,
    ``,
    `═══ FOCUS ACTUEL ═══`,
    `Goal #${focus.id}: ${focus.goal}`,
    `Phase: ${focus.peodc_phase} — ${PHASE_NAMES[focus.peodc_phase] || "?"}`,
  ];

  if (currentStrat) lines.push(`Stratégie: ${currentStrat}`);
  lines.push(`Tentatives: ${focus.attempts}/${focus.max_attempts}`);
  if (focus.last_error) lines.push(`Dernière erreur: ${focus.last_error.slice(0, 150)}`);

  // Previous context
  if (iterationContext) {
    lines.push(``, `═══ CONTEXTE PRÉCÉDENT ═══`, iterationContext.slice(-800));
  }

  // Scratchpad
  if (scratchpad) {
    lines.push(``, `═══ SCRATCHPAD ═══`, scratchpad);
  }

  // Inject reflexion context (past learnings)
  const reflexions = getRelevantReflections(focus.goal);
  if (reflexions) lines.push(reflexions);

  // Inject cross-trial learnings (past failures on similar goals)
  const crossTrial = getCrossTrialLearnings(focus.goal);
  if (crossTrial) lines.push(crossTrial);

  // Phase instructions
  lines.push(``, `═══ INSTRUCTIONS PHASE ${focus.peodc_phase} ═══`);

  switch (focus.peodc_phase) {
    case "P":
      lines.push(
        `1. Lis la documentation existante (files.read_anywhere, notes.list, memory.recall)`,
        `2. Comprends le contexte et identifie ce qu'on SAIT vs NE SAIT PAS`,
        `3. Quand tu as un plan clair → goal.advance(id=${focus.id}, output="résumé du plan")`,
      );
      break;
    case "E":
      lines.push(
        `1. Cherche TOUTES les infos manquantes (web.search, web.fetch, api.call)`,
        `2. Reformule si aucun résultat. Essaie 2-3 variations.`,
        `3. Quand tu as les infos → goal.advance(id=${focus.id}, output="infos trouvées")`,
      );
      break;
    case "O":
      lines.push(
        `1. Si ce goal nécessite plusieurs étapes → goal.decompose(parent_id=${focus.id}, subgoals=[...])`,
        `2. Définis les stratégies (Plan A, B, C) pour chaque sous-objectif`,
        `3. Quand organisé → goal.advance(id=${focus.id}, output="plan organisé")`,
      );
      break;
    case "D":
      lines.push(
        `1. EXÉCUTE le plan MAINTENANT avec des tool calls directs`,
        `2. Si Plan A échoue → essaie Plan B immédiatement`,
        `3. Utilise TOUS les outils: web.search, api.call, shell.exec, etc.`,
        `4. Quand exécuté → goal.advance(id=${focus.id}, output="résultats de l'exécution")`,
      );
      break;
    case "C":
      lines.push(
        `1. VÉRIFIE que les résultats sont RÉELS (pas hallucination)`,
        `2. Teste via tool calls (api.call, web.fetch, vérifications concrètes)`,
        `3. Si OK → goal.complete(id=${focus.id}, result="résultat final")`,
        `4. Si PAS OK → goal.fail(id=${focus.id}, reason="pourquoi ça a échoué")`,
      );
      break;
  }

  lines.push(
    ``,
    `═══ RÈGLES ═══`,
    `- EXÉCUTE avec des tool_calls. Ne dis pas "je vais faire X" — FAIS X.`,
    `- Quand une phase est finie, appelle goal.advance() ou goal.complete()/goal.fail()`,
    `- Sauvegarde tes découvertes: goal.scratch(id=${focus.id}, action="append", content="...")`,
    `- SILENCIEUX: Pas de telegram.send automatique — seulement via notes.add`,
    `- Si Plan A échoue, goal.fail() essaie automatiquement Plan B`,
  );

  return lines.join("\n");
}

// ── Main Loop ────────────────────────────────────────────────

async function runGoalLoop(rootGoalId: number, isCancelled: () => boolean): Promise<void> {
  log.info(`[goal-runner] === Starting loop for root goal #${rootGoalId} ===`);

  // Phase 1: Auto-decompose the root goal into sub-goals
  await autoDecompose(rootGoalId, isCancelled);
  if (isCancelled()) return;

  // Phase 2: Execute sub-goals depth-first via agentic loop
  let stuckCount = 0;
  let lastFocusId = -1;
  let lastFocusPhase = "";

  while (!isCancelled()) {
    const rootGoal = getGoal(rootGoalId);
    if (!rootGoal || rootGoal.status !== "active") {
      log.info(`[goal-runner] Root goal #${rootGoalId} is ${rootGoal?.status || "gone"} — done`);
      break;
    }

    // Find current focus (deepest active leaf)
    const focus = findFocusNode(rootGoalId);
    if (!focus) {
      // No active nodes left
      const { done, total, pct } = getProgress(rootGoalId);
      log.info(`[goal-runner] No active focus — ${pct}% (${done}/${total})`);

      if (done >= total && total > 1) {
        // All sub-goals done — complete root
        getDb().prepare(
          "UPDATE goal_tree SET status = 'completed', result = ?, updated_at = unixepoch() WHERE id = ? AND status = 'active'"
        ).run("Tous les sous-objectifs complétés automatiquement", rootGoalId);
        notify(`🎉 Goal #${rootGoalId} TERMINÉ!\n${rootGoal.goal}\n\n${buildQuickTree(rootGoalId)}`);
      }
      break;
    }

    // Reset stuck counter when focus changes
    if (focus.id !== lastFocusId || focus.peodc_phase !== lastFocusPhase) {
      stuckCount = 0;
      lastFocusId = focus.id;
      lastFocusPhase = focus.peodc_phase;
    }

    log.info(`[goal-runner] Focus: #${focus.id} [${focus.peodc_phase}] — ${focus.goal.slice(0, 50)}`);

    // Execute one batch of iterations on the current focus
    await executeSubGoal(focus, rootGoalId, isCancelled);
    if (isCancelled()) break;

    // Check if progress was made
    const updated = getGoal(focus.id);
    if (updated && updated.status === "active" && updated.peodc_phase === focus.peodc_phase) {
      stuckCount++;
      log.warn(`[goal-runner] Focus #${focus.id} didn't progress (stuck ${stuckCount}/${STUCK_THRESHOLD})`);

      if (stuckCount >= STUCK_THRESHOLD) {
        // Log reflexion for this failure
        logReflection({
          goalId: focus.id,
          task: focus.goal,
          outcome: "Bloqué — aucun progrès après plusieurs tentatives",
          error: focus.last_error || undefined,
          strategy: getStrategies(focus)[focus.current_strategy] || undefined,
        });

        // Force-fail to trigger next strategy
        notify(`⚠️ Goal #${focus.id} bloqué après ${STUCK_THRESHOLD} tentatives\n${focus.goal.slice(0, 60)}`);

        // Log ignorance: WHY is this goal stuck?
        diagnoseFailure({
          what_failed: `Goal #${focus.id}: ${focus.goal.slice(0, 80)}`,
          error_message: `Bloqué après ${STUCK_THRESHOLD} tentatives en phase ${focus.peodc_phase}. Aucun progrès détecté.${focus.last_error ? ` Dernière erreur: ${focus.last_error}` : ""}`,
          context: `Goal Runner, sous-objectif #${focus.id}, stratégie en cours, phase PEODC: ${focus.peodc_phase}`,
          source: "goal-runner",
        });

        clearTurns(RUNNER_CHAT_ID);
        clearSession(RUNNER_CHAT_ID);
        try {
          await enqueueAdminAsync(() => handleMessage(
            RUNNER_CHAT_ID,
            `[GOAL-RUNNER] Goal #${focus.id} est bloqué. Appelle goal.fail(id=${focus.id}, reason="Bloqué après ${STUCK_THRESHOLD} tentatives sans progrès") MAINTENANT.`,
            getUserId(),
            "scheduler"
          ));
        } catch (err) {
          log.warn(`[goal-runner] Forced fail failed: ${err}`);
          // Last resort: fail directly in DB
          try {
            getDb().prepare(
              `UPDATE goal_tree SET status = 'failed', last_error = ?, updated_at = unixepoch() WHERE id = ?`
            ).run(`Bloqué après ${STUCK_THRESHOLD} tentatives`, focus.id);
          } catch { /* ignore */ }
        }
        stuckCount = 0;
      }
    }

    await sleep(DELAY_BETWEEN_SUBGOALS_MS);
  }

  // Final report
  if (!isCancelled()) {
    const rootGoal = getGoal(rootGoalId);
    const { pct } = getProgress(rootGoalId);
    if (rootGoal?.status === "completed") {
      notify(`✅ Goal Runner terminé: #${rootGoalId}\n${rootGoal.goal}\n${pct}% complété\n\n${buildQuickTree(rootGoalId)}`);
    } else if (rootGoal?.status !== "completed") {
      // Log reflexion for incomplete goal
      logReflection({
        goalId: rootGoalId,
        task: rootGoal?.goal || "unknown",
        outcome: `Goal Runner arrêté — ${getProgress(rootGoalId).pct}% complété`,
        error: rootGoal?.last_error || "Arrêté avant complétion",
      });
      notify(`📊 Goal Runner arrêté: #${rootGoalId}\n${pct}% complété\n\n${buildQuickTree(rootGoalId)}`);
    }
  } else {
    notify(`⏹️ Goal Runner annulé pour #${rootGoalId}`);
  }

  log.info(`[goal-runner] === Loop ended for #${rootGoalId} ===`);
}

// ── Auto-Decompose ───────────────────────────────────────────

async function autoDecompose(rootGoalId: number, isCancelled: () => boolean): Promise<void> {
  const goal = getGoal(rootGoalId);
  if (!goal) return;

  // Skip if already has children
  const existing = getActiveChildren(rootGoalId);
  if (existing.length > 0) {
    log.info(`[goal-runner] Goal #${rootGoalId} already has ${existing.length} sub-goals`);
    return;
  }

  log.info(`[goal-runner] Auto-decomposing goal #${rootGoalId}: ${goal.goal.slice(0, 60)}`);
  notify(`🔍 Décomposition du goal: ${goal.goal.slice(0, 80)}...`);

  clearTurns(RUNNER_CHAT_ID);
  clearSession(RUNNER_CHAT_ID);

  const prompt = [
    `[GOAL-RUNNER] Décomposition automatique`,
    ``,
    `Tu es Kingston. Décompose ce goal en sous-objectifs CONCRETS et ACTIONNABLES.`,
    ``,
    `GOAL: ${goal.goal}`,
    ``,
    `INSTRUCTIONS:`,
    `1. Analyse le goal et identifie 2-5 sous-objectifs nécessaires`,
    `2. Pour chaque sous-objectif, définis 2-3 stratégies alternatives`,
    `3. Appelle goal.decompose(parent_id=${rootGoalId}, subgoals=[...])`,
    `4. Appelle goal.tree(root_id=${rootGoalId}) pour voir l'arbre`,
    `5. Envoie l'arbre à Nicolas via telegram.send`,
    ``,
    `FORMAT pour goal.decompose:`,
    `subgoals=[{"goal":"Description concrète","strategies":["Plan A: ...", "Plan B: ..."]}]`,
    ``,
    `EXEMPLES de BONS sous-goals: "S'inscrire sur Shopify", "Créer un design de t-shirt"`,
    `EXEMPLES de MAUVAIS sous-goals: "Faire de la recherche", "Planifier"`,
  ].join("\n");

  try {
    await enqueueAdminAsync(() => handleMessage(RUNNER_CHAT_ID, prompt, getUserId(), "scheduler"));

    await sleep(1000);

    // Verify decomposition happened
    const children = getActiveChildren(rootGoalId);
    if (children.length === 0 && !isCancelled()) {
      log.warn(`[goal-runner] Decompose didn't create sub-goals — retrying`);
      clearTurns(RUNNER_CHAT_ID);
      clearSession(RUNNER_CHAT_ID);

      await enqueueAdminAsync(() => handleMessage(
        RUNNER_CHAT_ID,
        `[GOAL-RUNNER] Tu DOIS décomposer ce goal MAINTENANT.\n` +
        `Goal: ${goal.goal}\n\n` +
        `Appelle goal.decompose(parent_id=${rootGoalId}, subgoals=[{"goal":"premier sous-objectif","strategies":["Plan A","Plan B"]}]) IMMÉDIATEMENT.`,
        getUserId(),
        "scheduler"
      ));
    }

    // Report to Nicolas
    const finalChildren = getActiveChildren(rootGoalId);
    if (finalChildren.length > 0) {
      const tree = buildQuickTree(rootGoalId);
      notify(`🌳 Goal décomposé (${finalChildren.length} sous-objectifs):\n\n${tree}\n\nExécution autonome lancée...`);

      // Advance root to D phase (sub-goals organized)
      getDb().prepare(
        "UPDATE goal_tree SET peodc_phase = 'D', organize_output = ?, updated_at = unixepoch() WHERE id = ?"
      ).run(`Décomposé en ${finalChildren.length} sous-objectifs`, rootGoalId);
    } else {
      // No decomposition — the goal might be simple enough to execute directly
      log.info(`[goal-runner] No sub-goals created — executing root directly`);
    }
  } catch (err) {
    log.error(`[goal-runner] Auto-decompose error: ${err}`);
  }
}

// ── Sub-Goal Execution ───────────────────────────────────────

async function executeSubGoal(
  initialFocus: GoalNode,
  rootGoalId: number,
  isCancelled: () => boolean,
): Promise<void> {
  const startTime = Date.now();
  let iterationContext = "";

  for (let iteration = 1; iteration <= MAX_ITERATIONS_PER_SUBGOAL; iteration++) {
    if (isCancelled()) return;

    // Timeout check
    if (Date.now() - startTime > SUBGOAL_TIMEOUT_MS) {
      log.warn(`[goal-runner] Sub-goal #${initialFocus.id} timed out`);
      notify(`⏰ Timeout: Goal #${initialFocus.id} (${Math.round((Date.now() - startTime) / 60000)}min)`);
      break;
    }

    // Re-fetch goal state
    const focus = getGoal(initialFocus.id);
    if (!focus || focus.status !== "active") {
      log.info(`[goal-runner] Sub-goal #${initialFocus.id} → ${focus?.status || "gone"}`);
      return; // Goal was completed or failed
    }

    // Check if this goal now has active children (was decomposed)
    const children = getActiveChildren(focus.id);
    if (children.length > 0) {
      log.info(`[goal-runner] Sub-goal #${focus.id} was decomposed into ${children.length} children — handing off`);
      return; // Let outer loop find the child focus
    }

    // Summarize context periodically
    if (iteration > 1 && (iteration - 1) % SUMMARIZE_EVERY === 0 && iterationContext.length > 800) {
      iterationContext = `[Résumé itérations 1-${iteration - 1}]: ${iterationContext.slice(-500)}`;
    }

    // Build and send prompt
    const rootGoal = getGoal(rootGoalId) || initialFocus;
    const prompt = buildIterationPrompt(focus, rootGoal, iteration, iterationContext);

    clearTurns(RUNNER_CHAT_ID);
    clearSession(RUNNER_CHAT_ID);

    log.info(`[goal-runner] Iter ${iteration}/${MAX_ITERATIONS_PER_SUBGOAL} for #${focus.id} [${focus.peodc_phase}]`);

    try {
      const result = await enqueueAdminAsync(() =>
        handleMessage(RUNNER_CHAT_ID, prompt, getUserId(), "scheduler")
      );

      // Accumulate context
      if (result) {
        const summary = result.length > 300 ? result.slice(0, 300) + "..." : result;
        iterationContext += `\n[Iter ${iteration} — ${focus.peodc_phase}]: ${summary}`;
      }

      // Check if phase changed (progress made) — early exit from iteration loop
      const afterIter = getGoal(initialFocus.id);
      if (!afterIter || afterIter.status !== "active") {
        log.info(`[goal-runner] Goal #${initialFocus.id} resolved during iteration ${iteration}`);
        return;
      }
      if (afterIter.peodc_phase !== focus.peodc_phase) {
        log.info(`[goal-runner] Phase change: ${focus.peodc_phase} → ${afterIter.peodc_phase} — continuing`);
        // Continue to next iteration with updated state
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`[goal-runner] Iteration ${iteration} error: ${msg}`);
      iterationContext += `\n[Iter ${iteration} ERROR]: ${msg.slice(0, 200)}`;
    }

    await sleep(DELAY_BETWEEN_ITERATIONS_MS);
  }
}

// ── Utility ──────────────────────────────────────────────────

function getUserId(): number {
  return config.voiceUserId || 0;
}

log.info(`[goal-runner] Module loaded — chatId ${RUNNER_CHAT_ID}`);
