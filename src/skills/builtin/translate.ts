/**
 * Built-in skill: translate.text
 * Translation via MyMemory API — free, no key needed.
 * Auto-detect source language, translate to target.
 */
import { registerSkill } from "../loader.js";

registerSkill({
  name: "translate.text",
  description:
    "Translate text between languages. Auto-detects source language. Default target: French.",
  argsSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "Text to translate" },
      from: {
        type: "string",
        description: "Source language code (e.g. 'en', 'fr', 'es'). Use 'auto' for auto-detect (default).",
      },
      to: {
        type: "string",
        description: "Target language code (e.g. 'fr', 'en', 'es'). Default: 'fr'.",
      },
    },
    required: ["text"],
  },
  async execute(args): Promise<string> {
    const text = args.text as string;
    const from = (args.from as string) || "auto";
    const to = (args.to as string) || "fr";

    // Detect language if auto
    let sourceLang = from;
    if (from === "auto") {
      // Simple heuristic: if target is French and text looks French, swap to English target
      // Otherwise use MyMemory auto-detect
      sourceLang = "auto";
    }

    const langpair = `${sourceLang === "auto" ? "" : sourceLang}|${to}`;
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text.slice(0, 1000))}&langpair=${encodeURIComponent(langpair)}`;

    const resp = await fetch(url);
    if (!resp.ok) return `Translation error: HTTP ${resp.status}`;

    const data = await resp.json();
    if (data.responseStatus !== 200) {
      return `Translation error: ${data.responseStatus} — ${data.responseDetails || "Unknown error"}`;
    }

    const translated = data.responseData?.translatedText;
    if (!translated) return "No translation returned.";

    const detectedLang = data.responseData?.detectedLanguage;
    const langInfo = detectedLang ? ` (detected: ${detectedLang})` : "";

    return `${langpair}${langInfo}\n\n${translated}`;
  },
});
