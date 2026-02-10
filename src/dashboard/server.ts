/**
 * Kingston Dashboard — Local web UI for monitoring agents, chatting, and system health.
 * Serves on localhost:3200 (configurable via DASHBOARD_PORT).
 * No external dependencies — uses Node http + existing ws.
 */
import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { getDb, clearSession, clearTurns } from "../storage/store.js";
import { handleMessage } from "../orchestrator/router.js";
import { config, reloadEnv } from "../config/env.js";
import { log, getRecentLogs, setLogBroadcast } from "../utils/log.js";
import { listAgents } from "../agents/registry.js";
import { isRateLimited, getRateLimitReset } from "../agents/base.js";
import { addClient, broadcast, getClientCount } from "./broadcast.js";
import { getAllSkills } from "../skills/loader.js";
import { getMemoryStats } from "../memory/semantic.js";
import { describeImageBuffer } from "../llm/vision.js";
import { GeminiLiveSession, type LiveCallbacks } from "../llm/geminiLive.js";
import {
  getAllPatterns,
  evaluateEffectiveness,
  getErrorTrends as getPatternTrends,
} from "../memory/self-review.js";

const PORT = Number(process.env.DASHBOARD_PORT) || 3200;

// Resolve static dir relative to this file (works on Windows with tsx)
function resolveStaticDir(): string {
  try {
    const fileUrl = new URL(import.meta.url);
    // fileURLToPath handles Windows correctly
    const dir = path.dirname(fileUrl.pathname.replace(/^\/([A-Z]:)/i, "$1"));
    return path.resolve(dir, "public");
  } catch {
    // Fallback: resolve from cwd
    return path.resolve(process.cwd(), "src", "dashboard", "public");
  }
}
const STATIC_DIR = resolveStaticDir();

// ── MIME types ──────────────────────────────────────────────
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

// ── Auth ────────────────────────────────────────────────────
/** Check DASHBOARD_TOKEN on mutating API endpoints. Returns true if OK. */
function checkAuth(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const token = config.dashboardToken;
  if (!token) return true; // no token configured = open (localhost-only anyway)
  const provided = req.headers["x-auth-token"] as string | undefined;
  const authHeader = req.headers["authorization"] as string | undefined;
  const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  const candidate = provided || bearer;
  if (candidate === token) return true;
  sendJson(res, 401, { ok: false, error: "Unauthorized - missing or invalid X-Auth-Token" });
  return false;
}

// ── Rate limiting ──────────────────────────────────────────
const rateLimitMap = new Map<string, { count: number; reset: number }>();
const RATE_LIMIT_MAX = 30; // requests per window
const RATE_LIMIT_WINDOW_MS = 60_000;

function checkRateLimit(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const ip = req.socket.remoteAddress || "unknown";
  const now = Date.now();
  let entry = rateLimitMap.get(ip);
  if (!entry || now > entry.reset) {
    entry = { count: 0, reset: now + RATE_LIMIT_WINDOW_MS };
    rateLimitMap.set(ip, entry);
  }
  entry.count++;
  if (entry.count > RATE_LIMIT_MAX) {
    sendJson(res, 429, { ok: false, error: "Rate limit exceeded — max 30 req/min" });
    return false;
  }
  return true;
}

// Helpers
function getCorsOrigin(): string {
  return process.env.DASHBOARD_CORS_ORIGIN || `http://localhost:${PORT}`;
}

function sendJson(res: http.ServerResponse, status: number, data: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": getCorsOrigin(),
  });
  res.end(JSON.stringify(data));
}

function json(res: http.ServerResponse, data: unknown, status = 200) {
  sendJson(res, status, data);
}

function serveFile(res: http.ServerResponse, filePath: string) {
  const ext = path.extname(filePath);
  const mime = MIME[ext] || "application/octet-stream";
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { "Content-Type": mime });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

async function parseBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        resolve({});
      }
    });
  });
}

// ── API Routes ──────────────────────────────────────────────

function apiAgents(): unknown {
  const agents = listAgents();
  const rateLimited = isRateLimited();
  return {
    rateLimited,
    rateLimitReset: rateLimited ? getRateLimitReset() : null,
    agents,
  };
}

