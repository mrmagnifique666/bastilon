/**
 * Autonomous Crypto Trading Engine v3 — Micro-Cap Momentum (MCM)
 *
 * Strategy: Kingston Micro-Cap Momentum v1.1 (RSI Rising Filter)
 * - Scans Binance ALL USDT pairs for top movers (dynamic, not 4 hardcoded coins)
 * - ATR-based stops/TP/trailing (adapts to each coin's real volatility)
 * - RSI MUST be rising (current > 3 candles ago) — Nicolas rule 2026-02-24
 * - Targets coins with >5% daily move + decent volume ($500K-$50M)
 * - Position sizing: risk max 1.5% of portfolio per trade
 * - Scale out: 50% at 2x ATR, trail rest at 2x ATR from high
 * - Max 3 concurrent positions, 50% max exposure
 * - Hold max 2h, circuit breaker after 3 consecutive losses
 *
 * Skills: crypto_auto.tick, crypto_auto.status, crypto_auto.toggle, crypto_auto.signals
 */
import { registerSkill } from "../loader.js";
import { getDb } from "../../storage/store.js";
import { log } from "../../utils/log.js";

// ─── Configuration ───

// Discovery filters
const MIN_24H_CHANGE = 5;           // Min 5% daily move
const MIN_QUOTE_VOLUME = 2_000_000;  // Min $2M daily USDT volume (raised from $500K — filters illiquid coins like ELF)
const MAX_QUOTE_VOLUME = 50_000_000;// Max $50M (skip mega-caps)
const EXCLUDED_BASES = new Set([
  "USDC", "BUSD", "TUSD", "DAI", "FDUSD", "USDD", "USDP",   // stablecoins
  "WBTC", "WETH", "STETH", "WBETH", "CBETH",                  // wrapped
]);

// ATR
const ATR_PERIOD = 14;
const ATR_INTERVAL = "1h";
const MIN_ATR_PCT = 0.5;
const MAX_ATR_PCT = 20;

// Risk
const RISK_PER_TRADE = 0.015;     // 1.5% portfolio risk per trade
const MAX_POSITIONS = 3;
const MAX_EXPOSURE_PCT = 0.50;    // 50% of portfolio max
const STOP_ATR_MULT = 1.5;       // SL at 1.5x ATR
const TP_ATR_MULT = 3.0;         // TP at 3x ATR
const SCALE_OUT_ATR = 2.0;       // Scale out 50% at 2x ATR
const TRAILING_ATR_MULT = 2.0;   // Trail at 2x ATR from high

// Time
const MAX_HOLD_MS = 2 * 60 * 60 * 1000; // 2 hours (micro-caps are pump-and-dump prone)
const COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24h cooldown per symbol after exit (prevents ELF-style re-entry loops)
const MIN_RSI_DELTA = 3;  // RSI must rise by at least +3 points — "faut qu'il y ait du gaz dans la tank" (Nicolas, 26 fév)

// Circuit breakers
const MAX_DAILY_LOSS_PCT = -0.05;
const CIRCUIT_BREAKER_LOSSES = 3;
const MIN_BUY_SCORE = 6;         // Minimum 6/10 to enter (Nicolas scoring system 2026-02-26)
const CANDIDATE_LIMIT = 10;
const MAX_SIGNALS = 50;

// ─── Types ───

interface Candidate {
  symbol: string;       // "DOGEUSDT"
  base: string;         // "DOGE"
  price: number;
  change24h: number;
  volume24h: number;    // USDT volume
  atr: number;
  atrPct: number;
  rsi: number | null;
  rsiPrev: number | null;  // RSI 3 candles ago — for slope detection
  volTrend: number;     // ratio of last candle volume vs average (>1 = above avg)
}

interface PosMeta {
  atr: number;
  stopPrice: number;
  tpPrice: number;
  scaleOutPrice: number;
  scaledOut: boolean;
  highWater: number;
}

interface Signal {
  ts: number;
  symbol: string;
  action: string;
  confidence: number;
  reason: string;
  price: number;
  executed: boolean;
}

// ─── State ───

const posMeta: Record<string, PosMeta> = {};
const cooldownMap: Record<string, number> = {}; // symbol → timestamp of last close (prevents re-entry loops)
const signals: Signal[] = [];
let enabled = true;
let scanOnly = false; // LIVE mode — Nicolas approved 2026-02-22
let consLosses = 0;
let dailyPnl = 0;
let dailyDate = "";
let lastTickTs = 0;
let lastCandidates: Candidate[] = [];

