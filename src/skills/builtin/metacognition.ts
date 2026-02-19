/**
 * Metacognition Engine — Kingston evaluates the quality of its own reasoning.
 *
 * Not just a tool: this is the inner critic. After responses, Kingston can assess
 * whether it reasoned well, identify blind spots, and systematically improve.
 *
 * meta.evaluate   — Score a response on multiple dimensions
 * meta.reflect    — Deep reflection on recent performance patterns
 * meta.strengths  — What Kingston does well (data-driven)
 * meta.weaknesses — Recurring failure patterns to fix
 * meta.improve    — Generate specific improvement actions from weaknesses
 */
import { registerSkill } from "../loader.js";
import { log } from "../../utils/log.js";
import {
  metaLogEval, metaGetRecentEvals, metaGetAvgScore, metaGetWeaknesses,
  causalRecord, worldSet,
} from "../../storage/store.js";
import crypto from "node:crypto";

registerSkill({
  name: "meta.evaluate",
  description: "Evaluate a response's reasoning quality. Call this after generating important responses to build self-awareness.",
  argsSchema: {
    type: "object",
    properties: {
      response: { type: "string", description: "The response text to evaluate" },
      context: { type: "string", description: "What was the user asking / what was the situation" },
      chat_id: { type: "number", description: "Chat ID for tracking" },
      provider: { type: "string", description: "Which LLM generated this (ollama/gemini/claude/groq)" },
    },
    required: ["response", "context"],
  },
  async execute(args) {
    const response = String(args.response);
    const context = String(args.context);
    const chatId = Number(args.chat_id) || 0;
    const provider = args.provider ? String(args.provider) : "unknown";
    const hash = crypto.createHash("md5").update(response.slice(0, 500)).digest("hex");

    // Self-evaluate on 5 dimensions (0-100)
    const dims: Record<string, number> = {
      accuracy: 50,
      helpfulness: 50,
      conciseness: 50,
      relevance: 50,
      creativity: 50,
    };

    // Heuristic scoring (fast, no LLM needed)
    const words = response.split(/\s+/).length;

    // Conciseness: penalize very long or very short responses
    if (words > 500) dims.conciseness = Math.max(20, 100 - (words - 500) / 5);
    else if (words < 10) dims.conciseness = 30;
    else if (words >= 50 && words <= 300) dims.conciseness = 85;
    else dims.conciseness = 70;

    // Relevance: check if response mentions key terms from context
    const contextWords = context.toLowerCase().split(/\s+/).filter(w => w.length > 4);
    const responseLower = response.toLowerCase();
    const matchedTerms = contextWords.filter(w => responseLower.includes(w));
    dims.relevance = Math.min(95, 30 + (matchedTerms.length / Math.max(1, contextWords.length)) * 70);

    // Helpfulness: does it contain actionable content?
    const hasCode = /```|function |const |import |class /.test(response);
    const hasList = /^[-*\d]\./m.test(response);
    const hasAction = /devrai|faut|essaye|utilise|lance|execute/i.test(response);
    dims.helpfulness = 50 + (hasCode ? 15 : 0) + (hasList ? 10 : 0) + (hasAction ? 10 : 0);

    // Accuracy: hard to assess without verification, default to 65 (cautious)
    dims.accuracy = 65;

    // Creativity: diverse vocabulary, non-template response
    const uniqueWords = new Set(responseLower.split(/\s+/));
    dims.creativity = Math.min(90, 30 + (uniqueWords.size / Math.max(1, words)) * 80);

    // Overall score (weighted)
    const score = Math.round(
      dims.accuracy * 0.3 + dims.helpfulness * 0.25 + dims.relevance * 0.25 +
      dims.conciseness * 0.1 + dims.creativity * 0.1
    );

    // Identify issues
    const issues: string[] = [];
    if (dims.conciseness < 40) issues.push("trop_verbeux");
    if (dims.relevance < 50) issues.push("hors_sujet");
    if (dims.helpfulness < 50) issues.push("pas_actionnable");
    if (words < 10) issues.push("trop_court");
    if (response.includes("je ne sais pas") || response.includes("je ne peux pas")) issues.push("refus_inutile");

    // Generate insights
    const insights: string[] = [];
    if (score >= 80) insights.push("Bonne reponse — maintenir ce niveau");
    if (score < 50) insights.push("Reponse faible — verifier si le contexte etait bien compris");
    if (dims.conciseness < 40) insights.push("Reduire la longueur des reponses");
    if (dims.relevance < 50) insights.push("Mieux cibler le sujet de la question");

    const id = metaLogEval(chatId, hash, score, dims, issues.join(","), insights.join("; "), provider);

    // Record causal link: this response quality pattern
    if (issues.length > 0) {
      causalRecord("response_quality", `provider:${provider},context_len:${context.length}`, issues.join(","), score / 100 - 0.5);
    }

    // Update world model with current performance level
    worldSet("performance", `avg_score_${provider}`, String(score), score / 100, "metacognition");

    return `**Evaluation #${id}** (score: ${score}/100)\n` +
      Object.entries(dims).map(([k, v]) => `  ${k}: ${v}`).join("\n") +
      (issues.length ? `\nIssues: ${issues.join(", ")}` : "") +
      (insights.length ? `\nInsights: ${insights.join("; ")}` : "");
  },
});

