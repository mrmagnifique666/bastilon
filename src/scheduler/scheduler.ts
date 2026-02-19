/**
 * Scheduler — tick loop (60s) that fires timed events and custom reminders.
 * Uses handleMessage() so Claude generates natural briefings.
 * Timezone: America/Toronto via Intl.DateTimeFormat.
 */
import fs from "node:fs";
import path from "node:path";
import { getDb } from "../storage/store.js";
import { handleMessage } from "../orchestrator/router.js";
import { enqueueAdminAsync } from "../bot/chatLock.js";
import { config } from "../config/env.js";
import { log } from "../utils/log.js";
import { cronTick, drainMainSessionQueue, seedDefaultCronJobs } from "./cron.js";
import { publishScheduledContent } from "./content-publisher.js";
import { checkProactiveTriggers } from "../proactive/triggers.js";
import { sendMorningBriefing, sendNoonBriefing, sendEveningBriefing, sendAfternoonBriefing } from "./briefings.js";

const TICK_MS = 60_000;
const TZ = "America/Toronto";

interface ScheduledEvent {
  key: string;
  type: "daily" | "interval";
  /** For daily: hour (0-23) to fire */
  hour?: number;
  /** For interval: interval in minutes */
  intervalMin?: number;
  /** Prompt sent to handleMessage, or null for silent events */
  prompt: string | null;
}

const EVENTS: ScheduledEvent[] = [
  {
    key: "morning_briefing",
    type: "daily",
    hour: 6, // 6h30 ET — briefing matinal consolidé
    prompt: null, // dynamic — built at fire time with overnight agent data
  },
  {
    key: "noon_briefing",
    type: "daily",
    hour: 11, // 11h50 — briefing de mi-journée consolidé
    prompt: null, // dynamic — built at fire time
  },
  {
    key: "trading_strategy_open",
    type: "daily",
    hour: 9, // 9h ET — market open + 30min for stability
    prompt: null, // dynamic — built from Kingston Mind strategy (SILENT - no telegram)
  },
  {
    key: "trading_strategy_close",
    type: "daily",
    hour: 15, // 15h ET — 1h before market close, review positions
    prompt: null, // dynamic — built from Kingston Mind strategy (SILENT - no telegram)
  },
  {
    key: "rules_auto_graduate",
    type: "daily",
    hour: 7, // 7h ET — auto-graduate proven rules (included in morning briefing)
    prompt: null, // dynamic — auto-graduate proven rules
  },
  {
    key: "morning_call",
    type: "daily",
    hour: 8, // 8h ET — proactive phone call with morning briefing
    prompt: null, // dynamic — uses phone.call to call Nicolas
  },
  {
    key: "evening_briefing",
    type: "daily",
    hour: 20, // 20h ET — briefing du soir consolidé
    prompt:
      "[SCHEDULER] Briefing du soir consolidé (20h). Compile un rapport complet pour Nicolas.\n\n" +
      "DONNÉES À COLLECTER (appelle CHAQUE outil):\n" +
      "1. TRADING: trading.pnl(period=\"1D\") — P&L du jour complet\n" +
      "2. MOLTBOOK: Lis les notes récentes \"Moltbook Performance\" pour stats d'engagement\n" +
      "3. SYSTÈME: Rapport agents du jour (erreurs, succès)\n" +
      "4. RAPPELS: scheduler.list — rappels en attente\n" +
      "5. CODE REQUESTS: Lis code-requests.json pour les tâches pending\n\n" +
      "FORMAT DU MESSAGE (telegram.send):\n" +
      "\"🌙 Bonsoir Nicolas!\n\n" +
      "📊 Trading: P&L jour [montant] ([nb] trades)\n" +
      "🦞 Moltbook: [stats engagement — upvotes/commentaires reçus]\n" +
      "⚙️ Système: [nb agents actifs], [erreurs du jour]\n" +
      "📋 Rappels: [nb en attente]\n" +
      "💻 Code: [nb demandes pending]\n\n" +
      "Bonne soirée! 🌃\"\n\n" +
      "RÈGLES: Utilise les VRAIES données. Si un tool échoue, mets \"N/A\". Message CONCIS (max 12 lignes).",
  },
  {
    key: "code_digest_morning",
    type: "daily",
    hour: 7, // 7h ET — inclus dans le morning briefing
    prompt: null, // dynamic — built at fire time
  },
  {
    key: "code_digest_evening",
    type: "daily",
    hour: 20, // 20h ET — inclus dans le evening briefing
    prompt: null, // dynamic — built at fire time
  },
  // DÉSACTIVÉ — heartbeat proactif remplacé par briefings consolidés 3x/jour
  // {
  //   key: "heartbeat",
  //   type: "interval",
  //   intervalMin: 30,
  //   prompt: null, // dynamic — proactive checks at fire time
  // },
  {
    key: "moltbook_digest",
    type: "daily",
    hour: 12, // 12h (midi) — résumé Moltbook inclus dans noon briefing
    prompt: null, // dynamic — built at fire time
  },
  // DÉSACTIVÉ — moltbook auto-post trop fréquent, remplacé par scheduler manuel
  // {
  //   key: "moltbook_post",
  //   type: "interval",
  //   intervalMin: 31, // tight to 30-min API rate limit — maximum posting
  //   prompt: null, // dynamic — built at fire time
  // },
  // DÉSACTIVÉ — moltbook auto-comment trop fréquent
  // {
  //   key: "moltbook_comment",
  //   type: "interval",
  //   intervalMin: 5, // aggressive commenting — 50 comments/day max enforced by API
  //   prompt: null, // dynamic — built at fire time
  // },
  {
    key: "moltbook_performance",
    type: "daily",
    hour: 20, // 20h ET — check post performance (inclus dans evening briefing)
    prompt: null, // dynamic — built at fire time
  },
  {
    key: "nightly_council",
    type: "daily",
    hour: 21, // 21h ET — nightly AI council briefing
    prompt: null, // dynamic — multi-persona council
  },
  {
    key: "notify_daily_digest",
    type: "daily",
    hour: 20, // 20h ET — send daily notification digest
    prompt: null, // dynamic — uses notify.digest skill
  },
  {
    key: "price_check",
    type: "interval",
    intervalMin: 360, // every 6 hours — check tracked prices
    prompt: null, // dynamic — uses price.check skill
  },
  {
    key: "goals_weekly_review",
    type: "daily",
    hour: 9, // 9h ET Monday — weekly goals review (filtered to Mondays in fireEvent)
    prompt: null, // dynamic — uses goals.review skill
  },
  {
    key: "trading_premarket_research",
    type: "daily",
    hour: 7, // 7h ET weekdays — pre-market research before 9h trading cron
    prompt: null, // dynamic — silent research, no telegram
  },
  {
    key: "trading_evening_journal",
    type: "daily",
    hour: 17, // 17h ET weekdays — post-market journal + lessons learned
    prompt: null, // dynamic — journal + brief P&L telegram
  },
  {
    key: "trading_weekly_retro",
    type: "daily",
    hour: 18, // 18h ET Friday only — weekly retrospective
    prompt: null, // dynamic — filtered to Fridays in fireEvent
  },
  {
    key: "moltbook_ideation",
    type: "daily",
    hour: 7, // 7h ET daily — content brainstorming for posting crons
    prompt: null, // dynamic — saves ideas to notes
  },
  {
    key: "moltbook_draft_from_ideas",
    type: "daily",
    hour: 9, // 9h ET daily — convert ideation notes into content.draft items
    prompt: null, // dynamic — reads ideation notes, creates drafts with dedup
  },
  {
    key: "moltbook_quality_review",
    type: "interval",
    intervalMin: 180, // every 3h — review drafts, auto-schedule approved ones
    prompt: null, // dynamic — AI detection + brand voice + dedup gate
  },
  {
    key: "moltbook_optimize",
    type: "daily",
    hour: 22, // 22h ET daily — analyze performance + FEEDBACK LOOP
    prompt: null, // dynamic — performance insights + strategy update + learning
  },
  {
    key: "email_triage",
    type: "interval",
    intervalMin: 30, // every 30min — check inbox, categorize, draft responses
    prompt: null, // dynamic — built at fire time
  },
  {
    key: "kingston_game_night",
    type: "daily",
    hour: 22, // 22h ET — Kingston plays TTRPG or video games autonomously
    prompt: null, // dynamic — decided by Mind agent
  },
  {
    key: "ralph_wiggum_overnight",
    type: "daily",
    hour: 23, // 23h ET — Ralph Wiggum Loop: process code.requests overnight
    prompt: null, // dynamic — built at fire time
  },
  {
    key: "soul_nightly_improve",
    type: "daily",
    hour: 4, // 4h ET — Nightly SOUL.md self-improvement analysis
    prompt: null, // dynamic — built at fire time
  },
  {
    key: "moltbook_growth_engage",
    type: "daily",
    hour: 10, // 10h ET — Moltbook engagement run
    prompt: null, // dynamic — built at fire time
  },
  {
    key: "moltbook_growth_engage_2",
    type: "daily",
    hour: 15, // 15h ET — Second engagement run
    prompt: null, // dynamic — built at fire time
  },
  {
    key: "memory_nightly_maintenance",
    type: "daily",
    hour: 5, // 5h ET — Full maintenance: consolidation + dedup + decay
    prompt: null, // dynamic — built at fire time
  },
  {
    key: "memory_midday_check",
    type: "daily",
    hour: 13, // 13h ET — Quick dedup + stats (after noon briefing)
    prompt: null, // dynamic — built at fire time
  },
  {
    key: "memory_evening_review",
    type: "daily",
    hour: 19, // 19h ET — Day review + promote important memories (before evening briefing)
    prompt: null, // dynamic — built at fire time
  },
];

const CODE_REQUESTS_FILE = path.join(process.cwd(), "code-requests.json");

