/**
 * Built-in skills: wakeword.start, wakeword.stop, wakeword.status
 * Wake Word Listener — Browser-based via Web Speech API.
 * Opens http://localhost:3200/listen.html — says "Kingston" to activate.
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
    'Open the wake word listener page in the browser. Uses Web Speech API (Chrome/Edge) — no API key needed. Say "Kingston" to talk.',
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {},
  },
  async execute(): Promise<string> {
    const status = getWakeWordStatus();
    if (status.listening) {
      return `Deja actif! Page: ${status.url}`;
    }

    const ok = await startWakeWord();
    if (ok) {
      const s = getWakeWordStatus();
      return `Wake word active! Ouvre ${s.url} dans Chrome/Edge.\nDis "${s.keyword}" suivi de ta commande.`;
    }
    return "Echec de l'activation.";
  },
});

registerSkill({
  name: "wakeword.stop",
  description: "Deactivate the wake word listener.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {},
  },
  async execute(): Promise<string> {
    stopWakeWord();
    return "Wake word desactive. Ferme l'onglet listen.html pour arreter completement.";
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
      `**Wake Word (Browser):**\n` +
      `- Actif: ${status.listening ? "OUI" : "NON"}\n` +
      `- Mot-cle: "${status.keyword}"\n` +
      `- Mode: ${status.mode}\n` +
      `- URL: ${status.url}\n\n` +
      `Utilise Chrome ou Edge pour la meilleure compatibilite.\n` +
      `Web Speech API — gratuit, aucune cle requise.`
    );
  },
});
