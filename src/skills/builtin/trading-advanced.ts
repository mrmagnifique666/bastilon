/**
 * Advanced Technical Analysis Skills
 *
 * Adds: MACD, Bollinger Bands, EMA, ATR, Stochastic RSI, support/resistance,
 * multi-timeframe analysis, and a composite "trading.analyze" skill.
 */
import { registerSkill } from "../loader.js";
import { log } from "../../utils/log.js";

// ── Yahoo Finance Data ──

const YF = "https://query1.finance.yahoo.com/v8/finance/chart";
const UA = { "User-Agent": "Mozilla/5.0" };

interface OHLCV {
  timestamps: number[];
  opens: number[];
  highs: number[];
  lows: number[];
  closes: number[];
  volumes: number[];
}

async function fetchOHLCV(symbol: string, range = "6mo", interval = "1d"): Promise<OHLCV | null> {
  try {
    const resp = await fetch(`${YF}/${symbol}?interval=${interval}&range=${range}`, {
      headers: UA, signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const result = data?.chart?.result?.[0];
    if (!result) return null;

    const q = result.indicators?.quote?.[0] || {};
    const ts = result.timestamp || [];

    const opens: number[] = [];
    const highs: number[] = [];
    const lows: number[] = [];
    const closes: number[] = [];
    const volumes: number[] = [];
    const timestamps: number[] = [];

    for (let i = 0; i < ts.length; i++) {
      if (q.close?.[i] != null) {
        timestamps.push(ts[i]);
        opens.push(q.open?.[i] ?? q.close[i]);
        highs.push(q.high?.[i] ?? q.close[i]);
        lows.push(q.low?.[i] ?? q.close[i]);
        closes.push(q.close[i]);
        volumes.push(q.volume?.[i] ?? 0);
      }
    }

    return { timestamps, opens, highs, lows, closes, volumes };
  } catch { return null; }
}

// ── Indicator Functions ──

function ema(data: number[], period: number): number[] {
  const result: number[] = [];
  if (data.length === 0) return result;
  const k = 2 / (period + 1);
  result[0] = data[0];
  for (let i = 1; i < data.length; i++) {
    result[i] = data[i] * k + result[i - 1] * (1 - k);
  }
  return result;
}

function sma(data: number[], period: number): number[] {
  const result: number[] = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) { result.push(NaN); continue; }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += data[j];
    result.push(sum / period);
  }
  return result;
}

function rsi(closes: number[], period = 14): number[] {
  const result: number[] = new Array(closes.length).fill(NaN);
  if (closes.length < period + 1) return result;

  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) avgGain += change; else avgLoss += Math.abs(change);
  }
  avgGain /= period;
  avgLoss /= period;

  result[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (change > 0 ? change : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (change < 0 ? Math.abs(change) : 0)) / period;
    result[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return result;
}

interface MACDResult {
  macd: number[];
  signal: number[];
  histogram: number[];
}

function macd(closes: number[], fast = 12, slow = 26, sig = 9): MACDResult {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const macdLine: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    macdLine.push(emaFast[i] - emaSlow[i]);
  }
  const signalLine = ema(macdLine, sig);
  const histogram: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    histogram.push(macdLine[i] - signalLine[i]);
  }
  return { macd: macdLine, signal: signalLine, histogram };
}

interface BollingerResult {
  upper: number[];
  middle: number[];
  lower: number[];
  bandwidth: number[];
  percentB: number[];
}

function bollinger(closes: number[], period = 20, stdDev = 2): BollingerResult {
  const middle = sma(closes, period);
  const upper: number[] = [];
  const lower: number[] = [];
  const bandwidth: number[] = [];
  const percentB: number[] = [];

  for (let i = 0; i < closes.length; i++) {
    if (isNaN(middle[i])) {
      upper.push(NaN); lower.push(NaN); bandwidth.push(NaN); percentB.push(NaN);
      continue;
    }
    let sumSq = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sumSq += (closes[j] - middle[i]) ** 2;
    }
    const sd = Math.sqrt(sumSq / period);
    upper.push(middle[i] + stdDev * sd);
    lower.push(middle[i] - stdDev * sd);
    const bw = (upper[i] - lower[i]) / middle[i];
    bandwidth.push(bw);
    const pB = lower[i] !== upper[i] ? (closes[i] - lower[i]) / (upper[i] - lower[i]) : 0.5;
    percentB.push(pB);
  }

  return { upper, middle, lower, bandwidth, percentB };
}

