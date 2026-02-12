/**
 * Built-in skills: trading.scan, trading.picks, trading.buy, trading.sell,
 * trading.positions, trading.pnl, trading.account, trading.close
 *
 * Paper trading engine using Alpaca Markets API.
 * Focus: US small-cap day trading with $2,000 virtual budget.
 */
import { registerSkill } from "../loader.js";
import { log } from "../../utils/log.js";

// ── Config ──

const PAPER_URL = "https://paper-api.alpaca.markets";
const DATA_URL = "https://data.alpaca.markets";

function getHeaders(): Record<string, string> {
  const key = process.env.ALPACA_API_KEY || "";
  const secret = process.env.ALPACA_SECRET_KEY || "";
  if (!key || !secret) throw new Error("ALPACA_API_KEY and ALPACA_SECRET_KEY must be set in .env");
  return {
    "APCA-API-KEY-ID": key,
    "APCA-API-SECRET-KEY": secret,
    "Content-Type": "application/json",
  };
}

// ── Alpaca helpers ──

async function alpacaGet(path: string, base = PAPER_URL): Promise<any> {
  const resp = await fetch(`${base}${path}`, { headers: getHeaders() });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Alpaca ${resp.status}: ${text}`);
  }
  return resp.json();
}

async function alpacaPost(path: string, body: any): Promise<any> {
  const resp = await fetch(`${PAPER_URL}${path}`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Alpaca ${resp.status}: ${text}`);
  }
  return resp.json();
}

