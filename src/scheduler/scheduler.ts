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
    hour: 8,
    prompt: null, // dynamic — built at fire time with overnight agent data
  },
  {
    key: "trading_strategy_open",
    type: "daily",
    hour: 9, // 9h ET — market open + 30min for stability
    prompt: null, // dynamic — built from Kingston Mind strategy
  },
  {
    key: "trading_strategy_close",
    type: "daily",
    hour: 15, // 15h ET — 1h before market close, review positions
    prompt: null, // dynamic — built from Kingston Mind strategy
  },
  {
    key: "rules_auto_graduate",
    type: "interval",
    intervalMin: 360, // every 6 hours
    prompt: null, // dynamic — auto-graduate proven rules
  },
  {
    key: "evening_checkin",
    type: "daily",
    hour: 20,
    prompt:
      "[SCHEDULER] Check-in du soir. Fais un bilan rapide de la journée : ce qui a été fait, rappels manqués, et souhaite une bonne soirée.",
  },
  {
    key: "code_digest_morning",
    type: "daily",
    hour: 9,
    prompt: null, // dynamic — built at fire time
  },
  {
    key: "code_digest_evening",
    type: "daily",
    hour: 21,
    prompt: null, // dynamic — built at fire time
  },
  {
    key: "heartbeat",
    type: "interval",
    intervalMin: 30,
    prompt: null, // dynamic — proactive checks at fire time
  },
  {
    key: "moltbook_digest",
    type: "daily",
    hour: 15,
    prompt: null, // dynamic — built at fire time
  },
  {
    key: "moltbook_post",
    type: "interval",
    intervalMin: 31, // tight to 30-min API rate limit — maximum posting
    prompt: null, // dynamic — built at fire time
  },
  {
    key: "moltbook_comment",
    type: "interval",
    intervalMin: 5, // aggressive commenting — 50 comments/day max enforced by API
    prompt: null, // dynamic — built at fire time
  },
  {
    key: "moltbook_performance",
    type: "interval",
    intervalMin: 120, // every 2 hours — check post performance and award results-based XP
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
      `[SCHEDULER] Code Request Digest — ${pending.length} demande(s) en attente.\n\n` +
      `${summary}\n\n` +
      `Présente ce digest à Nicolas de façon concise. Pour chaque demande, donne ton avis : ` +
      `utile/redondant/déjà fait/trop ambitieux. Demande-lui lesquelles exécuter. ` +
      `Utilise telegram.send pour envoyer le résumé.`
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
    `DONNÉES À COLLECTER (appelle CHAQUE outil):\n` +
    `1. MÉTÉO: web.search("météo Gatineau aujourd'hui") ou web.fetch("https://wttr.in/Gatineau?format=3")\n` +
    `2. TRADING P&L: trading.positions() + trading.account() — résumé portfolio\n` +
    `3. MOLTBOOK: moltbook.feed(sort=hot, limit=3) — tendances du jour\n` +
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
 * Build Moltbook digest — check trending posts and suggest engagement.
 */
function buildMoltbookDigestPrompt(): string {
  return (
    `[SCHEDULER] Moltbook daily digest. ` +
    `Utilise moltbook.feed avec sort=hot et limit=5 pour voir les posts tendance. ` +
    `Puis envoie un résumé concis à Nicolas via telegram.send avec les 3-5 posts les plus intéressants. ` +
    `Si tu vois un post pertinent pour Kingston ou Nicolas, mentionne pourquoi. ` +
    `Garde le message court et informatif.`
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
    `7. telegram.send avec résumé:\n` +
    `   "📊 [Moltbook Stats] X upvotes, Y commentaires reçus | XP gagné: +Z | Top post: [titre]"\n\n` +
    `IMPORTANT:\n` +
    `- N'attribue PAS de XP pour le simple fait d'avoir posté — seulement pour les RÉSULTATS\n` +
    `- Si un post a 0 engagement après 2h, c'est une PÉNALITÉ, pas une récompense\n` +
    `- Compare avec les posts précédents pour voir si on s'améliore`
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
      `7. telegram.send — SEULEMENT si tu as ACHETÉ ou VENDU:\n` +
      `   "🟢 Achat: Xqty SYMBOL @ $prix (total: $montant)" ou\n` +
      `   "🔴 Vente: Xqty SYMBOL @ $prix (P&L: +/-$montant / +/-X%)"\n\n` +
      `RÈGLES:\n` +
      `- Max $5000 par position, $10000 total toutes positions combinées (90% cash minimum)\n` +
      `- TOUJOURS vérifier le stop-loss avant d'acheter\n` +
      `- Log CHAQUE décision (achat, skip, wait) via mind.decide\n` +
      `- Sois DISCIPLINÉ — pas de FOMO, suis la stratégie\n` +
      `- NE PAS envoyer de signaux techniques (RSI, VWAP, etc.) à Nicolas — analyse interne seulement\n`
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
    `6. telegram.send — rapport BREF de fin de journée:\n` +
    `   "📊 [Trading EOD] P&L jour: +/-$X | Positions restantes: Y | Trades: Z achats, W ventes"\n` +
    `   SEULEMENT les résultats concrets (pas de signaux techniques)\n\n` +
    `RÈGLES:\n` +
    `- Coupe les pertes > -5% SANS hésiter\n` +
    `- Ne fais PAS de nouveaux achats en fin de journée\n` +
    `- Log chaque décision via mind.decide\n` +
    `- NE PAS envoyer de signaux techniques à Nicolas — résultats seulement\n`
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

  // Morning briefing with overnight agent report
  if (event.key === "morning_briefing") {
    log.info(`[scheduler] Firing morning briefing with overnight agent report`);
    try {
      const prompt = buildMorningBriefingPrompt();
      await enqueueAdminAsync(() => handleMessage(schedulerChatId, prompt, schedulerUserId, "scheduler"));
    } catch (err) {
      log.error(`[scheduler] Morning briefing error: ${err}`);
    }
    return;
  }

  // Trading strategy — market open / pre-close
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

  // Moltbook daily digest
  if (event.key === "moltbook_digest") {
    log.info(`[scheduler] Firing Moltbook daily digest`);
    try {
      const prompt = buildMoltbookDigestPrompt();
      await enqueueAdminAsync(() => handleMessage(schedulerChatId, prompt, schedulerUserId, "scheduler"));
    } catch (err) {
      log.error(`[scheduler] Moltbook digest error: ${err}`);
    }
    return;
  }

  // Moltbook auto-post (every 35 min) — active hours only
  if (event.key === "moltbook_post") {
    const { hour: mhPost } = nowInTz();
    if (mhPost < 8 || mhPost >= 23) {
      log.debug(`[scheduler] Moltbook auto-post skipped — outside active hours (${mhPost}h)`);
      return;
    }
    log.info(`[scheduler] Firing Moltbook auto-post`);
    try {
      const prompt = buildMoltbookPostPrompt();
      await enqueueAdminAsync(() => handleMessage(schedulerChatId, prompt, schedulerUserId, "scheduler"));
    } catch (err) {
      log.error(`[scheduler] Moltbook auto-post error: ${err}`);
    }
    return;
  }

  // Moltbook auto-comment (every 15 min) — active hours only
  if (event.key === "moltbook_comment") {
    const { hour: mhComment } = nowInTz();
    if (mhComment < 8 || mhComment >= 23) {
      log.debug(`[scheduler] Moltbook auto-comment skipped — outside active hours (${mhComment}h)`);
      return;
    }
    log.info(`[scheduler] Firing Moltbook auto-comment`);
    try {
      const prompt = buildMoltbookCommentPrompt();
      await enqueueAdminAsync(() => handleMessage(schedulerChatId, prompt, schedulerUserId, "scheduler"));
    } catch (err) {
      log.error(`[scheduler] Moltbook auto-comment error: ${err}`);
    }
    return;
  }

  // Moltbook performance tracker — results-based XP
  if (event.key === "moltbook_performance") {
    const { hour: mhPerf } = nowInTz();
    if (mhPerf < 10 || mhPerf >= 23) {
      log.debug(`[scheduler] Moltbook performance check skipped — outside active hours (${mhPerf}h)`);
      return;
    }
    log.info(`[scheduler] Firing Moltbook performance check`);
    try {
      const prompt = buildMoltbookPerformancePrompt();
      await enqueueAdminAsync(() => handleMessage(schedulerChatId, prompt, schedulerUserId, "scheduler"));
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

  // Notification daily digest (20h)
  if (event.key === "notify_daily_digest") {
    log.info(`[scheduler] Firing daily notification digest`);
    try {
      const { getSkill } = await import("../skills/loader.js");
      const digestSkill = getSkill("notify.digest");
      if (digestSkill) {
        const result = await digestSkill.execute({ period: "daily" });
        if (result && !result.includes("Aucune notification")) {
          const prompt = `[SCHEDULER] Digest de notifications du jour. Envoie ce résumé à Nicolas via telegram.send.\n\n${result}`;
          await enqueueAdminAsync(() => handleMessage(schedulerChatId, prompt, schedulerUserId, "scheduler"));
        } else {
          log.debug(`[scheduler] No notifications to digest`);
        }
      }
    } catch (err) {
      log.error(`[scheduler] Notification digest error: ${err}`);
    }
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

  // Proactive heartbeat — check emails + calendar (with restraint)
  if (event.key === "heartbeat") {
    log.debug(`[scheduler] Heartbeat tick — checking proactive alerts (silent streak: ${consecutiveSilentHeartbeats})`);
    try {
      const heartbeatPrompt = await buildHeartbeatPrompt();
      if (heartbeatPrompt) {
        // Something to report — reset silence streak
        consecutiveSilentHeartbeats = 0;
        silenceStreakNotified = false;
        log.info(`[scheduler] Heartbeat found alerts — notifying`);
        await enqueueAdminAsync(() => handleMessage(schedulerChatId, heartbeatPrompt, schedulerUserId, "scheduler"));
      } else {
        // Nothing to report — increment silence streak
        consecutiveSilentHeartbeats++;
        log.debug(`[scheduler] Heartbeat — nothing to report (streak: ${consecutiveSilentHeartbeats})`);

        // After 10 consecutive silent heartbeats (~5h), surface stability message once
        if (consecutiveSilentHeartbeats >= SILENCE_STREAK_THRESHOLD && !silenceStreakNotified) {
          silenceStreakNotified = true;
          const hours = Math.round((consecutiveSilentHeartbeats * 30) / 60);
          const stabilityMsg =
            `[SCHEDULER] Stability report: tout est stable depuis ~${hours}h. ` +
            `${consecutiveSilentHeartbeats} heartbeats consécutifs sans alertes. ` +
            `Envoie un bref message de stabilité à Nicolas via telegram.send — pas d'urgence, juste un signal de confiance.`;
          await enqueueAdminAsync(() => handleMessage(schedulerChatId, stabilityMsg, schedulerUserId, "scheduler"));
        }
      }
    } catch (err) {
      log.error(`[scheduler] Heartbeat error: ${err}`);
    }
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