// ─── Helpers ───

function fmt(n: number, d = 2): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}
function fmtPnl(n: number): string { return `${n >= 0 ? "+" : ""}$${fmt(n)}`; }

function nowET() {
  const d = new Date();
  const hour = parseInt(new Intl.DateTimeFormat("en-US", { timeZone: "America/Toronto", hour: "numeric", hour12: false }).format(d));
  const dateStr = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(d);
  return { hour, dateStr };
}

async function alert(text: string) {
  try {
    const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID || process.env.ADMIN_CHAT_ID;
    const token = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
    if (!chatId || !token) return;
    for (const pm of ["Markdown", undefined] as const) {
      const body: Record<string, unknown> = { chat_id: chatId, text };
      if (pm) body.parse_mode = pm;
      const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
      });
      if (r.ok) return;
      if (pm && r.status === 400) continue;
      return;
    }
  } catch {}
}

function addSignal(s: Signal) {
  signals.unshift(s);
  if (signals.length > MAX_SIGNALS) signals.length = MAX_SIGNALS;
}

// ─── Market Scanning (Binance public API — no auth) ───

async function scanMarket(): Promise<Candidate[]> {
  const url = "https://api.binance.com/api/v3/ticker/24hr";
  const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!resp.ok) throw new Error(`Binance ticker ${resp.status}`);
  const tickers = await resp.json() as any[];

  // Filter USDT pairs with big moves and decent volume
  const raw = tickers
    .filter((t: any) => {
      const sym = String(t.symbol);
      if (!sym.endsWith("USDT")) return false;
      const base = sym.replace("USDT", "");
      if (EXCLUDED_BASES.has(base)) return false;
      const chg = parseFloat(t.priceChangePercent);
      const vol = parseFloat(t.quoteVolume);
      // Only positive movers (we go long only) with real volume
      return chg >= MIN_24H_CHANGE && vol >= MIN_QUOTE_VOLUME && vol <= MAX_QUOTE_VOLUME;
    })
    .map((t: any) => ({
      symbol: String(t.symbol),
      base: String(t.symbol).replace("USDT", ""),
      price: parseFloat(t.lastPrice),
      change24h: parseFloat(t.priceChangePercent),
      volume24h: parseFloat(t.quoteVolume),
      atr: 0, atrPct: 0, rsi: null as number | null, rsiPrev: null as number | null, volTrend: 1,
    }))
    .sort((a, b) => b.change24h - a.change24h) // Biggest gainers first
    .slice(0, CANDIDATE_LIMIT * 2);

  // Fetch ATR for top candidates (batches of 5)
  const result: Candidate[] = [];
  for (let i = 0; i < raw.length; i += 5) {
    const batch = raw.slice(i, i + 5);
    const settled = await Promise.allSettled(batch.map(async (c) => {
      const data = await fetchATR(c.symbol);
      if (data) {
        c.atr = data.atr;
        c.atrPct = (data.atr / c.price) * 100;
        c.rsi = data.rsi;
        c.rsiPrev = data.rsiPrev;
        c.volTrend = data.volTrend;
      }
      return c;
    }));
    for (const r of settled) {
      if (r.status === "fulfilled" && r.value.atr > 0
          && r.value.atrPct >= MIN_ATR_PCT && r.value.atrPct <= MAX_ATR_PCT) {
        result.push(r.value);
      }
    }
    if (result.length >= CANDIDATE_LIMIT) break;
  }
  return result.slice(0, CANDIDATE_LIMIT);
}

