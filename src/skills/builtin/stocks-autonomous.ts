/**
 * Autonomous Stocks Trading Engine — Kingston Edge v2 (Paper Trading)
 *
 * Scans watchlist via Yahoo Finance + Alpaca paper API.
 * Strategies: Catalyst, Momentum, Dip-Buy, Sector Rotation.
 * Risk: Volatility-adjusted sizing (1.5% equity / 1.5x ATR), 3-tier exits via bracket-manager.
 * Macro filters: VIX kill-switch, S&P MA50 exposure reduction.
 *
 * Skills: stocks_auto.tick, stocks_auto.status, stocks_auto.toggle, stocks_auto.signals
 */
import { registerSkill } from "../loader.js";
import { log } from "../../utils/log.js";

// ─── Configuration ───

const WATCHLIST = ["COIN", "DKNG", "HIMS", "HOOD", "IONQ", "JOBY", "LUNR", "RGTI"];
const PAPER_URL = "https://paper-api.alpaca.markets";
const DATA_URL = "https://data.alpaca.markets";
const YF_URL = "https://query1.finance.yahoo.com/v8/finance/chart";
const YF_UA = { "User-Agent": "Mozilla/5.0" };

const MAX_POSITIONS = 4;           // Edge v2: 4 concurrent positions
const RISK_PCT = 0.015;            // Edge v2: 1.5% of equity per trade
const MAX_POSITION_PCT = 0.20;     // Edge v2: 20% max per position
const MAX_EXPOSURE_PCT = 0.60;     // Edge v2: 60% total exposure
const STOP_LOSS_PCT = -0.02;       // Backup SL if bracket-manager fails
const TAKE_PROFIT_PCT = 0.04;      // Backup TP
const TRAILING_TRIGGER = 0.02;     // Trailing after +2% (backup)
const TRAILING_DROP = 0.015;       // Trailing stop 1.5% below peak (backup)
const MAX_DAILY_LOSS_PCT = -0.02;  // -2% daily kill-switch
const CIRCUIT_BREAKER_LOSSES = 3;
const NO_ENTRY_AFTER_HOUR = 15;
const NO_ENTRY_AFTER_MIN = 30;
const CLOSE_ALL_HOUR = 15;
const CLOSE_ALL_MIN = 45;
const MIN_BUY_CONFIDENCE = 40;     // Edge v2: lowered threshold (more entry types)

// ─── In-Memory State ───

interface StockSignal {
  ts: number;
  symbol: string;
  action: "BUY" | "SELL" | "SL" | "TP" | "TRAILING" | "EOD_CLOSE" | "GAP_FADE";
  confidence: number;
  reason: string;
  price: number;
  executed: boolean;
}

interface PositionState {
  symbol: string;
  entryPrice: number;
  highWatermark: number;
  enteredAt: number;
}

const positionStates: Record<string, PositionState> = {};
const recentSignals: StockSignal[] = [];
const MAX_SIGNALS = 50;

let enabled = true;
let consecutiveLosses = 0;
let dailyPnl = 0;
let dailyDate = "";
let dailyTradeCount = 0;
let dailyNewPositions = 0;  // Edge v2: track new entries for VIX rate limiting
let lastTickTs = 0;

// ─── Helpers ───

function fmt(n: number | undefined | null, d = 2): string {
  return n == null ? "N/A" : n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

function fmtPnl(n: number): string {
  return `${n >= 0 ? "+" : ""}$${fmt(n)}`;
}

function nowET(): { hour: number; min: number; dateStr: string; dayOfWeek: number } {
  const d = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Toronto", hour: "numeric", minute: "numeric", hour12: false,
  }).formatToParts(d);
  const hour = parseInt(parts.find(p => p.type === "hour")?.value || "0");
  const min = parseInt(parts.find(p => p.type === "minute")?.value || "0");
  const dateStr = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(d);
  const dayOfWeek = new Date(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(d)).getDay();
  return { hour, min, dateStr, dayOfWeek };
}

function isMarketOpen(): boolean {
  const { hour, min, dayOfWeek } = nowET();
  if (dayOfWeek === 0 || dayOfWeek === 6) return false; // Weekend
  const timeMin = hour * 60 + min;
  return timeMin >= 9 * 60 + 30 && timeMin < 16 * 60; // 9:30 - 16:00
}

function shouldCloseAll(): boolean {
  const { hour, min } = nowET();
  return hour === CLOSE_ALL_HOUR && min >= CLOSE_ALL_MIN;
}

function canOpenNew(): boolean {
  const { hour, min } = nowET();
  const timeMin = hour * 60 + min;
  return timeMin < NO_ENTRY_AFTER_HOUR * 60 + NO_ENTRY_AFTER_MIN; // Before 15:30
}

// Buffer alerts for daily digest instead of spamming Telegram
const alertBuffer: string[] = [];

async function sendAlert(text: string): Promise<void> {
  // Store in buffer — will be sent as daily digest at noon
  alertBuffer.push(`[${new Date().toLocaleTimeString("en-US", { timeZone: "America/Toronto", hour12: false })}] ${text}`);
  log.info(`[stocks_auto] Alert buffered (${alertBuffer.length} total)`);
}

