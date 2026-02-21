/**
 * Kingston Dashboard — Local web UI for monitoring agents, chatting, and system health.
 * Serves on localhost:3200 (configurable via DASHBOARD_PORT).
 * No external dependencies — uses Node http + existing ws.
 */
import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { WebSocketServer, WebSocket } from "ws";
import {
  getDb, clearSession, clearTurns, getTurns,
  dungeonListSessions, dungeonGetSession, dungeonGetCharacters, dungeonGetTurns, dungeonAddCharacter,
  kgUpsertEntity, kgAddRelation, kgGetEntity, kgGetRelations, kgTraverse,
  logEpisodicEvent, recallEvents,
  savedCharCreate, savedCharGet, savedCharList, savedCharUpdate, savedCharDelete,
} from "../storage/store.js";
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
import { registerHook, removeHooksByNamespace } from "../hooks/hooks.js";
import { getTodayUsage, getUsageTrend, getUsageSummary, PRICING_TABLE } from "../llm/tokenTracker.js";

const PORT = Number(process.env.DASHBOARD_PORT) || 3200;

// ── Cloudflare Tunnel for Mini App ─────────────────────────
let dashboardTunnelUrl: string | null = null;

/** Get the public Cloudflare tunnel URL for the dashboard (null if not active). */
export function getDashboardPublicUrl(): string | null {
  return dashboardTunnelUrl;
}

