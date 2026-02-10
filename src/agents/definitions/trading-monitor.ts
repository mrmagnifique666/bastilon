/**
 * Trading Monitor Agent — quantitative portfolio surveillance.
 * Heartbeat: 1 minute during market hours (configurable via env).
 *
 * Architecture: HYBRID approach
 * - Cycle 0 & 1: Direct API calls (no LLM needed) — fetch prices, compute RSI,
 *   VWAP, check stop-loss/take-profit, send Telegram alerts. Zero LLM cost.
 * - Cycle 2: Ollama analysis — feed market data to local LLM for pattern
 *   interpretation and trade recommendations. Free (local model).
 *
 * Data sources:
 * - Alpaca Data API: 1-min bars, latest quotes/trades, snapshots (FREE with paper account)
 * - Yahoo Finance: 3-month daily history for SMA/RSI (fallback)
 *
 * Quantitative signals:
 * - RSI(14): <30 oversold (buy), >70 overbought (sell)
 * - RSI divergence: price/RSI disagreement = reversal signal
 * - VWAP: price vs volume-weighted average price (intraday trend)
 * - Price vs SMA(20/50): trend confirmation
 * - Volume relative (RVOL): >1.5x = significant move
 * - Stop-loss / take-profit monitoring
 *
 * Skips weekends and outside market hours (9h-17h ET).
 */
import type { AgentConfig } from "../base.js";
import { config } from "../../config/env.js";
import { log } from "../../utils/log.js";
import fs from "node:fs";
import path from "node:path";

const TZ = "America/Toronto";
const YF_URL = "https://query1.finance.yahoo.com/v8/finance/chart";
const YF_HEADERS = { "User-Agent": "Mozilla/5.0" };
const ALPACA_DATA_URL = "https://data.alpaca.markets";

// ── Position alert levels ──
interface AlertLevel {
  symbol: string;
  entryPrice: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  note?: string;
}

const POSITIONS: AlertLevel[] = [
  {
    symbol: "TSLA",
    entryPrice: 410.19,
    stopLoss: 385,
    takeProfit1: 450,
    takeProfit2: 480,
  },
  {
    symbol: "VST",
    entryPrice: 155.62,
    stopLoss: 140,
    takeProfit1: 180,
    takeProfit2: 210,
    note: "Earnings 26 fev 2026",
  },
  {
    symbol: "NVST",
    entryPrice: 0, // will be filled at market open
    stopLoss: 0,
    takeProfit1: 0,
    takeProfit2: 0,
    note: "Grok pick - Healthcare/Dental - Conviction 4/5",
  },
  {
    symbol: "BBVA",
    entryPrice: 0,
    stopLoss: 0,
    takeProfit1: 0,
    takeProfit2: 0,
    note: "Grok pick - Banking/Financials - Conviction 4/5",
  },
  {
    symbol: "AVXL",
    entryPrice: 0,
    stopLoss: 0,
    takeProfit1: 0,
    takeProfit2: 0,
    note: "Grok pick - Biotech - Conviction 3/5 speculatif",
  },
  {
    symbol: "DVA",
    entryPrice: 0,
    stopLoss: 0,
    takeProfit1: 0,
    takeProfit2: 0,
    note: "Grok pick - Healthcare scanner",
  },
  {
    symbol: "ADNT",
    entryPrice: 0,
    stopLoss: 0,
    takeProfit1: 0,
    takeProfit2: 0,
    note: "Grok pick - Auto Parts scanner",
  },
];

// ── Alpaca intraday data ──

interface IntradayBar {
  t: string; // timestamp
  o: number; // open
  h: number; // high
  l: number; // low
  c: number; // close
  v: number; // volume
  vw: number; // volume-weighted average price
  n: number; // number of trades
}

interface AlpacaSnapshot {
  dailyBar: IntradayBar;
  latestTrade: { p: number; s: number; t: string };
  latestQuote: { ap: number; bp: number; as: number; bs: number; t: string };
  minuteBar: IntradayBar;
  prevDailyBar: IntradayBar;
}

async function fetchAlpacaSnapshots(symbols: string[]): Promise<Record<string, AlpacaSnapshot>> {
  try {
    const resp = await fetch(
      `${ALPACA_DATA_URL}/v2/stocks/snapshots?symbols=${symbols.join(",")}&feed=iex`,
      {
        headers: {
          "APCA-API-KEY-ID": config.alpacaApiKey || "",
          "APCA-API-SECRET-KEY": config.alpacaSecretKey || "",
        },
      }
    );
    if (!resp.ok) return {};
    return await resp.json() as Record<string, AlpacaSnapshot>;
  } catch (err) {
    log.warn(`[trading-monitor] Alpaca snapshot error: ${err}`);
    return {};
  }
}