/** Get and clear buffered alerts — called by noon digest cron */
export function flushAlertBuffer(): string[] {
  const copy = [...alertBuffer];
  alertBuffer.length = 0;
  return copy;
}

function addSignal(s: StockSignal): void {
  recentSignals.unshift(s);
  if (recentSignals.length > MAX_SIGNALS) recentSignals.length = MAX_SIGNALS;
}

// ─── Alpaca API ───

function getHeaders(): Record<string, string> {
  const key = process.env.ALPACA_API_KEY || "";
  const secret = process.env.ALPACA_SECRET_KEY || "";
  if (!key || !secret) throw new Error("ALPACA_API_KEY and ALPACA_SECRET_KEY required");
  return { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret, "Content-Type": "application/json" };
}

async function alpacaGet(path: string, base = PAPER_URL): Promise<any> {
  const resp = await fetch(`${base}${path}`, { headers: getHeaders(), signal: AbortSignal.timeout(10000) });
  if (!resp.ok) throw new Error(`Alpaca ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

async function alpacaPost(path: string, body: any): Promise<any> {
  const resp = await fetch(`${PAPER_URL}${path}`, {
    method: "POST", headers: getHeaders(), body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) throw new Error(`Alpaca ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

async function alpacaDelete(path: string): Promise<void> {
  const resp = await fetch(`${PAPER_URL}${path}`, { method: "DELETE", headers: getHeaders(), signal: AbortSignal.timeout(10000) });
  if (!resp.ok && resp.status !== 204) throw new Error(`Alpaca DELETE ${resp.status}`);
}

async function getAccount(): Promise<{ equity: number; cash: number; buying_power: number }> {
  return alpacaGet("/v2/account");
}

async function getPositions(): Promise<any[]> {
  return alpacaGet("/v2/positions");
}

async function placeBuy(symbol: string, qty: number): Promise<any> {
  return alpacaPost("/v2/orders", {
    symbol, qty: String(qty), side: "buy", type: "market", time_in_force: "day",
  });
}

async function placeSell(symbol: string, qty: number): Promise<any> {
  return alpacaPost("/v2/orders", {
    symbol, qty: String(qty), side: "sell", type: "market", time_in_force: "day",
  });
}

async function closeAllPositions(): Promise<void> {
  await fetch(`${PAPER_URL}/v2/positions`, { method: "DELETE", headers: getHeaders() });
}

// ─── Yahoo Finance Data ───

interface StockData {
  symbol: string;
  price: number;
  prevClose: number;
  gapPct: number;
  volume: number;
  avgVolume: number;
  ma20: number | null;
  ma50: number | null;
  rsi14: number | null;
  high: number;
  low: number;
  // Edge v2 additions
  atr14: number | null;
  macdHistogram: number | null;
  bollingerLower: number | null;
  stochRsi: number | null;
  volTrend20: boolean;
  ma20AboveMa50: boolean;
}

async function fetchStockData(symbol: string): Promise<StockData | null> {
  try {
    const resp = await fetch(`${YF_URL}/${symbol}?interval=1d&range=6mo`, {
      headers: YF_UA, signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const result = data?.chart?.result?.[0];
    const meta = result?.meta;
    if (!meta) return null;

    const quote = result?.indicators?.quote?.[0];
    const closes: number[] = (quote?.close || []).filter((c: any) => c != null);
    const highs: number[] = (quote?.high || []).filter((h: any) => h != null);
    const lows: number[] = (quote?.low || []).filter((l: any) => l != null);
    const volumes: number[] = (quote?.volume || []).filter((v: any) => v != null);
    const price = meta.regularMarketPrice;
    const prevClose = meta.chartPreviousClose || meta.previousClose || price;

    // MA20 / MA50
    let ma20: number | null = null;
    let ma50: number | null = null;
    if (closes.length >= 20) ma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    if (closes.length >= 50) ma50 = closes.slice(-50).reduce((a, b) => a + b, 0) / 50;

    // RSI(14)
    let rsi14: number | null = null;
    if (closes.length >= 15) {
      let gains = 0, losses = 0;
      for (let i = closes.length - 14; i < closes.length; i++) {
        const change = closes[i] - closes[i - 1];
        if (change > 0) gains += change; else losses += Math.abs(change);
      }
      const avgG = gains / 14, avgL = losses / 14;
      rsi14 = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
    }

    // ATR(14) — True Range over 14 periods
    let atr14: number | null = null;
    const minLen = Math.min(highs.length, lows.length, closes.length);
    if (minLen >= 15) {
      let atrSum = 0;
      for (let i = minLen - 14; i < minLen; i++) {
        const tr = Math.max(
          highs[i] - lows[i],
          Math.abs(highs[i] - closes[i - 1]),
          Math.abs(lows[i] - closes[i - 1])
        );
        atrSum += tr;
      }
      atr14 = atrSum / 14;
    }

    // MACD histogram (12/26/9 EMA)
    let macdHistogram: number | null = null;
    if (closes.length >= 35) {
      const ema = (arr: number[], period: number): number[] => {
        const k = 2 / (period + 1);
        const res = [arr[0]];
        for (let i = 1; i < arr.length; i++) {
          res.push(arr[i] * k + res[i - 1] * (1 - k));
        }
        return res;
      };
      const ema12 = ema(closes, 12);
      const ema26 = ema(closes, 26);
      const macdLine = ema12.map((v, i) => v - ema26[i]);
      const signalLine = ema(macdLine.slice(26), 9);
      macdHistogram = macdLine[macdLine.length - 1] - signalLine[signalLine.length - 1];
    }

    // Bollinger Lower Band (MA20 - 2σ)
    let bollingerLower: number | null = null;
    if (closes.length >= 20 && ma20 !== null) {
      const recent20 = closes.slice(-20);
      const variance = recent20.reduce((sum, c) => sum + (c - ma20!) ** 2, 0) / 20;
      bollingerLower = ma20 - 2 * Math.sqrt(variance);
    }

    // Stochastic RSI (14-period RSI, then stochastic of RSI)
    let stochRsi: number | null = null;
    if (closes.length >= 29) {
      const rsiValues: number[] = [];
      for (let j = closes.length - 15; j < closes.length; j++) {
        let g = 0, l = 0;
        for (let k = j - 13; k <= j; k++) {
          const ch = closes[k] - closes[k - 1];
          if (ch > 0) g += ch; else l += Math.abs(ch);
        }
        const ag = g / 14, al = l / 14;
        rsiValues.push(al === 0 ? 100 : 100 - 100 / (1 + ag / al));
      }
      if (rsiValues.length >= 14) {
        const maxR = Math.max(...rsiValues.slice(-14));
        const minR = Math.min(...rsiValues.slice(-14));
        const curR = rsiValues[rsiValues.length - 1];
        stochRsi = maxR === minR ? 50 : ((curR - minR) / (maxR - minR)) * 100;
      }
    }

    // Volume trend (recent 10 days vs prior 10 days)
    let volTrend20 = false;
    if (volumes.length >= 20) {
      const recent10 = volumes.slice(-10).reduce((a, b) => a + b, 0) / 10;
      const prior10 = volumes.slice(-20, -10).reduce((a, b) => a + b, 0) / 10;
      volTrend20 = recent10 > prior10;
    }

    // Average volume (20-day)
    const avgVolume = volumes.length >= 20
      ? volumes.slice(-20).reduce((a, b) => a + b, 0) / 20
      : volumes.length >= 10
        ? volumes.slice(-10).reduce((a, b) => a + b, 0) / 10
        : meta.regularMarketVolume || 1;

    return {
      symbol: symbol.toUpperCase(),
      price, prevClose,
      gapPct: ((price - prevClose) / prevClose) * 100,
      volume: meta.regularMarketVolume || 0,
      avgVolume,
      ma20, ma50, rsi14,
      high: meta.regularMarketDayHigh || price,
      low: meta.regularMarketDayLow || price,
      atr14,
      macdHistogram,
      bollingerLower,
      stochRsi,
      volTrend20,
      ma20AboveMa50: (ma20 !== null && ma50 !== null) ? ma20 > ma50 : false,
    };
  } catch { return null; }
}

// ─── Macro Filters (Edge v2) ───

interface MacroState {
  vix: number | null;
  spyAboveMa50: boolean | null;
}

async function fetchMacroFilters(): Promise<MacroState> {
  const state: MacroState = { vix: null, spyAboveMa50: null };
  try {
    const vixResp = await fetch(`${YF_URL}/%5EVIX?interval=1d&range=5d`, {
      headers: YF_UA, signal: AbortSignal.timeout(8000),
    });
    if (vixResp.ok) {
      const vixData = await vixResp.json();
      state.vix = vixData?.chart?.result?.[0]?.meta?.regularMarketPrice || null;
    }
  } catch { /* VIX unavailable */ }
  try {
    const spyResp = await fetch(`${YF_URL}/SPY?interval=1d&range=3mo`, {
      headers: YF_UA, signal: AbortSignal.timeout(8000),
    });
    if (spyResp.ok) {
      const spyData = await spyResp.json();
      const spyResult = spyData?.chart?.result?.[0];
      const spyPrice = spyResult?.meta?.regularMarketPrice;
      const spyCloses: number[] = (spyResult?.indicators?.quote?.[0]?.close || []).filter((c: any) => c != null);
      if (spyCloses.length >= 50 && spyPrice) {
        const spyMa50 = spyCloses.slice(-50).reduce((a: number, b: number) => a + b, 0) / 50;
        state.spyAboveMa50 = spyPrice > spyMa50;
      }
    }
  } catch { /* SPY unavailable */ }
  return state;
}

// ─── Edge v2 Strategy Engine ───

interface EntrySignal {
  symbol: string;
  confidence: number;
  reason: string;
  price: number;
  strategy: string;
  atr14: number | null;  // Edge v2: for volatility-adjusted sizing
}

function evaluateEntry(data: StockData, macro: MacroState): EntrySignal | null {
  // VIX > 35 → DEFENSIVE MODE: no new entries
  if (macro.vix !== null && macro.vix > 35) return null;

  const volRatio = data.avgVolume > 0 ? data.volume / data.avgVolume : 1;

  // ── A. Catalyst Entry (Earnings Play) ──
  // Detected via: volume > 2x average (proxy for earnings day) + positive reaction + RSI < 70
  if (volRatio > 2.0 && data.gapPct > 0 && data.rsi14 !== null && data.rsi14 < 70) {
    let score = 55;
    const reasons = [`Catalyst: vol ${fmt(volRatio, 1)}x avg, gap +${fmt(data.gapPct, 1)}%`];

    if (data.ma20 && data.price > data.ma20) { score += 10; reasons.push("above MA20"); }
    if (data.ma50 && data.price > data.ma50) { score += 5; reasons.push("above MA50"); }
    if (data.macdHistogram !== null && data.macdHistogram > 0) { score += 5; reasons.push("MACD+"); }
    // Bonus for double-strength volume (> 3x)
    if (volRatio > 3.0) { score += 5; reasons.push(`extreme vol ${fmt(volRatio, 1)}x`); }
    // Penalty for chasing (gap too large = risky)
    if (data.gapPct > 8) { score -= 10; reasons.push("gap >8% — chase risk"); }

    if (score >= MIN_BUY_CONFIDENCE) {
      return {
        symbol: data.symbol, confidence: score,
        reason: reasons.join("; "), price: data.price,
        strategy: "CATALYST", atr14: data.atr14,
      };
    }
  }

  // ── B. Momentum Entry (Trend Following) ──
  // Price > MA20 > MA50, MACD histogram positive, RSI 40-65, volume trending up
  if (data.ma20 && data.ma50 && data.ma20AboveMa50 && data.price > data.ma20 &&
      data.rsi14 !== null && data.rsi14 >= 40 && data.rsi14 <= 65 &&
      data.macdHistogram !== null && data.macdHistogram > 0 && data.volTrend20) {
    let score = 50;
    const reasons = [`Momentum: MA20>MA50, RSI ${fmt(data.rsi14, 0)}, MACD+, vol↑`];

    // Pullback to MA20 bonus (ideal entry — within 2% of MA20)
    if (data.price <= data.ma20 * 1.02) { score += 10; reasons.push("near MA20 pullback"); }
    if (volRatio > 1.5) { score += 5; reasons.push(`vol ${fmt(volRatio, 1)}x`); }
    // Strong trend: price well above MA50
    if (data.price > data.ma50 * 1.05) { score += 5; reasons.push("strong trend >5% above MA50"); }

    if (score >= MIN_BUY_CONFIDENCE) {
      return {
        symbol: data.symbol, confidence: score,
        reason: reasons.join("; "), price: data.price,
        strategy: "MOMENTUM", atr14: data.atr14,
      };
    }
  }

  // ── C. Dip-Buy Entry (Mean Reversion) ──
  // RSI < 30, price at/below lower Bollinger Band, StochRSI < 20 with confirmation
  if (data.rsi14 !== null && data.rsi14 < 30 &&
      data.bollingerLower !== null && data.price <= data.bollingerLower) {
    let score = 50;
    const reasons = [`Dip-Buy: RSI ${fmt(data.rsi14, 0)}, below BB lower $${fmt(data.bollingerLower)}`];

    // StochRSI confirmation (bullish crossover zone)
    if (data.stochRsi !== null && data.stochRsi < 20) { score += 10; reasons.push(`StochRSI ${fmt(data.stochRsi, 0)}`); }
    // Volume confirms reversal interest
    if (volRatio > 1.2) { score += 5; reasons.push("volume confirming"); }
    // Near MA50 support = safer dip buy
    if (data.ma50 && data.price > data.ma50 * 0.95) { score += 5; reasons.push("near MA50 support"); }
    // Penalty: sector in downtrend (SPY below MA50 = risk)
    if (macro.spyAboveMa50 === false) { score -= 15; reasons.push("SPY<MA50 — sector risk"); }
    // No dip-buy in extreme volatility
    if (macro.vix !== null && macro.vix > 30) { score -= 10; reasons.push("VIX>30 — high vol caution"); }

    if (score >= MIN_BUY_CONFIDENCE) {
      return {
        symbol: data.symbol, confidence: score,
        reason: reasons.join("; "), price: data.price,
        strategy: "DIP_BUY", atr14: data.atr14,
      };
    }
  }

  // ── D. Sector Rotation Entry ──
  // Breakout above MA20 with sector momentum, RSI not overbought
  if (data.ma20 && data.price > data.ma20 * 1.02 && volRatio > 1.5 &&
      data.rsi14 !== null && data.rsi14 > 30 && data.rsi14 < 60) {
    let score = 45;
    const reasons = [`Sector Rotation: breakout >MA20+2%, vol ${fmt(volRatio, 1)}x, RSI ${fmt(data.rsi14, 0)}`];

    if (data.ma50 && data.price > data.ma50) { score += 5; reasons.push("above MA50"); }
    if (data.macdHistogram !== null && data.macdHistogram > 0) { score += 5; reasons.push("MACD+"); }
    if (data.ma20AboveMa50) { score += 5; reasons.push("golden alignment MA20>MA50"); }
    // SPY above MA50 = healthy market for rotation
    if (macro.spyAboveMa50 === true) { score += 5; reasons.push("SPY>MA50 — healthy market"); }

    if (score >= MIN_BUY_CONFIDENCE) {
      return {
        symbol: data.symbol, confidence: score,
        reason: reasons.join("; "), price: data.price,
        strategy: "SECTOR_ROTATION", atr14: data.atr14,
      };
    }
  }

  return null;
}

// ─── Bracket Manager Deference ───
// If bracket-manager (heartbeat.ts) has placed ATR-based brackets for a symbol,
// this system defers to it instead of using fixed % stops.

function hasBracketCoverage(symbol: string): boolean {
  try {
    const fs = require("fs");
    const path = require("path");
    const bracketPath = path.join(process.cwd(), "data", "bracket-state.json");
    if (!fs.existsSync(bracketPath)) return false;
    const state = JSON.parse(fs.readFileSync(bracketPath, "utf-8"));
    const bracket = state[symbol];
    if (!bracket) return false;
    // Edge v2: check for tp1OrderId (3-tier) instead of tpOrderId
    if (bracket.version === "edge-v2") {
      if (!bracket.slOrderId || !bracket.tp1OrderId) return false;
    } else {
      if (!bracket?.slOrderId || !bracket?.tpOrderId) return false;
    }
    // Verify bracket is fresh (< 10 min) — stale = no coverage
    if (bracket.placedAt) {
      const age = Date.now() - new Date(bracket.placedAt).getTime();
      if (age > 600_000) return false;
    }
    return true;
  } catch {
    // On error, assume bracket exists (conservative: don't double-exit)
    return true;
  }
}

// ─── Position Exit Checks ───

type ExitReason = "SL" | "TP" | "TRAILING" | "EOD_CLOSE" | "RSI_OB" | null;

function checkExit(symbol: string, currentPrice: number, entryPrice: number, rsi: number | null): ExitReason {
  const state = positionStates[symbol];
  if (!state) return null;

  // DEFER to bracket-manager if it has ATR-based brackets for this symbol
  if (hasBracketCoverage(symbol)) return null;

  const pnlPct = (currentPrice - entryPrice) / entryPrice;

  // Update high watermark
  if (currentPrice > state.highWatermark) {
    state.highWatermark = currentPrice;
  }

  // Hard stop-loss: -2%
  if (pnlPct <= STOP_LOSS_PCT) return "SL";

  // Take-profit: +4%
  if (pnlPct >= TAKE_PROFIT_PCT) return "TP";

  // Trailing stop: activated after +2%, triggers at 1.5% below peak
  if (pnlPct >= TRAILING_TRIGGER) {
    const dropFromPeak = (currentPrice - state.highWatermark) / state.highWatermark;
    if (dropFromPeak <= -TRAILING_DROP) return "TRAILING";
  }

  // RSI overbought
  if (rsi !== null && rsi > 75) return "RSI_OB";

  // End of day close
  if (shouldCloseAll()) return "EOD_CLOSE";

  return null;
}

// ─── Main Tick ───

async function runTick(): Promise<string> {
  const lines: string[] = [];
  const { dateStr, dayOfWeek, hour, min } = nowET();

  // Reset daily counters
  if (dailyDate !== dateStr) {
    dailyDate = dateStr;
    dailyPnl = 0;
    dailyTradeCount = 0;
    dailyNewPositions = 0;
    consecutiveLosses = 0;
  }

  if (!enabled) return "[stocks_auto] DISABLED — use stocks_auto.toggle to re-enable.";

  // Weekend check
  if (dayOfWeek === 0 || dayOfWeek === 6) return "[stocks_auto] Weekend — markets closed.";

  // Market hours check
  if (!isMarketOpen()) {
    return `[stocks_auto] Markets closed (${hour}:${String(min).padStart(2, "0")} ET). Open 9:30-16:00.`;
  }

  // Circuit breakers
  let account: any;
  try {
    account = await getAccount();
  } catch (e) {
    return `[stocks_auto] Alpaca account error: ${e instanceof Error ? e.message : String(e)}`;
  }

  const equity = parseFloat(account.equity);
  const dailyLossPct = equity > 0 ? dailyPnl / equity : 0;

  if (dailyLossPct <= MAX_DAILY_LOSS_PCT) {
    return `[stocks_auto] CIRCUIT BREAKER: daily loss ${fmt(dailyLossPct * 100)}% exceeds -3% limit.`;
  }
  if (consecutiveLosses >= CIRCUIT_BREAKER_LOSSES) {
    return `[stocks_auto] CIRCUIT BREAKER: ${consecutiveLosses} consecutive losses.`;
  }

  // Edge v2: Fetch macro filters (VIX + SPY MA50)
  let macro: MacroState = { vix: null, spyAboveMa50: null };
  try {
    macro = await fetchMacroFilters();
  } catch { /* use defaults */ }

  // Edge v2: Determine max exposure based on macro
  let maxExposure = MAX_EXPOSURE_PCT; // Default 60%
  if (macro.spyAboveMa50 === false) {
    maxExposure = 0.40; // S&P below MA50 → reduce to 40%
  }

  // Edge v2: Determine max new entries based on VIX
  let maxNewEntriesToday = 4; // Default
  if (macro.vix !== null && macro.vix > 35) {
    maxNewEntriesToday = 0; // DEFENSIVE MODE
  } else if (macro.vix !== null && macro.vix > 25) {
    maxNewEntriesToday = 1; // Max 1 new position per day
  }

  // 1. Close all at 15:45
  if (shouldCloseAll()) {
    try {
      const positions = await getPositions();
      if (positions.length > 0) {
        await closeAllPositions();
        let totalPnl = 0;
        for (const p of positions) {
          const pnl = parseFloat(p.unrealized_pl || "0");
          totalPnl += pnl;
          delete positionStates[p.symbol];
        }
        dailyPnl += totalPnl;
        const msg = `🔔 *EOD CLOSE ALL*\n${positions.length} positions fermées\nP&L: ${fmtPnl(totalPnl)}`;
        lines.push(msg);
        addSignal({ ts: Date.now(), symbol: "ALL", action: "EOD_CLOSE", confidence: 100, reason: "15h45 — fermeture fin de journée", price: 0, executed: true });
        sendAlert(msg).catch(() => {});
      }
    } catch (e) {
      lines.push(`[stocks_auto] Close all error: ${e}`);
    }
    return lines.join("\n") || "[stocks_auto] No positions to close at EOD.";
  }

  // 2. Check existing positions for exits
  let positions: any[];
  try {
    positions = await getPositions();
  } catch (e) {
    return `[stocks_auto] Positions fetch error: ${e}`;
  }

  for (const pos of positions) {
    const symbol = pos.symbol;
    const currentPrice = parseFloat(pos.current_price);
    const entryPrice = parseFloat(pos.avg_entry_price);
    const qty = parseFloat(pos.qty);

    // Ensure position state
    if (!positionStates[symbol]) {
      positionStates[symbol] = {
        symbol, entryPrice, highWatermark: currentPrice,
        enteredAt: Date.now(),
      };
    }

    // Quick RSI check from Yahoo
    let rsi: number | null = null;
    try {
      const data = await fetchStockData(symbol);
      if (data) rsi = data.rsi14;
    } catch { /* use null */ }

    const exit = checkExit(symbol, currentPrice, entryPrice, rsi);
    if (exit) {
      try {
        await placeSell(symbol, qty);
        const pnl = (currentPrice - entryPrice) * qty;
        const pnlPct = ((currentPrice / entryPrice) - 1) * 100;
        dailyPnl += pnl;
        dailyTradeCount++;
        if (pnl < 0) consecutiveLosses++; else consecutiveLosses = 0;
        delete positionStates[symbol];

        const emoji = exit === "TP" || exit === "TRAILING" ? "💰" : exit === "SL" ? "🚨" : "🔴";
        const msg = `${emoji} *STOCK AUTO-SELL (${exit})*\n${symbol} — ${qty} @ $${fmt(currentPrice)}\nP&L: ${fmtPnl(pnl)} (${pnlPct >= 0 ? "+" : ""}${fmt(pnlPct)}%)\nDaily: ${fmtPnl(dailyPnl)}`;
        lines.push(msg);
        addSignal({ ts: Date.now(), symbol, action: exit as any, confidence: 100, reason: `${exit}: ${fmtPnl(pnl)}`, price: currentPrice, executed: true });
        sendAlert(msg).catch(() => {});
      } catch (e) {
        lines.push(`[stocks_auto] Sell ${symbol} error: ${e}`);
      }
    }
  }

  // Edge v2: Earnings Protocol — check existing positions
  for (const pos of positions) {
    try {
      const sym = pos.symbol;
      const entryPrice = parseFloat(pos.avg_entry_price);
      const currentPrice = parseFloat(pos.current_price);
      const posQty = Math.abs(parseInt(pos.qty));
      const posData = await fetchStockData(sym);
      if (!posData || !posData.atr14) continue;

      const R = 1.5 * posData.atr14;
      const profitInR = (currentPrice - entryPrice) / R;
      const volRatio = posData.avgVolume > 0 ? posData.volume / posData.avgVolume : 1;

      // Pre-earnings: If profit > 2R and volume spiking (earnings imminent), sell 50%
      if (profitInR > 2 && volRatio > 2.5) {
        const sellQty = Math.floor(posQty * 0.5);
        if (sellQty > 0) {
          await placeSell(sym, sellQty);
          const pnl = (currentPrice - entryPrice) * sellQty;
          dailyPnl += pnl;
          dailyTradeCount++;
          const msg = `📋 *EARNINGS PROTOCOL*\n${sym} — Sold 50% (${sellQty}) @ $${fmt(currentPrice)}\nProfit: ${fmtPnl(pnl)} (+${fmt(profitInR, 1)}R)\nReason: >2R profit + volume spike`;
          lines.push(msg);
          addSignal({ ts: Date.now(), symbol: sym, action: "TP" as any, confidence: 100, reason: `Earnings protocol: +${fmt(profitInR, 1)}R`, price: currentPrice, executed: true });
          sendAlert(msg).catch(() => {});
        }
      }
    } catch { /* skip earnings check on error */ }
  }

  // 3. Scan for new entries (if allowed)
  // Edge v2: Check exposure limit + VIX entry cap
  const totalMarketValue = positions.reduce((sum: number, p: any) => sum + Math.abs(parseFloat(p.market_value || "0")), 0);
  const exposurePct = equity > 0 ? totalMarketValue / equity : 0;
  const withinExposure = exposurePct < maxExposure;
  const withinDailyEntryLimit = dailyNewPositions < maxNewEntriesToday;

  if (canOpenNew() && positions.length < MAX_POSITIONS && dailyTradeCount < 15 && withinExposure && withinDailyEntryLimit) {
    const heldSymbols = new Set(positions.map((p: any) => p.symbol));

    // Fetch data for watchlist (parallel, with error handling)
    const dataPromises = WATCHLIST
      .filter(s => !heldSymbols.has(s))
      .map(async s => ({ symbol: s, data: await fetchStockData(s).catch(() => null) }));

    const results = await Promise.all(dataPromises);

    // Edge v2: Evaluate and rank signals with macro context
    const signals: EntrySignal[] = [];
    for (const r of results) {
      if (!r.data) continue;
      const signal = evaluateEntry(r.data, macro);
      if (signal) signals.push(signal);
    }

    // Sort by confidence, take best
    signals.sort((a, b) => b.confidence - a.confidence);
    const slotsAvailable = Math.min(
      MAX_POSITIONS - positions.length,
      maxNewEntriesToday - dailyNewPositions,
    );

    for (const signal of signals.slice(0, slotsAvailable)) {
      // Edge v2: Check if adding this position would exceed max exposure
      const positionValue = signal.price * Math.floor((equity * RISK_PCT) / (1.5 * (signal.atr14 || signal.price * 0.03)));
      if ((totalMarketValue + positionValue) / equity > maxExposure) continue;

      try {
        const buyingPower = parseFloat(account.buying_power || "0");

        // Edge v2: Volatility-adjusted position sizing
        // qty = (Equity × 1.5% risk) / (1.5 × ATR stop distance)
        const atr = signal.atr14 || signal.price * 0.03; // Fallback: 3% of price
        const stopDistance = 1.5 * atr;
        const riskAmount = equity * RISK_PCT; // 1.5% of equity
        const volAdjustedQty = Math.floor(riskAmount / stopDistance);

        // Cap at 20% of equity AND 40% of buying power
        const maxQtyByEquity = Math.floor((equity * MAX_POSITION_PCT) / signal.price);
        const maxQtyByBP = Math.floor((buyingPower * 0.4) / signal.price);
        const qty = Math.min(volAdjustedQty, maxQtyByEquity, maxQtyByBP);
        if (qty < 1) continue;

        await placeBuy(signal.symbol, qty);
        dailyTradeCount++;
        dailyNewPositions++;

        positionStates[signal.symbol] = {
          symbol: signal.symbol,
          entryPrice: signal.price,
          highWatermark: signal.price,
          enteredAt: Date.now(),
        };

        const total = qty * signal.price;
        const atrInfo = signal.atr14 ? ` | ATR=$${fmt(signal.atr14)}` : "";
        const msg = `🟢 *EDGE v2 BUY (${signal.strategy})*\n${signal.symbol} — ${qty} @ $${fmt(signal.price)}\nTotal: $${fmt(total)}${atrInfo}\nConfidence: ${signal.confidence}%\nRaison: ${signal.reason}`;
        lines.push(msg);
        addSignal({ ts: Date.now(), symbol: signal.symbol, action: "BUY", confidence: signal.confidence, reason: signal.reason, price: signal.price, executed: true });
        sendAlert(msg).catch(() => {});
      } catch (e) {
        lines.push(`[stocks_auto] Buy ${signal.symbol} error: ${e}`);
      }
    }
  }

  // 4. Run alert checks (price alerts + auto-exits)
  try {
    const { getSkill } = await import("../loader.js");
    const alertCheckSkill = getSkill("trading.alert_check");
    if (alertCheckSkill) {
      const alertResult = await alertCheckSkill.execute({});
      if (alertResult && !alertResult.startsWith("[alert_check] OK")) {
        lines.push(alertResult);
      }
    }
  } catch { /* alerts module not loaded yet */ }

  if (lines.length === 0) {
    const macroInfo = macro.vix !== null ? ` | VIX:${fmt(macro.vix, 1)}` : "";
    const spyInfo = macro.spyAboveMa50 !== null ? ` | SPY>${macro.spyAboveMa50 ? "MA50" : "⚠️<MA50"}` : "";
    return `[stocks_auto] Edge v2 Tick OK — ${positions.length}/${MAX_POSITIONS} pos, ${dailyTradeCount} trades, P&L: ${fmtPnl(dailyPnl)}${macroInfo}${spyInfo} | Exp: ${fmt(exposurePct * 100, 0)}%/${fmt(maxExposure * 100, 0)}%`;
  }

  return lines.join("\n\n");
}

// ─── Skills ───

registerSkill({
  name: "stocks_auto.tick",
  description: "Run one autonomous stock trading cycle. Checks exits, scans entries, executes trades. Called by cron during market hours.",
  adminOnly: true,
  argsSchema: { type: "object", properties: {} },
  async execute(): Promise<string> {
    try {
      lastTickTs = Date.now();
      return await runTick();
    } catch (e) {
      const msg = `[stocks_auto] Tick error: ${e instanceof Error ? e.message : String(e)}`;
      log.error(msg);
      return msg;
    }
  },
});

registerSkill({
  name: "stocks_auto.status",
  description: "Show autonomous stock trading status: enabled, positions, P&L, circuit breaker state.",
  adminOnly: true,
  argsSchema: { type: "object", properties: {} },
  async execute(): Promise<string> {
    const { dateStr, hour, min } = nowET();
    const marketOpen = isMarketOpen();

    let accountInfo = "N/A";
    let posInfo: string[] = [];
    try {
      const acc = await getAccount();
      accountInfo = `Equity: $${fmt(Number(acc.equity))} | Cash: $${fmt(Number(acc.cash))} | BP: $${fmt(Number(acc.buying_power))}`;
      const positions = await getPositions();
      for (const p of positions) {
        const pnl = parseFloat(p.unrealized_pl || "0");
        const pnlPct = parseFloat(p.unrealized_plpc || "0") * 100;
        posInfo.push(`  ${p.symbol}: ${p.qty} @ $${fmt(parseFloat(p.avg_entry_price))} → $${fmt(parseFloat(p.current_price))} (${fmtPnl(pnl)} / ${pnlPct >= 0 ? "+" : ""}${fmt(pnlPct)}%)`);
      }
    } catch (e) {
      accountInfo = `Error: ${e}`;
    }

    return [
      `📊 *Stocks Auto-Trading Status*`,
      `Enabled: ${enabled ? "✅" : "❌"} | Market: ${marketOpen ? "🟢 OPEN" : "🔴 CLOSED"} (${hour}:${String(min).padStart(2, "0")} ET)`,
      `${accountInfo}`,
      `Daily P&L: ${fmtPnl(dailyPnl)} (${dateStr}) | Trades: ${dailyTradeCount}`,
      `Consecutive losses: ${consecutiveLosses}/${CIRCUIT_BREAKER_LOSSES}`,
      `Watchlist: ${WATCHLIST.join(", ")}`,
      `Last tick: ${lastTickTs ? new Date(lastTickTs).toISOString() : "never"}`,
      posInfo.length ? `\n📈 *Positions:*\n${posInfo.join("\n")}` : "\nNo open positions.",
    ].join("\n");
  },
});

registerSkill({
  name: "stocks_auto.toggle",
  description: "Enable or disable the autonomous stock trading system.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      state: { type: "string", description: "'on' or 'off'" },
    },
    required: ["state"],
  },
  async execute(args): Promise<string> {
    const state = String(args.state).toLowerCase();
    if (state === "on" || state === "true" || state === "enable") {
      enabled = true;
      consecutiveLosses = 0;
      return "✅ Stock auto-trading ENABLED. Circuit breaker reset.";
    } else {
      enabled = false;
      return "❌ Stock auto-trading DISABLED.";
    }
  },
});

registerSkill({
  name: "stocks_auto.signals",
  description: "Show recent trading signals from the autonomous stock system.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      limit: { type: "number", description: "Number of signals (default 10)" },
    },
  },
  async execute(args): Promise<string> {
    const limit = Number(args.limit) || 10;
    if (recentSignals.length === 0) return "No signals recorded yet.";

    const lines = [`📡 *Last ${Math.min(limit, recentSignals.length)} Stock Signals:*`];
    for (const s of recentSignals.slice(0, limit)) {
      const time = new Date(s.ts).toLocaleTimeString("en-US", { timeZone: "America/Toronto", hour12: false });
      const exec = s.executed ? "✅" : "⏭️";
      lines.push(`${exec} [${time}] ${s.symbol} ${s.action} @ $${fmt(s.price)} (${s.confidence}%) — ${s.reason}`);
    }
    return lines.join("\n");
  },
});

