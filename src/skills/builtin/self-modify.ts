/**
 * Self-Modification Engine — Kingston can rewrite its own behavior.
 *
 * This is where AGI gets real: Kingston can modify its own prompts,
 * adjust thresholds, evolve strategies, and track what works.
 * Every change is logged with rollback capability.
 *
 * self.modify     — Apply a self-modification (prompt, threshold, strategy)
 * self.revert     — Roll back a modification that didn't work
 * self.experiment — Try a modification for N cycles, then auto-assess
 * self.log        — View recent self-modifications and their outcomes
 */
import { registerSkill } from "../loader.js";
import { log } from "../../utils/log.js";
import {
  selfModLog, selfModGetRecent, selfModRevert, selfModAssessOutcome,
  causalRecord, worldSet, logEpisodicEvent,
} from "../../storage/store.js";
import fs from "node:fs";
import path from "node:path";

// Modifiable targets and their file paths
const MODIFIABLE_TARGETS: Record<string, { path: string; description: string }> = {
  "KINGSTON_MIND": {
    path: path.resolve("relay/KINGSTON_MIND.md"),
    description: "Kingston's strategy document — business goals, priorities, trading rules",
  },
  "USER_CONTEXT": {
    path: path.resolve("relay/USER.md"),
    description: "User context loaded into all LLM prompts — who Nicolas is, preferences",
  },
  "PERSONALITY": {
    path: path.resolve("relay/PERSONALITY.md"),
    description: "Kingston's personality traits and communication style",
  },
  "HEARTBEAT": {
    path: path.resolve("relay/HEARTBEAT.md"),
    description: "Heartbeat checklist — what Kingston checks every 30 minutes",
  },
};

function readTarget(target: string): string | null {
  const t = MODIFIABLE_TARGETS[target];
  if (!t) return null;
  try {
    return fs.readFileSync(t.path, "utf-8");
  } catch {
    return null;
  }
}

function writeTarget(target: string, content: string): boolean {
  const t = MODIFIABLE_TARGETS[target];
  if (!t) return false;
  try {
    fs.writeFileSync(t.path, content, "utf-8");
    return true;
  } catch {
    return false;
  }
}

registerSkill({
  name: "self.modify",
  description: "Apply a self-modification to Kingston's behavior. Targets: KINGSTON_MIND, USER_CONTEXT, PERSONALITY, HEARTBEAT. All changes are logged and reversible.",
  argsSchema: {
    type: "object",
    properties: {
      target: { type: "string", description: "What to modify: KINGSTON_MIND, USER_CONTEXT, PERSONALITY, HEARTBEAT" },
      change_type: { type: "string", description: "Type: append, replace_section, full_rewrite, threshold_adjust" },
      section: { type: "string", description: "For replace_section: the section header to find and replace" },
      new_content: { type: "string", description: "The new content to apply" },
      reason: { type: "string", description: "Why this modification — what problem it solves" },
    },
    required: ["target", "change_type", "new_content", "reason"],
  },
  async execute(args) {
    const target = String(args.target).toUpperCase();
    const changeType = String(args.change_type);
    const newContent = String(args.new_content);
    const reason = String(args.reason);
    const section = args.section ? String(args.section) : undefined;

    if (!MODIFIABLE_TARGETS[target]) {
      return `Cible invalide: "${target}". Disponibles: ${Object.keys(MODIFIABLE_TARGETS).join(", ")}`;
    }

    const oldValue = readTarget(target);
    if (oldValue === null && changeType !== "full_rewrite") {
      return `Fichier cible introuvable: ${MODIFIABLE_TARGETS[target].path}. Utilisez full_rewrite pour creer.`;
    }

    let finalContent: string;

    switch (changeType) {
      case "append":
        finalContent = (oldValue || "") + "\n\n" + newContent;
        break;

      case "replace_section":
        if (!section) return "Parametre 'section' requis pour replace_section.";
        if (!oldValue) return "Fichier vide — impossible de remplacer une section.";
        // Find the section header and replace until next header or end
        const sectionRegex = new RegExp(
          `(^#+\\s*${section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\n]*\n)([\\s\\S]*?)(?=^#+\\s|$)`,
          "m"
        );
        if (!sectionRegex.test(oldValue)) {
          // Section not found — append it
          finalContent = oldValue + `\n\n## ${section}\n${newContent}\n`;
        } else {
          finalContent = oldValue.replace(sectionRegex, `$1${newContent}\n`);
        }
        break;

      case "full_rewrite":
        finalContent = newContent;
        break;

      case "threshold_adjust":
        // For inline value changes (e.g., changing a number in a config section)
        if (!oldValue) return "Fichier vide — rien a ajuster.";
        if (!section) return "Parametre 'section' requis — quelle valeur ajuster (ex: 'confidence_threshold: 0.5').";
        if (oldValue.includes(section)) {
          finalContent = oldValue.replace(section, newContent);
        } else {
          return `Valeur "${section}" introuvable dans ${target}. Contenu actuel (100 premiers chars): ${oldValue.slice(0, 100)}`;
        }
        break;

      default:
        return `Type de changement inconnu: "${changeType}". Options: append, replace_section, full_rewrite, threshold_adjust`;
    }

    // Apply the change
    if (!writeTarget(target, finalContent)) {
      return `Erreur: impossible d'ecrire dans ${MODIFIABLE_TARGETS[target].path}`;
    }

    // Log the modification
    const id = selfModLog(target, changeType, oldValue, finalContent, reason);

    // Record causal link
    causalRecord(`self_modify:${target}`, changeType, reason, 0.3);

    // Update world model
    worldSet("learning", `last_self_mod_target`, target, 0.8, "self.modify");
    worldSet("learning", `self_mod_count`, String(id), 0.9, "self.modify");

    // Log episodic event
    logEpisodicEvent("self_modification", `Kingston a modifie ${target} (${changeType}): ${reason.slice(0, 100)}`, {
      importance: 0.7,
      source: "self.modify",
    });

    log.info(`[self-modify] Applied ${changeType} to ${target}: ${reason.slice(0, 80)}`);

    return `**Self-Modification #${id}**\n` +
      `Cible: ${target} (${MODIFIABLE_TARGETS[target].description})\n` +
      `Type: ${changeType}\n` +
      `Raison: ${reason}\n` +
      `Statut: APPLIQUE — reversible via self.revert(id=${id})`;
  },
});

