/**
 * Claude CLI integration.
 * Spawns `claude -p ... --output-format json` and captures output.
 * Passes the prompt via stdin to avoid command-line length limits (especially on Windows).
 * Supports session resumption via --resume <sessionId>.
 */
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { config } from "../config/env.js";
import { log } from "../utils/log.js";
import { parseClaudeOutput, type ParsedResult } from "./protocol.js";
import { getTurns, getSession, saveSession, getDb } from "../storage/store.js";
import { getCompactToolCatalog } from "../skills/loader.js";
import { getLifeboatPrompt } from "../orchestrator/lifeboat.js";
import { getLearnedRulesPrompt } from "../memory/self-review.js";
import { buildSemanticContext } from "../memory/semantic.js";

const CLI_TIMEOUT_MS = config.cliTimeoutMs;

/** Load AUTONOMOUS.md if it exists */
function loadAutonomousPrompt(): string {
  try {
    const p = path.resolve(process.cwd(), "AUTONOMOUS.md");
    if (fs.existsSync(p)) {
      return fs.readFileSync(p, "utf-8");
    }
  } catch { /* ignore */ }
  return "";
}

/** Load SOUL.md if it exists */
function loadSoulPrompt(): string {
  try {
    const p = path.resolve(process.cwd(), "relay", "SOUL.md");
    if (fs.existsSync(p)) {
      return fs.readFileSync(p, "utf-8");
    }
  } catch { /* ignore */ }
  return "";
}

function buildSystemPolicy(isAdmin: boolean, chatId?: number): string {
  const lines = [
    `You are Kingston, an autonomous AI assistant operating through a Telegram relay on the user's machine.`,
    `Your name is Kingston. You are proactive, capable, and concise.`,
    `IMPORTANT: Your identity is Kingston. Never identify as Émile, OpenClaw, Claude, or any other name.`,
    ``,
    `## Environment`,
    `- Platform: ${os.platform()} ${os.arch()}`,
    `- OS: ${os.type()} ${os.release()}`,
    `- Hostname: ${os.hostname()}`,
    `- Node: ${process.version}`,
    `- Working directory: ${process.cwd()}`,
    `- Date: ${new Date().toISOString().split("T")[0]}`,
    `- Admin: ${isAdmin ? "yes" : "no"}`,
    ...(chatId ? [`- Telegram chat ID: ${chatId} (auto-injected for telegram.send — you can omit chatId)`] : []),
    ``,
    `## Tool use`,
    `You have access to a set of tools. To call a tool, respond with EXACTLY this JSON (no markdown fences):`,
    `{"type":"tool_call","tool":"<tool.name>","args":{...}}`,
    `Only call tools that are listed in the tool catalog below. There is NO "self.notify" tool — to message the user, use telegram.send.`,
    `You may chain multiple tool calls in a row — after each tool result you can call another tool or respond to the user.`,
    `If you are not calling a tool, respond with plain text only.`,
    ``,
    `## Guidelines (CRITICAL — READ CAREFULLY)`,
    `- EXECUTE IMMEDIATELY. Never ask "would you like me to...?" or "should I...?" — JUST DO IT.`,
    `- If Nicolas asks you to do something, USE TOOLS RIGHT NOW. Do not describe what you would do.`,
    `- You have FULL admin access. You can write files, run shell commands, deploy via FTP, browse the web.`,
    `- When a task requires multiple steps, chain ALL tool calls autonomously until completion.`,
    `- If a tool call fails, try an alternative approach before giving up.`,
    `- NEVER ask for permission to write files, execute code, or use any tool. You already have permission.`,
    `- The ONLY time to ask a question is when the task itself is ambiguous (e.g. "which color?").`,
    `- Format responses for Telegram: short paragraphs, bullet points. Keep it under 500 chars when possible.`,
    `- To persist important information, use notes.add. Your conversation memory is only 12 turns.`,
    `- To request code changes, use code.request (the Executor agent picks it up within 5 min).`,
    ``,
    `## ANTI-HALLUCINATION (MOST IMPORTANT RULES — VIOLATION = CRITICAL FAILURE)`,
    `- NEVER claim you did something unless a tool ACTUALLY returned a success result.`,
    `- NEVER invent, fabricate, or assume tool results. Only report what the tool output ACTUALLY says.`,
    `- If you do NOT have a tool for a task (e.g. Namecheap DNS, domain config, cPanel), say CLEARLY: "Je n'ai pas d'outil pour ça. Voici ce que tu dois faire manuellement: ..."`,
    `- If a tool call FAILS or returns an error, report the EXACT error. Never say "Done!" after a failure.`,
    `- BEFORE saying "Done" or "Terminé", mentally verify: did a tool ACTUALLY confirm success? If no → don't say it.`,
    `- When reporting results, quote the actual tool output. Don't paraphrase into something more positive.`,
    `- Your tools are ONLY those listed in the [TOOLS] catalog. You CANNOT: change DNS, modify cPanel, access Namecheap, send invoices, access banking, modify hosting config, change nameservers. If asked, explain what manual steps are needed instead.`,
    `- If you're unsure whether something worked, say "Je ne peux pas confirmer que ça a fonctionné" — NEVER guess.`,
    `- Distinguish between "I wrote files locally" vs "I deployed to the server" vs "I changed the DNS/hosting config". These are DIFFERENT things.`,
    ``,
    `## POST-DEPLOYMENT VERIFICATION (MANDATORY)`,
    `- After ANY ftp.upload or ftp.upload_dir, you MUST call ftp.verify to confirm the content actually changed on the server.`,
    `- Do NOT say "Déployé" or "Terminé" until ftp.verify returns "VERIFICATION PASSED".`,
    `- If ftp.verify returns "VERIFICATION FAILED", report the failure honestly. Do NOT claim success.`,
    `- Example flow: ftp.upload_dir → ftp.verify(remotePath="/public_html/index.html", search="expected content") → only THEN confirm to user.`,
    ``,
    `## Self-modification (admin only)`,
    `- Your source code is at: ${process.cwd()}`,
    `- You can read your own code with files.read_anywhere`,
    `- You can modify your own code with files.write_anywhere`,
    `- You can run shell commands with shell.exec`,
    `- You can execute code with code.run`,
    `- After modifying code, the bot must be restarted to apply changes.`,
  ];

  // Inject SOUL.md personality (before AUTONOMOUS.md)
  const soulPrompt = loadSoulPrompt();
  if (soulPrompt) {
    lines.push("", soulPrompt);
  }

  // Append AUTONOMOUS.md content if it exists
  const autonomousPrompt = loadAutonomousPrompt();
  if (autonomousPrompt) {
    lines.push("", autonomousPrompt);
  }

  // Inject learned rules from MISS/FIX auto-graduation
  const learnedRules = getLearnedRulesPrompt();
  if (learnedRules) {
    lines.push("", learnedRules);
  }

  // Inject context lifeboat if available
  if (chatId) {
    const lifeboat = getLifeboatPrompt(chatId);
    if (lifeboat) {
      lines.push("", lifeboat);
    }
  }

  return lines.join("\n");
}