async function fetchIntradayBars(symbol: string, timeframe: string = "1Min", limit: number = 30): Promise<IntradayBar[]> {
  try {
    const resp = await fetch(
      `${ALPACA_DATA_URL}/v2/stocks/${symbol}/bars?timeframe=${timeframe}&limit=${limit}&feed=iex`,
      {
        headers: {
          "APCA-API-KEY-ID": config.alpacaApiKey || "",
          "APCA-API-SECRET-KEY": config.alpacaSecretKey || "",
        },
      }
    );
    if (!resp.ok) return [];
    const data = await resp.json() as { bars: IntradayBar[] };
    return data.bars || [];
  } catch (err) {
    log.warn(`[trading-monitor] Intraday bars error for ${symbol}: ${err}`);
    return [];
  }
}

// ── VWAP calculation from intraday bars ──

function calculateVWAP(bars: IntradayBar[]): number | null {
  if (!bars || bars.length === 0) return null;
  let cumVolPrice = 0;
  let cumVolume = 0;
  for (const bar of bars) {
    const typicalPrice = (bar.h + bar.l + bar.c) / 3;
    cumVolPrice += typicalPrice * bar.v;
    cumVolume += bar.v;
  }
  return cumVolume > 0 ? cumVolPrice / cumVolume : null;
}

// ── RSI & technical indicator calculations ──

interface TechnicalData {
  symbol: string;
  price: number;
  prevClose: number;
  changePct: number;
  volume: number;
  avgVolume: number;
  rsi14: number | null;
  sma20: number | null;
  sma50: number | null;
  high: number;
  low: number;
  closes: number[];
}