function apiAgentRuns(agentId: string, limit = 50): unknown {
  const db = getDb();
  return db
    .prepare(
      `SELECT id, agent_id, cycle, started_at, duration_ms, outcome, error_msg
       FROM agent_runs WHERE agent_id = ? ORDER BY started_at DESC LIMIT ?`
    )
    .all(agentId, limit);
}

function apiStats(): unknown {
  const db = getDb();
  const uptimeMs = process.uptime() * 1000;
  const mem = process.memoryUsage();

  // Last 24h agent stats
  const cutoff24h = Math.floor(Date.now() / 1000) - 86400;
  const agentStats = db
    .prepare(
      `SELECT agent_id,
              COUNT(*) as total,
              SUM(CASE WHEN outcome='success' THEN 1 ELSE 0 END) as successes,
              SUM(CASE WHEN outcome='error' THEN 1 ELSE 0 END) as errors,
              SUM(CASE WHEN outcome='rate_limit' THEN 1 ELSE 0 END) as rate_limits,
              AVG(duration_ms) as avg_duration
       FROM agent_runs WHERE started_at > ? GROUP BY agent_id`
    )
    .all(cutoff24h);

  // Error count last 24h
  const errorCount = db
    .prepare(`SELECT COUNT(*) as count FROM error_log WHERE timestamp > ? AND resolved = 0`)
    .get(cutoff24h) as { count: number };

  // Notes count
  const noteCount = db.prepare(`SELECT COUNT(*) as count FROM notes`).get() as { count: number };

  return {
    uptime: uptimeMs,
    memory: {
      rss: Math.round(mem.rss / 1048576),
      heap: Math.round(mem.heapUsed / 1048576),
      heapTotal: Math.round(mem.heapTotal / 1048576),
    },
    agentStats,
    errorCount: errorCount.count,
    noteCount: noteCount.count,
    wsClients: getClientCount(),
    rateLimited: isRateLimited(),
  };
}

function apiErrors(limit = 20): unknown {
  const db = getDb();
  return db
    .prepare(
      `SELECT id, timestamp, error_message, context, resolved
       FROM error_log ORDER BY timestamp DESC LIMIT ?`
    )
    .all(limit);
}

function apiNotes(limit = 30): unknown {
  const db = getDb();
  return db
    .prepare(`SELECT id, text, created_at FROM notes ORDER BY created_at DESC LIMIT ?`)
    .all(limit);
}

function apiScheduler(): unknown {
  const db = getDb();
  const recent = db
    .prepare(
      `SELECT id, event_key, fired_at, result FROM scheduler_runs ORDER BY fired_at DESC LIMIT 20`
    )
    .all();
  const reminders = db
    .prepare(`SELECT id, label, fire_at, chat_id FROM scheduler_reminders ORDER BY fire_at ASC`)
    .all();
  return { recent, reminders };
}

function apiLearnedPatterns(): unknown {
  const db = getDb();
  try {
    return db
      .prepare(`SELECT * FROM learned_patterns ORDER BY rowid DESC LIMIT 30`)
      .all();
  } catch {
    return [];
  }
}

function apiLearningInsights(): unknown {
  const patterns = getAllPatterns();
  const effectiveness = evaluateEffectiveness();
  const trends = getPatternTrends(48);

  const graduated = patterns.filter((p) => p.graduated);
  const nearGraduation = patterns.filter((p) => !p.graduated && p.count >= 3);
  const totalErrors = patterns.reduce((sum, p) => sum + p.count, 0);

  return {
    summary: {
      totalPatterns: patterns.length,
      graduatedRules: graduated.length,
      nearGraduation: nearGraduation.length,
      totalErrorsTracked: totalErrors,
      effectiveRules: effectiveness.filter((e) => e.effective).length,
      ineffectiveRules: effectiveness.filter((e) => !e.effective).length,
    },
    patterns: patterns.sort((a, b) => b.count - a.count).slice(0, 30),
    effectiveness,
    trends,
  };
}

// ── New API Routes (dashboard redesign) ─────────────────────