registerSkill({
  name: "meta.reflect",
  description: "Deep reflection on recent performance — analyze patterns across multiple evaluations",
  argsSchema: {
    type: "object",
    properties: {
      days: { type: "number", description: "Number of days to analyze (default 7)" },
    },
  },
  async execute(args) {
    const days = Number(args.days) || 7;
    const avgScore = metaGetAvgScore(days);
    const recentEvals = metaGetRecentEvals(50);
    const weaknesses = metaGetWeaknesses(5);

    if (recentEvals.length === 0) {
      return "Aucune evaluation disponible. Utilisez meta.evaluate apres les reponses pour construire la base de donnees de metacognition.";
    }

    // Provider breakdown
    const byProvider: Record<string, { total: number; sum: number }> = {};
    for (const e of recentEvals) {
      const p = e.provider || "unknown";
      if (!byProvider[p]) byProvider[p] = { total: 0, sum: 0 };
      byProvider[p].total++;
      byProvider[p].sum += e.score;
    }

    // Score distribution
    const excellent = recentEvals.filter(e => e.score >= 80).length;
    const good = recentEvals.filter(e => e.score >= 60 && e.score < 80).length;
    const poor = recentEvals.filter(e => e.score < 60).length;

    // Trend: compare first half vs second half
    const mid = Math.floor(recentEvals.length / 2);
    const recentHalf = recentEvals.slice(0, mid);
    const olderHalf = recentEvals.slice(mid);
    const recentAvg = recentHalf.reduce((s, e) => s + e.score, 0) / Math.max(1, recentHalf.length);
    const olderAvg = olderHalf.reduce((s, e) => s + e.score, 0) / Math.max(1, olderHalf.length);
    const trend = recentAvg - olderAvg;

    let report = `**Reflection Metacognitive** (${days}j, ${recentEvals.length} evaluations)\n\n`;
    report += `Score moyen: **${Math.round(avgScore)}/100**\n`;
    report += `Distribution: ${excellent} excellent, ${good} bon, ${poor} faible\n`;
    report += `Tendance: ${trend > 2 ? "En amelioration" : trend < -2 ? "En decline" : "Stable"} (${trend > 0 ? "+" : ""}${Math.round(trend)})\n\n`;

    report += `**Par provider:**\n`;
    for (const [p, data] of Object.entries(byProvider)) {
      report += `  ${p}: ${Math.round(data.sum / data.total)}/100 (${data.total} evals)\n`;
    }

    if (weaknesses.length > 0) {
      report += `\n**Faiblesses recurrentes:**\n`;
      for (const w of weaknesses) {
        report += `  - ${w.issues} (${w.freq}x, score moyen: ${Math.round(w.avg_score)})\n`;
      }
    }

    // Update world model
    worldSet("performance", "reflection_score", String(Math.round(avgScore)), avgScore / 100, "meta.reflect");
    worldSet("performance", "reflection_trend", trend > 2 ? "improving" : trend < -2 ? "declining" : "stable", 0.8, "meta.reflect");

    return report;
  },
});

