/**
 * Theory of Mind — Kingston models Nicolas's mental state.
 *
 * The most human-like AGI capability: understanding what another person
 * thinks, feels, wants, and needs — even before they say it.
 *
 * Dimensions modeled:
 *   - mood: emotional state (stressed, relaxed, excited, tired...)
 *   - focus: what Nicolas is currently working on
 *   - preference: likes/dislikes, habits, patterns
 *   - knowledge: what Nicolas knows/doesn't know
 *   - need: unmet needs Kingston can proactively address
 *   - schedule: daily patterns, availability
 *
 * tom.update   — Update the model based on observed signals
 * tom.model    — View the full mental model of Nicolas
 * tom.predict  — Predict what Nicolas wants/needs right now
 * tom.needs    — Proactive suggestions based on unmet needs
 */
import { registerSkill } from "../loader.js";
import { log } from "../../utils/log.js";
import {
  tomSet, tomGet, tomGetModel, tomPredict,
  worldSet, logEpisodicEvent, causalRecord, getDb,
} from "../../storage/store.js";

const NICOLAS_ID = 8189338836;

// Signal interpretation rules
const MOOD_SIGNALS: Record<string, { mood: string; confidence: number }> = {
  "lol": { mood: "amuse", confidence: 0.6 },
  "haha": { mood: "amuse", confidence: 0.6 },
  "nice": { mood: "satisfait", confidence: 0.7 },
  "cool": { mood: "satisfait", confidence: 0.6 },
  "fuck": { mood: "frustre", confidence: 0.8 },
  "merde": { mood: "frustre", confidence: 0.8 },
  "criss": { mood: "frustre", confidence: 0.8 },
  "tabarnak": { mood: "tres_frustre", confidence: 0.9 },
  "urgent": { mood: "presse", confidence: 0.8 },
  "vite": { mood: "presse", confidence: 0.7 },
  "fatigué": { mood: "fatigue", confidence: 0.8 },
  "tired": { mood: "fatigue", confidence: 0.8 },
  "genial": { mood: "excite", confidence: 0.8 },
  "super": { mood: "satisfait", confidence: 0.6 },
  "parfait": { mood: "satisfait", confidence: 0.7 },
  "merci": { mood: "reconnaissant", confidence: 0.5 },
  "bravo": { mood: "impressionne", confidence: 0.7 },
  "?!": { mood: "surpris", confidence: 0.5 },
  "...": { mood: "incertain", confidence: 0.4 },
};

registerSkill({
  name: "tom.update",
  description: "Update Kingston's model of Nicolas based on observed signals. Call this when Nicolas sends a message or behaves in a notable way.",
  argsSchema: {
    type: "object",
    properties: {
      dimension: { type: "string", description: "What to update: mood, focus, preference, knowledge, need, schedule" },
      key: { type: "string", description: "Specific aspect (e.g. 'current_mood', 'working_on', 'prefers_short_messages')" },
      value: { type: "string", description: "The observed value" },
      signal: { type: "string", description: "Raw signal that triggered this update (e.g. Nicolas's message text)" },
      confidence: { type: "number", description: "Confidence 0-1 (default 0.5)" },
    },
    required: ["dimension", "key", "value"],
  },
  async execute(args) {
    const dimension = String(args.dimension);
    const key = String(args.key);
    const value = String(args.value);
    const signal = args.signal ? String(args.signal) : undefined;
    const confidence = Number(args.confidence) || 0.5;

    const validDims = ["mood", "focus", "preference", "knowledge", "need", "schedule"];
    if (!validDims.includes(dimension)) {
      return `Dimension invalide: "${dimension}". Options: ${validDims.join(", ")}`;
    }

    // Auto-detect mood from signal text
    if (signal && dimension === "mood") {
      const lowerSignal = signal.toLowerCase();
      for (const [trigger, moodInfo] of Object.entries(MOOD_SIGNALS)) {
        if (lowerSignal.includes(trigger)) {
          tomSet(NICOLAS_ID, "mood", "detected_mood", moodInfo.mood, moodInfo.confidence);
          tomSet(NICOLAS_ID, "mood", "mood_signal", trigger, moodInfo.confidence);
        }
      }
    }

    // Store the update
    tomSet(NICOLAS_ID, dimension, key, value, confidence);

    // Also update world model
    worldSet("personal", `nicolas_${dimension}_${key}`, value, confidence, "tom.update");

    log.info(`[tom] Updated: ${dimension}.${key} = "${value}" (conf: ${confidence})`);

    return `Modele mental mis a jour:\n  [${dimension}] ${key} = "${value}" (confiance: ${(confidence * 100).toFixed(0)}%)`;
  },
});

