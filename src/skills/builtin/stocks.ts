/**
 * Built-in skill: stocks.price
 * Yahoo Finance free endpoint — no key needed.
 */
import { registerSkill } from "../loader.js";

registerSkill({
  name: "stocks.price",
  description:
    "Get current stock price and stats for one or more tickers (e.g. PLTR, AAPL, TSLA).",
  argsSchema: {
    type: "object",
    properties: {
      symbols: {
        type: "string",
        description: "Comma-separated stock tickers (e.g. 'PLTR,AAPL,TSLA')",
      },
    },
    required: ["symbols"],
  },
  async execute(args): Promise<string> {
    const symbols = (args.symbols as string)
      .toUpperCase()
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const results: string[] = [];

    for (const sym of symbols.slice(0, 10)) {
      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=5d`;
        const resp = await fetch(url, {
          headers: { "User-Agent": "Mozilla/5.0" },
        });
        if (!resp.ok) {
          results.push(`${sym}: Error ${resp.status}`);
          continue;
        }
        const data = await resp.json();
        const meta = data?.chart?.result?.[0]?.meta;
        if (!meta) {
          results.push(`${sym}: No data found`);
          continue;
        }

        const price = meta.regularMarketPrice?.toFixed(2);
        const prevClose = meta.chartPreviousClose || meta.previousClose;
        const change = prevClose ? (meta.regularMarketPrice - prevClose).toFixed(2) : "?";
        const changePct = prevClose
          ? (((meta.regularMarketPrice - prevClose) / prevClose) * 100).toFixed(2)
          : "?";
        const arrow = Number(change) >= 0 ? "+" : "";
        const currency = meta.currency || "USD";

        results.push(
          `${sym}: $${price} ${currency} (${arrow}${change} / ${arrow}${changePct}%)`
        );
      } catch (err) {
        results.push(`${sym}: ${err instanceof Error ? err.message : "Error"}`);
      }
    }

    return results.join("\n") || "No results.";
  },
});
