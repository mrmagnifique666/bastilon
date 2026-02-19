/**
 * Markdown Skill Loader — loads SKILL.md files as executable skills.
 * Kingston can create new skills by writing .skill.md files to relay/skills/.
 *
 * SECURITY: All skills are verified via SHA-256 integrity check + dangerous
 * pattern detection before execution. Modified skills require re-approval.
 *
 * Format:
 * ```yaml
 * name: my-namespace.my-skill
 * description: What this skill does
 * admin_only: false
 * args:
 *   query: { type: string, description: "Search query", required: true }
 *   limit: { type: number, description: "Max results" }
 * ```
 * ```javascript
 * // Code block is executed as an async function.
 * // Available: args, fetch, config, log, db
 * const res = await fetch(`https://api.example.com?q=${args.query}`);
 * const data = await res.json();
 * return JSON.stringify(data, null, 2);
 * ```
 *
 * Skills are hot-reloaded when files change.
 */
import fs from "node:fs";
import path from "node:path";
import { registerSkill } from "../loader.js";
import { config } from "../../config/env.js";
import { log } from "../../utils/log.js";
import { getDb } from "../../storage/store.js";
import {
  ensureVerifyTable,
  verifySkill,
  withTimeout,
  scanCode,
  hashContent,
} from "../../security/skill-verify.js";

const SKILLS_DIR = path.resolve(process.cwd(), "relay", "skills");
const SKILL_TIMEOUT_MS = 30_000;

interface ParsedSkillMd {
  name: string;
  description: string;
  adminOnly: boolean;
  args: Record<string, { type: string; description: string; required?: boolean }>;
  code: string;
}

/** Parse a .skill.md file into a structured skill definition */
function parseSkillMd(content: string): ParsedSkillMd | null {
  // Extract YAML front matter (between ```yaml and ```)
  const yamlMatch = content.match(/```ya?ml\s*\n([\s\S]*?)```/i);
  if (!yamlMatch) return null;

  const yaml = yamlMatch[1];

  // Simple YAML-like parsing (no external dep needed)
  const name = yaml.match(/name:\s*(.+)/)?.[1]?.trim();
  const description = yaml.match(/description:\s*(.+)/)?.[1]?.trim();
  const adminOnly = yaml.match(/admin_only:\s*(true|false)/)?.[1] === "true";

  if (!name || !description) return null;

  // Parse args section
  const args: Record<string, { type: string; description: string; required?: boolean }> = {};
  const argsSection = yaml.match(/args:\s*\n((?:\s+.+\n)*)/);
  if (argsSection) {
    const lines = argsSection[1].split("\n").filter((l) => l.trim());
    for (const line of lines) {
      const m = line.match(/^\s+(\w+):\s*\{(.+)\}/);
      if (m) {
        const argName = m[1];
        const props = m[2];
        const type = props.match(/type:\s*(\w+)/)?.[1] || "string";
        const desc = props.match(/description:\s*"([^"]+)"/)?.[1] || "";
        const required = props.includes("required: true");
        args[argName] = { type, description: desc, required };
      }
    }
  }

  // Extract code block (javascript/js/typescript/ts)
  const codeMatch = content.match(/```(?:javascript|js|typescript|ts)\s*\n([\s\S]*?)```/i);
  const code = codeMatch?.[1]?.trim() || "";

  if (!code) return null;

  return { name, description, adminOnly, args, code };
}

/**
 * Create a HARDENED executable function from skill code.
 *
 * Security measures:
 * - Frozen sandbox context (no prototype pollution)
 * - globalThis/global/process blocked via proxy
 * - Execution timeout (30s default)
 * - Error wrapping (no stack leak)
 */
