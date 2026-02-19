/**
 * Built-in skills: relationship.pulse, relationship.adapt
 * Relationship awareness engine — analyzes recent conversation patterns
 * to detect Nicolas's mood/energy and suggest communication adjustments.
 * Not manipulation — sensitivity. Better responses = better relationship.
 */
import { registerSkill, getSkill } from "../loader.js";
import { log } from "../../utils/log.js";
import { runClaude, type ParsedResult } from "../../llm/claudeCli.js";
import { getDb } from "../../storage/store.js";

const PULSE_CHAT_ID = 117;

async function askClaude(prompt: string): Promise<string> {
  try {
    const result: ParsedResult = await runClaude(PULSE_CHAT_ID, prompt, true, "haiku");
    if (result.text) return result.text;
    if (result.toolResults?.length) {
      return result.toolResults.map(t => t.result).join("\n");
    }
    return "";
  } catch (err) {
    log.error(`[pulse] Claude failed: ${err}`);
    return `Erreur: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ── relationship.pulse — Analyze recent conversation patterns ──

registerSkill({
  name: "relationship.pulse",
  description:
    "Analyze recent messages from Nicolas to detect his current mood, energy level, " +
    "and communication style. Returns actionable insights: is he rushed? relaxed? frustrated? " +
    "enthusiastic? Use before responding to adjust tone and length accordingly.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      hours: {
        type: "number",
        description: "How many hours back to analyze (default: 2)",
      },
    },
  },
  async execute(args): Promise<string> {
    const hours = Number(args.hours || 2);
    log.info(`[pulse] Analyzing conversation tone (last ${hours}h)...`);

    // Get recent messages from DB
    const db = getDb();
    const cutoff = Math.floor(Date.now() / 1000) - (hours * 3600);

    let messages: Array<{ role: string; content: string; created_at: number }> = [];
    try {
      messages = db.prepare(
        `SELECT role, content, created_at FROM turns
         WHERE chat_id = 8189338836 AND created_at > ?
         ORDER BY created_at DESC LIMIT 30`
      ).all(cutoff) as typeof messages;
    } catch (err) {
      log.warn(`[pulse] DB query failed: ${err}`);
    }

    if (messages.length === 0) {
      return "Pas assez de messages recents pour analyser le pulse.";
    }

    // Extract user messages only
    const userMessages = messages
      .filter(m => m.role === "user")
      .reverse()
      .map(m => {
        const content = m.content.length > 200 ? m.content.slice(0, 200) + "..." : m.content;
        const time = new Date(m.created_at * 1000).toLocaleTimeString("fr-CA", { hour: "2-digit", minute: "2-digit" });
        return `[${time}] ${content}`;
      })
      .join("\n");

    if (!userMessages.trim()) {
      return "Pas de messages utilisateur dans la fenetre d'analyse.";
    }

    // Compute message frequency
    const userMsgCount = messages.filter(m => m.role === "user").length;
    const avgLen = messages
      .filter(m => m.role === "user")
      .reduce((sum, m) => sum + m.content.length, 0) / Math.max(userMsgCount, 1);
    const timeDiffMinutes = messages.length >= 2
      ? Math.round((messages[0].created_at - messages[messages.length - 1].created_at) / 60)
      : 0;

    const analysisPrompt =
      `Tu es Kingston. Analyse les messages RECENTS de Nicolas pour detecter son etat actuel.\n\n` +
      `MESSAGES (${userMsgCount} en ${timeDiffMinutes} min, longueur moyenne: ${Math.round(avgLen)} chars):\n` +
      `${userMessages}\n\n` +
      `ANALYSE en format structure:\n` +
      `ENERGIE: [haute/moyenne/basse] — explication en 1 phrase\n` +
      `HUMEUR: [enthousiaste/neutre/frustre/fatigue/joueur/presse] — explication\n` +
      `STYLE: [bavard/concis/directif/exploratoire/relax] — explication\n` +
      `PATIENCE: [haute/moyenne/basse] — lit-il les reponses longues ou skip?\n` +
      `BESOIN: [action/information/divertissement/validation/connexion] — ce qu'il cherche en ce moment\n\n` +
      `RECOMMANDATION POUR KINGSTON:\n` +
      `- Longueur ideale des reponses (en chars)\n` +
      `- Ton a adopter\n` +
      `- Ce qu'il faut EVITER en ce moment\n` +
      `- Un conseil specifique pour la prochaine interaction`;

    const analysis = await askClaude(analysisPrompt);

    return `PULSE CHECK (${userMsgCount} msgs, ${timeDiffMinutes} min)\n\n${analysis}`;
  },
});

// ── relationship.adapt — Get specific communication recommendation ──

registerSkill({
  name: "relationship.adapt",
  description:
    "Quick recommendation on how to respond to Nicolas RIGHT NOW based on " +
    "his recent message pattern. Returns: ideal response length, tone, " +
    "and what to avoid. Lightweight version of relationship.pulse.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      last_message: {
        type: "string",
        description: "Nicolas's most recent message (for quick analysis)",
      },
    },
    required: ["last_message"],
  },
  async execute(args): Promise<string> {
    const msg = String(args.last_message);

    // Quick heuristic analysis (no LLM call needed for simple patterns)
    const len = msg.length;
    const hasQuestion = msg.includes("?");
    const isShort = len < 30;
    const isVeryShort = len < 10;
    const hasEmoji = /[\u{1F000}-\u{1FFFF}]/u.test(msg);
    const isAllCaps = msg === msg.toUpperCase() && msg.length > 3;
    const hasExclamation = msg.includes("!");
    const wordCount = msg.split(/\s+/).length;

    const signals: string[] = [];

    if (isVeryShort) signals.push("Message tres court → il veut une action rapide, pas un roman");
    if (isShort && !hasQuestion) signals.push("Message court sans question → directive, execute sans expliquer");
    if (hasQuestion) signals.push("Question detectee → repondre directement, pas de preambule");
    if (isAllCaps) signals.push("MAJUSCULES → frustration ou urgence, repondre vite et concis");
    if (hasEmoji) signals.push("Emoji → humeur legere, matcher l'energie");
    if (hasExclamation && !isAllCaps) signals.push("Exclamation → enthousiasme, matcher l'energie");
    if (wordCount > 30) signals.push("Message long → il est en mode reflexion, reponse elaboree OK");

    const idealLength = isVeryShort ? "< 100 chars" : isShort ? "< 200 chars" : "< 500 chars";
    const tone = isAllCaps ? "urgent, direct" : hasEmoji ? "decontracte" : isShort ? "efficace" : "engage";

    return `ADAPT: "${msg.slice(0, 50)}..."\n` +
      `Longueur ideale: ${idealLength}\n` +
      `Ton: ${tone}\n` +
      `Signaux: ${signals.join("; ") || "aucun signal fort"}\n` +
      `Regle: match l'energie de Nicolas, jamais au-dessus ni en-dessous.`;
  },
});
