/**
 * PEODC Autonomous Workflow Framework
 *
 * A structured 5-phase methodology for Kingston Mind to execute complex goals:
 *   P — Planification: Read all existing documentation, understand the context
 *   E — Exploration: Find all missing information, research unknowns
 *   O — Organisation: Structure the work into actionable steps
 *   D — Direction: Execute the work, delegate to agents
 *   C — Contrôle: Verify results, measure success
 *
 * Skills: mind.peodc, mind.peodc_status, mind.peodc_advance
 */
import { registerSkill } from "../loader.js";
import { getDb } from "../../storage/store.js";
import { log } from "../../utils/log.js";

// --- DB setup ---

function ensureTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS peodc_workflows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      goal TEXT NOT NULL,
      phase TEXT NOT NULL DEFAULT 'planification',
      status TEXT NOT NULL DEFAULT 'active',
      plan_output TEXT,
      explore_output TEXT,
      organize_output TEXT,
      direct_output TEXT,
      control_output TEXT,
      delegated_agents TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      completed_at INTEGER
    )
  `);
}

const PHASES = ["planification", "exploration", "organisation", "direction", "controle"] as const;
type Phase = typeof PHASES[number];

const PHASE_LABELS: Record<Phase, string> = {
  planification: "P — Planification",
  exploration: "E — Exploration",
  organisation: "O — Organisation",
  direction: "D — Direction",
  controle: "C — Contrôle",
};

const PHASE_PROMPTS: Record<Phase, string> = {
  planification:
    `PHASE P — PLANIFICATION (Comprendre le contexte)\n\n` +
    `OBJECTIF: Lire TOUTE la documentation existante et comprendre le terrain.\n\n` +
    `ACTIONS REQUISES:\n` +
    `1. files.read_anywhere — Lis les fichiers pertinents au goal (code source, docs, configs)\n` +
    `2. notes.list — Cherche les notes existantes sur le sujet\n` +
    `3. memory.recall — Cherche en mémoire sémantique\n` +
    `4. kg.search — Cherche dans le knowledge graph\n` +
    `5. episodic.search — Cherche les événements passés liés\n\n` +
    `OUTPUT ATTENDU:\n` +
    `- Ce qu'on SAIT déjà (faits, données, code existant)\n` +
    `- Ce qu'on NE SAIT PAS (questions ouvertes, zones d'ombre)\n` +
    `- Les CONTRAINTES identifiées (limites techniques, budget, temps)\n` +
    `- Les RESSOURCES disponibles (tools, APIs, agents)\n\n` +
    `Sauvegarde ton analyse avec notes.add(title="PEODC Plan: [goal]")`,

  exploration:
    `PHASE E — EXPLORATION (Trouver l'information manquante)\n\n` +
    `OBJECTIF: Aller chercher TOUTES les informations manquantes identifiées en phase P.\n\n` +
    `ACTIONS REQUISES:\n` +
    `1. web.search — Recherche web pour chaque question ouverte\n` +
    `2. web.fetch — Lire les pages pertinentes trouvées\n` +
    `3. api.call — Tester les APIs si besoin\n` +
    `4. trading.* / moltbook.* — Récupérer les données live si pertinent\n` +
    `5. shell.exec — Vérifier l'état du système si nécessaire\n\n` +
    `RÈGLES D'EXPLORATION:\n` +
    `- Pour chaque "inconnue" de phase P, essaie AU MOINS 2 approches\n` +
    `- Si web.search donne rien, reformule la requête\n` +
    `- Si une API est nécessaire mais indisponible, note-le comme blocage\n` +
    `- Documente TOUT ce que tu trouves, même si ça semble mineur\n\n` +
    `OUTPUT ATTENDU:\n` +
    `- Réponses aux questions ouvertes de phase P\n` +
    `- Nouvelles données découvertes\n` +
    `- Blocages identifiés (ce qu'on ne PEUT PAS trouver)\n\n` +
    `Sauvegarde avec notes.add(title="PEODC Explore: [goal]")`,

  organisation:
    `PHASE O — ORGANISATION (Structurer le travail)\n\n` +
    `OBJECTIF: Basé sur P (contexte) + E (données), créer un PLAN d'action concret.\n\n` +
    `ACTIONS REQUISES:\n` +
    `1. Synthétiser les données de P et E\n` +
    `2. Décomposer le goal en TÂCHES ATOMIQUES (max 30min chacune)\n` +
    `3. Pour chaque tâche: qui l'exécute? (Mind, Executor, Scout, autre agent?)\n` +
    `4. Définir l'ORDRE d'exécution (séquentiel vs parallèle)\n` +
    `5. Définir les CRITÈRES DE SUCCÈS pour chaque tâche\n\n` +
    `FORMAT DU PLAN:\n` +
    `Tâche 1: [description] → Agent: [qui] → Critère: [succès si...]\n` +
    `Tâche 2: [description] → Agent: [qui] → Critère: [succès si...]\n` +
    `...\n\n` +
    `OUTPUT ATTENDU:\n` +
    `- Plan d'action numéroté avec assignations\n` +
    `- Estimation de temps totale\n` +
    `- Risques identifiés + plans B\n\n` +
    `Sauvegarde avec notes.add(title="PEODC Plan: [goal]")`,

  direction:
    `PHASE D — DIRECTION (Exécuter le travail)\n\n` +
    `OBJECTIF: Diriger l'exécution du plan. Faire le travail toi-même ET déléguer.\n\n` +
    `ACTIONS REQUISES:\n` +
    `1. Exécute les tâches assignées à "Mind" toi-même (tool calls)\n` +
    `2. Délègue aux autres agents via agents.delegate\n` +
    `3. Crée des agent_tasks pour l'Executor si besoin\n` +
    `4. Pour les tâches code: code.request pour Émile\n` +
    `5. Monitore l'avancement entre chaque tâche\n\n` +
    `RÈGLES D'EXÉCUTION:\n` +
    `- Fais le MAXIMUM toi-même avant de déléguer\n` +
    `- Si une tâche échoue, essaie Plan B IMMÉDIATEMENT\n` +
    `- Log chaque décision avec mind.decide\n` +
    `- Si blocage total, escalade via autonomous.escalate\n\n` +
    `OUTPUT ATTENDU:\n` +
    `- Status de chaque tâche (done/in_progress/blocked)\n` +
    `- Résultats concrets obtenus\n` +
    `- Problèmes rencontrés et solutions appliquées\n\n` +
    `Sauvegarde avec notes.add(title="PEODC Execute: [goal]")`,

  controle:
    `PHASE C — CONTRÔLE (Vérifier les résultats)\n\n` +
    `OBJECTIF: Vérifier que le goal est RÉELLEMENT atteint. Pas de "done" sans preuve.\n\n` +
    `ACTIONS REQUISES:\n` +
    `1. Pour chaque tâche du plan: vérifier le critère de succès\n` +
    `2. Tester les résultats concrètement (API calls, web.fetch, etc.)\n` +
    `3. Comparer le résultat avec le goal original\n` +
    `4. Identifier les écarts et résidus\n\n` +
    `VÉRIFICATIONS OBLIGATOIRES:\n` +
    `- Les données sont-elles réelles? (anti-hallucination check)\n` +
    `- Les changements sont-ils persistants? (pas juste en mémoire)\n` +
    `- Les agents délégués ont-ils terminé?\n` +
    `- Le goal original est-il satisfait à 100%?\n\n` +
    `OUTPUT ATTENDU:\n` +
    `- Score de complétion: X/100%\n` +
    `- Ce qui est fait vs ce qui reste\n` +
    `- Leçons apprises\n` +
    `- Recommandations pour la prochaine fois\n\n` +
    `Sauvegarde avec episodic.log + notes.add(title="PEODC Control: [goal]")\n` +
    `telegram.send — rapport final à Nicolas`,
};