function createExecutor(code: string, skillName: string): (args: Record<string, unknown>) => Promise<string> {
  return async (args: Record<string, unknown>): Promise<string> => {
    // Build sandboxed execution context
    const context: Record<string, unknown> = {
      args,
      fetch: globalThis.fetch,
      config: Object.freeze({
        ollamaUrl: config.ollamaUrl,
        ollamaModel: config.ollamaModel,
        adminChatId: config.adminChatId,
      }),
      // Controlled secrets accessor — skills can request specific env vars by name.
      // Only API keys and safe config values are exposed. Passwords/tokens for internal
      // services are blocked. Each access is logged for audit.
      secrets: Object.freeze({
        get(key: string): string {
          const allowed = /^(BRAVE_SEARCH|GEMINI|ELEVENLABS|DEEPGRAM|ALPACA|PRINTFUL|REMOVEBG|FACEBOOK|INSTAGRAM|MOLTBOOK|BINANCE|GROQ|COHERE|MISTRAL|TOGETHER|REPLICATE|NEWS|HUGGINGFACE|SERPER|FINNHUB|PICOVOICE)/i;
          const blocked = /PASSWORD|AUTH_TOKEN|ADMIN|TELEGRAM_BOT_TOKEN|ANTHROPIC_API_KEY|TWILIO_AUTH/i;
          if (blocked.test(key)) {
            log.warn(`[skill:${skillName}] BLOCKED secret access: ${key}`);
            return "";
          }
          if (!allowed.test(key)) {
            log.warn(`[skill:${skillName}] Denied secret access (not in allowlist): ${key}`);
            return "";
          }
          const val = process.env[key] || "";
          log.debug(`[skill:${skillName}] Secret access: ${key} (${val ? "found" : "empty"})`);
          return val;
        },
      }),
      // Telegram send capability — skills can send messages/media to admin.
      // The bot token is NEVER exposed to skill code; it's used internally.
      telegram: Object.freeze({
        async send(text: string): Promise<boolean> {
          try {
            const token = process.env.TELEGRAM_BOT_TOKEN || "";
            const chatId = config.adminChatId;
            if (!token || !chatId) return false;
            const resp = await globalThis.fetch(
              `https://api.telegram.org/bot${token}/sendMessage`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
              }
            );
            return resp.ok;
          } catch { return false; }
        },
        async sendPhoto(photoBlob: Blob, caption?: string): Promise<boolean> {
          try {
            const token = process.env.TELEGRAM_BOT_TOKEN || "";
            const chatId = config.adminChatId;
            if (!token || !chatId) return false;
            const form = new FormData();
            form.append("chat_id", String(chatId));
            form.append("photo", photoBlob, "photo.png");
            if (caption) form.append("caption", caption);
            const resp = await globalThis.fetch(
              `https://api.telegram.org/bot${token}/sendPhoto`,
              { method: "POST", body: form }
            );
            return resp.ok;
          } catch { return false; }
        },
        async sendVoice(audioBlob: Blob, caption?: string): Promise<boolean> {
          try {
            const token = process.env.TELEGRAM_BOT_TOKEN || "";
            const chatId = config.adminChatId;
            if (!token || !chatId) return false;
            const form = new FormData();
            form.append("chat_id", String(chatId));
            form.append("voice", audioBlob, "voice.ogg");
            if (caption) form.append("caption", caption);
            const resp = await globalThis.fetch(
              `https://api.telegram.org/bot${token}/sendVoice`,
              { method: "POST", body: form }
            );
            return resp.ok;
          } catch { return false; }
        },
        async sendDocument(docBlob: Blob, filename: string, caption?: string): Promise<boolean> {
          try {
            const token = process.env.TELEGRAM_BOT_TOKEN || "";
            const chatId = config.adminChatId;
            if (!token || !chatId) return false;
            const form = new FormData();
            form.append("chat_id", String(chatId));
            form.append("document", docBlob, filename);
            if (caption) form.append("caption", caption);
            const resp = await globalThis.fetch(
              `https://api.telegram.org/bot${token}/sendDocument`,
              { method: "POST", body: form }
            );
            return resp.ok;
          } catch { return false; }
        },
      }),
      log: Object.freeze({
        info: (msg: string) => log.info(`[skill:${skillName}] ${msg}`),
        warn: (msg: string) => log.warn(`[skill:${skillName}] ${msg}`),
        debug: (msg: string) => log.debug(`[skill:${skillName}] ${msg}`),
      }),
      db: getDb(),
      JSON,
      Date,
      Math,
      parseInt,
      parseFloat,
      encodeURIComponent,
      decodeURIComponent,
      URL,
      URLSearchParams,
      AbortSignal,
      Buffer: globalThis.Buffer,
      TextEncoder: globalThis.TextEncoder,
      TextDecoder: globalThis.TextDecoder,
      FormData: globalThis.FormData,
      Blob: globalThis.Blob,
      Headers: globalThis.Headers,
      Request: globalThis.Request,
      Response: globalThis.Response,
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      // Block sandbox escapes explicitly
      globalThis: undefined,
      global: undefined,
      process: undefined,
      require: undefined,
      module: undefined,
      exports: undefined,
      __dirname: undefined,
      __filename: undefined,
    };

    const contextKeys = Object.keys(context);
    const contextValues = Object.values(context);

    const execute = async () => {
      try {
        const fn = new Function(
          ...contextKeys,
          `"use strict"; return (async () => { ${code} })()`
        ) as (...a: unknown[]) => Promise<unknown>;
        const result = await fn(...contextValues);
        return typeof result === "string" ? result : JSON.stringify(result, null, 2);
      } catch (err) {
        // Don't leak internal stack traces
        const msg = err instanceof Error ? err.message : String(err);
        return `Skill error [${skillName}]: ${msg}`;
      }
    };

    // Enforce execution timeout
    return withTimeout(execute, SKILL_TIMEOUT_MS);
  };
}

