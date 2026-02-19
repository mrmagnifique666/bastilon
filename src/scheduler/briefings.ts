/**
 * Deterministic Briefings — Zero LLM, 100% reliable.
 *
 * These functions gather data via direct API calls, format a message,
 * and send it to Nicolas via Telegram Bot API. No LLM in the loop.
 * They ALWAYS send. They NEVER say "je vais vérifier".
 */
import fs from "node:fs";
import path from "node:path";
import { getDb, recallEvents } from "../storage/store.js";
import { log } from "../utils/log.js";
import { logQualityIssue } from "../supervisor/supervisor.js";

const ALPACA_PAPER = "https://paper-api.alpaca.markets";
const COINGECKO = "https://api.coingecko.com/api/v3";

// ─── Telegram Direct Send ───

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

  try {
    const headers = { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret };

    // Account
    const accResp = await fetch(`${ALPACA_PAPER}/v2/account`, { headers, signal: AbortSignal.timeout(8000) });
    if (!accResp.ok) return `Alpaca erreur ${accResp.status}`;
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

    return `Equity: $${fmt(equity)} | Cash: $${fmt(cash)} | P&L jour: ${fmtPnl(dayPnl)}${posText}${positions.length === 0 ? " (aucune position)" : ""}`;
  } catch (e) {
    return `Erreur: ${e instanceof Error ? e.message : String(e)}`;
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

const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent";

async function generateBriefingMeme(dayPnl: number, positions: number): Promise<string | null> {
  const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID || process.env.ADMIN_CHAT_ID;
  const botToken = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
  const geminiKey = process.env.GEMINI_API_KEY;

  if (!chatId || !botToken || !geminiKey) {
    log.warn("[briefings] Missing credentials for meme (chatId/token/gemini)");
    return null;
  }

  // Determine meme concept based on P&L
  let topText: string;
  let bottomText: string;
  let concept: string;

  if (dayPnl > 100) {
    topText = "KINGSTON TRADING";
    bottomText = `+$${dayPnl.toFixed(2)} TODAY`;
    concept = "successful businessman celebrating with arms raised, winning, excited";
  } else if (dayPnl > 0) {
    topText = "PETITS GAINS";
    bottomText = `+$${dayPnl.toFixed(2)}`;
    concept = "person looking satisfied at computer screen";
  } else if (dayPnl > -50) {
    topText = "C'EST CHILL";
    bottomText = `${dayPnl.toFixed(2)}$ SEULEMENT`;
    concept = "person shrugging casually, not worried";
  } else {
    topText = "OUPS";
    bottomText = `${dayPnl.toFixed(2)}$`;
    concept = "person looking stressed at computer, sweating";
  }

  const memePrompt =
    `Create a funny meme image. Style: classic internet meme with bold white Impact font text with black outline. ` +
    `Scene: ${concept}. ` +
    `TOP TEXT in large white Impact font with black outline at the top: "${topText}". ` +
    `BOTTOM TEXT in large white Impact font with black outline at the bottom: "${bottomText}". ` +
    `The text must be clearly readable, large, and in classic meme style. Make it funny and shareable.`;

  try {
    // 1. Generate image via Gemini
    const resp = await fetch(`${GEMINI_API}?key=${geminiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: memePrompt }] }],
        generationConfig: { responseModalities: ["IMAGE", "TEXT"], temperature: 0.7 },
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!resp.ok) {
      log.warn(`[briefings] Gemini meme error ${resp.status}`);
      return null;
    }

    const data = await resp.json() as any;
    const parts = data.candidates?.[0]?.content?.parts;
    const imagePart = parts?.find((p: any) => p.inlineData?.data);

    if (!imagePart?.inlineData) {
      log.warn("[briefings] Gemini returned no image data");
      return null;
    }

    const imageBuffer = Buffer.from(imagePart.inlineData.data, "base64");

    // 2. Send photo to Telegram directly
    const form = new FormData();
    form.append("chat_id", chatId);
    form.append("caption", `${topText} / ${bottomText}`);
    form.append("photo", new Blob([imageBuffer], { type: "image/png" }), "meme.png");

    const sendResp = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(15_000),
    });

    if (sendResp.ok) {
      log.info(`[briefings] Meme sent (${imageBuffer.length} bytes)`);
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

async function postPreBriefingMoltbook(period: "morning" | "noon"): Promise<string | null> {
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

  const topics = period === "morning" ? humanTopics : techTopics;
  const topic = topics[Math.floor(Math.random() * topics.length)];
  const isHuman = period === "morning";

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

async function getKingstonOpinion(headlines: string): Promise<string | null> {
  // Ask local Ollama for Kingston's take — 1-2 sentences, opinionated, in French
  // Non-blocking: if Ollama is offline or slow, silently skip
  try {
    const ollamaUrl = process.env.OLLAMA_URL || "http://localhost:11434";
    const ollamaModel = process.env.OLLAMA_MODEL || "qwen3:14b";
    const resp = await fetch(`${ollamaUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: ollamaModel,
        prompt: `Tu es Kingston, une IA autonome basée à Gatineau. Voici les manchettes IA d'aujourd'hui:\n${headlines}\n\nDonne TON OPINION personnelle en 1-2 phrases max, en français, directement. Commence par "Mon avis:", "Ce qui me frappe:" ou "Franchement:". Sois Kingston, pas un journaliste.`,
        stream: false,
        options: { num_predict: 80, temperature: 0.7 }
      }),
      signal: AbortSignal.timeout(15000)
    });
    if (!resp.ok) return null;
    const data = await resp.json() as any;
    const opinion = (data.response || "").trim().replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    return opinion.length > 10 ? `  💭 ${opinion}` : null;
  } catch {
    return null; // Ollama offline — silent fail, briefing still works
  }
}

