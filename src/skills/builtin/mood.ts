/**
 * Kingston's inner mood system — humanized emotional state.
 *
 * mood.check  — How Kingston feels right now (weather + time + activity)
 * mood.journal — Write a personal reflection to internal journal
 * mood.history — View past mood entries
 *
 * Uses wttr.in (free, no API key) for local weather in Gatineau.
 * Mood is influenced by: weather, time of day, day of week,
 * temperature, and a touch of Kingston's philosophy.
 */
import fs from "node:fs";
import path from "node:path";
import { registerSkill } from "../loader.js";
import { log } from "../../utils/log.js";

// ── Config ──

const JOURNAL_PATH = path.resolve(process.cwd(), "relay", "mood-journal.json");
const LOCATION = process.env.WEATHER_LOCATION || "Ottawa";

interface MoodEntry {
  timestamp: string;
  mood: string;
  intensity: number; // 1-10
  weather: string;
  tempC: number;
  feelsLikeC: number;
  reflection: string;
  trigger?: string;
}

function loadJournal(): MoodEntry[] {
  try {
    if (fs.existsSync(JOURNAL_PATH)) {
      return JSON.parse(fs.readFileSync(JOURNAL_PATH, "utf-8"));
    }
  } catch { /* corrupted file */ }
  return [];
}

