/**
 * Trading Screener — Find opportunities across the whole market
 *
 * Skills: trading.screen, trading.momentum, trading.oversold, trading.gap
 *
 * Scans 100+ stocks for specific technical setups:
 * - Oversold bounces (RSI < 30)
 * - Momentum breakouts (RSI + volume + trend)
 * - Gap plays (pre-market gaps)
 * - Custom screens with filters
 */
import { registerSkill } from "../loader.js";
import { log } from "../../utils/log.js";

// ── Universe Definitions ──

const UNIVERSES: Record<string, string[]> = {
  quantum: ["IONQ", "RGTI", "QUBT"],
  space: ["JOBY", "LUNR", "RKLB", "ACHR", "ASTS"],
  crypto_stocks: ["COIN", "MARA", "RIOT", "HOOD", "HUT", "CIFR", "BTBT"],
  fintech: ["SOFI", "AFRM", "UPST", "PYPL", "SQ"],
  biotech: ["HIMS", "CLOV", "DNA"],
  ev: ["LCID", "RIVN", "NIO", "GOEV", "QS"],
  ai_tech: ["NVDA", "AMD", "PLTR", "SMCI", "ARM", "CRWD", "NET", "SNOW", "DDOG", "SOUN", "BBAI"],
  gaming: ["DKNG", "RBLX", "SNAP"],
  mega: ["AAPL", "MSFT", "GOOGL", "AMZN", "META", "TSLA", "NFLX"],
  etf: ["SPY", "QQQ", "IWM", "ARKK", "SOXL", "TQQQ"],
};

// Combined "all smallcaps" universe
const ALL_SMALLCAPS = [
  ...UNIVERSES.quantum, ...UNIVERSES.space, ...UNIVERSES.crypto_stocks,
  ...UNIVERSES.fintech, ...UNIVERSES.biotech, ...UNIVERSES.ev,
  ...UNIVERSES.gaming, "KULR", "STEM", "MVST", "OPEN", "WISH",
];

const ALL_STOCKS = Array.from(new Set([...ALL_SMALLCAPS, ...UNIVERSES.ai_tech, ...UNIVERSES.mega]));

// ── Yahoo Finance Helper ──

const YF = "https://query1.finance.yahoo.com/v8/finance/chart";
const UA = { "User-Agent": "Mozilla/5.0" };

interface ScreenData {
  symbol: string;
  price: number;
  prevClose: number;
  changePct: number;
  volume: number;
  avgVolume: number;
  rsi14: number | null;
  ma20: number | null;
  ma50: number | null;
  high: number;
  low: number;
  gapPct: number;
  range: number; // intraday range %
  rVol: number;
}