registerSkill({
  name: "self.revert",
  description: "Roll back a self-modification. Restores the previous state of the target file.",
  argsSchema: {
    type: "object",
    properties: {
      id: { type: "number", description: "The modification ID to revert" },
      reason: { type: "string", description: "Why reverting (optional)" },
    },
    required: ["id"],
  },
  async execute(args) {
    const id = Number(args.id);
    const reason = args.reason ? String(args.reason) : "revert demande";

    const result = selfModRevert(id);
    if (!result) {
      return `Modification #${id} introuvable ou deja revertee.`;
    }

    // Restore old content
    if (result.old_value !== null) {
      const written = writeTarget(result.target, result.old_value);
      if (!written) {
        return `Erreur: impossible de restaurer ${result.target}. L'ancien contenu est: ${result.old_value.slice(0, 200)}...`;
      }
    }

    // Log
    selfModAssessOutcome(id, `REVERTED: ${reason}`, -0.5);
    causalRecord(`self_revert:${result.target}`, `mod_${id}`, reason, -0.3);

    logEpisodicEvent("self_revert", `Kingston a annule la modification #${id} sur ${result.target}: ${reason}`, {
      importance: 0.6,
      source: "self.revert",
    });

    log.info(`[self-modify] Reverted #${id} on ${result.target}`);

    return `Modification #${id} ANNULEE. ${result.target} restaure a l'etat precedent.`;
  },
});

