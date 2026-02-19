/**
 * Autonomous Stocks Trading Engine — 9h-16h ET Weekdays (Paper Trading)
 *
 * Scans watchlist via Yahoo Finance + Alpaca paper API.
 * Strategies: Gap and Go, Gap and Fade, Breakout, Dip Buy.
 * Risk management: SL -2%, TP +4%, trailing +2%, close all at 15h45,
 * -3% daily loss cap, 3-consecutive-loss circuit breaker.
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

const MAX_POSITIONS = 3;
const MAX_BUDGET_PCT = 0.30;    // 30% of capital per trade
const STOP_LOSS_PCT = -0.02;    // -2%
const TAKE_PROFIT_PCT = 0.04;   // +4%
const TRAILING_TRIGGER = 0.02;  // Activate trailing after +2%
const TRAILING_DROP = 0.015;    // Trailing stop at 1.5% below peak
const MAX_DAILY_LOSS_PCT = -0.03; // -3% daily
const CIRCUIT_BREAKER_LOSSES = 3;
const NO_ENTRY_AFTER_HOUR = 15; // No new trades after 15h ET
const NO_ENTRY_AFTER_MIN = 30;  // 15h30
const CLOSE_ALL_HOUR = 15;     // Close all at 15h45
const CLOSE_ALL_MIN = 45;
const MIN_BUY_CONFIDENCE = 45;

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

    const closes: number[] = (result?.indicators?.quote?.[0]?.close || []).filter((c: any) => c != null);
    const volumes: number[] = (result?.indicators?.quote?.[0]?.volume || []).filter((v: any) => v != null);
    const price = meta.regularMarketPrice;
    const prevClose = meta.chartPreviousClose || meta.previousClose || price;

    // Indicators
    let ma20: number | null = null;
    let ma50: number | null = null;
    let rsi14: number | null = null;

    if (closes.length >= 20) ma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    if (closes.length >= 50) ma50 = closes.slice(-50).reduce((a, b) => a + b, 0) / 50;
    if (closes.length >= 15) {
      let gains = 0, losses = 0;
      for (let i = closes.length - 14; i < closes.length; i++) {
        const change = closes[i] - closes[i - 1];
        if (change > 0) gains += change; else losses += Math.abs(change);
      }
      const avgG = gains / 14, avgL = losses / 14;
      rsi14 = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
    }

    // Average volume (last 10 days)
    const avgVolume = volumes.length >= 10
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
    };
  } catch { return null; }
}

// ─── Strategy Engine ───

interface EntrySignal {
  symbol: string;
  confidence: number;
  reason: string;
  price: number;
  strategy: string;
}

function evaluateEntry(data: StockData): EntrySignal | null {
  let score = 0;
  const reasons: string[] = [];
  let strategy = "";

  const volRatio = data.avgVolume > 0 ? data.volume / data.avgVolume : 1;

  // ── Gap and Go: gap up > 3% + volume > 1.5x + price > VWAP proxy (MA20) ──
  if (data.gapPct > 3 && data.gapPct <= 10 && volRatio > 1.5 && data.ma20 && data.price > data.ma20) {
    score += 45;
    reasons.push(`Gap&Go: gap +${fmt(data.gapPct, 1)}%, vol ${fmt(volRatio, 1)}x, > MA20`);
    strategy = "GAP_AND_GO";
  }

  // ── Gap and Fade: gap up > 5% + volume declining (price already fading) ──
  if (data.gapPct > 5 && data.price < data.high * 0.97) {
    // Price is already 3%+ below day high → fading
    score += 35;
    reasons.push(`Gap&Fade: gap +${fmt(data.gapPct, 1)}%, prix sous high -3%`);
    strategy = "GAP_AND_FADE";
  }

  // ── Breakout: price > MA20 resistance + volume > 2x ──
  if (data.ma20 && data.price > data.ma20 * 1.02 && volRatio > 2.0) {
    score += 30;
    reasons.push(`Breakout: prix > MA20 +2%, vol ${fmt(volRatio, 1)}x`);
    if (!strategy) strategy = "BREAKOUT";
  }

  // ── Dip Buy: price below MA20 - 2% + RSI < 30 ──
  if (data.ma20 && data.price < data.ma20 * 0.98 && data.rsi14 !== null && data.rsi14 < 30) {
    score += 50;
    reasons.push(`Dip buy: prix < MA20 -2%, RSI ${fmt(data.rsi14, 0)}`);
    if (!strategy) strategy = "DIP_BUY";
  }

  // ── RSI Bonus ──
  if (data.rsi14 !== null) {
    if (data.rsi14 < 35) { score += 10; reasons.push(`RSI oversold ${fmt(data.rsi14, 0)}`); }
    if (data.rsi14 > 70) { score -= 15; reasons.push(`RSI overbought ${fmt(data.rsi14, 0)} — caution`); }
  }

  // ── Volume confirmation ──
  if (volRatio > 1.5) { score += 5; }

  // ── MA50 trend confirmation ──
  if (data.ma50 && data.price > data.ma50) {
    score += 5;
    reasons.push(`Above MA50 (trend ↑)`);
  }

  if (score >= MIN_BUY_CONFIDENCE && strategy) {
    return { symbol: data.symbol, confidence: score, reason: reasons.join("; "), price: data.price, strategy };
  }
  return null;
}

// ─── Position Exit Checks ───

type ExitReason = "SL" | "TP" | "TRAILING" | "EOD_CLOSE" | "RSI_OB" | null;

function checkExit(symbol: string, currentPrice: number, entryPrice: number, rsi: number | null): ExitReason {
  const state = positionStates[symbol];
  if (!state) return null;

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

  // 3. Scan for new entries (if allowed)
  if (canOpenNew() && positions.length < MAX_POSITIONS && dailyTradeCount < 15) {
    const heldSymbols = new Set(positions.map((p: any) => p.symbol));

    // Fetch data for watchlist (parallel, with error handling)
    const dataPromises = WATCHLIST
      .filter(s => !heldSymbols.has(s))
      .map(async s => ({ symbol: s, data: await fetchStockData(s).catch(() => null) }));

    const results = await Promise.all(dataPromises);

    // Evaluate and rank signals
    const signals: EntrySignal[] = [];
    for (const r of results) {
      if (!r.data) continue;
      const signal = evaluateEntry(r.data);
      if (signal) signals.push(signal);
    }

    // Sort by confidence, take best
    signals.sort((a, b) => b.confidence - a.confidence);
    const slotsAvailable = MAX_POSITIONS - positions.length;

    for (const signal of signals.slice(0, slotsAvailable)) {
      try {
        const buyingPower = parseFloat(account.buying_power || "0");
        const maxBudget = equity * MAX_BUDGET_PCT;
        const budget = Math.min(maxBudget, buyingPower * 0.4); // Use max 40% of buying power
        if (budget < 50) continue; // Min $50

        const qty = Math.floor(budget / signal.price);
        if (qty < 1) continue;

        await placeBuy(signal.symbol, qty);
        dailyTradeCount++;

        positionStates[signal.symbol] = {
          symbol: signal.symbol,
          entryPrice: signal.price,
          highWatermark: signal.price,
          enteredAt: Date.now(),
        };

        const total = qty * signal.price;
        const msg = `🟢 *STOCK AUTO-BUY (${signal.strategy})*\n${signal.symbol} — ${qty} @ $${fmt(signal.price)}\nTotal: $${fmt(total)}\nConfidence: ${signal.confidence}%\nRaison: ${signal.reason}`;
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
    return `[stocks_auto] Tick OK — ${positions.length}/${MAX_POSITIONS} positions, ${dailyTradeCount} trades today, P&L: ${fmtPnl(dailyPnl)}`;
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
      accountInfo = `Equity: $${fmt(parseFloat(acc.equity))} | Cash: $${fmt(parseFloat(acc.cash))} | BP: $${fmt(parseFloat(acc.buying_power))}`;
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

log.info(`[stocks_auto] Autonomous stock trading engine loaded (${WATCHLIST.length} stocks, SL ${STOP_LOSS_PCT * 100}%, TP ${TAKE_PROFIT_PCT * 100}%)`);
