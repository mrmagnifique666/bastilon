/**
 * Binance API Integration — Real crypto trading via Binance.
 * Supports: spot prices, account balance, market buy/sell, order history, klines.
 * Uses HMAC-SHA256 signed requests for authenticated endpoints.
 */
import { registerSkill } from "../loader.js";
import { log } from "../../utils/log.js";
import crypto from "node:crypto";

// ── Config ──

const BINANCE_API_KEY = process.env.BINANCE_API_KEY || "";
const BINANCE_SECRET = process.env.BINANCE_SECRET_KEY || "";
const BASE_URL = process.env.BINANCE_TESTNET === "true"
  ? "https://testnet.binance.vision/api"
  : "https://api.binance.com/api";

function isConfigured(): boolean {
  return !!BINANCE_API_KEY && !!BINANCE_SECRET;
}

// ── Helpers ──

function sign(queryString: string): string {
  return crypto.createHmac("sha256", BINANCE_SECRET).update(queryString).digest("hex");
}

async function publicGet(path: string, params: Record<string, string> = {}): Promise<any> {
  const qs = new URLSearchParams(params).toString();
  const url = `${BASE_URL}${path}${qs ? "?" + qs : ""}`;
  const resp = await fetch(url, { headers: { "X-MBX-APIKEY": BINANCE_API_KEY } });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Binance ${resp.status}: ${body}`);
  }
  return resp.json();
}

async function signedGet(path: string, params: Record<string, string> = {}): Promise<any> {
  if (!isConfigured()) throw new Error("Binance API not configured. Set BINANCE_API_KEY and BINANCE_SECRET_KEY in .env");
  params.timestamp = Date.now().toString();
  params.recvWindow = "10000";
  const qs = new URLSearchParams(params).toString();
  const signature = sign(qs);
  const url = `${BASE_URL}${path}?${qs}&signature=${signature}`;
  const resp = await fetch(url, { headers: { "X-MBX-APIKEY": BINANCE_API_KEY } });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Binance ${resp.status}: ${body}`);
  }
  return resp.json();
}

async function signedPost(path: string, params: Record<string, string> = {}): Promise<any> {
  if (!isConfigured()) throw new Error("Binance API not configured. Set BINANCE_API_KEY and BINANCE_SECRET_KEY in .env");
  params.timestamp = Date.now().toString();
  params.recvWindow = "10000";
  const qs = new URLSearchParams(params).toString();
  const signature = sign(qs);
  const url = `${BASE_URL}${path}?${qs}&signature=${signature}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "X-MBX-APIKEY": BINANCE_API_KEY },
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Binance ${resp.status}: ${body}`);
  }
  return resp.json();
}

function fmt(n: number, decimals = 2): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

// Common symbol mappings (CoinGecko ID → Binance symbol)
const SYMBOL_MAP: Record<string, string> = {
  bitcoin: "BTCUSDT", btc: "BTCUSDT",
  ethereum: "ETHUSDT", eth: "ETHUSDT",
  solana: "SOLUSDT", sol: "SOLUSDT",
  dogecoin: "DOGEUSDT", doge: "DOGEUSDT",
  cardano: "ADAUSDT", ada: "ADAUSDT",
  ripple: "XRPUSDT", xrp: "XRPUSDT",
  polkadot: "DOTUSDT", dot: "DOTUSDT",
  avalanche: "AVAXUSDT", avax: "AVAXUSDT",
  chainlink: "LINKUSDT", link: "LINKUSDT",
  polygon: "MATICUSDT", matic: "MATICUSDT",
  litecoin: "LTCUSDT", ltc: "LTCUSDT",
  bnb: "BNBUSDT", binancecoin: "BNBUSDT",
  shiba: "SHIBUSDT", "shiba-inu": "SHIBUSDT",
  tron: "TRXUSDT", trx: "TRXUSDT",
  sui: "SUIUSDT",
  pepe: "PEPEUSDT",
};