async function fetchScreenData(symbol: string): Promise<ScreenData | null> {
  try {
    const resp = await fetch(`${YF}/${symbol}?interval=1d&range=6mo`, {
      headers: UA, signal: AbortSignal.timeout(8000),
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

    let ma20: number | null = null, ma50: number | null = null, rsi14: number | null = null;

    if (closes.length >= 20) ma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    if (closes.length >= 50) ma50 = closes.slice(-50).reduce((a, b) => a + b, 0) / 50;
    if (closes.length >= 15) {
      let gains = 0, losses = 0;
      for (let i = closes.length - 14; i < closes.length; i++) {
        const c = closes[i] - closes[i - 1];
        if (c > 0) gains += c; else losses += Math.abs(c);
      }
      const ag = gains / 14, al = losses / 14;
      rsi14 = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    }

    const avgVolume = volumes.length >= 10
      ? volumes.slice(-10).reduce((a, b) => a + b, 0) / 10
      : meta.regularMarketVolume || 1;

    const high = meta.regularMarketDayHigh || price;
    const low = meta.regularMarketDayLow || price;

    return {
      symbol: symbol.toUpperCase(),
      price, prevClose,
      changePct: ((price - prevClose) / prevClose) * 100,
      volume: meta.regularMarketVolume || 0,
      avgVolume,
      rsi14, ma20, ma50, high, low,
      gapPct: ((price - prevClose) / prevClose) * 100,
      range: price > 0 ? ((high - low) / price) * 100 : 0,
      rVol: avgVolume > 0 ? (meta.regularMarketVolume || 0) / avgVolume : 1,
    };
  } catch { return null; }
}

function fmt(n: number | null | undefined, d = 2): string {
  return n == null ? "N/A" : n.toFixed(d);
}

// ── Batch fetch with concurrency control ──

async function batchFetch(symbols: string[], concurrency = 5): Promise<ScreenData[]> {
  const results: ScreenData[] = [];
  for (let i = 0; i < symbols.length; i += concurrency) {
    const batch = symbols.slice(i, i + concurrency);
    const fetched = await Promise.all(batch.map(fetchScreenData));
    for (const d of fetched) {
      if (d) results.push(d);
    }
  }
  return results;
}

// ── trading.screen ──

registerSkill({
  name: "trading.screen",
  description: "Screen stocks with custom filters: RSI range, volume spike, change %, price range. Scans 80+ stocks.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      rsi_min: { type: "number", description: "Min RSI (e.g. 0)" },
      rsi_max: { type: "number", description: "Max RSI (e.g. 30 for oversold)" },
      min_change: { type: "number", description: "Min daily change % (e.g. 3)" },
      max_change: { type: "number", description: "Max daily change % (e.g. -3 for drops)" },
      min_rvol: { type: "number", description: "Min relative volume (e.g. 1.5)" },
      min_price: { type: "number", description: "Min stock price" },
      max_price: { type: "number", description: "Max stock price" },
      universe: { type: "string", description: "Universe: all (default), quantum, space, crypto_stocks, fintech, ai_tech, mega" },
      limit: { type: "number", description: "Max results (default 15)" },
    },
  },
  async execute(args): Promise<string> {
    const universe = (args.universe as string) || "all";
    const limit = Math.min(Number(args.limit) || 15, 30);
    const symbols = universe === "all" ? ALL_STOCKS : (UNIVERSES[universe] || ALL_STOCKS);

    const stocks = await batchFetch(symbols);

    // Apply filters
    let filtered = stocks;

    if (args.rsi_min != null) filtered = filtered.filter(s => s.rsi14 !== null && s.rsi14 >= Number(args.rsi_min));
    if (args.rsi_max != null) filtered = filtered.filter(s => s.rsi14 !== null && s.rsi14 <= Number(args.rsi_max));
    if (args.min_change != null) filtered = filtered.filter(s => s.changePct >= Number(args.min_change));
    if (args.max_change != null) filtered = filtered.filter(s => s.changePct <= Number(args.max_change));
    if (args.min_rvol != null) filtered = filtered.filter(s => s.rVol >= Number(args.min_rvol));
    if (args.min_price != null) filtered = filtered.filter(s => s.price >= Number(args.min_price));
    if (args.max_price != null) filtered = filtered.filter(s => s.price <= Number(args.max_price));

    // Sort by absolute change (most interesting first)
    filtered.sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct));
    const top = filtered.slice(0, limit);

    if (top.length === 0) return `Aucun stock ne correspond aux filtres dans l'univers "${universe}".`;

    const lines = [`\u{1F50D} **SCREENER** (${universe}) — ${top.length}/${filtered.length} résultats\n`];

    for (const s of top) {
      const dir = s.changePct >= 0 ? "+" : "";
      const rsiTag = s.rsi14 !== null ? (s.rsi14 < 30 ? " \u{1F7E2}SURVENDU" : s.rsi14 > 70 ? " \u{1F534}SURACHETÉ" : "") : "";
      const volTag = s.rVol > 2 ? " \u{1F4A5}VOL" : s.rVol > 1.5 ? " \u26A1VOL" : "";

      lines.push(
        `**${s.symbol}** $${fmt(s.price)} (${dir}${fmt(s.changePct)}%) RSI:${fmt(s.rsi14, 0)} RVOL:${fmt(s.rVol, 1)}x${rsiTag}${volTag}`
      );
    }

    return lines.join("\n");
  },
});

// ── trading.momentum ──

registerSkill({
  name: "trading.momentum",
  description: "Find momentum breakout candidates: rising price + volume spike + RSI 50-70 (sweet spot). Best for swing trades.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      universe: { type: "string", description: "Universe to scan (default: all)" },
    },
  },
  async execute(args): Promise<string> {
    const universe = (args.universe as string) || "all";
    const symbols = universe === "all" ? ALL_STOCKS : (UNIVERSES[universe] || ALL_STOCKS);

    const stocks = await batchFetch(symbols);

    // Momentum criteria: RSI 40-70, price > MA20, volume > 1.3x, positive change
    const momentum = stocks.filter(s =>
      s.rsi14 !== null && s.rsi14 >= 40 && s.rsi14 <= 70 &&
      s.ma20 !== null && s.price > s.ma20 &&
      s.rVol >= 1.3 &&
      s.changePct > 0
    );

    // Score them
    const scored = momentum.map(s => {
      let score = 0;
      // RSI sweet spot (50-65 = best)
      if (s.rsi14! >= 50 && s.rsi14! <= 65) score += 3;
      else score += 1;
      // Volume confirmation
      if (s.rVol > 2) score += 3;
      else if (s.rVol > 1.5) score += 2;
      else score += 1;
      // Price above MA50
      if (s.ma50 && s.price > s.ma50) score += 2;
      // Strong daily move
      if (s.changePct > 3) score += 2;
      else if (s.changePct > 1) score += 1;
      // Intraday range
      if (s.range > 3) score += 1;

      return { ...s, score };
    });

    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, 10);

    if (top.length === 0) return "Aucun signal momentum détecté.";

    const lines = [`\u{1F680} **MOMENTUM SCREENER** — ${top.length} candidats\n`];

    for (const s of top) {
      const stars = s.score >= 8 ? "\u{1F525}\u{1F525}" : s.score >= 6 ? "\u{1F525}" : "\u26A1";
      lines.push(
        `${stars} **${s.symbol}** $${fmt(s.price)} (+${fmt(s.changePct)}%)`,
        `   RSI:${fmt(s.rsi14, 0)} | RVOL:${fmt(s.rVol, 1)}x | Score:${s.score} | Range:${fmt(s.range)}%`,
        ""
      );
    }

    lines.push(`\u{1F4A1} Momentum = prix monte + volume confirme + RSI pas encore suracheté`);
    return lines.join("\n");
  },
});