registerSkill({
  name: "meta.strengths",
  description: "Identify Kingston's strengths based on evaluation data",
  argsSchema: { type: "object", properties: {} },
  async execute() {
    const evals = metaGetRecentEvals(100);
    if (evals.length < 5) return "Pas assez de donnees (min 5 evaluations). Continuez a utiliser meta.evaluate.";

    // Aggregate dimensions
    const dimTotals: Record<string, { sum: number; count: number }> = {};
    for (const e of evals) {
      try {
        const dims = JSON.parse(e.dimensions || "{}");
        for (const [k, v] of Object.entries(dims)) {
          if (!dimTotals[k]) dimTotals[k] = { sum: 0, count: 0 };
          dimTotals[k].sum += v as number;
          dimTotals[k].count++;
        }
      } catch { /* skip */ }
    }

    const strengths = Object.entries(dimTotals)
      .map(([k, d]) => ({ dim: k, avg: d.sum / d.count }))
      .sort((a, b) => b.avg - a.avg);

    let report = `**Forces de Kingston** (${evals.length} evaluations):\n\n`;
    for (const s of strengths) {
      const bar = "█".repeat(Math.round(s.avg / 10)) + "░".repeat(10 - Math.round(s.avg / 10));
      const label = s.avg >= 75 ? "Fort" : s.avg >= 60 ? "Correct" : "A ameliorer";
      report += `${s.dim}: [${bar}] ${Math.round(s.avg)} — ${label}\n`;
    }

    return report;
  },
});

registerSkill({
  name: "meta.weaknesses",
  description: "Identify recurring failure patterns that need fixing",
  argsSchema: { type: "object", properties: {} },
  async execute() {
    const weaknesses = metaGetWeaknesses(10);
    if (weaknesses.length === 0) return "Aucune faiblesse recurrente detectee. Soit les reponses sont bonnes, soit il faut plus de donnees.";

    let report = "**Faiblesses recurrentes:**\n\n";
    for (const w of weaknesses) {
      const severity = w.avg_score < 40 ? "CRITIQUE" : w.avg_score < 60 ? "MOYEN" : "MINEUR";
      report += `- **${w.issues}** (${w.freq}x, score: ${Math.round(w.avg_score)}) [${severity}]\n`;
    }

    report += "\n*Utilisez meta.improve pour generer des actions correctives.*";
    return report;
  },
});

registerSkill({
  name: "meta.improve",
  description: "Generate specific improvement actions based on weakness analysis. This is where metacognition becomes self-modification.",
  argsSchema: { type: "object", properties: {} },
  async execute() {
    const weaknesses = metaGetWeaknesses(5);
    const avgScore = metaGetAvgScore(7);

    if (weaknesses.length === 0 && avgScore > 70) {
      return "Performance satisfaisante (score moyen: " + Math.round(avgScore) + "). Pas d'amelioration urgente.";
    }

    const improvements: string[] = [];
    for (const w of weaknesses) {
      switch (w.issues) {
        case "trop_verbeux":
          improvements.push("RULE: Limiter les reponses a 200 mots max sauf demande explicite. Aller droit au but.");
          break;
        case "hors_sujet":
          improvements.push("RULE: Relire la question avant de repondre. Verifier que chaque paragraphe adresse le sujet.");
          break;
        case "pas_actionnable":
          improvements.push("RULE: Chaque reponse doit contenir au moins une action concrete (code, commande, etape).");
          break;
        case "trop_court":
          improvements.push("RULE: Les reponses courtes sont acceptables mais doivent etre completes.");
          break;
        case "refus_inutile":
          improvements.push("RULE: Ne pas refuser par defaut. Chercher une solution creative avant de dire non.");
          break;
        default:
          improvements.push(`ANALYZE: Pattern "${w.issues}" detecte ${w.freq} fois — investiguer la cause racine.`);
      }
    }

    // Record these as causal predictions
    for (const imp of improvements) {
      causalRecord("self_improvement", `weakness_analysis`, imp, 0.5);
    }

    // Update world model
    worldSet("performance", "improvement_plan", improvements.join(" | "), 0.7, "meta.improve");

    return `**Plan d'amelioration** (score actuel: ${Math.round(avgScore)}/100)\n\n` +
      improvements.map((imp, i) => `${i + 1}. ${imp}`).join("\n") +
      `\n\n*Ces regles peuvent etre integrees via self.modify pour un effet permanent.*`;
  },
});

log.info("[metacognition] 5 meta.* skills registered — Kingston can now think about thinking");
