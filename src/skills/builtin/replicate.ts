/**
 * Replicate API skills — free tier for image/audio models.
 * API: https://replicate.com — pay-per-use with free credits.
 * Skills: replicate.run, replicate.image
 */
import { registerSkill } from "../loader.js";
import { config } from "../../config/env.js";

const BASE_URL = "https://api.replicate.com/v1";

interface ReplicatePrediction {
  id: string;
  status: "starting" | "processing" | "succeeded" | "failed" | "canceled";
  output: unknown;
  error: string | null;
  urls: { get: string };
}

async function replicateRun(model: string, input: Record<string, unknown>): Promise<ReplicatePrediction> {
  if (!config.replicateApiKey) {
    throw new Error("Replicate non configuré. Ajoute REPLICATE_API_KEY dans .env (https://replicate.com/account/api-tokens)");
  }

  // Create prediction
  const createRes = await fetch(`${BASE_URL}/predictions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.replicateApiKey}`,
      "Content-Type": "application/json",
      Prefer: "wait",  // Synchronous mode — wait for result
    },
    body: JSON.stringify({ model, input }),
    signal: AbortSignal.timeout(120000),
  });

  if (!createRes.ok) {
    const body = await createRes.text().catch(() => "");
    throw new Error(`Replicate ${createRes.status}: ${body.slice(0, 200)}`);
  }

  return (await createRes.json()) as ReplicatePrediction;
}

registerSkill({
  name: "replicate.run",
  description:
    "Run any Replicate model (image, audio, video, text). " +
    "Specify model as 'owner/name' (e.g. 'stability-ai/sdxl'). " +
    "Input is JSON string.",
  argsSchema: {
    type: "object",
    properties: {
      model: { type: "string", description: "Model identifier (e.g. 'stability-ai/sdxl')" },
      input: { type: "string", description: "JSON input for the model" },
    },
    required: ["model", "input"],
  },
  adminOnly: true,
  async execute(args): Promise<string> {
    const model = String(args.model);
    let input: Record<string, unknown>;

    try {
      input = JSON.parse(String(args.input));
    } catch {
      return "Error: input must be valid JSON.";
    }

    try {
      const prediction = await replicateRun(model, input);

      if (prediction.status === "failed") {
        return `Replicate failed: ${prediction.error || "unknown error"}`;
      }

      if (prediction.status === "succeeded") {
        const output = prediction.output;
        if (typeof output === "string") return output;
        if (Array.isArray(output)) return output.join("\n");
        return JSON.stringify(output, null, 2);
      }

      return `Prediction ${prediction.id} status: ${prediction.status}. Check: ${prediction.urls.get}`;
    } catch (err) {
      return `Erreur: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

registerSkill({
  name: "replicate.image",
  description: "Generate an image using Replicate (SDXL, FLUX, etc). Returns image URL.",
  argsSchema: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "Image description" },
      model: { type: "string", description: "Model (default: stability-ai/sdxl)" },
      negative_prompt: { type: "string", description: "What to avoid in the image" },
    },
    required: ["prompt"],
  },
  async execute(args): Promise<string> {
    const prompt = String(args.prompt);
    const model = String(args.model || "stability-ai/sdxl");
    const negativePrompt = args.negative_prompt ? String(args.negative_prompt) : "";

    try {
      const input: Record<string, unknown> = {
        prompt,
        width: 1024,
        height: 1024,
      };
      if (negativePrompt) input.negative_prompt = negativePrompt;

      const prediction = await replicateRun(model, input);

      if (prediction.status === "failed") {
        return `Échec: ${prediction.error || "erreur inconnue"}`;
      }

      const output = prediction.output;
      if (Array.isArray(output) && output.length > 0) {
        return `Image générée:\n${output[0]}`;
      }
      if (typeof output === "string") return `Image: ${output}`;

      return `Prediction en cours: ${prediction.urls.get}`;
    } catch (err) {
      return `Erreur: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});
