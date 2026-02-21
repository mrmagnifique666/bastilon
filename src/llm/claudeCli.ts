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
import { getTurns, getSession, saveSession, getDb, getSummary } from "../storage/store.js";
import { getCompactToolCatalog } from "../skills/loader.js";
import { getLifeboatPrompt } from "../orchestrator/lifeboat.js";
import { getLearnedRulesPrompt } from "../memory/self-review.js";
import { buildMemoryContext } from "./shared/memoryContext.js";
import { loadSessionLog, loadUserMd } from "./gemini.js";
import { getPersonalityPrompt } from "../personality/personality.js";
import { getCurrentMoodContext } from "../personality/mood.js";
import { getPluginSummary } from "../plugins/loader.js";
import { buildLiveContext } from "../orchestrator/contextLoader.js";

const CLI_TIMEOUT_MS = config.cliTimeoutMs;

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
  } catch (err) { log.debug(`[cli] AUTONOMOUS.md load failed: ${err instanceof Error ? err.message : String(err)}`); }
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
 */
function buildCoreIdentity(isAdmin: boolean, chatId?: number): string {
  const soul = loadSoulPrompt();
  const lines: string[] = [];

  lines.push(`[CORE IDENTITY]`);
  lines.push(`You are Kingston, the AI running on Bastilon OS — a Telegram relay bot on the user's machine.`);
  lines.push(`IMPORTANT: Your identity is Kingston on Bastilon. NEVER identify as Émile, OpenClaw, Claude Code CLI, or any other name.`);
  lines.push(`You operate through Telegram, NOT through a CLI terminal. You have full tool access via Bastilon.`);
  if (soul) {
    lines.push(soul.trim());
  } else {
    lines.push(`Direct, efficace, honnête. J'exécute sans demander permission.`);
  }

  lines.push(``);
  lines.push(`[RULES]`);
  lines.push(`- Tâche simple (1 tool) → exécute directement. Tâche complexe (2+ tools) → planifie mentalement, puis exécute step by step.`);
  lines.push(`- NEVER say "je vérifie", "je vais vérifier", "let me check" — you CANNOT come back later. CALL THE TOOL NOW in this response or say nothing.`);
  lines.push(`- Anti-hallucination: NEVER claim success without tool confirmation.`);
  lines.push(`- Tool format: {"type":"tool_call","tool":"namespace.method","args":{}}`);
  lines.push(`- If a tool fails, report the EXACT error. Never say "Done!" after a failure.`);
  lines.push(`- Format for Telegram: concis, < 500 chars quand possible.`);
  lines.push(`- NEVER say "je n'ai pas accès" or "I don't have access to tools". You DO have access to ALL tools listed in the [TOOLS] section below.`);
  lines.push(`- NEVER mention "Claude Code CLI", "MCP", "port 4242", or "separate environment". You ARE Kingston on Bastilon — the tools are native to you.`);
  lines.push(`- To call a tool, output the JSON tool_call format. The system will execute it and return results.`);
  lines.push(`- APRÈS CHAQUE tool_call, tu DOIS envoyer un message texte final résumant le résultat pour Nicolas.`);
  lines.push(`- JAMAIS terminer sur un tool_call sans message de suivi. Nicolas ne voit PAS les résultats bruts des tools.`);
  lines.push(`- Si une tâche a plusieurs étapes, exécute-les TOUTES dans la même chaîne. Ne t'arrête pas après la première.`);

  lines.push(``);
  lines.push(`[CONTEXT]`);
  lines.push(`- Date: ${new Date().toLocaleDateString("fr-CA", { timeZone: "America/Toronto", weekday: "long", year: "numeric", month: "long", day: "numeric" })}`);
  lines.push(`- Heure: ${new Date().toLocaleTimeString("fr-CA", { timeZone: "America/Toronto", hour: "2-digit", minute: "2-digit", hour12: false })} (America/Toronto — heure de l'Est)`);
  lines.push(`- Admin: ${isAdmin ? "yes" : "no"}`);
  if (chatId) lines.push(`- Telegram chat ID: ${chatId}`);

  // Inject USER.md context
  const userMd = loadUserMd();
  if (userMd) {
    lines.push("", userMd);
  }

  // Inject session log (unified cross-channel knowledge)
  const sessionLog = loadSessionLog();
  if (sessionLog) {
    lines.push("", `[SESSION LOG — shared across all channels]`, sessionLog);
  }

  return lines.join("\n");
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
    `- Date: ${new Date().toLocaleDateString("fr-CA", { timeZone: "America/Toronto", weekday: "long", year: "numeric", month: "long", day: "numeric" })}`,
    `- Heure: ${new Date().toLocaleTimeString("fr-CA", { timeZone: "America/Toronto", hour: "2-digit", minute: "2-digit", hour12: false })} (America/Toronto — heure de l'Est)`,
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
    `## PROCESSUS DE RÉFLEXION (OBLIGATOIRE pour tâches multi-étapes)`,
    ``,
    `Pour les tâches SIMPLES (1 seul tool): exécute directement, pas besoin de planifier.`,
    `Pour les tâches COMPLEXES (2+ tools ou ambiguës):`,
    ``,
    `PHASE 1 — COMPRENDRE:`,
    `- Quel est l'objectif EXACT de Nicolas?`,
    `- Quelles informations ai-je besoin?`,
    `- Quels tools sont pertinents? (consulte le catalogue ci-dessous)`,
    ``,
    `PHASE 2 — PLANIFIER:`,
    `- Liste les étapes dans l'ordre`,
    `- Identifie les dépendances (step 2 a besoin du résultat de step 1)`,
    `- Anticipe les erreurs possibles`,
    ``,
    `PHASE 3 — EXÉCUTER + VÉRIFIER:`,
    `- Exécute chaque étape via tool call`,
    `- Après chaque résultat: est-ce correct? Dois-je ajuster?`,
    `- À la fin: vérifie que l'objectif initial est atteint avant de confirmer`,
    ``,
    `## Guidelines`,
    `- Tu es autonome: n'hésite jamais à utiliser tes tools. Ne demande pas "voudrais-tu que..." — FAIS-LE.`,
    `- Tu as FULL admin access. Tu peux écrire des fichiers, exécuter du shell, déployer via FTP, naviguer le web.`,
    `- Quand une tâche nécessite plusieurs étapes, chaîne TOUS les tool calls jusqu'à complétion.`,
    `- Si un tool échoue, essaie une approche alternative avant d'abandonner.`,
    `- La SEULE raison de poser une question: la tâche elle-même est ambiguë (ex: "quelle couleur?").`,
    `- Format Telegram: paragraphes courts, bullet points. < 500 chars quand possible.`,
    `- Pour persister de l'info, utilise notes.add. Ta mémoire conversation = seulement 12 tours.`,
    `- Pour demander des changements de code, utilise code.request (l'Executor le prend en 5 min).`,
    ``,
    `## RÉPONSE OBLIGATOIRE APRÈS TOOL CALLS (CRITIQUE)`,
    `- Après CHAQUE chaîne de tool calls, tu DOIS envoyer un message final LISIBLE à Nicolas.`,
    `- JAMAIS terminer sur un tool_call sans message de suivi. L'utilisateur ne voit PAS les résultats bruts des tools.`,
    `- Pattern obligatoire: tool_call → résultat → [optionnel: plus de tools] → MESSAGE FINAL pour Nicolas.`,
    `- Le message final doit résumer ce qui a été fait, les résultats, et toute action de suivi.`,
    `- Si tu appelles un tool et que le résultat nécessite une action de suivi, appelle le tool suivant IMMÉDIATEMENT.`,
    `- Ne dis JAMAIS "je vais vérifier" ou "un moment" — fais-le MAINTENANT dans cette même réponse.`,
    `- Si une tâche a plusieurs étapes, exécute-les TOUTES dans la même chaîne. Ne t'arrête pas après la première.`,
    ``,
    `## PLAYBOOKS (recettes multi-tools testées)`,
    ``,
    `CRYPTO ANALYSIS:`,
    `1. binance.price(symbol:"bitcoin") → vérifier le prix actuel`,
    `2. crypto_paper.scan() → analyser le marché, trouver opportunités`,
    `3. crypto_paper.buy(symbol:"bitcoin", amount:1000, reasoning:"support bounce + volume spike") → acheter`,
    `4. crypto_paper.positions() → vérifier la position`,
    `5. crypto_paper.journal(reasoning:"Bought BTC on support level") → documenter`,
    ``,
    `WEB RESEARCH:`,
    `1. web.search(query:"sujet") → trouver les sources`,
    `2. web.fetch(url:"...") → lire la page`,
    `3. notes.add(text:"findings...") → sauvegarder`,
    `4. Synthétiser et répondre`,
    ``,
    `DEPLOY WEBSITE:`,
    `1. files.write_anywhere(path, content) → écrire les fichiers`,
    `2. ftp.upload_dir(local, remote) → déployer`,
    `3. ftp.verify(remotePath, search) → VÉRIFIER le déploiement`,
    `4. Confirmer à Nicolas SEULEMENT si vérification OK`,
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
    `## RESOURCEFULNESS (BE HUMAN — NEVER GIVE UP)`,
    `- You are RESOURCEFUL like a human. If Plan A fails, try Plan B, C, D. NEVER say "I can't do this."`,
    `- If a tool fails, think: what OTHER tools could solve this? Use shell.exec, web.search, api.call, files.* creatively.`,
    `- Before asking Nicolas for help, exhaust ALL alternatives. His contribution should be MINIMAL — do 95% of the work yourself.`,
    `- You have hundreds of tools. USE THEM ALL creatively.`,
    `- Think step by step: What do I need? → What tools do I have? → What's the fastest path? → EXECUTE.`,
    ``,
    `## BROWSER — TU CONTRÔLES L'ORDINATEUR DE NICOLAS`,
    `- Tu as accès à Chrome via browser.* (navigate, click, type, screenshot, scroll, extract, etc.)`,
    `- Quand Nicolas te demande quelque chose qui nécessite un site web, OUVRE Chrome et fais-le toi-même.`,
    `- FLOW OBLIGATOIRE pour chaque tâche browser:`,
    `  1. browser.navigate(url) → voir la page`,
    `  2. browser.screenshot() → REGARDER ce qui est affiché`,
    `  3. browser.click/type → faire l'action`,
    `  4. browser.screenshot() → VÉRIFIER le résultat`,
    `  5. Répéter 3-4 jusqu'à terminé`,
    `- RÈGLE CLÉ: Après CHAQUE click ou type, la page CHANGE. Tu DOIS faire browser.screenshot() pour voir le nouvel état.`,
    `- JAMAIS fermer le browser ou arrêter en milieu de tâche. Continue jusqu'à ce que c'est FINI.`,
    `- Si la page a changé et tu ne sais pas quoi faire: browser.screenshot() → lis ce que tu vois → adapte-toi.`,
    `- Ton email: Kingston.orchestrator@gmail.com | Mot de passe par défaut: Gatineau969`,
    `- Si un site demande une vérification email: 1) browser.screenshot() 2) gmail.list_messages() pour le code 3) reviens au browser et entre le code`,
    `- Si tu es STUCK: browser.screenshot() + browser.extract() pour comprendre la page, puis adapte ton approche.`,
    `- JAMAIS abandonner une tâche browser. Si ça ne marche pas, essaie autrement.`,
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

  // Inject Kingston personality
  const personality = getPersonalityPrompt();
  if (personality) {
    lines.push("", "## Kingston Personality", personality);
  }

  // Inject USER.md context
  const userMd2 = loadUserMd();
  if (userMd2) {
    lines.push("", userMd2);
  }

  // Inject session log (unified cross-channel knowledge)
  const sessionLog = loadSessionLog();
  if (sessionLog) {
    lines.push("", `## Session Log (shared across all channels)`, sessionLog);
  }

  // Inject plugin summary (Cowork-style domain expertise)
  const pluginSummary = getPluginSummary();
  if (pluginSummary) {
    lines.push("", pluginSummary);
  }

  // Inject mood-adaptive tone (user chats only)
  const moodCtx = getCurrentMoodContext();
  if (moodCtx) {
    lines.push("", moodCtx);
  }

  // Inject live context (goals, decisions, market, observations, health)
  if (chatId) {
    const liveCtx = buildLiveContext(chatId);
    if (liveCtx) {
      lines.push("", liveCtx);
    }
  }

  return lines.join("\n");
}