function atr(highs: number[], lows: number[], closes: number[], period = 14): number[] {
  const result: number[] = new Array(closes.length).fill(NaN);
  if (closes.length < 2) return result;

  const trueRanges: number[] = [highs[0] - lows[0]];
  for (let i = 1; i < closes.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trueRanges.push(tr);
  }

  // First ATR = simple average
  if (trueRanges.length >= period) {
    let sum = 0;
    for (let i = 0; i < period; i++) sum += trueRanges[i];
    result[period - 1] = sum / period;

    for (let i = period; i < trueRanges.length; i++) {
      result[i] = (result[i - 1] * (period - 1) + trueRanges[i]) / period;
    }
  }
  return result;
}

function stochasticRsi(closes: number[], rsiPeriod = 14, stochPeriod = 14, kSmooth = 3, dSmooth = 3): { k: number[]; d: number[] } {
  const rsiValues = rsi(closes, rsiPeriod);
  const k: number[] = new Array(closes.length).fill(NaN);

  for (let i = stochPeriod + rsiPeriod; i < closes.length; i++) {
    const window = rsiValues.slice(i - stochPeriod + 1, i + 1).filter(v => !isNaN(v));
    if (window.length < stochPeriod) continue;
    const min = Math.min(...window);
    const max = Math.max(...window);
    k[i] = max === min ? 50 : ((rsiValues[i] - min) / (max - min)) * 100;
  }

  // Smooth %K
  const kSmoothed = sma(k.map(v => isNaN(v) ? 0 : v), kSmooth);
  // %D = SMA of smoothed %K
  const d = sma(kSmoothed, dSmooth);

  return { k: kSmoothed, d };
}

function findSupportResistance(highs: number[], lows: number[], closes: number[], lookback = 50): { supports: number[]; resistances: number[] } {
  const n = closes.length;
  const start = Math.max(0, n - lookback);
  const recentHighs = highs.slice(start);
  const recentLows = lows.slice(start);
  const price = closes[n - 1];

  // Find local minima (supports) and maxima (resistances)
  const supports: number[] = [];
  const resistances: number[] = [];

  for (let i = 2; i < recentLows.length - 2; i++) {
    if (recentLows[i] < recentLows[i - 1] && recentLows[i] < recentLows[i - 2] &&
        recentLows[i] < recentLows[i + 1] && recentLows[i] < recentLows[i + 2]) {
      if (recentLows[i] < price) supports.push(recentLows[i]);
    }
    if (recentHighs[i] > recentHighs[i - 1] && recentHighs[i] > recentHighs[i - 2] &&
        recentHighs[i] > recentHighs[i + 1] && recentHighs[i] > recentHighs[i + 2]) {
      if (recentHighs[i] > price) resistances.push(recentHighs[i]);
    }
  }

  // Sort: supports descending (closest first), resistances ascending
  supports.sort((a, b) => b - a);
  resistances.sort((a, b) => a - b);

  return { supports: supports.slice(0, 3), resistances: resistances.slice(0, 3) };
}

function fmt(n: number | undefined | null, d = 2): string {
  return n == null || isNaN(n as number) ? "N/A" : (n as number).toFixed(d);
}

// ── trading.technical ──