// ── mind.peodc ──

registerSkill({
  name: "mind.peodc",
  description:
    "Start a PEODC autonomous workflow for a complex goal. " +
    "5 phases: Planification → Exploration → Organisation → Direction → Contrôle. " +
    "Returns the prompt for the current phase so the LLM can execute it.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      goal: {
        type: "string",
        description: "The complex goal to achieve via PEODC workflow",
      },
      context: {
        type: "string",
        description: "Optional additional context or constraints",
      },
    },
    required: ["goal"],
  },
  async execute(args): Promise<string> {
    ensureTable();
    const goal = String(args.goal);
    const context = args.context ? String(args.context) : "";
    const db = getDb();

    // Check for existing active workflow with same goal
    const existing = db.prepare(
      `SELECT id, phase FROM peodc_workflows WHERE goal = ? AND status = 'active'`
    ).get(goal) as { id: number; phase: string } | undefined;

    if (existing) {
      const phase = existing.phase as Phase;
      return (
        `Workflow PEODC #${existing.id} déjà actif pour ce goal.\n` +
        `Phase actuelle: ${PHASE_LABELS[phase]}\n\n` +
        `--- INSTRUCTIONS PHASE ---\n` +
        `GOAL: ${goal}\n` +
        (context ? `CONTEXTE: ${context}\n` : "") +
        `\n${PHASE_PROMPTS[phase]}`
      );
    }

    // Create new workflow
    const info = db.prepare(
      `INSERT INTO peodc_workflows (goal, phase, status) VALUES (?, 'planification', 'active')`
    ).run(goal);
    const id = info.lastInsertRowid as number;

    log.info(`[peodc] Workflow #${id} created: ${goal}`);

    return (
      `Workflow PEODC #${id} créé.\n` +
      `Goal: ${goal}\n` +
      (context ? `Contexte: ${context}\n` : "") +
      `\nPhases: P → E → O → D → C\n` +
      `Phase actuelle: ${PHASE_LABELS.planification}\n\n` +
      `--- INSTRUCTIONS PHASE ---\n` +
      `GOAL: ${goal}\n` +
      (context ? `CONTEXTE: ${context}\n` : "") +
      `\n${PHASE_PROMPTS.planification}`
    );
  },
});