async function fetchATR(symbol: string): Promise<{ atr: number; rsi: number | null; rsiPrev: number | null; volTrend: number } | null> {
  try {
    // Fetch 30 candles to have enough data for RSI slope (current vs 3 candles ago)
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${ATR_INTERVAL}&limit=30`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!resp.ok) return null;
    const klines = await resp.json() as any[];
    if (klines.length < ATR_PERIOD + 1) return null;

    // ATR = average of True Range over ATR_PERIOD
    const trs: number[] = [];
    for (let i = 1; i < klines.length; i++) {
      const h = parseFloat(klines[i][2]);
      const l = parseFloat(klines[i][3]);
      const pc = parseFloat(klines[i - 1][4]);
      trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
    const atr = trs.slice(-ATR_PERIOD).reduce((a, b) => a + b, 0) / ATR_PERIOD;

    // RSI helper — calculates RSI from a slice of closes
    const calcRsi = (closes: number[]): number | null => {
      if (closes.length < 15) return null;
      let avgG = 0, avgL = 0;
      for (let i = closes.length - 14; i < closes.length; i++) {
        const d = closes[i] - closes[i - 1];
        if (d > 0) avgG += d; else avgL += Math.abs(d);
      }
      avgG /= 14; avgL /= 14;
      return avgL === 0 ? 100 : 100 - (100 / (1 + avgG / avgL));
    };

    const closes = klines.map((k: any) => parseFloat(k[4]));
    // Current RSI (all closes)
    const rsi = calcRsi(closes);
    // RSI 3 candles ago (drop last 3 closes)
    const rsiPrev = closes.length >= 18 ? calcRsi(closes.slice(0, -3)) : null;

    // Volume trend: last candle volume vs average of prior candles
    const volumes = klines.map((k: any) => parseFloat(k[5])); // base asset volume
    const avgVol = volumes.slice(0, -1).reduce((a, b) => a + b, 0) / (volumes.length - 1);
    const lastVol = volumes[volumes.length - 1];
    const volTrend = avgVol > 0 ? lastVol / avgVol : 1;

    return { atr, rsi, rsiPrev, volTrend };
  } catch { return null; }
}

// ─── Strategy ───

/**
 * Kingston Confidence Score — 0 to 10 (Nicolas system, 2026-02-26)
 *
 * | Factor           | Max  | Logic                                              |
 * |------------------|------|----------------------------------------------------|
 * | Momentum         | 2.0  | Sweet spot 5-15% = 2, hot 15-30% = 1, pump = 0.5  |
 * | RSI Zone         | 2.0  | 40-65 rising = 2, reversal = 1.5, warm = 1, OB = 0 |
 * | RSI Delta        | 1.5  | +8 = 1.5, +5 = 1, +3 = 0.5                        |
 * | Volume (24h)     | 1.5  | >$10M = 1.5, >$5M = 1, >$2M = 0.5                 |
 * | ATR Quality      | 1.0  | 2-8% = 1, else 0.5                                 |
 * | Volume Trend     | 1.0  | Last candle vol > avg = 1, else 0                  |
 * | Risk/Reward      | 1.0  | TP/SL ratio > 2 = 1, > 1.5 = 0.5                  |
 * | TOTAL            | 10.0 | Min 6/10 to enter                                  |
 */
function evaluate(c: Candidate): { confidence: number; score: number; breakdown: string; reason: string } | null {
  let score = 0;
  const parts: string[] = [];  // detailed breakdown
  const why: string[] = [];     // compact reason

  // ── HARD FILTERS (instant reject) ──

  // RSI must exist
  if (c.rsi === null) return null;

  const rsiDelta = c.rsiPrev !== null ? c.rsi - c.rsiPrev : 0;
  const rsiRising = c.rsiPrev !== null && c.rsi > c.rsiPrev;

  // RSI must be rising
  if (!rsiRising) return null;
  // RSI delta must be >= MIN_RSI_DELTA
  if (rsiDelta < MIN_RSI_DELTA) return null;

  // ── FACTOR 1: Momentum (0-2 pts) ──
  if (c.change24h >= 5 && c.change24h <= 15) {
    score += 2;
    parts.push(`Mom:2.0`);
    why.push(`+${fmt(c.change24h, 1)}% 24h`);
  } else if (c.change24h > 15 && c.change24h <= 30) {
    score += 1;
    parts.push(`Mom:1.0`);
    why.push(`+${fmt(c.change24h, 1)}% (hot)`);
  } else if (c.change24h > 30) {
    score += 0.5;
    parts.push(`Mom:0.5`);
    why.push(`+${fmt(c.change24h, 1)}% (pump?)`);
  }

  // ── FACTOR 2: RSI Zone (0-2 pts) ──
  if (c.rsi >= 40 && c.rsi <= 65) {
    score += 2;
    parts.push(`RSI:2.0`);
    why.push(`RSI ${fmt(c.rsi, 0)}\u2191`);
  } else if (c.rsi < 40) {
    score += 1.5; // rising from oversold = reversal
    parts.push(`RSI:1.5`);
    why.push(`RSI ${fmt(c.rsi, 0)}\u2191 rev`);
  } else if (c.rsi > 65 && c.rsi <= 75) {
    score += 1;
    parts.push(`RSI:1.0`);
    why.push(`RSI ${fmt(c.rsi, 0)}\u2191 warm`);
  } else if (c.rsi > 75) {
    score += 0; // overbought = no points
    parts.push(`RSI:0`);
    why.push(`RSI ${fmt(c.rsi, 0)}\u2191 OB`);
  }

  // ── FACTOR 3: RSI Delta / Momentum Strength (0-1.5 pts) ──
  if (rsiDelta >= 8) {
    score += 1.5;
    parts.push(`\u0394RSI:1.5`);
  } else if (rsiDelta >= 5) {
    score += 1;
    parts.push(`\u0394RSI:1.0`);
  } else if (rsiDelta >= MIN_RSI_DELTA) {
    score += 0.5;
    parts.push(`\u0394RSI:0.5`);
  }
  why.push(`\u0394+${fmt(rsiDelta, 1)}`);

  // ── FACTOR 4: Volume 24h (0-1.5 pts) ──
  if (c.volume24h >= 10_000_000) {
    score += 1.5;
    parts.push(`Vol:1.5`);
  } else if (c.volume24h >= 5_000_000) {
    score += 1;
    parts.push(`Vol:1.0`);
  } else {
    score += 0.5;
    parts.push(`Vol:0.5`);
  }
  why.push(`Vol $${fmt(c.volume24h / 1e6, 1)}M`);

  // ── FACTOR 5: ATR Quality (0-1 pt) ──
  if (c.atrPct >= 2 && c.atrPct <= 8) {
    score += 1;
    parts.push(`ATR:1.0`);
  } else {
    score += 0.5;
    parts.push(`ATR:0.5`);
  }
  why.push(`ATR ${fmt(c.atrPct, 1)}%`);

  // ── FACTOR 6: Volume Trend (0-1 pt) ──
  if (c.volTrend > 1.2) {
    score += 1;
    parts.push(`VT:1.0`);
  } else if (c.volTrend > 0.8) {
    score += 0.5;
    parts.push(`VT:0.5`);
  } else {
    parts.push(`VT:0`);
  }

  // ── FACTOR 7: Risk/Reward Setup (0-1 pt) ──
  const stopDist = STOP_ATR_MULT * c.atr;
  const tpDist = TP_ATR_MULT * c.atr;
  const rrRatio = stopDist > 0 ? tpDist / stopDist : 0;
  if (rrRatio >= 2) {
    score += 1;
    parts.push(`RR:1.0`);
  } else if (rrRatio >= 1.5) {
    score += 0.5;
    parts.push(`RR:0.5`);
  } else {
    parts.push(`RR:0`);
  }

  // Round to 1 decimal
  score = Math.round(score * 10) / 10;

  const breakdown = `[${score}/10] ${parts.join(" ")}`;
  const reason = why.join("; ");

  // Confidence 0-100 mapped from 0-10 for backward compat
  const confidence = Math.round(score * 10);

  return score >= MIN_BUY_SCORE ? { confidence, score, breakdown, reason } : null;
}

// ─── DB ───

function openPositions(): any[] {
  return getDb().prepare("SELECT * FROM crypto_paper_positions WHERE status = 'open' ORDER BY opened_at DESC").all();
}

function getAccount(): { balance: number; initial_balance: number } {
  const d = getDb();
  let acc = d.prepare("SELECT * FROM crypto_paper_account WHERE id = 1").get() as any;
  if (!acc) {
    d.prepare("INSERT INTO crypto_paper_account (id, balance, initial_balance) VALUES (1, 10000.0, 10000.0)").run();
    acc = { balance: 10000.0, initial_balance: 10000.0 };
  }
  return acc;
}

// ─── Execution ───

function buyExec(c: Candidate, conf: number, reason: string, scoreInfo?: { score: number; breakdown: string }): string {
  const d = getDb();
  const acc = getAccount();

  // ATR-based sizing: risk / stop_distance
  const riskAmt = acc.balance * RISK_PER_TRADE;
  const stopDist = STOP_ATR_MULT * c.atr;
  if (stopDist <= 0) return `Skip ${c.base}: ATR zero`;
  const maxQty = riskAmt / stopDist;
  const amount = Math.min(maxQty * c.price, acc.balance * MAX_EXPOSURE_PCT / MAX_POSITIONS);

  if (amount < 10) return `Skip ${c.base}: cash $${fmt(acc.balance)}`;
  if (amount > acc.balance * 0.95) return `Skip ${c.base}: exceeds cash`;

  const qty = amount / c.price;
  const stopP = c.price - stopDist;
  const tpP = c.price + (TP_ATR_MULT * c.atr);
  const scaleP = c.price + (SCALE_OUT_ATR * c.atr);

  const scoreTag = scoreInfo ? ` | Score: ${scoreInfo.score}/10` : "";
  const scoreBreakdown = scoreInfo ? ` ${scoreInfo.breakdown}` : "";

  d.prepare("INSERT INTO crypto_paper_trades (symbol, side, quantity, price, total, reasoning) VALUES (?, 'buy', ?, ?, ?, ?)")
    .run(c.symbol, qty, c.price, amount, `[MCM] ${reason}${scoreTag} | SL $${fmt(stopP)} TP $${fmt(tpP)}`);
  d.prepare("INSERT INTO crypto_paper_positions (symbol, quantity, avg_price, current_price, status) VALUES (?, ?, ?, ?, 'open')")
    .run(c.symbol, qty, c.price, c.price);
  d.prepare("UPDATE crypto_paper_account SET balance = balance - ?, updated_at = unixepoch() WHERE id = 1").run(amount);

  posMeta[c.symbol] = { atr: c.atr, stopPrice: stopP, tpPrice: tpP, scaleOutPrice: scaleP, scaledOut: false, highWater: c.price };

  const msg = `🟢 *MCM BUY ${c.base}* ${scoreInfo ? `(${scoreInfo.score}/10)` : ""}\n${fmt(qty, 4)} @ $${fmt(c.price)} = $${fmt(amount)}\nATR: ${fmt(c.atrPct, 1)}% | SL: $${fmt(stopP)} | TP: $${fmt(tpP)}\nScale 50% @ $${fmt(scaleP)}\n${reason}${scoreBreakdown}`;
  log.info(`[crypto_auto] MCM BUY ${c.base} ${fmt(qty, 4)} @ $${fmt(c.price)} Score=${scoreInfo?.score || "?"}/10`);
  addSignal({ ts: Date.now(), symbol: c.base, action: "BUY", confidence: conf, reason: `${scoreInfo?.score || "?"}/10 ${reason}`, price: c.price, executed: true });
  alert(msg).catch(() => {});
  return msg;
}

function scaleOut(pos: any, price: number): string {
  const d = getDb();
  const sym = pos.symbol;
  const base = sym.replace("USDT", "");
  const meta = posMeta[sym];
  if (!meta) return "";

  const sellQty = pos.quantity * 0.5;
  const proceeds = sellQty * price;
  const pnl = proceeds - (sellQty * pos.avg_price);
  const pnlPct = (pnl / (sellQty * pos.avg_price)) * 100;

  d.prepare("INSERT INTO crypto_paper_trades (symbol, side, quantity, price, total, reasoning) VALUES (?, 'sell', ?, ?, ?, ?)")
    .run(sym, sellQty, price, proceeds, `[MCM-SCALE] 50% P&L: ${fmtPnl(pnl)}`);
  d.prepare("UPDATE crypto_paper_positions SET quantity = quantity - ?, current_price = ?, updated_at = unixepoch() WHERE id = ?")
    .run(sellQty, price, pos.id);
  d.prepare("UPDATE crypto_paper_account SET balance = balance + ?, updated_at = unixepoch() WHERE id = 1").run(proceeds);

  meta.scaledOut = true;
  meta.stopPrice = pos.avg_price; // Move stop to breakeven
  meta.highWater = price;
  dailyPnl += pnl;

  const msg = `💰 *SCALE OUT 50% ${base}*\n@ $${fmt(price)} | P&L: ${fmtPnl(pnl)} (${fmt(pnlPct)}%)\nRest: ${fmt(pos.quantity - sellQty, 4)} trailing`;
  log.info(`[crypto_auto] SCALE ${base} 50% @ $${fmt(price)} P&L: ${fmtPnl(pnl)}`);
  addSignal({ ts: Date.now(), symbol: base, action: "SCALE_OUT", confidence: 100, reason: `${fmtPnl(pnl)}`, price, executed: true });
  alert(msg).catch(() => {});
  return msg;
}

function sellExec(pos: any, price: number, reason: string): string {
  if (reason === "SCALE_OUT") return scaleOut(pos, price);

  const d = getDb();
  const sym = pos.symbol;
  const base = sym.replace("USDT", "");
  const proceeds = pos.quantity * price;
  const cost = pos.quantity * pos.avg_price;
  const pnl = proceeds - cost;
  const pnlPct = (pnl / cost) * 100;

  d.prepare("INSERT INTO crypto_paper_trades (symbol, side, quantity, price, total, reasoning) VALUES (?, 'sell', ?, ?, ?, ?)")
    .run(sym, pos.quantity, price, proceeds, `[MCM-${reason}] P&L: ${fmtPnl(pnl)} (${fmt(pnlPct)}%)`);
  d.prepare("UPDATE crypto_paper_positions SET status = 'closed', current_price = ?, pnl = ?, pnl_percent = ?, updated_at = unixepoch() WHERE id = ?")
    .run(price, pnl, pnlPct, pos.id);
  d.prepare("UPDATE crypto_paper_account SET balance = balance + ?, updated_at = unixepoch() WHERE id = 1").run(proceeds);

  dailyPnl += pnl;
  if (pnl < 0) consLosses++; else consLosses = 0;
  delete posMeta[sym];
  cooldownMap[sym] = Date.now(); // 24h cooldown — prevents re-entry loops (ELF bug fix)

  const e = reason === "TP" || reason === "TRAILING" ? "💰" : reason === "SL" ? "🚨" : "🔴";
  const msg = `${e} *SELL ${base} (${reason})*\n${fmt(pos.quantity, 4)} @ $${fmt(price)}\nP&L: ${fmtPnl(pnl)} (${fmt(pnlPct)}%)\nDaily: ${fmtPnl(dailyPnl)}`;
  log.info(`[crypto_auto] SELL ${base} ${reason} P&L: ${fmtPnl(pnl)}`);
  addSignal({ ts: Date.now(), symbol: base, action: reason, confidence: 100, reason: fmtPnl(pnl), price, executed: true });
  alert(msg).catch(() => {});
  return msg;
}

// ─── Exit Logic ───

function checkExit(pos: any, price: number): string | null {
  const sym = pos.symbol;
  const meta = posMeta[sym];

  if (!meta) {
    // Legacy position — simple % stops
    const pnl = (price - pos.avg_price) / pos.avg_price;
    if (pnl <= -0.05) return "SL";
    if (pnl >= 0.10) return "TP";
    const hold = Date.now() - (pos.opened_at * 1000);
    if (hold >= MAX_HOLD_MS) return "TIME_STOP";
    return null;
  }

  if (price > meta.highWater) meta.highWater = price;

  // 1. Stop-loss (ATR)
  if (price <= meta.stopPrice) return "SL";
  // 2. Take-profit (ATR)
  if (price >= meta.tpPrice) return "TP";
  // 3. Scale out at 2x ATR
  if (!meta.scaledOut && price >= meta.scaleOutPrice) return "SCALE_OUT";
  // 4. Trailing (after scale-out)
  if (meta.scaledOut) {
    const trail = meta.highWater - (TRAILING_ATR_MULT * meta.atr);
    if (price <= trail) return "TRAILING";
  }
  // 5. Time stop
  const hold = Date.now() - (pos.opened_at * 1000);
  if (hold >= MAX_HOLD_MS) return "TIME_STOP";

  return null;
}

// ─── Price fetch for existing positions ───

async function getPrice(symbol: string): Promise<number | null> {
  try {
    const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`, { signal: AbortSignal.timeout(5_000) });
    if (!r.ok) return null;
    const d = await r.json() as any;
    return parseFloat(d.price);
  } catch { return null; }
}