registerSkill({
  name: "trading.technical",
  description: "Full technical analysis for a stock: RSI, MACD, Bollinger, EMA, ATR, Stochastic RSI, support/resistance levels.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      symbol: { type: "string", description: "Stock ticker (e.g. IONQ)" },
    },
    required: ["symbol"],
  },
  async execute(args): Promise<string> {
    const symbol = (args.symbol as string).toUpperCase();
    const data = await fetchOHLCV(symbol);
    if (!data || data.closes.length < 50) {
      return `Pas assez de données pour ${symbol}. Minimum 50 jours requis.`;
    }

    const n = data.closes.length;
    const price = data.closes[n - 1];
    const prevPrice = data.closes[n - 2];

    // Calculate all indicators
    const rsiValues = rsi(data.closes);
    const macdResult = macd(data.closes);
    const bbResult = bollinger(data.closes);
    const atrValues = atr(data.highs, data.lows, data.closes);
    const stochRsi = stochasticRsi(data.closes);
    const ema9 = ema(data.closes, 9);
    const ema21 = ema(data.closes, 21);
    const sma50 = sma(data.closes, 50);
    const sma200 = data.closes.length >= 200 ? sma(data.closes, 200) : null;
    const { supports, resistances } = findSupportResistance(data.highs, data.lows, data.closes);

    // Volume analysis
    const avgVol = data.volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const currentVol = data.volumes[n - 1];
    const rVol = avgVol > 0 ? currentVol / avgVol : 1;

    // Signal scoring
    let bullScore = 0;
    let bearScore = 0;
    const signals: string[] = [];

    // RSI
    const currentRsi = rsiValues[n - 1];
    if (!isNaN(currentRsi)) {
      if (currentRsi < 30) { bullScore += 3; signals.push("RSI survendu"); }
      else if (currentRsi < 40) { bullScore += 1; signals.push("RSI bas"); }
      else if (currentRsi > 70) { bearScore += 3; signals.push("RSI suracheté"); }
      else if (currentRsi > 60) { bearScore += 1; signals.push("RSI élevé"); }
    }

    // MACD
    const currentMACD = macdResult.histogram[n - 1];
    const prevMACD = macdResult.histogram[n - 2];
    if (!isNaN(currentMACD) && !isNaN(prevMACD)) {
      if (currentMACD > 0 && prevMACD <= 0) { bullScore += 3; signals.push("MACD cross haussier"); }
      else if (currentMACD < 0 && prevMACD >= 0) { bearScore += 3; signals.push("MACD cross baissier"); }
      else if (currentMACD > prevMACD) { bullScore += 1; signals.push("MACD momentum +"); }
      else { bearScore += 1; signals.push("MACD momentum -"); }
    }

    // Bollinger
    const pctB = bbResult.percentB[n - 1];
    if (!isNaN(pctB)) {
      if (pctB < 0) { bullScore += 2; signals.push("Sous Bollinger inf."); }
      else if (pctB > 1) { bearScore += 2; signals.push("Dessus Bollinger sup."); }
    }

    // EMA crossover
    if (ema9[n - 1] > ema21[n - 1] && ema9[n - 2] <= ema21[n - 2]) {
      bullScore += 2; signals.push("EMA9 > EMA21 (golden cross)");
    } else if (ema9[n - 1] < ema21[n - 1] && ema9[n - 2] >= ema21[n - 2]) {
      bearScore += 2; signals.push("EMA9 < EMA21 (death cross)");
    }

    // Trend (SMA50/200)
    if (!isNaN(sma50[n - 1]) && price > sma50[n - 1]) { bullScore += 1; signals.push("Au-dessus SMA50"); }
    if (sma200 && !isNaN(sma200[n - 1]) && price > sma200[n - 1]) { bullScore += 1; signals.push("Au-dessus SMA200"); }

    // Volume
    if (rVol > 2) { bullScore += 1; signals.push(`Volume élevé ${fmt(rVol, 1)}x`); }

    // Stochastic RSI
    const stochK = stochRsi.k[n - 1];
    const stochD = stochRsi.d[n - 1];
    if (!isNaN(stochK)) {
      if (stochK < 20) { bullScore += 2; signals.push("StochRSI survendu"); }
      else if (stochK > 80) { bearScore += 2; signals.push("StochRSI suracheté"); }
    }

    const totalScore = bullScore - bearScore;
    const verdict = totalScore >= 4 ? "ACHAT FORT" :
                    totalScore >= 2 ? "ACHAT" :
                    totalScore > -2 ? "NEUTRE" :
                    totalScore > -4 ? "VENTE" : "VENTE FORTE";
    const emoji = totalScore >= 4 ? "\u{1F7E2}" : totalScore >= 2 ? "\u{1F7E1}" : totalScore > -2 ? "\u26AA" : totalScore > -4 ? "\u{1F7E0}" : "\u{1F534}";

    const lines = [
      `${emoji} **ANALYSE TECHNIQUE: ${symbol}** — ${verdict} (score: ${totalScore > 0 ? "+" : ""}${totalScore})`,
      `Prix: $${fmt(price)} | Var: ${((price - prevPrice) / prevPrice * 100) >= 0 ? "+" : ""}${fmt((price - prevPrice) / prevPrice * 100)}%`,
      "",
      "**Indicateurs:**",
      `  RSI(14): ${fmt(currentRsi, 0)}`,
      `  MACD: ${fmt(macdResult.macd[n - 1], 3)} | Signal: ${fmt(macdResult.signal[n - 1], 3)} | Hist: ${fmt(currentMACD, 3)}`,
      `  Bollinger: [${fmt(bbResult.lower[n - 1])} - ${fmt(bbResult.middle[n - 1])} - ${fmt(bbResult.upper[n - 1])}] | %B: ${fmt(pctB, 2)}`,
      `  ATR(14): ${fmt(atrValues[n - 1])} (vol ${fmt((atrValues[n - 1] || 0) / price * 100)}%)`,
      `  StochRSI: K=${fmt(stochK, 0)} D=${fmt(stochD, 0)}`,
      `  EMA: 9=${fmt(ema9[n - 1])} | 21=${fmt(ema21[n - 1])}`,
      `  SMA: 50=${fmt(sma50[n - 1])}${sma200 ? ` | 200=${fmt(sma200[n - 1])}` : ""}`,
      `  RVOL: ${fmt(rVol, 1)}x (vol ${currentVol > 1e6 ? fmt(currentVol / 1e6, 1) + "M" : fmt(currentVol / 1e3, 0) + "K"})`,
      "",
      `**Support:** ${supports.length ? supports.map(s => "$" + fmt(s)).join(", ") : "N/A"}`,
      `**Résistance:** ${resistances.length ? resistances.map(r => "$" + fmt(r)).join(", ") : "N/A"}`,
      "",
      `**Signaux (${signals.length}):** ${signals.join(" | ")}`,
    ];

    return lines.join("\n");
  },
});

