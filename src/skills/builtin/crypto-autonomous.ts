/**
 * Autonomous Crypto Trading Engine — 24/7 Paper Trading
 *
 * Monitors BTC, ETH, SOL, BNB via CoinGecko. Calculates MA20, RSI14.
 * Executes paper trades via crypto_paper DB tables.
 * Risk management: SL -3%, TP +5%, trailing +3%, max 6h hold,
 * -5% daily loss cap, 3-consecutive-loss circuit breaker.
 *
 * Skills: crypto_auto.tick, crypto_auto.status, crypto_auto.toggle, crypto_auto.signals
 */
import { registerSkill } from "../loader.js";
import { getDb } from "../../storage/store.js";
import { log } from "../../utils/log.js";

// ─── Configuration ───

const COINS = ["bitcoin", "ethereum", "solana", "binancecoin"] as const;
const SYMBOL_MAP: Record<string, string> = {
  bitcoin: "BTC", ethereum: "ETH", solana: "SOL", binancecoin: "BNB",
};

const MAX_POSITIONS = 2;
const MAX_BUDGET_PCT = 0.30;   // 30% of capital per trade
const STOP_LOSS_PCT = -0.03;   // -3%
const TAKE_PROFIT_PCT = 0.05;  // +5%
const TRAILING_TRIGGER = 0.03; // Activate trailing after +3%
const TRAILING_DROP = 0.02;    // Trailing stop triggers at 2% below peak
const MAX_HOLD_MS = 6 * 60 * 60 * 1000; // 6 hours
const MAX_DAILY_LOSS_PCT = -0.05; // -5% daily
const CIRCUIT_BREAKER_LOSSES = 3;
const MIN_BUY_CONFIDENCE = 40;
const MAX_HISTORY = 120; // ~10h at 5min intervals

// ─── In-Memory State ───

interface PricePoint {
  ts: number;
  price: number;
  vol24h: number;
  change24h: number;
}

interface TradeSignal {
  ts: number;
  coinId: string;
  symbol: string;
  action: "BUY" | "SELL" | "SL" | "TP" | "TRAILING" | "TIME_STOP";
  confidence: number;
  reason: string;
  price: number;
  executed: boolean;
}

const priceHistory: Record<string, PricePoint[]> = {};
const highWatermarks: Record<string, number> = {}; // symbol → highest price since entry
const recentSignals: TradeSignal[] = [];
const MAX_SIGNALS = 50;

let enabled = true;
let consecutiveLosses = 0;
let dailyPnl = 0;
let dailyDate = "";
let lastTickTs = 0;

// ─── Helpers ───

function fmt(n: number, d = 2): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

function fmtPnl(n: number): string {
  return `${n >= 0 ? "+" : ""}$${fmt(n)}`;
}

function nowET(): { hour: number; dateStr: string } {
  const d = new Date();
  const hour = parseInt(new Intl.DateTimeFormat("en-US", { timeZone: "America/Toronto", hour: "numeric", hour12: false }).format(d));
  const dateStr = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(d);
  return { hour, dateStr };
}

async function sendAlert(text: string): Promise<void> {
  try {
    const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID || process.env.ADMIN_CHAT_ID;
    const token = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
    if (!chatId || !token) return;
    // Try Markdown, fallback to plain text
    for (const pm of ["Markdown", undefined] as const) {
      const body: Record<string, unknown> = { chat_id: chatId, text };
      if (pm) body.parse_mode = pm;
      const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      if (resp.ok) return;
      if (pm && resp.status === 400) continue; // Markdown failed, retry plain
      return;
    }
  } catch (e) {
    log.warn(`[crypto_auto] Alert send failed: ${e}`);
  }
}

function addSignal(s: TradeSignal): void {
  recentSignals.unshift(s);
  if (recentSignals.length > MAX_SIGNALS) recentSignals.length = MAX_SIGNALS;
}

// ─── Price Fetching ───

