/**
 * Secrets management skills — §§secret(KEY) placeholder system.
 * LLM never sees actual secret values.
 */
import { registerSkill } from "../loader.js";
import {
  listSecretKeys,
  setSecret,
  deleteSecret,
  maskSecrets,
  resolvePlaceholders,
  filterOutput,
} from "../../security/secrets.js";

registerSkill({
  name: "secrets.list",
  description: "List all secret keys (never shows values)",
  argsSchema: { type: "object", properties: {} },
  async execute() {
    const keys = listSecretKeys();
    if (keys.length === 0) return "No secrets stored. Use secrets.set to add one.";
    return `Secrets (${keys.length}):\n${keys.map(k => `  §§secret(${k})`).join("\n")}`;
  },
});

registerSkill({
  name: "secrets.set",
  description: "Store a secret value — only the key name is visible to AI, value is hidden",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      key: { type: "string", description: "Secret key name (e.g., SMTP_PASSWORD)" },
      value: { type: "string", description: "Secret value" },
    },
    required: ["key", "value"],
  },
  async execute(args) {
    const key = args.key as string;
    const value = args.value as string;
    setSecret(key, value);
    return `Secret §§secret(${key}) stored. Use §§secret(${key}) as placeholder in commands.`;
  },
});

registerSkill({
  name: "secrets.delete",
  description: "Delete a stored secret",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      key: { type: "string", description: "Secret key to delete" },
    },
    required: ["key"],
  },
  async execute(args) {
    const key = args.key as string;
    const ok = deleteSecret(key);
    return ok ? `Secret ${key} deleted.` : `Secret ${key} not found.`;
  },
});

registerSkill({
  name: "secrets.resolve",
  description: "Resolve §§secret() placeholders in text (for execution). Admin only.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "Text with §§secret(KEY) placeholders" },
    },
    required: ["text"],
  },
  async execute(args) {
    const text = args.text as string;
    const resolved = resolvePlaceholders(text);
    // Don't return the resolved text to the LLM — just confirm it was resolved
    return `Resolved ${(text.match(/§§secret\(/g) || []).length} placeholder(s). Text ready for execution.`;
  },
});

registerSkill({
  name: "secrets.mask",
  description: "Mask any raw secret values in text, replacing them with §§secret() placeholders",
  argsSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "Text that may contain raw secret values" },
    },
    required: ["text"],
  },
  async execute(args) {
    const text = args.text as string;
    return maskSecrets(text);
  },
});
