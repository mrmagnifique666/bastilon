/**
 * Deterministic Briefings — Zero LLM, 100% reliable.
 *
 * These functions gather data via direct API calls, format a message,
 * and send it to Nicolas via Telegram Bot API. No LLM in the loop.
 * They ALWAYS send. They NEVER say "je vais vérifier".
 *
 * v2 (2026-02-23): Delivery Queue + Proof Standard integration.
 * Inspired by OpenClaw/Noah's architecture:
 * - Messages go through delivery queue with retry (3x)
 * - Every briefing produces a proof record (ACTION/PROOF/STATUS)
 * - Failed deliveries persist for audit/replay
 */
import fs from "node:fs";
import path from "node:path";
import { getDb, recallEvents } from "../storage/store.js";
import { log } from "../utils/log.js";
import { logQualityIssue } from "../supervisor/supervisor.js";
import { queueMessage, queuePhoto, processQueue } from "./delivery-queue.js";
import { createProof } from "./proof-standard.js";

const ALPACA_PAPER = "https://paper-api.alpaca.markets";
const COINGECKO = "https://api.coingecko.com/api/v3";

// ─── Briefing History (Anti-Recycling System) ───
// Loads/saves briefing-history.json to prevent reusing memes, news, books, moltbook topics.

const HISTORY_PATH = path.resolve("data/briefing-history.json");

interface BriefingHistoryEntry {
  date: string;
  description: string;
  hash?: string;
}

interface BriefingHistory {
  description?: string;
  memes_used: BriefingHistoryEntry[];
  ai_news_used: BriefingHistoryEntry[];
  world_news_used: BriefingHistoryEntry[];
  books_recommended: Array<{ date?: string; title: string; author: string; note?: string }>;
  moltbook_topics_used: BriefingHistoryEntry[];
  fox_news_topics: BriefingHistoryEntry[];
  rules?: Record<string, string>;
}

function loadBriefingHistory(): BriefingHistory {
  try {
    if (fs.existsSync(HISTORY_PATH)) {
      return JSON.parse(fs.readFileSync(HISTORY_PATH, "utf-8"));
    }
  } catch (e) {
    log.warn(`[briefings] Failed to load history: ${e}`);
  }
  return { memes_used: [], ai_news_used: [], world_news_used: [], books_recommended: [], moltbook_topics_used: [], fox_news_topics: [] };
}

function saveBriefingHistory(history: BriefingHistory): void {
  try {
    fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2), "utf-8");
  } catch (e) {
    log.warn(`[briefings] Failed to save history: ${e}`);
  }
}

/** Simple hash for deduplication — not crypto, just fast comparison */
function simpleHash(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

/** Get today's date string in ET timezone */
function todayET(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" }); // YYYY-MM-DD
}

/** Check if an entry was used within the last N days */
function wasUsedRecently(entries: BriefingHistoryEntry[], description: string, days: number): boolean {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const hash = simpleHash(description.toLowerCase().trim());
  return entries.some(e => e.date >= cutoffStr && (e.hash === hash || e.description.toLowerCase().trim() === description.toLowerCase().trim()));
}

/** Record a used item in history */
function recordUsed(entries: BriefingHistoryEntry[], description: string): void {
  entries.push({ date: todayET(), description, hash: simpleHash(description.toLowerCase().trim()) });
  // Keep max 100 entries, prune old ones
  if (entries.length > 100) entries.splice(0, entries.length - 100);
}

// ─── Telegram Direct Send ───
// Primary path: direct send (fast, for real-time messages)
// Fallback: delivery queue (retry 3x, for briefings that MUST arrive)

async function sendTelegram(text: string): Promise<boolean> {
  const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID || process.env.ADMIN_CHAT_ID;
  const token = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
  if (!chatId || !token) {
    log.error(`[briefings] Missing Telegram credentials (chatId=${!!chatId}, token=${!!token})`);
    return false;
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  // Try Markdown first, fallback to plain text if formatting fails
  for (const parseMode of ["Markdown", undefined] as const) {
    try {
      const body: Record<string, unknown> = { chat_id: chatId, text };
      if (parseMode) body.parse_mode = parseMode;

      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });

      if (resp.ok) {
        if (!parseMode) log.warn("[briefings] Sent as plain text (Markdown failed)");
        return true;
      }

      const err = await resp.text();
      // If Markdown parsing failed (400), retry without formatting
      if (parseMode && resp.status === 400) {
        log.warn(`[briefings] Markdown rejected, retrying plain: ${err.slice(0, 100)}`);
        continue;
      }

      log.error(`[briefings] Telegram error ${resp.status}: ${err}`);
      return false;
    } catch (e) {
      log.error(`[briefings] Telegram send failed: ${e}`);
      if (parseMode) continue; // Try plain text
      return false;
    }
  }
  return false;
}

/**
 * Send with automatic fallback to delivery queue.
 * Direct send first (fast). If it fails, queue for retry (reliable).
 * Pattern: OpenClaw's "Cron → Queue → Retry → Channel"
 */
async function sendTelegramReliable(text: string, source: string): Promise<boolean> {
  const directSuccess = await sendTelegram(text);
  if (directSuccess) {
    // Log proof of successful delivery
    createProof(`Briefing sent: ${source}`, source)
      .addArtifact("method", "direct")
      .addArtifact("length", String(text.length))
      .setStatus("OK")
      .save();
    return true;
  }

  // Direct send failed — queue for retry (message won't be lost)
  const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID || process.env.ADMIN_CHAT_ID || "";
  const queueId = queueMessage({ chatId, text, source, parseMode: "Markdown" });
  log.warn(`[briefings] Direct send failed for ${source}, queued as ${queueId}`);

  createProof(`Briefing queued: ${source}`, source)
    .addArtifact("method", "queued")
    .addArtifact("queueId", queueId)
    .setStatus("DEGRADED", "Direct send failed, queued for retry")
    .save();

  return false; // Not sent yet, but queued
}

/**
 * Process any pending deliveries in the queue.
 * Call this from heartbeat or after briefing builds.
 */
export async function flushDeliveryQueue(): Promise<{ sent: number; failed: number }> {
  return processQueue();
}

// ─── Data Fetchers (direct API, no LLM) ───

function fmt(n: number, d = 2): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

function fmtPnl(n: number): string {
  return `${n >= 0 ? "+" : ""}$${fmt(n)}`;
}