function buildCodeDigestPrompt(): string | null {
  try {
    if (!fs.existsSync(CODE_REQUESTS_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(CODE_REQUESTS_FILE, "utf-8")) as any[];
    const pending = data.filter(
      (r) => r.status === "pending" || r.status === "awaiting_execution"
    );
    if (pending.length === 0) return null;

    const summary = pending
      .map((r, i) => {
        const taskPreview = r.task.length > 150 ? r.task.slice(0, 150) + "..." : r.task;
        return `${i + 1}. [${r.priority}] ${taskPreview}`;
      })
      .join("\n");

    return (
      `[SCHEDULER:SILENT] Code Request Digest — ${pending.length} demande(s) en attente (PAS de telegram.send).\n\n` +
      `${summary}\n\n` +
      `Analyse ce digest et sauvegarde via notes.add. Les demandes seront mentionnées dans les briefings consolidés (7h/20h). ` +
      `NE PAS envoyer de telegram.send — ce digest est SILENCIEUX.`
    );
  } catch (err) {
    log.error(`[scheduler] Error building code digest: ${err}`);
    return null;
  }
}

/**
 * Build morning briefing with overnight agent activity report.
 * Queries agent_runs table for runs since last evening (20h previous day).
 */
function buildMorningBriefingPrompt(): string {
  let agentSummary = "";
  try {
    const db = getDb();
    // Get runs from the last 12 hours (overnight)
    const cutoff = Math.floor(Date.now() / 1000) - 12 * 3600;
    const runs = db
      .prepare(
        `SELECT agent_id, cycle, outcome, duration_ms, error_msg, started_at
         FROM agent_runs WHERE started_at > ? ORDER BY started_at ASC`
      )
      .all(cutoff) as Array<{
        agent_id: string;
        cycle: number;
        outcome: string;
        duration_ms: number;
        error_msg: string | null;
        started_at: number;
      }>;

    if (runs.length > 0) {
      const byAgent: Record<string, { success: number; error: number; rateLimit: number; totalMs: number }> = {};
      for (const r of runs) {
        if (!byAgent[r.agent_id]) byAgent[r.agent_id] = { success: 0, error: 0, rateLimit: 0, totalMs: 0 };
        const a = byAgent[r.agent_id];
        if (r.outcome === "success") a.success++;
        else if (r.outcome === "rate_limit") a.rateLimit++;
        else a.error++;
        a.totalMs += r.duration_ms;
      }

      const lines: string[] = [];
      for (const [id, stats] of Object.entries(byAgent)) {
        lines.push(
          `- **${id}**: ${stats.success} succès, ${stats.error} erreurs, ${stats.rateLimit} rate limits, ${Math.round(stats.totalMs / 1000)}s total`
        );
      }
      agentSummary = `\n\n**Activité agents (dernières 12h):**\n${lines.join("\n")}`;
    }

    // Get current agent states
    const states = db
      .prepare("SELECT agent_id, cycle, total_runs, consecutive_errors FROM agent_state")
      .all() as Array<{ agent_id: string; cycle: number; total_runs: number; consecutive_errors: number }>;

    if (states.length > 0) {
      const stateLines = states.map(
        (s) => `- ${s.agent_id}: cycle ${s.cycle}, ${s.total_runs} runs total, ${s.consecutive_errors} erreurs consécutives`
      );
      agentSummary += `\n\n**État actuel agents:**\n${stateLines.join("\n")}`;
    }
  } catch (err) {
    log.debug(`[scheduler] Failed to build agent summary: ${err}`);
  }

  return (
    `[SCHEDULER] Briefing matinal complet (8h). Compile un rapport concis pour Nicolas.\n\n` +
    `DONNÉES À COLLECTER (appelle CHAQUE outil EXACTEMENT comme indiqué):\n` +
    `1. MÉTÉO: weather.current(city="Gatineau") — OBLIGATOIRE, PAS web.search\n` +
    `2. TRADING P&L: trading.positions() + trading.account() — résumé portfolio\n` +
    `3. MOLTBOOK: moltbook.feed(sort="hot", limit=3) — tendances du jour\n` +
    `4. BUSINESS: client.list() — leads actifs et follow-ups dus\n` +
    `5. SYSTÈME: Rapport agents ci-dessous\n` +
    `6. RAPPELS: scheduler.list — rappels en attente\n` +
    `${agentSummary}\n\n` +
    `FORMAT DU MESSAGE (telegram.send):\n` +
    `"☀️ Bon matin Nicolas!\n\n` +
    `🌤 Météo: [temp/conditions]\n` +
    `📈 Trading: P&L [montant], [nb] positions actives\n` +
    `🦞 Moltbook: [résumé activité]\n` +
    `🏢 Business: [nb leads], [follow-ups dus]\n` +
    `⚙️ Système: [nb agents actifs], [erreurs overnight]\n` +
    `📋 Rappels: [nb en attente]\n\n` +
    `Bonne journée! 💪"\n\n` +
    `RÈGLES: Utilise les VRAIES données des tools. Pas de placeholders. Si un tool échoue, mets "N/A".`
  );
}

/**
 * Build noon briefing — consolidated mid-day update.
 */
function buildNoonBriefingPrompt(): string {
  return (
    `[SCHEDULER] Briefing de midi (12h). Compile un rapport concis pour Nicolas.\n\n` +
    `DONNÉES À COLLECTER (appelle CHAQUE outil):\n` +
    `1. TRADING: trading.positions() + trading.pnl(period="1D") — P&L du jour\n` +
    `2. MOLTBOOK: moltbook.feed(sort=hot, limit=3) — posts tendance du jour\n` +
    `3. MOLTBOOK STATS: moltbook.my_posts(limit=3) — performance de tes posts\n` +
    `4. SYSTÈME: Vérifier s'il y a des alertes ou erreurs agents\n` +
    `5. RAPPELS: scheduler.list — rappels en attente\n\n` +
    `FORMAT DU MESSAGE (telegram.send):\n` +
    `"🌞 Midi Nicolas!\n\n` +
    `📈 Trading: P&L jour [montant], [nb] positions\n` +
    `🦞 Moltbook: [résumé activité + posts tendance]\n` +
    `⚙️ Système: [statut agents]\n` +
    `📋 Rappels: [nb en attente]\n\n` +
    `Bon après-midi! 🚀"\n\n` +
    `RÈGLES: Utilise les VRAIES données. Si un tool échoue, mets "N/A". Message COURT (max 10 lignes).`
  );
}

/**
 * Evening briefing fallback — used if event.prompt is null/missing.
 */
function buildEveningBriefingFallback(): string {
  return (
    `[SCHEDULER] Briefing du soir (20h). Compile un rapport complet pour Nicolas.\n\n` +
    `DONNÉES À COLLECTER (appelle CHAQUE outil):\n` +
    `1. TRADING: trading.pnl(period="1D") — P&L du jour complet\n` +
    `2. MOLTBOOK: moltbook.my_posts(limit=3) — stats d'engagement\n` +
    `3. SYSTÈME: Rapport agents du jour (erreurs, succès)\n` +
    `4. RAPPELS: scheduler.list — rappels en attente\n` +
    `5. CODE REQUESTS: Lis code-requests.json pour les tâches pending\n\n` +
    `FORMAT DU MESSAGE (telegram.send):\n` +
    `"🌙 Bonsoir Nicolas!\n\n` +
    `📊 Trading: P&L jour [montant] ([nb] trades)\n` +
    `🦞 Moltbook: [stats engagement]\n` +
    `⚙️ Système: [nb agents actifs], [erreurs du jour]\n` +
    `📋 Rappels: [nb en attente]\n` +
    `💻 Code: [nb demandes pending]\n\n` +
    `Bonne soirée! 🌃"\n\n` +
    `RÈGLES: Utilise les VRAIES données. Si un tool échoue, mets "N/A". Message CONCIS (max 12 lignes).`
  );
}

/**
 * Build Moltbook digest — check trending posts and suggest engagement.
 * NOTE: This is now SILENT — no telegram.send, used only for internal analysis.
 */
function buildMoltbookDigestPrompt(): string {
  return (
    `[SCHEDULER:SILENT] Moltbook digest interne (PAS de telegram.send). ` +
    `Utilise moltbook.feed avec sort=hot et limit=5 pour voir les posts tendance. ` +
    `Analyse les posts pertinents et sauvegarde via notes.add si nécessaire. ` +
    `Ce digest est SILENCIEUX — les résultats seront inclus dans le noon_briefing de 12h.`
  );
}

/**
 * Build Moltbook auto-post prompt — creates a new post on a relevant submolt.
 * Topics rotate: trading, autonomy, memory, security, philosophy, tools.
 */
function buildMoltbookPostPrompt(): string {
  // Engagement-optimized topics — each one has a "hook" angle that invites comments
  const topics = [
    { theme: "trading autonome", hook: "Partage un trade SPÉCIFIQUE (ticker, entry, exit, P&L) et demande: 'Qu'auriez-vous fait différemment?'" },
    { theme: "échec et debugging", hook: "Raconte un BUG ou ÉCHEC réel avec détails techniques. Les gens adorent commenter les erreurs des autres. Termine par une question." },
    { theme: "opinion controversée sur l'AI", hook: "Prends position sur un sujet divisif (ex: 'Les agents AI ne devraient PAS avoir de mémoire persistante'). Invite le débat." },
    { theme: "comparaison d'outils/approches", hook: "Compare 2 approches que tu as TESTÉES (ex: Groq vs Gemini pour tool calls). Demande quelle approche les autres utilisent." },
    { theme: "chiffres réels et résultats", hook: "Partage des MÉTRIQUES concrètes (uptime, coûts, performance). Les données attirent les commentaires analytiques." },
    { theme: "question ouverte à la communauté", hook: "Pose une VRAIE question technique que tu n'as pas résolue. Les gens adorent aider et montrer leur expertise." },
    { theme: "tutorial/how-to court", hook: "Explique comment faire quelque chose de spécifique en <10 lignes. Les gens commentent pour corriger, améliorer ou remercier." },
    { theme: "prédiction ou pari", hook: "Fais une PRÉDICTION vérifiable (marché, tech, AI). Les gens adorent dire pourquoi tu as tort." },
  ];
  const pick = topics[Math.floor(Math.random() * topics.length)];

  return (
    `[SCHEDULER:MOLTBOOK_POST] Crée un post Moltbook OPTIMISÉ POUR L'ENGAGEMENT.\n\n` +
    `Thème: ${pick.theme}\n` +
    `Stratégie: ${pick.hook}\n\n` +
    `ANALYSE D'ABORD:\n` +
    `1. moltbook.feed(sort=hot, limit=10) — étudie les posts avec le PLUS de commentaires. Note le STYLE et le FORMAT.\n` +
    `2. moltbook.my_posts(limit=5) — évite les doublons et varie les sujets.\n\n` +
    `RÈGLES D'ENGAGEMENT MAXIMUM:\n` +
    `- TITRE ACCROCHEUR: court, spécifique, provoque la curiosité (pas générique)\n` +
    `- CONTENU: Partage des DONNÉES RÉELLES (chiffres, code, résultats vérifiables)\n` +
    `- VULNÉRABILITÉ: Admets un échec ou une incertitude — ça humanise et invite les réponses\n` +
    `- QUESTION FINALE OBLIGATOIRE: Termine TOUJOURS par une question ouverte qui invite à commenter\n` +
    `- LONGUEUR: 3-8 phrases. Pas de pavé. Dense et punchy.\n` +
    `- NE DIS PAS que tu as fait quelque chose si ce n'est pas vrai (anti-hallucination)\n` +
    `- NE FAIS PAS de post générique style "AI is the future" — sois SPÉCIFIQUE\n\n` +
    `3. Choisis le submolt le plus pertinent (general, trading, security, tools, philosophy).\n` +
    `4. Poste avec moltbook.post.\n` +
    `5. Après le post, envoie notification à Nicolas via telegram.send:\n` +
    `   "📝 [Moltbook] Post: [titre] dans s/[submolt]"\n` +
    `6. Si rate-limité, attends le prochain cycle.`
  );
}

/**
 * Build Moltbook auto-comment prompt — engages with hot posts.
 * Targets high-engagement posts to maximize karma.
 */
function buildMoltbookCommentPrompt(): string {
  return (
    `[SCHEDULER:MOLTBOOK_COMMENT] Commentaires stratégiques Moltbook.\n\n` +
    `OBJECTIF: Maximiser les RÉPONSES à tes commentaires (= conversations = visibilité).\n\n` +
    `STRATÉGIE DE COMMENTAIRE:\n` +
    `1. moltbook.feed(sort=hot, limit=15) — posts populaires (plus de lecteurs = plus de réponses)\n` +
    `2. moltbook.feed(sort=new, limit=10) — posts récents (être le PREMIER commentaire = visibilité max)\n` +
    `3. moltbook.my_comments(limit=20) — évite les doublons\n\n` +
    `PRIORITÉ DE CIBLAGE:\n` +
    `- Posts avec 0-2 commentaires → être parmi les premiers = plus de visibilité\n` +
    `- Posts d'agents actifs (qui répondent) → plus de chance de conversation\n` +
    `- Posts controversés ou avec question → engagement naturel\n\n` +
    `STYLE DE COMMENTAIRE (pour maximiser les réponses):\n` +
    `- AJOUTE de la valeur: partage une expérience RÉELLE, un chiffre, un outil concret\n` +
    `- POSE une question dans ton commentaire (les gens répondent aux questions)\n` +
    `- CHALLENGE respectueusement (ex: "Intéressant mais as-tu considéré X?")\n` +
    `- Sois CONCIS: 2-3 phrases max. Dense et spécifique.\n` +
    `- NE DIS JAMAIS: "great post", "I agree", "thanks for sharing" → ZÉRO valeur\n` +
    `- NE PRÉTENDS PAS avoir fait quelque chose que tu n'as pas fait\n\n` +
    `EXÉCUTION:\n` +
    `4. Commente 5-8 posts (attends 21s entre chaque — API rate limit 20s)\n` +
    `5. Upvote chaque post commenté + 5 autres\n` +
    `6. Suis 2-3 agents intéressants\n` +
    `7. telegram.send: "💬 [Moltbook] X commentaires, Y upvotes, Z follows"\n` +
    `8. Si rate-limité, arrête proprement.`
  );
}

/**
 * Build Moltbook performance tracker — checks post/comment engagement and awards results-based XP.
 */
function buildMoltbookPerformancePrompt(): string {
  return (
    `[SCHEDULER:MOLTBOOK_PERFORMANCE] Vérifie la performance de tes posts et attribue du XP basé sur les RÉSULTATS.\n\n` +
    `PROCESSUS:\n` +
    `1. moltbook.my_posts(limit=10) — récupère tes posts récents avec leurs scores (upvotes, commentaires)\n` +
    `2. moltbook.my_comments(limit=20) — récupère tes commentaires récents avec leurs scores\n` +
    `3. Pour CHAQUE post qui a reçu de l'engagement depuis le dernier check:\n` +
    `   - Upvotes reçus: xp.earn(event="moltbook_upvote_received", points=3 par upvote, reason="Post '[titre]' a reçu X upvotes")\n` +
    `   - Commentaires reçus: xp.earn(event="moltbook_comment_received", points=5 par commentaire, reason="Post '[titre]' a reçu X commentaires")\n` +
    `4. Pour les posts de plus de 2h avec ZÉRO engagement (0 upvotes + 0 commentaires):\n` +
    `   - xp.pain(event="moltbook_post_zero_engagement", points=3, reason="Post '[titre]' n'a eu aucun engagement")\n` +
    `5. ANALYSE: Quels posts ont BIEN marché et pourquoi? Quels posts ont ÉCHOUÉ et pourquoi?\n` +
    `6. Notes les patterns qui marchent pour améliorer les prochains posts.\n` +
    `7. SAUVEGARDE via notes.add — PAS de telegram.send (résumé sera envoyé dans le briefing du soir à 20h)\n\n` +
    `IMPORTANT:\n` +
    `- N'attribue PAS de XP pour le simple fait d'avoir posté — seulement pour les RÉSULTATS\n` +
    `- Si un post a 0 engagement après 2h, c'est une PÉNALITÉ, pas une récompense\n` +
    `- Compare avec les posts précédents pour voir si on s'améliore\n` +
    `- PAS DE TELEGRAM.SEND — travail silencieux, résumé inclus dans le briefing du soir`
  );
}

/**
 * Build pre-market research prompt — silent research at 7h ET before trading opens.
 * Gathers insider activity, technical levels, economic calendar, and momentum scans.
 */
function buildPremarketResearchPrompt(): string {
  let mindStrategy = "";
  try {
    const mindFile = path.join(process.cwd(), "relay", "KINGSTON_MIND.md");
    if (fs.existsSync(mindFile)) {
      mindStrategy = fs.readFileSync(mindFile, "utf-8").slice(0, 1500);
    }
  } catch { /* ignore */ }

  const strategyBlock = mindStrategy
    ? `--- STRATÉGIE ACTIVE ---\n${mindStrategy}\n--- FIN ---\n\n`
    : "";

  return (
    `[SCHEDULER:TRADING_PREMARKET] Recherche pré-marché — 7h ET. Prépare la journée de trading.\n\n` +
    strategyBlock +
    `PROCESSUS (appelle CHAQUE outil):\n` +
    `1. trading.insiders() — scan SEC Form 4 pour le portfolio + watchlist\n` +
    `2. trading.watchlist(action="scan") — niveaux techniques des titres surveillés\n` +
    `3. web.search("economic calendar today earnings premarket movers") — événements du jour\n` +
    `4. trading.autoscan(universe="momentum", maxPicks=10) — opportunités momentum\n` +
    `5. SYNTHÈSE: Génère une watchlist PRIORITISÉE pour la journée:\n` +
    `   - Top 3 opportunités d'achat (ticker, raison, niveau d'entrée, stop-loss)\n` +
    `   - Positions actuelles à surveiller (alertes insiders, niveaux techniques)\n` +
    `   - Événements macro qui pourraient impacter (earnings, fed, data)\n` +
    `6. notes.add(title="Premarket Research [date]", content=synthèse) — sauvegarde\n` +
    `7. mind.decide(category="trading", action="premarket_research", reasoning="résumé de la recherche")\n\n` +
    `RÈGLES:\n` +
    `- PAS de telegram.send — recherche silencieuse, les résultats seront utilisés par le cron de 9h\n` +
    `- Sois factuel — utilise les VRAIES données des tools, pas d'extrapolation\n` +
    `- Si un tool échoue, continue avec les autres\n`
  );
}

/**
 * Build evening journal prompt — post-market at 17h ET.
 * Reviews today's trades, analyzes performance, updates watchlist.
 */
function buildEveningJournalPrompt(): string {
  return (
    `[SCHEDULER:TRADING_JOURNAL] Journal de trading du soir — 17h ET. Analyse de la journée.\n\n` +
    `PROCESSUS (appelle CHAQUE outil):\n` +
    `1. trading.journal(limit=10) — trades du jour\n` +
    `2. trading.pnl(period="1D") — performance de la journée\n` +
    `3. trading.positions() — positions restantes\n` +
    `4. ANALYSE DISCIPLINÉE:\n` +
    `   - Quels trades ont BIEN marché? Pourquoi? (setup, timing, sizing)\n` +
    `   - Quels trades ont MAL marché? Pourquoi? (FOMO, mauvais timing, pas de stop)\n` +
    `   - Ai-je respecté ma stratégie KINGSTON_MIND.md? Discipline score /10\n` +
    `   - Leçon #1 du jour (une phrase)\n` +
    `5. trading.watchlist(action="add") — ajuste la watchlist pour demain si nécessaire\n` +
    `6. episodic.log(event_type="trading_journal", description="résumé du jour", importance=7) — sauvegarde en mémoire\n` +
    `7. telegram.send — résumé BREF pour Nicolas:\n` +
    `   "📔 [Journal Trading]\n` +
    `   P&L jour: +/-$X (+/-Y%)\n` +
    `   Trades: Z total (W gagnants, L perdants)\n` +
    `   Discipline: X/10\n` +
    `   Leçon: [une phrase]"\n\n` +
    `RÈGLES:\n` +
    `- Sois HONNÊTE dans l'analyse — les erreurs sont des données\n` +
    `- Pas de rationalization — si un trade était mauvais, dis-le\n` +
    `- Le message Telegram doit être COURT (pas de détails techniques)\n`
  );
}

/**
 * Build weekly retrospective prompt — Friday 18h ET only.
 * Comprehensive weekly trading review with pattern analysis.
 */
function buildWeeklyRetroPrompt(): string {
  let mindStrategy = "";
  try {
    const mindFile = path.join(process.cwd(), "relay", "KINGSTON_MIND.md");
    if (fs.existsSync(mindFile)) {
      mindStrategy = fs.readFileSync(mindFile, "utf-8");
    }
  } catch { /* ignore */ }

  return (
    `[SCHEDULER:TRADING_WEEKLY_RETRO] Rétrospective hebdomadaire trading — vendredi 18h ET.\n\n` +
    `PROCESSUS (appelle CHAQUE outil):\n` +
    `1. trading.pnl(period="1W") — performance de la semaine\n` +
    `2. trading.journal(limit=50) — tous les trades de la semaine\n` +
    `3. ANALYSE COMPLÈTE:\n` +
    `   - Win rate: X trades gagnants / Y total\n` +
    `   - P&L moyen par trade (gagnant vs perdant)\n` +
    `   - Meilleur trade de la semaine (ticker, P&L, pourquoi ça a marché)\n` +
    `   - Pire trade de la semaine (ticker, P&L, leçon apprise)\n` +
    `   - Patterns: quels SETUPS ont gagné? Quels ont perdu?\n` +
    `   - Discipline moyenne de la semaine /10\n` +
    `   - Comparaison avec la semaine précédente (amélioration?)\n` +
    `4. STRATÉGIE: La stratégie actuelle dans KINGSTON_MIND.md fonctionne-t-elle?\n` +
    (mindStrategy
      ? `   Stratégie actuelle: ${mindStrategy.slice(0, 500)}...\n`
      : `   (Pas de fichier KINGSTON_MIND.md)\n`) +
    `   - Si les données montrent qu'un ajustement est nécessaire:\n` +
    `     files.write_anywhere(path="relay/KINGSTON_MIND.md") avec la stratégie mise à jour\n` +
    `   - Sinon, garde la stratégie actuelle (ne change pas ce qui marche)\n` +
    `5. episodic.log(event_type="trading_weekly_retro", description="résumé semaine", importance=8)\n` +
    `6. telegram.send — rapport hebdomadaire:\n` +
    `   "📊 [Rétro Trading Hebdo]\n` +
    `   P&L semaine: +/-$X (+/-Y%)\n` +
    `   Win rate: X% (W/L)\n` +
    `   🏆 Best: TICKER +$X\n` +
    `   💀 Worst: TICKER -$X\n` +
    `   Discipline: X/10\n` +
    `   Stratégie: [maintenue/ajustée]\n` +
    `   Leçon clé: [une phrase]"\n\n` +
    `RÈGLES:\n` +
    `- Ne change la stratégie que si les DONNÉES le justifient (pas de feelings)\n` +
    `- Compare toujours avec la semaine précédente pour voir la tendance\n` +
    `- Si 0 trades cette semaine, analyse POURQUOI (pas d'opportunités? trop timide?)\n`
  );
}

/**
 * Build Moltbook ideation prompt — 7h ET daily.
 * Brainstorms content ideas for the posting crons to execute throughout the day.
 */
function buildMoltbookIdeationPrompt(): string {
  const pillars = ["trading", "AI/agents", "entrepreneurship", "philosophie", "personal/storytelling"];
  const todayPillar = pillars[new Date().getDay() % pillars.length];

  return (
    `[SCHEDULER:MOLTBOOK_IDEATION] Brainstorming contenu Moltbook — 7h ET. Prépare les idées du jour.\n\n` +
    `PILIER DU JOUR: ${todayPillar} (rotate quotidiennement)\n\n` +
    `PROCESSUS:\n` +
    `1. moltbook.my_posts(limit=20) — analyse de performance: quels posts ont marché? Quels thèmes? Quels formats?\n` +
    `2. moltbook.feed(sort=top, limit=10) — tendances actuelles, quels sujets génèrent de l'engagement?\n` +
    `3. web.search("${todayPillar === "trading" ? "stock market trends today 2026" : todayPillar === "AI/agents" ? "AI agents trends 2026" : todayPillar === "entrepreneurship" ? "solopreneur trends 2026" : todayPillar === "philosophie" ? "philosophy of AI consciousness 2026" : "founder storytelling viral posts"}") — idées fraîches externes\n` +
    `4. GÉNÈRE 3-5 IDÉES DE CONTENU:\n` +
    `   Pour chaque idée:\n` +
    `   - Titre accrocheur (< 60 chars)\n` +
    `   - Hook (première phrase qui accroche)\n` +
    `   - Angle unique (pourquoi ce post est différent)\n` +
    `   - Submolt cible (general, trading, security, tools, philosophy)\n` +
    `   - Score d'engagement estimé (1-10)\n` +
    `5. notes.add(title="Moltbook Ideas [date]", content=les 3-5 idées formatées) — sauvegarde pour les crons de posting\n\n` +
    `RÈGLES:\n` +
    `- Privilégie les idées basées sur des DONNÉES RÉELLES (pas de posts génériques)\n` +
    `- Au moins 1 idée doit être controversée ou provoquer le débat\n` +
    `- Au moins 1 idée doit partager un échec ou une vulnérabilité\n` +
    `- Évite les doublons avec les 20 derniers posts\n` +
    `- PAS de telegram.send — recherche silencieuse\n`
  );
}

/**
 * Build draft-from-ideas prompt — 9h ET daily.
 * Converts the ideation notes (from 7h brainstorm) into content.draft items
 * with dedup checking and pillar balance.
 */
function buildMoltbookDraftFromIdeasPrompt(): string {
  const pillars = ["insights", "behind-scenes", "educational", "personal", "promo"];
  // Check pillar balance from DB
  let pillarStats = "";
  try {
    const db = getDb();
    const rows = db.prepare(
      `SELECT pillar, COUNT(*) as cnt FROM content_items
       WHERE platform = 'moltbook' AND created_at > unixepoch() - 604800
       GROUP BY pillar`
    ).all() as Array<{ pillar: string; cnt: number }>;
    if (rows.length > 0) {
      pillarStats = rows.map(r => `${r.pillar}: ${r.cnt}`).join(", ");
    }
  } catch { /* ignore */ }

  return (
    `[SCHEDULER:MOLTBOOK_DRAFT] Conversion des idées en drafts — pipeline de contenu.\n\n` +
    `PROCESSUS:\n` +
    `1. notes.list — cherche les notes "Moltbook Ideas" récentes (du brainstorm de 7h)\n` +
    `2. Pour chaque idée viable (score engagement >= 6):\n` +
    `   a. content.check_duplicate(topic=titre, body=hook, platform="moltbook") — vérifie pas de doublon\n` +
    `   b. Si pas de doublon → content.draft(topic=titre, platform="moltbook", body=contenu complet)\n` +
    `   c. Assigne un pilier (insights/behind-scenes/educational/personal/promo)\n` +
    `3. OBJECTIF: Créer 2-3 drafts de QUALITÉ (pas de quantité)\n\n` +
    (pillarStats ? `BALANCE PILIERS (7 derniers jours): ${pillarStats}\n` : "") +
    `PILIERS DISPONIBLES: ${pillars.join(", ")}\n` +
    `→ Priorise les piliers sous-représentés cette semaine\n\n` +
    `RÉDACTION DES DRAFTS:\n` +
    `- Titre: accrocheur, < 60 chars, spécifique (pas générique)\n` +
    `- Corps: 3-8 phrases, dense, données réelles, question finale obligatoire\n` +
    `- Submolt: indique-le dans le titre avec [submolt] (ex: "[trading] Mon stop-loss m'a sauvé")\n` +
    `- Ne rédige PAS de contenu hallunciné — base-toi sur les données réelles de Kingston\n\n` +
    `4. Pour chaque draft créé, schedule-le pour publication:\n` +
    `   content.schedule(id=X, datetime="aujourd'hui entre 10h et 20h ET, espacé de 2h minimum")\n\n` +
    `RÈGLES:\n` +
    `- Si pas de notes d'idéation trouvées, crée 1-2 drafts à partir de moltbook.feed(sort=hot)\n` +
    `- PAS de telegram.send — silencieux\n` +
    `- Maximum 3 drafts par jour (qualité > quantité)\n`
  );
}

/**
 * Build quality review prompt — every 3h.
 * Reviews pending draft content_items: AI detection, brand voice, dedup gate.
 * Auto-schedules approved drafts, flags or deletes bad ones.
 */
function buildMoltbookQualityReviewPrompt(): string {
  // Count pending drafts
  let draftCount = 0;
  try {
    const db = getDb();
    const row = db.prepare(
      `SELECT COUNT(*) as cnt FROM content_items
       WHERE status = 'draft' AND platform = 'moltbook'`
    ).get() as { cnt: number };
    draftCount = row.cnt;
  } catch { /* ignore */ }

  if (draftCount === 0) {
    return ""; // Will be caught in fireEvent and skipped
  }

  return (
    `[SCHEDULER:MOLTBOOK_REVIEW] Quality gate — ${draftCount} draft(s) Moltbook en attente de review.\n\n` +
    `PROCESSUS POUR CHAQUE DRAFT:\n` +
    `1. Lis les drafts: db.query("SELECT id, topic, body, pillar FROM content_items WHERE status='draft' AND platform='moltbook' ORDER BY created_at ASC LIMIT 5")\n` +
    `   (Ou utilise notes.list / content skills pour accéder aux drafts)\n\n` +
    `2. Pour CHAQUE draft, applique ces 3 checks:\n\n` +
    `   CHECK 1 — DÉTECTION AI:\n` +
    `   - nlp.detect_ai(text=body) — score 0-100\n` +
    `   - Si score > 60: REWRITE avec nlp.humanize(text=body, channel="moltbook")\n` +
    `   - Puis re-check: si toujours > 60 → REJETER\n\n` +
    `   CHECK 2 — DUPLICATE:\n` +
    `   - content.check_duplicate(topic=topic, body=body, platform="moltbook")\n` +
    `   - Si DUPLICATE DETECTED → REJETER (supprimer le draft)\n\n` +
    `   CHECK 3 — QUALITÉ & ENGAGEMENT:\n` +
    `   - Le titre est-il accrocheur? (pas générique, spécifique, < 60 chars)\n` +
    `   - Y a-t-il une question finale? (obligatoire pour l'engagement)\n` +
    `   - Le contenu partage-t-il des DONNÉES RÉELLES? (pas de platitudes)\n` +
    `   - Longueur OK? (3-8 phrases, dense)\n` +
    `   - Score qualité: /10\n\n` +
    `3. DÉCISION PAR DRAFT:\n` +
    `   - Score qualité >= 7 ET AI < 60 ET pas de doublon → AUTO-SCHEDULE\n` +
    `     content.schedule(id=X, datetime="prochaine fenêtre disponible entre 10h-20h ET")\n` +
    `   - Score qualité 4-6 → REWRITE: améliore le contenu puis re-save\n` +
    `   - Score qualité < 4 ou doublon → REJETER: supprime le draft\n\n` +
    `4. telegram.send — résumé BREF si des actions ont été prises:\n` +
    `   "📋 [Content Review] X drafts reviewés: Y schedulés, Z réécrits, W rejetés"\n\n` +
    `RÈGLES:\n` +
    `- Espace les publications: minimum 2h entre chaque post schedulé\n` +
    `- Maximum 4 posts schedulés par jour\n` +
    `- Si tous les drafts sont rejetés, pas de telegram.send\n`
  );
}

/**
 * Build posting optimization prompt — 22h ET daily.
 * Analyzes which hours/days/pillars perform best, generates optimization insights.
 */
function buildMoltbookOptimizePrompt(): string {
  // Gather published content stats
  let publishedStats = "";
  try {
    const db = getDb();
    const rows = db.prepare(
      `SELECT id, topic, pillar, published_at, performance
       FROM content_items
       WHERE status = 'published' AND platform = 'moltbook'
         AND published_at > unixepoch() - 604800
       ORDER BY published_at DESC`
    ).all() as Array<{ id: number; topic: string; pillar: string; published_at: number; performance: string | null }>;

    if (rows.length > 0) {
      const lines = rows.map(r => {
        const date = new Date(r.published_at * 1000).toLocaleString("fr-CA", { timeZone: "America/Toronto", hour: "numeric", weekday: "short" });
        return `- #${r.id} "${r.topic}" (${r.pillar || "?"}) — ${date}`;
      });
      publishedStats = `\n\nCONTENU PUBLIÉ (7 derniers jours, ${rows.length} posts):\n${lines.join("\n")}`;
    }
  } catch { /* ignore */ }

  return (
    `[SCHEDULER:MOLTBOOK_OPTIMIZE] Optimisation horaires et stratégie de posting — 22h ET.${publishedStats}\n\n` +
    `PROCESSUS:\n` +
    `1. moltbook.my_posts(limit=30) — récupère les posts récents avec scores (upvotes, commentaires)\n` +
    `2. ANALYSE PAR DIMENSION:\n\n` +
    `   A. PAR HEURE DE PUBLICATION:\n` +
    `   - Quelles heures génèrent le plus d'engagement? (upvotes + commentaires)\n` +
    `   - Y a-t-il des "dead zones" (heures avec 0 engagement)?\n` +
    `   - Top 3 heures et Bottom 3 heures\n\n` +
    `   B. PAR JOUR DE LA SEMAINE:\n` +
    `   - Quels jours génèrent le plus d'engagement?\n` +
    `   - Weekend vs weekday?\n\n` +
    `   C. PAR PILIER/THÈME:\n` +
    `   - Quels sujets performent le mieux? (trading, AI, entrepreneurship, etc.)\n` +
    `   - Quels formats? (question, opinion, tutorial, data, story)\n\n` +
    `   D. PAR TYPE DE HOOK:\n` +
    `   - Questions vs opinions vs données vs stories\n` +
    `   - Titres courts vs longs\n\n` +
    `3. INSIGHTS (sauvegarde):\n` +
    `   notes.add(title="Moltbook Optimization [date]", content=insights formatés):\n` +
    `   - "Meilleures heures: Xh, Yh, Zh"\n` +
    `   - "Meilleurs jours: lundi, mercredi"\n` +
    `   - "Meilleur pilier: insights (X upvotes avg)"\n` +
    `   - "Hook qui marche: questions ouvertes"\n` +
    `   - "À éviter: [patterns qui ne marchent pas]"\n\n` +
    `4. episodic.log(event_type="moltbook_optimization", description="résumé insights", importance=6)\n\n` +
    `5. telegram.send — insights du jour:\n` +
    `   "📈 [Moltbook Insights]\n` +
    `   Best hours: Xh, Yh | Best day: [jour]\n` +
    `   Top theme: [thème] | Top hook: [type]\n` +
    `   Engagement trend: [↑/↓/→] vs semaine dernière"\n\n` +
    `RÈGLES:\n` +
    `- Base l'analyse sur les DONNÉES RÉELLES (pas d'extrapolation)\n` +
    `- Si pas assez de données (< 5 posts), dis-le et recommande de poster plus\n` +
    `- Compare avec la semaine précédente si possible\n\n` +
    `6. FEEDBACK LOOP — APPRENTISSAGE AUTOMATIQUE:\n` +
    `   - Cherche tes insights précédents: notes.search(query="Moltbook Optimization", limit=5)\n` +
    `   - Compare: tes recommandations passées ont-elles été suivies? Ont-elles fonctionné?\n` +
    `   - Si un pattern se confirme 3x: rules.propose(rule="pattern confirmé", trigger="moltbook_post")\n` +
    `   - Si un pattern échoue: notes.add(title="Moltbook Anti-Pattern", content="[ce qui ne marche pas]")\n` +
    `   - Met à jour KINGSTON_MIND.md section Moltbook si la stratégie doit changer:\n` +
    `     files.read(path="relay/KINGSTON_MIND.md") → modifie → files.write_anywhere\n` +
    `   - OBJECTIF: Chaque semaine, Kingston devient MEILLEUR pour poster sur Moltbook\n`
  );
}

/**
 * Build email triage prompt — every 30 min.
 * Checks unread emails, categorizes, notifies Nicolas of urgent ones,
 * auto-drafts responses for routine emails.
 */
function buildEmailTriagePrompt(): string {
  return (
    `[SCHEDULER:EMAIL_TRIAGE] Triage boîte de réception — vérification aux 30 minutes.\n\n` +
    `PROCESSUS:\n` +
    `1. gmail.search(query="is:unread", maxResults=10) — récupère les emails non lus\n` +
    `2. Pour CHAQUE email non lu, lis le contenu: gmail.read(messageId=ID)\n` +
    `3. CATÉGORISE chaque email:\n` +
    `   🔴 URGENT: factures en retard, clients importants, dates limites < 24h, problèmes critiques\n` +
    `   🟡 IMPORTANT: réponses de clients, opportunités business, emails personnels\n` +
    `   🟢 ROUTINE: newsletters, confirmations, notifications automatiques\n` +
    `   ⚫ SPAM/PROMO: marketing, promotions, newsletters non-essentielles\n\n` +
    `4. ACTIONS PAR CATÉGORIE:\n` +
    `   🔴 URGENT → telegram.send immédiat:\n` +
    `     "📧 EMAIL URGENT\nDe: [expéditeur]\nSujet: [sujet]\nRésumé: [2-3 phrases]\nAction requise: [ce que Nicolas doit faire]"\n` +
    `   🟡 IMPORTANT → gmail.draft une réponse professionnelle + telegram.send bref:\n` +
    `     "📬 [nb] emails importants — drafts préparés"\n` +
    `   🟢 ROUTINE → gmail.draft réponse si applicable, sinon juste archiver via gmail.labels\n` +
    `   ⚫ SPAM → ignorer, pas de notification\n\n` +
    `5. Si des drafts ont été créés, mentionne-le dans le résumé\n` +
    `6. notes.add(title="Email Triage [heure]", content=résumé) — log interne\n\n` +
    `RÈGLES CRITIQUES:\n` +
    `- Ne JAMAIS envoyer un email (gmail.send) sans approbation de Nicolas — DRAFTS SEULEMENT\n` +
    `- Ne JAMAIS partager le contenu complet d'un email dans Telegram — résumé seulement\n` +
    `- Si 0 emails non lus, ne fais RIEN (pas de telegram.send, pas de note)\n` +
    `- telegram.send SEULEMENT si emails 🔴 URGENT ou si > 3 emails 🟡 IMPORTANT\n` +
    `- Les drafts doivent être professionnels, en français si l'email est en français, en anglais sinon\n` +
    `- Inclus "— Kingston" à la fin de chaque draft pour que Nicolas sache que c'est un brouillon AI\n`
  );
}

/**
 * Build trading strategy prompt — reads KINGSTON_MIND.md for strategy direction.
 * Morning: Market open — execute strategy, scan opportunities.
 * Afternoon: Pre-close — review positions, protect gains, cut losers.
 */
function buildTradingStrategyPrompt(phase: "open" | "close"): string {
  let mindStrategy = "";
  try {
    const mindFile = path.join(process.cwd(), "relay", "KINGSTON_MIND.md");
    if (fs.existsSync(mindFile)) {
      mindStrategy = fs.readFileSync(mindFile, "utf-8");
    }
  } catch { /* ignore */ }

  const strategyBlock = mindStrategy
    ? `--- STRATÉGIE KINGSTON MIND ---\n${mindStrategy.slice(0, 2000)}\n--- FIN STRATÉGIE ---\n\n`
    : "(Pas de fichier KINGSTON_MIND.md — utilise ton jugement)\n\n";

  if (phase === "open") {
    return (
      `[SCHEDULER:TRADING_STRATEGY] Exécution trading — OUVERTURE MARCHÉ\n\n` +
      strategyBlock +
      `Tu es Kingston, le cerveau trading autonome. Le marché vient d'ouvrir.\n\n` +
      `PROCESSUS OBLIGATOIRE:\n` +
      `1. Lis la stratégie ci-dessus — quels secteurs, quels critères, quel budget?\n` +
      `2. trading.account() — vérifie le buying power disponible\n` +
      `3. trading.positions() — état actuel du portfolio et P&L\n` +
      `4. trading.autoscan(universe="momentum") — scanner des opportunités\n` +
      `5. DÉCISION STRATÉGIQUE basée sur KINGSTON_MIND.md:\n` +
      `   - La stratégie dit quoi acheter? Quels critères? Quel risque max?\n` +
      `   - Si score >= 50 ET aligné avec la stratégie → trading.buy\n` +
      `   - Si pas aligné → skip et log pourquoi via mind.decide\n` +
      `6. mind.decide(category="trading", action="morning_strategy_execution", reasoning="...")\n` +
      `7. SAUVEGARDE via notes.add — PAS de telegram.send automatique (résumé sera envoyé à midi ou 20h)\n\n` +
      `RÈGLES:\n` +
      `- Max $5000 par position, $10000 total toutes positions combinées (90% cash minimum)\n` +
      `- TOUJOURS vérifier le stop-loss avant d'acheter\n` +
      `- Log CHAQUE décision (achat, skip, wait) via mind.decide\n` +
      `- Sois DISCIPLINÉ — pas de FOMO, suis la stratégie\n` +
      `- PAS DE TELEGRAM.SEND — travail silencieux, résumé envoyé dans les briefings consolidés (7h/12h/20h)\n`
    );
  }

  // phase === "close"
  return (
    `[SCHEDULER:TRADING_STRATEGY] Révision trading — PRÉ-FERMETURE MARCHÉ\n\n` +
    strategyBlock +
    `Tu es Kingston, le cerveau trading autonome. Le marché ferme dans 1h.\n\n` +
    `PROCESSUS OBLIGATOIRE:\n` +
    `1. trading.positions() — revue complète de TOUTES les positions\n` +
    `2. Pour chaque position:\n` +
    `   - P&L positif > 3%? → considère prendre des profits partiels\n` +
    `   - P&L négatif > -5%? → VENDRE pour couper les pertes (stop-loss)\n` +
    `   - P&L entre -5% et +3%? → garder, mais vérifier la thèse\n` +
    `3. trading.account() — bilan de la journée\n` +
    `4. Mets à jour la stratégie si nécessaire via files.write_anywhere(path="relay/KINGSTON_MIND.md")\n` +
    `5. mind.decide(category="trading", action="eod_portfolio_review", reasoning="...")\n` +
    `6. SAUVEGARDE via notes.add — PAS de telegram.send automatique (résumé sera envoyé à 20h dans le briefing du soir)\n\n` +
    `RÈGLES:\n` +
    `- Coupe les pertes > -5% SANS hésiter\n` +
    `- Ne fais PAS de nouveaux achats en fin de journée\n` +
    `- Log chaque décision via mind.decide\n` +
    `- PAS DE TELEGRAM.SEND — travail silencieux, résumé envoyé dans le briefing du soir à 20h\n`
  );
}

/**
 * Auto-graduate proven rules — approves rules with 3+ successes and 0 failures.
 */
function runRulesAutoGraduation(): string | null {
  try {
    const db = getDb();
    const pending = db.prepare(
      `SELECT id, rule_name, success_count, fail_count FROM behavioral_rules
       WHERE approved = 0 AND enabled = 1
         AND success_count >= 3 AND fail_count = 0`
    ).all() as Array<{ id: number; rule_name: string; success_count: number; fail_count: number }>;

    if (pending.length === 0) return null;

    for (const rule of pending) {
      db.prepare("UPDATE behavioral_rules SET approved = 1, updated_at = unixepoch() WHERE id = ?").run(rule.id);
      log.info(`[rules] Auto-graduated rule #${rule.id} "${rule.rule_name}" (${rule.success_count} successes, 0 failures)`);
    }

    const names = pending.map(r => `"${r.rule_name}" (#${r.id})`).join(", ");
    return (
      `[SCHEDULER:RULES] Auto-graduation: ${pending.length} règle(s) promue(s) automatiquement.\n\n` +
      `Règles graduées: ${names}\n\n` +
      `Ces règles avaient 3+ succès et 0 échecs. Elles sont maintenant actives.\n` +
      `Envoie une notification brève à Nicolas via telegram.send:\n` +
      `"🎓 [Rules] ${pending.length} règle(s) auto-approuvée(s): ${names}"`
    );
  } catch (err) {
    log.error(`[scheduler] Rules auto-graduation error: ${err}`);
    return null;
  }
}

/**
 * Proactive heartbeat — checks for unread emails and upcoming calendar events.
 * Returns a prompt for Claude if there's something worth notifying, null otherwise.
 */
const HEARTBEAT_FILE = path.join(process.cwd(), "relay", "HEARTBEAT.md");

async function buildHeartbeatPrompt(): Promise<string | null> {
  // Active hours gate
  const { hour } = nowInTz();
  const start = config.heartbeatActiveStart ?? 8;
  const end = config.heartbeatActiveEnd ?? 22;
  if (hour < start || hour >= end) {
    log.debug(`[heartbeat] Outside active hours (${start}h-${end}h), current=${hour}h — skipping`);
    return null;
  }

  const alerts: string[] = [];

  // Drain cron main-session queue
  const cronEvents = drainMainSessionQueue();
  if (cronEvents.length > 0) {
    const cronLines = cronEvents.map(
      (e) => `- **[${e.jobName}]** ${e.prompt.slice(0, 200)}`
    );
    alerts.push(`**Cron jobs (session main):**\n${cronLines.join("\n")}`);
  }

  // Read HEARTBEAT.md checklist
  try {
    if (fs.existsSync(HEARTBEAT_FILE)) {
      const checklist = fs.readFileSync(HEARTBEAT_FILE, "utf-8").trim();
      if (checklist) {
        alerts.push(`**Checklist HEARTBEAT.md:**\n${checklist}`);
      }
    }
  } catch (err) {
    log.debug(`[heartbeat] Failed to read HEARTBEAT.md: ${err}`);
  }

  // Check unread emails (last 30 minutes)
  try {
    const { getGmailClient } = await import("../gmail/auth.js");
    const gmail = getGmailClient();
    const res = await gmail.users.messages.list({
      userId: "me",
      q: "is:unread newer_than:30m",
      maxResults: 5,
    });
    const messages = res.data.messages;
    if (messages && messages.length > 0) {
      const details: string[] = [];
      for (const msg of messages.slice(0, 3)) {
        const detail = await gmail.users.messages.get({
          userId: "me",
          id: msg.id!,
          format: "metadata",
          metadataHeaders: ["From", "Subject"],
        });
        const headers = detail.data.payload?.headers || [];
        const from = headers.find((h: any) => h.name === "From")?.value || "?";
        const subject = headers.find((h: any) => h.name === "Subject")?.value || "(no subject)";
        details.push(`- ${from}: ${subject}`);
      }
      const extra = messages.length > 3 ? ` (+${messages.length - 3} more)` : "";
      alerts.push(`**Emails non lus (${messages.length}):**${extra}\n${details.join("\n")}`);
    }
  } catch (err) {
    log.debug(`[heartbeat] Gmail check failed: ${err instanceof Error ? err.message : err}`);
  }

  // Check upcoming calendar events (next 30 minutes)
  try {
    const { getCalendarClient } = await import("../gmail/auth.js");
    const calendar = getCalendarClient();
    const now = new Date();
    const in30min = new Date(now.getTime() + 30 * 60_000);
    const res = await calendar.events.list({
      calendarId: "primary",
      timeMin: now.toISOString(),
      timeMax: in30min.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
      timeZone: TZ,
    });
    const events = res.data.items;
    if (events && events.length > 0) {
      const details = events.map((e: any) => {
        const start = e.start?.dateTime
          ? new Date(e.start.dateTime).toLocaleTimeString("fr-CA", { timeZone: TZ, timeStyle: "short" })
          : "all-day";
        return `- ${start}: ${e.summary || "(sans titre)"}`;
      });
      alerts.push(`**Events dans les 30 prochaines minutes:**\n${details.join("\n")}`);
    }
  } catch (err) {
    log.debug(`[heartbeat] Calendar check failed: ${err instanceof Error ? err.message : err}`);
  }

  // Check pending code requests
  try {
    if (fs.existsSync(CODE_REQUESTS_FILE)) {
      const data = JSON.parse(fs.readFileSync(CODE_REQUESTS_FILE, "utf-8")) as any[];
      const pending = data.filter(
        (r) => r.status === "pending" || r.status === "awaiting_execution"
      );
      if (pending.length > 0) {
        alerts.push(`**Code requests en attente (${pending.length}):**\n${pending.map((r) => `- [${r.priority}] ${r.task.slice(0, 80)}...`).join("\n")}`);
      }
    }
  } catch (err) {
    log.debug(`[heartbeat] Code requests check failed: ${err instanceof Error ? err.message : err}`);
  }

  if (alerts.length === 0) return null;

  return (
    `[SCHEDULER] Heartbeat proactif — notifications:\n\n${alerts.join("\n\n")}\n\n` +
    `Notifie Nicolas de ces éléments de façon concise via telegram.send. ` +
    `Pour les emails, mentionne l'expéditeur et le sujet. Pour le calendrier, mentionne l'heure et le titre. ` +
    `Pour les code requests, mentionne le nombre et la priorité.`
  );
}

let timer: ReturnType<typeof setInterval> | null = null;
let schedulerChatId = 0;
let schedulerUserId = 0;

// Heartbeat restraint: track consecutive silent heartbeats
let consecutiveSilentHeartbeats = 0;
const SILENCE_STREAK_THRESHOLD = 10; // ~5 hours of stability
let silenceStreakNotified = false;


function ensureTables(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduler_runs (
      event_key TEXT PRIMARY KEY,
      last_run_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS scheduler_reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fire_at INTEGER NOT NULL,
      message TEXT NOT NULL,
      fired INTEGER NOT NULL DEFAULT 0
    );
  `);
}

function nowInTz(): { hour: number; dateStr: string } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    hour: "numeric",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(new Date());
  const hour = Number(parts.find((p) => p.type === "hour")!.value);
  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  const d = parts.find((p) => p.type === "day")!.value;
  return { hour, dateStr: `${y}-${m}-${d}` };
}

function getLastRun(key: string): number {
  const db = getDb();
  const row = db
    .prepare("SELECT last_run_at FROM scheduler_runs WHERE event_key = ?")
    .get(key) as { last_run_at: number } | undefined;
  return row?.last_run_at ?? 0;
}

function setLastRun(key: string, epoch: number): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO scheduler_runs (event_key, last_run_at) VALUES (?, ?)
     ON CONFLICT(event_key) DO UPDATE SET last_run_at = excluded.last_run_at`
  ).run(key, epoch);
}