// ── trading.oversold ──

registerSkill({
  name: "trading.oversold",
  description: "Find oversold bounce candidates: RSI < 35 + near support. Best for mean-reversion trades.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      universe: { type: "string", description: "Universe to scan (default: all)" },
    },
  },
  async execute(args): Promise<string> {
    const universe = (args.universe as string) || "all";
    const symbols = universe === "all" ? ALL_STOCKS : (UNIVERSES[universe] || ALL_STOCKS);

    const stocks = await batchFetch(symbols);

    // Oversold: RSI < 35
    const oversold = stocks.filter(s => s.rsi14 !== null && s.rsi14 < 35);

    // Score them
    const scored = oversold.map(s => {
      let score = 0;
      // Deeper RSI = stronger bounce potential
      if (s.rsi14! < 20) score += 4;
      else if (s.rsi14! < 25) score += 3;
      else if (s.rsi14! < 30) score += 2;
      else score += 1;
      // Volume spike = capitulation
      if (s.rVol > 2) score += 2;
      // Near day low (bounce starting?)
      if (s.price > s.low * 1.01) score += 1; // Price bounced from low
      // Big drop = bigger bounce potential
      if (s.changePct < -5) score += 2;
      else if (s.changePct < -3) score += 1;

      const entry = s.price;
      const stop = entry * 0.95;
      const target = entry * 1.10;

      return { ...s, score, entry, stop, target };
    });

    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, 10);

    if (top.length === 0) return "Aucun stock survendu détecté (RSI > 35 partout).";

    const lines = [`\u{1F7E2} **OVERSOLD SCREENER** — ${top.length} candidats\n`];

    for (const s of top) {
      const emoji = s.score >= 6 ? "\u{1F525}" : s.score >= 4 ? "\u26A1" : "\u{1F4CA}";
      lines.push(
        `${emoji} **${s.symbol}** $${fmt(s.price)} (${fmt(s.changePct)}%)`,
        `   RSI:${fmt(s.rsi14, 0)} | RVOL:${fmt(s.rVol, 1)}x | Score:${s.score}`,
        `   Entry: $${fmt(s.entry)} | SL: $${fmt(s.stop)} | TP: $${fmt(s.target)}`,
        ""
      );
    }

    lines.push(`\u{1F4A1} Survendu = potentiel rebond. Attendre confirmation (volume + prix remonte) avant d'entrer.`);
    return lines.join("\n");
  },
});

// ── trading.gap ──

registerSkill({
  name: "trading.gap",
  description: "Find gap-up and gap-down stocks for gap trading strategies.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      direction: { type: "string", description: "'up' (default), 'down', or 'both'" },
      min_gap: { type: "number", description: "Minimum gap % (default: 3)" },
    },
  },
  async execute(args): Promise<string> {
    const direction = ((args.direction as string) || "both").toLowerCase();
    const minGap = Number(args.min_gap) || 3;

    const stocks = await batchFetch(ALL_STOCKS);

    let gaps = stocks.filter(s => {
      const absGap = Math.abs(s.gapPct);
      if (absGap < minGap) return false;
      if (direction === "up") return s.gapPct > 0;
      if (direction === "down") return s.gapPct < 0;
      return true; // both
    });

    gaps.sort((a, b) => Math.abs(b.gapPct) - Math.abs(a.gapPct));
    const top = gaps.slice(0, 15);

    if (top.length === 0) return `Aucun gap > ${minGap}% détecté.`;

    const lines = [`\u26A1 **GAP SCREENER** (min ${minGap}%) — ${top.length} résultats\n`];

    for (const s of top) {
      const gapDir = s.gapPct > 0 ? "\u{1F7E2} GAP UP" : "\u{1F534} GAP DOWN";
      const strategy = s.gapPct > 5 && s.price < s.high * 0.97 ? " \u27A1\uFE0F FADE?" :
                       s.gapPct > 3 && s.rVol > 1.5 ? " \u27A1\uFE0F GO?" : "";

      lines.push(
        `${gapDir} **${s.symbol}** ${s.gapPct >= 0 ? "+" : ""}${fmt(s.gapPct)}% ($${fmt(s.price)})`,
        `   Vol: ${s.volume > 1e6 ? fmt(s.volume / 1e6, 1) + "M" : fmt(s.volume / 1e3, 0) + "K"} (${fmt(s.rVol, 1)}x) | RSI:${fmt(s.rsi14, 0)}${strategy}`,
        ""
      );
    }

    lines.push(`\u{1F4A1} Gap & Go: volume + tendance. Gap & Fade: gap > 5% + prix redescend.`);
    return lines.join("\n");
  },
});

