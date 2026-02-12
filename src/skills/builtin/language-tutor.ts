/**
 * Built-in skills: tutor.start, tutor.practice, tutor.quiz, tutor.progress
 * Language Tutor Mode — voice-based language practice with pronunciation feedback.
 * Inspired by OpenClaw "xuezh" Chinese learning engine.
 * Uses Gemini for corrections, integrates with voice pipeline (Deepgram/ElevenLabs).
 */
import { registerSkill } from "../loader.js";
import { getDb, kgUpsertEntity, kgGetEntity } from "../../storage/store.js";
import { config } from "../../config/env.js";
import { log } from "../../utils/log.js";

const TUTOR_CONFIG_KEY = "tutor_config";
const TUTOR_CONFIG_TYPE = "config";

interface TutorConfig {
  target_language: string;
  native_language: string;
  level: string; // beginner, intermediate, advanced
  topics: string[];
  words_learned: number;
  sessions_completed: number;
}

function getConfig(): TutorConfig {
  const entity = kgGetEntity(TUTOR_CONFIG_KEY, TUTOR_CONFIG_TYPE);
  if (entity?.properties) {
    return entity.properties as unknown as TutorConfig;
  }
  return {
    target_language: "english",
    native_language: "french",
    level: "intermediate",
    topics: ["business", "technology", "daily life"],
    words_learned: 0,
    sessions_completed: 0,
  };
}

function saveConfig(cfg: TutorConfig): void {
  kgUpsertEntity(TUTOR_CONFIG_KEY, TUTOR_CONFIG_TYPE, cfg as any);
}

async function askGemini(prompt: string): Promise<string> {
  if (!config.geminiApiKey) throw new Error("GEMINI_API_KEY required");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${config.geminiApiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 2048 },
    }),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
}

registerSkill({
  name: "tutor.start",
  description: "Start or configure a language learning session. Set target language, level, topics.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      language: { type: "string", description: "Target language (e.g. english, spanish, mandarin)" },
      level: { type: "string", description: "Level: beginner, intermediate, advanced" },
      native: { type: "string", description: "Your native language (default: french)" },
    },
  },
  async execute(args): Promise<string> {
    const cfg = getConfig();
    if (args.language) cfg.target_language = String(args.language);
    if (args.level) cfg.level = String(args.level);
    if (args.native) cfg.native_language = String(args.native);
    saveConfig(cfg);

    return (
      `**Language Tutor configuré:**\n` +
      `Langue cible: ${cfg.target_language}\n` +
      `Niveau: ${cfg.level}\n` +
      `Langue maternelle: ${cfg.native_language}\n` +
      `Sessions: ${cfg.sessions_completed} | Mots appris: ${cfg.words_learned}\n\n` +
      `Utilise:\n` +
      `- tutor.practice text="..." pour corriger une phrase\n` +
      `- tutor.quiz pour un quiz de vocabulaire`
    );
  },
});

registerSkill({
  name: "tutor.practice",
  description:
    "Submit text for language practice. Gets grammar corrections, vocabulary suggestions, and pronunciation tips.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "Your text in the target language to check" },
      context: { type: "string", description: "Context: formal, casual, business, academic (optional)" },
    },
    required: ["text"],
  },
  async execute(args): Promise<string> {
    const text = String(args.text);
    const context = args.context ? String(args.context) : "general";
    const cfg = getConfig();

    const prompt = `You are a ${cfg.target_language} language tutor for a ${cfg.native_language} speaker at ${cfg.level} level.

The student wrote this in ${cfg.target_language} (context: ${context}):
"${text}"

Provide feedback in ${cfg.native_language}:
1. **Correction**: The corrected version (if needed, or "Parfait!" if no errors)
2. **Erreurs**: List each error with explanation
3. **Vocabulaire**: 2-3 alternative words/expressions they could use
4. **Conseil**: One tip to improve their ${cfg.target_language}
5. **Score**: /10

Be encouraging but precise. Use ${cfg.native_language} for explanations.`;

    try {
      const result = await askGemini(prompt);

      cfg.sessions_completed++;
      cfg.words_learned += text.split(/\s+/).length;
      saveConfig(cfg);

      return result;
    } catch (err) {
      return `Erreur: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

registerSkill({
  name: "tutor.quiz",
  description: "Generate a vocabulary quiz in the target language. Spaced repetition style.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      topic: { type: "string", description: "Quiz topic (e.g. business, food, travel)" },
      count: { type: "number", description: "Number of questions (default: 5)" },
    },
  },
  async execute(args): Promise<string> {
    const cfg = getConfig();
    const topic = args.topic ? String(args.topic) : cfg.topics[Math.floor(Math.random() * cfg.topics.length)] || "general";
    const count = Number(args.count) || 5;

    const prompt = `Generate a ${cfg.target_language} vocabulary quiz for a ${cfg.native_language} speaker at ${cfg.level} level.

Topic: ${topic}
Questions: ${count}

Format each question as:
Q1. [${cfg.target_language} word/phrase] → translate to ${cfg.native_language}
   a) option1  b) option2  c) option3  d) option4

After all questions, provide:
ANSWERS: Q1=b, Q2=a, etc.

Write the quiz instructions in ${cfg.native_language}. Make it fun and educational.`;

    try {
      return await askGemini(prompt);
    } catch (err) {
      return `Erreur: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

registerSkill({
  name: "tutor.progress",
  description: "Show language learning progress stats.",
  adminOnly: true,
  argsSchema: { type: "object", properties: {} },
  async execute(): Promise<string> {
    const cfg = getConfig();
    return (
      `**Language Tutor — Progression:**\n\n` +
      `Langue: ${cfg.target_language} (${cfg.level})\n` +
      `Sessions complétées: ${cfg.sessions_completed}\n` +
      `Mots pratiqués: ${cfg.words_learned}\n` +
      `Sujets: ${cfg.topics.join(", ")}\n\n` +
      `Continue avec tutor.practice ou tutor.quiz!`
    );
  },
});

log.debug("Registered 4 tutor.* skills");
