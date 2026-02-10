/**
 * Ollama skills — interact with local LLM models via Ollama.
 */
import { registerSkill } from "../loader.js";

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";

async function ollamaFetch(endpoint: string, body?: object, timeout = 60_000): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const resp = await fetch(`${OLLAMA_URL}${endpoint}`, {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

// ── List Models ──────────────────────────────────────────────

registerSkill({
  name: "ollama.models",
  description: "List locally available Ollama models.",
  argsSchema: { type: "object", properties: {} },
  async execute() {
    try {
      const data = await ollamaFetch("/api/tags");
      if (!data.models || data.models.length === 0) return "No models installed.";
      return data.models
        .map((m: any) => `${m.name} (${(m.size / 1e9).toFixed(1)}GB, ${m.details?.parameter_size || "?"})`)
        .join("\n");
    } catch (err) {
      return `Error connecting to Ollama: ${(err as Error).message}`;
    }
  },
});

// ── Chat with Model ──────────────────────────────────────────

registerSkill({
  name: "ollama.chat",
  description: "Send a prompt to a local Ollama model and get a response.",
  argsSchema: {
    type: "object",
    properties: {
      model: { type: "string", description: "Model name (e.g. 'llama3', 'mistral', 'codellama')" },
      prompt: { type: "string", description: "The prompt to send" },
      system: { type: "string", description: "System prompt (optional)" },
      temperature: { type: "number", description: "Temperature 0-2 (default 0.7)" },
    },
    required: ["model", "prompt"],
  },
  async execute(args) {
    const model = args.model as string;
    const prompt = args.prompt as string;
    const system = args.system as string;
    const temperature = (args.temperature as number) || 0.7;
    try {
      const data = await ollamaFetch("/api/generate", {
        model,
        prompt,
        system: system || undefined,
        stream: false,
        options: { temperature },
      }, 300_000);
      if (data.error) return `Ollama error: ${data.error}`;
      return `[${model}] ${data.response}`;
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  },
});

// ── Pull Model ───────────────────────────────────────────────

registerSkill({
  name: "ollama.pull",
  description: "Download/pull an Ollama model.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      model: { type: "string", description: "Model name to pull (e.g. 'llama3', 'mistral:7b')" },
    },
    required: ["model"],
  },
  async execute(args) {
    const model = args.model as string;
    try {
      const data = await ollamaFetch("/api/pull", { name: model, stream: false }, 600_000);
      if (data.error) return `Error: ${data.error}`;
      return `Model '${model}' pulled successfully.`;
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  },
});

// ── Delete Model ─────────────────────────────────────────────

registerSkill({
  name: "ollama.delete",
  description: "Delete a local Ollama model to free disk space.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      model: { type: "string", description: "Model name to delete" },
    },
    required: ["model"],
  },
  async execute(args) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      try {
        const resp = await fetch(`${OLLAMA_URL}/api/delete`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: args.model }),
          signal: controller.signal,
        });
        if (!resp.ok) return `Error: ${resp.statusText}`;
        return `Model '${args.model}' deleted.`;
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  },
});
