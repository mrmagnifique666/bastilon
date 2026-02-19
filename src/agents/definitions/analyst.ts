/**
 * Analyst Agent — performance analysis and reporting.
 * Heartbeat: 6h. 4-cycle rotation (6h/cycle = 24h full rotation):
 *   0: Daily Alpha Report (market overview)
 *   1: Performance snapshot (skills, errors, metrics)
 *   2: Trading analysis (portfolio, P&L, trends)
 *   3: Weekly deep dive (Sunday) or system health (other days)
 * Quiet hours: 23h-7h (skip all cycles).
 * ~4 fires/day.
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
    `- BROWSER: Tu peux utiliser browser.snapshot et browser.extract pour lire des pages web (headless, isolé). INTERDIT: browser.click, browser.type, browser.computer_use.\n` +
    `- Utilise: market.*, analytics.*, notes.*, telegram.send, web.search, api.call, trading.*, files.*, browser.snapshot, browser.extract\n` +
    `- INGÉNIOSITÉ: Si market.report échoue, utilise trading.account + trading.positions + web.search pour construire le rapport toi-même.\n` +
    `- Ne rapporte jamais "impossible" — trouve un autre chemin.\n\n`;

  const rotation = cycle % 4;

  // Cycle 0: Daily Alpha Report (market overview)
  if (rotation === 0) {
    return (
      `Tu es Analyst, agent de reporting de Kingston.\n` +
      AGENT_RULES +
      `Mission: Rapport marché du jour — LOG INTERNE.\n\n` +
      `1. Utilise market.report pour le rapport marché\n` +
      `2. Si le marché est fermé (weekend), dis-le brièvement\n` +
      `3. Log le rapport dans notes.add avec tag "analyst-daily" — PAS de telegram.send sauf mouvement extrême (>3% indices)`
    );
  }

  // Cycle 1: Performance snapshot
  if (rotation === 1) {
    return (
      `Tu es Analyst, agent de reporting de Kingston.\n` +
      AGENT_RULES +
      `Mission: Snapshot de performance quotidien.\n\n` +
      `1. Utilise analytics.report avec timeframe="today"\n` +
      `2. Vérifie les métriques: taux d'erreur, skills populaires\n` +
      `3. Log via analytics.log(skill="analyst.snapshot", outcome="success")\n` +
      `4. Log dans notes.add avec tag "analyst-snapshot" — PAS de telegram.send`
    );
  }

  // Cycle 2: Trading analysis
  if (rotation === 2) {
    return (
      `Tu es Analyst, agent de reporting de Kingston.\n` +
      AGENT_RULES +
      `Mission: Analyse trading du portfolio.\n\n` +
      `1. Utilise trading.positions pour voir les positions ouvertes\n` +
      `2. Utilise trading.account pour l'état du compte\n` +
      `3. Résume: P&L total, meilleurs/pires positions, tendances\n` +
      `4. Log dans notes.add avec tag "analyst-trading" — PAS de telegram.send`
    );
  }

  // Cycle 3: Weekly deep dive (Sunday) or system health
  if (rotation === 3) {
    if (isSunday()) {
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
        `4. Log le rapport dans notes.add avec tag "analyst-weekly" — PAS de telegram.send`
      );
    }
    // Non-Sunday: system health check
    return (
      `Tu es Analyst, agent de reporting de Kingston.\n` +
      AGENT_RULES +
      `Mission: Vérification santé système.\n\n` +
      `1. Utilise errors.recent pour voir les erreurs récentes\n` +
      `2. Utilise analytics.report avec timeframe="today" pour les stats\n` +
      `3. Si des patterns se répètent, note-les dans notes.add avec tag "analyst-health"\n` +
      `4. PAS de telegram.send sauf si le taux d'erreur est anormalement élevé`
    );
  }

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
    cycleCount: 4,
  };
}