async function fetchTechnicals(symbol: string): Promise<TechnicalData | null> {
  try {
    const resp = await fetch(`${YF_URL}/${symbol}?interval=1d&range=3mo`, {
      headers: YF_HEADERS,
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const result = data?.chart?.result?.[0];
    const meta = result?.meta;
    if (!meta) return null;

    const closes: number[] = (result?.indicators?.quote?.[0]?.close || []).filter(
      (c: any) => c != null
    );
    const volumes: number[] = (result?.indicators?.quote?.[0]?.volume || []).filter(
      (v: any) => v != null
    );
    const price = meta.regularMarketPrice;
    const prevClose = meta.chartPreviousClose || meta.previousClose || price;

    // SMA(20) and SMA(50)
    const sma20 = closes.length >= 20
      ? closes.slice(-20).reduce((a, b) => a + b, 0) / 20
      : null;
    const sma50 = closes.length >= 50
      ? closes.slice(-50).reduce((a, b) => a + b, 0) / 50
      : null;

    // RSI(14)
    let rsi14: number | null = null;
    if (closes.length >= 15) {
      const changes: number[] = [];
      for (let i = closes.length - 15; i < closes.length - 1; i++) {
        changes.push(closes[i + 1] - closes[i]);
      }
      let gains = 0,
        losses = 0;
      for (const c of changes) {
        if (c > 0) gains += c;
        else losses -= c;
      }
      const avgGain = gains / 14;
      const avgLoss = losses / 14;
      rsi14 = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }

    // Average volume (last 20 days)
    const avgVolume =
      volumes.length >= 20
        ? volumes.slice(-20).reduce((a, b) => a + b, 0) / 20
        : volumes.length > 0
        ? volumes.reduce((a, b) => a + b, 0) / volumes.length
        : 0;

    return {
      symbol: symbol.toUpperCase(),
      price,
      prevClose,
      changePct: ((price - prevClose) / prevClose) * 100,
      volume: meta.regularMarketVolume || 0,
      avgVolume,
      rsi14,
      sma20,
      sma50,
      high: meta.regularMarketDayHigh || price,
      low: meta.regularMarketDayLow || price,
      closes,
    };
  } catch (err) {
    log.warn(`[trading-monitor] Failed to fetch ${symbol}: ${err}`);
    return null;
  }
}

// ── RSI Divergence Detection ──

function detectRsiDivergence(closes: number[], rsiValues: number[]): string | null {
  if (closes.length < 5 || rsiValues.length < 5) return null;

  const recentCloses = closes.slice(-5);
  const recentRsi = rsiValues.slice(-5);

  const priceUp = recentCloses[recentCloses.length - 1] > recentCloses[0];
  const rsiUp = recentRsi[recentRsi.length - 1] > recentRsi[0];

  // Bearish divergence: price going up but RSI going down
  if (priceUp && !rsiUp) return "BEARISH_DIVERGENCE";
  // Bullish divergence: price going down but RSI going up
  if (!priceUp && rsiUp) return "BULLISH_DIVERGENCE";

  return null;
}

// Calculate rolling RSI values for divergence detection
function calculateRollingRsi(closes: number[], period: number = 14): number[] {
  const rsiValues: number[] = [];
  if (closes.length < period + 1) return rsiValues;

  for (let end = period + 1; end <= closes.length; end++) {
    const slice = closes.slice(end - period - 1, end);
    let gains = 0,
      losses = 0;
    for (let i = 0; i < slice.length - 1; i++) {
      const change = slice[i + 1] - slice[i];
      if (change > 0) gains += change;
      else losses -= change;
    }
    const avgGain = gains / period;
    const avgLoss = losses / period;
    rsiValues.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  }
  return rsiValues;
}

// ── Generate quant signals ──

interface Signal {
  type: "ALERT" | "SIGNAL" | "INFO";
  emoji: string;
  message: string;
}

function generateSignals(
  data: TechnicalData,
  alert: AlertLevel,
  vwap?: number | null,
  snapshot?: AlpacaSnapshot | null
): Signal[] {
  const signals: Signal[] = [];
  const { price, rsi14, sma20, sma50, changePct, volume, avgVolume, closes } = data;

  // Use real-time price from snapshot if available
  const livePrice = snapshot?.latestTrade?.p || price;

  // 1. Stop-loss check (skip if entry/stop not set)
  if (alert.stopLoss > 0 && livePrice <= alert.stopLoss) {
    signals.push({
      type: "ALERT",
      emoji: "🚨",
      message: `STOP-LOSS ${alert.symbol} @ $${livePrice.toFixed(2)} (seuil: $${alert.stopLoss}). VENDRE!`,
    });
  }

  // 2. Take-profit checks (skip if not set)
  if (alert.takeProfit2 > 0 && alert.entryPrice > 0) {
    if (livePrice >= alert.takeProfit2) {
      signals.push({
        type: "ALERT",
        emoji: "💰",
        message: `TP2 ATTEINT ${alert.symbol} @ $${livePrice.toFixed(2)} (+${(((livePrice - alert.entryPrice) / alert.entryPrice) * 100).toFixed(1)}%). Prendre profits!`,
      });
    } else if (livePrice >= alert.takeProfit1) {
      signals.push({
        type: "ALERT",
        emoji: "🎯",
        message: `TP1 ATTEINT ${alert.symbol} @ $${livePrice.toFixed(2)} (+${(((livePrice - alert.entryPrice) / alert.entryPrice) * 100).toFixed(1)}%). Considérer vendre 50%.`,
      });
    }
  }

  // 3. Big daily move (>3%)
  if (Math.abs(changePct) > 3) {
    signals.push({
      type: "ALERT",
      emoji: changePct > 0 ? "📈" : "📉",
      message: `${alert.symbol} ${changePct > 0 ? "+" : ""}${changePct.toFixed(1)}% aujourd'hui ($${livePrice.toFixed(2)})`,
    });
  }

  // 4. RSI signals
  if (rsi14 !== null) {
    if (rsi14 < 30) {
      signals.push({
        type: "SIGNAL",
        emoji: "🟢",
        message: `${alert.symbol} RSI=${rsi14.toFixed(0)} SURVENDU — signal d'achat potentiel`,
      });
    } else if (rsi14 > 70) {
      signals.push({
        type: "SIGNAL",
        emoji: "🔴",
        message: `${alert.symbol} RSI=${rsi14.toFixed(0)} SURACHETÉ — signal de vente potentiel`,
      });
    }
  }

  // 5. RSI divergence
  if (closes.length >= 20) {
    const rollingRsi = calculateRollingRsi(closes);
    const divergence = detectRsiDivergence(closes, rollingRsi);
    if (divergence === "BEARISH_DIVERGENCE") {
      signals.push({
        type: "SIGNAL",
        emoji: "⚠️",
        message: `${alert.symbol} DIVERGENCE BAISSIÈRE — prix monte mais RSI descend. Retournement possible.`,
      });
    } else if (divergence === "BULLISH_DIVERGENCE") {
      signals.push({
        type: "SIGNAL",
        emoji: "💡",
        message: `${alert.symbol} DIVERGENCE HAUSSIÈRE — prix descend mais RSI monte. Rebond possible.`,
      });
    }
  }

  // 6. VWAP signals (intraday)
  if (vwap !== null && vwap !== undefined && vwap > 0) {
    const vwapDiff = ((livePrice - vwap) / vwap) * 100;
    if (livePrice > vwap && vwapDiff > 0.5) {
      signals.push({
        type: "SIGNAL",
        emoji: "🔼",
        message: `${alert.symbol} au-dessus VWAP $${vwap.toFixed(2)} (+${vwapDiff.toFixed(1)}%) — momentum acheteur`,
      });
    } else if (livePrice < vwap && vwapDiff < -0.5) {
      signals.push({
        type: "SIGNAL",
        emoji: "🔽",
        message: `${alert.symbol} sous VWAP $${vwap.toFixed(2)} (${vwapDiff.toFixed(1)}%) — pression vendeuse`,
      });
    }
  }

  // 7. SMA crossover signals
  if (sma20 !== null && sma50 !== null) {
    if (price > sma20 && price > sma50) {
      signals.push({
        type: "INFO",
        emoji: "✅",
        message: `${alert.symbol} au-dessus SMA20 ($${sma20.toFixed(2)}) et SMA50 ($${sma50.toFixed(2)}) — tendance haussière`,
      });
    } else if (price < sma20 && price < sma50) {
      signals.push({
        type: "INFO",
        emoji: "❌",
        message: `${alert.symbol} sous SMA20 ($${sma20.toFixed(2)}) et SMA50 ($${sma50.toFixed(2)}) — tendance baissière`,
      });
    }
  }

  // 8. Volume spike (RVOL > 1.5x)
  if (avgVolume > 0 && volume > avgVolume * 1.5) {
    signals.push({
      type: "SIGNAL",
      emoji: "🔊",
      message: `${alert.symbol} VOLUME ${((volume / avgVolume) * 100).toFixed(0)}% de la moyenne — mouvement significatif`,
    });
  }

  // 9. Bid-ask spread warning (from snapshot)
  if (snapshot?.latestQuote) {
    const { ap, bp } = snapshot.latestQuote;
    if (ap > 0 && bp > 0) {
      const spreadPct = ((ap - bp) / bp) * 100;
      if (spreadPct > 1) {
        signals.push({
          type: "INFO",
          emoji: "⚠️",
          message: `${alert.symbol} spread large: ${spreadPct.toFixed(2)}% (bid $${bp.toFixed(2)} / ask $${ap.toFixed(2)})`,
        });
      }
    }
  }

  return signals;
}

// ── Market hours check ──

function isMarketHours(): boolean {
  const now = new Date();
  const dayParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    weekday: "long",
  }).formatToParts(now);
  const day = dayParts.find((p) => p.type === "weekday")!.value;
  if (day === "Saturday" || day === "Sunday") return false;

  const hourParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    hour: "numeric",
    hour12: false,
  }).formatToParts(now);
  const h = Number(hourParts.find((p) => p.type === "hour")!.value);
  return h >= 9 && h < 17;
}

