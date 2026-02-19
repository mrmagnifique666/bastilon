/**
 * Learner Agent — autonomous error analysis and self-improvement.
 * 3-cycle rotation (2h/cycle = 6h full rotation):
 *   0: Error cluster analysis — group recent errors, identify new patterns
 *   1: Rule effectiveness review — check if graduated rules reduced error rates
 *   2: Proactive fix proposals — analyze error trends and propose preventive measures
 */
import type { AgentConfig } from "../base.js";
import { config } from "../../config/env.js";
import { getDb } from "../../storage/store.js";
import {
  getAllPatterns,
  evaluateEffectiveness,
  getErrorTrends,
  deactivateRule,
} from "../../memory/self-review.js";
import { log } from "../../utils/log.js";

function getUnresolvedErrorSummary(): string {
  try {
    const db = getDb();
    const errors = db
      .prepare(
        `SELECT context, tool_name, error_message, COUNT(*) as cnt
         FROM error_log WHERE resolved = 0
         GROUP BY context ORDER BY cnt DESC LIMIT 10`,
      )
      .all() as Array<{
      context: string;
      tool_name: string | null;
      error_message: string;
      cnt: number;
    }>;

    if (errors.length === 0) return "Aucune erreur non résolue.";

    return errors
      .map(
        (e) =>
          `- [${e.cnt}x] ${e.context || "unknown"}${e.tool_name ? ` (${e.tool_name})` : ""}: ${e.error_message.slice(0, 100)}`,
      )
      .join("\n");
  } catch {
    return "Impossible de lire les erreurs.";
  }
}

function getErrorStats24h(): string {
  try {
    const db = getDb();
    const cutoff = Math.floor(Date.now() / 1000) - 86400;
    const total = db
      .prepare("SELECT COUNT(*) as c FROM error_log WHERE timestamp > ?")
      .get(cutoff) as { c: number };
    const unresolved = db
      .prepare(
        "SELECT COUNT(*) as c FROM error_log WHERE timestamp > ? AND resolved = 0",
      )
      .get(cutoff) as { c: number };
    const byContext = db
      .prepare(
        `SELECT context, COUNT(*) as c FROM error_log
         WHERE timestamp > ? GROUP BY context ORDER BY c DESC LIMIT 5`,
      )
      .all(cutoff) as Array<{ context: string; c: number }>;

    const breakdown = byContext
      .map((r) => `  ${r.context || "unknown"}: ${r.c}`)
      .join("\n");
    return `Total 24h: ${total.c} erreurs (${unresolved.c} non résolues)\nTop contextes:\n${breakdown}`;
  } catch {
    return "Stats indisponibles.";
  }
}

