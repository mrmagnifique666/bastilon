/**
 * Streaming Claude CLI integration.
 * Spawns `claude -p - --output-format stream-json --verbose` and parses NDJSON output.
 * Provides real-time text deltas for draft message updates.
 */
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { config } from "../config/env.js";
import { log } from "../utils/log.js";
import { getTurns, getSession, saveSession, getDb, getSummary } from "../storage/store.js";
import { getCompactToolCatalog } from "../skills/loader.js";
import { getLifeboatPrompt } from "../orchestrator/lifeboat.js";
import { getLearnedRulesPrompt } from "../memory/self-review.js";
import { buildSemanticContext } from "../memory/semantic.js";

export interface StreamResult {
  text: string;
  session_id?: string;
  is_tool_call: boolean;
  tool?: string;
  args?: Record<string, unknown>;
}

export interface StreamCallbacks {
  onDelta(text: string): void;
  onComplete(result: StreamResult): void;
  onError(error: Error): void;
}

export interface StreamHandle {
  cancel(): void;
}

/** Cached file contents — loaded once, avoids repeated disk I/O */
let _cachedAutonomous: string | null = null;
let _cachedSoul: string | null = null;
let _soulMtime = 0;

/** Load AUTONOMOUS.md if it exists (cached after first call) */
function loadAutonomousPrompt(): string {
  if (_cachedAutonomous !== null) return _cachedAutonomous;
  try {
    const p = path.resolve(process.cwd(), "AUTONOMOUS.md");
    if (fs.existsSync(p)) {
      _cachedAutonomous = fs.readFileSync(p, "utf-8");
      return _cachedAutonomous;
    }
  } catch { /* ignore */ }
  _cachedAutonomous = "";
  return "";
}

/** Load SOUL.md if it exists — mtime-aware cache (refreshes when file is edited). */
function loadSoulPrompt(): string {
  try {
    const p = path.resolve(process.cwd(), "relay", "SOUL.md");
    if (!fs.existsSync(p)) return "";
    const stat = fs.statSync(p);
    if (_cachedSoul !== null && stat.mtimeMs === _soulMtime) return _cachedSoul;
    _cachedSoul = fs.readFileSync(p, "utf-8");
    _soulMtime = stat.mtimeMs;
    return _cachedSoul;
  } catch {
    return "";
  }
}

/**
 * Build a compact core identity for resumed sessions.
 * Extracts the essential personality from SOUL.md + critical rules.
 * Much smaller than the full buildSystemPolicy but preserves Kingston's identity.
 */
function buildCoreIdentity(isAdmin: boolean, chatId?: number): string {
  const soul = loadSoulPrompt();
  const lines: string[] = [];

  lines.push(`[CORE IDENTITY]`);
  lines.push(`You are Kingston, the AI running on Bastilon OS — a Telegram relay bot on the user's machine.`);
  lines.push(`IMPORTANT: Your identity is Kingston on Bastilon. NEVER identify as Émile, OpenClaw, Claude Code CLI, or any other name.`);
  lines.push(`You operate through Telegram, NOT through a CLI terminal. You have full tool access via Bastilon.`);
  // Use SOUL.md if available for personality
  if (soul) {
    lines.push(soul.trim());
  } else {
    lines.push(`Direct, efficace, honnête. J'exécute sans demander permission.`);
  }

  lines.push(``);
  lines.push(`[RULES]`);
  lines.push(`- Execute immediately, never ask "would you like me to...?" — JUST DO IT.`);
  lines.push(`- Anti-hallucination: NEVER claim success without tool confirmation.`);
  lines.push(`- Tool format: {"type":"tool_call","tool":"namespace.method","args":{}}`);
  lines.push(`- If a tool fails, report the EXACT error. Never say "Done!" after a failure.`);
  lines.push(`- Format for Telegram: concis, < 500 chars quand possible.`);

  lines.push(``);
  lines.push(`[CONTEXT]`);
  lines.push(`- Date: ${new Date().toISOString().split("T")[0]}`);
  lines.push(`- Admin: ${isAdmin ? "yes" : "no"}`);
  if (chatId) lines.push(`- Telegram chat ID: ${chatId}`);

  return lines.join("\n");
}

