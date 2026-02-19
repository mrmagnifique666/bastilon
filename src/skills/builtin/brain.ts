/**
 * Built-in skills: brain.think, brain.research, brain.find_api
 * Smart escalation — lets Ollama/agents delegate complex reasoning to Claude (Opus/Sonnet).
 * Claude CLI on Max plan = $0, so this is free but much smarter than Ollama 14B.
 */
import { registerSkill } from "../loader.js";
import { runClaude, type ParsedResult } from "../../llm/claudeCli.js";
import { log } from "../../utils/log.js";

// Use a dedicated chatId for brain escalation (avoids polluting agent sessions)
const BRAIN_CHAT_ID = 108;

/**
 * Run a prompt through Claude CLI and return the text result.
 * Strips tool calls — this is pure reasoning only.
 */
async function askClaude(prompt: string): Promise<string> {
  try {
    const result: ParsedResult = await runClaude(
      BRAIN_CHAT_ID,
      prompt,
      true, // admin
      "sonnet" // Use Sonnet for fast + smart ($0 on Max)
    );
    if (result.text) return result.text;
    if (result.toolResults?.length) {
      return result.toolResults.map(t => t.result).join("\n");
    }
    return "Claude n'a pas pu répondre.";
  } catch (err) {
    log.error(`[brain] Claude escalation failed: ${err}`);
    return `Erreur escalation Claude: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ── brain.think — Complex reasoning via Claude ──

registerSkill({
  name: "brain.think",
  description:
    "Escalate complex reasoning to Claude (Sonnet/Opus). Use when you're stuck, need multi-step analysis, strategic planning, code generation, or any task that requires higher intelligence. Free on Max plan.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      problem: {
        type: "string",
        description: "The complex problem or question to solve",
      },
      context: {
        type: "string",
        description: "Relevant context (data, constraints, previous attempts)",
      },
      output_format: {
        type: "string",
        description: "Desired output format: 'analysis', 'plan', 'code', 'decision', 'summary' (default: analysis)",
      },
    },
    required: ["problem"],
  },
  async execute(args): Promise<string> {
    const problem = String(args.problem);
    const context = args.context ? String(args.context) : "";
    const format = String(args.output_format || "analysis");

    const prompt =
      `Tu es Kingston, un assistant IA expert. Un de tes sous-systèmes (Ollama) a besoin de ton aide pour un problème complexe.\n\n` +
      `PROBLÈME:\n${problem}\n\n` +
      (context ? `CONTEXTE:\n${context}\n\n` : "") +
      `FORMAT DE SORTIE: ${format}\n` +
      `RÈGLES:\n` +
      `- Sois direct et actionnable\n` +
      `- Si c'est un plan, numérote les étapes\n` +
      `- Si c'est du code, écris du TypeScript propre\n` +
      `- Si c'est une décision, donne le pour/contre puis ta recommandation\n` +
      `- Maximum 500 mots`;

    log.info(`[brain] Escalating to Claude: ${problem.slice(0, 80)}...`);
    const result = await askClaude(prompt);
    log.info(`[brain] Claude response: ${result.slice(0, 100)}...`);
    return result;
  },
});

// ── brain.research — Deep web research via Claude ──

registerSkill({
  name: "brain.research",
  description:
    "Deep research on a topic using Claude's intelligence. Produces a structured analysis with sources, alternatives, and recommendations. Use for API discovery, market research, competitive analysis, etc.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      topic: {
        type: "string",
        description: "What to research (e.g. 'best free weather API with hourly forecast')",
      },
      goal: {
        type: "string",
        description: "What you need to accomplish with this research",
      },
      constraints: {
        type: "string",
        description: "Constraints: budget, tech stack, etc.",
      },
    },
    required: ["topic"],
  },
  async execute(args): Promise<string> {
    const topic = String(args.topic);
    const goal = args.goal ? String(args.goal) : "";
    const constraints = args.constraints ? String(args.constraints) : "gratuit, TypeScript, pas de clé API si possible";

    const prompt =
      `Tu es Kingston, assistant IA. Fais une RECHERCHE APPROFONDIE sur ce sujet.\n\n` +
      `SUJET: ${topic}\n` +
      (goal ? `OBJECTIF: ${goal}\n` : "") +
      `CONTRAINTES: ${constraints}\n\n` +
      `STRUCTURE TA RÉPONSE:\n` +
      `1. RÉSUMÉ (2-3 phrases)\n` +
      `2. OPTIONS TROUVÉES (min 3, avec URL si possible)\n` +
      `   Pour chaque option: nom, description, avantages, inconvénients, coût\n` +
      `3. RECOMMANDATION (1 choix avec justification)\n` +
      `4. ÉTAPES D'IMPLÉMENTATION (si applicable)\n` +
      `5. ALTERNATIVES si l'option 1 échoue\n\n` +
      `RÈGLES:\n` +
      `- Cite des URLs réels et vérifiés\n` +
      `- Si tu n'es pas sûr d'une URL, dis-le\n` +
      `- Préfère les solutions gratuites et open-source\n` +
      `- Maximum 600 mots`;

    log.info(`[brain] Research via Claude: ${topic.slice(0, 80)}...`);
    const result = await askClaude(prompt);
    return result;
  },
});

// ── brain.find_api — Discover and evaluate APIs for a specific need ──

registerSkill({
  name: "brain.find_api",
  description:
    "Find the best API for a specific need. Searches documentation, evaluates options, and returns implementation instructions. Use when you need to integrate a new service.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      need: {
        type: "string",
        description: "What you need (e.g. 'send SMS', 'get stock prices', 'translate text')",
      },
      requirements: {
        type: "string",
        description: "Specific requirements (free tier, no API key, REST, etc.)",
      },
    },
    required: ["need"],
  },
  async execute(args): Promise<string> {
    const need = String(args.need);
    const requirements = args.requirements ? String(args.requirements) : "gratuit ou free tier, REST API, TypeScript compatible";

    const prompt =
      `Tu es Kingston, assistant IA spécialisé en intégration d'APIs.\n\n` +
      `BESOIN: ${need}\n` +
      `EXIGENCES: ${requirements}\n\n` +
      `TROUVE LA MEILLEURE API. Pour chaque option:\n` +
      `1. Nom + URL officielle\n` +
      `2. Free tier? Limites?\n` +
      `3. Auth: API key? OAuth? Rien?\n` +
      `4. Exemple d'appel (curl ou fetch TypeScript)\n` +
      `5. Score /10 (fiabilité, gratuité, facilité)\n\n` +
      `RECOMMANDATION FINALE:\n` +
      `- L'API recommandée\n` +
      `- Code TypeScript d'intégration (fetch, pas de SDK externe)\n` +
      `- Comment obtenir les credentials si nécessaire\n` +
      `- Plan B si l'API principale tombe\n\n` +
      `RÈGLES:\n` +
      `- APIs RÉELLES uniquement (pas d'hallucination)\n` +
      `- Si tu n'es pas sûr qu'une API existe, dis-le\n` +
      `- Préfère: pas de clé > clé gratuite > freemium > payant`;

    log.info(`[brain] API discovery via Claude: ${need.slice(0, 80)}...`);
    const result = await askClaude(prompt);
    return result;
  },
});