function startDashboardTunnel(): void {
  try {
    const proc = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${PORT}`], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      windowsHide: true,
    });

    const timeout = setTimeout(() => {
      if (!dashboardTunnelUrl) {
        log.warn("[dashboard-tunnel] Timeout waiting for cloudflared URL — Mini App will not be available");
        proc.kill();
      }
    }, 20_000);

    const handler = (data: Buffer) => {
      const line = data.toString();
      const match = line.match(/https?:\/\/[^\s]+\.trycloudflare\.com/);
      if (match && !dashboardTunnelUrl) {
        dashboardTunnelUrl = match[0];
        clearTimeout(timeout);
        log.info(`[dashboard-tunnel] Public URL: ${dashboardTunnelUrl}`);
      }
    };

    proc.stdout?.on("data", handler);
    proc.stderr?.on("data", handler);
    proc.on("error", (err) => {
      log.warn(`[dashboard-tunnel] cloudflared not available: ${err.message}. Install: winget install Cloudflare.cloudflared`);
      clearTimeout(timeout);
    });
    proc.on("exit", (code) => {
      if (code !== null && code !== 0) {
        log.warn(`[dashboard-tunnel] cloudflared exited with code ${code}`);
      }
      dashboardTunnelUrl = null;
    });

    // Don't keep the parent process alive for the tunnel
    proc.unref();
  } catch (err) {
    log.warn(`[dashboard-tunnel] Failed to start: ${(err as Error).message}`);
  }
}

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
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".mp3": "audio/mpeg",
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
  if (process.env.DASHBOARD_CORS_ORIGIN) return process.env.DASHBOARD_CORS_ORIGIN;
  // When tunnel is active, allow any origin (Mini App served via Telegram)
  if (dashboardTunnelUrl) return "*";
  return `http://localhost:${PORT}`;
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
      `SELECT event_key, last_run_at FROM scheduler_runs ORDER BY last_run_at DESC LIMIT 20`
    )
    .all();
  const reminders = db
    .prepare(`SELECT id, fire_at, message, fired FROM scheduler_reminders WHERE fired = 0 ORDER BY fire_at ASC`)
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
    const agentNames: Record<number, string> = {
      100: "Scout", 101: "Analyst", 102: "Learner", 103: "Executor",
      104: "Trading-Monitor", 105: "Sentinel", 106: "Mind",
    };
    return sessions.map(s => ({
      chatId: s.chat_id,
      turns: s.turns,
      label: s.chat_id === 1 ? "Scheduler" : s.chat_id === 2 ? "Dashboard Kingston" : s.chat_id === 3 ? "Dashboard Emile" :
        agentNames[s.chat_id] ? `Agent: ${agentNames[s.chat_id]}` :
        s.chat_id >= 200 && s.chat_id <= 249 ? `Cron ${s.chat_id}` : `User ${s.chat_id}`,
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

    if (!acctRes.ok) {
      const errBody = await acctRes.text().catch(() => "");
      return { error: `Alpaca API error ${acctRes.status}: ${errBody.slice(0, 200)}` };
    }
    const account = await acctRes.json();
    const positions = posRes.ok ? await posRes.json() : [];
    const orders = ordRes.ok ? await ordRes.json() : [];
    const clock = clockRes.ok ? await clockRes.json() : null;

    // Read watchlist
    let watchlist: unknown[] = [];
    const wlPath = path.resolve("relay", "watchlist.json");
    try { if (fs.existsSync(wlPath)) watchlist = JSON.parse(fs.readFileSync(wlPath, "utf-8")); } catch (e) { log.warn(`[dashboard] Failed to load watchlist: ${e}`); }

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

// ── XP API ──

function apiXp(): unknown {
  const db = getDb();

  // Ensure table exists (no-op if already created by xp.ts)
  db.exec(`
    CREATE TABLE IF NOT EXISTS kingston_xp (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      points INTEGER NOT NULL,
      reason TEXT NOT NULL,
      source TEXT DEFAULT 'system',
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
  `);

  // Total XP
  const totalRow = db.prepare("SELECT COALESCE(SUM(points), 0) AS total FROM kingston_xp").get() as { total: number };
  const totalXp = totalRow.total;

  // Level calculation (mirrors src/skills/builtin/xp.ts)
  const LEVELS = [
    { threshold: 10001, name: "Architecte" },
    { threshold: 2501, name: "Autonome" },
    { threshold: 500, name: "Operateur" },
    { threshold: 0, name: "Apprenti" },
  ];

  let level = "Apprenti";
  for (const l of LEVELS) {
    if (totalXp >= l.threshold) { level = l.name; break; }
  }

  let nextLevel: { name: string; threshold: number; remaining: number } | null = null;
  for (let i = 0; i < LEVELS.length; i++) {
    if (totalXp >= LEVELS[i].threshold) {
      if (i > 0) {
        const next = LEVELS[i - 1];
        nextLevel = { name: next.name, threshold: next.threshold, remaining: next.threshold - totalXp };
      }
      break;
    }
  }
  // If below all thresholds, next is Apprenti -> Operateur
  if (nextLevel === null && totalXp < LEVELS[LEVELS.length - 1].threshold) {
    const next = LEVELS[LEVELS.length - 1];
    nextLevel = { name: next.name, threshold: next.threshold, remaining: next.threshold - totalXp };
  }

  // Today's XP
  const todayStart = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
  const todayRow = db.prepare("SELECT COALESCE(SUM(points), 0) AS total FROM kingston_xp WHERE created_at >= ?").get(todayStart) as { total: number };
  const todayXp = todayRow.total;

  // 7-day daily breakdown
  const daily = db.prepare(`
    SELECT date(created_at, 'unixepoch') AS day, SUM(points) AS total_points, COUNT(*) AS event_count
    FROM kingston_xp
    WHERE created_at >= strftime('%s', 'now', '-7 days')
    GROUP BY day ORDER BY day DESC
  `).all() as Array<{ day: string; total_points: number; event_count: number }>;

  // Leaderboard by event type
  const leaderboard = db.prepare(`
    SELECT event_type, SUM(points) AS total_points, COUNT(*) AS event_count
    FROM kingston_xp
    GROUP BY event_type
    ORDER BY total_points DESC
  `).all() as Array<{ event_type: string; total_points: number; event_count: number }>;

  // Recent history (last 20)
  const history = db.prepare(
    "SELECT id, event_type, points, reason, source, created_at FROM kingston_xp ORDER BY created_at DESC, id DESC LIMIT 20"
  ).all() as Array<{ id: number; event_type: string; points: number; reason: string; source: string; created_at: number }>;

  // Total event count
  const countRow = db.prepare("SELECT COUNT(*) AS count FROM kingston_xp").get() as { count: number };

  return {
    totalXp,
    level,
    nextLevel,
    todayXp,
    totalEvents: countRow.count,
    daily,
    leaderboard,
    history: history.map(h => ({
      ...h,
      created_at_iso: new Date(h.created_at * 1000).toISOString(),
    })),
    levels: LEVELS,
  };
}

// ── Engagement analytics (Phase 2B) ──

async function apiAnalyticsEngagement(): Promise<unknown> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const day24h = now - 86400;
  const day7d = now - 7 * 86400;

  // Trading P&L from Alpaca
  let trading: unknown = { error: "not configured" };
  try {
    const headers = alpacaHeaders();
    if (headers["APCA-API-KEY-ID"]) {
      const [acctRes, posRes] = await Promise.all([
        fetch(`${ALPACA_PAPER}/v2/account`, { headers }),
        fetch(`${ALPACA_PAPER}/v2/positions`, { headers }),
      ]);
      if (acctRes.ok) {
        const account = await acctRes.json() as Record<string, string>;
        const positions = posRes.ok ? await posRes.json() as Array<Record<string, string>> : [];
        const totalPnL = positions.reduce((sum: number, p: Record<string, string>) =>
          sum + Number(p.unrealized_pl || 0), 0);
        trading = {
          equity: Number(account.equity || 0),
          cash: Number(account.cash || 0),
          buyingPower: Number(account.buying_power || 0),
          totalPnL: Math.round(totalPnL * 100) / 100,
          totalPnLPct: positions.length > 0
            ? Math.round(positions.reduce((sum: number, p: Record<string, string>) =>
                sum + Number(p.unrealized_plpc || 0), 0) / positions.length * 10000) / 100
            : 0,
          positionCount: positions.length,
          positions: positions.map((p: Record<string, string>) => ({
            symbol: p.symbol,
            qty: Number(p.qty),
            pnl: Math.round(Number(p.unrealized_pl || 0) * 100) / 100,
            pnlPct: Math.round(Number(p.unrealized_plpc || 0) * 10000) / 100,
            currentPrice: Number(p.current_price || 0),
          })),
        };
      }
    }
  } catch (err) {
    trading = { error: (err as Error).message };
  }

  // Content metrics (Moltbook, social)
  let content: unknown = {};
  try {
    const total = db.prepare(`SELECT COUNT(*) as count FROM content_items`).get() as { count: number };
    const published = db.prepare(`SELECT COUNT(*) as count FROM content_items WHERE status = 'published'`).get() as { count: number };
    const drafts = db.prepare(`SELECT COUNT(*) as count FROM content_items WHERE status = 'draft'`).get() as { count: number };
    const recent7d = db.prepare(`SELECT COUNT(*) as count FROM content_items WHERE created_at > ?`).get(day7d) as { count: number };
    const byPlatform = db.prepare(
      `SELECT platform, COUNT(*) as count FROM content_items GROUP BY platform ORDER BY count DESC`
    ).all() as Array<{ platform: string; count: number }>;
    content = { total: total.count, published: published.count, drafts: drafts.count, last7d: recent7d.count, byPlatform };
  } catch { content = { total: 0 }; }

  // Lead pipeline (clients)
  let pipeline: unknown = {};
  try {
    const byStatus = db.prepare(
      `SELECT status, COUNT(*) as count FROM clients GROUP BY status ORDER BY count DESC`
    ).all() as Array<{ status: string; count: number }>;
    const totalClients = db.prepare(`SELECT COUNT(*) as count FROM clients`).get() as { count: number };
    const recentContacts = db.prepare(
      `SELECT name, status, last_contact_at FROM clients WHERE last_contact_at > ? ORDER BY last_contact_at DESC LIMIT 5`
    ).all(day7d);
    pipeline = { total: totalClients.count, byStatus, recentContacts };
  } catch { pipeline = { total: 0 }; }

  // Revenue
  let revenue: unknown = {};
  try {
    const totalIncome = db.prepare(
      `SELECT COALESCE(SUM(amount), 0) as total FROM revenue WHERE type = 'income'`
    ).get() as { total: number };
    const totalExpenses = db.prepare(
      `SELECT COALESCE(SUM(amount), 0) as total FROM revenue WHERE type = 'expense'`
    ).get() as { total: number };
    const recent = db.prepare(
      `SELECT source, amount, type, currency, description, created_at FROM revenue ORDER BY created_at DESC LIMIT 10`
    ).all();
    revenue = { totalIncome: totalIncome.total, totalExpenses: totalExpenses.total, net: totalIncome.total - totalExpenses.total, recent };
  } catch { revenue = { totalIncome: 0, totalExpenses: 0, net: 0 }; }

  // Token usage (last 7 days)
  let tokenUsage: unknown = {};
  try {
    const usage = db.prepare(
      `SELECT provider, SUM(input_tokens) as input_tokens, SUM(output_tokens) as output_tokens,
              SUM(requests) as requests, SUM(estimated_cost_usd) as cost
       FROM token_usage WHERE date >= date('now', '-7 days') GROUP BY provider`
    ).all();
    tokenUsage = usage;
  } catch { tokenUsage = []; }

  // Agent performance (last 24h)
  let agentPerformance: unknown = {};
  try {
    agentPerformance = db.prepare(
      `SELECT agent_id, COUNT(*) as runs,
              SUM(CASE WHEN outcome='success' THEN 1 ELSE 0 END) as successes,
              SUM(CASE WHEN outcome='error' THEN 1 ELSE 0 END) as errors,
              ROUND(AVG(duration_ms)) as avg_duration_ms
       FROM agent_runs WHERE started_at > ? GROUP BY agent_id`
    ).all(day24h);
  } catch { agentPerformance = []; }

  // Autonomous decisions (last 24h)
  let decisions: unknown = {};
  try {
    const count = db.prepare(`SELECT COUNT(*) as count FROM autonomous_decisions WHERE created_at > ?`).get(day24h) as { count: number };
    const byCategory = db.prepare(
      `SELECT category, COUNT(*) as count FROM autonomous_decisions WHERE created_at > ? GROUP BY category`
    ).all(day24h);
    decisions = { last24h: count.count, byCategory };
  } catch { decisions = { last24h: 0 }; }

  return {
    timestamp: new Date().toISOString(),
    trading,
    content,
    pipeline,
    revenue,
    tokenUsage,
    agentPerformance,
    decisions,
  };
}

// ── Request handler ─────────────────────────────────────────
async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);
  const pathname = url.pathname;
  const searchParams = url.searchParams;
  const method = req.method || "GET";

  // CORS preflight
  if (method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": getCorsOrigin(),
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Auth-Token, Authorization",
    });
    res.end();
    return;
  }

  try {
    // ── API routes (all require auth when DASHBOARD_TOKEN is set) ──
    // ── Mini App URL (no auth — needed by bot to build inline buttons) ──
    if (pathname === "/api/webapp/url" && method === "GET") {
      return json(res, { url: dashboardTunnelUrl ? dashboardTunnelUrl + "/webapp.html" : null });
    }
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
    // ── LLM Token Usage ─────────────────────────────────────
    if (pathname === "/api/llm-usage/today" && method === "GET") {
      if (!checkAuth(req, res)) return;
      return json(res, getTodayUsage());
    }
    if (pathname === "/api/llm-usage/trend" && method === "GET") {
      if (!checkAuth(req, res)) return;
      const days = Math.min(Number(url.searchParams.get("days")) || 7, 30);
      return json(res, { trend: getUsageTrend(days), pricing: PRICING_TABLE });
    }
    if (pathname === "/api/llm-usage/summary" && method === "GET") {
      if (!checkAuth(req, res)) return;
      const days = Math.min(Number(url.searchParams.get("days")) || 7, 30);
      return json(res, getUsageSummary(days));
    }

    if (pathname === "/api/errors" && method === "GET") {
      if (!checkAuth(req, res)) return;
      return json(res, apiErrors());
    }
    if (pathname === "/api/notes" && method === "GET") {
      if (!checkAuth(req, res)) return;
      const notesLimit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 30, 1), 200);
      return json(res, apiNotes(notesLimit));
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
    // ── Direct skill execution endpoint ──
    if (pathname === "/api/skill/execute" && method === "POST") {
      if (!checkAuth(req, res)) return;
      const body = await parseBody(req) as Record<string, unknown>;
      const skillName = body?.skill as string;
      const skillArgs = (body?.args || {}) as Record<string, unknown>;
      if (!skillName) return sendJson(res, 400, { error: "Missing 'skill' field" });
      const { getSkill } = await import("../skills/loader.js");
      const skill = getSkill(skillName);
      if (!skill) return sendJson(res, 404, { error: `Skill not found: ${skillName}` });
      try {
        const result = await skill.execute(skillArgs);
        return json(res, { ok: true, skill: skillName, result });
      } catch (err) {
        return sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    }
    // ── Webhook trigger endpoint ──
    if (pathname.startsWith("/api/webhook/") && method === "POST") {
      const webhookId = pathname.slice("/api/webhook/".length);
      const body = await parseBody(req);
      try {
        const { handleWebhookTrigger } = await import("../workflows/engine.js");
        const run = await handleWebhookTrigger(webhookId, (body as Record<string, unknown>) || {});
        if (!run) return sendJson(res, 404, { error: `No workflow registered for webhook: ${webhookId}` });
        return json(res, { ok: true, run_id: run.id, status: run.status });
      } catch (err) {
        return sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    }
    // ── Workflow callback endpoint ──
    if (pathname.startsWith("/api/callback/") && method === "POST") {
      const runId = pathname.slice("/api/callback/".length);
      const body = await parseBody(req);
      try {
        const { triggerCallback } = await import("../workflows/engine.js");
        const triggered = triggerCallback(runId, (body as Record<string, unknown>) || {});
        if (!triggered) return sendJson(res, 404, { error: `No pending callback for run: ${runId}` });
        return json(res, { ok: true });
      } catch (err) {
        return sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
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
    if (pathname === "/api/analytics/engagement" && method === "GET") {
      if (!checkAuth(req, res)) return;
      return json(res, await apiAnalyticsEngagement());
    }
    if (pathname === "/api/xp" && method === "GET") {
      if (!checkAuth(req, res)) return;
      return json(res, apiXp());
    }
    // ── Dungeon Master API ──
    if (pathname === "/api/dungeon/sessions" && method === "GET") {
      if (!checkAuth(req, res)) return;
      const sessions = dungeonListSessions();
      return json(res, { sessions });
    }
    if (pathname.startsWith("/api/dungeon/session/") && method === "GET") {
      if (!checkAuth(req, res)) return;
      const id = Number(pathname.split("/").pop());
      const session = dungeonGetSession(id);
      if (!session) return sendJson(res, 404, { error: "Session not found" });
      const characters = dungeonGetCharacters(id);
      const turns = dungeonGetTurns(id, 50);
      return json(res, { session, characters, turns });
    }
    if (pathname === "/api/dungeon/create" && method === "POST") {
      if (!checkAuth(req, res)) return;
      const body = await parseBody(req);
      try {
        const { getSkill } = await import("../skills/loader.js");
        const skill = getSkill("dungeon.start");
        if (!skill) return sendJson(res, 500, { error: "dungeon.start skill not loaded" });
        const args: Record<string, any> = {
          name: body.name || "Aventure",
          setting: body.setting || "Heroic Fantasy",
          characters: body.characters || "Aventurier/Humain/Guerrier",
          ruleset: body.ruleset || "dnd5e",
          coop: body.coop || false,
          kingston_char: body.kingston_char || "",
        };
        // Multi-AI players support
        if (body.ai_players) {
          args.ai_players = typeof body.ai_players === "string"
            ? body.ai_players
            : JSON.stringify(body.ai_players);
        }
        // Shadowrun-specific options
        if (body.shadowrun_options) {
          args.shadowrun_options = typeof body.shadowrun_options === "string"
            ? body.shadowrun_options
            : JSON.stringify(body.shadowrun_options);
        }
        const result = await skill.execute(args);
        // Find the created session
        const sessions = dungeonListSessions();
        const latest = sessions[0];
        // Inject roster characters into session if roster_ids provided
        const rosterIds: number[] = Array.isArray(body.roster_ids) ? body.roster_ids : [];
        if (rosterIds.length > 0 && latest) {
          for (const rid of rosterIds) {
            const saved = savedCharGet(rid);
            if (!saved) continue;
            dungeonAddCharacter(latest.id, {
              name: saved.name,
              race: saved.race,
              class: saved.class,
              level: saved.level || 1,
              hp: saved.hp,
              hp_max: saved.hp_max,
              stats: saved.stats || {},
              inventory: saved.inventory || [],
              is_ai: Boolean(saved.is_ai),
              description: saved.backstory || undefined,
              saved_id: saved.id,
            });
          }
        }
        return json(res, { ok: true, result, session: latest });
      } catch (err) {
        return sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (pathname.startsWith("/api/dungeon/session/") && method === "DELETE") {
      if (!checkAuth(req, res)) return;
      const id = Number(pathname.split("/").pop());
      try {
        const { dungeonDeleteSession: delSession } = await import("../storage/store.js");
        delSession(id);
        return json(res, { ok: true });
      } catch (err) {
        return sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (pathname === "/api/dungeon/play" && method === "POST") {
      if (!checkAuth(req, res)) return;
      const body = await parseBody(req);
      const sessionId = Number(body.session_id);
      const action = String(body.action || "").trim();
      if (!sessionId || !action) return sendJson(res, 400, { error: "session_id and action required" });
      try {
        const { getSkill } = await import("../skills/loader.js");
        const skill = getSkill("dungeon.play");
        if (!skill) return sendJson(res, 500, { error: "dungeon.play skill not loaded" });
        const result = await skill.execute({ session_id: sessionId, action });
        const session = dungeonGetSession(sessionId);
        const characters = dungeonGetCharacters(sessionId);
        const turns = dungeonGetTurns(sessionId, 10);
        return json(res, { narrative: result, session, characters, turns, lastTurn: turns[turns.length - 1] || null });
      } catch (err) {
        return sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (pathname === "/api/dungeon/roll" && method === "POST") {
      if (!checkAuth(req, res)) return;
      const body = await parseBody(req);
      try {
        const { getSkill } = await import("../skills/loader.js");
        const skill = getSkill("dungeon.roll");
        if (!skill) return sendJson(res, 500, { error: "dungeon.roll skill not loaded" });
        const result = await skill.execute({ dice: body.dice, purpose: body.purpose });
        return json(res, { result });
      } catch (err) {
        return sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (pathname === "/api/dungeon/scene" && method === "POST") {
      if (!checkAuth(req, res)) return;
      const body = await parseBody(req);
      try {
        const { getSkill } = await import("../skills/loader.js");
        const skill = getSkill("dungeon.scene");
        if (!skill) return sendJson(res, 500, { error: "dungeon.scene skill not loaded" });
        const result = await skill.execute({ session_id: body.session_id, description: body.description });
        return json(res, { result });
      } catch (err) {
        return sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    }
    // ── DM Memory endpoints ──────────────────────────────────────
    if (pathname === "/api/dm/log-memory" && method === "POST") {
      if (!checkAuth(req, res)) return;
      const body = await parseBody(req);
      const characterName = String(body.characterName || "").trim();
      const sessionId = Number(body.sessionId) || 0;
      const sessionName = String(body.sessionName || "");
      const action = String(body.action || "").trim();
      const narrative = String(body.narrative || "").trim();
      const eventType = String(body.eventType || "exploration");
      const npcsInvolved = Array.isArray(body.npcsInvolved) ? body.npcsInvolved as string[] : [];

      if (!characterName || !action) return sendJson(res, 400, { error: "characterName and action required" });

      try {
        // Sentiment heuristic
        const lower = (narrative + " " + action).toLowerCase();
        const negWords = ["mort", "piege", "blesse", "echec", "glitch", "critique", "poison", "trahison", "embuscade"];
        const posWords = ["victoire", "tresor", "allie", "succes", "reussi", "guerison", "sauve", "recompense"];
        let valence = 0;
        for (const w of negWords) if (lower.includes(w)) valence -= 0.3;
        for (const w of posWords) if (lower.includes(w)) valence += 0.3;
        valence = Math.max(-1, Math.min(1, valence));

        const importanceMap: Record<string, number> = { combat: 0.8, dialogue: 0.6, matrix: 0.7, puzzle: 0.7, shop: 0.5, rest: 0.3, exploration: 0.4 };
        const importance = importanceMap[eventType] || 0.4;

        // KG: upsert character
        const charId = kgUpsertEntity(characterName, "dungeon_character", {
          lastAction: action.slice(0, 100),
          sessionId,
          sessionName,
        });

        // KG: NPC relations
        for (const npc of npcsInvolved) {
          const npcId = kgUpsertEntity(npc, "dungeon_npc", { sessionId, discoveredBy: characterName });
          kgAddRelation(charId, npcId, "interacted_with", 1.0, { eventType });
        }

        // Episodic log
        logEpisodicEvent("dungeon_ai_action", `[${sessionName}] ${characterName}: ${action.slice(0, 80)}`, {
          importance,
          emotionalValence: valence,
          details: narrative.slice(0, 200),
          participants: [characterName, ...npcsInvolved],
          source: "dungeon",
        });

        return json(res, { ok: true, charId, npcsLogged: npcsInvolved.length });
      } catch (err) {
        return sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (pathname === "/api/dm/recall" && method === "GET") {
      if (!checkAuth(req, res)) return;
      const character = url.searchParams.get("character") || "";
      if (!character) return sendJson(res, 400, { error: "character query param required" });
      const limit = Math.min(Number(url.searchParams.get("limit")) || 6, 15);

      try {
        // Episodic memories
        const events = recallEvents({ search: character, limit, minImportance: 0.3 });

        // KG entity + relations
        const entity = kgGetEntity(character, "dungeon_character");
        let relations: Array<{ other: string; type: string }> = [];
        let locations: string[] = [];
        if (entity) {
          const rels = kgGetRelations(entity.id);
          relations = rels.slice(0, 8).map(r => ({
            other: r.from_name === character ? r.to_name : r.from_name,
            type: r.relation_type,
          }));
          const connected = kgTraverse(entity.id, 1);
          locations = connected
            .filter(c => c.entity.entity_type === "dungeon_location")
            .slice(0, 5)
            .map(l => l.entity.name);
        }

        // Build text context for injection into Gemini prompt
        const parts: string[] = [];
        if (events.length > 0) {
          parts.push("Souvenirs recents:\n" + events.map(e => {
            const v = e.emotional_valence > 0.2 ? "(+)" : e.emotional_valence < -0.2 ? "(-)" : "";
            return `- ${e.summary.slice(0, 80)} ${v}`;
          }).join("\n"));
        }
        if (relations.length > 0) {
          parts.push("Relations:\n" + relations.map(r => `- ${r.other}: ${r.type}`).join("\n"));
        }
        if (locations.length > 0) {
          parts.push("Lieux visites: " + locations.join(", "));
        }
        const contextText = parts.length > 0 ? parts.join("\n") : "Premiere aventure — aucun souvenir.";

        return json(res, { events, relations, locations, contextText: contextText.slice(0, 600) });
      } catch (err) {
        return sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    // ── DM Narrate (LLM proxy for voice DM) ──────────────────────
    // Helper: build Gemini chat from request body
    async function buildGeminiDMChat(body: Record<string, unknown>) {
      const { GoogleGenerativeAI } = await import("@google/generative-ai");
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) throw new Error("GEMINI_API_KEY not configured");
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({
        model: "gemini-2.0-flash",
        generationConfig: { temperature: 0.7, maxOutputTokens: 2048 },
      });
      const msgs = (body.messages || []) as Array<{ role: string; content: string }>;
      let history = msgs.slice(0, -1).map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));
      while (history.length > 0 && history[0].role !== "user") {
        history.shift();
      }
      const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1].content : "";
      const sysText = (body.system as string) || "";
      const chat = model.startChat({
        systemInstruction: sysText ? { role: "user", parts: [{ text: sysText }] } : undefined,
        history: history.length > 0 ? history : undefined,
      });
      return { chat, lastMsg, msgCount: msgs.length, sysPreview: sysText.slice(0, 60) };
    }

    // Non-streaming (legacy, used by character creation + campaign gen)
    if (pathname === "/api/dm/narrate" && method === "POST") {
      if (!checkAuth(req, res)) return;
      const body = await parseBody(req);
      log.info("[dm] narrate request received");
      try {
        const { chat, lastMsg, msgCount, sysPreview } = await buildGeminiDMChat(body);
        log.info(`[dm] sending to Gemini: ${msgCount} msgs, system=${sysPreview}...`);
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Gemini timeout (30s)")), 30000)
        );
        const result = await Promise.race([chat.sendMessage(lastMsg), timeoutPromise]);
        const text = result.response.text();
        log.info(`[dm] Gemini response: ${text.length} chars`);
        return json(res, { response: text });
      } catch (err) {
        log.error(`[dm] narrate error: ${err instanceof Error ? err.message : String(err)}`);
        return sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    // Streaming narrate (SSE — used by playTurn for progressive text display)
    if (pathname === "/api/dm/narrate-stream" && method === "POST") {
      if (!checkAuth(req, res)) return;
      const body = await parseBody(req);
      log.info("[dm] narrate-stream request received");
      try {
        const { chat, lastMsg, msgCount, sysPreview } = await buildGeminiDMChat(body);
        log.info(`[dm] streaming to Gemini: ${msgCount} msgs, system=${sysPreview}...`);

        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "Access-Control-Allow-Origin": "*",
        });

        const streamResult = await chat.sendMessageStream(lastMsg);
        let fullText = "";
        for await (const chunk of streamResult.stream) {
          const text = chunk.text();
          if (text) {
            fullText += text;
            res.write(`data: ${JSON.stringify({ type: "delta", text })}\n\n`);
          }
        }
        res.write(`data: ${JSON.stringify({ type: "done", text: fullText })}\n\n`);
        log.info(`[dm] stream complete: ${fullText.length} chars`);
        res.end();
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.error(`[dm] narrate-stream error: ${errMsg}`);
        try {
          res.write(`data: ${JSON.stringify({ type: "error", error: errMsg })}\n\n`);
          res.end();
        } catch (e) { log.debug(`[dashboard] SSE write after close: ${e}`); }
      }
      return;
    }

    // ── DM Narrate via Claude (1M context, higher quality) ──────
    if (pathname === "/api/dm/narrate-claude" && method === "POST") {
      if (!checkAuth(req, res)) return;
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) return sendJson(res, 500, { error: "ANTHROPIC_API_KEY not configured" });
      const body = await parseBody(req);
      const sysText = (body.system as string) || "";
      const msgs = (body.messages || []) as Array<{ role: string; content: string }>;
      const model = (body.model as string) || "claude-sonnet-4-6";

      log.info(`[dm-claude] narrate request: ${msgs.length} msgs, model=${model}`);

      try {
        const anthropicBody = {
          model,
          max_tokens: 2048,
          system: sysText,
          messages: msgs.map(m => ({ role: m.role as "user" | "assistant", content: m.content })),
        };

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 45000);
        const resp = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "anthropic-beta": "interleaved-thinking-2025-05-14",
          },
          body: JSON.stringify(anthropicBody),
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (!resp.ok) {
          const errText = await resp.text();
          log.error(`[dm-claude] API error ${resp.status}: ${errText.slice(0, 200)}`);
          return sendJson(res, resp.status, { error: errText.slice(0, 200) });
        }

        const result = await resp.json() as { content: Array<{ type: string; text?: string }>; usage?: { input_tokens: number; output_tokens: number } };
        const text = result.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("") || "";
        log.info(`[dm-claude] response: ${text.length} chars, usage: ${JSON.stringify(result.usage || {})}`);

        // Log token usage
        if (result.usage) {
          const { logTokens } = await import("../llm/tokenTracker.js");
          logTokens("claude", result.usage.input_tokens, result.usage.output_tokens);
        }

        return json(res, { response: text, usage: result.usage });
      } catch (err) {
        log.error(`[dm-claude] error: ${err instanceof Error ? err.message : String(err)}`);
        return sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    // ── Push Notification Subscription ──────────────────────────
    if (pathname === "/api/push/subscribe" && method === "POST") {
      if (!checkAuth(req, res)) return;
      const body = await parseBody(req);
      // Store subscription in memory (persists until restart)
      (globalThis as any).__pushSubscription = body;
      log.info("[dashboard] Push subscription registered");
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === "/api/push/vapid-key" && method === "GET") {
      // Return VAPID public key for push subscription
      const vapidKey = process.env.VAPID_PUBLIC_KEY || "";
      return sendJson(res, 200, { key: vapidKey });
    }

    // ── DM Image Generation (Gemini) ────────────────────────────
    if (pathname === "/api/dm/generate-image" && method === "POST") {
      if (!checkAuth(req, res)) return;
      const body = await parseBody(req);
      const prompt = String(body.prompt || "").trim();
      if (!prompt) return sendJson(res, 400, { error: "prompt required" });

      try {
        const GEMINI_IMAGE_MODEL = "gemini-2.5-flash-image";
        const apiKey = config.geminiApiKey;
        if (!apiKey) throw new Error("GEMINI_API_KEY not configured");

        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_IMAGE_MODEL}:generateContent?key=${apiKey}`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 60_000);

        const resp = await fetch(apiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              responseModalities: ["IMAGE", "TEXT"],
              temperature: 0.7,
              topP: 0.90,
              topK: 40,
            },
          }),
          signal: controller.signal,
        });
        clearTimeout(timer);

        if (!resp.ok) {
          const errBody = await resp.text().catch(() => "");
          throw new Error(`Gemini API ${resp.status}: ${errBody.slice(0, 300)}`);
        }

        const data = await resp.json() as any;
        if (data.error) throw new Error(`Gemini: ${data.error.message}`);

        const parts = data.candidates?.[0]?.content?.parts;
        const imagePart = parts?.find((p: any) => p.inlineData?.data);
        if (!imagePart?.inlineData) throw new Error("Gemini returned no image");

        const { uploadPath, uploadRelativePath } = await import("../utils/uploads.js");
        const ext = imagePart.inlineData.mimeType?.includes("png") ? "png" : "jpg";
        const filePath = uploadPath("scenes", "dm", ext);
        const buf = Buffer.from(imagePart.inlineData.data, "base64");
        fs.writeFileSync(filePath, buf);

        const relPath = uploadRelativePath(filePath);
        log.info(`[dm] Gemini image generated: ${path.basename(filePath)} → scenes/ (${buf.length} bytes)`);
        return json(res, { url: `/uploads/${relPath}` });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`[dm] generate-image error: ${msg}`);
        return sendJson(res, 500, { error: msg });
      }
    }

    // ── DM Campaigns CRUD (individual files) ────────────────────
    const DM_DIR = path.resolve(process.cwd(), "relay", "dm-campaigns");

    if (pathname === "/api/dm/campaigns" && method === "GET") {
      if (!checkAuth(req, res)) return;
      try {
        if (!fs.existsSync(DM_DIR)) return json(res, { campaigns: [] });
        const files = fs.readdirSync(DM_DIR).filter((f: string) => f.endsWith(".json"));
        const campaigns = files.map((f: string) => {
          try { return JSON.parse(fs.readFileSync(path.join(DM_DIR, f), "utf8")); }
          catch { return null; }
        }).filter(Boolean);
        return json(res, { campaigns });
      } catch { return json(res, { campaigns: [] }); }
    }
    if (pathname === "/api/dm/campaigns" && method === "POST") {
      if (!checkAuth(req, res)) return;
      const body = await parseBody(req);
      if (!body.id) return sendJson(res, 400, { error: "id required" });
      if (!fs.existsSync(DM_DIR)) fs.mkdirSync(DM_DIR, { recursive: true });
      const filePath = path.join(DM_DIR, `${body.id}.json`);
      if (!filePath.startsWith(DM_DIR)) return sendJson(res, 403, { error: "Invalid id" });
      fs.writeFileSync(filePath, JSON.stringify(body, null, 2));
      return json(res, { ok: true, file: `dm-campaigns/${body.id}.json` });
    }
    if (pathname.startsWith("/api/dm/campaign/") && method === "DELETE") {
      if (!checkAuth(req, res)) return;
      const id = pathname.split("/").pop();
      const filePath = path.join(DM_DIR, `${id}.json`);
      if (!filePath.startsWith(DM_DIR)) return sendJson(res, 403, { error: "Invalid id" });
      try { fs.unlinkSync(filePath); } catch (e) { log.debug(`[dashboard] Cleanup campaign file: ${e}`); }
      return json(res, { ok: true });
    }

    // D&D Session Log — generate and save a readable markdown transcript
    if (pathname === "/api/dm/session-log" && method === "POST") {
      if (!checkAuth(req, res)) return;
      const body = await parseBody(req);
      if (!body.id) return sendJson(res, 400, { error: "id required" });
      const LOG_DIR = path.resolve(process.cwd(), "relay", "dungeon-logs");
      if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

      const c = body as any; // campaign object
      const dateStr = new Date().toISOString().slice(0, 10);
      const safeName = (c.name || "session").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
      const logFile = path.join(LOG_DIR, `${dateStr}_${safeName}_${c.id.slice(0, 8)}.md`);
      if (!logFile.startsWith(LOG_DIR)) return sendJson(res, 403, { error: "Invalid" });

      // Build markdown
      let md = `# ${c.name || "Aventure"}\n\n`;
      md += `**Date**: ${dateStr}  \n`;
      md += `**Univers**: ${c.universe || "?"}  \n`;
      md += `**Ton**: ${c.tone || "?"}  \n`;
      md += `**Tours**: ${c.turnNumber || 0}  \n`;
      md += `**Lieu final**: ${c.location || "?"}  \n`;
      if (c.concluded) md += `**Statut**: Terminee  \n`;
      md += `\n---\n\n`;

      // Players
      md += `## Personnages\n\n`;
      for (const p of (c.players || [])) {
        const ch = p.character || {};
        md += `### ${ch.name || p.name} (Joueur: ${p.name})\n`;
        md += `- Race: ${ch.race || "?"}, Classe: ${ch.class || "?"}\n`;
        md += `- PV: ${ch.hp || "?"}/${ch.hpMax || "?"}\n`;
        if (ch.background) md += `- Historique: ${ch.background}\n`;
        if (ch.equipment) md += `- Equipement: ${ch.equipment}\n`;
        md += `\n`;
      }
      for (const ai of (c.aiPlayers || [])) {
        const ch = ai.character || {};
        md += `### ${ch.name || ai.name} (IA, ${ai.personality || "?"})\n`;
        md += `- Race: ${ch.race || "?"}, Classe: ${ch.class || "?"}\n`;
        md += `- PV: ${ch.hp || "?"}/${ch.hpMax || "?"}\n`;
        if (ch.background) md += `- Historique: ${ch.background}\n`;
        if (ch.equipment) md += `- Equipement: ${ch.equipment}\n`;
        md += `\n`;
      }

      // Arc
      if (c.arcOutline) {
        md += `## Arc Narratif\n\n${c.arcOutline}\n\n`;
      }

      // Turns
      md += `## Chronique\n\n`;
      for (const t of (c.turns || [])) {
        if (t.action) {
          const prefix = t.isPartyChat ? `**${t.player}** *(au groupe)*` : `**${t.player}**`;
          const action = t.isPartyChat ? t.action.replace(/^\[PARTY\]\s*/i, "") : t.action;
          md += `> ${prefix}: ${action}\n\n`;
        }
        if (t.narrative) {
          md += `*Tour ${t.turn}* — ${t.narrative}\n\n`;
        }
        if ((t.images || []).filter((u: string) => !u.startsWith("dimg-")).length) {
          md += `*[Images: ${t.images.filter((u: string) => !u.startsWith("dimg-")).join(", ")}]*\n\n`;
        }
        md += `---\n\n`;
      }

      // Quests
      if (c.quests?.length) {
        md += `## Quetes\n\n`;
        for (const q of c.quests) {
          md += `- **${q.name}** (${q.status}): ${q.detail || ""}\n`;
        }
        md += `\n`;
      }

      // NPCs
      if (c.npcs?.length) {
        md += `## PNJ\n\n`;
        for (const n of c.npcs) {
          md += `- **${n.name}**: ${n.description || ""} (${n.attitude || "?"})\n`;
        }
        md += `\n`;
      }

      fs.writeFileSync(logFile, md, "utf8");
      log.info(`[dungeon-log] Saved session log: ${logFile}`);
      return json(res, { ok: true, file: logFile, size: md.length });
    }

    // List existing session logs
    if (pathname === "/api/dm/session-logs" && method === "GET") {
      if (!checkAuth(req, res)) return;
      const LOG_DIR = path.resolve(process.cwd(), "relay", "dungeon-logs");
      if (!fs.existsSync(LOG_DIR)) return json(res, { logs: [] });
      const files = fs.readdirSync(LOG_DIR).filter((f: string) => f.endsWith(".md")).sort().reverse();
      return json(res, { logs: files.map((f: string) => ({ name: f, path: path.join(LOG_DIR, f) })) });
    }

    // ── Persistent Character Roster API ──

    if (pathname === "/api/dm/characters" && method === "GET") {
      if (!checkAuth(req, res)) return;
      const owner = searchParams.get("owner") || undefined;
      const gameSystem = searchParams.get("game_system") || undefined;
      const chars = savedCharList(owner, gameSystem);
      return json(res, { ok: true, characters: chars });
    }

    if (pathname === "/api/dm/characters" && method === "POST") {
      if (!checkAuth(req, res)) return;
      const body = await parseBody(req);
      if (!body.owner || !body.name) return sendJson(res, 400, { ok: false, error: "owner and name required" });
      const id = savedCharCreate({
        owner: String(body.owner),
        game_system: String(body.game_system || "dnd5e"),
        name: String(body.name),
        race: body.race ? String(body.race) : undefined,
        class: body.class ? String(body.class) : undefined,
        level: body.level ? Number(body.level) : undefined,
        xp: body.xp ? Number(body.xp) : undefined,
        hp: body.hp ? Number(body.hp) : undefined,
        hp_max: body.hp_max ? Number(body.hp_max) : undefined,
        ac: body.ac ? Number(body.ac) : undefined,
        stats: body.stats || undefined,
        inventory: body.inventory || undefined,
        backstory: body.backstory ? String(body.backstory) : undefined,
        traits: body.traits ? String(body.traits) : undefined,
        flaw: body.flaw ? String(body.flaw) : undefined,
        bond: body.bond ? String(body.bond) : undefined,
        ideal: body.ideal ? String(body.ideal) : undefined,
        proficiencies: body.proficiencies ? String(body.proficiencies) : undefined,
        equipment: body.equipment ? String(body.equipment) : undefined,
        portrait_url: body.portrait_url ? String(body.portrait_url) : undefined,
        personality: body.personality ? String(body.personality) : undefined,
        is_ai: !!body.is_ai,
        extra: body.extra || undefined,
      });
      const saved = savedCharGet(id);
      return json(res, { ok: true, character: saved });
    }

    if (pathname.startsWith("/api/dm/characters/") && method === "PUT") {
      if (!checkAuth(req, res)) return;
      const id = Number(pathname.split("/").pop());
      if (!id) return sendJson(res, 400, { ok: false, error: "invalid character id" });
      const body = await parseBody(req);
      savedCharUpdate(id, body);
      const updated = savedCharGet(id);
      return json(res, { ok: true, character: updated });
    }

    if (pathname.startsWith("/api/dm/characters/") && method === "DELETE") {
      if (!checkAuth(req, res)) return;
      const id = Number(pathname.split("/").pop());
      if (!id) return sendJson(res, 400, { ok: false, error: "invalid character id" });
      savedCharDelete(id);
      return json(res, { ok: true, deleted: id });
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
    // Fast voice endpoint — uses Groq/Ollama for conversational speed (~1-3s vs 10-30s for Claude CLI)
    if (pathname === "/api/chat/voice" && method === "POST") {
      if (!checkAuth(req, res)) return;
      if (!checkRateLimit(req, res)) return;
      const body = await parseBody(req);
      const message = String(body.message || "").trim();
      if (!message) return sendJson(res, 400, { ok: false, error: "message is required" });

      // Use Nicolas's REAL chatId so voice has full memory + conversation context
      const userId = getDashboardUserId();
      const voiceChatId = config.adminChatId || userId;
      try {
        const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
          Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);

        // Voice needs speed — try Ollama first (fast, local), fallback to handleMessage
        let response = "";
        const voicePrefix =
          "[VOICE MODE] Reponds en francais, concis (2-3 phrases max). " +
          "PAS de markdown, PAS de headers, PAS de **bold**, PAS de listes. " +
          "Texte naturel parlé seulement. Tu as accès à toute la mémoire de la journée.\n\n";

        try {
          // Ollama-chat with tools — fast (~2-5s) + has tool access for memory/notes
          const { runOllamaChat } = await import("../llm/ollamaClient.js");
          // Build a quick memory context to inject
          const { getSummary, getDb } = await import("../storage/store.js");
          let memoryHint = "";
          try {
            const summary = getSummary(voiceChatId);
            if (summary?.summary) memoryHint += "Résumé conversation récente: " + summary.summary + "\n";
            const db = getDb();
            const recentNotes = db.prepare(
              "SELECT content FROM notes ORDER BY id DESC LIMIT 5"
            ).all() as { content: string }[];
            if (recentNotes.length > 0) {
              memoryHint += "Notes récentes: " + recentNotes.map(n => n.content.slice(0, 100)).join(" | ") + "\n";
            }
          } catch (e) { log.debug(`[dashboard] Failed to load voice memory context: ${e}`); }

          response = await withTimeout(
            runOllamaChat({
              chatId: voiceChatId,
              userMessage: voicePrefix + memoryHint + message,
              isAdmin: true,
              userId,
            }),
            30_000
          );
          log.debug(`[voice] Ollama-chat responded: ${response.slice(0, 80)}...`);
        } catch (ollamaErr) {
          log.debug(`[voice] Ollama-chat failed: ${ollamaErr instanceof Error ? ollamaErr.message : ollamaErr}, falling back to handleMessage...`);
          // Fallback: handleMessage with model override to avoid Opus (too slow for voice)
          response = await withTimeout(
            handleMessage(voiceChatId, "[MODEL:sonnet] " + voicePrefix + message, userId, "user"),
            60_000
          );
        }

        return json(res, { ok: true, response: response || "Desole, je n'ai pas pu repondre." });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.error(`[voice] Error: ${errMsg}`);
        return sendJson(res, 500, { ok: false, error: errMsg });
      }
    }
    if (pathname === "/api/chat/kingston/stream" && method === "POST") {
      if (!checkAuth(req, res)) return;
      if (!checkRateLimit(req, res)) return;
      const body = await parseBody(req);
      const message = String(body.message || "").trim();
      if (!message) return sendJson(res, 400, { ok: false, error: "message is required" });

      // SSE headers
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": getCorsOrigin(),
      });

      const requestId = `sse-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const namespace = `sse-${requestId}`;

      // Register temporary hooks for tool progress
      registerHook("tool:before", async (_evt, ctx) => {
        if (ctx.chatId !== KINGSTON_DASHBOARD_ID) return;
        const toolName = String(ctx.tool || ctx.name || "");
        const args = ctx.args as Record<string, unknown> | undefined;
        const detail = String(args?.path || args?.query || args?.command || "").slice(0, 80);
        try {
          res.write(`event: progress\ndata: ${JSON.stringify({ tool: toolName, status: "running", detail })}\n\n`);
        } catch (e) { log.debug(`[dashboard] SSE progress write failed: ${e}`); }
      }, { namespace, priority: "low", description: "SSE progress for dashboard" });

      registerHook("tool:after", async (_evt, ctx) => {
        if (ctx.chatId !== KINGSTON_DASHBOARD_ID) return;
        const toolName = String(ctx.tool || ctx.name || "");
        try {
          res.write(`event: progress\ndata: ${JSON.stringify({ tool: toolName, status: "done" })}\n\n`);
        } catch (e) { log.debug(`[dashboard] SSE progress write failed: ${e}`); }
      }, { namespace, priority: "low", description: "SSE progress for dashboard" });

      try {
        const response = await apiChatKingston(message);
        res.write(`event: done\ndata: ${JSON.stringify({ response })}\n\n`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        res.write(`event: error\ndata: ${JSON.stringify({ error: errMsg })}\n\n`);
      } finally {
        removeHooksByNamespace(namespace);
        res.end();
      }
      return;
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
    // ── Wake Word browser state ──
    if (pathname === "/api/wakeword/state" && method === "POST") {
      const body = await parseBody(req);
      try {
        const { updateBrowserState } = await import("../voice/wakeword.js");
        updateBrowserState(!!body.active, body.wake_word as string | undefined);
      } catch (e) { log.debug(`[dashboard] Failed to update wakeword state: ${e}`); }
      return json(res, { ok: true });
    }

    // ── TTS: Warmup (pre-create WebSocket connection) ──
    if (pathname === "/api/tts/warmup" && method === "POST") {
      try {
        const { warmupTTS, resolveVoice } = await import("../voice/edgeTts.js");
        const body = await parseBody(req);
        const voice = resolveVoice((body as any)?.voice as string | undefined);
        await warmupTTS(voice);
        return json(res, { ok: true });
      } catch (err) {
        log.debug(`[tts-warmup] Error: ${err instanceof Error ? err.message : String(err)}`);
        return json(res, { ok: true }); // Non-critical, don't fail
      }
    }

    // ── TTS: Edge TTS (free, unlimited, default) ──
    if (pathname === "/api/tts/edge" && method === "POST") {
      if (!checkAuth(req, res)) return;
      const body = await parseBody(req);
      const text = String(body.text || "").trim();
      if (!text) return sendJson(res, 400, { ok: false, error: "text is required" });
      try {
        const { edgeTtsToMp3, resolveVoice } = await import("../voice/edgeTts.js");
        const voice = resolveVoice(body.voice as string | undefined);
        const mp3 = await edgeTtsToMp3(text.slice(0, 2000), voice);
        res.writeHead(200, {
          "Content-Type": "audio/mpeg",
          "Content-Length": mp3.length,
          "Access-Control-Allow-Origin": getCorsOrigin(),
        });
        res.end(mp3);
      } catch (err) {
        log.error(`[tts-edge] Error: ${err instanceof Error ? err.message : String(err)}`);
        return sendJson(res, 500, { ok: false, error: "Edge TTS failed" });
      }
      return;
    }
    // ── TTS: Edge TTS (free, unlimited) ──
    if (pathname === "/api/tts" && method === "POST") {
      if (!checkAuth(req, res)) return;
      const body = await parseBody(req);
      const text = String(body.text || "").trim();
      if (!text) return sendJson(res, 400, { ok: false, error: "text is required" });

      try {
        const { edgeTtsToMp3, resolveVoice } = await import("../voice/edgeTts.js");
        const voice = resolveVoice(body.voice as string | undefined);
        const mp3 = await edgeTtsToMp3(text.slice(0, 2000), voice);
        res.writeHead(200, {
          "Content-Type": "audio/mpeg",
          "Content-Length": mp3.length,
          "Access-Control-Allow-Origin": getCorsOrigin(),
        });
        res.end(mp3);
      } catch (err) {
        log.error(`[tts] Edge TTS error: ${err instanceof Error ? err.message : String(err)}`);
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

    // ── MCP SSE transport ──
    if (pathname.startsWith("/mcp/")) {
      const { handleMcpRequest } = await import("../gateway/mcp.js");
      if (handleMcpRequest(req, res)) return;
    }

    if (pathname === "/api/gallery" && method === "GET") {
      try {
        const { listUploads } = await import("../utils/uploads.js");
        const category = url.searchParams.get("category") as any;
        const files = listUploads(category || undefined);
        return sendJson(res, 200, { ok: true, files });
      } catch {
        return sendJson(res, 200, { ok: true, files: [] });
      }
    }

    // ── Bridge (bot-to-bot communication) ──
    if (pathname === "/api/bridge" && method === "POST") {
      const body = await parseBody(req);
      const from = (body?.from as string) || "";
      const text = (body?.text as string) || "";
      const chatId = (body?.chatId as string) || "";
      if (!from || !text || !chatId) {
        return sendJson(res, 400, { ok: false, error: "Missing from, text, or chatId" });
      }
      try {
        const { receiveBridgeMessage } = await import("../bridge/bridge.js");
        const isBridgeReply = !!(body?.isBridgeReply);
        receiveBridgeMessage(from, text, chatId, isBridgeReply);
        log.info(`[bridge] Received message from ${from} for chat ${chatId} (${text.length} chars)`);
        return json(res, { ok: true });
      } catch (err) {
        return sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (pathname.startsWith("/api/") || pathname.startsWith("/v1/")) {
      return sendJson(res, 404, { ok: false, error: "Not found" });
    }

    // ── Serve generated images from relay/uploads ──
    if (pathname.startsWith("/uploads/")) {
      const uploadsDir = path.resolve(config.uploadsDir);
      const fileName = pathname.replace("/uploads/", "");
      const resolved = path.resolve(uploadsDir, fileName);
      if (!resolved.startsWith(uploadsDir)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }
      serveFile(res, resolved);
      return;
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

  // Wire bridge incoming handler → routes through Kingston's orchestrator
  import("../bridge/wsBridge.js").then(({ setBridgeIncomingHandler }) => {
    setBridgeIncomingHandler(async (agent, text, chatId) => {
      return await handleMessage(chatId, `[Bridge from ${agent}]: ${text}`, config.voiceUserId, "user");
    });
  });

  const server = http.createServer(handleRequest);

  // Handle port conflicts with retry (previous instance may still be releasing)
  let retryCount = 0;
  const MAX_RETRIES = 3;
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE" && retryCount < MAX_RETRIES) {
      retryCount++;
      log.warn(`[dashboard] Port ${PORT} in use — retry ${retryCount}/${MAX_RETRIES} in 2s`);
      setTimeout(() => {
        server.close();
        server.listen(PORT, process.env.DASHBOARD_BIND || "127.0.0.1");
      }, 2000);
    } else if (err.code === "EADDRINUSE") {
      log.error(`[dashboard] Port ${PORT} still in use after ${MAX_RETRIES} retries — dashboard not started`);
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
            onImageGenerated(url, caption) { trySend({ type: "image", url, caption }); },
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

  // WebSocket Bridge (inter-agent communication)
  const bridgeWss = new WebSocketServer({ noServer: true });
  bridgeWss.on("connection", (ws) => {
    import("../bridge/wsBridge.js").then(({ handleBridgeConnection }) => {
      handleBridgeConnection(ws);
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
    } else if (req.url === "/ws/bridge") {
      bridgeWss.handleUpgrade(req, socket, head, (ws) => {
        bridgeWss.emit("connection", ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  const bindHost = process.env.DASHBOARD_BIND || "127.0.0.1";
  server.listen(PORT, bindHost, () => {
    log.info(`[dashboard] UI available at http://${bindHost === "0.0.0.0" ? "localhost" : bindHost}:${PORT}${bindHost === "0.0.0.0" ? " (all interfaces)" : " (localhost only)"}`);
    // Auto-start Cloudflare tunnel for Telegram Mini App
    if (process.env.DASHBOARD_TUNNEL !== "false") {
      startDashboardTunnel();
    }
  });
}

// Re-export broadcast for use by other modules
export { broadcast } from "./broadcast.js";




