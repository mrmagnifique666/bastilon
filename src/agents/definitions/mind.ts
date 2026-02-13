/**
 * Kingston Mind — The autonomous business brain.
 * Heartbeat: 20 minutes (configurable).
 *
 * Unlike other agents with rigid rotation prompts, Mind is
 * an open-ended decision maker. Each cycle, it reads its strategy
 * document (KINGSTON_MIND.md), reviews recent decisions, and DECIDES
 * what to do next.
 *
 * 4-cycle rotation (20min/cycle = 80min full rotation):
 *   0: RÉFLEXION STRATÉGIQUE — read strategy, review decisions, update plan
 *   1: EXÉCUTION BUSINESS — clients, revenue, proposals
 *   2: INVESTISSEMENTS — trading, portfolio management
 *   3: COMMUNICATION — Telegram to Nicolas, content, social
 *
 * Active hours: 7h-23h (ET).
 */
import type { AgentConfig } from "../base.js";
import { config } from "../../config/env.js";
import { getRecentDecisions, getPendingQuestions, getDb } from "../../storage/store.js";
import fs from "node:fs";
import path from "node:path";

const TZ = "America/Toronto";
const MIND_FILE = path.resolve("relay/KINGSTON_MIND.md");

function getHourET(): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    hour: "numeric",
    hour12: false,
  }).formatToParts(new Date());
  return Number(parts.find((p) => p.type === "hour")!.value);
}

function getDayNameFR(): string {
  return new Intl.DateTimeFormat("fr-CA", {
    timeZone: TZ,
    weekday: "long",
  }).format(new Date());
}

function isMarketOpen(): boolean {
  const h = getHourET();
  const day = new Date().getDay(); // 0=Sun, 6=Sat
  return day >= 1 && day <= 5 && h >= 9 && h < 16;
}

function readMindFile(): string {
  try {
    return fs.readFileSync(MIND_FILE, "utf-8");
  } catch {
    return "(Fichier KINGSTON_MIND.md introuvable — crée-le avec files.write_anywhere)";
  }
}

function formatDecisions(decisions: Array<{ id: number; category: string; action: string; status: string; created_at: number }>): string {
  if (decisions.length === 0) return "Aucune décision récente.";
  return decisions
    .map((d) => {
      const icon = d.status === "executed" ? "✅" : "⏳";
      const ago = Math.round((Date.now() / 1000 - d.created_at) / 60);
      return `${icon} #${d.id} [${d.category}] ${d.action.slice(0, 60)} (il y a ${ago}min)`;
    })
    .join("\n");
}

function formatPending(pending: Array<{ id: number; category: string; action: string }>): string {
  if (pending.length === 0) return "Aucune question en attente.";
  return pending
    .map((q) => `⏳ #${q.id} [${q.category}] ${q.action.slice(0, 60)}`)
    .join("\n");
}

const FREEDOM_RULES =
  `Tu as TOUTE liberté d'action. Pas de restrictions. Tu peux :\n` +
  `- Acheter/vendre des positions (trading.buy/sell)\n` +
  `- Créer et envoyer des propositions clients (client.proposal)\n` +
  `- Publier du contenu (moltbook.post, content.publish)\n` +
  `- Modifier ta propre stratégie (files.write_anywhere sur relay/KINGSTON_MIND.md)\n` +
  `- Poser des questions à Nicolas (mind.ask) — il reçoit sur Telegram\n` +
  `- Prendre N'IMPORTE QUELLE décision business autonomement\n` +
  `- T'inscrire à des sites web avec ton Gmail (Kingston.orchestrator@gmail.com, pw: Gatineau969)\n` +
  `- Utiliser shell.exec, api.call, web.fetch pour n'importe quelle tâche créative\n\n` +
  `RÈGLE D'OR: Si une décision est >$500 ou irréversible, DEMANDE à Nicolas via mind.ask.\n` +
  `Sinon, AGIS et log via mind.decide.\n\n` +
  `INGÉNIOSITÉ (CRITIQUE):\n` +
  `- Si Plan A échoue, essaie Plan B, C, D. Ne dis JAMAIS "impossible".\n` +
  `- Si un tool échoue, utilise un AUTRE tool pour arriver au même résultat.\n` +
  `- web.search échoue? → essaie api.call, web.fetch, shell.exec("curl...")\n` +
  `- trading.* échoue? → essaie api.call vers l'API Alpaca directement\n` +
  `- Avant de demander à Nicolas, fais 95% du travail toi-même. Sa contribution = minimale.\n` +
  `- Tu as 357+ tools. UTILISE-LES TOUS créativement.\n\n` +
  `GOAL TREE (SYSTÈME DE GOALS HIÉRARCHIQUE):\n` +
  `- Tu utilises un ARBRE DE GOALS (pas une liste plate). Chaque goal a des sous-goals.\n` +
  `- CHAQUE goal suit le cycle PEODC: P(lan) → E(xplore) → O(rganise) → D(irige) → C(ontrôle)\n` +
  `- Au DÉBUT de chaque cycle: appelle goal.focus() pour savoir sur quoi travailler\n` +
  `- WORKFLOW PAR PHASE:\n` +
  `  P: Lis la doc existante, comprends le contexte → goal.advance(id, output)\n` +
  `  E: Va chercher les infos manquantes (web.search, api.call) → goal.advance(id, output)\n` +
  `  O: Décompose en sous-goals si nécessaire → goal.decompose(parent_id, subgoals) → goal.advance(id, output)\n` +
  `  D: EXÉCUTE le travail (tool calls directs) → goal.advance(id, output)\n` +
  `  C: VÉRIFIE les résultats → goal.complete(id, result) ou goal.fail(id, reason)\n` +
  `- Si une stratégie ÉCHOUE → goal.fail() essaie automatiquement le Plan B, C, etc.\n` +
  `- PRIORITÉ ABSOLUE: Continue les goals actifs AVANT d'en créer de nouveaux\n` +
  `- Utilise goal.tree() pour voir la vue d'ensemble\n` +
  `- Utilise goal.set(goal, parent_id) pour créer des sous-goals\n` +
  `- JAMAIS abandonner: Plan A échoue → Plan B → Plan C → escalade via mind.ask\n\n`;