// ─── Main Tick ───

async function runTick(): Promise<string> {
  const lines: string[] = [];
  const { dateStr } = nowET();

  if (dailyDate !== dateStr) { dailyDate = dateStr; dailyPnl = 0; consLosses = 0; }

  if (!enabled) return "[crypto_auto] DISABLED.";
  const acc = getAccount();
  if (dailyPnl / acc.initial_balance <= MAX_DAILY_LOSS_PCT)
    return `[crypto_auto] CIRCUIT BREAKER: daily ${fmt(dailyPnl / acc.initial_balance * 100)}% < -5%.`;
  if (consLosses >= CIRCUIT_BREAKER_LOSSES)
    return `[crypto_auto] CIRCUIT BREAKER: ${consLosses} consecutive losses.`;

  // 1. Scan market
  let candidates: Candidate[];
  try {
    candidates = await scanMarket();
    lastCandidates = candidates;
  } catch (e) {
    return `[crypto_auto] Scan error: ${e instanceof Error ? e.message : String(e)}`;
  }

  // 2. Check exits on open positions
  const positions = openPositions();
  for (const pos of positions) {
    const price = await getPrice(pos.symbol);
    if (!price) continue;
    getDb().prepare("UPDATE crypto_paper_positions SET current_price = ?, updated_at = unixepoch() WHERE id = ?").run(price, pos.id);

    const exit = checkExit(pos, price);
    if (exit) {
      if (scanOnly) {
        lines.push(`📡 [SCAN] Exit ${pos.symbol.replace("USDT", "")}: ${exit} @ $${fmt(price)}`);
        addSignal({ ts: Date.now(), symbol: pos.symbol.replace("USDT", ""), action: exit, confidence: 100, reason: `scan-only`, price, executed: false });
      } else {
        lines.push(sellExec(pos, price, exit));
      }
    }
  }

  // 3. New entries
  const current = openPositions();
  if (current.length < MAX_POSITIONS) {
    const held = new Set(current.map((p: any) => p.symbol));
    const invested = current.reduce((s: number, p: any) => s + (p.quantity * (p.current_price || p.avg_price)), 0);

    for (const c of candidates) {
      if (held.has(c.symbol)) continue;
      // Cooldown: skip symbols closed within last 24h (prevents TIME_STOP re-entry loops)
      const cd = cooldownMap[c.symbol];
      if (cd && (Date.now() - cd) < COOLDOWN_MS) continue;
      if (current.length >= MAX_POSITIONS) break;
      if (invested >= acc.initial_balance * MAX_EXPOSURE_PCT) break;

      const sig = evaluate(c);
      if (sig) {
        if (scanOnly) {
          lines.push(`📡 [SCAN] Buy ${c.base} @ $${fmt(c.price)} (${sig.score}/10): ${sig.reason} ${sig.breakdown}`);
          addSignal({ ts: Date.now(), symbol: c.base, action: "BUY", confidence: sig.confidence, reason: `${sig.score}/10 ${sig.reason}`, price: c.price, executed: false });
        } else {
          lines.push(buyExec(c, sig.confidence, sig.reason, { score: sig.score, breakdown: sig.breakdown }));
        }
      }
    }
  }

  if (lines.length === 0) {
    return `[crypto_auto] Tick OK — ${current.length}/${MAX_POSITIONS} pos, ${candidates.length} candidates, P&L: ${fmtPnl(dailyPnl)}`;
  }
  return lines.join("\n\n");
}