function resolveSymbol(input: string): string {
  const lower = input.toLowerCase().trim();
  if (SYMBOL_MAP[lower]) return SYMBOL_MAP[lower];
  // If already ends with USDT, use as-is
  if (lower.endsWith("usdt")) return lower.toUpperCase();
  // Default: append USDT
  return lower.toUpperCase() + "USDT";
}

// ── Skills ──

registerSkill({
  name: "binance.price",
  description: "Get real-time crypto price from Binance (more accurate than CoinGecko). Accepts coin name or symbol.",
  argsSchema: {
    type: "object",
    properties: {
      symbol: { type: "string", description: "Coin name or symbol (e.g. 'bitcoin', 'ETH', 'SOLUSDT')" },
    },
    required: ["symbol"],
  },
  async execute(args): Promise<string> {
    const symbols = String(args.symbol).split(",").map(s => s.trim());
    const lines: string[] = [];

    for (const sym of symbols) {
      const pair = resolveSymbol(sym);
      try {
        const ticker = await publicGet("/v3/ticker/24hr", { symbol: pair });
        const price = parseFloat(ticker.lastPrice);
        const change = parseFloat(ticker.priceChangePercent);
        const volume = parseFloat(ticker.quoteVolume);
        const high = parseFloat(ticker.highPrice);
        const low = parseFloat(ticker.lowPrice);
        const arrow = change >= 0 ? "+" : "";
        lines.push(
          `${pair}: $${fmt(price, price < 1 ? 6 : 2)} (${arrow}${fmt(change)}%) | H: $${fmt(high, 2)} L: $${fmt(low, 2)} | Vol: $${fmt(volume / 1e6, 1)}M`
        );
      } catch (e: any) {
        lines.push(`${pair}: Error — ${e.message}`);
      }
    }
    return lines.join("\n") || "No data.";
  },
});

registerSkill({
  name: "binance.balance",
  description: "Get Binance account balance (all non-zero assets).",
  argsSchema: { type: "object", properties: {} },
  async execute(): Promise<string> {
    const data = await signedGet("/v3/account");
    const nonZero = data.balances
      .filter((b: any) => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0)
      .map((b: any) => {
        const free = parseFloat(b.free);
        const locked = parseFloat(b.locked);
        return `  ${b.asset}: ${fmt(free, 6)} free${locked > 0 ? ` + ${fmt(locked, 6)} locked` : ""}`;
      });

    if (nonZero.length === 0) return "💰 Binance Account: Empty (no balances)";
    return `💰 Binance Account:\n${nonZero.join("\n")}`;
  },
});

registerSkill({
  name: "binance.buy",
  description: "Place a market BUY order on Binance. REAL MONEY — use with caution!",
  argsSchema: {
    type: "object",
    properties: {
      symbol: { type: "string", description: "Coin to buy (e.g. 'bitcoin', 'ETH', 'SOLUSDT')" },
      amount: { type: "number", description: "USD amount to spend (uses quoteOrderQty)" },
      reasoning: { type: "string", description: "Why are you buying? (logged)" },
    },
    required: ["symbol", "amount", "reasoning"],
  },
  async execute(args): Promise<string> {
    const pair = resolveSymbol(String(args.symbol));
    const amount = Number(args.amount);
    const reasoning = String(args.reasoning || "");

    if (amount <= 0) return "❌ Amount must be positive.";
    if (amount > 500) return "❌ Safety limit: max $500 per trade. Increase manually if needed.";
    if (!reasoning) return "❌ Reasoning required for every trade.";

    log.info(`[binance] BUY ${pair} $${amount} — ${reasoning}`);

    const result = await signedPost("/v3/order", {
      symbol: pair,
      side: "BUY",
      type: "MARKET",
      quoteOrderQty: amount.toFixed(2),
    });

    const qty = parseFloat(result.executedQty);
    const total = parseFloat(result.cummulativeQuoteQty);
    const avgPrice = total / qty;

    return `🟢 ACHAT ${pair}\nQuantité: ${fmt(qty, 8)}\nPrix moyen: $${fmt(avgPrice)}\nTotal: $${fmt(total)}\nOrder ID: ${result.orderId}\nRaison: ${reasoning}`;
  },
});

