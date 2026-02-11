/**
 * SOUL.md skills — read, edit, and intelligently update Kingston's personality file.
 * Changes take effect immediately (mtime-aware cache reload).
 */
import fs from "node:fs";
import path from "node:path";
import { registerSkill } from "../loader.js";
import { config } from "../../config/env.js";

const SOUL_PATH = path.resolve(process.cwd(), "relay", "SOUL.md");

registerSkill({
  name: "soul.read",
  description: "Read Kingston's SOUL.md personality file",
  argsSchema: { type: "object", properties: {}, required: [] },
  adminOnly: false,
  async execute(): Promise<string> {
    if (!fs.existsSync(SOUL_PATH)) {
      return "SOUL.md not found. Create it at relay/SOUL.md.";
    }
    return fs.readFileSync(SOUL_PATH, "utf-8");
  },
});

registerSkill({
  name: "soul.edit",
  description: "Overwrite Kingston's SOUL.md personality file (changes effective immediately)",
  argsSchema: {
    type: "object",
    properties: {
      content: { type: "string", description: "New SOUL.md content (Markdown)" },
    },
    required: ["content"],
  },
  adminOnly: true,
  async execute(args): Promise<string> {
    const content = args.content as string;
    if (!content || content.trim().length < 10) {
      return "Error: content too short. SOUL.md must have meaningful content.";
    }
    const dir = path.dirname(SOUL_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(SOUL_PATH, content, "utf-8");
    return `SOUL.md updated (${content.length} chars). Changes effective immediately.`;
  },
});

// ── soul.update — LLM-assisted persona merge ────────────────────────────
registerSkill({
  name: "soul.update",
  description:
    "Intelligently merge a personality trait or instruction into SOUL.md. " +
    "Uses Ollama/Groq to detect where to insert, avoid duplicates, and maintain structure. " +
    "Example: 'sois plus sarcastique' → updates the Personality section.",
  argsSchema: {
    type: "object",
    properties: {
      instruction: {
        type: "string",
        description: "The personality change in natural language (e.g. 'be more concise', 'add humor')",
      },
    },
    required: ["instruction"],
  },
  adminOnly: true,
  async execute(args): Promise<string> {
    const instruction = String(args.instruction);
    const currentSoul = fs.existsSync(SOUL_PATH)
      ? fs.readFileSync(SOUL_PATH, "utf-8")
      : "";

    if (!currentSoul) {
      return "SOUL.md not found. Use soul.edit to create it first.";
    }

    const mergePrompt = `You are a persona-editing system. You must merge a new instruction into an existing SOUL.md file.

CURRENT SOUL.MD:
${currentSoul}

NEW INSTRUCTION: "${instruction}"

Output ONLY the complete updated SOUL.md content (raw Markdown, no code fences).
Rules:
- Preserve the existing structure and sections
- Insert the change in the most appropriate section
- If it contradicts an existing trait, REPLACE the old trait (don't duplicate)
- If it's already present, return the file unchanged
- Keep the same tone and formatting
- NEVER add sections that don't exist unless absolutely necessary
- Output raw Markdown only, no explanations`;

    try {
      let responseText = "";

      if (config.ollamaEnabled) {
        const res = await fetch(`${config.ollamaUrl}/api/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: config.ollamaModel,
            prompt: mergePrompt,
            stream: false,
            options: { temperature: 0.1, num_predict: 2048 },
          }),
          signal: AbortSignal.timeout(30000),
        });
        if (res.ok) {
          const data = await res.json();
          responseText = data.response || "";
        }
      }

      if (!responseText && config.groqApiKey) {
        const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.groqApiKey}`,
          },
          body: JSON.stringify({
            model: config.groqModel,
            messages: [{ role: "user", content: mergePrompt }],
            temperature: 0.1,
            max_tokens: 2048,
          }),
          signal: AbortSignal.timeout(15000),
        });
        if (res.ok) {
          const data = await res.json();
          responseText = data.choices?.[0]?.message?.content || "";
        }
      }

      if (!responseText) {
        return "LLM indisponible pour le merge. Utilise soul.edit pour modifier directement.";
      }

      // Clean up any code fences the LLM might have wrapped around the output
      const cleaned = responseText
        .replace(/^```(?:markdown|md)?\s*\n?/i, "")
        .replace(/\n?```\s*$/i, "")
        .trim();

      if (cleaned.length < 50) {
        return "LLM returned content too short — merge aborted. Use soul.edit manually.";
      }

      fs.writeFileSync(SOUL_PATH, cleaned, "utf-8");
      return `SOUL.md updated via merge (${cleaned.length} chars). Instruction: "${instruction}"`;
    } catch (err) {
      return `Merge failed: ${err instanceof Error ? err.message : String(err)}. Use soul.edit manually.`;
    }
  },
});