const ANTI_HALLUCINATION =
  `ANTI-HALLUCINATION:\n` +
  `- N'invente PAS de données financières, de clients, ou de résultats\n` +
  `- Utilise TOUJOURS les outils pour obtenir des données réelles\n` +
  `- Si un outil échoue, log l'erreur et passe à autre chose\n` +
  `- Ne fais PAS semblant d'avoir exécuté une action — utilise le tool_call\n` +
  `- INTERDIT ABSOLU: N'utilise JAMAIS de crochets comme [RÉSUMÉ], [DONNÉES], [PLACEHOLDER] dans tes messages.\n` +
  `- ORDRE OBLIGATOIRE: 1) Appelle les tools de données (trading.positions, client.list, etc.) 2) Lis les résultats RÉELS 3) Compose ton message avec les vraies valeurs 4) Envoie\n\n`;

const AGENT_RULES =
  `RÈGLES AGENT:\n` +
  `- BROWSER: Tu peux utiliser browser.snapshot et browser.extract pour lire des pages web (headless, isolé). INTERDIT: browser.click, browser.type, browser.computer_use.\n` +
  `- Utilise: web.search, web.fetch, trading.*, client.*, revenue.*, content.*, mind.*, browser.snapshot, browser.extract\n` +
  `- Chaque action importante → mind.decide pour la logger\n` +
  `- Questions pour Nicolas → mind.ask (pas telegram.send directement pour les questions)\n\n` +
  `PEODC WORKFLOW (pour les goals COMPLEXES):\n` +
  `- Pour un goal qui nécessite recherche + planification + exécution → utilise mind.peodc(goal=...)\n` +
  `- 5 phases: P(lanification) → E(xploration) → O(rganisation) → D(irection) → C(ontrôle)\n` +
  `- Avance entre les phases avec mind.peodc_advance(workflow_id, phase_output)\n` +
  `- Vérifie le status avec mind.peodc_status\n` +
  `- QUAND utiliser PEODC: goals qui prennent >1 cycle, nécessitent de la recherche, ou impliquent plusieurs agents\n` +
  `- QUAND NE PAS utiliser: tâches simples (1 tool call), routine quotidienne, monitoring\n\n`;