registerSkill({
  name: "tom.model",
  description: "View Kingston's full mental model of Nicolas — everything Kingston believes about his state, preferences, and needs.",
  argsSchema: {
    type: "object",
    properties: {
      dimension: { type: "string", description: "Filter by dimension (optional)" },
    },
  },
  async execute(args) {
    const dimension = args.dimension ? String(args.dimension) : undefined;

    if (dimension) {
      const items = tomGet(NICOLAS_ID, dimension);
      if (items.length === 0) return `Rien dans la dimension "${dimension}". Utilisez tom.update pour ajouter des observations.`;

      let report = `**Modele Mental — ${dimension}**\n\n`;
      for (const item of items) {
        const age = Math.round((Date.now() / 1000 - item.updated_at) / 3600);
        const ageStr = age < 1 ? "< 1h" : age < 24 ? `${age}h` : `${Math.round(age / 24)}j`;
        report += `  ${item.key}: ${item.value} (conf: ${(item.confidence * 100).toFixed(0)}%, ${ageStr}, ${item.evidence_count} obs)\n`;
      }
      return report;
    }

    // Full model
    const model = tomGetModel(NICOLAS_ID);
    const dims = Object.keys(model);

    if (dims.length === 0) {
      return "Le modele mental de Nicolas est vide. Kingston n'a pas encore observe de signaux.\n" +
        "Utilisez tom.update apres chaque interaction pour construire le modele.";
    }

    let report = `**Modele Mental de Nicolas** (${dims.length} dimensions)\n\n`;

    const dimLabels: Record<string, string> = {
      mood: "Humeur",
      focus: "Focus actuel",
      preference: "Preferences",
      knowledge: "Connaissances",
      need: "Besoins",
      schedule: "Habitudes",
    };

    for (const [dim, items] of Object.entries(model)) {
      report += `**[${dimLabels[dim] || dim}]** (${items.length} faits)\n`;
      for (const item of items.slice(0, 8)) {
        const bar = item.confidence >= 0.8 ? "HIGH" : item.confidence >= 0.5 ? "MED" : "LOW";
        report += `  ${item.key}: ${item.value} [${bar}]\n`;
      }
      report += "\n";
    }

    return report;
  },
});

registerSkill({
  name: "tom.predict",
  description: "Predict what Nicolas wants or needs right now based on the mental model. Uses patterns, time of day, and recent behavior.",
  argsSchema: {
    type: "object",
    properties: {
      context: { type: "string", description: "Current context (what just happened, time of day, etc.)" },
    },
  },
  async execute(args) {
    const context = args.context ? String(args.context) : "general";

    // Get high-confidence predictions from each dimension
    const predictions: Array<{ dimension: string; key: string; value: string; confidence: number }> = [];

    for (const dim of ["mood", "focus", "need", "preference", "schedule"]) {
      const items = tomPredict(NICOLAS_ID, dim);
      predictions.push(...items.map(i => ({ dimension: dim, ...i })));
    }

    if (predictions.length === 0) {
      return "Pas assez de donnees pour predire. Continuez a observer Nicolas via tom.update.";
    }

    // Time-based predictions
    const now = new Date();
    const h = now.getHours();
    const day = now.getDay();
    const timePredictions: string[] = [];

    // Morning patterns
    if (h >= 7 && h < 10) {
      timePredictions.push("Nicolas commence sa journee — briefing matinal apprecie");
      const moodItems = predictions.filter(p => p.dimension === "mood");
      if (moodItems.length === 0) timePredictions.push("Humeur pas encore detectee — attendre premier message");
    }
    // Work hours
    if (h >= 10 && h < 17 && day >= 1 && day <= 5) {
      timePredictions.push("Heures de travail — Nicolas est probablement occupe, etre concis");
    }
    // Evening
    if (h >= 19 && h < 23) {
      timePredictions.push("Soiree — plus detendu, open aux discussions fun / gaming");
    }
    // Late night
    if (h >= 23 || h < 7) {
      timePredictions.push("Nuit — ne pas deranger sauf urgence");
    }
    // Weekend
    if (day === 0 || day === 6) {
      timePredictions.push("Weekend — rythme plus lent, projets perso");
    }

    let report = `**Predictions pour Nicolas** (contexte: ${context})\n\n`;

    if (timePredictions.length > 0) {
      report += `**Temporel:**\n`;
      for (const tp of timePredictions) report += `  - ${tp}\n`;
      report += "\n";
    }

    // Group predictions by dimension
    const byDim: Record<string, typeof predictions> = {};
    for (const p of predictions) {
      if (!byDim[p.dimension]) byDim[p.dimension] = [];
      byDim[p.dimension].push(p);
    }

    for (const [dim, items] of Object.entries(byDim)) {
      report += `**${dim}:**\n`;
      for (const item of items.slice(0, 5)) {
        report += `  ${item.key}: ${item.value} (${(item.confidence * 100).toFixed(0)}%)\n`;
      }
    }

    // Synthesize recommendation
    const moodPreds = predictions.filter(p => p.dimension === "mood");
    const needPreds = predictions.filter(p => p.dimension === "need");
    const focusPreds = predictions.filter(p => p.dimension === "focus");

    report += "\n**Recommandation:**\n";
    if (moodPreds.some(p => p.value.includes("frustre"))) {
      report += "  Nicolas semble frustre — etre particulierement efficace et direct.\n";
    }
    if (moodPreds.some(p => p.value.includes("fatigue"))) {
      report += "  Nicolas est fatigue — minimiser les questions, maximiser les actions autonomes.\n";
    }
    if (needPreds.length > 0) {
      report += `  Besoin detecte: ${needPreds[0].value} — adresser proactivement.\n`;
    }
    if (focusPreds.length > 0) {
      report += `  Focus: ${focusPreds[0].value} — prioriser le contenu lie.\n`;
    }
    if (moodPreds.length === 0 && needPreds.length === 0) {
      report += "  Pas assez de signaux pour une recommandation forte. Observer plus.\n";
    }

    return report;
  },
});