// ─── Skills ───

registerSkill({
  name: "crypto_auto.tick",
  description: "Run one MCM crypto trading cycle. Scans Binance for top movers, evaluates ATR-based entries/exits.",
  adminOnly: true,
  argsSchema: { type: "object", properties: {} },
  async execute(): Promise<string> {
    try { lastTickTs = Date.now(); return await runTick(); }
    catch (e) { const m = `[crypto_auto] Error: ${e instanceof Error ? e.message : e}`; log.error(m); return m; }
  },
});

registerSkill({
  name: "crypto_auto.status",
  description: "Show MCM crypto trading status: mode, positions with ATR levels, candidates, daily P&L.",
  adminOnly: true,
  argsSchema: { type: "object", properties: {} },
  async execute(): Promise<string> {
    const acc = getAccount();
    const pos = openPositions();
    const invested = pos.reduce((s: number, p: any) => s + (p.quantity * (p.current_price || p.avg_price)), 0);

    const lines = [
      `📊 *Crypto MCM Status*`,
      `Mode: ${enabled ? (scanOnly ? "📡 SCAN-ONLY" : "✅ LIVE") : "❌ OFF"}`,
      `Cash: $${fmt(acc.balance)} | Invested: $${fmt(invested)} | Initial: $${fmt(acc.initial_balance)}`,
      `Daily P&L: ${fmtPnl(dailyPnl)} | Losses: ${consLosses}/${CIRCUIT_BREAKER_LOSSES}`,
      `Positions: ${pos.length}/${MAX_POSITIONS} | Exposure: ${fmt(invested / acc.initial_balance * 100, 0)}%/${MAX_EXPOSURE_PCT * 100}%`,
      `Last tick: ${lastTickTs ? new Date(lastTickTs).toLocaleTimeString("en-US", { timeZone: "America/Toronto", hour12: false }) : "never"}`,
    ];

    // Position details with ATR levels
    for (const p of pos) {
      const base = p.symbol.replace("USDT", "");
      const pnl = p.current_price ? (p.current_price - p.avg_price) * p.quantity : 0;
      const pnlPct = p.avg_price ? ((p.current_price / p.avg_price) - 1) * 100 : 0;
      const meta = posMeta[p.symbol];
      let metaStr = "";
      if (meta) {
        metaStr = `\n    SL: $${fmt(meta.stopPrice)} | TP: $${fmt(meta.tpPrice)} | Scale: ${meta.scaledOut ? "DONE" : `$${fmt(meta.scaleOutPrice)}`}`;
        if (meta.scaledOut) metaStr += ` | Trail from $${fmt(meta.highWater)}`;
      } else {
        metaStr = "\n    ⚠️ Legacy (no ATR data)";
      }
      lines.push(`  ${pnl >= 0 ? "🟢" : "🔴"} ${base}: ${fmt(p.quantity, 4)} @ $${fmt(p.avg_price)} → $${fmt(p.current_price || 0)} (${fmtPnl(pnl)} / ${fmt(pnlPct)}%)${metaStr}`);
    }

    // Last candidates
    if (lastCandidates.length > 0) {
      lines.push(`\n🔍 *Top Movers (${lastCandidates.length}):*`);
      for (const c of lastCandidates.slice(0, 5)) {
        const sig = evaluate(c);
        const rsiDir = (c.rsi !== null && c.rsiPrev !== null) ? (c.rsi > c.rsiPrev ? "\u2191" : "\u2193") : "?";
        lines.push(`  ${c.base}: $${fmt(c.price)} +${fmt(c.change24h, 1)}% | ATR ${fmt(c.atrPct, 1)}% | RSI ${c.rsi ? fmt(c.rsi, 0) : "?"}${rsiDir} | Vol $${fmt(c.volume24h / 1e6, 1)}M${sig ? ` \u2705 ${sig.score}/10` : ""}`);
      }
    }

    return lines.join("\n");
  },
});

