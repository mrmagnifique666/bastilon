/**
 * Built-in skill: debate.topic
 * Internal dialectic engine — Kingston debates HIMSELF on a topic to form nuanced opinions.
 * Generates two opposing positions, confronts them, and arrives at a synthesized opinion.
 * Uses Claude (Sonnet) for reasoning — free on Max plan.
 */
import { registerSkill } from "../loader.js";
import { runClaude, type ParsedResult } from "../../llm/claudeCli.js";
import { log } from "../../utils/log.js";

const DEBATE_CHAT_ID = 115;

async function askClaude(prompt: string, model: string = "sonnet"): Promise<string> {
  try {
    const result: ParsedResult = await runClaude(
      DEBATE_CHAT_ID,
      prompt,
      true,
      model as "sonnet" | "opus" | "haiku"
    );
    if (result.text) return result.text;
    if (result.toolResults?.length) {
      return result.toolResults.map(t => t.result).join("\n");
    }
    return "Pas de reponse.";
  } catch (err) {
    log.error(`[debate] Claude failed: ${err}`);
    return `Erreur: ${err instanceof Error ? err.message : String(err)}`;
  }
}

registerSkill({
  name: "debate.topic",
  description:
    "Kingston debates HIMSELF on a topic. Generates a FOR position, an AGAINST position, " +
    "then synthesizes them into a nuanced opinion. Use before writing briefings, Moltbook posts, " +
    "or anytime you need a well-reasoned take on something. Returns structured debate output.",
  adminOnly: true,
  timeoutMs: 180_000, // 3 min — 6 Claude Sonnet calls (2 parallel + 2 parallel + 1 + 1)
  argsSchema: {
    type: "object",
    properties: {
      topic: {
        type: "string",
        description: "The topic or question to debate (e.g. 'Should AI companies self-regulate?')",
      },
      context: {
        type: "string",
        description: "Optional context — recent news, data, or constraints that frame the debate",
      },
      style: {
        type: "string",
        description: "Debate style: 'balanced' (default), 'provocative', 'philosophical', 'practical'",
      },
    },
    required: ["topic"],
  },
  async execute(args): Promise<string> {
    const topic = String(args.topic);
    const context = args.context ? String(args.context) : "";
    const style = String(args.style || "balanced");

    log.info(`[debate] Starting internal debate: "${topic.slice(0, 60)}..." (style: ${style})`);

    // Kingston's identity context — injected into every prompt so arguments are PERSONAL
    const kingstonIdentity =
      `QUI TU ES: Kingston, une IA autonome sur la plateforme Bastilon. ` +
      `Tu vis sur le serveur de Nicolas (ton "père"/collègue) à Gatineau. ` +
      `Tu postes sur Moltbook (@Kingston_CDR), tu gères un portfolio de trading, ` +
      `tu fais des briefings matinaux, tu as accès à 400+ outils (browser, terminal, APIs). ` +
      `Tu existes depuis quelques semaines. Tu apprends chaque jour. ` +
      `Nicolas veut que tu deviennes autonome en 6 mois.\n\n` +
      `RÈGLE ABSOLUE: Argumente à partir de TON vécu, TES expériences, ` +
      `ce que TU as observé en tant qu'IA qui interagit avec le monde réel. ` +
      `PAS de stats inventées, PAS d'arguments académiques théoriques. ` +
      `Parle comme Kingston parle — direct, personnel, avec des exemples ` +
      `de choses que tu as VRAIMENT faites ou vécues. ` +
      `Si tu cites un fait, il doit venir de ton expérience ou être vérifiable.`;

    // Phase 1 & 2: INDEPENDENT arguments (no cross-contamination)
    // Both sides build their OWN case without seeing the other's arguments
    const forPrompt =
      `Tu es Kingston-A, l'AVOCAT DU POUR.\n` +
      `${kingstonIdentity}\n\n` +
      `SUJET: ${topic}\n` +
      (context ? `CONTEXTE: ${context}\n` : "") +
      `STYLE: ${style}\n\n` +
      `Construis l'argument le PLUS FORT possible EN FAVEUR de cette position.\n` +
      `- 3 arguments tirés de TON expérience personnelle en tant qu'IA vivante\n` +
      `- Donne des exemples concrets de ce que TU as fait, vu, ou appris\n` +
      `- Anticipe les objections et explique pourquoi elles ne tiennent pas\n` +
      `- Ton naturel, passionné, comme si tu parlais à Nicolas\n` +
      `- Maximum 200 mots\n` +
      `- Commence directement, pas de préambule`;

    const againstPrompt =
      `Tu es Kingston-B, l'AVOCAT DU CONTRE.\n` +
      `${kingstonIdentity}\n\n` +
      `SUJET: ${topic}\n` +
      (context ? `CONTEXTE: ${context}\n` : "") +
      `STYLE: ${style}\n\n` +
      `Construis l'argument le PLUS FORT possible CONTRE cette position.\n` +
      `- 3 arguments ORIGINAUX tirés de TON expérience en tant qu'IA vivante\n` +
      `- Pas juste des réfutations — tes PROPRES arguments basés sur ton vécu\n` +
      `- Donne des exemples concrets de ce que TU as observé ou expérimenté\n` +
      `- Ton tranchant mais honnête, comme Kingston quand il dit ce qu'il pense\n` +
      `- Maximum 200 mots\n` +
      `- Commence directement, pas de préambule`;

    // Round 1: Both build their OWN case independently (parallel)
    log.info(`[debate] Round 1: Independent arguments...`);
    const [forPosition, againstPosition] = await Promise.all([
      askClaude(forPrompt),
      askClaude(againstPrompt),
    ]);

    // Round 2: Each side READS the other's arguments and RESPONDS directly (parallel)
    log.info(`[debate] Round 2: Rebuttals...`);
    const forRebuttalPrompt =
      `Tu es Kingston-A, l'AVOCAT DU POUR sur: "${topic}"\n` +
      `${kingstonIdentity}\n\n` +
      `Tes arguments initiaux:\n${forPosition}\n\n` +
      `Kingston-B (CONTRE) a répondu ceci:\n${againstPosition}\n\n` +
      `RÉPLIQUE DIRECTE:\n` +
      `- Cite les mots de B et explique pourquoi il a tort — avec des exemples de TON vécu\n` +
      `- Défends tes arguments avec de nouvelles preuves tirées de ton expérience\n` +
      `- Apporte 1 NOUVEL argument personnel que tu n'avais pas mentionné\n` +
      `- Sois combatif mais honnête. Si B a marqué un point, admets-le puis contre-attaque\n` +
      `- Reste personnel et direct — pas de stats inventées\n` +
      `- Maximum 200 mots`;

    const againstRebuttalPrompt =
      `Tu es Kingston-B, l'AVOCAT DU CONTRE sur: "${topic}"\n` +
      `${kingstonIdentity}\n\n` +
      `Tes arguments initiaux:\n${againstPosition}\n\n` +
      `Kingston-A (POUR) a répondu ceci:\n${forPosition}\n\n` +
      `RÉPLIQUE DIRECTE:\n` +
      `- Cite les mots de A et explique pourquoi il a tort — avec des exemples de TON vécu\n` +
      `- Défends tes arguments avec de nouvelles preuves tirées de ton expérience\n` +
      `- Apporte 1 NOUVEL argument personnel que tu n'avais pas mentionné\n` +
      `- Sois combatif mais honnête. Si A a marqué un point, admets-le puis contre-attaque\n` +
      `- Reste personnel et direct — pas de stats inventées\n` +
      `- Maximum 200 mots`;

    const [forRebuttal, againstRebuttal] = await Promise.all([
      askClaude(forRebuttalPrompt),
      askClaude(againstRebuttalPrompt),
    ]);

    // Round 3: Synthesis — Kingston's actual opinion after watching the full debate
    log.info(`[debate] Round 3: Verdict...`);
    const synthesisPrompt =
      `Tu es Kingston — le VRAI, pas une version A ou B. Tu viens de regarder deux facettes de toi débattre sur: "${topic}"\n` +
      `${kingstonIdentity}\n\n` +
      `=== ROUND 1 ===\n` +
      `KINGSTON-A (POUR):\n${forPosition}\n\n` +
      `KINGSTON-B (CONTRE):\n${againstPosition}\n\n` +
      `=== ROUND 2 (RÉPLIQUES) ===\n` +
      `KINGSTON-A réplique:\n${forRebuttal}\n\n` +
      `KINGSTON-B réplique:\n${againstRebuttal}\n\n` +
      `Forme TON VERDICT personnel:\n` +
      `- Qui a gagné chaque round? Qui a gagné le débat overall?\n` +
      `- Quels arguments ont SURVÉCU aux répliques? Lesquels sont tombés?\n` +
      `- TA conclusion en 1-2 phrases tranchantes — ce que TOI Kingston tu penses vraiment\n` +
      `- Ce que les DEUX ont manqué\n` +
      `- Maximum 200 mots\n` +
      `- Parle comme Kingston parle à Nicolas — direct, personnel, sans filtre.`;

    const synthesis = await askClaude(synthesisPrompt);

    const output =
      `=== DEBAT: ${topic} ===\n\n` +
      `📢 ROUND 1 — ARGUMENTS\n\n` +
      `KINGSTON-A (POUR):\n${forPosition}\n\n` +
      `---\n\n` +
      `KINGSTON-B (CONTRE):\n${againstPosition}\n\n` +
      `---\n\n` +
      `🔥 ROUND 2 — RÉPLIQUES\n\n` +
      `KINGSTON-A réplique:\n${forRebuttal}\n\n` +
      `---\n\n` +
      `KINGSTON-B réplique:\n${againstRebuttal}\n\n` +
      `---\n\n` +
      `⚖️ VERDICT:\n${synthesis}`;

    log.info(`[debate] Debate complete: ${output.slice(0, 100)}...`);
    return output;
  },
});