async function fetchPrices(): Promise<Record<string, PricePoint>> {
  const ids = COINS.join(",");
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_vol=true&include_24hr_change=true`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!resp.ok) throw new Error(`CoinGecko ${resp.status}`);
  const data = await resp.json();
  const now = Date.now();
  const result: Record<string, PricePoint> = {};
  for (const coinId of COINS) {
    if (data[coinId]) {
      result[coinId] = {
        ts: now,
        price: data[coinId].usd,
        vol24h: data[coinId].usd_24h_vol || 0,
        change24h: data[coinId].usd_24h_change || 0,
      };
    }
  }
  return result;
}

function recordPrices(prices: Record<string, PricePoint>): void {
  for (const [coinId, pp] of Object.entries(prices)) {
    if (!priceHistory[coinId]) priceHistory[coinId] = [];
    priceHistory[coinId].push(pp);
    if (priceHistory[coinId].length > MAX_HISTORY) {
      priceHistory[coinId] = priceHistory[coinId].slice(-MAX_HISTORY);
    }
  }
}

// ─── Technical Indicators ───

function calcSMA(prices: number[], period: number): number | null {
  if (prices.length < period) return null;
  const slice = prices.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function calcRSI(prices: number[], period = 14): number | null {
  if (prices.length < period + 1) return null;
  let avgGain = 0, avgLoss = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    const change = prices[i] - prices[i - 1];
    if (change > 0) avgGain += change; else avgLoss += Math.abs(change);
  }
  avgGain /= period;
  avgLoss /= period;
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}

function findSupport(prices: number[]): number {
  if (prices.length < 5) return prices[prices.length - 1] || 0;
  const sorted = [...prices].sort((a, b) => a - b);
  const lowCount = Math.max(2, Math.floor(sorted.length * 0.1));
  return sorted.slice(0, lowCount).reduce((a, b) => a + b, 0) / lowCount;
}

// ─── Strategy Engine ───

interface BuySignal {
  coinId: string;
  symbol: string;
  confidence: number;
  reason: string;
  price: number;
}

function evaluateBuySignal(coinId: string): BuySignal | null {
  const history = priceHistory[coinId];
  if (!history || history.length < 21) return null;

  const prices = history.map(h => h.price);
  const current = history[history.length - 1];
  const symbol = SYMBOL_MAP[coinId] || coinId.toUpperCase();

  const ma20 = calcSMA(prices, 20);
  const rsi = calcRSI(prices);
  const support = findSupport(prices.slice(-50));
  const avgVol = history.slice(-20).reduce((s, h) => s + h.vol24h, 0) / 20;
  const volRatio = avgVol > 0 ? current.vol24h / avgVol : 1;

  let score = 0;
  const reasons: string[] = [];

  // Breakout: price > MA20 + volume > 1.5x + RSI < 70
  if (ma20 && current.price > ma20 * 1.01) {
    score += 15;
    reasons.push(`Prix > MA20 (${fmt(ma20)})`);
    if (volRatio > 1.5) {
      score += 15;
      reasons.push(`Volume ${fmt(volRatio, 1)}x`);
    }
    if (rsi !== null && rsi < 70) {
      score += 10;
      reasons.push(`RSI ${fmt(rsi, 0)} < 70`);
    }
  }

  // Dip buy: price < support -2% + RSI < 30
  if (current.price < support * 0.98 && rsi !== null && rsi < 30) {
    score += 50;
    reasons.push(`Dip: prix ${fmt(current.price)} < support ${fmt(support)} -2%, RSI ${fmt(rsi, 0)}`);
  }

  // Momentum bonus: 24h change positive
  if (current.change24h > 3) {
    score += 5;
    reasons.push(`Momentum +${fmt(current.change24h, 1)}% 24h`);
  }

  if (score >= MIN_BUY_CONFIDENCE) {
    return { coinId, symbol, confidence: score, reason: reasons.join("; "), price: current.price };
  }
  return null;
}

// ─── Position Management ───

function getOpenPositions(): any[] {
  return getDb().prepare("SELECT * FROM crypto_paper_positions WHERE status = 'open' ORDER BY opened_at DESC").all();
}

function getAccount(): { balance: number; initial_balance: number } {
  const d = getDb();
  let acc = d.prepare("SELECT * FROM crypto_paper_account WHERE id = 1").get() as any;
  if (!acc) {
    d.prepare("INSERT INTO crypto_paper_account (id, balance, initial_balance) VALUES (1, 10000.0, 10000.0)").run();
    acc = { id: 1, balance: 10000.0, initial_balance: 10000.0 };
  }
  return acc;
}

type ExitReason = "SL" | "TP" | "TRAILING" | "TIME_STOP" | "RSI_OVERBOUGHT" | null;

function checkExit(pos: any, currentPrice: number, coinId: string): ExitReason {
  const pnlPct = (currentPrice - pos.avg_price) / pos.avg_price;
  const holdMs = Date.now() - (pos.opened_at * 1000);
  const symbol = pos.symbol;

  // Update high watermark
  if (!highWatermarks[symbol] || currentPrice > highWatermarks[symbol]) {
    highWatermarks[symbol] = currentPrice;
  }

  // Hard stop-loss: -3%
  if (pnlPct <= STOP_LOSS_PCT) return "SL";

  // Take-profit: +5%
  if (pnlPct >= TAKE_PROFIT_PCT) return "TP";

  // Trailing stop: triggered after +3%, closes at 2% below peak
  if (pnlPct >= TRAILING_TRIGGER && highWatermarks[symbol]) {
    const dropFromPeak = (currentPrice - highWatermarks[symbol]) / highWatermarks[symbol];
    if (dropFromPeak <= -TRAILING_DROP) return "TRAILING";
  }

  // Time stop: max 6h
  if (holdMs >= MAX_HOLD_MS) return "TIME_STOP";

  // RSI overbought
  const history = priceHistory[coinId];
  if (history && history.length >= 15) {
    const rsi = calcRSI(history.map(h => h.price));
    if (rsi !== null && rsi > 80) return "RSI_OVERBOUGHT";
  }

  return null;
}

// ─── Trade Execution ───

function executeBuy(coinId: string, price: number, reason: string, confidence: number): string {
  const d = getDb();
  const acc = getAccount();
  const symbol = coinId;
  const displaySymbol = SYMBOL_MAP[coinId] || coinId.toUpperCase();

  const maxBudget = acc.initial_balance * MAX_BUDGET_PCT;
  const amount = Math.min(maxBudget, acc.balance * 0.9); // Keep 10% cash buffer
  if (amount < 10) return `Skip ${displaySymbol}: insufficient cash ($${fmt(acc.balance)})`;

  const quantity = amount / price;

  // Record trade
  d.prepare(
    "INSERT INTO crypto_paper_trades (symbol, side, quantity, price, total, reasoning) VALUES (?, 'buy', ?, ?, ?, ?)"
  ).run(symbol, quantity, price, amount, `[AUTO] ${reason}`);

  // Create position
  d.prepare(
    "INSERT INTO crypto_paper_positions (symbol, quantity, avg_price, current_price, status) VALUES (?, ?, ?, ?, 'open')"
  ).run(symbol, quantity, price, price);

  // Deduct cash
  d.prepare("UPDATE crypto_paper_account SET balance = balance - ?, updated_at = unixepoch() WHERE id = 1").run(amount);

  // Set high watermark
  highWatermarks[symbol] = price;

  const msg = `🟢 *CRYPTO AUTO-BUY*\n${displaySymbol} — ${fmt(quantity, 6)} @ $${fmt(price)}\nTotal: $${fmt(amount)}\nConfidence: ${confidence}%\nRaison: ${reason}`;
  log.info(`[crypto_auto] BUY ${displaySymbol} ${fmt(quantity, 6)} @ $${fmt(price)} = $${fmt(amount)}`);
  addSignal({ ts: Date.now(), coinId, symbol: displaySymbol, action: "BUY", confidence, reason, price, executed: true });
  sendAlert(msg).catch(() => {});
  return msg;
}

function executeSell(pos: any, currentPrice: number, exitReason: ExitReason): string {
  const d = getDb();
  const coinId = pos.symbol;
  const displaySymbol = SYMBOL_MAP[coinId] || coinId.toUpperCase();
  const proceeds = pos.quantity * currentPrice;
  const cost = pos.quantity * pos.avg_price;
  const pnl = proceeds - cost;
  const pnlPct = (pnl / cost) * 100;

  // Record trade
  d.prepare(
    "INSERT INTO crypto_paper_trades (symbol, side, quantity, price, total, reasoning) VALUES (?, 'sell', ?, ?, ?, ?)"
  ).run(coinId, pos.quantity, currentPrice, proceeds, `[AUTO-${exitReason}] P&L: ${fmtPnl(pnl)} (${pnlPct >= 0 ? "+" : ""}${fmt(pnlPct)}%)`);

  // Close position
  d.prepare(
    "UPDATE crypto_paper_positions SET status = 'closed', current_price = ?, pnl = ?, pnl_percent = ?, updated_at = unixepoch() WHERE id = ?"
  ).run(currentPrice, pnl, pnlPct, pos.id);

  // Add cash
  d.prepare("UPDATE crypto_paper_account SET balance = balance + ?, updated_at = unixepoch() WHERE id = 1").run(proceeds);

  // Track daily P&L and consecutive losses
  dailyPnl += pnl;
  if (pnl < 0) {
    consecutiveLosses++;
  } else {
    consecutiveLosses = 0;
  }

  // Clean up watermark
  delete highWatermarks[coinId];

  const emoji = exitReason === "TP" || exitReason === "TRAILING" ? "💰" : exitReason === "SL" ? "🚨" : "🔴";
  const msg = `${emoji} *CRYPTO AUTO-SELL (${exitReason})*\n${displaySymbol} — ${fmt(pos.quantity, 6)} @ $${fmt(currentPrice)}\nP&L: ${fmtPnl(pnl)} (${pnlPct >= 0 ? "+" : ""}${fmt(pnlPct)}%)\nDaily P&L: ${fmtPnl(dailyPnl)}`;
  log.info(`[crypto_auto] SELL ${displaySymbol} ${exitReason} P&L: ${fmtPnl(pnl)}`);
  addSignal({ ts: Date.now(), coinId, symbol: displaySymbol, action: exitReason as any || "SELL", confidence: 100, reason: `${exitReason}: ${fmtPnl(pnl)}`, price: currentPrice, executed: true });
  sendAlert(msg).catch(() => {});
  return msg;
}

// ─── Main Tick ───

async function runTick(): Promise<string> {
  const lines: string[] = [];
  const { dateStr } = nowET();

  // Reset daily counters
  if (dailyDate !== dateStr) {
    dailyDate = dateStr;
    dailyPnl = 0;
    consecutiveLosses = 0;
  }

  // Circuit breaker checks
  if (!enabled) return "[crypto_auto] DISABLED — use crypto_auto.toggle to re-enable.";

  const acc = getAccount();
  const dailyLossPct = dailyPnl / acc.initial_balance;
  if (dailyLossPct <= MAX_DAILY_LOSS_PCT) {
    return `[crypto_auto] CIRCUIT BREAKER: daily loss ${fmt(dailyLossPct * 100)}% exceeds -5% limit. Paused until tomorrow.`;
  }
  if (consecutiveLosses >= CIRCUIT_BREAKER_LOSSES) {
    return `[crypto_auto] CIRCUIT BREAKER: ${consecutiveLosses} consecutive losses. Paused until next win or reset.`;
  }

  // Fetch prices
  let prices: Record<string, PricePoint>;
  try {
    prices = await fetchPrices();
    recordPrices(prices);
  } catch (e) {
    return `[crypto_auto] Price fetch error: ${e instanceof Error ? e.message : String(e)}`;
  }

  // 1. Check existing positions for exits
  const openPositions = getOpenPositions();
  for (const pos of openPositions) {
    const coinId = pos.symbol;
    const currentPrice = prices[coinId]?.price;
    if (!currentPrice) continue;

    // Update current price in DB
    getDb().prepare("UPDATE crypto_paper_positions SET current_price = ?, updated_at = unixepoch() WHERE id = ?")
      .run(currentPrice, pos.id);

    const exit = checkExit(pos, currentPrice, coinId);
    if (exit) {
      const result = executeSell(pos, currentPrice, exit);
      lines.push(result);
    }
  }

  // 2. Look for new entries (if slots available)
  const currentPositions = getOpenPositions();
  if (currentPositions.length < MAX_POSITIONS) {
    const heldCoins = new Set(currentPositions.map((p: any) => p.symbol));

    for (const coinId of COINS) {
      if (heldCoins.has(coinId)) continue; // Already holding
      if (currentPositions.length + lines.filter(l => l.includes("AUTO-BUY")).length >= MAX_POSITIONS) break;

      const signal = evaluateBuySignal(coinId);
      if (signal) {
        const result = executeBuy(coinId, signal.price, signal.reason, signal.confidence);
        lines.push(result);
      }
    }
  }

  if (lines.length === 0) {
    // No trades — just log status
    const posCount = currentPositions.length;
    const histLen = priceHistory[COINS[0]]?.length || 0;
    return `[crypto_auto] Tick OK — ${posCount}/${MAX_POSITIONS} positions, ${histLen}/${MAX_HISTORY} price points, daily P&L: ${fmtPnl(dailyPnl)}`;
  }

  return lines.join("\n\n");
}

// ─── Skills ───

registerSkill({
  name: "crypto_auto.tick",
  description: "Run one autonomous crypto trading cycle. Fetches prices, evaluates strategy, executes trades. Called by cron every 5 minutes.",
  adminOnly: true,
  argsSchema: { type: "object", properties: {} },
  async execute(): Promise<string> {
    try {
      lastTickTs = Date.now();
      return await runTick();
    } catch (e) {
      const msg = `[crypto_auto] Tick error: ${e instanceof Error ? e.message : String(e)}`;
      log.error(msg);
      return msg;
    }
  },
});

registerSkill({
  name: "crypto_auto.status",
  description: "Show autonomous crypto trading status: enabled, positions, daily P&L, indicators, circuit breaker state.",
  adminOnly: true,
  argsSchema: { type: "object", properties: {} },
  async execute(): Promise<string> {
    const acc = getAccount();
    const positions = getOpenPositions();
    const { dateStr } = nowET();

    const lines = [
      `📊 *Crypto Auto-Trading Status*`,
      `Enabled: ${enabled ? "✅" : "❌"}`,
      `Cash: $${fmt(acc.balance)} / Initial: $${fmt(acc.initial_balance)}`,
      `Daily P&L: ${fmtPnl(dailyPnl)} (${dateStr})`,
      `Consecutive losses: ${consecutiveLosses}/${CIRCUIT_BREAKER_LOSSES}`,
      `Positions: ${positions.length}/${MAX_POSITIONS}`,
      `Last tick: ${lastTickTs ? new Date(lastTickTs).toISOString() : "never"}`,
    ];

    // Position details
    for (const pos of positions) {
      const sym = SYMBOL_MAP[pos.symbol] || pos.symbol.toUpperCase();
      const pnl = pos.current_price ? (pos.current_price - pos.avg_price) * pos.quantity : 0;
      const pnlPct = pos.avg_price ? ((pos.current_price / pos.avg_price) - 1) * 100 : 0;
      lines.push(`  ${sym}: ${fmt(pos.quantity, 6)} @ $${fmt(pos.avg_price)} → $${fmt(pos.current_price || 0)} (${fmtPnl(pnl)} / ${pnlPct >= 0 ? "+" : ""}${fmt(pnlPct)}%)`);
    }

    // Indicator status
    lines.push(`\n📈 *Indicators* (${priceHistory[COINS[0]]?.length || 0} data points):`);
    for (const coinId of COINS) {
      const h = priceHistory[coinId];
      if (!h || h.length < 2) { lines.push(`  ${SYMBOL_MAP[coinId]}: collecting data...`); continue; }
      const prices = h.map(p => p.price);
      const ma20 = calcSMA(prices, 20);
      const rsi = calcRSI(prices);
      const current = h[h.length - 1];
      lines.push(`  ${SYMBOL_MAP[coinId]}: $${fmt(current.price)} | MA20: ${ma20 ? `$${fmt(ma20)}` : "N/A"} | RSI: ${rsi ? fmt(rsi, 0) : "N/A"} | Vol: ${fmt(current.vol24h / 1e6, 0)}M | 24h: ${current.change24h >= 0 ? "+" : ""}${fmt(current.change24h, 1)}%`);
    }

    return lines.join("\n");
  },
});

registerSkill({
  name: "crypto_auto.toggle",
  description: "Enable or disable the autonomous crypto trading system.",
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
      consecutiveLosses = 0; // Reset circuit breaker
      return "✅ Crypto auto-trading ENABLED. Circuit breaker reset.";
    } else {
      enabled = false;
      return "❌ Crypto auto-trading DISABLED.";
    }
  },
});

registerSkill({
  name: "crypto_auto.signals",
  description: "Show recent trading signals detected by the autonomous crypto system.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      limit: { type: "number", description: "Number of signals to show (default 10)" },
    },
  },
  async execute(args): Promise<string> {
    const limit = Number(args.limit) || 10;
    if (recentSignals.length === 0) return "No signals recorded yet. Wait for a few ticks.";

    const lines = [`📡 *Last ${Math.min(limit, recentSignals.length)} Crypto Signals:*`];
    for (const s of recentSignals.slice(0, limit)) {
      const time = new Date(s.ts).toLocaleTimeString("en-US", { timeZone: "America/Toronto", hour12: false });
      const exec = s.executed ? "✅" : "⏭️";
      lines.push(`${exec} [${time}] ${s.symbol} ${s.action} @ $${fmt(s.price)} (${s.confidence}%) — ${s.reason}`);
    }
    return lines.join("\n");
  },
});

log.info(`[crypto_auto] Autonomous crypto trading engine loaded (${COINS.length} coins, SL ${STOP_LOSS_PCT * 100}%, TP ${TAKE_PROFIT_PCT * 100}%)`);