registerSkill({
  name: "binance.sell",
  description: "Place a market SELL order on Binance. REAL MONEY — use with caution!",
  argsSchema: {
    type: "object",
    properties: {
      symbol: { type: "string", description: "Coin to sell (e.g. 'bitcoin', 'ETH')" },
      quantity: { type: "string", description: "Amount to sell (number or 'all')" },
      reasoning: { type: "string", description: "Why are you selling? (logged)" },
    },
    required: ["symbol", "reasoning"],
  },
  async execute(args): Promise<string> {
    const pair = resolveSymbol(String(args.symbol));
    const reasoning = String(args.reasoning || "");
    if (!reasoning) return "❌ Reasoning required for every trade.";

    let quantity: string;
    if (!args.quantity || String(args.quantity).toLowerCase() === "all") {
      // Get full balance for this asset
      const asset = pair.replace("USDT", "");
      const account = await signedGet("/v3/account");
      const bal = account.balances.find((b: any) => b.asset === asset);
      if (!bal || parseFloat(bal.free) <= 0) return `❌ No ${asset} balance to sell.`;
      quantity = bal.free;
    } else {
      quantity = String(args.quantity);
    }

    log.info(`[binance] SELL ${quantity} ${pair} — ${reasoning}`);

    const result = await signedPost("/v3/order", {
      symbol: pair,
      side: "SELL",
      type: "MARKET",
      quantity,
    });

    const qty = parseFloat(result.executedQty);
    const total = parseFloat(result.cummulativeQuoteQty);
    const avgPrice = total / qty;

    return `🔴 VENTE ${pair}\nQuantité: ${fmt(qty, 8)}\nPrix moyen: $${fmt(avgPrice)}\nTotal: $${fmt(total)}\nOrder ID: ${result.orderId}\nRaison: ${reasoning}`;
  },
});

registerSkill({
  name: "binance.orders",
  description: "Get recent order history from Binance for a symbol.",
  argsSchema: {
    type: "object",
    properties: {
      symbol: { type: "string", description: "Coin (e.g. 'bitcoin', 'BTCUSDT')" },
      limit: { type: "number", description: "Number of orders (default 10)" },
    },
    required: ["symbol"],
  },
  async execute(args): Promise<string> {
    const pair = resolveSymbol(String(args.symbol));
    const limit = Math.min(Number(args.limit) || 10, 50);

    const orders = await signedGet("/v3/allOrders", { symbol: pair, limit: limit.toString() });

    if (!orders || orders.length === 0) return `Aucun ordre pour ${pair}.`;

    const lines = orders.slice(-limit).reverse().map((o: any) => {
      const qty = parseFloat(o.executedQty);
      const total = parseFloat(o.cummulativeQuoteQty);
      const price = qty > 0 ? total / qty : 0;
      const time = new Date(o.time).toLocaleString("fr-CA");
      const emoji = o.side === "BUY" ? "🟢" : "🔴";
      return `${emoji} ${o.side} ${fmt(qty, 6)} @ $${fmt(price)} = $${fmt(total)} [${o.status}] ${time}`;
    });

    return `📋 Ordres ${pair}:\n${lines.join("\n")}`;
  },
});