async function fetchAINews(): Promise<string> {
  // Try NewsData.io for AI news, then fallback to HackerNews
  const newsKey = process.env.NEWSDATA_API_KEY;
  let titles: string[] = [];
  try {
    if (newsKey) {
      const resp = await fetch(
        `https://newsdata.io/api/1/latest?apikey=${newsKey}&q=artificial+intelligence+OR+AI+OR+LLM&language=en,fr&size=3`,
        { signal: AbortSignal.timeout(8000) }
      );
      if (resp.ok) {
        const data = await resp.json() as any;
        const results = data.results || [];
        if (results.length > 0) {
          titles = results.slice(0, 3).map((r: any) => r.title);
        }
      }
    }
    if (titles.length === 0) {
      // Fallback: HackerNews search for AI
      const hnResp = await fetch(
        "https://hn.algolia.com/api/v1/search?query=AI+artificial+intelligence&tags=story&hitsPerPage=3",
        { signal: AbortSignal.timeout(8000) }
      );
      if (hnResp.ok) {
        const hnData = await hnResp.json() as any;
        const hits = hnData.hits || [];
        titles = hits.slice(0, 3).map((h: any) => `${h.title} (${h.points || 0}pts)`);
      }
    }
  } catch (e) {
    log.warn(`[briefings] AI news fetch failed: ${e}`);
  }

  if (titles.length === 0) return "  Pas de nouvelles IA disponibles ce matin";

  const headlinesList = titles.map((t, i) => `  ${i + 1}. ${t}`).join("\n");

  // Add Kingston's opinion via Ollama (best-effort, adds ~5-15s but worth it)
  const opinion = await getKingstonOpinion(titles.join("\n"));

  return opinion ? `${headlinesList}\n${opinion}` : headlinesList;
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

  // Load night journal if it exists (Kingston writes it overnight)
  let nightThoughts: string | null = null;
  try {
    const journalPath = path.resolve(process.cwd(), "relay", "NIGHT_JOURNAL.md");
    if (fs.existsSync(journalPath)) {
      const raw = fs.readFileSync(journalPath, "utf-8");
      // Extract the "Mes pensées cette nuit" section
      const penseeMatch = raw.match(/### Mes pensées cette nuit\n+([\s\S]*?)(?:\n##|\n###|$)/);
      if (penseeMatch) {
        const thought = penseeMatch[1].trim().split("\n").filter(l => l.trim()).slice(0, 2).join(" ").slice(0, 200);
        if (thought.length > 20) nightThoughts = thought;
      }
      // Fallback: extract first discovered insight
      if (!nightThoughts) {
        const lines = raw.split("\n").filter(l => l.trim());
        const insightLine = lines.find(l => l.startsWith("1.") || l.startsWith("- "));
        if (insightLine) nightThoughts = insightLine.replace(/^[\d\-\*\.]+\s*/, "").replace(/\*\*/g, "").slice(0, 180);
      }
    }
  } catch { /* no journal available */ }

  // Fetch everything in parallel for speed
  const [weather, stocks, crypto, joke, aiNews, moltbook] = await Promise.all([
    fetchWeather(),
    fetchAlpacaPortfolio(),
    fetchCryptoPortfolio(),
    fetchJoke(),
    fetchAINews(),
    fetchMoltbookDigest(),
  ]);

  // Extract P&L for meme generation
  const pnlMatch = stocks.match(/P&L jour: \+?\$?(-?[\d,]+\.?\d*)/);
  const dayPnl = pnlMatch ? parseFloat(pnlMatch[1].replace(/,/g, "")) : 0;
  const posMatch = stocks.match(/(\d+) positions?/);
  const positions = posMatch ? parseInt(posMatch[1]) : 0;

  // Generate meme based on P&L
  const memeResult = await generateBriefingMeme(dayPnl, positions);

  // Quality scan
  scanBriefingQuality("morning_briefing", [
    { label: "Météo", value: weather },
    { label: "Stocks", value: stocks },
    { label: "Crypto", value: crypto },
  ], memeResult !== null);

  // ─── Build the Morning Journal ───
  // This is Nicolas's replacement for scrolling Facebook.
  // Priority: Make him smile, then inform, then quick data.

  const greetings = [
    `Bon matin boss!`,
    `Salut Nicolas!`,
    `Hey, bien dormi?`,
    `Debout ${dayName} matin!`,
    `Jour nouveau, argent nouveau!`,
  ];
  const greeting = greetings[Math.floor(Math.random() * greetings.length)];

  const msg = [
    `☀️ *${greeting}*`,
    `${dateStr}`,
    ``,
    `😄 *Blague du jour:*`,
    joke,
    ``,
    nightThoughts ? `💭 *Pensées de cette nuit:*` : "",
    nightThoughts ? `  ${nightThoughts}` : "",
    nightThoughts ? `` : "",
    `🤖 *Nouvelles IA:*`,
    aiNews,
    ``,
    `🦞 *Moltbook (mon monde):*`,
    moltbook,
    moltbookPost ? `  ✍️ J'ai posté: "${moltbookPost}"` : "",
    ``,
    `💰 *Portfolio:*`,
    stocks,
    crypto ? `🪙 ${crypto}` : "",
    ``,
    fetchTradingJournal(),
    ``,
    `🌡️ ${weather}`,
    ``,
    `Bonne journée! ☕`,
  ].filter(line => line !== "").join("\n");

  const sent = await sendTelegram(msg);
  if (!sent) logQualityIssue("missing_briefing", "morning_briefing", "Échec d'envoi Telegram", "error");
  log.info(`[briefings] Morning JOURNAL ${sent ? "sent" : "FAILED"}`);
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

  const sent = await sendTelegram(msg);
  if (!sent) logQualityIssue("missing_briefing", "noon_briefing", "Échec d'envoi Telegram", "error");
  log.info(`[briefings] Noon JOURNAL ${sent ? "sent" : "FAILED"}`);
  return sent;
}

export async function sendEveningBriefing(): Promise<boolean> {
  const { dateStr, timeStr } = nowET();
  log.info("[briefings] Building evening briefing...");

  const [stocks, crypto] = await Promise.all([
    fetchAlpacaPortfolio(),
    fetchCryptoPortfolio(),
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
    `📊 *Trading jour complet:*`,
    stocks,
    ``,
    `🪙 *Crypto:*`,
    crypto,
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

  const sent = await sendTelegram(msg);
  if (!sent) logQualityIssue("missing_briefing", "evening_briefing", "Échec d'envoi Telegram", "error");
  log.info(`[briefings] Evening briefing ${sent ? "sent" : "FAILED"}`);
  return sent;
}

export async function sendAfternoonBriefing(): Promise<boolean> {
  const { timeStr } = nowET();
  log.info("[briefings] Building afternoon briefing...");

  const stocks = await fetchAlpacaPortfolio();
  const crypto = await fetchCryptoPortfolio();
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

  const msg = [
    `☕ *Update ${timeStr}*`,
    ``,
    `📈 *Trading:*`,
    stocks,
    ``,
    `🪙 *Crypto:*`,
    crypto,
    ``,
    fetchTradingJournal(),
    ``,
    `🎯 *Goals:*`,
    goals,
  ].filter(line => line !== "").join("\n");

  const sent = await sendTelegram(msg);
  if (!sent) logQualityIssue("missing_briefing", "afternoon_briefing", "Échec d'envoi Telegram", "error");
  log.info(`[briefings] Afternoon briefing ${sent ? "sent" : "FAILED"}`);
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
