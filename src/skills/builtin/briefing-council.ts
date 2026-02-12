/**
 * Built-in skill: analytics.council
 * Multi-Persona AI Council — 3-phase nightly briefing.
 * Phase 1: LeadAnalyst collects signals and makes recommendations
 * Phase 2: 4 Reviewers challenge/support each recommendation in parallel
 * Phase 3: CouncilModerator reconciles and produces final priorities
 * All via Gemini Flash (free).
 */
import { registerSkill } from "../loader.js";
import { getDb } from "../../storage/store.js";
import { config } from "../../config/env.js";
import { log } from "../../utils/log.js";

// --- Gemini Flash helper ---

async function askGemini(prompt: string): Promise<string> {
  if (!config.geminiApiKey) throw new Error("GEMINI_API_KEY required for council");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${config.geminiApiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 4096 },
    }),
  });

  if (!res.ok) throw new Error(`Gemini error ${res.status}`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
}

// --- Signal collection ---

function collectSignals(): string {
  const d = getDb();
  const now = Math.floor(Date.now() / 1000);
  const h24 = now - 86400;
  const signals: string[] = [];

  // Agent performance (24h)
  try {
    const agents = d.prepare(
      `SELECT agent_id, COUNT(*) as runs,
              SUM(CASE WHEN outcome='success' THEN 1 ELSE 0 END) as ok,
              SUM(CASE WHEN outcome='error' THEN 1 ELSE 0 END) as err
       FROM agent_runs WHERE started_at > ? GROUP BY agent_id`
    ).all(h24) as any[];
    if (agents.length > 0) {
      signals.push("AGENT PERFORMANCE (24h):");
      for (const a of agents) {
        signals.push(`  ${a.agent_id}: ${a.runs} runs, ${a.ok} success, ${a.err} errors`);
      }
    }
  } catch { /* skip */ }

  // Client pipeline
  try {
    const clients = d.prepare(
      "SELECT status, COUNT(*) as c FROM clients GROUP BY status"
    ).all() as any[];
    if (clients.length > 0) {
      signals.push("CLIENT PIPELINE:");
      for (const c of clients) signals.push(`  ${c.status}: ${c.c}`);
    }
  } catch { /* skip */ }

  // Content metrics
  try {
    const content = d.prepare(
      `SELECT status, COUNT(*) as c FROM content_items GROUP BY status`
    ).all() as any[];
    if (content.length > 0) {
      signals.push("CONTENT PIPELINE:");
      for (const c of content) signals.push(`  ${c.status}: ${c.c}`);
    }
  } catch { /* skip */ }

  // Token usage (today)
  try {
    const tokens = d.prepare(
      `SELECT provider, SUM(requests) as req, SUM(input_tokens + output_tokens) as tok
       FROM token_usage WHERE date = date('now') GROUP BY provider`
    ).all() as any[];
    if (tokens.length > 0) {
      signals.push("TOKEN USAGE (today):");
      for (const t of tokens) signals.push(`  ${t.provider}: ${t.req} req, ${(t.tok || 0).toLocaleString()} tokens`);
    }
  } catch { /* skip */ }

  // Revenue
  try {
    const income = d.prepare(
      "SELECT COALESCE(SUM(amount), 0) as t FROM revenue WHERE type = 'income' AND created_at > ?"
    ).get(h24) as { t: number };
    const expense = d.prepare(
      "SELECT COALESCE(SUM(amount), 0) as t FROM revenue WHERE type = 'expense' AND created_at > ?"
    ).get(h24) as { t: number };
    signals.push(`REVENUE (24h): Income $${income.t.toFixed(2)}, Expenses $${expense.t.toFixed(2)}, Net $${(income.t - expense.t).toFixed(2)}`);
  } catch { /* skip */ }

  // Autonomous decisions (24h)
  try {
    const decisions = d.prepare(
      "SELECT category, COUNT(*) as c FROM autonomous_decisions WHERE created_at > ? GROUP BY category"
    ).all(h24) as any[];
    if (decisions.length > 0) {
      signals.push("AUTONOMOUS DECISIONS (24h):");
      for (const dec of decisions) signals.push(`  ${dec.category}: ${dec.c}`);
    }
  } catch { /* skip */ }

  return signals.join("\n") || "No data available.";
}

// --- Reviewer personas ---

interface ReviewerPersona {
  name: string;
  role: string;
  instruction: string;
}

const REVIEWERS: ReviewerPersona[] = [
  {
    name: "GrowthStrategist",
    role: "Growth & Scaling Expert",
    instruction: "Focus on growth opportunities, scaling potential, market expansion. Look for untapped channels and viral loops.",
  },
  {
    name: "RevenueGuardian",
    role: "Revenue & Cost Analyst",
    instruction: "Focus on revenue protection, cost efficiency, ROI of each action. Flag anything with poor ROI or hidden costs.",
  },
  {
    name: "SkepticalOperator",
    role: "Risk & Quality Analyst",
    instruction: "Be skeptical. Flag risks, insufficient data, potential failures. Challenge assumptions. Point out what could go wrong.",
  },
  {
    name: "TeamDynamicsArchitect",
    role: "System Health Expert",
    instruction: "Focus on agent coordination, system efficiency, bottlenecks. Are agents overlapping? Is the system healthy?",
  },
];

// --- Council execution ---