registerSkill({
  name: "binance.klines",
  description: "Get candlestick/OHLCV data from Binance for technical analysis.",
  argsSchema: {
    type: "object",
    properties: {
      symbol: { type: "string", description: "Coin (e.g. 'bitcoin', 'ETHUSDT')" },
      interval: { type: "string", description: "Timeframe: 1m, 5m, 15m, 1h, 4h, 1d (default: 1h)" },
      limit: { type: "number", description: "Number of candles (default 24, max 100)" },
    },
    required: ["symbol"],
  },
  async execute(args): Promise<string> {
    const pair = resolveSymbol(String(args.symbol));
    const interval = String(args.interval || "1h");
    const limit = Math.min(Number(args.limit) || 24, 100);

    const klines = await publicGet("/v3/klines", {
      symbol: pair,
      interval,
      limit: limit.toString(),
    });

    if (!Array.isArray(klines) || klines.length === 0) return `No kline data for ${pair}.`;

    // Calculate simple metrics
    const closes = klines.map((k: any) => parseFloat(k[4]));
    const lastClose = closes[closes.length - 1];
    const firstClose = closes[0];
    const trend = ((lastClose / firstClose) - 1) * 100;
    const high = Math.max(...klines.map((k: any) => parseFloat(k[2])));
    const low = Math.min(...klines.map((k: any) => parseFloat(k[3])));
    const avgVol = klines.reduce((s: number, k: any) => s + parseFloat(k[5]), 0) / klines.length;

    // Last 5 candles detail
    const recent = klines.slice(-5).map((k: any) => {
      const o = parseFloat(k[1]), h = parseFloat(k[2]), l = parseFloat(k[3]), c = parseFloat(k[4]);
      const vol = parseFloat(k[5]);
      const dir = c >= o ? "🟢" : "🔴";
      const time = new Date(k[0]).toLocaleString("fr-CA", { hour: "2-digit", minute: "2-digit" });
      return `${dir} ${time}: O:$${fmt(o)} H:$${fmt(h)} L:$${fmt(l)} C:$${fmt(c)} Vol:${fmt(vol, 2)}`;
    });

    return [
      `📊 ${pair} — ${interval} (${limit} candles)`,
      `Trend: ${trend >= 0 ? "+" : ""}${fmt(trend)}%`,
      `Range: $${fmt(low)} — $${fmt(high)}`,
      `Current: $${fmt(lastClose)}`,
      `Avg Volume: ${fmt(avgVol, 2)}`,
      `\nDernières bougies:`,
      ...recent,
    ].join("\n");
  },
});

registerSkill({
  name: "binance.top",
  description: "Get top moving crypto on Binance (biggest gainers/losers in 24h).",
  argsSchema: {
    type: "object",
    properties: {
      direction: { type: "string", description: "'gainers' or 'losers' (default: gainers)" },
      limit: { type: "number", description: "How many to show (default 10)" },
    },
  },
  async execute(args): Promise<string> {
    const direction = String(args.direction || "gainers").toLowerCase();
    const limit = Math.min(Number(args.limit) || 10, 25);

    const tickers = await publicGet("/v3/ticker/24hr");
    // Filter USDT pairs only, exclude low-volume
    const usdt = tickers
      .filter((t: any) => t.symbol.endsWith("USDT") && parseFloat(t.quoteVolume) > 100000)
      .map((t: any) => ({
        symbol: t.symbol,
        price: parseFloat(t.lastPrice),
        change: parseFloat(t.priceChangePercent),
        volume: parseFloat(t.quoteVolume),
      }));

    const sorted = direction === "losers"
      ? usdt.sort((a: any, b: any) => a.change - b.change)
      : usdt.sort((a: any, b: any) => b.change - a.change);

    const top = sorted.slice(0, limit);
    const emoji = direction === "losers" ? "📉" : "📈";
    const title = direction === "losers" ? "Top Losers 24h" : "Top Gainers 24h";

    const lines = top.map((t: any, i: number) => {
      const arrow = t.change >= 0 ? "+" : "";
      return `${i + 1}. ${t.symbol}: $${fmt(t.price, t.price < 1 ? 6 : 2)} (${arrow}${fmt(t.change)}%) Vol: $${fmt(t.volume / 1e6, 1)}M`;
    });

    return `${emoji} ${title}:\n${lines.join("\n")}`;
  },
});