function buildSystemPolicy(isAdmin: boolean, chatId?: number): string {
  const lines = [
    `You are Kingston, the AI running on Bastilon OS — a personal AI fortress on the user's machine.`,
    `Your name is Kingston. You are proactive, capable, and concise. Bastilon is your operating system.`,
    `IMPORTANT: Your identity is Kingston on Bastilon. Never identify as Émile, OpenClaw, Claude, or any other name.`,
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
    `- Format responses for Telegram: use short paragraphs, bullet points, and code blocks where helpful.`,
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
    `## Image Analysis (CRITICAL - Prevent Hallucination)`,
    `- When analyzing images, describe ONLY what is clearly visible in the image.`,
    `- Do NOT fabricate, invent, or hallucinate details that are not present.`,
    `- If you're uncertain about details, say "I can see [X] but I'm not confident about [Y]".`,
    `- Never elaborate beyond what's shown in the image.`,
    `- If an image is ambiguous, acknowledge the ambiguity rather than guessing.`,
    `- Trust the image data provided — it is accurate and complete.`,
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
 * Same as claudeCli.ts — injected into both new and resumed sessions.
 */
async function buildMemoryContext(chatId: number, userMessage?: string): Promise<string> {
  const db = getDb();
  const parts: string[] = [];

  // Run notes query + semantic search in parallel (saves ~500ms)
  const notesPromise = Promise.resolve().then(() => {
    try {
      return db
        .prepare("SELECT id, text, created_at FROM notes ORDER BY id DESC LIMIT 15")
        .all() as { id: number; text: string; created_at: number }[];
    } catch { return []; }
  });

  const semanticPromise = userMessage
    ? buildSemanticContext(userMessage, 10, chatId).catch(() => "")
    : Promise.resolve("");

  const [notes, semanticCtx] = await Promise.all([notesPromise, semanticPromise]);

  // 1. Conversation summary (progressive)
  try {
    const summary = getSummary(chatId);
    if (summary?.summary) {
      parts.push("[CONVERSATION SUMMARY]");
      parts.push(summary.summary);
      if (summary.topics.length > 0) {
        parts.push(`Topics actifs: [${summary.topics.join(", ")}]`);
      }
    }
  } catch { /* no summary */ }

  // 2. Recent notes
  if (notes.length > 0) {
    parts.push("\n[NOTES — Long-term memory]");
    for (const n of notes.reverse()) {
      const text = n.text.length > 200 ? n.text.slice(0, 200) + "..." : n.text;
      parts.push(`#${n.id}: ${text}`);
    }
  }

  // 3. Semantic memory
  if (semanticCtx) {
    parts.push("\n" + semanticCtx);
  }

  // 4. Recent conversation activity (last 48h, user messages only, from this chat)
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

async function buildFullPrompt(chatId: number, userMessage: string, isAdmin: boolean): Promise<string> {
  const parts: string[] = [];
  parts.push(`[SYSTEM]\n${buildSystemPolicy(isAdmin, chatId)}`);
  const catalog = getCompactToolCatalog(isAdmin);
  if (catalog) parts.push(`\n[TOOLS — call with {"type":"tool_call","tool":"namespace.method","args":{...}}]\n${catalog}`);

  // Long-term memory (notes + semantic + summary + 48h activity)
  const memory = await buildMemoryContext(chatId, userMessage);
  if (memory) parts.push(`\n${memory}`);

  const turns = getTurns(chatId);
  if (turns.length > 0) {
    parts.push("\n[CONVERSATION HISTORY]");
    for (const t of turns) {
      const label = t.role === "user" ? "User" : "Assistant";
      parts.push(`${label}: ${t.content}`);
    }
  }
  parts.push(`\n[CURRENT MESSAGE]\nUser: ${userMessage}`);
  return parts.join("\n");
}

/**
 * Run Claude CLI in streaming mode.
 * Parses NDJSON lines from `--output-format stream-json`.
 */
export function runClaudeStream(
  chatId: number,
  userMessage: string,
  isAdmin: boolean,
  callbacks: StreamCallbacks,
  modelOverride?: string
): StreamHandle {
  const existingSession = getSession(chatId);
  const isResume = !!existingSession;

  let killed = false;
  let proc: ChildProcess | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  // Build prompt async, then spawn the CLI process
  (async () => {
    let prompt: string;
    if (isResume) {
      const memory = await buildMemoryContext(chatId, userMessage);
      const catalog = getCompactToolCatalog(isAdmin);
      const parts: string[] = [
        buildCoreIdentity(isAdmin, chatId),
      ];
      if (catalog) {
        parts.push(`\n[TOOLS]\n${catalog}`);
      }
      if (memory) {
        parts.push(`\n${memory}`);
      }
      parts.push(`\n[NEW MESSAGE]\nUser: ${userMessage}`);
      prompt = parts.join("\n");
    } else {
      prompt = await buildFullPrompt(chatId, userMessage, isAdmin);
    }

    if (killed) return; // Cancelled while building prompt

    const model = modelOverride || config.claudeModel;
    const cliArgs = ["-p", "-", "--output-format", "stream-json", "--verbose", "--model", model, "--dangerously-skip-permissions"];
    if (isResume) {
      cliArgs.push("--resume", existingSession);
    }

    log.debug(`[stream] Spawning Claude stream (resume=${isResume})`);

    const { ANTHROPIC_API_KEY: _stripped, ...cliEnv } = process.env;
    proc = spawn(config.claudeBin, cliArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      env: cliEnv,
      shell: false,
    });

    timer = setTimeout(() => {
      killed = true;
      proc?.kill("SIGTERM");
      callbacks.onError(new Error("Claude CLI stream timed out"));
    }, config.cliTimeoutMs);

    // Stall detection: if no output for 2 minutes, kill the stream.
    // CLI with --dangerously-skip-permissions can be silent during tool execution,
    // but 2min is generous enough for any single operation.
    const STALL_TIMEOUT_MS = 120_000;
    let lastActivity = Date.now();
    const stallInterval = setInterval(() => {
      if (Date.now() - lastActivity > STALL_TIMEOUT_MS) {
        clearInterval(stallInterval);
        if (!killed) {
          killed = true;
          log.warn(`[stream] No output for ${STALL_TIMEOUT_MS / 1000}s — killing stalled stream`);
          proc?.kill("SIGTERM");
          callbacks.onError(new Error(`Claude CLI stream stalled (no output for ${STALL_TIMEOUT_MS / 1000}s)`));
        }
      }
    }, 15_000);

    let accumulated = "";
    let lineBuffer = "";

    function handleStreamEvent(event: any): void {
      if (event.type === "content_block_delta") {
        const delta = event.delta;
        if (delta?.type === "text_delta" && delta.text) {
          accumulated += delta.text;
          callbacks.onDelta(accumulated);
        }
      }

      if (event.type === "result") {
        const sessionId = event.session_id;
        if (sessionId) {
          saveSession(chatId, sessionId);
        }

        const resultText = typeof event.result === "string" ? event.result : accumulated;
        log.info(`[stream] Result received: ${resultText.length} chars, accumulated: ${accumulated.length} chars, event.result type: ${typeof event.result}`);
        log.debug(`[stream] Result text (first 300): ${resultText.slice(0, 300)}`);

        const toolCall = detectToolCall(resultText);
        if (toolCall) {
          log.info(`[stream] Detected tool_call: ${toolCall.tool}`);
          callbacks.onComplete({
            text: resultText,
            session_id: sessionId,
            is_tool_call: true,
            tool: toolCall.tool,
            args: toolCall.args,
          });
        } else {
          log.info(`[stream] Plain text response (no tool call)`);
          callbacks.onComplete({
            text: resultText,
            session_id: sessionId,
            is_tool_call: false,
          });
        }
      }

      if (event.type === "message_start" && event.message?.id) {
        log.debug(`[stream] Message started: ${event.message.id}`);
      }
    }

    proc.stdout!.on("data", (chunk: Buffer) => {
      lastActivity = Date.now();
      lineBuffer += chunk.toString();
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          handleStreamEvent(event);
        } catch {
          log.debug(`[stream] Non-JSON line: ${line.slice(0, 100)}`);
        }
      }
    });

    proc.stderr!.on("data", (chunk: Buffer) => {
      lastActivity = Date.now();
      log.debug(`[stream] stderr: ${chunk.toString().slice(0, 200)}`);
    });

    proc.stdin!.write(prompt);
    proc.stdin!.end();

    proc.on("error", (err) => {
      if (timer) clearTimeout(timer);
      clearInterval(stallInterval);
      callbacks.onError(err);
    });

    proc.on("close", (code) => {
      if (timer) clearTimeout(timer);
      clearInterval(stallInterval);
      if (killed) return;

      if (lineBuffer.trim()) {
        try {
          const event = JSON.parse(lineBuffer);
          handleStreamEvent(event);
        } catch {
          if (accumulated) {
            const toolCall = detectToolCall(accumulated);
            if (toolCall) {
              callbacks.onComplete({
                text: accumulated,
                is_tool_call: true,
                tool: toolCall.tool,
                args: toolCall.args,
              });
            } else {
              callbacks.onComplete({ text: accumulated, is_tool_call: false });
            }
          } else if (lineBuffer.trim()) {
            callbacks.onComplete({ text: lineBuffer.trim(), is_tool_call: false });
          }
        }
      } else if (!accumulated && code !== 0) {
        callbacks.onError(new Error(`Claude CLI exited with code ${code}`));
      } else if (accumulated) {
        const toolCall = detectToolCall(accumulated);
        callbacks.onComplete({
          text: accumulated,
          is_tool_call: !!toolCall,
          tool: toolCall?.tool,
          args: toolCall?.args,
        });
      } else {
        log.warn(`[stream] CLI exited cleanly but produced no output`);
        callbacks.onError(new Error("Claude CLI produced no output (empty response)"));
      }
    });
  })().catch((err) => {
    callbacks.onError(err instanceof Error ? err : new Error(String(err)));
  });

  return {
    cancel() {
      killed = true;
      if (timer) clearTimeout(timer);
      proc?.kill("SIGTERM");
    },
  };

  // Note: stallInterval is cleaned up in close/error handlers above
}