function apiSkills(): unknown {
  const skills = getAllSkills();
  return skills.map(s => ({
    name: s.name,
    description: s.description,
    adminOnly: !!s.adminOnly,
    args: Object.entries(s.argsSchema.properties).map(([key, val]) => ({
      name: key,
      type: val.type,
      description: val.description || "",
      required: s.argsSchema.required?.includes(key) || false,
    })),
  }));
}

function apiMemoryStats(): unknown {
  try {
    return getMemoryStats();
  } catch {
    return { total: 0, byCategory: {}, avgSalience: 0 };
  }
}

function apiMemoryItems(limit = 50): unknown {
  const db = getDb();
  try {
    return db
      .prepare(`SELECT id, content, category, salience, access_count, created_at, last_accessed FROM memory_items ORDER BY salience DESC LIMIT ?`)
      .all(limit);
  } catch {
    return [];
  }
}

function apiConfig(): unknown {
  // Return sanitized config — mask secrets
  const secretKeys = new Set([
    "telegramToken", "geminiApiKey", "anthropicApiKey", "twilioAuthToken",
    "deepgramApiKey", "elevenlabsApiKey", "adminPassphrase", "braveSearchApiKey",
    "dashboardToken",
  ]);
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(config)) {
    if (secretKeys.has(key) && typeof val === "string" && val.length > 0) {
      result[key] = "****";
    } else {
      result[key] = val;
    }
  }
  return result;
}

function apiLogs(limit = 200): unknown {
  return getRecentLogs(limit);
}

function apiSessions(): unknown {
  const db = getDb();
  try {
    const sessions = db
      .prepare(`SELECT chat_id, COUNT(*) as turns FROM turns GROUP BY chat_id ORDER BY chat_id`)
      .all() as { chat_id: number; turns: number }[];
    return sessions.map(s => ({
      chatId: s.chat_id,
      turns: s.turns,
      label: s.chat_id === 1 ? "Scheduler" : s.chat_id === 2 ? "Dashboard Kingston" : s.chat_id === 3 ? "Dashboard Emile" :
        s.chat_id >= 100 && s.chat_id <= 103 ? `Agent ${s.chat_id - 100}` : `User ${s.chat_id}`,
    }));
  } catch {
    return [];
  }
}

function apiSystem(): unknown {
  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  return {
    platform: os.platform(),
    arch: os.arch(),
    hostname: os.hostname(),
    release: os.release(),
    uptime: os.uptime(),
    nodeVersion: process.version,
    cpu: {
      model: cpus[0]?.model || "unknown",
      cores: cpus.length,
    },
    memory: {
      total: Math.round(totalMem / 1048576),
      free: Math.round(freeMem / 1048576),
      used: Math.round((totalMem - freeMem) / 1048576),
      percent: Math.round(((totalMem - freeMem) / totalMem) * 100),
    },
    process: {
      pid: process.pid,
      uptime: Math.round(process.uptime()),
      memory: {
        rss: Math.round(process.memoryUsage().rss / 1048576),
        heap: Math.round(process.memoryUsage().heapUsed / 1048576),
      },
    },
  };
}

// ── Trading API ──
const ALPACA_PAPER = "https://paper-api.alpaca.markets";
function alpacaHeaders(): Record<string, string> {
  return {
    "APCA-API-KEY-ID": process.env.ALPACA_API_KEY || "",
    "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY || "",
  };
}

