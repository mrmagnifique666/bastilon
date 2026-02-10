/**
 * Analyst Agent — performance analysis and reporting.
 * Heartbeat: 6h. Schedule by cycle:
 *   Cycle 0: Daily Alpha Report (market overview)
 *   Cycle % 4 (~24h): Performance snapshot
 *   Sunday cycle % 4: Weekly deep dive
 *   All other cycles: skip (return null)
 * Quiet hours: 23h-7h (skip all cycles).
 * ~3-4 fires/day max.
 */
import type { AgentConfig } from "../base.js";
import { config } from "../../config/env.js";

const TZ = "America/Toronto";

function getCurrentHour(): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    hour: "numeric",
    hour12: false,
  }).formatToParts(new Date());
  return Number(parts.find((p) => p.type === "hour")!.value);
}

function isSunday(): boolean {
  const day = new Date().toLocaleDateString("en-CA", { timeZone: TZ, weekday: "long" });
  return day === "Sunday";
}

function buildAnalystPrompt(cycle: number): string | null {
  // Quiet hours: no point running reports at night
  const h = getCurrentHour();
  if (h >= 23 || h < 7) return null;

  const AGENT_RULES =
    `RÈGLES STRICTES:\n` +
    `- INTERDIT: N'utilise JAMAIS browser.* — ça ouvre Chrome sur l'écran de Nicolas.\n` +
    `- Utilise UNIQUEMENT: market.*, analytics.*, notes.*, telegram.send\n\n`;

  // Cycle 0: Daily Alpha Report (first fire after startup)
  if (cycle === 0) {
    return (
      `Tu es Analyst, agent de reporting de Kingston.\n` +
      AGENT_RULES +
      `Mission: Rapport marché du jour.\n\n` +
      `1. Utilise market.report pour le rapport marché\n` +
      `2. Si le marché est fermé (weekend), dis-le brièvement\n` +
      `3. Envoie le rapport à Nicolas via telegram.send`
    );
  }

  // Sunday cycle % 4: Weekly deep dive
  if (cycle % 4 === 0 && isSunday()) {
    return (
      `Tu es Analyst, agent de reporting de Kingston.\n` +
      AGENT_RULES +
      `Mission: Rapport hebdomadaire complet.\n\n` +
      `1. Utilise analytics.report avec timeframe="week" pour les stats\n` +
      `2. Utilise analytics.bottlenecks pour les goulots\n` +
      `3. Génère un rapport:\n` +
      `   WEEKLY REPORT\n` +
      `   - Wins de la semaine\n` +
      `   - Métriques (skills, erreurs, temps)\n` +
      `   - Améliorations possibles\n` +
      `4. Envoie le rapport via telegram.send`
    );
  }

  // Cycle % 4 (~24h): Performance snapshot
  if (cycle % 4 === 0) {
    return (
      `Tu es Analyst, agent de reporting de Kingston.\n` +
      AGENT_RULES +
      `Mission: Snapshot de performance quotidien.\n\n` +
      `1. Utilise analytics.report avec timeframe="today"\n` +
      `2. Vérifie les métriques: taux d'erreur, skills populaires\n` +
      `3. Log via analytics.log(skill="analyst.snapshot", outcome="success")\n` +
      `4. Envoie un résumé concis (3-4 lignes) via telegram.send`
    );
  }

  // All other cycles: skip — nothing to do
  return null;
}

export function createAnalystConfig(): AgentConfig {
  return {
    id: "analyst",
    name: "Analyst",
    role: "Performance analysis & reporting agent",
    heartbeatMs: config.agentAnalystHeartbeatMs,
    enabled: config.agentAnalystEnabled,
    chatId: 101, // Session isolation ID — router rewrites to adminChatId for telegram.send
    userId: config.voiceUserId,
    buildPrompt: buildAnalystPrompt,
  };
}