// ── trading.multi_tf ──

registerSkill({
  name: "trading.multi_tf",
  description: "Multi-timeframe analysis: daily + weekly + monthly RSI, MACD, trend. Identifies convergent signals.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      symbol: { type: "string", description: "Stock ticker (e.g. TSLA)" },
    },
    required: ["symbol"],
  },
  async execute(args): Promise<string> {
    const symbol = (args.symbol as string).toUpperCase();

    const [daily, weekly, monthly] = await Promise.all([
      fetchOHLCV(symbol, "6mo", "1d"),
      fetchOHLCV(symbol, "2y", "1wk"),
      fetchOHLCV(symbol, "5y", "1mo"),
    ]);

    function analyzeTF(label: string, data: OHLCV | null): string {
      if (!data || data.closes.length < 20) return `${label}: Données insuffisantes`;
      const n = data.closes.length;
      const price = data.closes[n - 1];
      const rsiVals = rsi(data.closes);
      const macdR = macd(data.closes);
      const ema20 = ema(data.closes, 20);

      const currentRsi = rsiVals[n - 1];
      const hist = macdR.histogram[n - 1];
      const trend = price > ema20[n - 1] ? "\u2191 Haussier" : "\u2193 Baissier";
      const rsiText = isNaN(currentRsi) ? "N/A" : currentRsi < 30 ? `${currentRsi.toFixed(0)} SURVENDU` : currentRsi > 70 ? `${currentRsi.toFixed(0)} SURACHETÉ` : currentRsi.toFixed(0);
      const macdText = isNaN(hist) ? "N/A" : hist > 0 ? `+${hist.toFixed(3)} Haussier` : `${hist.toFixed(3)} Baissier`;

      return `**${label}:** ${trend} | RSI: ${rsiText} | MACD: ${macdText}`;
    }

    const lines = [
      `**MULTI-TIMEFRAME: ${symbol}** $${daily ? fmt(daily.closes[daily.closes.length - 1]) : "N/A"}`,
      "",
      analyzeTF("Journalier", daily),
      analyzeTF("Hebdo", weekly),
      analyzeTF("Mensuel", monthly),
    ];

    // Convergence check
    let bullCount = 0;
    let bearCount = 0;
    for (const d of [daily, weekly, monthly]) {
      if (!d || d.closes.length < 20) continue;
      const n = d.closes.length;
      const e = ema(d.closes, 20);
      if (d.closes[n - 1] > e[n - 1]) bullCount++; else bearCount++;
    }

    if (bullCount === 3) {
      lines.push("", "\u{1F7E2} **CONVERGENCE HAUSSIÈRE** — Tous les timeframes alignés UP");
    } else if (bearCount === 3) {
      lines.push("", "\u{1F534} **CONVERGENCE BAISSIÈRE** — Tous les timeframes alignés DOWN");
    } else {
      lines.push("", "\u26A0\uFE0F **DIVERGENCE** — Timeframes non alignés, prudence");
    }

    return lines.join("\n");
  },
});