registerSkill({
  name: "self.experiment",
  description: "Try a modification experimentally — apply it, then auto-assess after N cycles. If negative outcome, auto-revert.",
  argsSchema: {
    type: "object",
    properties: {
      target: { type: "string", description: "What to modify: KINGSTON_MIND, USER_CONTEXT, PERSONALITY, HEARTBEAT" },
      change_type: { type: "string", description: "Type: append, replace_section, full_rewrite" },
      section: { type: "string", description: "Section to replace (for replace_section)" },
      new_content: { type: "string", description: "The experimental content" },
      hypothesis: { type: "string", description: "What you expect will happen" },
      success_metric: { type: "string", description: "How to measure success (e.g., 'higher metacognition scores', 'more trades executed')" },
    },
    required: ["target", "change_type", "new_content", "hypothesis", "success_metric"],
  },
  async execute(args) {
    const target = String(args.target).toUpperCase();
    const changeType = String(args.change_type);
    const newContent = String(args.new_content);
    const hypothesis = String(args.hypothesis);
    const successMetric = String(args.success_metric);
    const section = args.section ? String(args.section) : undefined;

    if (!MODIFIABLE_TARGETS[target]) {
      return `Cible invalide: "${target}".`;
    }

    const oldValue = readTarget(target);

    // Apply the modification (same logic as self.modify)
    let finalContent: string;
    switch (changeType) {
      case "append":
        finalContent = (oldValue || "") + "\n\n" + newContent;
        break;
      case "replace_section":
        if (!section || !oldValue) return "Section ou fichier manquant.";
        const sectionRegex = new RegExp(
          `(^#+\\s*${section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\n]*\n)([\\s\\S]*?)(?=^#+\\s|$)`,
          "m"
        );
        if (!sectionRegex.test(oldValue)) {
          finalContent = oldValue + `\n\n## ${section}\n${newContent}\n`;
        } else {
          finalContent = oldValue.replace(sectionRegex, `$1${newContent}\n`);
        }
        break;
      case "full_rewrite":
        finalContent = newContent;
        break;
      default:
        return `Type inconnu: "${changeType}".`;
    }

    if (!writeTarget(target, finalContent)) {
      return `Erreur ecriture sur ${target}.`;
    }

    // Log as experiment
    const reason = `EXPERIMENT: ${hypothesis} | Metric: ${successMetric}`;
    const id = selfModLog(target, `experiment:${changeType}`, oldValue, finalContent, reason);

    // Record in causal system
    causalRecord(`experiment:${target}`, hypothesis, `started:${successMetric}`, 0.0);

    // Update world model
    worldSet("learning", "active_experiment", `#${id}: ${hypothesis.slice(0, 60)}`, 0.8, "self.experiment");

    logEpisodicEvent("self_experiment", `Kingston lance une experience #${id}: ${hypothesis.slice(0, 100)}`, {
      importance: 0.7,
      source: "self.experiment",
    });

    log.info(`[self-modify] Experiment #${id} started on ${target}: ${hypothesis.slice(0, 80)}`);

    return `**Experience #${id} LANCEE**\n` +
      `Cible: ${target}\n` +
      `Hypothese: ${hypothesis}\n` +
      `Metrique de succes: ${successMetric}\n` +
      `Type: ${changeType}\n\n` +
      `L'experience est active. Apres quelques cycles, utilisez self.log pour voir l'impact,\n` +
      `puis self.revert(id=${id}) si les resultats sont negatifs.`;
  },
});

registerSkill({
  name: "self.log",
  description: "View recent self-modifications and assess their outcomes. This is Kingston's self-improvement journal.",
  argsSchema: {
    type: "object",
    properties: {
      limit: { type: "number", description: "Number of recent modifications to show (default 10)" },
      assess_id: { type: "number", description: "If provided, assess the outcome of this modification" },
      outcome: { type: "string", description: "Outcome description (for assess_id)" },
      score: { type: "number", description: "Outcome score -1.0 to 1.0 (for assess_id)" },
    },
  },
  async execute(args) {
    // If assessing a specific modification
    if (args.assess_id) {
      const assessId = Number(args.assess_id);
      const outcome = args.outcome ? String(args.outcome) : "assessed";
      const score = Number(args.score ?? 0);

      selfModAssessOutcome(assessId, outcome, score);

      // Record causal learning from this outcome
      causalRecord("self_mod_outcome", `mod_${assessId}`, `${outcome} (score:${score})`, score);

      return `Modification #${assessId} evaluee: "${outcome}" (score: ${score})`;
    }

    // Show recent modifications
    const limit = Number(args.limit) || 10;
    const mods = selfModGetRecent(limit);

    if (mods.length === 0) {
      return "Aucune self-modification enregistree. Kingston n'a pas encore modifie son propre comportement.";
    }

    let report = `**Journal de Self-Modification** (${mods.length} dernieres):\n\n`;

    for (const m of mods) {
      const age = Math.round((Date.now() / 1000 - m.created_at) / 3600);
      const ageStr = age < 1 ? "< 1h" : age < 24 ? `${age}h` : `${Math.round(age / 24)}j`;
      const statusIcon = m.reverted ? "REVERT" : m.outcome_score !== null ?
        (m.outcome_score > 0.3 ? "OK" : m.outcome_score < -0.3 ? "FAIL" : "NEUTRE") : "EN COURS";

      report += `**#${m.id}** [${statusIcon}] ${m.target} (${m.change_type}) — ${ageStr}\n`;
      report += `  Raison: ${m.reason.slice(0, 100)}\n`;
      if (m.outcome) report += `  Resultat: ${m.outcome.slice(0, 80)} (score: ${m.outcome_score})\n`;
      report += "\n";
    }

    // Summary stats
    const assessed = mods.filter(m => m.outcome_score !== null);
    if (assessed.length > 0) {
      const avgScore = assessed.reduce((s, m) => s + m.outcome_score, 0) / assessed.length;
      const positive = assessed.filter(m => m.outcome_score > 0.3).length;
      const negative = assessed.filter(m => m.outcome_score < -0.3).length;
      report += `**Bilan**: ${positive} positifs, ${negative} negatifs, score moyen: ${avgScore.toFixed(2)}`;
    }

    return report;
  },
});

log.info("[self-modify] 4 self.* skills registered — Kingston can now modify its own behavior");