async function alpacaDelete(path: string): Promise<any> {
  const resp = await fetch(`${PAPER_URL}${path}`, {
    method: "DELETE",
    headers: getHeaders(),
  });
  if (resp.status === 204) return { status: "ok" };
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Alpaca ${resp.status}: ${text}`);
  }
  return resp.json();
}

// Yahoo Finance helper (reused from market.ts pattern)
const YF = "https://query1.finance.yahoo.com/v8/finance/chart";
const UA = { "User-Agent": "Mozilla/5.0" };

interface QuoteData {
  symbol: string;
  price: number;
  prevClose: number;
  changePct: number;
  volume: number;
  avgVolume?: number;
  ma20?: number;
  ma50?: number;
  rsi14?: number;
  high: number;
  low: number;
}

async function yfQuote(symbol: string): Promise<QuoteData | null> {
  try {
    const resp = await fetch(`${YF}/${symbol}?interval=1d&range=6mo`, { headers: UA });
    if (!resp.ok) return null;
    const data = await resp.json();
    const result = data?.chart?.result?.[0];
    const meta = result?.meta;
    if (!meta) return null;

    const closes: number[] = (result?.indicators?.quote?.[0]?.close || []).filter((c: any) => c != null);
    const price = meta.regularMarketPrice;
    const prevClose = meta.chartPreviousClose || meta.previousClose || price;

    // Calculate indicators
    let ma20: number | undefined;
    let ma50: number | undefined;
    let rsi14: number | undefined;

    if (closes.length >= 20) {
      ma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    }
    if (closes.length >= 50) {
      ma50 = closes.slice(-50).reduce((a, b) => a + b, 0) / 50;
    }
    if (closes.length >= 15) {
      const changes: number[] = [];
      for (let i = closes.length - 15; i < closes.length - 1; i++) {
        changes.push(closes[i + 1] - closes[i]);
      }
      let gains = 0, losses = 0;
      for (const c of changes) {
        if (c > 0) gains += c; else losses -= c;
      }
      const avgGain = gains / 14;
      const avgLoss = losses / 14;
      rsi14 = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }

    // Average volume
    let avgVolume: number | undefined;
    try {
      const r2 = await fetch(
        `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${symbol}?modules=summaryDetail`,
        { headers: UA }
      );
      if (r2.ok) {
        const d2 = await r2.json();
        avgVolume = d2?.quoteSummary?.result?.[0]?.summaryDetail?.averageDailyVolume10Day?.raw;
      }
    } catch { /* */ }

    return {
      symbol: symbol.toUpperCase(), price, prevClose,
      changePct: ((price - prevClose) / prevClose) * 100,
      volume: meta.regularMarketVolume || 0,
      avgVolume, ma20, ma50, rsi14,
      high: meta.regularMarketDayHigh || price,
      low: meta.regularMarketDayLow || price,
    };
  } catch { return null; }
}

function fmt(n: number | undefined, dec = 2): string {
  return n == null ? "N/A" : n.toFixed(dec);
}

// ── trading.account ──

registerSkill({
  name: "trading.account",
  description: "Get Alpaca paper trading account info (balance, buying power, equity).",
  adminOnly: true,
  argsSchema: { type: "object", properties: {} },
  async execute(): Promise<string> {
    try {
      const acct = await alpacaGet("/v2/account");
      return [
        "**Alpaca Paper Trading Account**",
        `Status: ${acct.status}`,
        `Equity: $${Number(acct.equity).toFixed(2)}`,
        `Cash: $${Number(acct.cash).toFixed(2)}`,
        `Buying Power: $${Number(acct.buying_power).toFixed(2)}`,
        `Portfolio Value: $${Number(acct.portfolio_value).toFixed(2)}`,
        `P&L Today: $${Number(acct.equity - acct.last_equity).toFixed(2)}`,
        `Pattern Day Trader: ${acct.pattern_day_trader ? "Yes" : "No"}`,
        `Day Trade Count: ${acct.daytrade_count}/3`,
      ].join("\n");
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

// ── trading.scan ──

registerSkill({
  name: "trading.scan",
  description: "Scan for day trading opportunities: top movers, volume spikes, RSI extremes. Focus on small caps.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      focus: { type: "string", description: "Focus: 'smallcap' (default), 'tech', 'all'" },
    },
  },
  async execute(args): Promise<string> {
    const focus = (args.focus as string) || "smallcap";

    // Smallcap + momentum universe
    const universes: Record<string, string[]> = {
      smallcap: [
        "IONQ", "RGTI", "QUBT", "SOUN", "BBAI", "JOBY", "LUNR", "RKLB", "ACHR",
        "MARA", "RIOT", "HOOD", "AFRM", "UPST", "SOFI", "LCID", "RIVN", "NIO",
        "DKNG", "RBLX", "SNAP", "DNA", "ASTS", "KULR", "BTBT", "HUT", "CIFR",
        "HIMS", "CLOV", "WISH", "OPEN", "STEM", "QS", "MVST", "GOEV",
      ],
      tech: [
        "NVDA", "TSLA", "AMD", "PLTR", "SMCI", "ARM", "AVGO", "MU", "INTC", "QCOM",
        "CRWD", "NET", "SNOW", "DDOG", "ZS", "PANW", "CRM", "ORCL", "NOW",
        "COIN", "SQ", "PYPL", "SHOP", "RBLX",
      ],
      all: [
        "IONQ", "RGTI", "QUBT", "SOUN", "BBAI", "JOBY", "LUNR", "RKLB", "ACHR",
        "MARA", "RIOT", "HOOD", "AFRM", "UPST", "SOFI", "LCID", "RIVN", "NIO",
        "NVDA", "TSLA", "AMD", "PLTR", "SMCI", "ARM", "COIN", "SQ", "PYPL",
        "CRWD", "NET", "DKNG", "SNAP", "HIMS", "ASTS", "KULR", "DNA",
        "BA", "XOM", "JPM", "LLY", "NFLX",
      ],
    };

    const tickers = universes[focus] || universes.smallcap;
    const quotes = await Promise.all(tickers.map(yfQuote));
    const valid = quotes.filter((q): q is QuoteData => q !== null);

    // Score each stock for day trading potential
    const scored = valid.map((q) => {
      let score = 0;
      // Momentum: big movers get points
      score += Math.min(Math.abs(q.changePct) * 2, 10);
      // Volume spike
      if (q.avgVolume && q.avgVolume > 0) {
        const rvol = q.volume / q.avgVolume;
        if (rvol > 2) score += 5;
        else if (rvol > 1.5) score += 3;
        else if (rvol > 1) score += 1;
      }
      // RSI extremes
      if (q.rsi14 !== undefined) {
        if (q.rsi14 < 30) score += 4; // oversold bounce
        else if (q.rsi14 > 70) score += 3; // momentum continuation
      }
      // Price range (intraday volatility)
      const range = ((q.high - q.low) / q.price) * 100;
      if (range > 5) score += 3;
      else if (range > 3) score += 2;

      return { ...q, score, range };
    });

    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, 15);

    const lines = [`**Day Trading Scanner (${focus.toUpperCase()})**\n`];
    for (const q of top) {
      const dir = q.changePct >= 0 ? "+" : "";
      const vol = q.volume > 1e6 ? `${(q.volume / 1e6).toFixed(1)}M` : `${(q.volume / 1e3).toFixed(0)}K`;
      const rvol = q.avgVolume ? `RVOL:${((q.volume / q.avgVolume) * 100).toFixed(0)}%` : "";
      const rsi = q.rsi14 ? `RSI:${q.rsi14.toFixed(0)}` : "";
      const signal =
        q.rsi14 && q.rsi14 < 30 ? "OVERSOLD" :
        q.rsi14 && q.rsi14 > 70 ? "OVERBOUGHT" :
        q.changePct > 5 ? "BREAKOUT" :
        q.changePct < -5 ? "BREAKDOWN" : "";

      lines.push(
        `${q.score >= 8 ? "🔥" : q.score >= 5 ? "⚡" : "📊"} **${q.symbol}** $${fmt(q.price)} (${dir}${fmt(q.changePct)}%)` +
        `\n   Vol:${vol} ${rvol} ${rsi} Range:${fmt(q.range as any)}% ${signal}`
      );
    }

    return lines.join("\n");
  },
});

// ── trading.picks ──

registerSkill({
  name: "trading.picks",
  description: "Generate 5 daily stock picks with entry, target, stop-loss. Uses scan data + technical analysis.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      budget: { type: "number", description: "Total budget in $ (default: 2000)" },
    },
  },
  async execute(args): Promise<string> {
    const budget = Number(args.budget) || 2000;
    const perPick = budget / 5;

    // Scan small caps
    const tickers = [
      "IONQ", "RGTI", "QUBT", "SOUN", "BBAI", "JOBY", "LUNR", "RKLB", "ACHR",
      "MARA", "RIOT", "HOOD", "AFRM", "UPST", "SOFI", "LCID", "RIVN", "NIO",
      "DKNG", "RBLX", "SNAP", "DNA", "ASTS", "KULR", "HIMS", "COIN",
      "PLTR", "AMD", "SMCI", "ARM",
    ];

    const quotes = await Promise.all(tickers.map(yfQuote));
    const valid = quotes.filter((q): q is QuoteData => q !== null);

    // Score and rank
    const scored = valid.map((q) => {
      let score = 0;
      const dir = q.changePct >= 0 ? "LONG" : "SHORT";

      // Momentum score
      if (Math.abs(q.changePct) > 3) score += 3;
      if (Math.abs(q.changePct) > 5) score += 2;

      // Volume confirmation
      if (q.avgVolume && q.volume > q.avgVolume * 1.5) score += 3;

      // RSI signal
      if (q.rsi14 !== undefined) {
        if (q.rsi14 < 30) { score += 4; } // oversold = long
        else if (q.rsi14 > 70 && q.changePct > 0) { score += 3; } // momentum
        else if (q.rsi14 > 70 && q.changePct < 0) { score += 2; } // reversal short
      }

      // MA position
      if (q.ma20 && q.price > q.ma20) score += 1;
      if (q.ma50 && q.price > q.ma50) score += 1;

      // Entry/target/stop calculation
      const entry = q.price;
      const stopPct = 0.05; // 5% stop loss
      const tp1Pct = 0.08; // 8% target 1
      const tp2Pct = 0.15; // 15% target 2

      const stop = dir === "LONG" ? entry * (1 - stopPct) : entry * (1 + stopPct);
      const tp1 = dir === "LONG" ? entry * (1 + tp1Pct) : entry * (1 - tp1Pct);
      const tp2 = dir === "LONG" ? entry * (1 + tp2Pct) : entry * (1 - tp2Pct);
      const shares = Math.floor(perPick / entry);
      const conviction = Math.min(Math.round(score / 3), 5);

      return { ...q, score, dir, entry, stop, tp1, tp2, shares, conviction };
    });

    scored.sort((a, b) => b.score - a.score);
    const picks = scored.slice(0, 5);

    const lines = [
      `**KINGSTON DAILY PICKS** (Budget: $${budget})\n`,
      `Per pick: ~$${perPick.toFixed(0)}\n`,
    ];

    for (let i = 0; i < picks.length; i++) {
      const p = picks[i];
      const rsi = p.rsi14 ? `RSI:${p.rsi14.toFixed(0)}` : "";
      const rvol = p.avgVolume ? `RVOL:${((p.volume / p.avgVolume) * 100).toFixed(0)}%` : "";
      const stars = "★".repeat(p.conviction) + "☆".repeat(5 - p.conviction);

      lines.push(
        `**#${i + 1} ${p.dir} ${p.symbol}** ${stars}`,
        `   Price: $${fmt(p.price)} (${p.changePct >= 0 ? "+" : ""}${fmt(p.changePct)}%)`,
        `   Entry: $${fmt(p.entry)} | Stop: $${fmt(p.stop)} | TP1: $${fmt(p.tp1)} | TP2: $${fmt(p.tp2)}`,
        `   Shares: ${p.shares} ($${(p.shares * p.price).toFixed(0)})`,
        `   ${rsi} ${rvol}`,
        "",
      );
    }

    lines.push(`\n⚠️ Paper trading only. Not financial advice.`);
    return lines.join("\n");
  },
});