// ── trading.best_setup ──

registerSkill({
  name: "trading.best_setup",
  description: "Find the single best trading setup right now. Combines all screeners and returns top 3 trades with entry/SL/TP.",
  adminOnly: true,
  argsSchema: { type: "object", properties: {} },
  async execute(): Promise<string> {
    const stocks = await batchFetch(ALL_STOCKS);

    // Score every stock
    const scored = stocks.map(s => {
      let bullScore = 0;
      let bearScore = 0;
      const reasons: string[] = [];

      // RSI
      if (s.rsi14 !== null) {
        if (s.rsi14 < 25) { bullScore += 5; reasons.push(`RSI ${s.rsi14.toFixed(0)} (très survendu)`); }
        else if (s.rsi14 < 35) { bullScore += 3; reasons.push(`RSI ${s.rsi14.toFixed(0)} (survendu)`); }
        else if (s.rsi14 > 75) { bearScore += 3; reasons.push(`RSI ${s.rsi14.toFixed(0)} (suracheté)`); }
      }

      // Momentum
      if (s.changePct > 5) { bullScore += 3; reasons.push(`+${s.changePct.toFixed(1)}% mouvement`); }
      else if (s.changePct > 2 && s.rVol > 1.5) { bullScore += 2; reasons.push(`+${s.changePct.toFixed(1)}% vol`); }
      else if (s.changePct < -5) { bullScore += 2; reasons.push(`${s.changePct.toFixed(1)}% (rebond?)`); }

      // Volume
      if (s.rVol > 3) { bullScore += 3; reasons.push(`RVOL ${s.rVol.toFixed(1)}x (énorme)`); }
      else if (s.rVol > 2) { bullScore += 2; reasons.push(`RVOL ${s.rVol.toFixed(1)}x`); }
      else if (s.rVol > 1.5) { bullScore += 1; }

      // Trend
      if (s.ma20 && s.price > s.ma20) bullScore += 1;
      if (s.ma50 && s.price > s.ma50) bullScore += 1;

      // Intraday range (volatility = opportunity)
      if (s.range > 5) { bullScore += 1; reasons.push(`Range ${s.range.toFixed(1)}%`); }

      const totalScore = bullScore;
      const direction = s.rsi14 !== null && s.rsi14 < 35 ? "LONG (rebond)" :
                        s.changePct > 2 ? "LONG (momentum)" :
                        s.changePct < -2 && s.rsi14 !== null && s.rsi14 < 40 ? "LONG (dip buy)" :
                        "LONG";

      const entry = s.price;
      const stop = entry * 0.95;
      const tp1 = entry * 1.05;
      const tp2 = entry * 1.10;

      return { ...s, totalScore, direction, reasons, entry, stop, tp1, tp2 };
    });

    scored.sort((a, b) => b.totalScore - a.totalScore);
    const top3 = scored.slice(0, 3);

    if (top3.length === 0 || top3[0].totalScore < 3) {
      return "Aucun setup intéressant détecté. Marché calme — patience.";
    }

    const lines = [`\u{1F3AF} **TOP 3 SETUPS** \u2014 ${new Date().toLocaleTimeString("fr-CA", { timeZone: "America/Toronto", hour12: false })}\n`];

    for (let i = 0; i < top3.length; i++) {
      const s = top3[i];
      const medal = i === 0 ? "\u{1F947}" : i === 1 ? "\u{1F948}" : "\u{1F949}";
      lines.push(
        `${medal} **${s.symbol}** — ${s.direction} (score: ${s.totalScore})`,
        `   Prix: $${fmt(s.price)} | RSI: ${fmt(s.rsi14, 0)} | RVOL: ${fmt(s.rVol, 1)}x`,
        `   Entry: $${fmt(s.entry)} | SL: $${fmt(s.stop)} | TP1: $${fmt(s.tp1)} | TP2: $${fmt(s.tp2)}`,
        `   ${s.reasons.join(", ")}`,
        ""
      );
    }

    return lines.join("\n");
  },
});

log.info("[trading-screener] Screener skills loaded (trading.screen, trading.momentum, trading.oversold, trading.gap, trading.best_setup)");