// ── mind.peodc_advance ──

registerSkill({
  name: "mind.peodc_advance",
  description:
    "Advance a PEODC workflow to the next phase. " +
    "Records the output of the current phase and returns instructions for the next phase.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      workflow_id: {
        type: "number",
        description: "PEODC workflow ID",
      },
      phase_output: {
        type: "string",
        description: "Summary of what was accomplished in the current phase",
      },
    },
    required: ["workflow_id", "phase_output"],
  },
  async execute(args): Promise<string> {
    ensureTable();
    const workflowId = Number(args.workflow_id);
    const phaseOutput = String(args.phase_output);
    const db = getDb();

    const workflow = db.prepare(
      `SELECT * FROM peodc_workflows WHERE id = ? AND status = 'active'`
    ).get(workflowId) as any;

    if (!workflow) {
      return `Erreur: Workflow #${workflowId} introuvable ou inactif.`;
    }

    const currentPhase = workflow.phase as Phase;
    const currentIdx = PHASES.indexOf(currentPhase);

    // Save current phase output
    const outputCol = `${currentPhase === "controle" ? "control" : currentPhase === "planification" ? "plan" : currentPhase === "exploration" ? "explore" : currentPhase === "organisation" ? "organize" : "direct"}_output`;
    db.prepare(
      `UPDATE peodc_workflows SET ${outputCol} = ?, updated_at = unixepoch() WHERE id = ?`
    ).run(phaseOutput, workflowId);

    // Last phase (Contrôle) → complete workflow
    if (currentIdx >= PHASES.length - 1) {
      db.prepare(
        `UPDATE peodc_workflows SET status = 'completed', completed_at = unixepoch(), updated_at = unixepoch() WHERE id = ?`
      ).run(workflowId);

      log.info(`[peodc] Workflow #${workflowId} completed`);

      return (
        `Workflow PEODC #${workflowId} TERMINÉ.\n\n` +
        `Goal: ${workflow.goal}\n` +
        `Durée: ${Math.round((Date.now() / 1000 - workflow.created_at) / 60)} minutes\n` +
        `Résultat phase C: ${phaseOutput.slice(0, 300)}\n\n` +
        `Le workflow est complété. Utilise episodic.log pour sauvegarder les leçons apprises.`
      );
    }

    // Advance to next phase
    const nextPhase = PHASES[currentIdx + 1];
    db.prepare(
      `UPDATE peodc_workflows SET phase = ?, updated_at = unixepoch() WHERE id = ?`
    ).run(nextPhase, workflowId);

    log.info(`[peodc] Workflow #${workflowId} advanced: ${currentPhase} → ${nextPhase}`);

    // Build context from previous phases
    const prevContext: string[] = [];
    if (workflow.plan_output) prevContext.push(`[P] ${workflow.plan_output.slice(0, 300)}`);
    if (workflow.explore_output) prevContext.push(`[E] ${workflow.explore_output.slice(0, 300)}`);
    if (workflow.organize_output) prevContext.push(`[O] ${workflow.organize_output.slice(0, 300)}`);
    if (workflow.direct_output) prevContext.push(`[D] ${workflow.direct_output.slice(0, 300)}`);
    // Add the just-completed phase
    prevContext.push(`[${currentPhase[0].toUpperCase()}] ${phaseOutput.slice(0, 300)}`);

    return (
      `Workflow #${workflowId} avancé: ${PHASE_LABELS[currentPhase]} → ${PHASE_LABELS[nextPhase]}\n\n` +
      `--- RÉSUMÉ PHASES PRÉCÉDENTES ---\n` +
      `${prevContext.join("\n")}\n\n` +
      `--- INSTRUCTIONS PHASE ---\n` +
      `GOAL: ${workflow.goal}\n\n` +
      `${PHASE_PROMPTS[nextPhase]}`
    );
  },
});

