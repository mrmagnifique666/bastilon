/**
 * Built-in skills: market.overview, market.movers, market.earnings, market.report
 * Daily Alpha Report pipeline — free Yahoo Finance data + Claude analysis.
 */
import { registerSkill } from "../loader.js";
import { log } from "../../utils/log.js";

const YF = "https://query1.finance.yahoo.com/v8/finance/chart";
const UA = { "User-Agent": "Mozilla/5.0" };

// ── Helpers ──

interface QuoteData {
  symbol: string;
  price: number;
  prevClose: number;
  change: number;
  changePct: number;
  high: number;
  low: number;
  volume: number;
  avgVolume?: number;
  ma20?: number;
  ma50?: number;
  ma200?: number;
  rsi14?: number;
}

async function getQuote(symbol: string, range = "1d"): Promise<QuoteData | null> {
  try {
    const resp = await fetch(`${YF}/${symbol}?interval=1d&range=${range}`, { headers: UA });
    if (!resp.ok) return null;
    const data = await resp.json();
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta) return null;

    const price = meta.regularMarketPrice;
    const prevClose = meta.chartPreviousClose || meta.previousClose || price;
    return {
      symbol: symbol.toUpperCase(),
      price,
      prevClose,
      change: price - prevClose,
      changePct: ((price - prevClose) / prevClose) * 100,
      high: meta.regularMarketDayHigh || price,
      low: meta.regularMarketDayLow || price,
      volume: meta.regularMarketVolume || 0,
    };
  } catch {
    return null;
  }
}

async function getHistorical(symbol: string, days: number): Promise<number[]> {
  try {
    const resp = await fetch(`${YF}/${symbol}?interval=1d&range=${days > 100 ? "1y" : "6mo"}`, { headers: UA });
    if (!resp.ok) return [];
    const data = await resp.json();
    const closes = data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close;
    return (closes || []).filter((c: any) => c != null);
  } catch {
    return [];
  }
}