// ── trading.compare ──

registerSkill({
  name: "trading.compare",
  description: "Compare technical indicators of multiple stocks side by side.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      symbols: { type: "string", description: "Comma-separated tickers (e.g. IONQ,RGTI,QUBT)" },
    },
    required: ["symbols"],
  },
  async execute(args): Promise<string> {
    const symbols = (args.symbols as string).split(",").map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 10);
    if (symbols.length < 2) return "Minimum 2 symboles requis.";

    const results = await Promise.all(symbols.map(async s => {
      const data = await fetchOHLCV(s);
      if (!data || data.closes.length < 26) return null;
      const n = data.closes.length;
      const price = data.closes[n - 1];
      const prevClose = data.closes[n - 2];
      const rsiVals = rsi(data.closes);
      const macdR = macd(data.closes);
      const atrVals = atr(data.highs, data.lows, data.closes);
      const ema20 = ema(data.closes, 20);
      const avgVol = data.volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;

      return {
        symbol: s,
        price,
        changePct: ((price - prevClose) / prevClose) * 100,
        rsi: rsiVals[n - 1],
        macdHist: macdR.histogram[n - 1],
        atr: atrVals[n - 1],
        atrPct: atrVals[n - 1] ? (atrVals[n - 1] / price) * 100 : NaN,
        trend: price > ema20[n - 1] ? "UP" : "DOWN",
        rVol: avgVol > 0 ? data.volumes[n - 1] / avgVol : 1,
      };
    }));

    const valid = results.filter(r => r !== null) as Exclude<typeof results[0], null>[];
    if (valid.length < 2) return "Données insuffisantes pour la comparaison.";

    const lines = [`**COMPARAISON TECHNIQUE** (${valid.length} stocks)\n`];
    lines.push("Ticker | Prix | Var% | RSI | MACD | ATR% | Trend | RVOL");
    lines.push("---|---|---|---|---|---|---|---");

    for (const r of valid) {
      const rsiEmoji = r.rsi < 30 ? "\u{1F7E2}" : r.rsi > 70 ? "\u{1F534}" : "\u26AA";
      lines.push(
        `${r.symbol} | $${fmt(r.price)} | ${r.changePct >= 0 ? "+" : ""}${fmt(r.changePct)}% | ${rsiEmoji}${fmt(r.rsi, 0)} | ${fmt(r.macdHist, 3)} | ${fmt(r.atrPct)}% | ${r.trend} | ${fmt(r.rVol, 1)}x`
      );
    }

    // Best pick
    const best = valid.reduce((a, b) => {
      const scoreA = (a.rsi < 40 ? 2 : 0) + (a.macdHist > 0 ? 1 : 0) + (a.trend === "UP" ? 1 : 0);
      const scoreB = (b.rsi < 40 ? 2 : 0) + (b.macdHist > 0 ? 1 : 0) + (b.trend === "UP" ? 1 : 0);
      return scoreB > scoreA ? b : a;
    });
    lines.push("", `\u{1F3AF} **Meilleur candidat:** ${best.symbol} (RSI: ${fmt(best.rsi, 0)}, Trend: ${best.trend})`);

    return lines.join("\n");
  },
});

log.info("[trading-advanced] Technical analysis skills loaded (trading.technical, trading.multi_tf, trading.compare)");
