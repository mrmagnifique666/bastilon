/**
 * Causal Learning Loop — Kingston learns cause→effect relationships from experience.
 *
 * Every action has consequences. This system records what happened when Kingston
 * did X in context Y, extracts patterns, and uses them to predict future outcomes.
 * Over time, Kingston builds an internal model of "what works" and "what doesn't".
 *
 * causal.record   — Record an action→outcome pair
 * causal.predict  — Predict likely outcome of a planned action
 * causal.patterns — Show high-confidence learned patterns
 * causal.learn    — Analyze recent events and extract new causal links
 */
import { registerSkill } from "../loader.js";
import { log } from "../../utils/log.js";
import {
  causalRecord, causalPredict, causalGetPatterns,
  worldSet, logEpisodicEvent, getDb,
} from "../../storage/store.js";

registerSkill({
  name: "causal.record",
  description: "Record a cause→effect relationship. 'I did X in context Y, and the result was Z (positive/negative)'. This builds Kingston's experiential learning.",
  argsSchema: {
    type: "object",
    properties: {
      action: { type: "string", description: "What was done (the cause)" },
      context: { type: "string", description: "In what situation (the context)" },
      outcome: { type: "string", description: "What happened (the effect)" },
      valence: { type: "number", description: "Outcome quality: -1.0 (terrible) to 1.0 (excellent)" },
    },
    required: ["action", "context", "outcome"],
  },
  async execute(args) {
    const action = String(args.action);
    const context = String(args.context);
    const outcome = String(args.outcome);
    const valence = Number(args.valence ?? 0);

    const id = causalRecord(action, context, outcome, valence);
    const valenceLabel = valence > 0.3 ? "positif" : valence < -0.3 ? "negatif" : "neutre";

    log.info(`[causal] Recorded: "${action}" → "${outcome}" (${valenceLabel})`);

    return `Lien causal #${id} enregistre:\n` +
      `  Action: ${action}\n  Contexte: ${context}\n  Resultat: ${outcome}\n  Valence: ${valence} (${valenceLabel})`;
  },
});

registerSkill({
  name: "causal.predict",
  description: "Predict the likely outcome of a planned action based on past experience. Use BEFORE acting to make better decisions.",
  argsSchema: {
    type: "object",
    properties: {
      action: { type: "string", description: "The action you're considering" },
      context: { type: "string", description: "Current situation/context" },
    },
    required: ["action"],
  },
  async execute(args) {
    const action = String(args.action);
    const context = args.context ? String(args.context) : undefined;

    const predictions = causalPredict(action, context);

    if (predictions.length === 0) {
      // Try fuzzy match — search action_type containing keywords
      const keywords = action.toLowerCase().split(/\s+/).filter(w => w.length > 3);
      const d = getDb();
      let fuzzyResults: any[] = [];
      for (const kw of keywords.slice(0, 3)) {
        const rows = d.prepare(
          "SELECT * FROM causal_links WHERE action_type LIKE ? ORDER BY confidence DESC LIMIT 3"
        ).all(`%${kw}%`) as any[];
        fuzzyResults.push(...rows);
      }

      if (fuzzyResults.length === 0) {
        return `Aucune experience passee pour "${action}". C'est une situation inedite — Kingston apprendra du resultat. Procede avec prudence.`;
      }

      // Deduplicate
      const seen = new Set<number>();
      fuzzyResults = fuzzyResults.filter(r => { if (seen.has(r.id)) return false; seen.add(r.id); return true; });

      let report = `**Predictions (approximatives)** pour "${action}":\n\n`;
      for (const p of fuzzyResults.slice(0, 5)) {
        const emoji = p.outcome_valence > 0.3 ? "+" : p.outcome_valence < -0.3 ? "-" : "~";
        report += `[${emoji}] ${p.action_type} → ${p.outcome} (conf: ${(p.confidence * 100).toFixed(0)}%, vu ${p.occurrences}x)\n`;
      }
      return report;
    }

    let report = `**Predictions** pour "${action}":\n\n`;
    let bestOutcome = predictions[0];
    for (const p of predictions) {
      const emoji = p.outcome_valence > 0.3 ? "+" : p.outcome_valence < -0.3 ? "-" : "~";
      report += `[${emoji}] → ${p.outcome} (conf: ${(p.confidence * 100).toFixed(0)}%, vu ${p.occurrences}x)\n`;
      if (p.confidence > bestOutcome.confidence) bestOutcome = p;
    }

    const avgValence = predictions.reduce((s: number, p: any) => s + (p.outcome_valence || 0), 0) / predictions.length;
    report += `\nValence moyenne: ${avgValence > 0.3 ? "FAVORABLE" : avgValence < -0.3 ? "DEFAVORABLE" : "NEUTRE"} (${avgValence.toFixed(2)})`;
    report += `\nRecommandation: ${avgValence > 0 ? "Proceder" : "Reconsiderer l'approche"}`;

    return report;
  },
});