function buildLearnerPrompt(cycle: number): string | null {
  const rotation = cycle % 3;

  // Quiet hours: 23h-7h
  const hour = new Date().getHours();
  if (hour >= 23 || hour < 7) return null;

  const AGENT_RULES =
    `RÈGLES STRICTES:\n` +
    `- BROWSER: Tu peux utiliser browser.snapshot et browser.extract pour lire des pages web (headless, isolé). INTERDIT: browser.click, browser.type, browser.computer_use.\n` +
    `- Utilise: notes.*, analytics.*, files.*, system.*, shell.exec, errors.*, selfimprove.*, browser.snapshot, browser.extract\n` +
    `- NE CRÉE PAS de note si le système est stable et qu'il n'y a rien à signaler.\n` +
    `- Crée une note UNIQUEMENT si tu as un finding actionnable (nouveau pattern, fix proposé, anomalie).\n` +
    `- INGÉNIOSITÉ: Si errors.recent ne donne rien, utilise shell.exec pour lire les logs directement. Si un outil manque, utilise code.request pour le créer.\n\n`;

  if (rotation === 0) {
    // Error cluster analysis
    const errors = getUnresolvedErrorSummary();
    const stats = getErrorStats24h();
    const patterns = getAllPatterns();
    const graduatedCount = patterns.filter((p) => p.graduated).length;
    const pendingCount = patterns.filter(
      (p) => !p.graduated && p.count >= 3,
    ).length;

    // Skip cycle if no errors and no patterns near graduation — nothing to analyze
    if (errors === "Aucune erreur non résolue." && pendingCount === 0) {
      log.debug(`[learner] Cycle ${cycle} skipped — no errors, no pending patterns`);
      return null;
    }

    return (
      `Cycle ${cycle} — Error Cluster Analysis\n\n` +
      `Tu es l'agent Learner de Kingston. Ta mission : analyser les erreurs récentes et identifier des patterns.\n` +
      AGENT_RULES +
      `## Stats 24h\n${stats}\n\n` +
      `## Erreurs non résolues\n${errors}\n\n` +
      `## Patterns connus : ${patterns.length} (${graduatedCount} gradués, ${pendingCount} proches de graduation)\n\n` +
      `Instructions :\n` +
      `1. Analyse les erreurs non résolues ci-dessus\n` +
      `2. Si tu identifies un pattern récurrent, utilise notes.add pour documenter le pattern\n` +
      `3. Si des erreurs sont des duplicatas de patterns déjà gradués, elles seront auto-résolues\n` +
      `4. Log via analytics.log(skill='learner.cluster', outcome='success')\n` +
      `5. Sauvegarde un résumé concis (3-5 lignes) dans notes.add avec tag [LEARNER-CYCLE0] pour que Nicolas le découvre`
    );
  }

  if (rotation === 1) {
    // Rule effectiveness review
    const effectiveness = evaluateEffectiveness();
    if (effectiveness.length === 0) {
      // No graduated rules to evaluate — skip this cycle entirely
      const patterns = getAllPatterns();
      const nearGrad = patterns.filter(p => !p.graduated && p.count >= 3);
      if (nearGrad.length === 0) {
        log.debug(`[learner] Cycle ${cycle} skipped — no rules to evaluate, no patterns near graduation`);
        return null;
      }
      return (
        `Cycle ${cycle} — Rule Effectiveness Review\n\n` +
        `Tu es l'agent Learner de Kingston.\n` +
        AGENT_RULES +
        `Aucune règle graduée à évaluer, mais ${nearGrad.length} pattern(s) proche(s) de graduation.\n\n` +
        `1. Liste les error patterns via system.patterns\n` +
        `2. Si des patterns ont 3-4 occurrences, note les dans notes.add pour suivi\n` +
        `3. Log via analytics.log(skill='learner.effectiveness', outcome='success')\n` +
        `4. NE CRÉE PAS de note si tout est stable. Note UNIQUEMENT si tu trouves un finding actionnable.`
      );
    }

    const report = effectiveness
      .map((e) => {
        const icon = e.effective ? "✅" : "⚠️";
        return `${icon} ${e.key}: score ${e.score}% (${e.postHits} hits post-rule sur ${e.preCount} pré-rule)`;
      })
      .join("\n");

    // Auto-deactivate rules with very low effectiveness
    const ineffective = effectiveness.filter((e) => e.score < 30 && e.postHits >= 5);
    for (const rule of ineffective) {
      deactivateRule(rule.key);
      log.info(`[learner] Deactivated ineffective rule: ${rule.key} (score: ${rule.score}%)`);
    }

    return (
      `Cycle ${cycle} — Rule Effectiveness Review\n\n` +
      `Tu es l'agent Learner. Évalue l'efficacité des règles apprises.\n` +
      AGENT_RULES +
      `## Rapport d'efficacité\n${report}\n\n` +
      (ineffective.length > 0
        ? `⚠️ ${ineffective.length} règle(s) désactivée(s) car inefficaces.\n\n`
        : "") +
      `Instructions :\n` +
      `1. Analyse le rapport ci-dessus\n` +
      `2. Pour les règles inefficaces, propose une meilleure formulation dans notes.add\n` +
      `3. Log via analytics.log(skill='learner.effectiveness', outcome='success')\n` +
      `4. Sauvegarde un résumé concis dans notes.add avec tag [LEARNER-CYCLE1] et recommendations`
    );
  }

  // rotation === 2: Proactive fix proposals
  const trends = getErrorTrends(48); // 48h of trends
  const trendSummary =
    trends.length > 0
      ? trends
          .slice(-10)
          .map((t) => `${t.hour}: ${t.count} erreurs`)
          .join("\n")
      : "Aucune donnée de tendance.";

  const patterns = getAllPatterns();
  const recurring = patterns
    .filter((p) => !p.graduated && p.count >= 2)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  const recurringReport =
    recurring.length > 0
      ? recurring
          .map(
            (p) =>
              `- ${p.key} (${p.count}x): ${p.description.slice(0, 80)}`,
          )
          .join("\n")
      : "Aucun pattern récurrent non gradué.";

  // Skip cycle if no trends and no recurring patterns — nothing to propose
  if (trends.length === 0 && recurring.length === 0) {
    log.debug(`[learner] Cycle ${cycle} skipped — no trends, no recurring patterns`);
    return null;
  }

  // Load open ignorance gaps for the Learner to work on
  let ignoranceReport = "";
  try {
    const igDb = getDb();
    const gaps = igDb.prepare(
      `SELECT id, topic, what_i_dont_know, severity, suggested_fix, attempts FROM ignorance_log
       WHERE status = 'open' ORDER BY
       CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
       attempts DESC LIMIT 10`
    ).all() as Array<any>;
    if (gaps.length > 0) {
      ignoranceReport = gaps.map((g: any) => {
        const icon = g.severity === "critical" ? "🔴" : g.severity === "high" ? "🟠" : "🟡";
        return `${icon} #${g.id} [${g.topic}] ${g.what_i_dont_know.slice(0, 100)}${g.suggested_fix ? `\n   💡 ${g.suggested_fix.slice(0, 80)}` : ""}`;
      }).join("\n");
    }
  } catch { /* table may not exist */ }

  return (
    `Cycle ${cycle} — Proactive Fix Proposals + Ignorance Review\n\n` +
    `Tu es l'agent Learner. Propose des améliorations préventives ET traite les lacunes d'ignorance.\n` +
    AGENT_RULES +
    `## Tendances d'erreurs (48h)\n${trendSummary}\n\n` +
    `## Patterns récurrents non gradués\n${recurringReport}\n\n` +
    (ignoranceReport ? `## Aveux d'Ignorance (lacunes ouvertes)\n${ignoranceReport}\n\n` : "") +
    `Instructions :\n` +
    `1. Analyse les tendances et patterns ci-dessus\n` +
    `2. Si tu détectes un problème systémique, propose une solution dans notes.add\n` +
    `3. Si approprié, utilise files.read pour lire le code source pertinent et comprendre la root cause\n` +
    `4. **IGNORANCE**: Pour chaque lacune ouverte, tente de la résoudre:\n` +
    `   - Recherche l'info manquante (web.search, files.read, memory.search)\n` +
    `   - Si résolue, appelle learn.resolve(id=N, resolution="ce que j'ai appris")\n` +
    `   - Si pas résolvable, documente pourquoi dans notes.add\n` +
    `5. Log via analytics.log(skill='learner.proactive', outcome='success')\n` +
    `6. Sauvegarde un résumé concis dans notes.add avec tag [LEARNER-CYCLE2] et proposals concrètes`
  );
}

export function createLearnerConfig(): AgentConfig {
  return {
    id: "learner",
    name: "Learner",
    role: "Error analysis and self-improvement agent",
    heartbeatMs: config.agentLearnerHeartbeatMs,
    enabled: config.agentLearnerEnabled,
    chatId: 102, // Session isolation ID — router rewrites to adminChatId for telegram.send
    userId: config.voiceUserId,
    buildPrompt: buildLearnerPrompt,
    cycleCount: 3,
  };
}