// ── Alpaca order execution ──

const ALPACA_PAPER_URL = "https://paper-api.alpaca.markets";

function alpacaHeaders(): Record<string, string> {
  return {
    "APCA-API-KEY-ID": config.alpacaApiKey || "",
    "APCA-API-SECRET-KEY": config.alpacaSecretKey || "",
    "Content-Type": "application/json",
  };
}

async function alpacaGet(path: string): Promise<any> {
  const resp = await fetch(`${ALPACA_PAPER_URL}${path}`, { headers: alpacaHeaders() });
  if (!resp.ok) throw new Error(`Alpaca ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

async function alpacaPost(path: string, body: any): Promise<any> {
  const resp = await fetch(`${ALPACA_PAPER_URL}${path}`, {
    method: "POST", headers: alpacaHeaders(), body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`Alpaca ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

async function placeOrder(
  symbol: string, qty: number, side: "buy" | "sell",
  type: "market" | "limit" | "stop" | "stop_limit" = "market",
  limitPrice?: number, stopPrice?: number
): Promise<any> {
  const body: any = { symbol, qty: String(qty), side, type, time_in_force: "day" };
  if (limitPrice) body.limit_price = String(limitPrice);
  if (stopPrice) body.stop_price = String(stopPrice);
  return alpacaPost("/v2/orders", body);
}

// ── Bollinger Bands ──

interface BollingerBands {
  upper: number;
  middle: number; // SMA(20)
  lower: number;
  bandwidth: number; // (upper - lower) / middle * 100
}

function calculateBollinger(closes: number[], period: number = 20, stdDevMult: number = 2): BollingerBands | null {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((sum, c) => sum + Math.pow(c - mean, 2), 0) / period;
  const stdDev = Math.sqrt(variance);
  const upper = mean + stdDevMult * stdDev;
  const lower = mean - stdDevMult * stdDev;
  return { upper, middle: mean, lower, bandwidth: ((upper - lower) / mean) * 100 };
}

// ── Trailing stop state ──

interface TrailingStopState {
  symbol: string;
  highWaterMark: number; // highest price since entry
  trailingPct: number;   // trailing stop % (e.g. 0.05 = 5%)
  active: boolean;
}

const trailingStops: Map<string, TrailingStopState> = new Map();

function updateTrailingStop(symbol: string, currentPrice: number, trailingPct: number = 0.05): { triggered: boolean; stopPrice: number } {
  let state = trailingStops.get(symbol);
  if (!state) {
    state = { symbol, highWaterMark: currentPrice, trailingPct, active: true };
    trailingStops.set(symbol, state);
  }

  // Update high water mark
  if (currentPrice > state.highWaterMark) {
    state.highWaterMark = currentPrice;
  }

  const stopPrice = state.highWaterMark * (1 - state.trailingPct);
  const triggered = currentPrice <= stopPrice;

  return { triggered, stopPrice };
}

// ── Trade journal ──

interface TradeEntry {
  timestamp: string;
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  price: number;
  reason: string;
  signals: string[];
  pnl?: number;
  pnlPct?: number;
}

const JOURNAL_PATH = path.join(process.cwd(), "relay", "trade-journal.json");

function loadJournal(): TradeEntry[] {
  try {
    if (fs.existsSync(JOURNAL_PATH)) {
      return JSON.parse(fs.readFileSync(JOURNAL_PATH, "utf-8"));
    }
  } catch { /* */ }
  return [];
}

function saveJournal(journal: TradeEntry[]): void {
  try {
    const dir = path.dirname(JOURNAL_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(JOURNAL_PATH, JSON.stringify(journal, null, 2));
  } catch (err) {
    log.warn(`[trading-monitor] Failed to save journal: ${err}`);
  }
}

function logTrade(entry: TradeEntry): void {
  const journal = loadJournal();
  journal.push(entry);
  saveJournal(journal);
  log.info(`[trading-monitor] TRADE: ${entry.side} ${entry.qty}x ${entry.symbol} @ $${entry.price} — ${entry.reason}`);
}

// ── Auto-fill entry prices from Alpaca positions ──

let entryPricesFilled = false;

async function syncEntryPricesFromAlpaca(): Promise<string[]> {
  if (entryPricesFilled) return [];
  const changes: string[] = [];
  try {
    const positions = await alpacaGet("/v2/positions");
    for (const p of positions) {
      const pos = POSITIONS.find((pos) => pos.symbol === p.symbol);
      if (pos && pos.entryPrice === 0) {
        const entry = Number(p.avg_entry_price);
        pos.entryPrice = entry;
        // Auto-calculate stop-loss (5%) and take-profits (10%, 20%)
        pos.stopLoss = Math.round(entry * 0.95 * 100) / 100;
        pos.takeProfit1 = Math.round(entry * 1.10 * 100) / 100;
        pos.takeProfit2 = Math.round(entry * 1.20 * 100) / 100;
        changes.push(`${p.symbol}: entry=$${entry.toFixed(2)}, SL=$${pos.stopLoss}, TP1=$${pos.takeProfit1}, TP2=$${pos.takeProfit2}`);
      }
    }
    if (changes.length > 0) entryPricesFilled = true;
  } catch (err) {
    log.warn(`[trading-monitor] Failed to sync entry prices: ${err}`);
  }
  return changes;
}

// ── Risk management ──

const RISK_RULES = {
  maxPositionPct: 0.01,     // 1% of portfolio per trade
  maxDailyLossPct: 0.03,    // 3% max daily loss
  minRewardRisk: 2.0,       // 2:1 reward/risk minimum
  maxOpenPositions: 10,     // max simultaneous positions
  maxTradesPerDay: 20,      // avoid overtrading
};

let dailyTradeCount = 0;
let dailyPnL = 0;
let lastTradeDate = "";

function resetDailyCounters(): void {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== lastTradeDate) {
    dailyTradeCount = 0;
    dailyPnL = 0;
    lastTradeDate = today;
  }
}

async function canTrade(): Promise<{ allowed: boolean; reason: string }> {
  resetDailyCounters();

  if (dailyTradeCount >= RISK_RULES.maxTradesPerDay) {
    return { allowed: false, reason: `Max ${RISK_RULES.maxTradesPerDay} trades/jour atteint` };
  }

  try {
    const account = await alpacaGet("/v2/account");
    const equity = Number(account.equity);
    const dailyLossPct = Math.abs(dailyPnL) / equity;
    if (dailyPnL < 0 && dailyLossPct >= RISK_RULES.maxDailyLossPct) {
      return { allowed: false, reason: `Perte quotidienne max (${(dailyLossPct * 100).toFixed(1)}%) atteinte` };
    }

    const positions = await alpacaGet("/v2/positions");
    if (positions.length >= RISK_RULES.maxOpenPositions) {
      return { allowed: false, reason: `Max ${RISK_RULES.maxOpenPositions} positions ouvertes` };
    }
  } catch { /* allow if API fails — don't block on transient errors */ }

  return { allowed: true, reason: "OK" };
}

function calculatePositionSize(price: number, stopLoss: number): number {
  // Risk 1% of portfolio (~$1000 on $100K)
  const riskAmount = 1000; // simplified — would fetch from account
  const riskPerShare = Math.abs(price - stopLoss);
  if (riskPerShare <= 0) return 1;
  return Math.max(1, Math.floor(riskAmount / riskPerShare));
}

// ── Auto-execution engine ──

interface TradeDecision {
  action: "BUY" | "SELL" | "HOLD";
  symbol: string;
  qty: number;
  reason: string;
  confidence: number; // 0-100
  signals: string[];
}

function evaluateAutoTrade(
  pos: AlertLevel,
  techData: TechnicalData,
  vwap: number | null,
  snapshot: AlpacaSnapshot | null,
  bollinger: BollingerBands | null,
  trailing: { triggered: boolean; stopPrice: number } | null
): TradeDecision {
  const livePrice = snapshot?.latestTrade?.p || techData.price;
  const signals: string[] = [];
  let buyScore = 0;
  let sellScore = 0;

  // Trailing stop triggered — MUST SELL
  if (trailing?.triggered) {
    return {
      action: "SELL", symbol: pos.symbol, qty: 1,
      reason: `Trailing stop declenche @ $${trailing.stopPrice.toFixed(2)}`,
      confidence: 95, signals: ["TRAILING_STOP"],
    };
  }

  // Hard stop-loss — MUST SELL
  if (pos.stopLoss > 0 && livePrice <= pos.stopLoss) {
    return {
      action: "SELL", symbol: pos.symbol, qty: 1,
      reason: `Stop-loss atteint @ $${livePrice.toFixed(2)} (seuil: $${pos.stopLoss})`,
      confidence: 99, signals: ["HARD_STOP_LOSS"],
    };
  }

  // RSI signals
  if (techData.rsi14 !== null) {
    if (techData.rsi14 < 30) { buyScore += 25; signals.push(`RSI=${techData.rsi14.toFixed(0)} survendu`); }
    if (techData.rsi14 > 70) { sellScore += 25; signals.push(`RSI=${techData.rsi14.toFixed(0)} surachete`); }
  }

  // VWAP signals
  if (vwap && vwap > 0) {
    const diff = ((livePrice - vwap) / vwap) * 100;
    if (diff > 1) { sellScore += 10; signals.push(`Au-dessus VWAP +${diff.toFixed(1)}%`); }
    if (diff < -1) { buyScore += 10; signals.push(`Sous VWAP ${diff.toFixed(1)}%`); }
  }

  // Bollinger Bands
  if (bollinger) {
    if (livePrice <= bollinger.lower) { buyScore += 20; signals.push("Prix touche Bollinger bas"); }
    if (livePrice >= bollinger.upper) { sellScore += 20; signals.push("Prix touche Bollinger haut"); }
    if (bollinger.bandwidth < 2) { signals.push("Bollinger squeeze — breakout imminent"); }
  }

  // Volume spike = confirms direction
  if (techData.avgVolume > 0 && techData.volume > techData.avgVolume * 1.5) {
    const boost = 10;
    if (techData.changePct > 0) buyScore += boost;
    else sellScore += boost;
    signals.push(`Volume ${((techData.volume / techData.avgVolume) * 100).toFixed(0)}% de la moyenne`);
  }

  // Take profit levels
  if (pos.entryPrice > 0 && pos.takeProfit2 > 0 && livePrice >= pos.takeProfit2) {
    sellScore += 30; signals.push(`TP2 atteint +${(((livePrice - pos.entryPrice) / pos.entryPrice) * 100).toFixed(1)}%`);
  } else if (pos.entryPrice > 0 && pos.takeProfit1 > 0 && livePrice >= pos.takeProfit1) {
    sellScore += 15; signals.push(`TP1 atteint +${(((livePrice - pos.entryPrice) / pos.entryPrice) * 100).toFixed(1)}%`);
  }

  // Big daily move (>5%) = take profit on longs
  if (pos.entryPrice > 0 && techData.changePct > 5) {
    sellScore += 15; signals.push(`Mouvement +${techData.changePct.toFixed(1)}% aujourd'hui`);
  }

  // Determine action — need confidence > 60 to act
  const confidence = Math.max(buyScore, sellScore);
  if (sellScore >= 60) {
    return { action: "SELL", symbol: pos.symbol, qty: 1, reason: signals.join(", "), confidence, signals };
  }
  // Don't auto-buy for existing positions (only for new scanner opportunities)
  return { action: "HOLD", symbol: pos.symbol, qty: 0, reason: signals.join(", ") || "Pas de signal fort", confidence, signals };
}

async function executeDecision(decision: TradeDecision, sendAlert: (msg: string) => void): Promise<void> {
  if (decision.action === "HOLD") return;

  const check = await canTrade();
  if (!check.allowed) {
    log.info(`[trading-monitor] Trade bloque: ${check.reason}`);
    return;
  }

  try {
    const order = await placeOrder(decision.symbol, decision.qty, decision.action === "BUY" ? "buy" : "sell");
    dailyTradeCount++;

    // Log to journal
    logTrade({
      timestamp: new Date().toISOString(),
      symbol: decision.symbol,
      side: decision.action === "BUY" ? "buy" : "sell",
      qty: decision.qty,
      price: 0, // will be filled
      reason: decision.reason,
      signals: decision.signals,
    });

    const emoji = decision.action === "BUY" ? "🟢" : "🔴";
    sendAlert(
      `${emoji} **AUTO-TRADE** ${decision.action} ${decision.qty}x ${decision.symbol}\n` +
      `Raison: ${decision.reason}\n` +
      `Confiance: ${decision.confidence}%\n` +
      `Order ID: ${order.id} (${order.status})`
    );
  } catch (err) {
    log.error(`[trading-monitor] Auto-trade failed: ${err}`);
    sendAlert(`**AUTO-TRADE ECHEC** ${decision.action} ${decision.symbol}: ${err}`);
  }
}

// ── Intraday tick — runs every heartbeat, no LLM cost ──

let lastAlertKey = ""; // avoid duplicate alerts within same minute

async function onTick(cycle: number, sendAlert: (msg: string) => void): Promise<void> {
  if (!isMarketHours()) return;

  // Auto-fill entry prices on first tick (after orders fill at market open)
  if (!entryPricesFilled && cycle > 2) {
    const filled = await syncEntryPricesFromAlpaca();
    if (filled.length > 0) {
      log.info(`[trading-monitor] Entry prices synced: ${filled.join(", ")}`);
    }
  }

  const symbols = POSITIONS.map((p) => p.symbol);

  // Fetch snapshots for all positions in one call
  const snapshots = await fetchAlpacaSnapshots(symbols);
  if (Object.keys(snapshots).length === 0) {
    log.warn("[trading-monitor] No snapshots returned — skipping tick");
    return;
  }

  const allSignals: Signal[] = [];

  for (const pos of POSITIONS) {
    const snap = snapshots[pos.symbol];
    if (!snap) continue;

    const livePrice = snap.latestTrade?.p || snap.minuteBar?.c || 0;
    if (livePrice === 0) continue;

    // Calculate VWAP from today's minute bars (every 5th cycle to save API calls)
    let vwap: number | null = null;
    if (cycle % 5 === 0) {
      const bars = await fetchIntradayBars(pos.symbol, "5Min", 78);
      vwap = calculateVWAP(bars);
    }

    // Build TechnicalData from snapshot
    const prevClose = snap.prevDailyBar?.c || snap.dailyBar?.o || livePrice;
    const techData: TechnicalData = {
      symbol: pos.symbol,
      price: livePrice,
      prevClose,
      changePct: prevClose > 0 ? ((livePrice - prevClose) / prevClose) * 100 : 0,
      volume: snap.dailyBar?.v || 0,
      avgVolume: snap.prevDailyBar?.v || 1,
      rsi14: null,
      sma20: null,
      sma50: null,
      high: snap.dailyBar?.h || livePrice,
      low: snap.dailyBar?.l || livePrice,
      closes: [],
    };

    // Trailing stop update
    let trailing: { triggered: boolean; stopPrice: number } | null = null;
    if (pos.entryPrice > 0) {
      trailing = updateTrailingStop(pos.symbol, livePrice);
    }

    // Bollinger Bands (need daily closes — fetch every 15 min to save API)
    let bollinger: BollingerBands | null = null;
    if (cycle % 15 === 0) {
      const dailyTech = await fetchTechnicals(pos.symbol);
      if (dailyTech && dailyTech.closes.length >= 20) {
        bollinger = calculateBollinger(dailyTech.closes);
        // Also update RSI and SMAs in techData
        techData.rsi14 = dailyTech.rsi14;
        techData.sma20 = dailyTech.sma20;
        techData.sma50 = dailyTech.sma50;
        techData.closes = dailyTech.closes;
      }
    }

    // Generate alert signals
    const signals = generateSignals(techData, pos, vwap, snap);
    const important = signals.filter((s) => s.type === "ALERT" || s.type === "SIGNAL");
    allSignals.push(...important);

    // Bollinger signal
    if (bollinger) {
      if (livePrice <= bollinger.lower) {
        allSignals.push({ type: "SIGNAL", emoji: "📉", message: `${pos.symbol} touche Bollinger bas $${bollinger.lower.toFixed(2)} — rebond potentiel` });
      }
      if (livePrice >= bollinger.upper) {
        allSignals.push({ type: "SIGNAL", emoji: "📈", message: `${pos.symbol} touche Bollinger haut $${bollinger.upper.toFixed(2)} — correction potentielle` });
      }
      if (bollinger.bandwidth < 2) {
        allSignals.push({ type: "INFO", emoji: "🔧", message: `${pos.symbol} Bollinger squeeze (BW=${bollinger.bandwidth.toFixed(1)}%) — breakout imminent` });
      }
    }

    // Trailing stop signal
    if (trailing?.triggered) {
      allSignals.push({ type: "ALERT", emoji: "🛑", message: `${pos.symbol} TRAILING STOP @ $${trailing.stopPrice.toFixed(2)} (HWM: $${trailingStops.get(pos.symbol)?.highWaterMark.toFixed(2)})` });
    }

    // Auto-execution — evaluate and execute trade decisions
    if (pos.entryPrice > 0) { // only for positions we own
      const decision = evaluateAutoTrade(pos, techData, vwap, snap, bollinger, trailing);
      if (decision.action !== "HOLD" && decision.confidence >= 60) {
        await executeDecision(decision, sendAlert);
      }
    }
  }

  // Log signals to notes only — don't spam Nicolas's Telegram
  // He only wants notifications when an actual trade is executed (handled in executeDecision)
  if (allSignals.length > 0) {
    const alertKey = allSignals.map((s) => s.message).join("|");
    if (alertKey !== lastAlertKey) {
      lastAlertKey = alertKey;
      log.debug(`[trading-monitor] ${allSignals.length} signals (logged, not sent): ${allSignals.map(s => s.message).join("; ").slice(0, 200)}`);
    }
  }
}

// ── Prompt builder (for LLM analysis cycles) ──

function buildTradingMonitorPrompt(cycle: number): string | null {
  if (!isMarketHours()) return null;

  const rotation = cycle % 3;
  const positionList = POSITIONS.map(
    (p) =>
      `${p.symbol} (entry: $${p.entryPrice || "pending"}, SL: $${p.stopLoss || "N/A"}, TP: $${p.takeProfit1 || "N/A"}/$${p.takeProfit2 || "N/A"})${p.note ? " — " + p.note : ""}`
  ).join("\n");

  if (rotation === 0) {
    return (
      `[MODEL:ollama]\n` +
      `Tu es TradingMonitor. Voici les positions du portfolio:\n\n` +
      `${positionList}\n\n` +
      `Les vérifications quantitatives (RSI, VWAP, stop-loss, take-profit) sont faites automatiquement chaque minute par le code.\n` +
      `Réponds simplement: "Monitoring actif. Aucune alerte." si tout est normal.`
    );
  }

  if (rotation === 1) {
    return (
      `[MODEL:ollama]\n` +
      `Tu es TradingMonitor. Résume l'état du marché.\n` +
      `Positions:\n${positionList}\n` +
      `Réponds en 2-3 phrases max.`
    );
  }

  return (
    `[MODEL:ollama]\n` +
    `Tu es TradingMonitor, analyste quantitatif.\n\n` +
    `Portfolio:\n${positionList}\n\n` +
    `Stratégie: Day/swing trading, RSI + VWAP based\n` +
    `Données intraday: snapshots Alpaca chaque minute, VWAP calculé toutes les 5 min\n\n` +
    `Donne une analyse brève (3-4 phrases) sur la stratégie et les risques.`
  );
}

export function createTradingMonitorConfig(): AgentConfig {
  return {
    id: "trading-monitor",
    name: "Trading Monitor",
    role: "Quantitative portfolio monitoring — RSI, VWAP, stop-loss/take-profit, intraday data",
    heartbeatMs: config.agentTradingMonitorHeartbeatMs,
    enabled: config.agentTradingMonitorEnabled,
    chatId: 104,
    userId: config.voiceUserId,
    buildPrompt: buildTradingMonitorPrompt,
    onTick,
    cycleCount: 3,
  };
}

// ── Exported for use by trading skills ──
export {
  fetchTechnicals, generateSignals, calculateRollingRsi, detectRsiDivergence,
  fetchAlpacaSnapshots, fetchIntradayBars, calculateVWAP, calculateBollinger,
  placeOrder, loadJournal, POSITIONS, RISK_RULES,
};
export type { TechnicalData, Signal, AlertLevel, IntradayBar, AlpacaSnapshot, BollingerBands, TradeEntry };