// ── mind.peodc_status ──

registerSkill({
  name: "mind.peodc_status",
  description:
    "Check status of all PEODC workflows (active and recent completed).",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      workflow_id: {
        type: "number",
        description: "Optional: specific workflow ID to inspect in detail",
      },
    },
  },
  async execute(args): Promise<string> {
    ensureTable();
    const db = getDb();

    if (args.workflow_id) {
      const w = db.prepare("SELECT * FROM peodc_workflows WHERE id = ?").get(Number(args.workflow_id)) as any;
      if (!w) return `Workflow #${args.workflow_id} introuvable.`;

      const phase = w.phase as Phase;
      const lines = [
        `**PEODC Workflow #${w.id}**`,
        `Goal: ${w.goal}`,
        `Status: ${w.status} | Phase: ${PHASE_LABELS[phase]}`,
        `Créé: ${new Date(w.created_at * 1000).toLocaleString("fr-CA", { timeZone: "America/Toronto" })}`,
        ``,
      ];

      if (w.plan_output) lines.push(`**[P] Planification:** ${w.plan_output.slice(0, 200)}...`);
      if (w.explore_output) lines.push(`**[E] Exploration:** ${w.explore_output.slice(0, 200)}...`);
      if (w.organize_output) lines.push(`**[O] Organisation:** ${w.organize_output.slice(0, 200)}...`);
      if (w.direct_output) lines.push(`**[D] Direction:** ${w.direct_output.slice(0, 200)}...`);
      if (w.control_output) lines.push(`**[C] Contrôle:** ${w.control_output.slice(0, 200)}...`);

      return lines.join("\n");
    }

    // List all workflows
    const workflows = db.prepare(
      `SELECT id, goal, phase, status, created_at, completed_at
       FROM peodc_workflows ORDER BY created_at DESC LIMIT 10`
    ).all() as any[];

    if (workflows.length === 0) {
      return "Aucun workflow PEODC. Utilise mind.peodc(goal=...) pour en créer un.";
    }

    const active = workflows.filter((w) => w.status === "active");
    const completed = workflows.filter((w) => w.status === "completed");

    const lines: string[] = [`**PEODC Workflows** (${workflows.length} total)\n`];

    if (active.length > 0) {
      lines.push(`**Actifs (${active.length}):**`);
      for (const w of active) {
        const phase = PHASE_LABELS[w.phase as Phase] || w.phase;
        lines.push(`  #${w.id} — ${w.goal.slice(0, 60)} [${phase}]`);
      }
    }

    if (completed.length > 0) {
      lines.push(`\n**Complétés (${completed.length}):**`);
      for (const w of completed) {
        const dur = w.completed_at ? Math.round((w.completed_at - w.created_at) / 60) : "?";
        lines.push(`  #${w.id} — ${w.goal.slice(0, 60)} (${dur}min)`);
      }
    }

    return lines.join("\n");
  },
});

log.info(`[peodc] 3 PEODC workflow skills registered`);