registerSkill({
  name: "stocks_auto.watchlist",
  description: "View or modify the autonomous trading watchlist.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      action: { type: "string", description: "'list', 'add', or 'remove'" },
      symbol: { type: "string", description: "Stock ticker to add/remove" },
    },
  },
  async execute(args): Promise<string> {
    const action = String(args.action || "list").toLowerCase();
    if (action === "list") {
      return `📋 Watchlist (${WATCHLIST.length}): ${WATCHLIST.join(", ")}`;
    }
    const symbol = String(args.symbol || "").toUpperCase().trim();
    if (!symbol) return "❌ Symbol required.";
    if (action === "add") {
      if (WATCHLIST.includes(symbol)) return `${symbol} already in watchlist.`;
      WATCHLIST.push(symbol);
      return `✅ Added ${symbol}. Watchlist: ${WATCHLIST.join(", ")}`;
    }
    if (action === "remove") {
      const idx = WATCHLIST.indexOf(symbol);
      if (idx === -1) return `${symbol} not in watchlist.`;
      WATCHLIST.splice(idx, 1);
      return `✅ Removed ${symbol}. Watchlist: ${WATCHLIST.join(", ")}`;
    }
    return "❌ Unknown action. Use 'list', 'add', or 'remove'.";
  },
});

log.info(`[stocks_auto] Kingston Edge v2 loaded (${WATCHLIST.length} stocks, ${MAX_POSITIONS} max pos, ${RISK_PCT * 100}% risk, ${MAX_EXPOSURE_PCT * 100}% max exposure)`);
