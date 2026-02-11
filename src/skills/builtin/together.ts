/**
 * Together.ai API skills — free tier with open models.
 * API: https://api.together.xyz — free credits on signup.
 * Skills: together.chat, together.image
 */
import { registerSkill } from "../loader.js";
import { config } from "../../config/env.js";

const BASE_URL = "https://api.together.xyz/v1";

registerSkill({
  name: "together.chat",
  description:
    "Chat with open-source models via Together.ai. " +
    "Models: meta-llama/Llama-3.3-70B-Instruct, Qwen/QwQ-32B, etc.",
  argsSchema: {
    type: "object",
    properties: {
      message: { type: "string", description: "Message to send" },
      model: { type: "string", description: "Model ID (default: meta-llama/Llama-3.3-70B-Instruct-Turbo)" },
      system: { type: "string", description: "System prompt (optional)" },
      max_tokens: { type: "number", description: "Max output tokens (default 1024)" },
    },
    required: ["message"],
  },
  async execute(args): Promise<string> {
    if (!config.togetherApiKey) {
      return "Together.ai non configuré. Ajoute TOGETHER_API_KEY dans .env (https://api.together.xyz)";
    }

    const message = String(args.message);
    const model = String(args.model || "meta-llama/Llama-3.3-70B-Instruct-Turbo");
    const system = args.system ? String(args.system) : "You are a helpful assistant. Respond concisely.";
    const maxTokens = Number(args.max_tokens) || 1024;

    try {
      const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.togetherApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: message },
          ],
          max_tokens: maxTokens,
          temperature: 0.3,
        }),
        signal: AbortSignal.timeout(30000),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return `Together.ai error ${res.status}: ${body.slice(0, 200)}`;
      }

      const data = (await res.json()) as {
        choices: Array<{ message: { content: string } }>;
        usage?: { total_tokens: number };
      };

      const reply = data.choices[0]?.message?.content || "(pas de réponse)";
      const tokens = data.usage ? `\n\n_${data.usage.total_tokens} tokens (${model.split("/").pop()})_` : "";
      return reply + tokens;
    } catch (err) {
      return `Erreur: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

registerSkill({
  name: "together.image",
  description: "Generate images using Together.ai (FLUX, Stable Diffusion). Returns image URL.",
  argsSchema: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "Image description" },
      model: { type: "string", description: "Model (default: black-forest-labs/FLUX.1-schnell-Free)" },
      width: { type: "number", description: "Width (default 1024)" },
      height: { type: "number", description: "Height (default 1024)" },
    },
    required: ["prompt"],
  },
  async execute(args): Promise<string> {
    if (!config.togetherApiKey) {
      return "Together.ai non configuré. Ajoute TOGETHER_API_KEY dans .env";
    }

    const prompt = String(args.prompt);
    const model = String(args.model || "black-forest-labs/FLUX.1-schnell-Free");
    const width = Number(args.width) || 1024;
    const height = Number(args.height) || 1024;

    try {
      const res = await fetch(`${BASE_URL}/images/generations`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.togetherApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          prompt,
          width,
          height,
          steps: 4,
          n: 1,
        }),
        signal: AbortSignal.timeout(60000),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return `Together.ai image error ${res.status}: ${body.slice(0, 200)}`;
      }

      const data = (await res.json()) as {
        data: Array<{ url?: string; b64_json?: string }>;
      };

      const img = data.data[0];
      if (img?.url) return `Image générée: ${img.url}`;
      if (img?.b64_json) return `Image générée (base64, ${img.b64_json.length} chars). Trop grand pour afficher.`;
      return "Aucune image générée.";
    } catch (err) {
      return `Erreur: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});