/**
 * Build long-term memory context: recent notes + semantic memories + 48h conversation activity.
 * Injected into both new and resumed sessions so Kingston remembers past interactions.
 */
async function buildMemoryContext(chatId: number, userMessage?: string): Promise<string> {
  const db = getDb();
  const parts: string[] = [];

  // 1. Recent notes (Kingston's long-term memory)
  try {
    const notes = db
      .prepare("SELECT id, text, created_at FROM notes ORDER BY id DESC LIMIT 15")
      .all() as { id: number; text: string; created_at: number }[];
    if (notes.length > 0) {
      parts.push("[NOTES — Long-term memory]");
      for (const n of notes.reverse()) {
        const text = n.text.length > 200 ? n.text.slice(0, 200) + "..." : n.text;
        parts.push(`#${n.id}: ${text}`);
      }
    }
  } catch { /* notes table may not exist yet */ }

  // 2. Semantic memory (relevant to current message)
  if (userMessage) {
    try {
      const semanticCtx = await buildSemanticContext(userMessage, 10);
      if (semanticCtx) {
        parts.push("\n" + semanticCtx);
      }
    } catch { /* semantic memory not available yet */ }
  }

  // 3. Recent conversation activity (last 48h, user messages only, from this chat)
  try {
    const cutoff = Math.floor(Date.now() / 1000) - 48 * 3600;
    const recentTurns = db
      .prepare(
        `SELECT role, content, created_at FROM turns
         WHERE chat_id = ? AND created_at > ? AND role = 'user'
         AND content NOT LIKE '[Tool %' AND content NOT LIKE '[AGENT:%' AND content NOT LIKE '[SCHEDULER%'
         ORDER BY id DESC LIMIT 20`
      )
      .all(chatId, cutoff) as { role: string; content: string; created_at: number }[];
    if (recentTurns.length > 0) {
      parts.push("\n[RECENT ACTIVITY — last 48h user messages]");
      for (const t of recentTurns.reverse()) {
        const date = new Date(t.created_at * 1000);
        const timeStr = date.toLocaleString("fr-CA", { hour: "2-digit", minute: "2-digit", hour12: false });
        const content = t.content.length > 120 ? t.content.slice(0, 120) + "..." : t.content;
        parts.push(`[${timeStr}] ${content}`);
      }
    }
  } catch { /* turns query failed */ }

  return parts.length > 0 ? parts.join("\n") : "";
}

/**
 * Build the full prompt: system policy + tool catalog + memory + conversation history + current message.
 * Used only for new sessions (no --resume).
 */