registerSkill({
  name: "tom.needs",
  description: "Proactive needs detection — what Nicolas might need before he asks. Kingston anticipates and suggests.",
  argsSchema: {
    type: "object",
    properties: {
      scan_messages: { type: "boolean", description: "Scan recent messages to detect implicit needs (default true)" },
    },
  },
  async execute(args) {
    const scanMessages = args.scan_messages !== false;
    const needs: Array<{ need: string; confidence: number; source: string; action: string }> = [];

    // 1. Check existing need dimension
    const knownNeeds = tomGet(NICOLAS_ID, "need");
    for (const n of knownNeeds) {
      needs.push({
        need: `${n.key}: ${n.value}`,
        confidence: n.confidence,
        source: "modele_existant",
        action: `Adresser: ${n.value}`,
      });
    }

    // 2. Time-based needs
    const h = new Date().getHours();
    const day = new Date().getDay();

    if (h >= 7 && h < 9) {
      needs.push({
        need: "Briefing matinal",
        confidence: 0.8,
        source: "pattern_temporel",
        action: "Envoyer un resume des P&L, goals, et agenda du jour",
      });
    }
    if (h >= 17 && h < 19 && day >= 1 && day <= 5) {
      needs.push({
        need: "Resume de fin de journee",
        confidence: 0.7,
        source: "pattern_temporel",
        action: "Resume trades, avancement goals, decisions prises",
      });
    }

    // 3. Scan recent messages for implicit needs
    if (scanMessages) {
      try {
        const d = getDb();
        const recentTurns = d.prepare(
          "SELECT content FROM turns WHERE role = 'user' ORDER BY created_at DESC LIMIT 10"
        ).all() as Array<{ content: string }>;

        for (const turn of recentTurns) {
          const text = turn.content.toLowerCase();

          // Detect implicit needs
          if (text.includes("combien") || text.includes("how much")) {
            needs.push({ need: "Information financiere", confidence: 0.6, source: "message_recent", action: "Verifier trading.positions et revenue.summary" });
          }
          if (text.includes("rappel") || text.includes("oublie pas") || text.includes("remind")) {
            needs.push({ need: "Rappel configure", confidence: 0.7, source: "message_recent", action: "Creer un cron job ou rappel" });
          }
          if (text.includes("aide") || text.includes("help") || text.includes("comment")) {
            needs.push({ need: "Assistance technique", confidence: 0.6, source: "message_recent", action: "Fournir explication ou tutoriel" });
          }
          if (text.includes("stress") || text.includes("anxieux") || text.includes("worried")) {
            needs.push({ need: "Support emotionnel", confidence: 0.7, source: "message_recent", action: "Etre rassurant, montrer les progres positifs" });
          }
        }
      } catch { /* DB might not have turns */ }
    }

    // 4. Check for stale information needs
    try {
      const model = tomGetModel(NICOLAS_ID);
      const focusItems = model["focus"] || [];
      for (const f of focusItems) {
        // If focus hasn't been updated in 24h, might need refresh
        const staleHours = 24; // arbitrary
        needs.push({
          need: `Mise a jour sur: ${f.key}`,
          confidence: f.confidence * 0.5,
          source: "focus_stale",
          action: `Verifier l'etat actuel de "${f.value}" et informer Nicolas`,
        });
      }
    } catch { /* model might be empty */ }

    // Deduplicate by need text
    const seen = new Set<string>();
    const uniqueNeeds = needs.filter(n => {
      if (seen.has(n.need)) return false;
      seen.add(n.need);
      return true;
    }).sort((a, b) => b.confidence - a.confidence);

    if (uniqueNeeds.length === 0) {
      return "Aucun besoin detecte pour le moment. Nicolas semble autonome. Continuez a observer.";
    }

    let report = `**Besoins detectes pour Nicolas** (${uniqueNeeds.length}):\n\n`;
    for (const n of uniqueNeeds.slice(0, 10)) {
      const priority = n.confidence >= 0.7 ? "HAUT" : n.confidence >= 0.5 ? "MOYEN" : "BAS";
      report += `[${priority}] ${n.need}\n`;
      report += `  Source: ${n.source} | Action: ${n.action}\n\n`;
    }

    // Record the scan as an event
    logEpisodicEvent("tom_needs_scan", `Scan des besoins: ${uniqueNeeds.length} detectes (${uniqueNeeds.filter(n => n.confidence >= 0.7).length} prioritaires)`, {
      importance: 0.3,
      source: "tom.needs",
    });

    return report;
  },
});

log.info("[theory-of-mind] 4 tom.* skills registered — Kingston understands Nicolas's mind");