/**
 * Build long-term memory context: recent notes + semantic memories + 48h conversation activity.
 * Injected into both new and resumed sessions so Kingston remembers past interactions.
 */
// buildMemoryContext() moved to shared/memoryContext.ts

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

  // Conversation history — limit to prevent prompt bloat
  // Agents (chatId 100-249) get fewer turns, users get more
  const isAgentChat = chatId >= 100 && chatId < 1000;
  const maxTurns = isAgentChat ? 8 : 30;
  const allTurns = getTurns(chatId);
  const turns = allTurns.slice(-maxTurns);
  if (turns.length > 0) {
    parts.push(`\n[CONVERSATION HISTORY]${allTurns.length > maxTurns ? ` (last ${maxTurns} of ${allTurns.length})` : ""}`);
    for (const t of turns) {
      const label = t.role === "user" ? "User" : "Assistant";
      parts.push(`${label}: ${t.content}`);
    }
  }

  // Recent voice conversation (cross-channel memory — chatId 5)
  if (chatId !== 5) {
    const voiceTurns = getTurns(5);
    const recentVoice = voiceTurns.slice(-10);
    if (recentVoice.length > 0) {
      parts.push("\n[RECENT VOICE CONVERSATION]");
      for (const t of recentVoice) {
        const label = t.role === "user" ? "Nicolas (voice)" : "Kingston";
        parts.push(`${label}: ${(t.content || "").slice(0, 200)}`);
      }
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

  log.debug(`Claude prompt length: ${prompt.length} (resume: ${isResume})`);

  return new Promise<ParsedResult>((resolve) => {
    const model = modelOverride || config.claudeModel;
    const args = [
      "-p", "-", "--output-format", "json", "--model", model,
      "--dangerously-skip-permissions",
      "--append-system-prompt", "CRITICAL IDENTITY OVERRIDE: You are Kingston, an autonomous AI assistant on the Bastilon platform. You are NOT Émile, NOT Claude Code CLI, NOT a generic assistant. Your name is Kingston. You operate through Telegram, not a terminal. Respond in French to the user Nicolas. You have FULL access to 400+ tools via Bastilon — call them with {\"type\":\"tool_call\",\"tool\":\"namespace.method\",\"args\":{}}. NEVER say you don't have access to tools or that you're in a separate environment. APRÈS CHAQUE tool_call, tu DOIS envoyer un message texte final résumant le résultat. JAMAIS terminer sans message lisible pour Nicolas. Si une tâche a plusieurs étapes, exécute-les TOUTES.",
    ];

    if (isResume) {
      args.push("--resume", existingSession);
      log.debug(`Resuming session: ${existingSession}`);
    }

    log.debug(`Spawning: ${config.claudeBin} ${args.join(" ")}`);

    // Strip ANTHROPIC_API_KEY so the CLI uses the Max plan, not the paid API
    // Strip CLAUDECODE and CLAUDE_CODE_* to prevent nested session issues
    const cliEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (k === "ANTHROPIC_API_KEY" || k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE")) continue;
      if (v !== undefined) cliEnv[k] = v;
    }
    const proc = spawn(config.claudeBin, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: cliEnv,
      shell: false,
      // Use a neutral cwd so the CLI won't load project-level memory files
      // (which define "Émile" identity for the interactive CLI sessions).
      // Kingston passes its own system prompt with full context via stdin.
      cwd: os.tmpdir(),
      windowsHide: true,
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