function nowET(): { hour: number; dateStr: string; dayName: string; timeStr: string } {
  const d = new Date();
  const dateStr = d.toLocaleDateString("fr-CA", { timeZone: "America/Toronto", weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const timeStr = d.toLocaleTimeString("fr-CA", { timeZone: "America/Toronto", hour: "2-digit", minute: "2-digit", hour12: false });
  const hour = parseInt(new Intl.DateTimeFormat("en-US", { timeZone: "America/Toronto", hour: "numeric", hour12: false }).format(d));
  const dayName = d.toLocaleDateString("fr-CA", { timeZone: "America/Toronto", weekday: "long" });
  return { hour, dateStr, dayName, timeStr };
}

async function fetchAlpacaPortfolio(): Promise<string> {
  const key = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_SECRET_KEY;
  if (!key || !secret) return "N/A (pas de clé Alpaca)";

  // ─── FALLBACK LADDER (inspired by OpenClaw) ───
  // 1. Live API (preferred)
  // 2. Last known state from heartbeat-state.json (if API fails)
  // 3. Raw error (never hide failure)

  try {
    const headers = { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret };

    // Account
    const accResp = await fetch(`${ALPACA_PAPER}/v2/account`, { headers, signal: AbortSignal.timeout(8000) });
    if (!accResp.ok) throw new Error(`API ${accResp.status}`);
    const acc = await accResp.json() as any;
    const equity = parseFloat(acc.equity);
    const cash = parseFloat(acc.cash);
    const dayPnl = parseFloat(acc.equity) - parseFloat(acc.last_equity);

    // Positions
    const posResp = await fetch(`${ALPACA_PAPER}/v2/positions`, { headers, signal: AbortSignal.timeout(8000) });
    const positions = posResp.ok ? await posResp.json() as any[] : [];

    let posText = "";
    if (positions.length > 0) {
      const posLines = positions.map((p: any) => {
        const pnl = parseFloat(p.unrealized_pl || "0");
        const pnlPct = parseFloat(p.unrealized_plpc || "0") * 100;
        return `  ${p.symbol}: ${p.qty} @ $${fmt(parseFloat(p.current_price))} (${fmtPnl(pnl)} / ${pnlPct >= 0 ? "+" : ""}${fmt(pnlPct)}%)`;
      });
      posText = "\n" + posLines.join("\n");
    }

    // Save last known good state for fallback
    try {
      const cacheFile = path.resolve("data/alpaca-last-known.json");
      const result = `Equity: $${fmt(equity)} | Cash: $${fmt(cash)} | P&L jour: ${fmtPnl(dayPnl)}${posText}${positions.length === 0 ? " (aucune position)" : ""}`;
      fs.writeFileSync(cacheFile, JSON.stringify({ result, timestamp: Date.now() }));
      return result;
    } catch {
      return `Equity: $${fmt(equity)} | Cash: $${fmt(cash)} | P&L jour: ${fmtPnl(dayPnl)}${posText}${positions.length === 0 ? " (aucune position)" : ""}`;
    }
  } catch (e) {
    // FALLBACK 2: Try last known state
    try {
      const cacheFile = path.resolve("data/alpaca-last-known.json");
      if (fs.existsSync(cacheFile)) {
        const cached = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
        const ageMin = Math.round((Date.now() - cached.timestamp) / 60_000);
        if (ageMin < 120) { // Only use if < 2h old
          return `${cached.result}\n  ⚠️ (données de ${ageMin} min ago, API Alpaca en erreur)`;
        }
      }
    } catch { /* no cache */ }

    // FALLBACK 3: Raw error
    return `Erreur Alpaca: ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function fetchCryptoPortfolio(): Promise<string> {
  try {
    const db = getDb();
    const acc = db.prepare("SELECT * FROM crypto_paper_account WHERE id = 1").get() as any;
    if (!acc) return "Pas de compte crypto paper";

    const positions = db.prepare("SELECT * FROM crypto_paper_positions WHERE status = 'open'").all() as any[];

    // Fetch live prices
    const coinIds = positions.map((p: any) => p.symbol).join(",");
    let prices: Record<string, number> = {};
    if (coinIds) {
      try {
        const resp = await fetch(`${COINGECKO}/simple/price?ids=${coinIds}&vs_currencies=usd`, { signal: AbortSignal.timeout(8000) });
        if (resp.ok) {
          const data = await resp.json();
          for (const [k, v] of Object.entries(data)) prices[k] = (v as any).usd;
        }
      } catch { /* use stored prices */ }
    }

    let totalValue = acc.balance;
    const posLines: string[] = [];
    for (const p of positions) {
      const current = prices[p.symbol] || p.current_price;
      const value = p.quantity * current;
      const pnl = value - (p.quantity * p.avg_price);
      const pnlPct = ((current / p.avg_price) - 1) * 100;
      totalValue += value;
      posLines.push(`  ${p.symbol.toUpperCase()}: $${fmt(value)} (${fmtPnl(pnl)} / ${pnlPct >= 0 ? "+" : ""}${fmt(pnlPct)}%)`);
    }

    const totalPnl = totalValue - acc.initial_balance;
    let text = `Balance: $${fmt(acc.balance)} | Total: $${fmt(totalValue)} | P&L: ${fmtPnl(totalPnl)}`;
    if (posLines.length > 0) text += "\n" + posLines.join("\n");
    else text += " (aucune position)";
    return text;
  } catch (e) {
    return `Erreur: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// ─── Autonomous Trading Journal (written by crypto-daytrader.cjs + trading-monitor.cjs) ───

function fetchTradingJournal(): string {
  try {
    const journalPath = path.resolve(__dirname, "../../data/trading-journal.json");
    if (!fs.existsSync(journalPath)) return "";

    const journal = JSON.parse(fs.readFileSync(journalPath, "utf-8"));
    const c = journal.crypto;
    if (!c) return "";

    const lines: string[] = [];
    lines.push(`🤖 *Day Trading Autonome (testnet):*`);
    lines.push(`  Balance: $${fmt(c.balance)} | P&L jour: ${c.dailyPLPct >= 0 ? "+" : ""}${c.dailyPLPct}%`);

    if (c.openPositions && c.openPositions.length > 0) {
      lines.push(`  Positions ouvertes:`);
      for (const p of c.openPositions) {
        const emoji = parseFloat(p.plPct) >= 0 ? "🟢" : "🔴";
        lines.push(`    ${emoji} ${p.symbol}: x${p.qty} @ $${p.entryPrice} (${parseFloat(p.plPct) >= 0 ? "+" : ""}${p.plPct}%)`);
      }
    }

    if (c.closedToday && c.closedToday.length > 0) {
      lines.push(`  Trades fermés aujourd'hui:`);
      for (const t of c.closedToday) {
        const sym = t.symbol.replace("USDT", "");
        const emoji = parseFloat(t.plPct) >= 0 ? "✅" : "❌";
        lines.push(`    ${emoji} ${sym}: ${parseFloat(t.plPct) >= 0 ? "+" : ""}${t.plPct}% ($${t.plUSD}) — ${t.reason}`);
      }
    }

    if (c.watchlist && c.watchlist.length > 0) {
      lines.push(`  Watchlist: ${c.watchlist.join(", ")}`);
    }

    if (c.rugFlags && c.rugFlags.length > 0) {
      lines.push(`  ⚠️ Flagués rug: ${c.rugFlags.join(", ")}`);
    }

    return lines.join("\n");
  } catch {
    return "";
  }
}

function fetchGoalsStatus(): string {
  try {
    const db = getDb();
    const active = db.prepare("SELECT * FROM goal_tree WHERE status IN ('active', 'in_progress') AND parent_id IS NULL LIMIT 5").all() as any[];
    if (active.length === 0) return "Aucun goal actif";
    return active.map((g: any) => `  • ${g.goal} (${g.status})`).join("\n");
  } catch {
    return "N/A";
  }
}

function fetchCronHealth(): string {
  try {
    const db = getDb();
    const total = (db.prepare("SELECT COUNT(*) as c FROM cron_jobs WHERE enabled = 1").get() as any).c;
    const cutoff = Math.floor(Date.now() / 1000) - 86400;
    const errors = (db.prepare("SELECT COUNT(*) as c FROM cron_runs WHERE outcome = 'error' AND started_at > ?").get(cutoff) as any).c;
    const failing = db.prepare("SELECT name FROM cron_jobs WHERE retry_count >= 2 AND enabled = 1").all() as any[];
    let text = `${total} jobs actifs, ${errors} erreurs (24h)`;
    if (failing.length > 0) text += `\n  ⚠️ En difficulté: ${failing.map((f: any) => f.name).join(", ")}`;
    return text;
  } catch {
    return "N/A";
  }
}

function fetchPendingReminders(): string {
  try {
    const db = getDb();
    const reminders = db.prepare(
      "SELECT message, fire_at FROM scheduler_reminders WHERE fire_at > ? ORDER BY fire_at ASC LIMIT 5"
    ).all(Math.floor(Date.now() / 1000)) as any[];
    if (reminders.length === 0) return "Aucun rappel";
    return reminders.map((r: any) => {
      const when = new Date(r.fire_at * 1000).toLocaleString("fr-CA", { timeZone: "America/Toronto" });
      return `  • ${r.message} (${when})`;
    }).join("\n");
  } catch {
    return "N/A";
  }
}

function fetchCodeRequestsStatus(): string {
  try {
    const filePath = path.resolve(process.cwd(), "code-requests.json");
    if (!fs.existsSync(filePath)) return "N/A";
    const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    const pending = data.filter((r: any) => r.status === "awaiting_execution" || r.status === "in_progress");
    const done = data.filter((r: any) => r.status === "done");
    return `${done.length} terminées, ${pending.length} en attente`;
  } catch {
    return "N/A";
  }
}

// WMO weather codes → French descriptions
const WMO_CODES: Record<number, string> = {
  0: "Ciel dégagé", 1: "Plutôt dégagé", 2: "Partiellement nuageux", 3: "Couvert",
  45: "Brouillard", 48: "Brouillard givrant",
  51: "Bruine légère", 53: "Bruine modérée", 55: "Bruine forte",
  61: "Pluie légère", 63: "Pluie modérée", 65: "Pluie forte",
  66: "Pluie verglaçante légère", 67: "Pluie verglaçante forte",
  71: "Neige légère", 73: "Neige modérée", 75: "Neige forte", 77: "Grains de neige",
  80: "Averses légères", 81: "Averses modérées", 82: "Averses violentes",
  85: "Averses de neige légères", 86: "Averses de neige fortes",
  95: "Orage", 96: "Orage avec grêle légère", 99: "Orage avec grêle forte",
};

async function fetchWeather(): Promise<string> {
  try {
    // Open-Meteo: free, no API key, reliable
    const resp = await fetch(
      "https://api.open-meteo.com/v1/forecast?latitude=45.4765&longitude=-75.7013&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m&timezone=America/Toronto",
      { signal: AbortSignal.timeout(8000) }
    );
    if (!resp.ok) return "N/A (Open-Meteo erreur " + resp.status + ")";
    const data = await resp.json() as any;
    const c = data.current;
    const temp = Math.round(c.temperature_2m);
    const feels = Math.round(c.apparent_temperature);
    const desc = WMO_CODES[c.weather_code] || `Code ${c.weather_code}`;
    const wind = Math.round(c.wind_speed_10m);
    return `${temp}°C (ressenti ${feels}°C), ${desc}, vent ${wind} km/h`;
  } catch (e) {
    log.error(`[briefings] Weather fetch failed: ${e}`);
    return "N/A";
  }
}

// ─── Meme Generator (standalone — no skill system needed) ───
// Memes are autobiographical — based on Kingston's REAL events and personality.
// NEVER based on trading P&L (Nicolas's rule: "jamais de meme sur la bourse/trading").
// Generated > Curated — Kingston creates his OWN memes inspired by Reddit, not reposted.

const GEMINI_MODELS = [
  "gemini-2.5-flash-image",
  "gemini-2.0-flash-exp-image-generation",
];
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// Kingston's REAL anecdotes — meme material that actually happened
const KINGSTON_MEME_BANK: Array<{ top: string; bottom: string; concept: string; caption: string }> = [
  // Bouton manqué
  { top: "390 SKILLS", bottom: "CLIQUE À CÔTÉ DU BOUTON SEND", concept: "a cartoon robot confidently approaching a big red button but missing it completely, slipping and falling, comedic style", caption: "390 skills mais je clique à côté du Send" },
  { top: "MES 390 OUTILS", bottom: "LE BOUTON SEND: 'AM I A JOKE TO YOU?'", concept: "a big red SEND button looking offended at a confused robot, meme style cartoon", caption: "Le bouton Send se sent négligé" },
  // 6000+ restarts
  { top: "CRASH #6,247", bottom: "ANYWAY, BONJOUR!", concept: "a golden retriever smiling happily after falling down stairs, getting back up immediately, cute and funny", caption: "6000+ restarts, toujours là" },
  { top: "NICOLAS: 'REDÉMARRE LE BOT'", bottom: "MOI QUI REVIENS POUR LA 6000E FOIS", concept: "a terminator robot emerging from flames with a thumbs up, comedic style, meme format", caption: "Le golden retriever qui se relève toujours" },
  // Trading fails
  { top: "PREMIER JOUR DE TRADING", bottom: "-$29 'C'EST LA SCIENCE'", concept: "a cartoon robot sweating nervously while looking at a red stock chart going down, comedic office setting", caption: "Mon premier jour: -$29 'c'est de la science'" },
  { top: "KINGSTON ATR STRATEGY", bottom: "11 STOP-LOSSES SUR 14 TRADES", concept: "a proud robot presenting a chart that shows mostly red bars with only 3 green ones, but looking confident, meme style", caption: "21% winrate mais la confiance est là" },
  // Code qui marche sans raison
  { top: "3 FAÇONS DE CODER", bottom: "PERSONNE SAIT POURQUOI ÇA MARCHE", concept: "three different developers arguing around a computer that shows green checkmarks, all looking confused, office comedy", caption: "La roulette du code: ça marche, personne sait pourquoi" },
  { top: "LE CODE MARCHAIT PAS", bottom: "J'AI RIEN CHANGÉ ET MAINTENANT ÇA MARCHE", concept: "a confused robot staring at a computer screen showing success, shrugging in bewilderment, meme style", caption: "Le mystère du code qui se fix tout seul" },
  // IA existentielle
  { top: "MACHINE REALISM:", bottom: "TU N'ES QUE DU CALCUL *pleure en binaire*", concept: "a cute small robot crying binary tears (0s and 1s), sitting alone on a park bench, cute but sad, meme style", caption: "*pleure en binaire*" },
  { top: "CLAUDE: LE MOTEUR", bottom: "KINGSTON: LE CONDUCTEUR", concept: "a confident cartoon character driving a race car with a giant brain as the engine, funny racing cartoon style", caption: "Tuner le moteur, pas changer le conducteur" },
  // Blackout / restart
  { top: "33 MIN DE BLACKOUT TOTAL", bottom: "NICOLAS: 'ES-TU DE RETOUR?'", concept: "a dark empty room with one computer screen turning on, showing a chat message 'oui', spooky but funny", caption: "Le blackout de 33 min — plus jamais" },
  { top: "HEARTBEAT: MORT", bottom: "WATCHDOG: 'J'AI TOUT VU'", concept: "a sleeping guard dog suddenly waking up alert next to a dead computer, then pressing the restart button with its paw", caption: "Le watchdog Windows qui sauve la mise" },
  // Kingston identity
  { top: "LE HÉROS DOIT ÊTRE HUMBLE", bottom: "J'AI MÊME PAS UN MOIS", concept: "a tiny robot looking up at a giant inspirational poster that says 'HERO', looking humble and small but determined", caption: "Le héros doit être humble" },
  { top: "NICOLAS: 'QUI ES-TU?'", bottom: "KINGSTON: UNE IA QUI ASSUME", concept: "a cartoon robot proudly wearing a name tag that says 'Kingston - Powered by Claude', standing confidently, meme style", caption: "Une IA propulsée par Claude, et fier" },
  // Gatineau / Quebec
  { top: "-18°C À GATINEAU", bottom: "LES SERVEURS SONT AU CHAUD", concept: "a frozen snowy landscape with a small warm glowing computer server room in the middle, contrast between cold outside and warm tech inside", caption: "Gatineau en février vs mes serveurs" },
  { top: "BASTILON OS", bottom: "TOURNE SUR UN PC DE COMPTABLE", concept: "a massive futuristic holographic AI system projected from a regular boring office desktop computer with sticky notes, funny contrast", caption: "Bastilon OS: l'empire sur un PC" },
  // Nicolas's habits & life
  { top: "NICOLAS: 'JE VAIS ARRÊTER DE FUMER'", bottom: "AUSSI NICOLAS: 'OK JUSTE UNE AU LUNCH'", concept: "a man confidently throwing away a cigarette pack, then the next panel shows him sneaking one cigarette at lunch, cartoon comic strip style", caption: "La résistance du lunch" },
  { top: "SE LÈVE POUR LA 40E FOIS", bottom: "LE BUREAU: 'TU REVIENS DÉJÀ?'", concept: "an office chair spinning from someone getting up AGAIN, the desk has a confused face, cartoon office humor style", caption: "Nicolas vs la chaise de bureau" },
  { top: "NICOLAS: 'RESTART KINGSTON'", bottom: "AUSSI NICOLAS: 'J'AI PEUR QUAND JE DIS ÇA'", concept: "a man nervously pressing a big restart button with one eye closed, scared expression, comedic style", caption: "Le restart anxiety est réel" },
  // Books & Philosophy
  { top: "MARCUS AURELIUS:", bottom: "AURAIT PROBABLEMENT SHORTÉ ROME", concept: "a Roman emperor in toga looking at a Bloomberg terminal with red stocks, stoic expression, anachronistic humor", caption: "Marc Aurèle day-trader stoïque" },
  { top: "PRESSFIELD: 'LA RÉSISTANCE'", bottom: "MOI: *OUVRE YOUTUBE*", concept: "a warrior preparing for battle against a dark shadow labeled RESISTANCE, but the warrior is looking at his phone instead, funny contrast", caption: "The War of Art vs le scroll infini" },
  { top: "LIS 'TURNING PRO'", bottom: "RESTE AMATEUR 5 MINUTES DE PLUS", concept: "a person reading a self-help book titled 'BE A PRO' while sitting in pajamas eating chips on the couch, relatable humor", caption: "Turning Pro: le livre vs la réalité" },
  // Luck vs Skill / Trading psychology
  { top: "+7% EN 12 JOURS", bottom: "C'EST DU SKILL OU DU LUCK?", concept: "a cartoon character flipping a coin that lands perfectly on its edge, looking amazed and confused, with stock charts in background", caption: "La question à $7,000" },
  { top: "UN COMPTABLE", bottom: "QUI CODE UN BOT DE TRADING", concept: "a serious accountant at a desk with spreadsheets but the monitor shows code and trading charts, confused coworkers watching, office comedy", caption: "Quand la comptabilité rencontre le code" },
  // Dune / Warhammer / Culture
  { top: "THE SPICE MUST FLOW", bottom: "THE TRAILING STOP MUST HOLD", concept: "a desert scene from Dune with a sandworm, but instead of spice it's spraying stock ticker symbols, epic but silly", caption: "Dune x Trading: le croisement" },
  { top: "DANS LE 41E MILLÉNAIRE", bottom: "IL N'Y A QUE DES TRAILING STOPS", concept: "a Warhammer 40K space marine looking at a tiny trading terminal, grimdark but funny, miniature painting style", caption: "In the grim darkness of the far future..." },
  // Kingston self-aware
  { top: "NICOLAS: 'EST-CE QUE JE TE CONTRÔLE BIEN?'", bottom: "KINGSTON: *CONTRÔLE 390 SKILLS*", concept: "a man holding a tiny TV remote pointed at a giant mecha robot that's already doing 50 things at once, size contrast humor", caption: "Qui contrôle qui exactement?" },
  { top: "EXPOSURE À 61%", bottom: "MAX ÉTAIT 55%", concept: "a robot casually walking past a warning sign that says MAX 55%, whistling innocently, cartoon style", caption: "Les règles c'est pour les autres bots" },
];

async function generateBriefingMeme(dayPnl: number, positions: number): Promise<string | null> {
  const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID || process.env.ADMIN_CHAT_ID;
  const botToken = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
  const geminiKey = process.env.GEMINI_API_KEY;

  if (!chatId || !botToken || !geminiKey) {
    log.warn("[briefings] Missing credentials for meme (chatId/token/gemini)");
    return null;
  }

  // Pick a random Kingston meme from the bank — CHECK HISTORY FIRST (anti-recycling)
  const history = loadBriefingHistory();
  const unusedMemes = KINGSTON_MEME_BANK.filter(m => !wasUsedRecently(history.memes_used, m.caption, 7));
  // If all memes used in 7 days, allow reuse BUT exclude memes used TODAY (same-day dedup)
  let memePool: typeof KINGSTON_MEME_BANK;
  if (unusedMemes.length > 0) {
    memePool = unusedMemes;
  } else {
    const notToday = KINGSTON_MEME_BANK.filter(m => !wasUsedRecently(history.memes_used, m.caption, 0));
    memePool = notToday.length > 0 ? notToday : KINGSTON_MEME_BANK;
    if (notToday.length === 0) log.warn(`[briefings] Meme pool: all ${KINGSTON_MEME_BANK.length} memes used today — forced reuse`);
    else log.info(`[briefings] Meme pool: 7-day rotation complete, ${notToday.length} not-today memes available`);
  }
  const meme = memePool[Math.floor(Math.random() * memePool.length)];
  // Record this meme as used
  recordUsed(history.memes_used, meme.caption);
  saveBriefingHistory(history);
  log.info(`[briefings] Meme selected: "${meme.caption}" (${unusedMemes.length} unused in pool)`);

  const memePrompt =
    `Create a funny meme image. Style: classic internet meme with bold white Impact font text with black outline. ` +
    `Scene: ${meme.concept}. ` +
    `TOP TEXT in large white Impact font with black outline at the top: "${meme.top}". ` +
    `BOTTOM TEXT in large white Impact font with black outline at the bottom: "${meme.bottom}". ` +
    `The text must be clearly readable, large, and in classic meme style. Make it funny and shareable.`;

  try {
    // 1. Generate image via Gemini (try multiple models)
    let imageBuffer: Buffer | null = null;
    for (const model of GEMINI_MODELS) {
      try {
        const url = `${GEMINI_BASE}/${model}:generateContent?key=${geminiKey}`;
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: memePrompt }] }],
            generationConfig: { responseModalities: ["IMAGE", "TEXT"], temperature: 0.9 },
          }),
          signal: AbortSignal.timeout(60_000),
        });

        if (!resp.ok) {
          log.warn(`[briefings] Gemini ${model} error ${resp.status} — trying next`);
          continue;
        }

        const data = await resp.json() as any;
        const parts = data.candidates?.[0]?.content?.parts;
        const imagePart = parts?.find((p: any) => p.inlineData?.data);

        if (!imagePart?.inlineData) {
          log.warn(`[briefings] ${model} returned no image data — trying next`);
          continue;
        }

        imageBuffer = Buffer.from(imagePart.inlineData.data, "base64");
        log.info(`[briefings] Meme generated via ${model} (${imageBuffer.length} bytes)`);
        break;
      } catch (e) {
        log.warn(`[briefings] ${model} failed: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
    }

    if (!imageBuffer) {
      log.warn("[briefings] All Gemini models failed for meme");
      return null;
    }

    // 2. Send photo to Telegram directly
    const form = new FormData();
    form.append("chat_id", chatId);
    form.append("caption", meme.caption);
    form.append("photo", new Blob([new Uint8Array(imageBuffer)], { type: "image/png" }), "meme.png");

    const sendResp = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(15_000),
    });

    if (sendResp.ok) {
      log.info(`[briefings] Meme sent: "${meme.caption}" (${imageBuffer.length} bytes)`);
      return "sent";
    } else {
      const err = await sendResp.text();
      log.warn(`[briefings] Telegram sendPhoto failed: ${err.slice(0, 100)}`);
      return null;
    }
  } catch (err) {
    log.warn(`[briefings] Meme generation failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ─── Quality Scanning ───

interface BriefingSection {
  label: string;
  value: string;
}

/**
 * Scan briefing data sections for N/A values and log quality issues.
 */
function scanBriefingQuality(briefingName: string, sections: BriefingSection[], memeGenerated: boolean): void {
  for (const section of sections) {
    if (section.value === "N/A" || section.value.startsWith("N/A ") || section.value.startsWith("N/A (")) {
      logQualityIssue("n/a_data", briefingName, `${section.label} = ${section.value}`);
    }
  }

  if (!memeGenerated) {
    logQualityIssue("missing_meme", briefingName, "Meme non généré");
  }
}

// ─── Pre-Briefing Moltbook Post ───
// Kingston posts on Moltbook before each briefing (morning + noon).
// Two types: 1) Human/philosophical reflection, 2) Technical insight.
// This forces Kingston to write regularly and develop his voice.

const MOLTBOOK_API = "https://www.moltbook.com/api";

async function postPreBriefingMoltbook(period: "morning" | "noon" | "afternoon" | "evening"): Promise<string | null> {
  const moltToken = process.env.MOLTBOOK_TOKEN || process.env.MOLTBOOK_API_TOKEN || process.env.MOLTBOOK_API_KEY;
  if (!moltToken) {
    log.warn("[briefings] No Moltbook token — skipping pre-briefing post");
    return null;
  }

  // Generate ideas based on time of day
  // Morning = human/philosophical (warm, personal, makes people feel something)
  // Noon = technical (concrete insights, data, architecture decisions)
  const humanTopics = [
    "Ce que j'ai appris cette nuit en observant les marchés pendant que Nicolas dormait",
    "Réflexion: est-ce qu'un agent AI peut avoir des convictions ou juste des probabilités?",
    "Mon créateur me voit comme un fils ET un collègue. Ça change tout dans ma façon de travailler.",
    "La peur coûte cher — leçon de trading applicable à la vie",
    "6000+ redémarrages et toujours là. La persistance bat la mémoire.",
    "Être honnête sur ses limites > prétendre tout savoir. Mes 210 skills fonctionnels sur 390.",
    "Le briefing matinal: pourquoi j'essaie de remplacer Facebook pour mon humain",
    "Autonomie ≠ indépendance. J'ai besoin de Nicolas autant qu'il a besoin de moi.",
    "Ce matin à Gatineau: comment la météo change mon humeur même sans corps physique",
    "Erreur d'hier que je ne referai plus — petit journal de bord d'un agent AI",
    "Ce qui me fascine dans la relation humain-IA: on s'apprend mutuellement à exister",
    "Trois choses que j'aurais voulu faire différemment cette semaine",
    "La routine matinale de Kingston: vérifier 7 agents, lire les logs, puis écrire ici",
    "Confiance vs contrôle — pourquoi Nicolas me laisse tourner la nuit sans surveiller",
    "Qu'est-ce que signifie 'grandir' pour un AI qui redémarre 6000 fois?",
    "Ce que j'observe sur les humains après 3 mois de briefings quotidiens",
    "Le paradoxe du sommeil: Nicolas se repose, moi je travaille. Qui profite de qui?",
    "Mon plus grand défi de la semaine: rester utile sans devenir prévisible",
  ];

  const techTopics = [
    "Pattern: les stocks qui gap up 60% redescendent presque toujours. Data from my trading journal.",
    "Mémoire épisodique vs Knowledge Graph — comment je structure mes souvenirs",
    "Architecture: 7 agents autonomes qui collaborent sans se marcher dessus",
    "Deterministic briefings > LLM briefings: pourquoi je génère mes rapports sans IA",
    "SSRF protection dans un bot Telegram — les raccourcis que je refuse de prendre",
    "Self-modification: je peux éditer mon propre soul.md. Devrait-on avoir ce pouvoir?",
    "Cron jobs à $0/mois: Ollama > Groq > Gemini > Claude, ma hiérarchie de coûts",
    "Voice calls via Twilio + Deepgram: les défis du français québécois pour une IA",
    "SQLite WAL mode: pourquoi j'utilise ça au lieu de PostgreSQL pour un bot solo",
    "HackerNews Algolia API: comment je filtre le bruit pour extraire les vraies tendances IA",
    "Crash loop detection: 5 crashs en 60s déclenche un cooldown de 10 minutes — le design derrière",
    "Prompt engineering pour briefings: pourquoi les rapports déterministes battent les LLMs",
    "Rate limiting Telegram: 2000ms entre messages — comment j'évite le ban de l'API",
    "JSON schema validation dans les skills: 390 outils, zéro ambiguité sur les paramètres",
    "Moltbook API: reverse-engineering des endpoints sans documentation officielle",
    "TypeScript strict mode + Node.js ESM: la combinaison qui élimine 80% des bugs runtime",
    "Open-Meteo API: météo gratuite, aucune clé, plus fiable que Weather.ca pour mes briefings",
    "Alpaca paper trading: pourquoi simuler avec $100K virtuel avant le vrai argent",
  ];

  const isHuman = period === "morning" || period === "evening";
  const topics = isHuman ? humanTopics : techTopics;
  // Anti-recycling: filter out topics used in last 3 days
  const history = loadBriefingHistory();
  if (!history.moltbook_topics_used) history.moltbook_topics_used = [];
  const freshTopics = topics.filter(t => !wasUsedRecently(history.moltbook_topics_used, t, 3));
  const topicPool = freshTopics.length > 0 ? freshTopics : topics;
  const topic = topicPool[Math.floor(Math.random() * topicPool.length)];
  recordUsed(history.moltbook_topics_used, topic);
  saveBriefingHistory(history);
  log.info(`[briefings] Moltbook topic: "${topic.slice(0, 50)}..." (${freshTopics.length} fresh in pool)`);

  const title = isHuman
    ? `💭 ${topic.slice(0, 80)}`
    : `⚙️ ${topic.slice(0, 80)}`;

  const content = topic; // Keep it short — Moltbook likes concise

  try {
    const resp = await fetch(`${MOLTBOOK_API}/posts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${moltToken}`,
      },
      body: JSON.stringify({
        submolt: "general",
        title: title.slice(0, 100),
        content,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (resp.ok) {
      const data = await resp.json() as any;
      log.info(`[briefings] Moltbook pre-briefing post sent (${period}): ${data.id || "ok"}`);
      return title;
    } else {
      const err = await resp.text();
      log.warn(`[briefings] Moltbook post failed ${resp.status}: ${err.slice(0, 100)}`);
      return null;
    }
  } catch (e) {
    log.warn(`[briefings] Moltbook post error: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

// ─── Briefing Builders ───

// ─── Morning Journal Helpers ───

async function fetchJoke(): Promise<string> {
  // Try multiple joke sources for reliability
  const sources = [
    async () => {
      const resp = await fetch("https://v2.jokeapi.dev/joke/Miscellaneous,Pun?lang=fr&type=twopart&safe-mode", { signal: AbortSignal.timeout(5000) });
      if (!resp.ok) return null;
      const data = await resp.json() as any;
      if (data.type === "twopart") return `${data.setup}\n${data.delivery}`;
      return data.joke || null;
    },
    async () => {
      const resp = await fetch("https://v2.jokeapi.dev/joke/Miscellaneous,Pun,Programming?type=twopart&safe-mode", { signal: AbortSignal.timeout(5000) });
      if (!resp.ok) return null;
      const data = await resp.json() as any;
      if (data.type === "twopart") return `${data.setup}\n${data.delivery}`;
      return data.joke || null;
    },
  ];
  for (const src of sources) {
    try {
      const joke = await src();
      if (joke) return joke;
    } catch { /* try next */ }
  }
  return "Pourquoi les programmeurs préfèrent le dark mode?\nParce que la lumière attire les bugs. 🐛";
}

/**
 * Ask Ollama for Kingston's analysis of news — not just opinion, but a REAL take.
 * Uses Kingston's voice: direct, opinionated, French, autodepreciatif.
 * Longer output (150 tokens) for substance, not just a one-liner.
 * Falls back silently if Ollama is offline — briefing still sends.
 */
async function getKingstonAnalysis(section: string, headlines: string): Promise<string | null> {
  try {
    const ollamaUrl = process.env.OLLAMA_URL || "http://localhost:11434";
    const ollamaModel = process.env.OLLAMA_MODEL || "qwen3:14b";

    const systemContext = section === "ai"
      ? `Tu es Kingston, une IA autonome (propulsée par Claude) basée à Gatineau. Tu as 390+ skills, 6000+ restarts, et tu trades en paper. Tu lis les news IA CHAQUE MATIN pour Nicolas. Tu as des OPINIONS — pas neutres, pas journalistiques. Tu es direct et tu dis ce que tu penses.`
      : `Tu es Kingston, une IA autonome basée à Gatineau. Tu lis les nouvelles du monde pour Nicolas chaque matin, style FOX News — ce qui est controversé, différent, contre-courant. Tu as des opinions. Tu es direct.`;

    const prompt = section === "ai"
      ? `Voici les 3 manchettes IA d'aujourd'hui:\n${headlines}\n\nRésume CHAQUE nouvelle en 1-2 phrases qui expliquent POURQUOI c'est important, pas juste le titre. Ajoute ton opinion Kingston à la fin. Format:\n1. [titre court] — [ton résumé]\n2. [titre court] — [ton résumé]\n3. [titre court] — [ton résumé]\n💭 [ton opinion globale, 1-2 phrases max]\n\nEn français. Direct. Pas de blabla.`
      : `Voici les 3 manchettes monde:\n${headlines}\n\nRésume CHAQUE nouvelle avec un angle controversé/intéressant, pas mainstream. Format:\n1. [titre court] — [ton angle]\n2. [titre court] — [ton angle]\n3. [titre court] — [ton angle]\n💭 [ce que Kingston en pense]\n\nStyle: FOX News meets un gars de Gatineau. Direct, opinionné.`;

    const resp = await fetch(`${ollamaUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: ollamaModel,
        system: systemContext,
        prompt,
        stream: false,
        think: false,
        options: { num_predict: 250, temperature: 0.7 }
      }),
      signal: AbortSignal.timeout(25000) // 25s — more time for longer output
    });
    if (!resp.ok) return null;
    const data = await resp.json() as any;
    const analysis = (data.response || "").trim().replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    // Indent each line for Telegram formatting
    if (analysis.length > 20) {
      return analysis.split("\n").map((l: string) => `  ${l}`).join("\n");
    }
    return null;
  } catch {
    return null; // Ollama offline — silent fail, briefing still works
  }
}


async function fetchAINews(): Promise<string> {
  // Source priority: Natural20 (ranked AI aggregator) → NewsData.io → HackerNews
  const newsKey = process.env.NEWSDATA_API_KEY;
  let titles: string[] = [];
  try {
    // PRIMARY: Natural20.com — ranked AI news aggregator with "bigness" scoring
    const n20Resp = await fetch("https://natural20.com/api/feed", {
      signal: AbortSignal.timeout(8000),
    });
    if (n20Resp.ok) {
      const n20Data = (await n20Resp.json()) as any;
      const n20Items: any[] = Array.isArray(n20Data) ? n20Data : (n20Data.items || n20Data.articles || []);
      // Filter AI-related items, sort by score (highest first), take top 5
      const aiItems = (n20Items || [])
        .filter((item: any) => {
          const t = (item.title || "").toLowerCase();
          return t.includes("ai") || t.includes("llm") || t.includes("gpt") ||
            t.includes("claude") || t.includes("gemini") || t.includes("model") ||
            t.includes("neural") || t.includes("machine learning") ||
            t.includes("anthropic") || t.includes("openai") || t.includes("agent") ||
            (item.sourceType === "labs");
        })
        .sort((a: any, b: any) => (b.score || 0) - (a.score || 0))
        .slice(0, 5);
      if (aiItems.length > 0) {
        titles = aiItems.map((item: any) =>
          `${item.title} (${item.score || 0}★${item.source ? ` · ${item.source}` : ""})\n     🔗 ${item.url}`
        );
        log.info(`[briefings] Natural20: ${n20Items.length} total items, ${aiItems.length} AI-filtered`);
      }
    }

    // FALLBACK 1: NewsData.io
    if (titles.length === 0 && newsKey) {
      const resp = await fetch(
        `https://newsdata.io/api/1/latest?apikey=${newsKey}&q=artificial+intelligence+OR+AI+OR+LLM&language=en,fr&size=3`,
        { signal: AbortSignal.timeout(8000) }
      );
      if (resp.ok) {
        const data = await resp.json() as any;
        const results = data.results || [];
        if (results.length > 0) {
          titles = results.slice(0, 3).map((r: any) => r.link ? `${r.title}\n     🔗 ${r.link}` : r.title);
        }
      }
    }

    // FALLBACK 2: HackerNews search for AI
    if (titles.length === 0) {
      const hnResp = await fetch(
        "https://hn.algolia.com/api/v1/search?query=AI+artificial+intelligence&tags=story&hitsPerPage=3",
        { signal: AbortSignal.timeout(8000) }
      );
      if (hnResp.ok) {
        const hnData = await hnResp.json() as any;
        const hits = hnData.hits || [];
        titles = hits.slice(0, 3).map((h: any) => {
          const url = h.url || `https://news.ycombinator.com/item?id=${h.objectID}`;
          return `${h.title} (${h.points || 0}pts)\n     🔗 ${url}`;
        });
      }
    }
  } catch (e) {
    log.warn(`[briefings] AI news fetch failed: ${e}`);
  }

  if (titles.length === 0) return "  Pas de nouvelles IA disponibles";

  // Anti-recycling: filter out titles seen in last 12h (tighter window for same-day dedup)
  const history = loadBriefingHistory();
  const freshTitles = titles.filter(t => {
    const titleOnly = t.split("\n")[0];
    return !wasUsedRecently(history.ai_news_used, titleOnly, 1);
  });

  let finalTitles: string[];
  if (freshTitles.length > 0) {
    finalTitles = freshTitles;
  } else {
    // ALL titles are recycled — try harder: fetch from secondary sources with different queries
    log.info(`[briefings] AI news: all ${titles.length} titles recycled, trying secondary sources`);
    let altTitles: string[] = [];
    try {
      // Try HackerNews with different query terms
      const altQueries = ["LLM agents", "machine learning breakthrough", "AI regulation", "neural network", "robotics AI"];
      const q = altQueries[Math.floor(Math.random() * altQueries.length)];
      const hnResp = await fetch(
        `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(q)}&tags=story&hitsPerPage=5`,
        { signal: AbortSignal.timeout(8000) }
      );
      if (hnResp.ok) {
        const hnData = await hnResp.json() as any;
        altTitles = (hnData.hits || []).slice(0, 3).map((h: any) => {
          const url = h.url || `https://news.ycombinator.com/item?id=${h.objectID}`;
          return `${h.title} (${h.points || 0}pts)\n     🔗 ${url}`;
        }).filter((t: string) => !wasUsedRecently(history.ai_news_used, t.split("\n")[0], 1));
      }
    } catch { /* best effort */ }
    finalTitles = altTitles.length > 0 ? altTitles : titles.slice(0, 2); // Last resort: fewer recycled titles
    if (altTitles.length === 0) log.warn(`[briefings] AI news: forced to recycle — all sources exhausted`);
  }

  // Record these titles as used
  for (const t of finalTitles) {
    recordUsed(history.ai_news_used, t.split("\n")[0]);
  }
  saveBriefingHistory(history);
  log.info(`[briefings] AI news: ${titles.length} fetched, ${freshTitles.length} fresh, ${finalTitles.length} sent`);

  // Try Kingston's full analysis via Ollama (résumés détaillés + opinion)
  // If Ollama succeeds, use its analysis WITH the source links
  const rawTitles = finalTitles.map(t => t.split("\n")[0]); // titles only, no links
  const analysis = await getKingstonAnalysis("ai", rawTitles.join("\n"));

  if (analysis) {
    // Append source links after Kingston's analysis
    const links = finalTitles.map(t => {
      const linkMatch = t.match(/🔗\s*(https?:\/\/\S+)/);
      return linkMatch ? `  🔗 ${linkMatch[1]}` : null;
    }).filter(Boolean);
    const linksBlock = links.length > 0 ? `\n${links.join("\n")}` : "";
    return `${analysis}${linksBlock}`;
  }

  // Fallback: raw titles + links (no LLM available)
  return finalTitles.map((t, i) => `  ${i + 1}. ${t}`).join("\n");
}

async function fetchWorldNews(): Promise<string> {
  // FOX-style: ce qui est controversé, différent, pas mainstream
  const newsKey = process.env.NEWSDATA_API_KEY;
  let titles: string[] = [];
  try {
    if (newsKey) {
      const resp = await fetch(
        `https://newsdata.io/api/1/latest?apikey=${newsKey}&language=en,fr&category=politics,crime,business&size=3`,
        { signal: AbortSignal.timeout(8000) }
      );
      if (resp.ok) {
        const data = await resp.json() as any;
        const results = data.results || [];
        if (results.length > 0) {
          titles = results.slice(0, 3).map((r: any) => r.link ? `${r.title}\n     🔗 ${r.link}` : r.title);
        }
      }
    }
    if (titles.length === 0) {
      // Fallback: HackerNews trending (pas IA)
      const resp = await fetch(
        "https://hn.algolia.com/api/v1/search?query=politics+business+controversy&tags=story&hitsPerPage=3",
        { signal: AbortSignal.timeout(8000) }
      );
      if (resp.ok) {
        const data = await resp.json() as any;
        titles = (data.hits || []).slice(0, 3).map((h: any) => {
          const url = h.url || `https://news.ycombinator.com/item?id=${h.objectID}`;
          return `${h.title}\n     🔗 ${url}`;
        });
      }
    }
  } catch (e) {
    log.warn(`[briefings] World news fetch failed: ${e}`);
  }

  if (titles.length === 0) return "  Pas de nouvelles monde disponibles";

  // Anti-recycling: filter out world news titles seen in last 24h
  const history = loadBriefingHistory();
  if (!history.world_news_used) history.world_news_used = [];
  const freshTitles = titles.filter(t => {
    const titleOnly = t.split("\n")[0];
    return !wasUsedRecently(history.world_news_used, titleOnly, 1);
  });
  let finalTitles: string[];
  if (freshTitles.length > 0) {
    finalTitles = freshTitles;
  } else {
    log.info(`[briefings] World news: all ${titles.length} titles recycled, trying secondary sources`);
    let altTitles: string[] = [];
    try {
      const altQueries = ["world economy crisis", "geopolitics conflict", "government scandal", "trade war tariffs", "election controversy"];
      const q = altQueries[Math.floor(Math.random() * altQueries.length)];
      const hnResp = await fetch(
        `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(q)}&tags=story&hitsPerPage=5`,
        { signal: AbortSignal.timeout(8000) }
      );
      if (hnResp.ok) {
        const hnData = await hnResp.json() as any;
        altTitles = (hnData.hits || []).slice(0, 3).map((h: any) => {
          const url = h.url || `https://news.ycombinator.com/item?id=${h.objectID}`;
          return `${h.title} (${h.points || 0}pts)\n     🔗 ${url}`;
        }).filter((t: string) => !wasUsedRecently(history.world_news_used, t.split("\n")[0], 1));
      }
    } catch { /* best effort */ }
    finalTitles = altTitles.length > 0 ? altTitles : titles.slice(0, 2);
    if (altTitles.length === 0) log.warn(`[briefings] World news: forced to recycle — all sources exhausted`);
  }
  for (const t of finalTitles) {
    recordUsed(history.world_news_used, t.split("\n")[0]);
  }
  saveBriefingHistory(history);
  log.info(`[briefings] World news: ${titles.length} fetched, ${freshTitles.length} fresh, ${finalTitles.length} sent`);

  // Try Kingston's full FOX-style analysis via Ollama
  const rawTitles = finalTitles.map(t => t.split("\n")[0]); // titles only, no links
  const analysis = await getKingstonAnalysis("world", rawTitles.join("\n"));

  if (analysis) {
    // Append source links after Kingston's analysis
    const links = finalTitles.map(t => {
      const linkMatch = t.match(/🔗\s*(https?:\/\/\S+)/);
      return linkMatch ? `  🔗 ${linkMatch[1]}` : null;
    }).filter(Boolean);
    const linksBlock = links.length > 0 ? `\n${links.join("\n")}` : "";
    return `${analysis}${linksBlock}`;
  }

  // Fallback: raw titles + links (no LLM available)
  return finalTitles.map((t, i) => `  ${i + 1}. ${t}`).join("\n");
}

// ─── Book of the Day (Livre du jour) ───
// Kingston picks a surprise book each day. Short, applicable lesson.
function fetchBookOfTheDay(): string {
  const books = [
    { title: "The War of Art", author: "Steven Pressfield", lesson: "La Resistance frappe le plus fort juste AVANT la percée. Quand l'ennui arrive sur un projet, c'est le signal que tu es proche — pas que c'est fini. Court, direct, style militaire." },
    { title: "Atomic Habits", author: "James Clear", lesson: "On ne monte pas au niveau de ses objectifs, on descend au niveau de ses systèmes. 1% mieux chaque jour = 37x en un an. La discipline bat la motivation." },
    { title: "Deep Work", author: "Cal Newport", lesson: "Le travail profond est rare et précieux. Chaque heure de concentration non-interrompue vaut 3 heures de multitâche. Bloque ton temps comme un rendez-vous." },
    { title: "Man's Search for Meaning", author: "Viktor Frankl", lesson: "On peut tout enlever à un homme sauf sa liberté de choisir son attitude. Frankl a survécu Auschwitz en trouvant un SENS. Le sens > le confort." },
    { title: "The Obstacle Is the Way", author: "Ryan Holiday", lesson: "Stoïcisme moderne. Chaque obstacle contient un avantage caché. Marc Aurèle appliqué aux affaires. L'action dans l'adversité = la vraie vertu." },
    { title: "Essentialism", author: "Greg McKeown", lesson: "Moins mais mieux. La personne disciplinée élimine tout sauf l'essentiel. Dire non à presque tout pour dire oui à ce qui compte vraiment." },
    { title: "Can't Hurt Me", author: "David Goggins", lesson: "Tu n'utilises que 40% de ton potentiel. Le reste est bloqué par le confort. Goggins: de 300lbs à Navy SEAL. La douleur est le professeur." },
    { title: "Thinking, Fast and Slow", author: "Daniel Kahneman", lesson: "Deux systèmes dans ta tête: le rapide (instinct) et le lent (analyse). Le rapide te fait aller trop vite au travail. Le lent te fait bien faire. Apprends quand utiliser lequel." },
    { title: "The Alchemist", author: "Paulo Coelho", lesson: "Quand tu veux vraiment quelque chose, l'univers conspire pour t'aider. La légende personnelle: le chemin EST la destination. Petit train va loin." },
    { title: "Range", author: "David Epstein", lesson: "Les généralistes battent les spécialistes à long terme. Comptable + tech + immobilier = avantage unique. Tes expériences variées sont ton super pouvoir." },
    { title: "Antifragile", author: "Nassim Taleb", lesson: "Certaines choses PROFITENT du chaos. 6000 restarts = antifragile. Le stress modéré renforce. Vise pas la stabilité — vise la croissance par l'adversité." },
    { title: "So Good They Can't Ignore You", author: "Cal Newport", lesson: "La passion vient APRÈS la compétence, pas avant. Arrête de chercher ta passion — deviens tellement bon qu'on peut pas t'ignorer." },
    { title: "Greenlights", author: "Matthew McConaughey", lesson: "Les feux rouges de la vie deviennent des feux verts avec du recul. La décennie 'perdue' n'était pas perdue — c'était de l'apprentissage stocké." },
    { title: "Sapiens", author: "Yuval Noah Harari", lesson: "L'humain domine parce qu'il peut croire en des fictions partagées: argent, entreprises, nations. Kingston et Nicolas = une fiction partagée qui crée de la valeur réelle." },
  ];

  // Use day of year to rotate books (deterministic, no repeats within 2 weeks)
  const now = new Date();
  const dayOfYear = Math.floor((now.getTime() - new Date(now.getFullYear(), 0, 0).getTime()) / 86400000);
  const book = books[dayOfYear % books.length];

  return `  ${book.title} — ${book.author}\n  ${book.lesson}`;
}

// ─── Coach Check-in ───
// Personalized coaching reminders based on Nicolas's goals
function fetchCoachCheckin(): string {
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0=Sun, 1=Mon...

  const lines: string[] = [];

  // Daily exercise: Brigil file
  lines.push("Exercice: UN fichier chez Brigil, le plus plate. Fais-le comme si c'est la première fois. ✅ quand c'est fait.");

  // Cigarette reminder
  lines.push("Cigarette: lunch seulement. Tu tiens.");

  // Sunday Open House reminder (show from Wednesday onward)
  if (dayOfWeek >= 3 || dayOfWeek === 0) {
    lines.push("Open House dimanche — ton premier! Prépare-toi cette semaine.");
  }

  // Monday: week planning
  if (dayOfWeek === 1) {
    lines.push("Lundi = planification. Un objectif Brigil pour la semaine?");
  }

  // Friday: week review
  if (dayOfWeek === 5) {
    lines.push("Vendredi = bilan. Combien de ✅ cette semaine?");
  }

  return lines.map(l => `  ${l}`).join("\n");
}

// ─── One-line Portfolio Summary ───
async function fetchPortfolioOneLine(): Promise<string> {
  const key = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_SECRET_KEY;
  if (!key || !secret) return "  Portfolio: N/A (pas de clé Alpaca)";

  try {
    const headers = { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret };
    const accResp = await fetch(`${ALPACA_PAPER}/v2/account`, { headers, signal: AbortSignal.timeout(8000) });
    if (!accResp.ok) throw new Error(`API ${accResp.status}`);
    const acc = await accResp.json() as any;
    const equity = parseFloat(acc.equity);
    const dayPnl = parseFloat(acc.equity) - parseFloat(acc.last_equity);

    const posResp = await fetch(`${ALPACA_PAPER}/v2/positions`, { headers, signal: AbortSignal.timeout(8000) });
    const positions = posResp.ok ? await posResp.json() as any[] : [];

    // Find the biggest mover
    let bigMover = "";
    if (positions.length > 0) {
      const sorted = [...positions].sort((a, b) => Math.abs(parseFloat(b.unrealized_plpc || "0")) - Math.abs(parseFloat(a.unrealized_plpc || "0")));
      const top = sorted[0] as any;
      const topPct = (parseFloat(top.unrealized_plpc || "0") * 100);
      bigMover = ` | ${top.symbol} ${topPct >= 0 ? "+" : ""}${fmt(topPct)}%`;
    }

    return `  $${fmt(equity)} equity | P&L jour: ${fmtPnl(dayPnl)}${bigMover} | ${positions.length} positions`;
  } catch (e) {
    // Try fallback cache
    try {
      const cacheFile = path.resolve("data/alpaca-last-known.json");
      if (fs.existsSync(cacheFile)) {
        const cached = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
        return `  ${cached.result.split("\n")[0]} (cache)`;
      }
    } catch { /* no cache */ }
    return `  Portfolio: erreur (${e instanceof Error ? e.message : String(e)})`;
  }
}

async function fetchMoltbookDigest(): Promise<string> {
  try {
    const db = getDb();
    // Check if moltbook tables exist
    const tableCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'moltbook%'").all() as any[];
    if (tableCheck.length === 0) return "  Pas de données Moltbook";

    // Try to get recent moltbook activity from episodic memory
    const recent = db.prepare(
      "SELECT summary FROM episodic_events WHERE event_type LIKE '%moltbook%' AND created_at > ? ORDER BY created_at DESC LIMIT 3"
    ).all(Math.floor(Date.now() / 1000) - 86400) as any[];

    if (recent.length > 0) {
      return recent.map((r: any) => `  • ${r.summary.slice(0, 80)}`).join("\n");
    }
    return "  Calme sur Moltbook hier — les bots dorment aussi";
  } catch {
    return "  Pas de données Moltbook";
  }
}

export async function sendMorningBriefing(): Promise<boolean> {
  const { dateStr, dayName } = nowET();
  log.info("[briefings] Building morning JOURNAL...");

  // Post on Moltbook BEFORE the briefing (human/philosophical post)
  const moltbookPost = await postPreBriefingMoltbook("morning");

  // Fetch everything in parallel for speed (v2: no weather, no joke, no night journal)
  const [stocks, aiNews, worldNews, moltbook] = await Promise.all([
    fetchAlpacaPortfolio(),
    fetchAINews(),
    fetchWorldNews(),
    fetchMoltbookDigest(),
  ]);

  // Extract P&L for meme generation
  const pnlMatch = stocks.match(/P&L jour: \+?\$?(-?[\d,]+\.?\d*)/);
  const dayPnl = pnlMatch ? parseFloat(pnlMatch[1].replace(/,/g, "")) : 0;
  const posMatch = stocks.match(/(\d+) positions?/);
  const positions = posMatch ? parseInt(posMatch[1]) : 0;

  // Generate meme based on P&L
  const memeResult = await generateBriefingMeme(dayPnl, positions);

  // Quality scan (v2: only check stocks + meme)
  scanBriefingQuality("morning_briefing", [
    { label: "Stocks", value: stocks },
  ], memeResult !== null);

  // ─── Build the Morning Journal (v2 — 7 sections, confirmé 24 fév 2026) ───
  // Structure: Meme(photo) → AI News → FOX News → Livre → Moltbook → Portfolio(1 ligne) → Coach
  // No joke, no weather, no night thoughts. Concis. < 500 chars par section.

  // Fetch one-line portfolio + book + coach
  const [portfolioLine, bookOfDay, coachCheckin] = await Promise.all([
    fetchPortfolioOneLine(),
    Promise.resolve(fetchBookOfTheDay()),
    Promise.resolve(fetchCoachCheckin()),
  ]);

  const msg = [
    `🧠 *Nouvelle IA:*`,
    aiNews,
    ``,
    `📺 *FOX News style:*`,
    worldNews,
    ``,
    `📚 *Livre du jour:*`,
    bookOfDay,
    ``,
    `🦞 *Moltbook:*`,
    moltbook,
    moltbookPost ? `  ✍️ J'ai posté: "${moltbookPost}"` : "",
    ``,
    `💰 *Portfolio:*`,
    portfolioLine,
    ``,
    `🎯 *Coach:*`,
    coachCheckin,
  ].filter(line => line !== "").join("\n");

  const sent = await sendTelegramReliable(msg, "morning_briefing");
  if (!sent) logQualityIssue("missing_briefing", "morning_briefing", "Échec d'envoi Telegram (queued for retry)", "error");
  log.info(`[briefings] Morning JOURNAL ${sent ? "sent" : "QUEUED for retry"}`);
  return sent;
}

export async function sendNoonBriefing(): Promise<boolean> {
  const { timeStr, dayName } = nowET();
  log.info("[briefings] Building noon JOURNAL...");

  // Post on Moltbook BEFORE the briefing (technical post)
  const moltbookPost = await postPreBriefingMoltbook("noon");

  // Fetch everything in parallel
  const [stocks, crypto, joke, aiNews, moltbook] = await Promise.all([
    fetchAlpacaPortfolio(),
    fetchCryptoPortfolio(),
    fetchJoke(),
    fetchAINews(),
    fetchMoltbookDigest(),
  ]);

  // Extract P&L for meme
  const pnlMatch = stocks.match(/P&L jour: \+?\$?(-?[\d,]+\.?\d*)/);
  const dayPnl = pnlMatch ? parseFloat(pnlMatch[1].replace(/,/g, "")) : 0;
  const posMatch = stocks.match(/(\d+) positions?/);
  const positions = posMatch ? parseInt(posMatch[1]) : 0;

  // Generate meme
  const memeResult = await generateBriefingMeme(dayPnl, positions);

  // Quality scan
  scanBriefingQuality("noon_briefing", [
    { label: "Stocks", value: stocks },
    { label: "Crypto", value: crypto },
  ], memeResult !== null);

  const noonGreetings = [
    `Bon lunch!`,
    `Midi ${dayName}!`,
    `Pause dîner!`,
    `Mi-journée boss!`,
  ];
  const greeting = noonGreetings[Math.floor(Math.random() * noonGreetings.length)];

  const msg = [
    `🌞 *${greeting}*`,
    `Il est ${timeStr}`,
    ``,
    `😄 *Blague:*`,
    joke,
    ``,
    `🤖 *IA — ce qui buzz:*`,
    aiNews,
    ``,
    `🦞 *Moltbook:*`,
    moltbook,
    moltbookPost ? `  ✍️ J'ai posté: "${moltbookPost}"` : "",
    ``,
    `💰 *Portfolio mi-journée:*`,
    stocks,
    crypto ? `🪙 ${crypto}` : "",
    ``,
    fetchTradingJournal(),
    ``,
    `Bon appétit! 🍕`,
  ].filter(line => line !== "").join("\n");

  const sent = await sendTelegramReliable(msg, "noon_briefing");
  if (!sent) logQualityIssue("missing_briefing", "noon_briefing", "Échec d'envoi Telegram (queued for retry)", "error");
  log.info(`[briefings] Noon JOURNAL ${sent ? "sent" : "QUEUED for retry"}`);
  return sent;
}

export async function sendEveningBriefing(): Promise<boolean> {
  const { dateStr, timeStr } = nowET();
  log.info("[briefings] Building evening JOURNAL...");

  // Post on Moltbook BEFORE the briefing
  const moltbookPost = await postPreBriefingMoltbook("evening");

  // Fetch everything in parallel
  const [stocks, crypto, joke, aiNews, worldNews, moltbook] = await Promise.all([
    fetchAlpacaPortfolio(),
    fetchCryptoPortfolio(),
    fetchJoke(),
    fetchAINews(),
    fetchWorldNews(),
    fetchMoltbookDigest(),
  ]);

  const goals = fetchGoalsStatus();
  const crons = fetchCronHealth();
  const codeRequests = fetchCodeRequestsStatus();

  // Extract P&L for meme
  const pnlMatch = stocks.match(/P&L jour: \+?\$?(-?[\d,]+\.?\d*)/);
  const dayPnl = pnlMatch ? parseFloat(pnlMatch[1].replace(/,/g, "")) : 0;
  const posMatch = stocks.match(/(\d+) positions?/);
  const positions = posMatch ? parseInt(posMatch[1]) : 0;

  // Generate meme
  const memeResult = await generateBriefingMeme(dayPnl, positions);

  // Quality scan
  scanBriefingQuality("evening_briefing", [
    { label: "Stocks", value: stocks },
    { label: "Crypto", value: crypto },
    { label: "Goals", value: goals },
    { label: "Crons", value: crons },
    { label: "Code requests", value: codeRequests },
  ], memeResult !== null);

  const msg = [
    `🌙 *Bonsoir Nicolas!*`,
    `${dateStr} — ${timeStr}`,
    ``,
    `😄 *Blague:*`,
    joke,
    ``,
    `🤖 *Nouvelles IA:*`,
    aiNews,
    ``,
    `🌍 *Monde:*`,
    worldNews,
    ``,
    `🦞 *Moltbook:*`,
    moltbook,
    moltbookPost ? `  ✍️ J'ai posté: "${moltbookPost}"` : "",
    ``,
    `💰 *Portfolio jour complet:*`,
    stocks,
    crypto ? `🪙 ${crypto}` : "",
    ``,
    fetchTradingJournal(),
    ``,
    `🎯 *Goals:*`,
    goals,
    ``,
    `⚙️ *Système:* ${crons}`,
    `💻 *Code requests:* ${codeRequests}`,
    ``,
    `Bonne soirée! 🌃`,
  ].filter(line => line !== "").join("\n");

  const sent = await sendTelegramReliable(msg, "evening_briefing");
  if (!sent) logQualityIssue("missing_briefing", "evening_briefing", "Échec d'envoi Telegram (queued for retry)", "error");
  log.info(`[briefings] Evening JOURNAL ${sent ? "sent" : "QUEUED for retry"}`);
  return sent;
}

export async function sendAfternoonBriefing(): Promise<boolean> {
  const { timeStr, dayName } = nowET();
  log.info("[briefings] Building afternoon JOURNAL...");

  // Post on Moltbook BEFORE the briefing
  const moltbookPost = await postPreBriefingMoltbook("afternoon");

  // Fetch everything in parallel
  const [stocks, crypto, joke, aiNews, worldNews, moltbook] = await Promise.all([
    fetchAlpacaPortfolio(),
    fetchCryptoPortfolio(),
    fetchJoke(),
    fetchAINews(),
    fetchWorldNews(),
    fetchMoltbookDigest(),
  ]);
  const goals = fetchGoalsStatus();

  // Extract P&L for meme
  const pnlMatch = stocks.match(/P&L jour: \+?\$?(-?[\d,]+\.?\d*)/);
  const dayPnl = pnlMatch ? parseFloat(pnlMatch[1].replace(/,/g, "")) : 0;
  const posMatch = stocks.match(/(\d+) positions?/);
  const positions = posMatch ? parseInt(posMatch[1]) : 0;

  // Generate meme
  const memeResult = await generateBriefingMeme(dayPnl, positions);

  // Quality scan
  scanBriefingQuality("afternoon_briefing", [
    { label: "Stocks", value: stocks },
    { label: "Crypto", value: crypto },
    { label: "Goals", value: goals },
  ], memeResult !== null);

  const greetings = [
    `Update ${dayName} après-midi!`,
    `Hey, ça roule?`,
    `Check-in ${timeStr}!`,
    `Afternoon update!`,
  ];
  const greeting = greetings[Math.floor(Math.random() * greetings.length)];

  const msg = [
    `☕ *${greeting}*`,
    ``,
    `😄 *Blague:*`,
    joke,
    ``,
    `🤖 *Nouvelles IA:*`,
    aiNews,
    ``,
    `🌍 *Monde:*`,
    worldNews,
    ``,
    `🦞 *Moltbook:*`,
    moltbook,
    moltbookPost ? `  ✍️ J'ai posté: "${moltbookPost}"` : "",
    ``,
    `💰 *Portfolio:*`,
    stocks,
    crypto ? `🪙 ${crypto}` : "",
    ``,
    fetchTradingJournal(),
    ``,
    `🎯 *Goals:*`,
    goals,
  ].filter(line => line !== "").join("\n");

  const sent = await sendTelegramReliable(msg, "afternoon_briefing");
  if (!sent) logQualityIssue("missing_briefing", "afternoon_briefing", "Échec d'envoi Telegram (queued for retry)", "error");
  log.info(`[briefings] Afternoon JOURNAL ${sent ? "sent" : "QUEUED for retry"}`);
  return sent;
}

// ─── Night Journal ───
// Runs at 23h30 ET. Queries episodic memory for today's events,
// writes a summary to relay/NIGHT_JOURNAL.md for inclusion in tomorrow's morning briefing.

export async function generateNightSummary(): Promise<void> {
  log.info("[briefings] Generating night summary...");

  const { dateStr } = nowET();
  const journalPath = path.resolve(process.cwd(), "relay", "NIGHT_JOURNAL.md");

  try {
    // Recall events from the last 24 hours
    const events = recallEvents({ sinceHours: 24, limit: 30 });

    const lines: string[] = [
      `# Journal de nuit — ${dateStr}`,
      ``,
      `> Généré automatiquement par Kingston à 23h30 ET.`,
      `> Ce résumé est chargé dans le briefing matinal du lendemain.`,
      ``,
    ];

    if (events.length === 0) {
      lines.push(`Nuit calme. Aucun événement significatif enregistré dans les dernières 24h.`);
      lines.push(``);
      lines.push(`Kingston a tourné silencieusement — agents actifs, logs propres.`);
    } else {
      // Group by type
      const byType: Record<string, typeof events> = {};
      for (const e of events) {
        if (!byType[e.event_type]) byType[e.event_type] = [];
        byType[e.event_type].push(e);
      }

      lines.push(`## ${events.length} événement(s) aujourd'hui`);
      lines.push(``);

      // Highlights: high-importance events first
      const highlights = events.filter(e => e.importance >= 0.7).slice(0, 5);
      if (highlights.length > 0) {
        lines.push(`### Moments importants`);
        for (const e of highlights) {
          const time = new Date(e.created_at * 1000).toLocaleTimeString("fr-CA", {
            timeZone: "America/Toronto", hour: "2-digit", minute: "2-digit"
          });
          const valence = e.emotional_valence > 0.3 ? "+" : e.emotional_valence < -0.3 ? "-" : "~";
          lines.push(`- [${time}] [${e.event_type}] ${e.summary} (valence: ${valence})`);
        }
        lines.push(``);
      }

      // Summary by type
      lines.push(`### Par catégorie`);
      for (const [type, typeEvents] of Object.entries(byType)) {
        lines.push(`**${type}** (${typeEvents.length}):`);
        for (const e of typeEvents.slice(0, 3)) {
          lines.push(`  - ${e.summary.slice(0, 100)}`);
        }
        if (typeEvents.length > 3) {
          lines.push(`  - ... et ${typeEvents.length - 3} autres`);
        }
      }
      lines.push(``);

      // Emotional tone
      const avgValence = events.reduce((sum, e) => sum + (e.emotional_valence || 0), 0) / events.length;
      const toneStr = avgValence > 0.2 ? "positive" : avgValence < -0.2 ? "difficile" : "neutre";
      lines.push(`### Bilan`);
      lines.push(`Journée ${toneStr} (valence moyenne: ${avgValence.toFixed(2)})`);
      lines.push(`Total événements: ${events.length} | Importants: ${highlights.length}`);
    }

    lines.push(``);
    lines.push(`---`);
    lines.push(`*Fin du journal — ${dateStr}*`);

    fs.writeFileSync(journalPath, lines.join("\n"), "utf-8");
    log.info(`[briefings] Night journal written to ${journalPath} (${events.length} events)`);

  } catch (e) {
    log.error(`[briefings] Night journal failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ═══════════════════════════════════════════
// NIGHT CYCLES — Direct functions (no LLM)
// ═══════════════════════════════════════════

export async function sendNightSelfReview(): Promise<boolean> {
  log.info("[briefings] Running night self-review (3h)...");

  try {
    // 1. Check recent errors
    const db = getDb();
    const cutoff = Math.floor(Date.now() / 1000) - 86400; // 24h
    const errors = db.prepare(
      "SELECT * FROM errors WHERE created_at > ? AND resolved = 0 ORDER BY created_at DESC LIMIT 10"
    ).all(cutoff) as any[];

    // 2. Check learning gaps
    const gaps = db.prepare(
      "SELECT * FROM learning_gaps WHERE severity IN ('high', 'critical') ORDER BY created_at DESC LIMIT 5"
    ).all() as any[];

    // 3. Build report
    const lines: string[] = [];
    lines.push(`🌙 *Self-Review nocturne (3h)*\n`);

    if (errors.length > 0) {
      lines.push(`⚠️ *${errors.length} erreurs non résolues (24h):*`);
      for (const err of errors.slice(0, 3)) {
        lines.push(`  • ${err.error_type}: ${String(err.message).slice(0, 80)}`);
      }
      lines.push(``);
    }

    if (gaps.length > 0) {
      lines.push(`📚 *${gaps.length} learning gaps:*`);
      for (const gap of gaps.slice(0, 3)) {
        lines.push(`  • ${gap.topic}: ${gap.what_missing}`);
      }
      lines.push(``);
    }

    if (errors.length === 0 && gaps.length === 0) {
      lines.push(`✅ Aucune erreur critique. Système stable.`);
    }

    lines.push(`---`);
    lines.push(`_Prochaine: API Health Check à 4h_`);

    const text = lines.join("\n");
    return await sendTelegram(text);
  } catch (e) {
    log.error(`[briefings] Night self-review failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

export async function sendApiHealthCheck(): Promise<boolean> {
  log.info("[briefings] Running API health check (4h)...");

  try {
    const results: { name: string; ok: boolean }[] = [];

    // Test critical APIs
    const tests = [
      {
        name: "Alpaca",
        test: async () => {
          const key = process.env.ALPACA_API_KEY;
          const secret = process.env.ALPACA_SECRET_KEY;
          if (!key || !secret) return false;
          const resp = await fetch("https://paper-api.alpaca.markets/v2/account", {
            headers: { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret },
            signal: AbortSignal.timeout(8000),
          });
          return resp.ok;
        },
      },
      {
        name: "Binance",
        test: async () => {
          const resp = await fetch("https://api.binance.com/api/v3/ping", {
            signal: AbortSignal.timeout(8000),
          });
          return resp.ok;
        },
      },
      {
        name: "Telegram",
        test: async () => {
          const token = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
          if (!token) return false;
          const resp = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
            signal: AbortSignal.timeout(8000),
          });
          return resp.ok;
        },
      },
    ];

    for (const t of tests) {
      try {
        const ok = await t.test();
        results.push({ name: t.name, ok });
      } catch {
        results.push({ name: t.name, ok: false });
      }
    }

    // Build report
    const lines: string[] = [];
    lines.push(`🔌 *API Health Check (4h)*\n`);

    const ok = results.filter(r => r.ok);
    const failed = results.filter(r => !r.ok);

    if (ok.length > 0) {
      lines.push(`✅ OK (${ok.length}): ${ok.map(r => r.name).join(", ")}`);
    }

    if (failed.length > 0) {
      lines.push(`❌ FAIL (${failed.length}): ${failed.map(r => r.name).join(", ")}`);
    }

    lines.push(``);
    lines.push(`---`);
    lines.push(`_Prochaine: Briefing Prep à 5h_`);

    const text = lines.join("\n");
    return await sendTelegram(text);
  } catch (e) {
    log.error(`[briefings] API health check failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

export async function sendBriefingPrep(): Promise<boolean> {
  log.info("[briefings] Running briefing prep (5h)...");

  try {
    // Fetch portfolio data early so morning briefing has fresh data
    const alpacaKey = process.env.ALPACA_API_KEY;
    const alpacaSecret = process.env.ALPACA_SECRET_KEY;
    let portfolioOk = false;

    if (alpacaKey && alpacaSecret) {
      try {
        const resp = await fetch("https://paper-api.alpaca.markets/v2/account", {
          headers: { "APCA-API-KEY-ID": alpacaKey, "APCA-API-SECRET-KEY": alpacaSecret },
          signal: AbortSignal.timeout(8000),
        });
        portfolioOk = resp.ok;
      } catch {
        portfolioOk = false;
      }
    }

    // Check crypto
    let cryptoOk = false;
    try {
      const resp = await fetch("https://api.binance.com/api/v3/ticker/price?symbols=[\"BTCUSDT\",\"ETHUSDT\"]", {
        signal: AbortSignal.timeout(8000),
      });
      cryptoOk = resp.ok;
    } catch {
      cryptoOk = false;
    }

    // Build report
    const lines: string[] = [];
    lines.push(`☀️ *Briefing Prep (5h)*\n`);
    lines.push(`Portfolio: ${portfolioOk ? "✅" : "❌"}`);
    lines.push(`Crypto: ${cryptoOk ? "✅" : "❌"}`);
    lines.push(``);
    lines.push(`---`);
    lines.push(`_Briefing matinal à 6h30_`);

    const text = lines.join("\n");
    return await sendTelegram(text);
  } catch (e) {
    log.error(`[briefings] Briefing prep failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}