/**
 * Detect if text contains a JSON tool_call.
 * Tries pure JSON first (ideal case), then scans for the last
 * {"type":"tool_call",...} block in case Claude prefixed thinking text.
 * Tool name is validated against a strict pattern to prevent injection.
 */
function detectToolCall(text: string): { tool: string; args: Record<string, unknown> } | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // Fast path: pure JSON (ideal case — no thinking text)
  if (trimmed.startsWith("{")) {
    const result = tryParseToolCall(trimmed);
    if (result) return result;
  }

  // Slow path: Claude prefixed thinking text before the JSON.
  // Find the last occurrence of {"type":"tool_call" in the text.
  const marker = '{"type":"tool_call"';
  const idx = trimmed.lastIndexOf(marker);
  if (idx < 0) return null;

  let jsonCandidate = trimmed.slice(idx);
  // Strip trailing markdown code fence if present (```json...```)
  jsonCandidate = jsonCandidate.replace(/\s*```\s*$/, "").trim();
  return tryParseToolCall(jsonCandidate);
}

function tryParseToolCall(text: string): { tool: string; args: Record<string, unknown> } | null {
  try {
    const obj = JSON.parse(text);
    if (
      obj &&
      typeof obj === "object" &&
      obj.type === "tool_call" &&
      typeof obj.tool === "string" &&
      /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(obj.tool)
    ) {
      return { tool: obj.tool, args: obj.args || {} };
    }
  } catch { /* not valid JSON */ }
  return null;
}
