/**
 * Built-in skills: wakeword.start, wakeword.stop, wakeword.status
 * Wake Word Listener — "Computer" activates Kingston via local microphone.
 */
import { registerSkill } from "../loader.js";
import {
  startWakeWord,
  stopWakeWord,
  getWakeWordStatus,
} from "../../voice/wakeword.js";

registerSkill({
  name: "wakeword.start",
  description:
    'Start listening for wake word ("Computer" by default). Requires PICOVOICE_ACCESS_KEY in .env (free at picovoice.ai).',
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {},
  },
  async execute(): Promise<string> {
    const status = getWakeWordStatus();
    if (status.listening) {
      return `Deja en ecoute pour "${status.keyword}".`;
    }

    const ok = await startWakeWord();
    if (ok) {
      return `🎙️ Wake word active! Dis "${getWakeWordStatus().keyword}" pour parler a Kingston.`;
    }
    return "Echec — verifie que PICOVOICE_ACCESS_KEY est dans .env (gratuit sur picovoice.ai).";
  },
});

registerSkill({
  name: "wakeword.stop",
  description: "Stop listening for wake word.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {},
  },
  async execute(): Promise<string> {
    stopWakeWord();
    return "🔇 Wake word desactive.";
  },
});

registerSkill({
  name: "wakeword.status",
  description: "Get wake word listener status.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {},
  },
  async execute(): Promise<string> {
    const status = getWakeWordStatus();
    return (
      `**Wake Word:**\n` +
      `- Ecoute: ${status.listening ? "✅ OUI" : "❌ NON"}\n` +
      `- Mot-cle: "${status.keyword}"\n` +
      `- En traitement: ${status.processing ? "oui" : "non"}\n\n` +
      `Mots disponibles: COMPUTER, JARVIS, TERMINATOR, ALEXA, PICOVOICE\n` +
      `Config: WAKEWORD_KEYWORD dans .env`
    );
  },
});