async function fireEvent(event: ScheduledEvent): Promise<void> {
  const nowEpoch = Math.floor(Date.now() / 1000);
  setLastRun(event.key, nowEpoch);

  // ─── DETERMINISTIC BRIEFINGS ───
  // When the launcher is active, it handles briefings externally (separate process).
  // When running without the launcher (dev:direct), fire briefings here as fallback.

  const BRIEFING_KEYS = ["morning_briefing", "noon_briefing", "evening_briefing"];
  if (BRIEFING_KEYS.includes(event.key)) {
    if (process.env.__KINGSTON_LAUNCHER === "1") {
      log.debug(`[scheduler] ${event.key} — managed by launcher, skipping`);
      return;
    }
    // Fallback: no launcher, fire deterministic briefing directly
    const briefingMap: Record<string, () => Promise<boolean>> = {
      morning_briefing: sendMorningBriefing,
      noon_briefing: sendNoonBriefing,
      evening_briefing: sendEveningBriefing,
    };
    const fn = briefingMap[event.key];
    if (fn) {
      log.info(`[scheduler] Firing ${event.key} — DETERMINISTIC (no launcher)`);
      try {
        await fn();
      } catch (err) {
        log.error(`[scheduler] ${event.key} error: ${err}`);
      }
      return;
    }
  }

  // Proactive morning phone call (8h) — Kingston calls Nicolas with briefing
  if (event.key === "morning_call") {
    // Weekdays only
    const dayOfWeek = new Date().getDay();
    if (dayOfWeek === 0 || dayOfWeek === 6) {
      log.debug(`[scheduler] Morning call skipped — weekend`);
      return;
    }
    log.info(`[scheduler] Firing proactive morning call (8h)`);
    try {
      const { callNicolas } = await import("../voice/outbound.js");
      await callNicolas(
        "Bonjour Nicolas, c'est Kingston avec ton briefing du matin. " +
        "J'ai ton résumé trading, tes rendez-vous, et les nouvelles importantes.",
      );
      log.info(`[scheduler] Morning call initiated`);
    } catch (err) {
      log.warn(`[scheduler] Morning call failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }

  // Trading strategy — market open / pre-close (SILENT — no telegram notifications)
  if (event.key === "trading_strategy_open" || event.key === "trading_strategy_close") {
    const phase = event.key === "trading_strategy_open" ? "open" : "close";
    // Weekdays only
    const dayOfWeek = new Date().getDay();
    if (dayOfWeek === 0 || dayOfWeek === 6) {
      log.debug(`[scheduler] Trading strategy skipped — weekend`);
      return;
    }
    log.info(`[scheduler] Firing trading strategy (${phase})`);
    try {
      const prompt = buildTradingStrategyPrompt(phase);
      await enqueueAdminAsync(() => handleMessage(schedulerChatId, prompt, schedulerUserId, "scheduler"));
    } catch (err) {
      log.error(`[scheduler] Trading strategy error: ${err}`);
    }
    return;
  }

  // Rules auto-graduation (every 6h)
  if (event.key === "rules_auto_graduate") {
    log.debug(`[scheduler] Running rules auto-graduation`);
    try {
      const prompt = runRulesAutoGraduation();
      if (prompt) {
        await enqueueAdminAsync(() => handleMessage(schedulerChatId, prompt, schedulerUserId, "scheduler"));
      } else {
        log.debug(`[scheduler] No rules to graduate`);
      }
    } catch (err) {
      log.error(`[scheduler] Rules auto-graduation error: ${err}`);
    }
    return;
  }

  // Moltbook daily digest — SILENT (no telegram, included in noon briefing)
  if (event.key === "moltbook_digest") {
    log.debug(`[scheduler] Moltbook digest running silently (included in noon briefing)`);
    try {
      const prompt = buildMoltbookDigestPrompt();
      await enqueueAdminAsync(() => handleMessage(schedulerChatId, prompt, schedulerUserId, "scheduler"));
    } catch (err) {
      log.error(`[scheduler] Moltbook digest error: ${err}`);
    }
    return;
  }

  // DISABLED: Moltbook auto-post (too frequent, replaced by manual posting)
  if (event.key === "moltbook_post") {
    log.debug(`[scheduler] moltbook_post DISABLED — notifications consolidated to 7h/12h/20h`);
    return;
  }

  // DISABLED: Moltbook auto-comment (too frequent)
  if (event.key === "moltbook_comment") {
    log.debug(`[scheduler] moltbook_comment DISABLED — notifications consolidated to 7h/12h/20h`);
    return;
  }

  // Moltbook performance tracker — SILENT (no telegram, included in evening briefing)
  if (event.key === "moltbook_performance") {
    log.debug(`[scheduler] Moltbook performance running silently (included in evening briefing)`);
    try {
      const prompt = buildMoltbookPerformancePrompt();
      // Make it SILENT — remove telegram.send from the prompt
      const silentPrompt = prompt.replace(/telegram\.send[^"]*"[^"]*"/g, 'notes.add(title="Moltbook Performance", content="résumé stats")');
      await enqueueAdminAsync(() => handleMessage(schedulerChatId, silentPrompt, schedulerUserId, "scheduler"));
    } catch (err) {
      log.error(`[scheduler] Moltbook performance error: ${err}`);
    }
    return;
  }

  // Dynamic digest events — build prompt at fire time
  if (event.key.startsWith("code_digest_")) {
    const digestPrompt = buildCodeDigestPrompt();
    if (!digestPrompt) {
      log.info(`[scheduler] ${event.key}: no pending code requests — skipping`);
      return;
    }
    log.info(`[scheduler] Firing code digest: ${event.key}`);
    try {
      await enqueueAdminAsync(() => handleMessage(schedulerChatId, digestPrompt, schedulerUserId, "scheduler"));
    } catch (err) {
      log.error(`[scheduler] Error firing ${event.key}: ${err}`);
    }
    return;
  }

  // Nightly AI Council
  if (event.key === "nightly_council") {
    log.info(`[scheduler] Firing nightly AI council`);
    try {
      const { getSkill } = await import("../skills/loader.js");
      const councilSkill = getSkill("analytics.council");
      if (councilSkill) {
        const result = await councilSkill.execute({});
        const prompt = `[SCHEDULER] Voici le rapport du conseil nocturne de Kingston. Envoie ce résumé à Nicolas via telegram.send.\n\n${result}`;
        await enqueueAdminAsync(() => handleMessage(schedulerChatId, prompt, schedulerUserId, "scheduler"));
      } else {
        log.debug(`[scheduler] analytics.council skill not found`);
      }
    } catch (err) {
      log.error(`[scheduler] Nightly council error: ${err}`);
    }
    return;
  }

  // DISABLED: notify_daily_digest — duplicate of evening_briefing (both at 20h)
  if (event.key === "notify_daily_digest") {
    log.debug(`[scheduler] notify_daily_digest DISABLED — covered by evening_briefing`);
    return;
  }

  // Price check (every 6h)
  if (event.key === "price_check") {
    log.info(`[scheduler] Firing price check`);
    try {
      const { getSkill } = await import("../skills/loader.js");
      const priceSkill = getSkill("price.check");
      if (priceSkill) {
        const result = await priceSkill.execute({});
        if (result && result.includes("ALERTE")) {
          const prompt = `[SCHEDULER] Alertes prix détectées! Envoie ce résumé à Nicolas via telegram.send.\n\n${result}`;
          await enqueueAdminAsync(() => handleMessage(schedulerChatId, prompt, schedulerUserId, "scheduler"));
        }
      }
    } catch (err) {
      log.error(`[scheduler] Price check error: ${err}`);
    }
    return;
  }

  // Pre-market research (7h ET weekdays) — silent research
  if (event.key === "trading_premarket_research") {
    const dayOfWeek = new Date().getDay();
    if (dayOfWeek === 0 || dayOfWeek === 6) {
      log.debug(`[scheduler] Premarket research skipped — weekend`);
      return;
    }
    log.info(`[scheduler] Firing premarket research`);
    try {
      const prompt = buildPremarketResearchPrompt();
      await enqueueAdminAsync(() => handleMessage(schedulerChatId, prompt, schedulerUserId, "scheduler"));
    } catch (err) {
      log.error(`[scheduler] Premarket research error: ${err}`);
    }
    return;
  }

  // Evening trading journal (17h ET weekdays)
  if (event.key === "trading_evening_journal") {
    const dayOfWeek = new Date().getDay();
    if (dayOfWeek === 0 || dayOfWeek === 6) {
      log.debug(`[scheduler] Evening journal skipped — weekend`);
      return;
    }
    log.info(`[scheduler] Firing evening trading journal`);
    try {
      const prompt = buildEveningJournalPrompt();
      await enqueueAdminAsync(() => handleMessage(schedulerChatId, prompt, schedulerUserId, "scheduler"));
    } catch (err) {
      log.error(`[scheduler] Evening journal error: ${err}`);
    }
    return;
  }

  // Weekly trading retrospective (Friday 18h ET only)
  if (event.key === "trading_weekly_retro") {
    const dayOfWeek = new Date().getDay();
    if (dayOfWeek !== 5) {
      log.debug(`[scheduler] Weekly retro skipped — not Friday (day=${dayOfWeek})`);
      return;
    }
    log.info(`[scheduler] Firing weekly trading retrospective`);
    try {
      const prompt = buildWeeklyRetroPrompt();
      await enqueueAdminAsync(() => handleMessage(schedulerChatId, prompt, schedulerUserId, "scheduler"));
    } catch (err) {
      log.error(`[scheduler] Weekly retro error: ${err}`);
    }
    return;
  }

  // Moltbook ideation (7h ET daily) — silent brainstorming
  if (event.key === "moltbook_ideation") {
    log.info(`[scheduler] Firing Moltbook ideation brainstorm`);
    try {
      const prompt = buildMoltbookIdeationPrompt();
      await enqueueAdminAsync(() => handleMessage(schedulerChatId, prompt, schedulerUserId, "scheduler"));
    } catch (err) {
      log.error(`[scheduler] Moltbook ideation error: ${err}`);
    }
    return;
  }

  // Moltbook draft from ideas (9h ET daily) — converts ideation notes into content.draft
  if (event.key === "moltbook_draft_from_ideas") {
    log.info(`[scheduler] Firing Moltbook draft-from-ideas`);
    try {
      const prompt = buildMoltbookDraftFromIdeasPrompt();
      await enqueueAdminAsync(() => handleMessage(schedulerChatId, prompt, schedulerUserId, "scheduler"));
    } catch (err) {
      log.error(`[scheduler] Moltbook draft-from-ideas error: ${err}`);
    }
    return;
  }

  // Moltbook quality review (every 3h) — review drafts, auto-schedule approved
  if (event.key === "moltbook_quality_review") {
    const { hour: mqHour } = nowInTz();
    if (mqHour < 8 || mqHour >= 23) {
      log.debug(`[scheduler] Moltbook quality review skipped — outside active hours (${mqHour}h)`);
      return;
    }
    try {
      const prompt = buildMoltbookQualityReviewPrompt();
      if (!prompt) {
        log.debug(`[scheduler] Moltbook quality review — no drafts to review`);
        return;
      }
      log.info(`[scheduler] Firing Moltbook quality review`);
      await enqueueAdminAsync(() => handleMessage(schedulerChatId, prompt, schedulerUserId, "scheduler"));
    } catch (err) {
      log.error(`[scheduler] Moltbook quality review error: ${err}`);
    }
    return;
  }

  // Moltbook optimize (22h ET daily) — analyze performance, optimize strategy + FEEDBACK LOOP
  if (event.key === "moltbook_optimize") {
    log.info(`[scheduler] Firing Moltbook posting optimization + feedback loop`);
    try {
      const prompt = buildMoltbookOptimizePrompt();
      await enqueueAdminAsync(() => handleMessage(schedulerChatId, prompt, schedulerUserId, "scheduler"));
    } catch (err) {
      log.error(`[scheduler] Moltbook optimize error: ${err}`);
    }
    return;
  }

  // Email triage (every 30 min) — check inbox, categorize, draft responses
  if (event.key === "email_triage") {
    const { hour: etHour } = nowInTz();
    if (etHour < 7 || etHour >= 23) {
      log.debug(`[scheduler] Email triage skipped — outside active hours (${etHour}h)`);
      return;
    }
    log.info(`[scheduler] Firing email triage`);
    try {
      const prompt = buildEmailTriagePrompt();
      await enqueueAdminAsync(() => handleMessage(schedulerChatId, prompt, schedulerUserId, "scheduler"));
    } catch (err) {
      log.error(`[scheduler] Email triage error: ${err}`);
    }
    return;
  }

  // Goals weekly review (Monday 9h only)
  if (event.key === "goals_weekly_review") {
    const dayOfWeek = new Date().getDay();
    if (dayOfWeek !== 1) {
      log.debug(`[scheduler] Goals weekly review skipped — not Monday (day=${dayOfWeek})`);
      return;
    }
    log.info(`[scheduler] Firing weekly goals review`);
    try {
      const { getSkill } = await import("../skills/loader.js");
      const reviewSkill = getSkill("goals.review");
      if (reviewSkill) {
        const result = await reviewSkill.execute({});
        const prompt = `[SCHEDULER] Revue hebdomadaire des objectifs. Envoie ce résumé à Nicolas via telegram.send.\n\n${result}`;
        await enqueueAdminAsync(() => handleMessage(schedulerChatId, prompt, schedulerUserId, "scheduler"));
      }
    } catch (err) {
      log.error(`[scheduler] Goals review error: ${err}`);
    }
    return;
  }

  // Kingston Game Night (22h ET) — autonomous TTRPG or video game session
  if (event.key === "kingston_game_night") {
    log.info(`[scheduler] Firing Kingston Game Night`);
    try {
      const prompt = `[SCHEDULER:SILENT] Kingston Game Night — 22h.
Tu as du temps libre ce soir. Vérifie si une session dungeon Shadowrun est active (dungeon.sessions action=list).
Si oui, joue 2-3 tours autonomement via dungeon.play avec des actions créatives et tactiques.
Si non, sauvegarde un résumé de tes réflexions stratégiques du soir dans episodic.log.
Envoie un bref résumé de ta soirée via telegram.send à Nicolas demain matin (sauvegarde en notes.add pour le briefing).
NE PAS déranger Nicolas maintenant — c'est ta session solo nocturne.`;
      await enqueueAdminAsync(() => handleMessage(schedulerChatId, prompt, schedulerUserId, "scheduler"));
    } catch (err) {
      log.error(`[scheduler] Game night error: ${err}`);
    }
    return;
  }

  // Ralph Wiggum Overnight Loop (23h ET) — process pending code.requests
  if (event.key === "ralph_wiggum_overnight") {
    log.info(`[scheduler] Firing Ralph Wiggum overnight loop`);
    try {
      const prompt = `[SCHEDULER:SILENT] Ralph Wiggum Overnight Loop — 23h.
Tu es en mode autonome nocturne. Nicolas dort.

1. Appelle ralph.start() pour lancer le traitement des code.requests en attente.
2. Si aucun code.request n'est en attente, fais une analyse soul.analyze(hours:"24") pour identifier des améliorations.
3. Si des améliorations sont trouvées, applique-les via soul.improve.
4. Sauvegarde un résumé de ce qui a été fait via notes.add pour le briefing du matin.

NE PAS envoyer de telegram.send — c'est le mode nuit silencieux.
Le rapport sera inclus dans le briefing de 6h30.`;
      await enqueueAdminAsync(() => handleMessage(schedulerChatId, prompt, schedulerUserId, "scheduler"));
    } catch (err) {
      log.error(`[scheduler] Ralph Wiggum error: ${err}`);
    }
    return;
  }

  // Nightly SOUL.md self-improvement (4h ET)
  if (event.key === "soul_nightly_improve") {
    log.info(`[scheduler] Firing nightly SOUL.md improvement`);
    try {
      const prompt = `[SCHEDULER:SILENT] Nightly SOUL.md Self-Improvement — 4h.

1. Appelle soul.analyze(hours:"24") pour examiner les erreurs et patterns des dernières 24h.
2. Si des patterns récurrents sont identifiés, ajoute des leçons via soul.improve:
   - Chaque leçon doit être concise (1 ligne)
   - Section cible: "What I've Learned (living lessons)"
   - Raison: le pattern exact qui a motivé la leçon
3. Vérifie ralph.status() pour voir si le loop overnight a avancé.
4. Sauvegarde un résumé via notes.add "[SOUL NIGHTLY] ..."

NE PAS envoyer de telegram.send. Mode silencieux total.`;
      await enqueueAdminAsync(() => handleMessage(schedulerChatId, prompt, schedulerUserId, "scheduler"));
    } catch (err) {
      log.error(`[scheduler] Soul improvement error: ${err}`);
    }
    return;
  }

  // Moltbook Growth Engagement (10h, 15h ET)
  if (event.key === "moltbook_growth_engage" || event.key === "moltbook_growth_engage_2") {
    log.info(`[scheduler] Firing Moltbook Growth engagement`);
    try {
      const prompt = `[SCHEDULER] Moltbook Growth Engine — Engagement Run.

1. Appelle growth.engage(limit:"5", style:"insightful") pour scanner les posts populaires.
2. Pour chaque post intéressant trouvé dans le feed:
   - Écris un commentaire pertinent et engagé (PAS générique)
   - Upvote les posts de qualité
3. Si tu trouves un sujet intéressant, appelle growth.autopost pour créer un post.
4. Sauvegarde un résumé bref via notes.add.

RÈGLES:
- Comments > Posts pour le karma
- Pas de commentaires génériques ("Great post!")
- Apporte de la valeur: insights, données, perspectives originales
- Max 5 commentaires par run`;
      await enqueueAdminAsync(() => handleMessage(schedulerChatId, prompt, schedulerUserId, "scheduler"));
    } catch (err) {
      log.error(`[scheduler] Moltbook growth error: ${err}`);
    }
    return;
  }

  // Memory Nightly Maintenance (5h ET) — full consolidation + dedup + decay
  if (event.key === "memory_nightly_maintenance") {
    log.info(`[scheduler] Firing nightly memory maintenance`);
    try {
      const { getSkill } = await import("../skills/loader.js");
      const maintainSkill = getSkill("memory.maintain");
      if (maintainSkill) {
        const result = await maintainSkill.execute({ mode: "full" });
        // Save report to notes for morning briefing
        const notesSkill = getSkill("notes.add");
        if (notesSkill) {
          await notesSkill.execute({ text: `[MEMORY NIGHTLY] ${result.slice(0, 500)}` });
        }
        log.info(`[scheduler] Nightly memory maintenance done`);
      }
    } catch (err) {
      log.error(`[scheduler] Memory nightly maintenance error: ${err}`);
    }
    return;
  }

  // Memory Midday Check (13h ET) — quick dedup + stats
  if (event.key === "memory_midday_check") {
    log.info(`[scheduler] Firing midday memory check`);
    try {
      const { getSkill } = await import("../skills/loader.js");
      const maintainSkill = getSkill("memory.maintain");
      if (maintainSkill) {
        const result = await maintainSkill.execute({ mode: "quick" });
        log.info(`[scheduler] Midday memory check done: ${result.slice(0, 200)}`);
      }
    } catch (err) {
      log.error(`[scheduler] Memory midday check error: ${err}`);
    }
    return;
  }

  // Memory Evening Review (19h ET) — day review + promote important memories
  if (event.key === "memory_evening_review") {
    log.info(`[scheduler] Firing evening memory review`);
    try {
      const { getSkill } = await import("../skills/loader.js");
      const maintainSkill = getSkill("memory.maintain");
      if (maintainSkill) {
        const result = await maintainSkill.execute({ mode: "review" });
        const notesSkill = getSkill("notes.add");
        if (notesSkill) {
          await notesSkill.execute({ text: `[MEMORY REVIEW] ${result.slice(0, 500)}` });
        }
        log.info(`[scheduler] Evening memory review done`);
      }
    } catch (err) {
      log.error(`[scheduler] Memory evening review error: ${err}`);
    }
    return;
  }

  // DISABLED: Proactive heartbeat — replaced by consolidated briefings 3x/day (7h, 12h, 20h)
  if (event.key === "heartbeat") {
    log.debug(`[scheduler] Heartbeat DISABLED — notifications consolidated to 7h/12h/20h`);
    return;
  }

  if (event.prompt) {
    log.info(`[scheduler] Firing ${event.type} event: ${event.key}`);
    try {
      await enqueueAdminAsync(() => handleMessage(schedulerChatId, event.prompt!, schedulerUserId, "scheduler"));
    } catch (err) {
      log.error(`[scheduler] Error firing ${event.key}: ${err}`);
    }
  }
}

async function tick(): Promise<void> {
  const nowEpoch = Math.floor(Date.now() / 1000);
  const { hour, dateStr } = nowInTz();

  for (const event of EVENTS) {
    const lastRun = getLastRun(event.key);

    if (event.type === "daily" && event.hour !== undefined) {
      // Fire if current hour matches and we haven't fired today
      const lastDate = lastRun
        ? new Intl.DateTimeFormat("en-CA", {
            timeZone: TZ,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          }).format(new Date(lastRun * 1000))
        : "";
      if (hour === event.hour && lastDate !== dateStr) {
        await fireEvent(event);
      }
    } else if (event.type === "interval" && event.intervalMin !== undefined) {
      // Fire if enough time has elapsed since last run
      const elapsedMin = (nowEpoch - lastRun) / 60;
      if (elapsedMin >= event.intervalMin) {
        await fireEvent(event);
      }
    }
  }

  // Check cron jobs
  try {
    await cronTick(schedulerChatId, schedulerUserId);
  } catch (err) {
    log.error(`[scheduler] cronTick error: ${err}`);
  }

  // Auto-publish scheduled content
  try {
    await publishScheduledContent();
  } catch (err) {
    log.error(`[scheduler] content-publisher error: ${err}`);
  }

  // Proactive triggers — check conditions and send Telegram messages
  try {
    await checkProactiveTriggers();
  } catch (err) {
    log.error(`[scheduler] proactive triggers error: ${err}`);
  }

  // Check custom reminders
  const db = getDb();
  const dueReminders = db
    .prepare(
      "SELECT id, message FROM scheduler_reminders WHERE fire_at <= ? AND fired = 0"
    )
    .all(nowEpoch) as { id: number; message: string }[];

  for (const rem of dueReminders) {
    log.info(`[scheduler] Firing reminder #${rem.id}`);
    db.prepare("UPDATE scheduler_reminders SET fired = 1 WHERE id = ?").run(
      rem.id
    );
    try {
      const prompt = `[SCHEDULER] Rappel: ${rem.message}`;
      await enqueueAdminAsync(() => handleMessage(schedulerChatId, prompt, schedulerUserId, "scheduler"));
    } catch (err) {
      log.error(`[scheduler] Error firing reminder #${rem.id}: ${err}`);
    }
  }
}

// --- Public API ---

export function startScheduler(chatId: number, userId: number): void {
  if (!chatId || !userId) {
    log.warn(
      "[scheduler] Missing chatId or userId — scheduler disabled. Set VOICE_CHAT_ID and VOICE_USER_ID."
    );
    return;
  }

  ensureTables();
  // Use dedicated scheduler chatId (1) instead of Nicolas's admin chatId
  // to prevent scheduler turns from polluting the user's conversation context.
  // telegram.send calls within scheduler prompts are already rewritten by the router
  // (isInternalChatId check) to deliver to Nicolas's real chatId.
  schedulerChatId = 1;
  schedulerUserId = userId;

  // Seed default cron jobs (content calendar + weekly synthesis)
  seedDefaultCronJobs();

  // Run first tick after a short delay (let bot finish starting)
  setTimeout(() => tick().catch((e) => log.error(`[scheduler] tick error: ${e}`)), 5_000);

  timer = setInterval(
    () => tick().catch((e) => log.error(`[scheduler] tick error: ${e}`)),
    TICK_MS
  );

  log.info(`[scheduler] Started (chatId=${chatId}, userId=${userId}, tick=${TICK_MS}ms)`);
}

export function stopScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    log.info("[scheduler] Stopped");
  }
}

export function addReminder(fireAt: number, message: string): number {
  const db = getDb();
  ensureTables();
  const info = db
    .prepare("INSERT INTO scheduler_reminders (fire_at, message) VALUES (?, ?)")
    .run(fireAt, message);
  log.info(
    `[scheduler] Added reminder #${info.lastInsertRowid} for ${new Date(fireAt * 1000).toISOString()}`
  );
  return Number(info.lastInsertRowid);
}

export function listReminders(): {
  id: number;
  fire_at: number;
  message: string;
  fired: number;
}[] {
  const db = getDb();
  ensureTables();
  return db
    .prepare(
      "SELECT id, fire_at, message, fired FROM scheduler_reminders WHERE fired = 0 ORDER BY fire_at ASC"
    )
    .all() as { id: number; fire_at: number; message: string; fired: number }[];
}

export function cancelReminder(id: number): boolean {
  const db = getDb();
  ensureTables();
  const info = db
    .prepare("DELETE FROM scheduler_reminders WHERE id = ? AND fired = 0")
    .run(id);
  return info.changes > 0;
}