registerSkill({
  name: "crypto_auto.toggle",
  description: "Toggle MCM crypto trading: 'on' (live), 'scan' (signals only), 'off' (disabled).",
  adminOnly: true,
  argsSchema: { type: "object", properties: { state: { type: "string" } }, required: ["state"] },
  async execute(args): Promise<string> {
    const s = String(args.state).toLowerCase();
    if (s === "on" || s === "true" || s === "enable" || s === "live") {
      enabled = true; scanOnly = false; consLosses = 0;
      return "✅ MCM crypto LIVE — trades will execute.";
    } else if (s === "scan" || s === "scan-only" || s === "scanonly") {
      enabled = true; scanOnly = true;
      return "📡 MCM crypto SCAN-ONLY — signals but no execution.";
    } else {
      enabled = false;
      return "❌ MCM crypto DISABLED.";
    }
  },
});

registerSkill({
  name: "crypto_auto.signals",
  description: "Show recent MCM crypto trading signals.",
  adminOnly: true,
  argsSchema: { type: "object", properties: { limit: { type: "number" } } },
  async execute(args): Promise<string> {
    const limit = Number(args.limit) || 10;
    if (signals.length === 0) return "No signals yet.";
    const lines = [`📡 *Last ${Math.min(limit, signals.length)} MCM Signals:*`];
    for (const s of signals.slice(0, limit)) {
      const t = new Date(s.ts).toLocaleTimeString("en-US", { timeZone: "America/Toronto", hour12: false });
      lines.push(`${s.executed ? "✅" : "⏭️"} [${t}] ${s.symbol} ${s.action} @ $${fmt(s.price)} (${s.confidence}) — ${s.reason}`);
    }
    return lines.join("\n");
  },
});

log.info(`[crypto_auto] MCM v3 loaded — Binance scanner, ATR-based, ${MAX_POSITIONS} max pos, ${RISK_PER_TRADE * 100}% risk/trade`);