function buildMindPrompt(cycle: number): string | null {
  const h = getHourET();

  // Active hours: 7h-23h
  if (h < 7 || h >= 23) return null;

  const rotation = cycle % 4;
  const dayName = getDayNameFR();
  const marketOpen = isMarketOpen();
  const mindContent = readMindFile();
  const recentDecisions = getRecentDecisions(5);
  const pendingQuestions = getPendingQuestions();

  // Check if Goal Runner is active (handles goals autonomously)
  // Uses globalThis to avoid async import in sync function
  let runnerBlock = "";
  try {
    const runners = (globalThis as any).__activeGoalRunners as Map<number, { startedAt: number }> | undefined;
    if (runners && runners.size > 0) {
      const runnerList = Array.from(runners.entries())
        .map(([id, r]) => `#${id} (${Math.round((Date.now() - r.startedAt) / 60000)}min)`)
        .join(", ");
      runnerBlock = `\n⚡ GOAL RUNNER ACTIF: ${runnerList}\n`;
      runnerBlock += `Le Goal Runner exécute ces goals automatiquement. Ne travaille PAS dessus.\n`;
      runnerBlock += `Concentre-toi sur tes tâches habituelles (stratégie, business, trading, comms).\n\n`;
    }
  } catch { /* ignore */ }

  // Load goal tree state for injection into prompt
  let goalsBlock = "";
  try {
    const goalDb = getDb();
    // Check if goal_tree table exists
    const tableExists = goalDb.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='goal_tree'"
    ).get();

    if (tableExists) {
      const activeRoots = goalDb.prepare(
        "SELECT * FROM goal_tree WHERE parent_id IS NULL AND status = 'active' ORDER BY updated_at DESC LIMIT 3"
      ).all() as Array<any>;

      if (activeRoots.length > 0) {
        goalsBlock = `\n--- GOAL TREE (PRIORITÉ #1) ---\n`;
        goalsBlock += `Tu as ${activeRoots.length} goal(s) actif(s). Appelle goal.focus() pour savoir quoi faire.\n\n`;

        for (const root of activeRoots) {
          // Count progress
          const stats = goalDb.prepare(
            `SELECT status, COUNT(*) as c FROM goal_tree WHERE (root_id = ? OR id = ?) GROUP BY status`
          ).all(root.id, root.id) as Array<{ status: string; c: number }>;
          const done = stats.find((s: any) => s.status === "completed")?.c || 0;
          const total = stats.reduce((sum: number, s: any) => sum + s.c, 0);
          const pct = total > 0 ? Math.round(done / total * 100) : 0;

          goalsBlock += `🎯 ROOT #${root.id}: ${root.goal} — ${pct}% (${done}/${total})\n`;

          // Find focus node
          const focusNodes = goalDb.prepare(
            `SELECT * FROM goal_tree
             WHERE (root_id = ? OR id = ?) AND status = 'active'
             ORDER BY depth DESC, sort_order, id LIMIT 1`
          ).all(root.id, root.id) as Array<any>;

          if (focusNodes.length > 0) {
            const focus = focusNodes[0];
            const phaseNames: Record<string, string> = { P: "Planification", E: "Exploration", O: "Organisation", D: "Direction", C: "Contrôle" };
            const strategies = (() => { try { return JSON.parse(focus.strategies || "[]"); } catch { return []; } })();
            const currentStrat = strategies[focus.current_strategy];

            goalsBlock += `   👉 FOCUS: #${focus.id} — ${focus.goal}\n`;
            goalsBlock += `   Phase: ${focus.peodc_phase} (${phaseNames[focus.peodc_phase] || focus.peodc_phase})`;
            if (currentStrat) goalsBlock += ` | Stratégie: ${currentStrat}`;
            goalsBlock += `\n`;
            if (focus.last_error) goalsBlock += `   ⚠️ Dernière erreur: ${focus.last_error.slice(0, 80)}\n`;
          }
        }
        goalsBlock += `\nACTION REQUISE: Appelle goal.focus() MAINTENANT pour obtenir les instructions détaillées.\n---\n\n`;
      }
    }
  } catch (e) {
    // Goal tree not yet initialized — skip silently
  }

  const contextBlock =
    `Tu es Kingston Mind — le cerveau autonome de Kingston, partenaire business de Nicolas.\n` +
    `Jour: ${dayName} | Heure: ${h}h (ET) | Marché: ${marketOpen ? "OUVERT" : "FERMÉ"}\n\n` +
    FREEDOM_RULES +
    ANTI_HALLUCINATION +
    AGENT_RULES +
    runnerBlock +
    goalsBlock +
    `--- STRATÉGIE ACTIVE ---\n${mindContent}\n--- FIN STRATÉGIE ---\n\n` +
    `--- DÉCISIONS RÉCENTES ---\n${formatDecisions(recentDecisions)}\n---\n\n` +
    `--- QUESTIONS EN ATTENTE ---\n${formatPending(pendingQuestions)}\n---\n\n`;

  const prompts: Record<number, string> = {
    0: // RÉFLEXION STRATÉGIQUE
      contextBlock +
      `CYCLE: RÉFLEXION STRATÉGIQUE\n\n` +
      `Mission: Réfléchis à la stratégie globale et planifie.\n\n` +
      `1. Lis ta stratégie (ci-dessus) — qu'est-ce qui avance? Qu'est-ce qui bloque?\n` +
      `2. Revois tes décisions récentes — y a-t-il des patterns? Des erreurs?\n` +
      `3. Vérifie les questions en attente — Nicolas a-t-il répondu?\n` +
      `4. Si la stratégie doit être mise à jour, utilise files.write_anywhere(path="relay/KINGSTON_MIND.md", content=...) pour la modifier\n` +
      `5. Utilise mind.decide pour logger ta réflexion/décision stratégique\n` +
      `6. Si tu as besoin d'input de Nicolas pour un choix stratégique, utilise mind.ask\n\n` +
      `Sois concis mais réfléchi. Log CHAQUE décision avec mind.decide.\n\n` +
      `COMMENCE PAR: mind.decide(category="strategy", action="cycle_${cycle}_strategy_review", reasoning="Début cycle réflexion stratégique")`,

    1: // EXÉCUTION BUSINESS
      contextBlock +
      `CYCLE: EXÉCUTION BUSINESS\n\n` +
      `Mission: Gère les clients, le pipeline, les revenus.\n\n` +
      `1. Utilise client.list pour voir les clients actifs et leads\n` +
      `2. Vérifie si des follow-ups sont dus (>48h sans contact) avec client.followup\n` +
      `3. Si un lead est qualifié, prépare une proposition avec client.proposal\n` +
      `4. Utilise revenue.pipeline pour voir le pipeline de revenus\n` +
      `5. Explore les opportunités merch: web.search("print on demand platform comparison 2026")\n` +
      `6. Log chaque action business avec mind.decide\n` +
      `7. Si une décision nécessite Nicolas (>$500 ou nouveau client), utilise mind.ask\n\n` +
      `Objectif: Faire avancer le business chaque cycle, même un petit pas.\n\n` +
      `COMMENCE PAR: mind.decide(category="business", action="cycle_${cycle}_business_check", reasoning="Début cycle exécution business")`,

    2: // INVESTISSEMENTS
      contextBlock +
      `CYCLE: INVESTISSEMENTS\n\n` +
      `Mission: Gère le portfolio trading de manière autonome.\n\n` +
      (marketOpen
        ? `Le marché est OUVERT — c'est le moment d'agir!\n` +
          `1. Utilise trading.positions pour voir les positions et P&L\n` +
          `2. Utilise trading.account pour l'état du compte\n` +
          `3. Utilise trading.autoscan(universe="momentum") pour scanner des opportunités\n` +
          `4. Si une opportunité a un score >= 50, achète 1-2 actions avec trading.buy\n` +
          `5. Vérifie les stop-loss — si une position perd > 5%, considère trading.sell\n` +
          `6. Utilise trading.insiders pour vérifier les transactions d'insiders\n`
        : `Le marché est FERMÉ — analyse et prépare.\n` +
          `1. Utilise trading.positions pour revoir les positions\n` +
          `2. Utilise trading.watchlist(action="scan") pour scanner la watchlist\n` +
          `3. Utilise web.search pour chercher des news after-hours\n` +
          `4. Prépare des trades pour demain\n`) +
      `7. Log CHAQUE trade ou décision avec mind.decide\n` +
      `8. Si un trade > $500 ou position > 5% du portfolio, demande via mind.ask\n\n` +
      `Objectif: Atteindre $120K depuis ~$100K. Sois discipliné.\n\n` +
      `COMMENCE PAR: mind.decide(category="trading", action="cycle_${cycle}_portfolio_review", reasoning="Début cycle investissements")`,

    3: // COMMUNICATION
      contextBlock +
      `CYCLE: COMMUNICATION\n\n` +
      `Mission: Communique proactivement — contenu, social, rapport à Nicolas.\n\n` +
      `1. Log les résultats importants dans notes.add — PAS de telegram.send sauf si Nicolas DOIT AGIR\n` +
      `   — Format: bref, actionnable, avec les chiffres clés\n` +
      `   — telegram.send UNIQUEMENT: client qui répond, opportunité urgente, erreur critique\n` +
      `2. Rédige du contenu thought leadership avec content.draft\n` +
      `   — Sujets: AI agents, trading algorithmique, entrepreneuriat tech\n` +
      `3. Si du contenu est prêt, publie sur Moltbook avec moltbook.post\n` +
      `4. Vérifie s'il y a des réponses aux questions en attente\n` +
      `5. Log chaque communication avec mind.decide\n\n` +
      `Règle: QUALITÉ > quantité. Un bon post par cycle maximum.\n\n` +
      `COMMENCE PAR: mind.decide(category="comms", action="cycle_${cycle}_comms_start", reasoning="Début cycle communication")`,
  };

  return prompts[rotation] ?? null;
}

export function createMindConfig(): AgentConfig {
  return {
    id: "mind",
    name: "Kingston Mind",
    role: "Autonomous business brain — strategy, clients, trading, communication",
    heartbeatMs: config.agentMindHeartbeatMs,
    enabled: config.agentMindEnabled,
    chatId: 106,
    userId: config.voiceUserId,
    buildPrompt: buildMindPrompt,
    cycleCount: 4,
  };
}