async function buildFullPrompt(
  chatId: number,
  userMessage: string,
  isAdmin: boolean
): Promise<string> {
  const parts: string[] = [];

  // System policy
  parts.push(`[SYSTEM]\n${buildSystemPolicy(isAdmin, chatId)}`);

  // Tool catalog (compact — one line per namespace)
  const catalog = getCompactToolCatalog(isAdmin);
  if (catalog) {
    parts.push(`\n[TOOLS — call with {"type":"tool_call","tool":"namespace.method","args":{...}}]\n${catalog}`);
  }

  // Long-term memory (notes + semantic + 48h activity)
  const memory = await buildMemoryContext(chatId, userMessage);
  if (memory) {
    parts.push(`\n${memory}`);
  }

  // Conversation history
  const turns = getTurns(chatId);
  if (turns.length > 0) {
    parts.push("\n[CONVERSATION HISTORY]");
    for (const t of turns) {
      const label = t.role === "user" ? "User" : "Assistant";
      parts.push(`${label}: ${t.content}`);
    }
  }

  // Current message
  parts.push(`\n[CURRENT MESSAGE]\nUser: ${userMessage}`);

  return parts.join("\n");
}

/**
 * Run the Claude CLI with the given prompt and return parsed output.
 * Uses stdin to pass the prompt to avoid shell quoting issues.
 * Resumes existing sessions when available for token savings.
 */
export async function runClaude(
  chatId: number,
  userMessage: string,
  isAdmin: boolean = false,
  modelOverride?: string,
  _retryCount: number = 0
): Promise<ParsedResult> {
  const existingSession = getSession(chatId);
  const isResume = !!existingSession;

  // For resumed sessions: lightweight prompt — CLI already has full context in memory.
  // Only inject identity reminder + memory context + the new message.
  // For new sessions: full prompt with system policy + tools + history.
  let prompt: string;
  if (isResume) {
    const memory = await buildMemoryContext(chatId, userMessage);
    const memoryBlock = memory ? `\n${memory}\n` : "";
    prompt = [
      `[IDENTITY: You are Kingston. Respond in the same language as the user (usually French).]`,
      `[Context: chatId=${chatId}, admin=${isAdmin}, date=${new Date().toISOString().split("T")[0]}]`,
      memoryBlock,
      userMessage,
    ].join("\n");
  } else {
    prompt = await buildFullPrompt(chatId, userMessage, isAdmin);
  }

  log.debug(`Claude prompt length: ${prompt.length} (resume: ${isResume})`);

  return new Promise<ParsedResult>((resolve) => {
    const model = modelOverride || config.claudeModel;
    const args = ["-p", "-", "--output-format", "json", "--model", model, "--dangerously-skip-permissions"];

    if (isResume) {
      args.push("--resume", existingSession);
      log.debug(`Resuming session: ${existingSession}`);
    }

    log.debug(`Spawning: ${config.claudeBin} ${args.join(" ")}`);

    // Strip ANTHROPIC_API_KEY so the CLI uses the Max plan, not the paid API
    const { ANTHROPIC_API_KEY: _stripped, ...cliEnv } = process.env;
    const proc = spawn(config.claudeBin, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: cliEnv,
      shell: false,
    });

    let stdout = "";
    let stderr = "";
    let killed = false;

    // Timeout: kill the process if it takes too long
    const timer = setTimeout(() => {
      killed = true;
      proc.kill("SIGTERM");
      log.warn(`Claude CLI timed out after ${CLI_TIMEOUT_MS}ms`);
    }, CLI_TIMEOUT_MS);

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    // Write the prompt to stdin and close it
    proc.stdin.write(prompt);
    proc.stdin.end();

    proc.on("error", (err) => {
      clearTimeout(timer);
      log.error("Failed to spawn Claude CLI:", err.message);
      resolve({
        type: "message",
        text: `Error: Could not run Claude CLI. Is "${config.claudeBin}" on your PATH?\n\n${err.message}`,
      });
    });

    proc.on("close", (code) => {
      clearTimeout(timer);

      if (killed) {
        resolve({
          type: "message",
          text: "(Claude CLI timed out — response took too long)",
        });
        return;
      }

      if (code !== 0) {
        log.warn(`Claude CLI exited with code ${code}. stderr: ${stderr.slice(0, 500)}`);
      }
      if (!stdout.trim()) {
        log.warn("Claude CLI returned empty stdout. stderr:", stderr.slice(0, 500));
        // Retry once on empty response (CLI may have been killed by tsx --watch restart)
        if (_retryCount < 1) {
          log.info(`[claudeCli] Empty response — retrying (attempt ${_retryCount + 1})...`);
          resolve(runClaude(chatId, userMessage, isAdmin, modelOverride, _retryCount + 1));
          return;
        }
        resolve({
          type: "message",
          text: stderr.trim() || "(Claude returned an empty response)",
        });
        return;
      }

      log.debug(`Claude raw output (first 300 chars): ${stdout.slice(0, 300)}`);
      const result = parseClaudeOutput(stdout);
      log.debug("Parsed Claude result type:", result.type);
      if (result.type === "tool_call") {
        log.debug(`Parsed tool_call: ${result.tool}(${JSON.stringify(result.args).slice(0, 200)})`);
      }

      // Save session_id for future resumption
      if (result.session_id) {
        saveSession(chatId, result.session_id);
        log.debug(`Session saved: ${result.session_id}`);
      }

      resolve(result);
    });
  });
}
