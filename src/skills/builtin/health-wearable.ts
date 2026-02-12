/**
 * Built-in skills: health.connect, health.daily, health.log, health.trends
 * Health/Wearable Integration — API-ready health tracking with smart scheduling.
 * Supports: Oura Ring, Fitbit, Apple Health (via shortcuts), manual entry.
 * Inspired by OpenClaw: wearable data → morning briefing → smart scheduling.
 */
import { registerSkill } from "../loader.js";
import { getDb, kgUpsertEntity, kgGetEntity } from "../../storage/store.js";
import { log } from "../../utils/log.js";

const HEALTH_CONFIG_KEY = "health_config";
const HEALTH_CONFIG_TYPE = "config";

interface HealthConfig {
  provider: string; // oura, fitbit, manual
  api_token?: string;
  daily_goal_steps: number;
  daily_goal_sleep_hours: number;
  auto_schedule: boolean; // adjust calendar based on readiness
}

// Health data is stored in KG entities (one per day)
function todayKey(): string {
  return `health:${new Date().toISOString().slice(0, 10)}`;
}

registerSkill({
  name: "health.connect",
  description:
    "Configure health/wearable integration. Set provider (oura, fitbit, manual) and API token if applicable.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      provider: { type: "string", description: "Provider: oura, fitbit, manual (default: manual)" },
      api_token: { type: "string", description: "API token for the wearable service (optional)" },
      goal_steps: { type: "number", description: "Daily step goal (default: 8000)" },
      goal_sleep: { type: "number", description: "Daily sleep goal in hours (default: 7.5)" },
    },
  },
  async execute(args): Promise<string> {
    const cfg: HealthConfig = {
      provider: String(args.provider || "manual"),
      api_token: args.api_token ? String(args.api_token) : undefined,
      daily_goal_steps: Number(args.goal_steps) || 8000,
      daily_goal_sleep_hours: Number(args.goal_sleep) || 7.5,
      auto_schedule: true,
    };

    kgUpsertEntity(HEALTH_CONFIG_KEY, HEALTH_CONFIG_TYPE, cfg as any);

    return (
      `**Health Integration configurée:**\n` +
      `Provider: ${cfg.provider}\n` +
      `Objectif pas: ${cfg.daily_goal_steps}/jour\n` +
      `Objectif sommeil: ${cfg.daily_goal_sleep_hours}h/nuit\n` +
      (cfg.provider !== "manual" && !cfg.api_token ? "\n⚠️ Token API non configuré — utilise le mode manuel." : "") +
      `\nUtilise health.log pour enregistrer tes données.`
    );
  },
});

registerSkill({
  name: "health.log",
  description: "Log daily health data: sleep, steps, mood, energy, HRV, notes.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      sleep_hours: { type: "number", description: "Hours of sleep" },
      sleep_quality: { type: "number", description: "Sleep quality 1-10" },
      steps: { type: "number", description: "Steps count" },
      energy: { type: "number", description: "Energy level 1-10" },
      mood: { type: "number", description: "Mood 1-10" },
      hrv: { type: "number", description: "Heart Rate Variability (ms)" },
      weight: { type: "number", description: "Weight (kg)" },
      notes: { type: "string", description: "Additional notes" },
    },
  },
  async execute(args): Promise<string> {
    const data: Record<string, unknown> = {};
    const fields = ["sleep_hours", "sleep_quality", "steps", "energy", "mood", "hrv", "weight"];
    for (const f of fields) {
      if (args[f] !== undefined) data[f] = Number(args[f]);
    }
    if (args.notes) data.notes = String(args.notes);
    data.logged_at = new Date().toISOString();

    const key = todayKey();
    const existing = kgGetEntity(key, "health_data");
    const merged = existing ? { ...existing.properties, ...data } : data;

    kgUpsertEntity(key, "health_data", merged);

    // Generate readiness assessment
    const sleep = Number(merged.sleep_hours || 0);
    const energy = Number(merged.energy || 5);
    const mood = Number(merged.mood || 5);
    const readiness = Math.round(((sleep / 8) * 40 + (energy / 10) * 30 + (mood / 10) * 30));
    const clampedReadiness = Math.max(0, Math.min(100, readiness));

    const icon = clampedReadiness >= 70 ? "🟢" : clampedReadiness >= 50 ? "🟡" : "🔴";
    const recommendation = clampedReadiness >= 70
      ? "Bonne forme — journée productive possible."
      : clampedReadiness >= 50
        ? "Forme moyenne — prioriser les tâches importantes le matin."
        : "Repos recommandé — reprogrammer les tâches intensives.";

    const lines = [`${icon} **Santé aujourd'hui — Readiness: ${clampedReadiness}%**\n`];
    if (merged.sleep_hours) lines.push(`Sommeil: ${merged.sleep_hours}h${merged.sleep_quality ? ` (qualité: ${merged.sleep_quality}/10)` : ""}`);
    if (merged.steps) lines.push(`Pas: ${Number(merged.steps).toLocaleString()}`);
    if (merged.energy) lines.push(`Énergie: ${merged.energy}/10`);
    if (merged.mood) lines.push(`Humeur: ${merged.mood}/10`);
    if (merged.hrv) lines.push(`HRV: ${merged.hrv}ms`);
    if (merged.weight) lines.push(`Poids: ${merged.weight}kg`);
    lines.push(`\n**Recommandation:** ${recommendation}`);

    return lines.join("\n");
  },
});