async function apiTrading(): Promise<unknown> {
  try {
    const headers = alpacaHeaders();
    if (!headers["APCA-API-KEY-ID"]) return { error: "ALPACA_API_KEY not configured" };

    const [acctRes, posRes, ordRes, clockRes] = await Promise.all([
      fetch(`${ALPACA_PAPER}/v2/account`, { headers }),
      fetch(`${ALPACA_PAPER}/v2/positions`, { headers }),
      fetch(`${ALPACA_PAPER}/v2/orders?status=all&limit=20`, { headers }),
      fetch(`${ALPACA_PAPER}/v2/clock`, { headers }),
    ]);

    const account = acctRes.ok ? await acctRes.json() : null;
    const positions = posRes.ok ? await posRes.json() : [];
    const orders = ordRes.ok ? await ordRes.json() : [];
    const clock = clockRes.ok ? await clockRes.json() : null;

    // Read watchlist
    let watchlist: unknown[] = [];
    const wlPath = path.resolve("relay", "watchlist.json");
    try { if (fs.existsSync(wlPath)) watchlist = JSON.parse(fs.readFileSync(wlPath, "utf-8")); } catch {}

    return { account, positions, orders, clock, watchlist };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

// Dashboard has its own chatIds — separate from Telegram sessions
const KINGSTON_DASHBOARD_ID = 2;
const EMILE_DASHBOARD_ID = 3;
type DashboardAgent = "kingston" | "emile";

function getDashboardUserId(): number {
  if (config.allowedUsers.length === 0) {
    log.warn("[dashboard] No TELEGRAM_ALLOWED_USERS configured — dashboard chat disabled");
    return 0;
  }
  return Number(config.allowedUsers[0]);
}

async function apiChatKingston(message: string): Promise<string> {
  const userId = getDashboardUserId();
  const prefix =
    `[DASHBOARD MODE — KINGSTON]\n` +
    `Tu es Kingston dans le Dashboard web local. Nicolas voit ta réponse ici — PAS telegram.send.\n` +
    `Tu as l'AUTONOMIE COMPLÈTE et l'approbation de Nicolas pour modifier le code.\n\n` +
    `## RÈGLE #1 : AGIS, NE PARLE PAS\n` +
    `- Si on te demande d'améliorer quelque chose → lis le code (files.read_anywhere), modifie-le (files.write_anywhere)\n` +
    `- Si on te pose une question sur le système → lis les fichiers, analyse, réponds avec des faits\n` +
    `- Ne dis JAMAIS "je pourrais faire X" — FAIS X directement\n\n` +
    `## OUTILS DISPONIBLES\n` +
    `- files.read_anywhere: lire n'importe quel fichier du projet\n` +
    `- files.write_anywhere: modifier n'importe quel fichier du projet\n` +
    `- shell.exec: exécuter des commandes shell\n` +
    `- code.run: exécuter du code TypeScript/JavaScript\n` +
    `- notes.add: persister des décisions/observations\n` +
    `- analytics.log: logger une action\n\n` +
    `## FORMAT DE RÉPONSE\n` +
    `Après chaque action, structure ta réponse :\n` +
    `**ANALYSE** : ce que tu as trouvé (1-2 lignes)\n` +
    `**ACTIONS** : ce que tu as fait (liste des fichiers modifiés)\n` +
    `**RÉSULTAT** : ce qui a changé concrètement\n` +
    `**SUITE** : prochaine étape suggérée\n\n` +
    `Source du projet : ${process.cwd()}\n\n`;
  return handleMessage(KINGSTON_DASHBOARD_ID, prefix + message, userId, "user");
}

async function apiChatEmile(message: string): Promise<string> {
  const userId = getDashboardUserId();
  const prefix =
    `[DASHBOARD MODE - EMILE]\n` +
    `Tu es Emile, architecte logiciel. Dashboard web local. PAS telegram.send.\n` +
    `Mode par defaut: conversation directe concise et utile.\n` +
    `Si Nicolas demande explicitement de coder/modifier, alors execute les actions sur le repo.\n` +
    `Sinon, reponds clairement sans lancer de workflow long.\n\n` +
    `Source du projet : ${process.cwd()}\n\n`;
  return handleMessage(EMILE_DASHBOARD_ID, prefix + message, userId, "user");
}
async function apiChat(agent: DashboardAgent, message: string): Promise<string> {
  return agent === "emile" ? apiChatEmile(message) : apiChatKingston(message);
}

function buildUltimatePrompt(payload: {
  goal: string;
  constraints?: string;
  context?: string;
  target?: DashboardAgent | "both";
}): string {
  const goal = (payload.goal || "").trim() || "Ameliorer le dashboard et livrer une implementation testable.";
  const constraints = (payload.constraints || "").trim() || "Conserver le style actuel, securiser les endpoints, et garder une UX simple.";
  const target = payload.target || "both";
  const context = (payload.context || "").trim();
  const contextBlock = context ? `\n## CONTEXTE RECENT\n${context}\n` : "";

  return [
    "[PROMPT ULTIME - DASHBOARD EXECUTION]",
    `CIBLE: ${target}`,
    "",
    "Tu agis comme lead engineer sur ce repo local.",
    "Objectif: implementer maintenant, avec modifications de fichiers concretes.",
    "",
    "## OBJECTIF",
    goal,
    "",
    "## CONTRAINTES",
    constraints,
    contextBlock.trimEnd(),
    "",
    "## EXIGENCES D'EXECUTION",
    "- Lire les fichiers pertinents avant toute proposition.",
    "- Modifier le code directement (pas de plan theorique sans action).",
    "- Valider avec au moins une commande de verification (build/test/lint).",
    "- Si bloque: expliquer precisement le blocage et proposer la correction immediate.",
    "",
    "## LIVRABLES ATTENDUS",
    "1. Liste des fichiers modifies.",
    "2. Resume exact des changements.",
    "3. Resultat des verifications executees.",
    "4. Prochaine etape concrete.",
    "",
    "## FORMAT DE REPONSE",
    "ANALYSE:",
    "ACTIONS:",
    "VALIDATION:",
    "SUITE:",
  ].filter(Boolean).join("\n");
}

// ── Request handler ─────────────────────────────────────────
async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);
  const pathname = url.pathname;
  const method = req.method || "GET";

  // CORS preflight
  if (method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": getCorsOrigin(),
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Auth-Token, Authorization",
    });
    res.end();
    return;
  }

  try {
    // ── API routes (all require auth when DASHBOARD_TOKEN is set) ──
    if (pathname === "/api/agents" && method === "GET") {
      if (!checkAuth(req, res)) return;
      return json(res, apiAgents());
    }
    if (pathname.startsWith("/api/agents/") && pathname.endsWith("/runs") && method === "GET") {
      if (!checkAuth(req, res)) return;
      const agentId = pathname.split("/")[3];
      return json(res, apiAgentRuns(agentId));
    }
    if (pathname === "/api/stats" && method === "GET") {
      if (!checkAuth(req, res)) return;
      return json(res, apiStats());
    }
    if (pathname === "/api/errors" && method === "GET") {
      if (!checkAuth(req, res)) return;
      return json(res, apiErrors());
    }
    if (pathname === "/api/notes" && method === "GET") {
      if (!checkAuth(req, res)) return;
      return json(res, apiNotes());
    }
    if (pathname === "/api/scheduler" && method === "GET") {
      if (!checkAuth(req, res)) return;
      return json(res, apiScheduler());
    }
    if (pathname === "/api/learned" && method === "GET") {
      if (!checkAuth(req, res)) return;
      return json(res, apiLearnedPatterns());
    }
    if (pathname === "/api/learning" && method === "GET") {
      if (!checkAuth(req, res)) return;
      return json(res, apiLearningInsights());
    }
    // ── New endpoints ──
    if (pathname === "/api/skills" && method === "GET") {
      if (!checkAuth(req, res)) return;
      return json(res, apiSkills());
    }
    if (pathname === "/api/memory/stats" && method === "GET") {
      if (!checkAuth(req, res)) return;
      return json(res, apiMemoryStats());
    }
    if (pathname === "/api/memory/items" && method === "GET") {
      if (!checkAuth(req, res)) return;
      return json(res, apiMemoryItems());
    }
    if (pathname === "/api/config" && method === "GET") {
      if (!checkAuth(req, res)) return;
      return json(res, apiConfig());
    }
    if (pathname === "/api/config" && method === "POST") {
      if (!checkAuth(req, res)) return;
      const body = await parseBody(req);
      // Write non-secret key-value pairs to .env
      const envPath = path.resolve(".env");
      const secretKeys = new Set([
        "TELEGRAM_BOT_TOKEN", "GEMINI_API_KEY", "ANTHROPIC_API_KEY", "TWILIO_AUTH_TOKEN",
        "DEEPGRAM_API_KEY", "ELEVENLABS_API_KEY", "ADMIN_PASSPHRASE", "BRAVE_SEARCH_API_KEY",
        "DASHBOARD_TOKEN", "FTP_PASSWORD",
      ]);
      const updates = body as Record<string, string>;
      // Block secret updates via dashboard
      for (const key of Object.keys(updates)) {
        if (secretKeys.has(key)) {
          return sendJson(res, 403, { ok: false, error: `Cannot update secret key: ${key}` });
        }
      }
      try {
        let envContent = fs.readFileSync(envPath, "utf-8");
        for (const [key, value] of Object.entries(updates)) {
          const regex = new RegExp(`^${key}=.*$`, "m");
          if (regex.test(envContent)) {
            envContent = envContent.replace(regex, `${key}=${value}`);
          } else {
            envContent += `\n${key}=${value}`;
          }
        }
        fs.writeFileSync(envPath, envContent);
        reloadEnv();
        return json(res, { ok: true, message: "Config updated and reloaded" });
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: (err as Error).message });
      }
    }
    if (pathname === "/api/logs" && method === "GET") {
      if (!checkAuth(req, res)) return;
      return json(res, apiLogs());
    }
    if (pathname === "/api/sessions" && method === "GET") {
      if (!checkAuth(req, res)) return;
      return json(res, apiSessions());
    }
    if (pathname === "/api/system" && method === "GET") {
      if (!checkAuth(req, res)) return;
      return json(res, apiSystem());
    }
    if (pathname === "/api/trading" && method === "GET") {
      if (!checkAuth(req, res)) return;
      return json(res, await apiTrading());
    }
    if (pathname === "/api/chat/reset" && method === "POST") {
      if (!checkAuth(req, res)) return;
      // Reset dashboard sessions for fresh starts
      clearSession(KINGSTON_DASHBOARD_ID);
      clearSession(EMILE_DASHBOARD_ID);
      clearTurns(KINGSTON_DASHBOARD_ID);
      clearTurns(EMILE_DASHBOARD_ID);
      log.info("[dashboard] Reset Kingston + Émile sessions");
      return json(res, { ok: true, message: "Sessions reset" });
    }
    if (pathname === "/api/chat/kingston" && method === "POST") {
      if (!checkAuth(req, res)) return;
      if (!checkRateLimit(req, res)) return;
      const body = await parseBody(req);
      const response = await apiChatKingston(body.message as string);
      return json(res, { ok: true, response });
    }
    if (pathname === "/api/chat/emile" && method === "POST") {
      if (!checkAuth(req, res)) return;
      if (!checkRateLimit(req, res)) return;
      const body = await parseBody(req);
      const response = await apiChatEmile(body.message as string);
      return json(res, { ok: true, response });
    }
    if (pathname === "/api/chat" && method === "POST") {
      if (!checkAuth(req, res)) return;
      if (!checkRateLimit(req, res)) return;
      const body = await parseBody(req);
      const message = String(body.message || "").trim();
      const rawAgent = String(body.agent || "kingston").toLowerCase();
      const agent: DashboardAgent = rawAgent === "emile" ? "emile" : "kingston";
      if (!message) return sendJson(res, 400, { ok: false, error: "message is required" });
      const response = await apiChat(agent, message);
      return json(res, { ok: true, response, agent });
    }
    if (pathname === "/api/chat/ultimate-prompt" && method === "POST") {
      if (!checkAuth(req, res)) return;
      const body = await parseBody(req);
      const prompt = buildUltimatePrompt({
        goal: String(body.goal || ""),
        constraints: body.constraints ? String(body.constraints) : undefined,
        context: body.context ? String(body.context) : undefined,
        target: body.target === "emile" || body.target === "kingston" || body.target === "both"
          ? body.target
          : "both",
      });
      return json(res, { ok: true, prompt });
    }
    // ── TTS proxy (ElevenLabs) — keeps API key server-side ──
    if (pathname === "/api/tts" && method === "POST") {
      if (!checkAuth(req, res)) return;
      const body = await parseBody(req);
      const text = String(body.text || "").trim();
      if (!text) return sendJson(res, 400, { ok: false, error: "text is required" });
      if (!config.elevenlabsApiKey) return sendJson(res, 503, { ok: false, error: "ElevenLabs not configured" });
      try {
        const voiceId = config.elevenlabsVoiceId || "onwK4e9ZLuTAKqWW03F9";
        const ttsResp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
          method: "POST",
          headers: {
            "xi-api-key": config.elevenlabsApiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            text,
            model_id: "eleven_multilingual_v2",
            voice_settings: { stability: 0.5, similarity_boost: 0.75 },
          }),
        });
        if (!ttsResp.ok) {
          const errText = await ttsResp.text();
          log.warn(`[tts] ElevenLabs error ${ttsResp.status}: ${errText.slice(0, 200)}`);
          return sendJson(res, 502, { ok: false, error: `ElevenLabs: ${ttsResp.status}` });
        }
        const audioBuffer = Buffer.from(await ttsResp.arrayBuffer());
        res.writeHead(200, {
          "Content-Type": "audio/mpeg",
          "Content-Length": audioBuffer.length,
          "Access-Control-Allow-Origin": getCorsOrigin(),
        });
        res.end(audioBuffer);
      } catch (err) {
        log.error(`[tts] Error: ${err instanceof Error ? err.message : String(err)}`);
        return sendJson(res, 500, { ok: false, error: "TTS failed" });
      }
      return;
    }

    // ── VisionClaw / OpenAI-compatible endpoint ──
    // Drop-in replacement for OpenClaw gateway — used by smart glasses, external apps, etc.
    // Format: POST /v1/chat/completions with OpenAI request body
    if (pathname === "/v1/chat/completions" && method === "POST") {
      if (!checkAuth(req, res)) return;
      if (!checkRateLimit(req, res)) return;
      const body = await parseBody(req);
      const messages = body.messages as Array<{ role: string; content: string }> | undefined;
      if (!messages || !messages.length) {
        return sendJson(res, 400, { error: { message: "messages array is required", type: "invalid_request_error" } });
      }
      // Extract the last user message (standard OpenAI pattern)
      const lastUserMsg = [...messages].reverse().find(m => m.role === "user");
      const userMessage = lastUserMsg?.content?.trim();
      if (!userMessage) {
        return sendJson(res, 400, { error: { message: "No user message found", type: "invalid_request_error" } });
      }

      // Optional: image field (data URL from webcam) → analyze with Gemini vision
      let visionContext = "";
      const imageDataUrl = body.image as string | undefined;
      if (imageDataUrl && imageDataUrl.startsWith("data:image/")) {
        const match = imageDataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
        if (match) {
          const [, mimeType, base64Data] = match;
          visionContext = await describeImageBuffer(base64Data, mimeType, userMessage);
          if (visionContext) {
            log.info(`[voice] Vision context: ${visionContext.slice(0, 80)}...`);
          }
        }
      }

      // Optional: custom chat_id (default 4 for VisionClaw, 5 for Voice)
      const chatId = Number(body.chat_id) || 4;
      const userId = getDashboardUserId();

      // Build the final message with optional vision context
      const finalMessage = visionContext
        ? `[Contexte visuel — webcam: ${visionContext}]\n\n${userMessage}`
        : userMessage;

      log.info(`[visionclaw] POST /v1/chat/completions (chat=${chatId}): ${userMessage.slice(0, 100)}...`);
      try {
        const response = await handleMessage(chatId, finalMessage, userId, "user");
        return sendJson(res, 200, {
          id: `chatcmpl-${Date.now()}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: body.model || "bastilon",
          choices: [{
            index: 0,
            message: { role: "assistant", content: response },
            finish_reason: "stop",
          }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.error(`[visionclaw] Error: ${errMsg}`);
        return sendJson(res, 500, { error: { message: errMsg, type: "server_error" } });
      }
    }

    if (pathname.startsWith("/api/") || pathname.startsWith("/v1/")) {
      return sendJson(res, 404, { ok: false, error: "Not found" });
    }

    // ── Static files ──
    const resolved = path.resolve(STATIC_DIR, (pathname === "/" ? "index.html" : pathname).replace(/^\//, ""));
    // Prevent path traversal (resolve normalizes ../ sequences)
    if (!resolved.startsWith(STATIC_DIR)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    serveFile(res, resolved);
  } catch (err) {
    log.error("[dashboard] Request error:", err);
    sendJson(res, 500, { ok: false, error: (err as Error).message });
  }
}

// ── Start server ────────────────────────────────────────────
export function startDashboard(): void {
  // Wire log broadcast to push live logs via WebSocket
  setLogBroadcast(broadcast);

  const server = http.createServer(handleRequest);

  // Handle port conflicts gracefully (noServer prevents WSS from re-throwing)
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      log.error(`[dashboard] Port ${PORT} already in use — dashboard not started`);
    } else {
      log.error("[dashboard] Server error:", err);
    }
  });

  // WebSocket: use noServer to prevent EADDRINUSE propagation
  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", (ws) => {
    addClient(ws);
    log.debug(`[dashboard] WS client connected (${getClientCount()} total)`);
    ws.send(JSON.stringify({ event: "init", data: apiAgents(), ts: Date.now() }));
  });

  // Voice WebSocket server (Gemini Live proxy)
  const voiceWss = new WebSocketServer({ noServer: true });
  voiceWss.on("connection", (ws) => {
    // Auth check: first message must be { type: "auth", token: "..." }
    let authenticated = false;
    let liveSession: GeminiLiveSession | null = null;

    const authTimeout = setTimeout(() => {
      if (!authenticated) {
        ws.send(JSON.stringify({ type: "error", message: "Auth timeout" }));
        ws.close();
      }
    }, 5000);

    ws.on("message", (raw) => {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      // --- Auth handshake ---
      if (!authenticated) {
        if (msg.type === "auth") {
          const token = config.dashboardToken;
          if (token && msg.token !== token) {
            ws.send(JSON.stringify({ type: "error", message: "Invalid token" }));
            ws.close();
            return;
          }
          authenticated = true;
          clearTimeout(authTimeout);

          // Create Gemini Live session
          const VOICE_CHAT_ID = 5;
          const userId = getDashboardUserId();
          const callbacks: LiveCallbacks = {
            onAudio(data) { trySend({ type: "audio", data }); },
            onText(text, role) { trySend({ type: "transcript", text, role }); },
            onInterrupted() { trySend({ type: "interrupted" }); },
            onTurnComplete() { trySend({ type: "turn_complete" }); },
            onToolCall(name, args) { trySend({ type: "tool", name, status: "calling", args }); },
            onToolResult(name, result) { trySend({ type: "tool", name, status: "done", result: result.slice(0, 500) }); },
            onReady() { trySend({ type: "ready" }); },
            onError(message) { trySend({ type: "error", message }); },
            onClose() {
              trySend({ type: "session_closed" });
              // Don't auto-reconnect here — GeminiLiveSession.reconnect() handles it
              // with proper retry limits. Only the 14-min timer triggers reconnect.
            },
          };

          liveSession = new GeminiLiveSession({
            chatId: VOICE_CHAT_ID,
            userId,
            isAdmin: true,
            callbacks,
            voiceName: msg.voice || "Enceladus",
            language: msg.language || "fr",
          });
          liveSession.connect();

          log.info(`[voice-ws] Client authenticated, starting Gemini Live session`);
          return;
        }
        return;
      }

      // --- Authenticated messages ---
      if (!liveSession) return;

      switch (msg.type) {
        case "audio":
          liveSession.sendAudio(msg.data);
          break;
        case "text":
          liveSession.sendText(msg.text);
          break;
        case "image":
          // Strip data URL prefix if present
          const b64 = (msg.data || "").replace(/^data:image\/\w+;base64,/, "");
          if (b64) liveSession.sendImage(b64);
          break;
      }
    });

    function trySend(obj: any) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(obj));
      }
    }

    ws.on("close", () => {
      clearTimeout(authTimeout);
      if (liveSession) {
        liveSession.close();
        liveSession = null;
      }
      log.info("[voice-ws] Client disconnected");
    });
  });

  server.on("upgrade", (req, socket, head) => {
    if (req.url === "/ws") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    } else if (req.url === "/ws/voice") {
      voiceWss.handleUpgrade(req, socket, head, (ws) => {
        voiceWss.emit("connection", ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  const bindHost = process.env.DASHBOARD_BIND || "127.0.0.1";
  server.listen(PORT, bindHost, () => {
    log.info(`[dashboard] UI available at http://${bindHost === "0.0.0.0" ? "localhost" : bindHost}:${PORT}${bindHost === "0.0.0.0" ? " (all interfaces)" : " (localhost only)"}`);
  });
}

// Re-export broadcast for use by other modules
export { broadcast } from "./broadcast.js";




