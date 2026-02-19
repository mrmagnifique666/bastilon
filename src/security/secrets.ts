/**
 * Secrets-as-Placeholders — LLM never sees real secret values.
 * Secrets stored in relay/secrets.json. LLM gets §§secret(KEY) placeholders.
 * Runtime substitution at execution time. Output filter masks leaked values.
 */
import fs from "node:fs";
import path from "node:path";
import { log } from "../utils/log.js";

const SECRETS_PATH = path.resolve("relay/secrets.json");
const PLACEHOLDER_REGEX = /§§secret\(([^)]+)\)/g;

let secrets: Record<string, string> = {};
let secretValues: Set<string> = new Set();

/**
 * Load secrets from relay/secrets.json.
 * Format: { "SMTP_PASSWORD": "actual_value", ... }
 */
export function loadSecrets(): void {
  try {
    if (fs.existsSync(SECRETS_PATH)) {
      const raw = fs.readFileSync(SECRETS_PATH, "utf-8");
      secrets = JSON.parse(raw);
      secretValues = new Set(Object.values(secrets).filter(v => v && v.length > 3));
      log.info(`[secrets] Loaded ${Object.keys(secrets).length} secrets`);
    } else {
      // Create empty secrets file
      fs.mkdirSync(path.dirname(SECRETS_PATH), { recursive: true });
      fs.writeFileSync(SECRETS_PATH, JSON.stringify({}, null, 2));
      log.info("[secrets] Created empty relay/secrets.json");
    }
  } catch (err) {
    log.warn(`[secrets] Failed to load: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Get a secret value by key.
 */
export function getSecret(key: string): string | undefined {
  return secrets[key];
}

/**
 * Set a secret value (persists to disk).
 */
export function setSecret(key: string, value: string): void {
  secrets[key] = value;
  secretValues.add(value);
  try {
    fs.writeFileSync(SECRETS_PATH, JSON.stringify(secrets, null, 2));
    log.info(`[secrets] Updated secret: ${key}`);
  } catch (err) {
    log.warn(`[secrets] Failed to save: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Delete a secret.
 */
export function deleteSecret(key: string): boolean {
  if (!(key in secrets)) return false;
  const val = secrets[key];
  delete secrets[key];
  secretValues.delete(val);
  try {
    fs.writeFileSync(SECRETS_PATH, JSON.stringify(secrets, null, 2));
  } catch (e) { log.warn(`[secrets] Failed to save after delete: ${e}`); }
  return true;
}

/**
 * List secret keys (never values).
 */
export function listSecretKeys(): string[] {
  return Object.keys(secrets);
}

/**
 * Replace §§secret(KEY) placeholders with actual values.
 * Used at runtime when executing code/commands.
 */
export function resolvePlaceholders(text: string): string {
  return text.replace(PLACEHOLDER_REGEX, (match, key) => {
    const value = secrets[key];
    if (value !== undefined) return value;
    log.warn(`[secrets] Unknown secret key: ${key}`);
    return match; // Leave placeholder if key not found
  });
}

/**
 * Convert actual secret values back to placeholders in text.
 * Used to sanitize prompts before sending to LLM.
 */
export function maskSecrets(text: string): string {
  let masked = text;
  for (const [key, value] of Object.entries(secrets)) {
    if (value && value.length > 3) {
      // Use global replace for all occurrences
      masked = masked.split(value).join(`§§secret(${key})`);
    }
  }
  return masked;
}

/**
 * Filter output stream — mask any secret values that appear in text.
 * Returns sanitized text safe to display/send.
 */
export function filterOutput(text: string): string {
  let filtered = text;
  for (const value of secretValues) {
    if (filtered.includes(value)) {
      filtered = filtered.split(value).join("[REDACTED]");
    }
  }
  return filtered;
}

/**
 * Check if text contains any raw secret values.
 */
export function containsSecrets(text: string): boolean {
  for (const value of secretValues) {
    if (text.includes(value)) return true;
  }
  return false;
}

// Auto-load on import
loadSecrets();