registerSkill({
  name: "health.daily",
  description: "Generate a daily health brief — summary of today's data with recommendations for scheduling.",
  adminOnly: true,
  argsSchema: { type: "object", properties: {} },
  async execute(): Promise<string> {
    const key = todayKey();
    const entity = kgGetEntity(key, "health_data");

    if (!entity || !entity.properties.logged_at) {
      return "Aucune donnée santé pour aujourd'hui. Utilise health.log pour enregistrer.";
    }

    const d = entity.properties as Record<string, any>;
    const sleep = Number(d.sleep_hours || 0);
    const energy = Number(d.energy || 5);
    const mood = Number(d.mood || 5);
    const readiness = Math.max(0, Math.min(100, Math.round(((sleep / 8) * 40 + (energy / 10) * 30 + (mood / 10) * 30))));

    // Get 7-day trend
    const trends: number[] = [];
    for (let i = 6; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const dayKey = `health:${date.toISOString().slice(0, 10)}`;
      const dayEntity = kgGetEntity(dayKey, "health_data");
      if (dayEntity?.properties.sleep_hours) {
        const s = Number(dayEntity.properties.sleep_hours);
        const e = Number(dayEntity.properties.energy || 5);
        const m = Number(dayEntity.properties.mood || 5);
        trends.push(Math.round(((s / 8) * 40 + (e / 10) * 30 + (m / 10) * 30)));
      }
    }

    const avgReadiness = trends.length > 0 ? Math.round(trends.reduce((a, b) => a + b, 0) / trends.length) : readiness;
    const trendBar = trends.map(r => r >= 70 ? "█" : r >= 50 ? "▓" : "░").join("");

    const lines = [
      `**Brief Santé — ${new Date().toISOString().slice(0, 10)}**\n`,
      `Readiness: ${readiness}% ${readiness >= 70 ? "🟢" : readiness >= 50 ? "🟡" : "🔴"}`,
      `Sommeil: ${d.sleep_hours || "?"}h | Énergie: ${d.energy || "?"}/10 | Humeur: ${d.mood || "?"}/10`,
      d.hrv ? `HRV: ${d.hrv}ms` : "",
      `\nTendance 7j: ${trendBar} (moy: ${avgReadiness}%)`,
      `\n**Planning adaptatif:**`,
    ];

    if (readiness >= 70) {
      lines.push("- 🏋️ Journée intensive OK — deep work le matin");
      lines.push("- 🧠 Tâches créatives/stratégiques recommandées");
    } else if (readiness >= 50) {
      lines.push("- ⚡ Tâches importantes le matin uniquement");
      lines.push("- 🚶 Activité légère recommandée (marche, stretching)");
    } else {
      lines.push("- 😴 Repos prioritaire — reporter les deadlines si possible");
      lines.push("- 📱 Tâches administratives légères uniquement");
    }

    return lines.filter(Boolean).join("\n");
  },
});

registerSkill({
  name: "health.trends",
  description: "Show health trends over the last 7-30 days: sleep, energy, mood, readiness.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      days: { type: "number", description: "Number of days to analyze (default: 7)" },
    },
  },
  async execute(args): Promise<string> {
    const days = Number(args.days) || 7;
    const data: Array<{ date: string; sleep: number; energy: number; mood: number; readiness: number }> = [];

    for (let i = days - 1; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().slice(0, 10);
      const entity = kgGetEntity(`health:${dateStr}`, "health_data");
      if (entity?.properties.logged_at) {
        const p = entity.properties as any;
        const sleep = Number(p.sleep_hours || 0);
        const energy = Number(p.energy || 5);
        const mood = Number(p.mood || 5);
        const readiness = Math.round(((sleep / 8) * 40 + (energy / 10) * 30 + (mood / 10) * 30));
        data.push({ date: dateStr, sleep, energy, mood, readiness });
      }
    }

    if (data.length === 0) return `Aucune donnée santé sur les ${days} derniers jours.`;

    const avgSleep = (data.reduce((s, d) => s + d.sleep, 0) / data.length).toFixed(1);
    const avgEnergy = (data.reduce((s, d) => s + d.energy, 0) / data.length).toFixed(1);
    const avgReadiness = Math.round(data.reduce((s, d) => s + d.readiness, 0) / data.length);

    const lines = [`**Tendances santé — ${days} derniers jours** (${data.length} jours enregistrés)\n`];
    lines.push(`Moy. sommeil: ${avgSleep}h | Moy. énergie: ${avgEnergy}/10 | Moy. readiness: ${avgReadiness}%\n`);

    for (const d of data) {
      const bar = "█".repeat(Math.round(d.readiness / 5));
      lines.push(`${d.date}: ${bar} ${d.readiness}% (sommeil: ${d.sleep}h, énergie: ${d.energy})`);
    }

    return lines.join("\n");
  },
});

log.debug("Registered 4 health.* skills");