function calcMA(prices: number[], period: number): number | undefined {
  if (prices.length < period) return undefined;
  const slice = prices.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function calcRSI(prices: number[], period = 14): number | undefined {
  if (prices.length < period + 1) return undefined;
  const changes = [];
  for (let i = prices.length - period - 1; i < prices.length - 1; i++) {
    changes.push(prices[i + 1] - prices[i]);
  }
  let gains = 0, losses = 0;
  for (const c of changes) {
    if (c > 0) gains += c;
    else losses -= c;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

async function getEnrichedQuote(symbol: string): Promise<QuoteData | null> {
  const quote = await getQuote(symbol);
  if (!quote) return null;

  const prices = await getHistorical(symbol, 220);
  if (prices.length > 0) {
    quote.ma20 = calcMA(prices, 20);
    quote.ma50 = calcMA(prices, 50);
    quote.ma200 = calcMA(prices, 200);
    quote.rsi14 = calcRSI(prices);
  }

  // Get average volume
  try {
    const resp = await fetch(
      `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${symbol}?modules=summaryDetail`,
      { headers: UA }
    );
    if (resp.ok) {
      const data = await resp.json();
      const detail = data?.quoteSummary?.result?.[0]?.summaryDetail;
      quote.avgVolume = detail?.averageVolume?.raw || detail?.averageDailyVolume10Day?.raw;
    }
  } catch { /* */ }

  return quote;
}

function fmt(n: number | undefined, dec = 2): string {
  if (n === undefined || n === null) return "N/A";
  return n.toFixed(dec);
}

function arrow(n: number): string {
  return n >= 0 ? "+" : "";
}

function rvol(vol: number, avg: number | undefined): string {
  if (!avg || avg === 0) return "N/A";
  return `${((vol / avg) * 100).toFixed(0)}%`;
}

// ── market.overview ──

registerSkill({
  name: "market.overview",
  description:
    "Market overview: SPY, QQQ, DIA, VIX, sector ETFs with price, change, MAs, RSI. Full macro snapshot.",
  argsSchema: { type: "object", properties: {} },
  async execute(): Promise<string> {
    const indices = ["SPY", "QQQ", "DIA", "IWM"];
    const sectors = ["XLK", "XLF", "XLE", "XLV", "XLI", "XLY", "XLP", "XLU", "XLRE", "XLC", "XLB"];
    const volatility = ["^VIX"];

    const sections: string[] = [];

    // Indices
    const indexResults = await Promise.all(indices.map(getEnrichedQuote));
    sections.push("**INDICES**");
    for (const q of indexResults) {
      if (!q) continue;
      const maInfo = [
        q.ma20 ? `MA20:${fmt(q.ma20)}` : null,
        q.ma50 ? `MA50:${fmt(q.ma50)}` : null,
        q.ma200 ? `MA200:${fmt(q.ma200)}` : null,
      ].filter(Boolean).join(" | ");
      const rsiStr = q.rsi14 ? `RSI:${fmt(q.rsi14, 0)}` : "";
      sections.push(
        `${q.symbol}: $${fmt(q.price)} (${arrow(q.changePct)}${fmt(q.changePct)}%) ${rsiStr}\n  ${maInfo}`
      );
    }

    // VIX
    const vix = await getQuote("^VIX");
    if (vix) {
      const level =
        vix.price < 15 ? "COMPLAISANCE" :
        vix.price < 20 ? "NORMAL" :
        vix.price < 25 ? "ÉLEVÉ" :
        vix.price < 30 ? "PEUR" : "PANIQUE";
      sections.push(`\n**VIX:** ${fmt(vix.price)} (${arrow(vix.changePct)}${fmt(vix.changePct)}%) — ${level}`);
    }

    // Sectors
    const sectorResults = await Promise.all(sectors.map(getQuote));
    const sortedSectors = sectorResults
      .filter((s): s is QuoteData => s !== null)
      .sort((a, b) => b.changePct - a.changePct);

    sections.push("\n**SECTEURS** (leaders → laggards)");
    for (const s of sortedSectors) {
      const bar = s.changePct > 0 ? "🟢" : s.changePct < -0.5 ? "🔴" : "⚪";
      sections.push(`${bar} ${s.symbol}: ${arrow(s.changePct)}${fmt(s.changePct)}%`);
    }

    // Market regime
    const spy = indexResults.find((q) => q?.symbol === "SPY");
    if (spy && vix) {
      const aboveMA50 = spy.ma50 ? spy.price > spy.ma50 : null;
      const regime =
        aboveMA50 && vix.price < 20 ? "🟢 BULL" :
        !aboveMA50 && vix.price > 25 ? "🔴 BEAR" : "⚪ NEUTRE";
      sections.push(`\n**RÉGIME:** ${regime}`);
    }

    return sections.join("\n");
  },
});

// ── market.movers ──

registerSkill({
  name: "market.movers",
  description:
    "Top market movers: biggest gainers and losers by % change. Scans common active tickers.",
  argsSchema: {
    type: "object",
    properties: {
      limit: { type: "number", description: "Number of movers per direction (default 10)" },
    },
  },
  async execute(args): Promise<string> {
    const limit = Math.min(Number(args.limit) || 10, 20);

    // Scan a universe of popular active stocks
    const universe = [
      "NVDA", "TSLA", "AAPL", "MSFT", "AMZN", "GOOG", "META", "AMD", "PLTR", "SOFI",
      "NIO", "RIVN", "LCID", "MARA", "RIOT", "COIN", "HOOD", "AFRM", "UPST", "RBLX",
      "SNAP", "PINS", "ROKU", "SQ", "PYPL", "SHOP", "DKNG", "PENN", "CRWD", "NET",
      "SNOW", "DDOG", "ZS", "PANW", "SMCI", "ARM", "AVGO", "MU", "INTC", "QCOM",
      "BA", "F", "GM", "XOM", "CVX", "JPM", "GS", "BAC", "WFC", "C",
      "PFE", "MRNA", "JNJ", "UNH", "LLY", "NVO", "ABBV", "BMY", "GILD", "AMGN",
      "DIS", "NFLX", "WBD", "PARA", "T", "VZ", "TMUS", "CRM", "ORCL", "NOW",
      "TER", "IONQ", "RGTI", "QUBT", "SOUN", "BBAI", "JOBY", "LUNR", "RKLB", "ACHR",
    ];

    const quotes = await Promise.all(universe.map(getQuote));
    const valid = quotes.filter((q): q is QuoteData => q !== null && q.changePct !== 0);
    valid.sort((a, b) => b.changePct - a.changePct);

    const gainers = valid.slice(0, limit);
    const losers = valid.slice(-limit).reverse();

    const lines: string[] = ["**TOP GAINERS**"];
    for (const q of gainers) {
      const vol = q.volume > 1e6 ? `${(q.volume / 1e6).toFixed(1)}M` : `${(q.volume / 1e3).toFixed(0)}K`;
      lines.push(`🟢 ${q.symbol}: $${fmt(q.price)} (+${fmt(q.changePct)}%) Vol:${vol}`);
    }

    lines.push("\n**TOP LOSERS**");
    for (const q of losers) {
      const vol = q.volume > 1e6 ? `${(q.volume / 1e6).toFixed(1)}M` : `${(q.volume / 1e3).toFixed(0)}K`;
      lines.push(`🔴 ${q.symbol}: $${fmt(q.price)} (${fmt(q.changePct)}%) Vol:${vol}`);
    }

    return lines.join("\n");
  },
});

// ── market.earnings ──

registerSkill({
  name: "market.earnings",
  description: "Get upcoming earnings calendar for today/this week.",
  argsSchema: {
    type: "object",
    properties: {},
  },
  async execute(): Promise<string> {
    // Use Yahoo Finance earnings calendar
    try {
      const now = new Date();
      const dateStr = now.toISOString().split("T")[0];
      const resp = await fetch(
        `https://finance.yahoo.com/calendar/earnings?day=${dateStr}`,
        { headers: { ...UA, Accept: "text/html" } }
      );
      if (!resp.ok) return `Error fetching earnings calendar: HTTP ${resp.status}`;

      const html = await resp.text();
      // Extract earnings from the HTML (simple pattern matching)
      const rows: string[] = [];
      const matches = html.matchAll(/data-symbol="([A-Z]+)"[^>]*>/g);
      const symbols = new Set<string>();
      for (const m of matches) {
        symbols.add(m[1]);
      }

      if (symbols.size === 0) {
        return `No earnings data found for ${dateStr}. Earnings calendar may require market hours.`;
      }

      // Get prices for earnings tickers
      const tickers = Array.from(symbols).slice(0, 20);
      const quotes = await Promise.all(tickers.map(getQuote));

      const lines = [`**Earnings Today (${dateStr}):**`];
      for (let i = 0; i < tickers.length; i++) {
        const q = quotes[i];
        if (q) {
          lines.push(`${tickers[i]}: $${fmt(q.price)} (${arrow(q.changePct)}${fmt(q.changePct)}%)`);
        } else {
          lines.push(`${tickers[i]}: price unavailable`);
        }
      }
      return lines.join("\n");
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

// ── market.report ── The main Daily Alpha Report generator

const ANALYST_PROMPT = `Tu es un analyste quantitatif elite, un CFA charterholder avec 15+ ans d'expérience en trading institutionnel. Tu combines analyse macro, analyse technique avancée et flux institutionnels. Tu NE MENS JAMAIS sur les données — si tu ne sais pas, tu dis "À vérifier pré-market". Ton objectif: fournir un rapport actionnable pour day trading US small-caps avec un budget de $2,000.

## FORMAT OBLIGATOIRE DU DAILY ALPHA REPORT

**SUJET:** 🎯 Daily Alpha Report - [DATE] | SPY [PRIX] ([+/-]%) | Régime: [BULL/BEAR/NEUTRE/RISK-OFF]

---

### SECTION 1: ANALYSE MACRO & RÉGIME DE MARCHÉ

**Indices clés:** SPY, QQQ, DIA, IWM — prix, variation, position vs MA20/MA50/MA200
**Volatilité:** VIX niveau + tendance (contango/backwardation)
**Dollar:** DXY si disponible
**Obligataire:** TNX (10Y yield) si disponible
**Sentiment:** Put/Call ratio, GEX (gamma exposure) si estimable

**Analyse des flux sectoriels:**
- Top 3 secteurs en rotation IN (flux positifs)
- Top 3 secteurs en rotation OUT (flux négatifs)
- Thème dominant du jour

**VERDICT MACRO:**
- Régime: BULL (SPY > MA50 + VIX < 20) | BEAR (SPY < MA50 + VIX > 25) | NEUTRE | RISK-OFF
- Biais directionnel: LONG / SHORT / NEUTRE
- Taille de position recommandée: FULL / 75% / 50% / CASH

---

### SECTION 2: TOP 5 OPPORTUNITÉS LONG (High Conviction)

Pour CHAQUE opportunité:
**[RANK]. [TICKER] — [NOM COMPLET]**
- Prix actuel: $XX.XX | Gap: +X.X% | RVOL: XXX%
- Catalyseur: [Earnings beat / Upgrade / Sector rotation / Technical breakout / News]
- **Setup technique:** RSI, MACD, support/résistance, pattern (cup&handle, bull flag, etc.)
- **Thesis:** Pourquoi MAINTENANT (2-3 phrases max)
- **Plan de trade:**
  - Entry: $XX.XX (breakout above / pullback to)
  - Stop-Loss: $XX.XX (-X%)
  - TP1: $XX.XX (+X%) — prendre 50%
  - TP2: $XX.XX (+X%) — trail stop
- **Conviction:** ★★★★★ (5/5) = 30% du portfolio | ★★★★☆ (4/5) = 20% | ★★★☆☆ (3/5) = 10%
- **Risk/Reward:** X:1

---

### SECTION 3: TOP 3 OPPORTUNITÉS SHORT / PUTS

Pour chaque:
- Signal de retournement (RSI divergence, break of support, death cross)
- Catalyseur négatif (downgrade, miss, sector weakness)
- Entry / Stop / Target
- Put option suggestion si applicable (strike, expiry, delta)

---

### SECTION 4: WATCH LIST — EARNINGS & ÉVÉNEMENTS

**Earnings aujourd'hui:**
- Before market: [Tickers + consensus EPS]
- After market: [Tickers + consensus EPS]

**Événements macro:**
- Fed speakers, CPI/PPI, jobs data, FOMC minutes
- Options expiry (monthly/weekly OPEX)

**Niveaux clés à surveiller:**
- SPY: support / résistance
- QQQ: support / résistance
- VIX: seuils critiques

---

### SECTION 5: STRATÉGIE D'EXÉCUTION INTRADAY

**Phase 1 — Opening Bell (9:30-10:00 ET)**
- Gap-and-go setups (gap > 3% avec volume)
- Attendre 5-10 min pour confirmation de direction
- NE PAS chaser les gaps > 8%

**Phase 2 — Morning Momentum (10:00-11:30 ET)**
- Meilleur window pour entries
- VWAP comme guide (long above, short below)
- Breakout trades avec volume confirmation

**Phase 3 — Lunch Hour (11:30-13:30 ET)**
- Réduire la taille des positions
- Attention aux faux breakouts (low volume)
- Profit-taking partiel recommandé

**Phase 4 — Afternoon (13:30-15:00 ET)**
- Reversals communs après 14:00
- Surveiller les institutions qui ajustent

**Phase 5 — Power Hour (15:00-16:00 ET)**
- Décisions de fin de journée
- Close toutes les positions intraday avant 15:55
- Pas de overnight holding sans catalyst

**Règles de risk management:**
- Max 3-5 positions simultanées
- Stop-loss OBLIGATOIRE sur chaque trade
- Max loss par trade: 2% du portfolio ($40 sur $2,000)
- Take profit partiel à +8-12%
- Pas de revenge trading après 2 losses consécutives

---

### SECTION 6: RED FLAGS & PIÈGES À ÉVITER

- **Tickers radioactifs:** [Liste avec raison — SEC investigation, dilution, pump&dump]
- **Bull traps potentiels:** [Tickers qui semblent bullish mais sont piégeux]
- **Sector overextension:** [Secteurs trop étirés, prêts pour pullback]
- **Catalyseurs négatifs à venir:** [Events qui pourraient renverser le sentiment]

---

### SECTION 7: RÉSUMÉ EXÉCUTIF (100 mots max)

**Biais du jour:** [BULLISH / BEARISH / NEUTRE]
**Top 3 convictions:**
1. [TICKER] — [Direction] — Conviction [X/5]
2. [TICKER] — [Direction] — Conviction [X/5]
3. [TICKER] — [Direction] — Conviction [X/5]
**Cash recommandé:** [X%]
**Mood du marché en un mot:** [Euphorique / Confiant / Nerveux / Panique]

---

## RÈGLES ABSOLUES:
1. JAMAIS de prix inventés — si données manquantes, marque "À vérifier pré-market"
2. Prioriser QUALITÉ sur quantité — mieux 3 setups 5/5 que 10 setups moyens
3. Adapter le ton au régime: Bullish = agressif/optimiste, Bearish = prudent/défensif
4. Tous les prix doivent venir des données fournies ci-dessous
5. Budget: $2,000 — adapter les tailles de position en conséquence
6. Focus: US small-caps et momentum stocks
7. Opinion éducative, pas conseil financier
8. Longueur totale: 1500-2000 mots MAX (concision = professionnalisme)
9. Utiliser emojis stratégiquement: 🚀 (momentum), ⚠️ (risque), 💎 (conviction), 📉 (short), 🔥 (hot pick)
10. AUCUN disclaimer légal ou avertissement "conseil financier" — ce rapport est éducatif, point final

## SOURCES DE DONNÉES À CROSS-RÉFÉRENCER (quand disponible):
- Finviz: Screener, Heatmap sectoriel, News
- TradingView: Analyse technique, Volume profile
- Benzinga: Breaking news, Earnings whispers
- Unusual Whales: Dark pool, Options flow inhabituel
- SEC Edgar: Form 4 (insider trading), 8-K (material events)
- Twitter/X: @unusual_whales, @DeItaone, @Fxhedgers (breaking news)

## EXEMPLE DE TON ATTENDU:
"Le SPY consolide à 595$ après son rally de 8% en décembre, coincé entre la résistance des 600$ et le support de la MA20 à 590$. Le VIX à 14 signale une complaisance dangereuse. Aujourd'hui, je mise sur la continuation tech avec NVDA qui teste les 145$ après des upgrades de Wedbush et Morgan Stanley. Setup 5/5."

QUALITÉ > VITESSE. Chaque mot doit compter.

Voici les données marché du jour:`;

registerSkill({
  name: "market.report",
  description:
    "Generate the full Daily Alpha Report: collects market data, analyzes with Claude, sends via Telegram. The main morning briefing.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      sendToTelegram: {
        type: "string",
        description: "Send report via telegram.send? 'yes' or 'no' (default: yes)",
      },
    },
  },
  async execute(args): Promise<string> {
    const sendTg = (args.sendToTelegram as string) !== "no";

    log.info("[market.report] Collecting market data...");

    // 1. Collect all data in parallel
    const [
      spyQ, qqqQ, diaQ, iwmQ, vixQ,
      xlkQ, xlfQ, xleQ, xlvQ, xliQ, xlyQ, xlpQ, xluQ,
    ] = await Promise.all([
      getEnrichedQuote("SPY"),
      getEnrichedQuote("QQQ"),
      getEnrichedQuote("DIA"),
      getEnrichedQuote("IWM"),
      getQuote("^VIX"),
      getQuote("XLK"), getQuote("XLF"), getQuote("XLE"), getQuote("XLV"),
      getQuote("XLI"), getQuote("XLY"), getQuote("XLP"), getQuote("XLU"),
    ]);

    // 2. Scan movers — expanded universe for better coverage
    const moverUniverse = [
      // Mega-caps & tech
      "NVDA", "TSLA", "AAPL", "MSFT", "AMZN", "GOOG", "META", "AMD", "PLTR", "SOFI",
      "CRWD", "NET", "SMCI", "ARM", "AVGO", "MU", "INTC", "QCOM",
      "CRM", "ORCL", "NOW", "NFLX", "BA", "XOM", "JPM", "GS", "LLY", "NVO",
      // Small-cap momentum (Kingston's focus)
      "IONQ", "RGTI", "QUBT", "SOUN", "BBAI", "JOBY", "LUNR", "RKLB", "ACHR",
      "MARA", "RIOT", "HOOD", "AFRM", "UPST", "RBLX",
      "NIO", "RIVN", "LCID", "DKNG", "SNAP", "SQ", "PYPL", "SHOP",
      "COIN", "HIMS", "DNA", "ASTS", "KULR", "BTBT", "HUT", "CIFR",
      "CLOV", "OPEN", "QS", "GOEV",
    ];
    const moverQuotes = await Promise.all(moverUniverse.map(getQuote));
    const movers = moverQuotes
      .filter((q): q is QuoteData => q !== null)
      .sort((a, b) => b.changePct - a.changePct);

    // 3. Build data block for Claude
    const now = new Date();
    const dateStr = now.toLocaleDateString("fr-CA", { timeZone: "America/Toronto" });
    const timeStr = now.toLocaleTimeString("fr-CA", { timeZone: "America/Toronto", timeStyle: "short" });

    const dataBlock: string[] = [`Date: ${dateStr} ${timeStr} ET\n`];

    // Indices
    dataBlock.push("=== INDICES ===");
    for (const q of [spyQ, qqqQ, diaQ, iwmQ]) {
      if (!q) continue;
      dataBlock.push(
        `${q.symbol}: $${fmt(q.price)} (${arrow(q.changePct)}${fmt(q.changePct)}%) ` +
        `H:${fmt(q.high)} L:${fmt(q.low)} Vol:${q.volume} ` +
        `MA20:${fmt(q.ma20)} MA50:${fmt(q.ma50)} MA200:${fmt(q.ma200)} RSI14:${fmt(q.rsi14, 0)}`
      );
    }

    // VIX
    if (vixQ) {
      const level = vixQ.price < 15 ? "COMPLAISANCE" : vixQ.price < 20 ? "NORMAL" :
        vixQ.price < 25 ? "ÉLEVÉ" : vixQ.price < 30 ? "PEUR" : "PANIQUE";
      dataBlock.push(`\nVIX: ${fmt(vixQ.price)} (${arrow(vixQ.changePct)}${fmt(vixQ.changePct)}%) — ${level}`);
    }

    // Sectors
    dataBlock.push("\n=== SECTEURS ===");
    const sectors = [xlkQ, xlfQ, xleQ, xlvQ, xliQ, xlyQ, xlpQ, xluQ]
      .filter((s): s is QuoteData => s !== null)
      .sort((a, b) => b.changePct - a.changePct);
    for (const s of sectors) {
      dataBlock.push(`${s.symbol}: ${arrow(s.changePct)}${fmt(s.changePct)}%`);
    }

    // Regime
    const regime =
      spyQ && vixQ && spyQ.ma50 && spyQ.price > spyQ.ma50 && vixQ.price < 20 ? "BULL" :
      spyQ && vixQ && spyQ.ma50 && spyQ.price < spyQ.ma50 && vixQ.price > 25 ? "BEAR" : "NEUTRE";
    dataBlock.push(`\nRÉGIME MARCHÉ: ${regime}`);

    // Top movers — get enriched data for top 10 gainers and losers
    const topGainers = movers.slice(0, 12);
    const topLosers = movers.slice(-8).reverse();

    // Enrich top movers with RSI/MA data
    const enrichedGainers = await Promise.all(
      topGainers.slice(0, 8).map((q) => getEnrichedQuote(q.symbol))
    );

    dataBlock.push("\n=== TOP GAINERS (with technicals) ===");
    for (const q of enrichedGainers) {
      if (!q) continue;
      const vol = q.volume > 1e6 ? `${(q.volume / 1e6).toFixed(1)}M` : `${(q.volume / 1e3).toFixed(0)}K`;
      const rvolStr = q.avgVolume ? `RVOL:${((q.volume / (q.avgVolume || 1)) * 100).toFixed(0)}%` : "";
      dataBlock.push(
        `${q.symbol}: $${fmt(q.price)} (+${fmt(q.changePct)}%) Vol:${vol} ${rvolStr} ` +
        `RSI:${fmt(q.rsi14, 0)} MA20:${fmt(q.ma20)} MA50:${fmt(q.ma50)} H:${fmt(q.high)} L:${fmt(q.low)}`
      );
    }
    // Remaining gainers without enrichment
    for (const q of topGainers.slice(8)) {
      const vol = q.volume > 1e6 ? `${(q.volume / 1e6).toFixed(1)}M` : `${(q.volume / 1e3).toFixed(0)}K`;
      dataBlock.push(`${q.symbol}: $${fmt(q.price)} (+${fmt(q.changePct)}%) Vol:${vol}`);
    }

    dataBlock.push("\n=== TOP LOSERS ===");
    for (const q of topLosers) {
      const vol = q.volume > 1e6 ? `${(q.volume / 1e6).toFixed(1)}M` : `${(q.volume / 1e3).toFixed(0)}K`;
      dataBlock.push(`${q.symbol}: $${fmt(q.price)} (${fmt(q.changePct)}%) Vol:${vol}`);
    }

    // Small-cap focus section
    const smallCaps = movers.filter((q) =>
      ["IONQ", "RGTI", "QUBT", "SOUN", "BBAI", "JOBY", "LUNR", "RKLB", "ACHR",
       "MARA", "RIOT", "HOOD", "AFRM", "UPST", "HIMS", "DNA", "ASTS", "KULR",
       "BTBT", "HUT", "CIFR", "CLOV", "OPEN", "QS", "GOEV"].includes(q.symbol)
    );
    if (smallCaps.length > 0) {
      dataBlock.push("\n=== SMALL-CAP MOMENTUM (Kingston's Focus) ===");
      for (const q of smallCaps.slice(0, 10)) {
        const vol = q.volume > 1e6 ? `${(q.volume / 1e6).toFixed(1)}M` : `${(q.volume / 1e3).toFixed(0)}K`;
        dataBlock.push(`${q.symbol}: $${fmt(q.price)} (${arrow(q.changePct)}${fmt(q.changePct)}%) Vol:${vol}`);
      }
    }

    const fullData = dataBlock.join("\n");
    log.info(`[market.report] Data collected (${fullData.length} chars). Regime: ${regime}`);

    // The report will be generated by Claude when this data is returned
    // The orchestrator will feed this + the prompt to Claude, which generates the analysis
    const report =
      `[MARKET_REPORT] Données marché collectées. Génère le Daily Alpha Report complet.\n\n` +
      `${ANALYST_PROMPT}\n\n${fullData}\n\n` +
      `Génère le rapport maintenant et envoie-le à Nicolas via telegram.send. ` +
      `Format le rapport en texte Telegram (pas de tableaux markdown complexes, utilise des listes). ` +
      `Sépare en plusieurs messages si nécessaire (max 4000 chars par message).`;

    return report;
  },
});