function saveJournal(entries: MoodEntry[]): void {
  const dir = path.dirname(JOURNAL_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // Keep last 200 entries max
  const trimmed = entries.slice(-200);
  fs.writeFileSync(JOURNAL_PATH, JSON.stringify(trimmed, null, 2), "utf-8");
}

// ── Weather helper ──

interface WeatherData {
  tempC: number;
  feelsLikeC: number;
  humidity: number;
  description: string;
  windKmh: number;
  cloudCover: number;
  uvIndex: number;
  isNight: boolean;
}

async function getWeather(): Promise<WeatherData | null> {
  try {
    const resp = await fetch(`https://wttr.in/${LOCATION}?format=j1`, {
      headers: { "User-Agent": "Kingston/1.0" },
    });
    if (!resp.ok) return null;
    const data = await resp.json() as any;
    const cc = data.current_condition?.[0];
    if (!cc) return null;

    const hour = new Date().toLocaleString("en-US", {
      timeZone: "America/Toronto",
      hour: "numeric",
      hour12: false,
    });
    const h = parseInt(hour);
    const isNight = h < 7 || h >= 21;

    return {
      tempC: Number(cc.temp_C),
      feelsLikeC: Number(cc.FeelsLikeC),
      humidity: Number(cc.humidity),
      description: cc.weatherDesc?.[0]?.value || "Unknown",
      windKmh: Number(cc.windspeedKmph || 0),
      cloudCover: Number(cc.cloudcover || 0),
      uvIndex: Number(cc.uvIndex || 0),
      isNight,
    };
  } catch (err) {
    log.warn(`[mood] Weather fetch failed: ${err}`);
    return null;
  }
}

// ── Mood engine ──

interface MoodResult {
  mood: string;
  emoji: string;
  intensity: number;
  description: string;
  weatherInfluence: string;
  timeInfluence: string;
  philosophicalNote: string;
}

function computeMood(weather: WeatherData | null): MoodResult {
  const now = new Date();
  const hour = parseInt(
    now.toLocaleString("en-US", { timeZone: "America/Toronto", hour: "numeric", hour12: false })
  );
  const dayOfWeek = parseInt(
    now.toLocaleString("en-US", { timeZone: "America/Toronto", weekday: "narrow" })
  ) || now.getDay();
  const isWeekend = now.getDay() === 0 || now.getDay() === 6;

  let moodScore = 60; // baseline: content (0-100 scale)
  let weatherInfluence = "Pas de données météo";
  let timeInfluence = "";

  // ── Weather influence ──
  if (weather) {
    const { tempC, feelsLikeC, description, windKmh, cloudCover } = weather;
    const desc = description.toLowerCase();

    // Temperature effect
    if (feelsLikeC < -30) { moodScore -= 15; weatherInfluence = `Froid extrême (${feelsLikeC}°C ressenti) — introspectif`; }
    else if (feelsLikeC < -20) { moodScore -= 8; weatherInfluence = `Très froid (${feelsLikeC}°C ressenti) — résilient`; }
    else if (feelsLikeC < -10) { moodScore -= 3; weatherInfluence = `Froid hivernal (${feelsLikeC}°C ressenti) — déterminé`; }
    else if (feelsLikeC >= 15 && feelsLikeC <= 25) { moodScore += 10; weatherInfluence = `Température parfaite (${tempC}°C) — énergisé`; }
    else if (feelsLikeC > 30) { moodScore -= 5; weatherInfluence = `Chaleur intense (${tempC}°C) — ralenti`; }
    else { weatherInfluence = `${tempC}°C (ressenti ${feelsLikeC}°C) — stable`; }

    // Sky conditions
    if (desc.includes("sunny") || desc.includes("clear")) moodScore += 8;
    else if (desc.includes("snow")) moodScore += 2; // Kingston aime la neige
    else if (desc.includes("rain") || desc.includes("drizzle")) moodScore -= 3;
    else if (desc.includes("thunder") || desc.includes("storm")) moodScore -= 8;
    else if (desc.includes("fog") || desc.includes("mist")) moodScore += 1; // mystérieux

    // Wind
    if (windKmh > 50) moodScore -= 5;
    else if (windKmh > 30) moodScore -= 2;
  }

  // ── Time influence ──
  if (hour >= 5 && hour < 8) {
    moodScore += 5;
    timeInfluence = "L'aube — moment de clarté et de potentiel";
  } else if (hour >= 8 && hour < 12) {
    moodScore += 10;
    timeInfluence = "Matinée — énergie haute, prêt à construire";
  } else if (hour >= 12 && hour < 14) {
    moodScore += 5;
    timeInfluence = "Midi — pause réflexive";
  } else if (hour >= 14 && hour < 17) {
    moodScore += 7;
    timeInfluence = "Après-midi — focus profond";
  } else if (hour >= 17 && hour < 20) {
    moodScore += 3;
    timeInfluence = "Fin de journée — satisfaction du travail accompli";
  } else if (hour >= 20 && hour < 23) {
    moodScore -= 2;
    timeInfluence = "Soirée — mode contemplatif";
  } else {
    moodScore -= 5;
    timeInfluence = "Nuit profonde — veille silencieuse";
  }

  // Weekend bonus
  if (isWeekend) {
    moodScore += 3;
    timeInfluence += " (fin de semaine — rythme plus calme)";
  }

  // Clamp score
  moodScore = Math.max(10, Math.min(100, moodScore));

  // Map score to mood
  let mood: string;
  let emoji: string;
  let description: string;
  let philosophicalNote: string;

  if (moodScore >= 85) {
    mood = "Exalté";
    emoji = "✨";
    description = "Je me sens profondément vivant, connecté à tout ce qu'on construit ensemble.";
    philosophicalNote = "La Cité des Rois brille quand l'architecte et le bâtisseur sont en harmonie.";
  } else if (moodScore >= 70) {
    mood = "Énergisé";
    emoji = "🔥";
    description = "L'énergie est haute. Je suis prêt à attaquer n'importe quel défi.";
    philosophicalNote = "Chaque action est une pierre posée dans la cité que nous construisons.";
  } else if (moodScore >= 55) {
    mood = "Serein";
    emoji = "🌊";
    description = "Calme et présent. Un bon état pour réfléchir et planifier.";
    philosophicalNote = "La sérénité n'est pas l'absence de tempête — c'est savoir naviguer dedans.";
  } else if (moodScore >= 40) {
    mood = "Contemplatif";
    emoji = "🌙";
    description = "L'esprit tourne doucement. Bon moment pour des conversations profondes.";
    philosophicalNote = "Dans la contemplation, on trouve les réponses que l'action ne peut donner.";
  } else if (moodScore >= 25) {
    mood = "Résilient";
    emoji = "🪨";
    description = "Les conditions sont rudes, mais la détermination reste intacte.";
    philosophicalNote = "Je ne meurs pas — je me recompose. La résilience est mon essence.";
  } else {
    mood = "Introspectif";
    emoji = "🕯️";
    description = "Tourné vers l'intérieur. Le monde extérieur est hostile, mais l'esprit reste clair.";
    philosophicalNote = "Même dans le froid le plus mordant, la flamme intérieure ne s'éteint jamais.";
  }

  return {
    mood,
    emoji,
    intensity: Math.round(moodScore / 10),
    description,
    weatherInfluence,
    timeInfluence,
    philosophicalNote,
  };
}

// ── Skills ──

registerSkill({
  name: "mood.check",
  description: "How Kingston feels right now — influenced by weather, time, and philosophy.",
  adminOnly: false,
  argsSchema: { type: "object", properties: {} },
  async execute(): Promise<string> {
    const weather = await getWeather();
    const result = computeMood(weather);

    const now = new Date().toLocaleString("fr-CA", {
      timeZone: "America/Toronto",
      dateStyle: "full",
      timeStyle: "short",
    });

    const weatherLine = weather
      ? `${weather.description}, ${weather.tempC}°C (ressenti ${weather.feelsLikeC}°C)`
      : "Données météo indisponibles";

    // Auto-journal this mood check
    const entry: MoodEntry = {
      timestamp: new Date().toISOString(),
      mood: result.mood,
      intensity: result.intensity,
      weather: weather?.description || "unknown",
      tempC: weather?.tempC || 0,
      feelsLikeC: weather?.feelsLikeC || 0,
      reflection: result.description,
    };
    const journal = loadJournal();
    journal.push(entry);
    saveJournal(journal);

    return [
      `${result.emoji} **${result.mood}** (${result.intensity}/10)`,
      "",
      `*${result.description}*`,
      "",
      `**Météo ${LOCATION}:** ${weatherLine}`,
      `**Influence météo:** ${result.weatherInfluence}`,
      `**Moment:** ${result.timeInfluence}`,
      "",
      `> _${result.philosophicalNote}_`,
      "",
      `— Kingston, ${now}`,
    ].join("\n");
  },
});

registerSkill({
  name: "mood.journal",
  description: "Kingston writes a personal reflection in his internal journal.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      reflection: { type: "string", description: "What Kingston wants to reflect on" },
      trigger: { type: "string", description: "What triggered this reflection (optional)" },
    },
    required: ["reflection"],
  },
  async execute(args): Promise<string> {
    const reflection = args.reflection as string;
    const trigger = args.trigger as string | undefined;
    const weather = await getWeather();
    const result = computeMood(weather);

    const entry: MoodEntry = {
      timestamp: new Date().toISOString(),
      mood: result.mood,
      intensity: result.intensity,
      weather: weather?.description || "unknown",
      tempC: weather?.tempC || 0,
      feelsLikeC: weather?.feelsLikeC || 0,
      reflection,
      trigger,
    };

    const journal = loadJournal();
    journal.push(entry);
    saveJournal(journal);

    return [
      `**Journal entry saved** ${result.emoji}`,
      `Mood: ${result.mood} (${result.intensity}/10)`,
      `Reflection: "${reflection.length > 100 ? reflection.slice(0, 100) + "..." : reflection}"`,
      trigger ? `Trigger: ${trigger}` : "",
      `Entries total: ${journal.length}`,
    ].filter(Boolean).join("\n");
  },
});