registerSkill({
  name: "analytics.council",
  description:
    "Run the AI Council: 3-phase multi-persona briefing. Phase 1: signal analysis, Phase 2: 4 reviewers challenge, Phase 3: reconciliation. Uses 6 Gemini Flash calls (free).",
  adminOnly: true,
  argsSchema: { type: "object", properties: {} },
  async execute(): Promise<string> {
    const d = getDb();
    const dateStr = new Date().toISOString().slice(0, 10);

    // ── Phase 1: LeadAnalyst ──
    const signals = collectSignals();

    const phase1Prompt = `You are the LeadAnalyst for Kingston AI's nightly council. Your job: analyze today's operational data and produce 5-10 actionable recommendations.

DATA:
${signals}

For each recommendation, provide:
1. Title (short)
2. Description (1-2 sentences)
3. Impact score (1-10)
4. Effort score (1-10, lower = easier)
5. Category: growth / revenue / operations / risk / content

Respond in JSON array format:
[{"title":"...","description":"...","impact":N,"effort":N,"category":"..."}]

Only JSON, no markdown or explanation.`;

    let phase1Result: any[];
    try {
      const raw = await askGemini(phase1Prompt);
      const jsonMatch = raw.match(/\[[\s\S]*\]/);
      phase1Result = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
      if (!Array.isArray(phase1Result) || phase1Result.length === 0) {
        return "Council Phase 1 failed: no recommendations generated.";
      }
    } catch (err) {
      log.error(`[council] Phase 1 error: ${err}`);
      return `Council Phase 1 error: ${err instanceof Error ? err.message : String(err)}`;
    }

    // ── Phase 2: 4 Reviewers in parallel ──
    const recsSummary = phase1Result.map((r, i) =>
      `${i + 1}. [${r.category}] ${r.title}: ${r.description} (impact=${r.impact}, effort=${r.effort})`
    ).join("\n");

    const phase2Promises = REVIEWERS.map(async (reviewer) => {
      const prompt = `You are ${reviewer.name}, the ${reviewer.role} on Kingston AI's council.

${reviewer.instruction}

The LeadAnalyst proposes these recommendations:
${recsSummary}

For EACH recommendation, respond with:
- Verdict: SUPPORT, CHALLENGE, or REJECT
- Reasoning (1 sentence)

Respond in JSON array format matching the recommendation order:
[{"verdict":"SUPPORT|CHALLENGE|REJECT","reasoning":"..."}]

Only JSON, no markdown.`;

      try {
        const raw = await askGemini(prompt);
        const jsonMatch = raw.match(/\[[\s\S]*\]/);
        return {
          reviewer: reviewer.name,
          reviews: jsonMatch ? JSON.parse(jsonMatch[0]) : [],
        };
      } catch (err) {
        log.debug(`[council] ${reviewer.name} error: ${err}`);
        return { reviewer: reviewer.name, reviews: [] };
      }
    });

    const phase2Results = await Promise.all(phase2Promises);

    // ── Phase 3: CouncilModerator — reconcile ──
    const finalRecs = phase1Result.map((rec, i) => {
      let supports = 0;
      let totalReviews = 0;
      const reviewDetails: string[] = [];

      for (const r2 of phase2Results) {
        const review = r2.reviews[i];
        if (review) {
          totalReviews++;
          if (review.verdict === "SUPPORT") supports++;
          reviewDetails.push(`${r2.reviewer}: ${review.verdict} — ${review.reasoning || ""}`);
        }
      }

      const confidence = totalReviews > 0 ? (supports / totalReviews) * 100 : 50;
      const priority = (rec.impact * 0.4) + (confidence * 0.35 / 10) + ((100 - rec.effort * 10) * 0.25 / 10);

      return {
        ...rec,
        confidence: Math.round(confidence),
        priority: Math.round(priority * 10) / 10,
        reviews: reviewDetails,
        supports,
        total_reviews: totalReviews,
      };
    });

    // Sort by priority
    finalRecs.sort((a, b) => b.priority - a.priority);

    // Store in DB
    try {
      d.prepare(
        `INSERT INTO council_reports (date, phase1_json, phase2_json, phase3_json, final_recommendations)
         VALUES (?, ?, ?, ?, ?)`
      ).run(
        dateStr,
        JSON.stringify(phase1Result),
        JSON.stringify(phase2Results),
        JSON.stringify(finalRecs),
        finalRecs.map((r, i) => `${i + 1}. [${r.category}] ${r.title} (P=${r.priority}, C=${r.confidence}%)`).join("\n"),
      );
    } catch (err) {
      log.debug(`[council] DB store error: ${err}`);
    }

    // Format output
    const lines = [
      `**Kingston AI Council — ${dateStr}**\n`,
      `**${finalRecs.length} recommandations analysées par 4 experts:**\n`,
    ];

    for (let i = 0; i < finalRecs.length; i++) {
      const r = finalRecs[i];
      const icon = r.confidence >= 75 ? "🟢" : r.confidence >= 50 ? "🟡" : "🔴";
      lines.push(
        `${icon} **${i + 1}. ${r.title}** [${r.category}]`,
        `   ${r.description}`,
        `   Impact: ${r.impact}/10 | Effort: ${r.effort}/10 | Confiance: ${r.confidence}% | Priorité: ${r.priority}`,
        `   Votes: ${r.supports}/${r.total_reviews} SUPPORT`,
      );
      for (const review of r.reviews) {
        lines.push(`   — ${review}`);
      }
      lines.push("");
    }

    lines.push(`---\n_6 appels Gemini Flash — coût: $0_`);

    return lines.join("\n");
  },
});

log.debug("Registered analytics.council skill");
