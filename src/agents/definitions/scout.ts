/**
 * Scout Agent — autonomous prospecting and market intelligence.
 * 6-cycle rotation (4h/cycle = 24h full rotation):
 *   0: LinkedIn prospecting (courtiers Gatineau/Ottawa)
 *   1: Reddit pain point mining
 *   2: Competitive intelligence
 *   3: Lead qualification (review prospects in CRM)
 *   4: Veille sectorielle (immobilier, assurance)
 *   5: Twitter/web trends monitoring
 * Quiet hours: 22h-8h (no point searching at night).
 * Each cycle: search → save to contacts/notes → log analytics.
 * Only telegram.send when high-value finding (not every cycle).
 */
import type { AgentConfig } from "../base.js";
import { config } from "../../config/env.js";

const TZ = "America/Toronto";

function isQuietHours(): boolean {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    hour: "numeric",
    hour12: false,
  }).formatToParts(new Date());
  const h = Number(parts.find((p) => p.type === "hour")!.value);
  return h >= 22 || h < 8;
}

function buildScoutPrompt(cycle: number): string | null {
  // Skip during quiet hours — web prospecting at night is pointless
  if (isQuietHours()) return null;

  const rotation = cycle % 6;

  const AGENT_RULES =
    `RÈGLES STRICTES:\n` +
    `- INTERDIT: N'utilise JAMAIS browser.* (navigate, click, etc.) — ça ouvre Chrome sur l'écran de Nicolas.\n` +
    `- Utilise UNIQUEMENT: web.search, contacts.*, notes.*, analytics.log, telegram.send\n` +
    `- Sois concis. Pas de bavardage.\n\n`;

  const prompts: Record<number, string> = {
    0: // LinkedIn Prospecting
      `Tu es Scout, agent de prospection de Kingston.\n` +
      AGENT_RULES +
      `Mission: Trouve des courtiers immobiliers ou d'assurance à Gatineau/Ottawa.\n\n` +
      `1. Utilise web.search pour "courtier immobilier Gatineau" ou "insurance broker Ottawa"\n` +
      `2. Pour chaque prospect trouvé, sauvegarde via contacts.add avec tags "prospect,broker"\n` +
      `3. Log via analytics.log(skill="scout.linkedin", outcome="success")\n` +
      `4. Si tu trouves un prospect très prometteur, envoie un bref message via telegram.send`,

    1: // Reddit Pain Points
      `Tu es Scout, agent de prospection de Kingston.\n` +
      AGENT_RULES +
      `Mission: Trouve des pain points de courtiers sur le web.\n\n` +
      `1. Utilise web.search pour "real estate broker pain points automation" ou "courtier immobilier problèmes technologie"\n` +
      `2. Sauvegarde les insights dans notes.add avec tag "reddit-insight"\n` +
      `3. Log via analytics.log(skill="scout.reddit", outcome="success")`,

    2: // Competitive Intelligence
      `Tu es Scout, agent de prospection de Kingston.\n` +
      AGENT_RULES +
      `Mission: Veille concurrentielle — qui offre des services AI aux courtiers?\n\n` +
      `1. Utilise web.search pour "AI answering service real estate" ou "assistant IA courtier immobilier"\n` +
      `2. Sauvegarde les concurrents trouvés dans notes.add avec tag "veille-concurrentielle"\n` +
      `3. Log via analytics.log(skill="scout.competitive", outcome="success")`,

    3: // Lead Qualification
      `Tu es Scout, agent de prospection de Kingston.\n` +
      AGENT_RULES +
      `Mission: Évalue les prospects existants dans le CRM.\n\n` +
      `1. Utilise contacts.list avec tag "prospect" pour voir les prospects récents\n` +
      `2. Pour chaque prospect, évalue la pertinence (immobilier/assurance + Gatineau/Ottawa = bonus)\n` +
      `3. Mets à jour les notes des contacts prometteurs via contacts.update\n` +
      `4. Log via analytics.log(skill="scout.qualify", outcome="success")\n` +
      `5. Si des prospects chauds identifiés, résume via telegram.send`,

    4: // Veille Sectorielle
      `Tu es Scout, agent de prospection de Kingston.\n` +
      AGENT_RULES +
      `Mission: Veille sur le marché immobilier et assurance au Québec.\n\n` +
      `1. Utilise web.search pour "marché immobilier Gatineau Ottawa 2026" ou "assurance courtier tendances Québec"\n` +
      `2. Sauvegarde les actualités importantes dans notes.add avec tag "veille-sectorielle"\n` +
      `3. Log via analytics.log(skill="scout.veille", outcome="success")`,

    5: // Web/Twitter Trends
      `Tu es Scout, agent de prospection de Kingston.\n` +
      AGENT_RULES +
      `Mission: Surveille les tendances AI + immobilier sur le web.\n\n` +
      `1. Utilise web.search pour "AI real estate trends 2026" ou "proptech innovation"\n` +
      `2. Sauvegarde dans notes.add avec tag "trends"\n` +
      `3. Log via analytics.log(skill="scout.trends", outcome="success")`,
  };

  return prompts[rotation] || null;
}

export function createScoutConfig(): AgentConfig {
  return {
    id: "scout",
    name: "Scout",
    role: "Prospecting & market intelligence agent",
    heartbeatMs: config.agentScoutHeartbeatMs,
    enabled: config.agentScoutEnabled,
    chatId: 100, // Session isolation ID — router rewrites to adminChatId for telegram.send
    userId: config.voiceUserId,
    buildPrompt: buildScoutPrompt,
    cycleCount: 6,
  };
}