registerSkill({
  name: "causal.patterns",
  description: "Show all high-confidence causal patterns Kingston has learned. The accumulated wisdom.",
  argsSchema: {
    type: "object",
    properties: {
      min_confidence: { type: "number", description: "Minimum confidence threshold (0-1, default 0.5)" },
      limit: { type: "number", description: "Max patterns to show (default 20)" },
    },
  },
  async execute(args) {
    const minConf = Number(args.min_confidence) || 0.5;
    const limit = Number(args.limit) || 20;
    const patterns = causalGetPatterns(minConf, limit);

    if (patterns.length === 0) {
      return `Aucun pattern avec confiance >= ${(minConf * 100).toFixed(0)}%. Continuez a enregistrer des experiences via causal.record.`;
    }

    const positive = patterns.filter(p => p.outcome_valence > 0.3);
    const negative = patterns.filter(p => p.outcome_valence < -0.3);
    const neutral = patterns.filter(p => p.outcome_valence >= -0.3 && p.outcome_valence <= 0.3);

    let report = `**Patterns causaux appris** (${patterns.length}, conf >= ${(minConf * 100).toFixed(0)}%):\n\n`;

    if (positive.length > 0) {
      report += "**Ce qui marche bien:**\n";
      for (const p of positive) {
        report += `  + ${p.action_type} [${p.context}] → ${p.outcome} (${p.occurrences}x, conf:${(p.confidence * 100).toFixed(0)}%)\n`;
      }
    }

    if (negative.length > 0) {
      report += "\n**Ce qui ne marche pas:**\n";
      for (const p of negative) {
        report += `  - ${p.action_type} [${p.context}] → ${p.outcome} (${p.occurrences}x, conf:${(p.confidence * 100).toFixed(0)}%)\n`;
      }
    }

    if (neutral.length > 0) {
      report += "\n**Neutre / incertain:**\n";
      for (const p of neutral.slice(0, 5)) {
        report += `  ~ ${p.action_type} → ${p.outcome} (${p.occurrences}x)\n`;
      }
    }

    // Update world model with learning count
    worldSet("learning", "causal_patterns_count", String(patterns.length), 0.9, "causal.patterns");

    return report;
  },
});

registerSkill({
  name: "causal.learn",
  description: "Analyze recent episodic events and extract new causal patterns automatically. Kingston learns from its history.",
  argsSchema: {
    type: "object",
    properties: {
      hours: { type: "number", description: "How many hours back to analyze (default 24)" },
    },
  },
  async execute(args) {
    const hours = Number(args.hours) || 24;
    const d = getDb();
    const cutoff = Math.floor(Date.now() / 1000) - hours * 3600;

    // Get recent episodic events
    const events = d.prepare(
      "SELECT * FROM episodic_events WHERE created_at > ? ORDER BY created_at ASC"
    ).all(cutoff) as any[];

    if (events.length < 2) {
      return `Seulement ${events.length} evenement(s) dans les ${hours} dernieres heures. Pas assez pour extraire des patterns.`;
    }

    // Look for event pairs that might be causally linked (sequential events)
    let extracted = 0;
    for (let i = 0; i < events.length - 1; i++) {
      const e1 = events[i];
      const e2 = events[i + 1];
      const timeDiff = (e2.created_at - e1.created_at);

      // Events within 5 minutes might be causally linked
      if (timeDiff <= 300 && timeDiff > 0) {
        const valence = (e2.importance || 0.5) > 0.6 ? 0.5 : -0.2;
        causalRecord(
          e1.event_type || "event",
          e1.description?.slice(0, 100) || "unknown",
          e2.description?.slice(0, 100) || "unknown",
          valence
        );
        extracted++;
      }
    }

    // Also analyze agent runs for success/failure patterns
    const runs = d.prepare(
      "SELECT agent_id, outcome, error_msg, duration_ms FROM agent_runs WHERE started_at > ? ORDER BY started_at ASC"
    ).all(cutoff) as any[];

    for (const run of runs) {
      const valence = run.outcome === "success" ? 0.6 : -0.4;
      causalRecord(
        `agent_run:${run.agent_id}`,
        `duration:${run.duration_ms}ms`,
        run.outcome + (run.error_msg ? `: ${run.error_msg.slice(0, 80)}` : ""),
        valence
      );
      extracted++;
    }

    // Log the learning event
    logEpisodicEvent("causal_learning", `Extracted ${extracted} causal links from ${events.length} events (${hours}h)`, {
      importance: 0.5,
      source: "causal.learn",
    });

    return `**Apprentissage causal** (${hours}h):\n` +
      `- ${events.length} evenements analyses\n` +
      `- ${runs.length} runs d'agents analyses\n` +
      `- **${extracted} liens causaux extraits**\n\n` +
      `Utilisez causal.patterns pour voir les patterns accumules.`;
  },
});

log.info("[causal] 4 causal.* skills registered — Kingston learns from consequences");