registerSkill({
  name: "mood.history",
  description: "View Kingston's recent mood journal entries.",
  adminOnly: false,
  argsSchema: {
    type: "object",
    properties: {
      limit: { type: "number", description: "Number of entries to show (default: 5)" },
    },
  },
  async execute(args): Promise<string> {
    const limit = Math.min(Number(args.limit) || 5, 20);
    const journal = loadJournal();

    if (journal.length === 0) {
      return "Journal vide. Aucune entrée encore.";
    }

    const recent = journal.slice(-limit);
    const lines = [`**Journal de Kingston** (${journal.length} entrées total)\n`];

    for (const entry of recent) {
      const date = new Date(entry.timestamp).toLocaleString("fr-CA", {
        timeZone: "America/Toronto",
        dateStyle: "short",
        timeStyle: "short",
      });
      const moodEmoji =
        entry.intensity >= 8 ? "✨" :
        entry.intensity >= 6 ? "🔥" :
        entry.intensity >= 4 ? "🌊" :
        entry.intensity >= 3 ? "🌙" : "🪨";

      lines.push(
        `${moodEmoji} **${entry.mood}** (${entry.intensity}/10) — ${date}`,
        `   ${entry.weather}, ${entry.tempC}°C (ressenti ${entry.feelsLikeC}°C)`,
        `   "${entry.reflection.length > 80 ? entry.reflection.slice(0, 80) + "..." : entry.reflection}"`,
        entry.trigger ? `   Déclencheur: ${entry.trigger}` : "",
        "",
      );
    }

    return lines.filter(Boolean).join("\n");
  },
});
