/**
 * Mistral API skills — free Le Chat / API tier.
 * API: https://api.mistral.ai — free tier available.
 * Good at French, fast, lightweight.
 * Skills: mistral.chat, mistral.code
 */
import { registerSkill } from "../loader.js";
import { config } from "../../config/env.js";

const BASE_URL = "https://api.mistral.ai/v1";

interface MistralMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface MistralResponse {
  choices: Array<{ message: { content: string } }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

async function mistralChat(
  messages: MistralMessage[],
  model = "mistral-small-latest",
  maxTokens = 1024,
  temperature = 0.3,
): Promise<MistralResponse> {
  if (!config.mistralApiKey) {
    throw new Error("Mistral non configuré. Ajoute MISTRAL_API_KEY dans .env (gratuit: https://console.mistral.ai)");
  }

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.mistralApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      temperature,
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Mistral ${res.status}: ${text.slice(0, 200)}`);
  }

  return (await res.json()) as MistralResponse;
}

registerSkill({
  name: "mistral.chat",
  description:
    "Chat with Mistral AI (excellent en français). Free tier available. " +
    "Useful as an alternative LLM opinion or for French-specific tasks.",
  argsSchema: {
    type: "object",
    properties: {
      message: { type: "string", description: "Message to send" },
      system: { type: "string", description: "System prompt (optional)" },
      model: { type: "string", description: "Model: mistral-small-latest | mistral-medium-latest | open-mistral-nemo (default: mistral-small-latest)" },
    },
    required: ["message"],
  },
  async execute(args): Promise<string> {
    const message = String(args.message);
    const system = args.system ? String(args.system) : "Tu es un assistant concis et utile. Réponds en français par défaut.";
    const model = String(args.model || "mistral-small-latest");

    try {
      const data = await mistralChat(
        [
          { role: "system", content: system },
          { role: "user", content: message },
        ],
        model,
      );

      const reply = data.choices[0]?.message?.content || "(pas de réponse)";
      const tokens = data.usage ? `\n\n_${data.usage.total_tokens} tokens (${model})_` : "";
      return reply + tokens;
    } catch (err) {
      return `Erreur: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

registerSkill({
  name: "mistral.code",
  description: "Generate or explain code using Mistral Codestral. Good for quick code tasks.",
  argsSchema: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "Code task description" },
      language: { type: "string", description: "Programming language (default: typescript)" },
    },
    required: ["prompt"],
  },
  async execute(args): Promise<string> {
    const prompt = String(args.prompt);
    const language = String(args.language || "typescript");

    try {
      const data = await mistralChat(
        [
          {
            role: "system",
            content: `You are an expert ${language} programmer. Write clean, concise code. Explain briefly if needed.`,
          },
          { role: "user", content: prompt },
        ],
        "mistral-small-latest",
        2048,
        0.1,
      );

      return data.choices[0]?.message?.content || "(pas de réponse)";
    } catch (err) {
      return `Erreur: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});