// ── trading.buy ──

registerSkill({
  name: "trading.buy",
  description: "Place a paper trading BUY order on Alpaca (market or limit).",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      symbol: { type: "string", description: "Stock ticker (e.g. IONQ)" },
      qty: { type: "number", description: "Number of shares" },
      type: { type: "string", description: "Order type: market (default) or limit" },
      limit_price: { type: "number", description: "Limit price (required if type=limit)" },
    },
    required: ["symbol", "qty"],
  },
  async execute(args): Promise<string> {
    const symbol = (args.symbol as string).toUpperCase();
    const qty = String(Number(args.qty));
    const orderType = (args.type as string) || "market";
    const limitPrice = args.limit_price ? String(Number(args.limit_price)) : undefined;

    try {
      const body: any = {
        symbol,
        qty,
        side: "buy",
        type: orderType,
        time_in_force: "day",
      };
      if (orderType === "limit" && limitPrice) {
        body.limit_price = limitPrice;
      }

      const order = await alpacaPost("/v2/orders", body);
      return [
        `**BUY Order Placed**`,
        `Symbol: ${order.symbol}`,
        `Qty: ${order.qty}`,
        `Type: ${order.type}`,
        `Status: ${order.status}`,
        `Order ID: ${order.id}`,
        orderType === "limit" ? `Limit: $${limitPrice}` : "",
        `Time: ${new Date().toLocaleString("fr-CA", { timeZone: "America/Toronto" })}`,
      ].filter(Boolean).join("\n");
    } catch (err) {
      return `Error placing buy order: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

// ── trading.sell ──

registerSkill({
  name: "trading.sell",
  description: "Place a paper trading SELL order on Alpaca (market or limit).",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      symbol: { type: "string", description: "Stock ticker (e.g. IONQ)" },
      qty: { type: "number", description: "Number of shares" },
      type: { type: "string", description: "Order type: market (default) or limit" },
      limit_price: { type: "number", description: "Limit price (required if type=limit)" },
    },
    required: ["symbol", "qty"],
  },
  async execute(args): Promise<string> {
    const symbol = (args.symbol as string).toUpperCase();
    const qty = String(Number(args.qty));
    const orderType = (args.type as string) || "market";
    const limitPrice = args.limit_price ? String(Number(args.limit_price)) : undefined;

    try {
      const body: any = {
        symbol,
        qty,
        side: "sell",
        type: orderType,
        time_in_force: "day",
      };
      if (orderType === "limit" && limitPrice) {
        body.limit_price = limitPrice;
      }

      const order = await alpacaPost("/v2/orders", body);
      return [
        `**SELL Order Placed**`,
        `Symbol: ${order.symbol}`,
        `Qty: ${order.qty}`,
        `Type: ${order.type}`,
        `Status: ${order.status}`,
        `Order ID: ${order.id}`,
        orderType === "limit" ? `Limit: $${limitPrice}` : "",
        `Time: ${new Date().toLocaleString("fr-CA", { timeZone: "America/Toronto" })}`,
      ].filter(Boolean).join("\n");
    } catch (err) {
      return `Error placing sell order: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

// ── trading.positions ──

registerSkill({
  name: "trading.positions",
  description: "Show all open paper trading positions with P&L.",
  adminOnly: true,
  argsSchema: { type: "object", properties: {} },
  async execute(): Promise<string> {
    try {
      const positions = await alpacaGet("/v2/positions");
      if (!positions || positions.length === 0) {
        return "**No open positions.** Portfolio is 100% cash.";
      }

      const lines = ["**Open Positions**\n"];
      let totalPL = 0;
      let totalValue = 0;

      for (const p of positions) {
        const pl = Number(p.unrealized_pl);
        const plPct = Number(p.unrealized_plpc) * 100;
        const mktValue = Number(p.market_value);
        totalPL += pl;
        totalValue += mktValue;

        const emoji = pl >= 0 ? "🟢" : "🔴";
        lines.push(
          `${emoji} **${p.symbol}** x${p.qty}`,
          `   Avg: $${Number(p.avg_entry_price).toFixed(2)} → Current: $${Number(p.current_price).toFixed(2)}`,
          `   P&L: ${pl >= 0 ? "+" : ""}$${pl.toFixed(2)} (${plPct >= 0 ? "+" : ""}${plPct.toFixed(1)}%)`,
          `   Value: $${mktValue.toFixed(2)}`,
          "",
        );
      }

      lines.push(`**Total P&L:** ${totalPL >= 0 ? "+" : ""}$${totalPL.toFixed(2)}`);
      lines.push(`**Total Value:** $${totalValue.toFixed(2)}`);

      return lines.join("\n");
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

// ── trading.pnl ──

registerSkill({
  name: "trading.pnl",
  description: "Portfolio performance history (daily P&L, equity curve).",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      period: { type: "string", description: "Period: 1D, 1W, 1M, 3M (default: 1W)" },
    },
  },
  async execute(args): Promise<string> {
    const period = (args.period as string) || "1W";

    try {
      const history = await alpacaGet(
        `/v2/account/portfolio/history?period=${period}&timeframe=1D`
      );

      if (!history || !history.equity || history.equity.length === 0) {
        return "No portfolio history available yet. Start trading first!";
      }

      const equity = history.equity as number[];
      const timestamps = history.timestamp as number[];
      const plPct = history.profit_loss_pct as number[];
      const pl = history.profit_loss as number[];

      const lines = [`**Portfolio History (${period})**\n`];

      const startEq = equity[0];
      const endEq = equity[equity.length - 1];
      const totalReturn = ((endEq - startEq) / startEq) * 100;

      lines.push(`Start: $${startEq.toFixed(2)}`);
      lines.push(`Current: $${endEq.toFixed(2)}`);
      lines.push(`Return: ${totalReturn >= 0 ? "+" : ""}${totalReturn.toFixed(2)}%`);
      lines.push("");

      // Show last 7 data points
      const show = Math.min(equity.length, 7);
      for (let i = equity.length - show; i < equity.length; i++) {
        const date = new Date(timestamps[i] * 1000).toLocaleDateString("fr-CA", { timeZone: "America/Toronto" });
        const dayPL = pl[i] || 0;
        const emoji = dayPL >= 0 ? "🟢" : "🔴";
        lines.push(`${emoji} ${date}: $${equity[i].toFixed(2)} (${dayPL >= 0 ? "+" : ""}$${dayPL.toFixed(2)})`);
      }

      return lines.join("\n");
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

// ── trading.close ──

registerSkill({
  name: "trading.close",
  description: "Close a position or all positions.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      symbol: { type: "string", description: "Ticker to close (omit for ALL positions)" },
    },
  },
  async execute(args): Promise<string> {
    const symbol = args.symbol as string;

    try {
      if (symbol) {
        await alpacaDelete(`/v2/positions/${symbol.toUpperCase()}`);
        return `**Position closed:** ${symbol.toUpperCase()}`;
      } else {
        await alpacaDelete("/v2/positions");
        return "**All positions closed.**";
      }
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

// ── trading.orders ──

registerSkill({
  name: "trading.orders",
  description: "List recent orders (open, filled, cancelled).",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      status: { type: "string", description: "Filter: open, closed, all (default: all)" },
      limit: { type: "number", description: "Max orders to show (default: 10)" },
    },
  },
  async execute(args): Promise<string> {
    const status = (args.status as string) || "all";
    const limit = Math.min(Number(args.limit) || 10, 50);

    try {
      const orders = await alpacaGet(`/v2/orders?status=${status}&limit=${limit}&direction=desc`);

      if (!orders || orders.length === 0) {
        return `No ${status} orders found.`;
      }

      const lines = [`**Orders (${status})**\n`];
      for (const o of orders) {
        const emoji = o.side === "buy" ? "🟢" : "🔴";
        const statusEmoji = o.status === "filled" ? "✅" : o.status === "canceled" ? "❌" : "⏳";
        const price = o.filled_avg_price ? `@$${Number(o.filled_avg_price).toFixed(2)}` : "";
        lines.push(
          `${emoji}${statusEmoji} ${o.side.toUpperCase()} ${o.symbol} x${o.qty} ${o.type} ${price} [${o.status}]`
        );
      }

      return lines.join("\n");
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

// ── trading.cancel ──

registerSkill({
  name: "trading.cancel",
  description: "Cancel an open order or all open orders.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      orderId: { type: "string", description: "Order ID to cancel (omit for ALL open orders)" },
    },
  },
  async execute(args): Promise<string> {
    const orderId = args.orderId as string;

    try {
      if (orderId) {
        await alpacaDelete(`/v2/orders/${orderId}`);
        return `**Order cancelled:** ${orderId}`;
      } else {
        await alpacaDelete("/v2/orders");
        return "**All open orders cancelled.**";
      }
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

// ── trading.journal ──

registerSkill({
  name: "trading.journal",
  description: "View trading journal — all auto-trades and manual trades with P&L.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      limit: { type: "number", description: "Number of recent trades to show (default: 10)" },
    },
  },
  async execute(args): Promise<string> {
    try {
      const { loadJournal } = await import("../../agents/definitions/trading-monitor.js");
      const journal = loadJournal();
      const limit = Math.min(Number(args.limit) || 10, 50);
      const recent = journal.slice(-limit);

      if (recent.length === 0) {
        return "**Journal de Trading** — Aucun trade enregistre.";
      }

      const lines = [`**Journal de Trading** (${recent.length} derniers trades)\n`];
      let totalPnL = 0;

      for (const t of recent) {
        const emoji = t.side === "buy" ? "🟢" : "🔴";
        const pnl = t.pnl ? ` | P&L: ${t.pnl >= 0 ? "+" : ""}$${t.pnl.toFixed(2)}` : "";
        totalPnL += t.pnl || 0;
        const date = new Date(t.timestamp).toLocaleString("fr-CA", { timeZone: "America/Toronto" });
        lines.push(
          `${emoji} **${t.side.toUpperCase()} ${t.symbol}** x${t.qty} @ $${t.price.toFixed(2)}${pnl}`,
          `   ${date} — ${t.reason}`,
          "",
        );
      }

      if (journal.length > 0) {
        lines.push(`**P&L Total Journal:** ${totalPnL >= 0 ? "+" : ""}$${totalPnL.toFixed(2)}`);
        lines.push(`**Trades totaux:** ${journal.length}`);
      }

      return lines.join("\n");
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

// ── trading.autoscan ──

registerSkill({
  name: "trading.autoscan",
  description: "Auto-scan market for new opportunities using RSI, VWAP, Bollinger. Returns top picks with entry/exit levels.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      universe: { type: "string", description: "Universe: smallcap, tech, momentum (default: momentum)" },
      maxPicks: { type: "number", description: "Max picks to return (default: 5)" },
    },
  },
  async execute(args): Promise<string> {
    const universe = (args.universe as string) || "momentum";
    const maxPicks = Math.min(Number(args.maxPicks) || 5, 10);

    const watchlists: Record<string, string[]> = {
      smallcap: ["IONQ", "RGTI", "QUBT", "SOUN", "BBAI", "JOBY", "LUNR", "RKLB", "ACHR", "HIMS", "KULR", "ASTS"],
      tech: ["NVDA", "AMD", "PLTR", "SMCI", "ARM", "CRWD", "NET", "SNOW", "DDOG", "COIN"],
      momentum: [
        "IONQ", "RGTI", "QUBT", "SOUN", "MARA", "RIOT", "HOOD", "SOFI", "HIMS",
        "PLTR", "AMD", "COIN", "RKLB", "JOBY", "LUNR", "DKNG",
      ],
    };

    const tickers = watchlists[universe] || watchlists.momentum;
    const results: Array<{ ticker: string; score: number; direction: string; entry: number; stop: number; target: number; reasons: string[] }> = [];

    for (const ticker of tickers) {
      try {
        const q = await yfQuote(ticker);
        if (!q) continue;

        let score = 0;
        const reasons: string[] = [];
        let direction = "LONG";

        // RSI extremes
        if (q.rsi14 !== undefined) {
          if (q.rsi14 < 30) { score += 30; reasons.push(`RSI=${q.rsi14.toFixed(0)} survendu`); direction = "LONG"; }
          else if (q.rsi14 > 70 && q.changePct > 0) { score += 20; reasons.push(`RSI=${q.rsi14.toFixed(0)} momentum`); direction = "LONG"; }
          else if (q.rsi14 > 70 && q.changePct < 0) { score += 15; reasons.push(`RSI=${q.rsi14.toFixed(0)} retournement`); direction = "SHORT"; }
        }

        // Volume spike
        if (q.avgVolume && q.volume > q.avgVolume * 2) { score += 20; reasons.push(`RVOL ${((q.volume / q.avgVolume) * 100).toFixed(0)}%`); }
        else if (q.avgVolume && q.volume > q.avgVolume * 1.5) { score += 10; reasons.push(`Volume eleve`); }

        // Big move
        if (Math.abs(q.changePct) > 5) { score += 15; reasons.push(`Mouvement ${q.changePct > 0 ? "+" : ""}${q.changePct.toFixed(1)}%`); }
        else if (Math.abs(q.changePct) > 3) { score += 8; reasons.push(`${q.changePct > 0 ? "+" : ""}${q.changePct.toFixed(1)}%`); }

        // Intraday range
        const range = ((q.high - q.low) / q.price) * 100;
        if (range > 5) { score += 10; reasons.push(`Range ${range.toFixed(1)}%`); }

        if (score >= 25) {
          const entry = q.price;
          const stop = direction === "LONG" ? entry * 0.95 : entry * 1.05;
          const target = direction === "LONG" ? entry * 1.12 : entry * 0.88;
          results.push({ ticker, score, direction, entry, stop, target, reasons });
        }
      } catch { /* skip */ }
    }

    results.sort((a, b) => b.score - a.score);
    const top = results.slice(0, maxPicks);

    if (top.length === 0) {
      return `**AutoScan (${universe})** — Aucune opportunite a signal fort detectee.`;
    }

    const lines = [`**AutoScan ${universe.toUpperCase()}** — ${top.length} opportunites\n`];
    for (const r of top) {
      const stars = r.score >= 50 ? "***" : r.score >= 35 ? "**" : "*";
      lines.push(
        `${r.score >= 50 ? "🔥" : "⚡"} ${stars}${r.direction} ${r.ticker}${stars} (score: ${r.score})`,
        `   Entry: $${r.entry.toFixed(2)} | Stop: $${r.stop.toFixed(2)} | Target: $${r.target.toFixed(2)}`,
        `   ${r.reasons.join(", ")}`,
        "",
      );
    }

    return lines.join("\n");
  },
});

// ── trading.insiders ──

registerSkill({
  name: "trading.insiders",
  description: "Check SEC EDGAR for recent insider transactions (buys/sells by executives). Useful for conviction signals.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      symbol: { type: "string", description: "Stock ticker to check (e.g. TSLA). Omit to check all portfolio positions." },
      days: { type: "number", description: "Look back N days (default: 30)" },
    },
  },
  async execute(args): Promise<string> {
    const days = Math.min(Number(args.days) || 30, 90);
    const symbol = args.symbol as string | undefined;

    // If no symbol, check all portfolio positions
    let tickers: string[];
    if (symbol) {
      tickers = [symbol.toUpperCase()];
    } else {
      try {
        const positions = await alpacaGet("/v2/positions");
        tickers = positions.map((p: any) => p.symbol as string);
      } catch {
        tickers = ["TSLA", "VST", "NVST", "BBVA", "AVXL", "DVA", "ADNT"];
      }
    }

    const dateTo = new Date().toISOString().slice(0, 10);
    const dateFrom = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

    const lines = [`**Insider Transactions** (${days} derniers jours)\n`];
    let totalFound = 0;

    for (const ticker of tickers) {
      try {
        // SEC EDGAR full-text search for insider filings (Form 4)
        const resp = await fetch(
          `https://efts.sec.gov/LATEST/search-index?q=%22${ticker}%22&forms=4&dateRange=custom&startdt=${dateFrom}&enddt=${dateTo}&from=0&size=5`,
          { headers: { "User-Agent": "Kingston/1.0 (nicolas@bastilon.org)", Accept: "application/json" } }
        );

        if (resp.ok) {
          const data = await resp.json();
          const hits = data?.hits?.hits || [];

          if (hits.length > 0) {
            lines.push(`**${ticker}** — ${hits.length} filings Form 4:`);
            for (const hit of hits.slice(0, 3)) {
              const src = hit._source || {};
              const name = src.display_names?.[0] || "Unknown";
              const date = src.file_date || "N/A";
              lines.push(`  - ${date}: ${name}`);
            }
            totalFound += hits.length;
          } else {
            lines.push(`${ticker}: Aucun Form 4 récent`);
          }
        } else {
          lines.push(`${ticker}: API SEC non disponible (${resp.status})`);
        }
      } catch (err) {
        lines.push(`${ticker}: Erreur — ${err instanceof Error ? err.message : String(err)}`);
      }
      lines.push("");
    }

    lines.push(`**Total:** ${totalFound} transactions d'insiders trouvées`);
    lines.push(`\n💡 Insiders qui ACHÈTENT = signal haussier fort`);
    lines.push(`⚠️ Insiders qui VENDENT = pas nécessairement baissier (diversification, impôts)`);

    return lines.join("\n");
  },
});

// ── trading.watchlist ──

registerSkill({
  name: "trading.watchlist",
  description: "Manage a dynamic watchlist — add, remove, list tickers to monitor for opportunities.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      action: { type: "string", description: "Action: add, remove, list, scan (default: list)" },
      symbol: { type: "string", description: "Ticker to add/remove" },
      reason: { type: "string", description: "Why watching this stock (for notes)" },
    },
  },
  async execute(args): Promise<string> {
    const action = (args.action as string) || "list";
    const symbol = (args.symbol as string)?.toUpperCase();
    const reason = (args.reason as string) || "";

    const fs = await import("node:fs");
    const path = await import("node:path");
    const watchlistPath = path.join(process.cwd(), "relay", "watchlist.json");

    interface WatchItem { symbol: string; addedAt: string; reason: string; }
    let watchlist: WatchItem[] = [];
    try {
      if (fs.existsSync(watchlistPath)) {
        watchlist = JSON.parse(fs.readFileSync(watchlistPath, "utf-8"));
      }
    } catch { /* fresh list */ }

    function saveList() {
      const dir = path.dirname(watchlistPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(watchlistPath, JSON.stringify(watchlist, null, 2));
    }

    if (action === "add" && symbol) {
      if (watchlist.some(w => w.symbol === symbol)) {
        return `${symbol} est déjà dans la watchlist.`;
      }
      watchlist.push({ symbol, addedAt: new Date().toISOString(), reason });
      saveList();
      return `**Ajouté à la watchlist:** ${symbol}${reason ? ` — ${reason}` : ""}`;
    }

    if (action === "remove" && symbol) {
      const before = watchlist.length;
      watchlist = watchlist.filter(w => w.symbol !== symbol);
      if (watchlist.length === before) return `${symbol} n'est pas dans la watchlist.`;
      saveList();
      return `**Retiré de la watchlist:** ${symbol}`;
    }

    if (action === "scan") {
      if (watchlist.length === 0) return "Watchlist vide. Ajoute des tickers avec action=add.";
      const scanTickers = watchlist.map(w => w.symbol);
      const scanLines = [`**Watchlist Scan** (${scanTickers.length} tickers)\n`];

      for (const t of scanTickers) {
        const q = await yfQuote(t);
        if (!q) { scanLines.push(`❓ ${t}: Données indisponibles`); continue; }

        const dir = q.changePct >= 0 ? "+" : "";
        const rsi = q.rsi14 ? `RSI:${q.rsi14.toFixed(0)}` : "";
        const alert =
          (q.rsi14 && q.rsi14 < 30) ? " 🟢 SURVENDU" :
          (q.rsi14 && q.rsi14 > 70) ? " 🔴 SURACHETÉ" :
          (Math.abs(q.changePct) > 5) ? " ⚡ MOUVEMENT" : "";

        const item = watchlist.find(w => w.symbol === t);
        scanLines.push(
          `${alert ? "🔔" : "📊"} **${t}** $${q.price.toFixed(2)} (${dir}${q.changePct.toFixed(1)}%) ${rsi}${alert}` +
          (item?.reason ? `\n   Note: ${item.reason}` : "")
        );
      }

      return scanLines.join("\n");
    }

    // Default: list
    if (watchlist.length === 0) return "**Watchlist vide.** Utilise action=add pour ajouter des tickers.";
    const listLines = [`**Watchlist** (${watchlist.length} tickers)\n`];
    for (const w of watchlist) {
      const date = new Date(w.addedAt).toLocaleDateString("fr-CA", { timeZone: "America/Toronto" });
      listLines.push(`- **${w.symbol}** (ajouté ${date})${w.reason ? ` — ${w.reason}` : ""}`);
    }
    return listLines.join("\n");
  },
});

// ── trading.morning ──

registerSkill({
  name: "trading.morning",
  description: "Generate morning briefing — portfolio status, market conditions, top opportunities.",
  adminOnly: true,
  argsSchema: { type: "object", properties: {} },
  async execute(): Promise<string> {
    const lines = [`**BRIEFING MATINAL — ${new Date().toLocaleDateString("fr-CA", { timeZone: "America/Toronto", weekday: "long", year: "numeric", month: "long", day: "numeric" })}**\n`];

    // 1. Account status
    try {
      const acct = await alpacaGet("/v2/account");
      const equity = Number(acct.equity);
      const lastEquity = Number(acct.last_equity);
      const dailyPL = equity - lastEquity;
      const goal = 120000;
      const progress = ((equity / goal) * 100).toFixed(1);

      lines.push(`**Portfolio:** $${equity.toFixed(2)}`);
      lines.push(`**P&L hier:** ${dailyPL >= 0 ? "+" : ""}$${dailyPL.toFixed(2)}`);
      lines.push(`**Cash dispo:** $${Number(acct.buying_power).toFixed(2)}`);
      lines.push(`**Objectif $120K:** ${progress}% (reste $${(goal - equity).toFixed(0)})`);
      lines.push("");
    } catch (err) {
      lines.push(`Account: Erreur — ${err instanceof Error ? err.message : String(err)}\n`);
    }

    // 2. Positions summary
    try {
      const positions = await alpacaGet("/v2/positions");
      if (positions.length > 0) {
        lines.push(`**Positions (${positions.length}):**`);
        let totalPL = 0;
        for (const p of positions) {
          const pl = Number(p.unrealized_pl);
          totalPL += pl;
          const emoji = pl >= 0 ? "🟢" : "🔴";
          lines.push(`${emoji} ${p.symbol} x${p.qty} @ $${Number(p.current_price).toFixed(2)} (${pl >= 0 ? "+" : ""}$${pl.toFixed(2)})`);
        }
        lines.push(`**P&L total:** ${totalPL >= 0 ? "+" : ""}$${totalPL.toFixed(2)}\n`);
      }
    } catch { /* skip */ }

    // 3. Market indices
    try {
      const indices = ["SPY", "QQQ", "IWM"];
      const indexQuotes = await Promise.all(indices.map(yfQuote));
      lines.push("**Marché:**");
      for (const q of indexQuotes) {
        if (!q) continue;
        const emoji = q.changePct >= 0 ? "📈" : "📉";
        lines.push(`${emoji} ${q.symbol}: $${q.price.toFixed(2)} (${q.changePct >= 0 ? "+" : ""}${q.changePct.toFixed(1)}%)`);
      }
      lines.push("");
    } catch { /* skip */ }

    // 4. Top movers from watchlist
    try {
      const movers = ["IONQ", "RGTI", "QUBT", "SOUN", "MARA", "RIOT", "HOOD", "SOFI", "HIMS", "PLTR", "AMD", "COIN"];
      const quotes = await Promise.all(movers.map(yfQuote));
      const valid = quotes.filter((q): q is QuoteData => q !== null);
      const sorted = valid.sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct)).slice(0, 3);

      if (sorted.length > 0) {
        lines.push("**Top movers:**");
        for (const q of sorted) {
          const dir = q.changePct >= 0 ? "+" : "";
          const rsi = q.rsi14 ? ` RSI:${q.rsi14.toFixed(0)}` : "";
          lines.push(`- ${q.symbol}: ${dir}${q.changePct.toFixed(1)}% ($${q.price.toFixed(2)})${rsi}`);
        }
        lines.push("");
      }
    } catch { /* skip */ }

    lines.push("_Bon trading! 🎯_");
    return lines.join("\n");
  },
});