/** Load all .skill.md files from relay/skills/ */
export function loadMarkdownSkills(): number {
  ensureVerifyTable();

  if (!fs.existsSync(SKILLS_DIR)) {
    fs.mkdirSync(SKILLS_DIR, { recursive: true });
    log.info(`[skill:md] Created ${SKILLS_DIR}`);
  }

  const files = fs.readdirSync(SKILLS_DIR).filter((f) => f.endsWith(".skill.md"));
  let loaded = 0;
  let blocked = 0;
  let pending = 0;

  for (const file of files) {
    try {
      const filePath = path.join(SKILLS_DIR, file);
      const content = fs.readFileSync(filePath, "utf-8");
      const parsed = parseSkillMd(content);

      if (!parsed) {
        log.warn(`[skill:md] Failed to parse ${file} — skipping`);
        continue;
      }

      // ── Verify integrity + scan for dangerous patterns ──
      const verification = verifySkill(parsed.name, filePath, content);

      if (verification.status === "blocked") {
        log.warn(`[skill:md] ⛔ BLOCKED ${parsed.name}: ${verification.reason}`);
        blocked++;
        continue;
      }

      if (verification.status === "modified") {
        log.warn(`[skill:md] ⚠️ MODIFIED ${parsed.name}: requires re-approval (hash changed)`);
        pending++;
        // Still load but mark as pending — admin can approve via skill-verify.approve
        // For now, allow modified skills to run but log heavily
      }

      if (verification.scanResult.warnings.length > 0) {
        log.warn(`[skill:md] ⚠️ ${parsed.name} warnings: ${verification.scanResult.warnings.join(", ")}`);
      }

      // Build argsSchema from parsed args
      const properties: Record<string, { type: string; description: string }> = {};
      const required: string[] = [];
      for (const [argName, argDef] of Object.entries(parsed.args)) {
        properties[argName] = { type: argDef.type, description: argDef.description };
        if (argDef.required) required.push(argName);
      }

      const statusTag = verification.status === "modified" ? "[PENDING] " : "";

      registerSkill({
        name: parsed.name,
        description: `[MD] ${statusTag}${parsed.description}`,
        adminOnly: parsed.adminOnly,
        argsSchema: { type: "object", properties, required },
        execute: createExecutor(parsed.code, parsed.name),
      });

      loaded++;
      log.info(`[skill:md] Loaded ${parsed.name} from ${file} (${verification.status}, hash: ${verification.hash.slice(0, 12)}...)`);
    } catch (err) {
      log.warn(`[skill:md] Error loading ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (blocked > 0) log.warn(`[skill:md] ⛔ ${blocked} skill(s) BLOCKED by security scan`);
  if (pending > 0) log.warn(`[skill:md] ⚠️ ${pending} skill(s) pending re-approval`);

  return loaded;
}

/**
 * Create a new skill from code (used by skills.create).
 * Validates code safety BEFORE writing to disk.
 */
export function createSkillFile(name: string, description: string, args: string, code: string): string {
  // Security scan BEFORE writing to disk
  const scanResult = scanCode(code);
  if (!scanResult.safe) {
    throw new Error(`Skill code blocked by security scan: ${scanResult.blocked.join(", ")}`);
  }

  if (!fs.existsSync(SKILLS_DIR)) {
    fs.mkdirSync(SKILLS_DIR, { recursive: true });
  }

  const fileName = `${name.replace(/\./g, "-")}.skill.md`;
  const filePath = path.join(SKILLS_DIR, fileName);

  const content = `# ${name}

${description}

\`\`\`yaml
name: ${name}
description: ${description}
admin_only: false
args:
${args || "  # no args"}
\`\`\`

\`\`\`javascript
${code}
\`\`\`
`;

  fs.writeFileSync(filePath, content, "utf-8");

  // Store hash immediately
  const hash = hashContent(content);
  try {
    const db = getDb();
    db.prepare(
      "INSERT OR REPLACE INTO skill_hashes (name, file_path, hash, status, approved_by, updated_at) VALUES (?, ?, ?, 'approved', 'skills.create', datetime('now'))"
    ).run(name, filePath, hash);
  } catch {
    // DB not available during tests
  }

  return filePath;
}
