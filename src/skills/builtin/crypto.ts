/**
 * Built-in skills: crypto.price, crypto.markets
 * Free CoinGecko API — no key needed.
 */
import { registerSkill } from "../loader.js";

const CG = "https://api.coingecko.com/api/v3";

async function cgFetch(path: string): Promise<any> {
  const resp = await fetch(`${CG}${path}`, {
    headers: { Accept: "application/json" },
  });
  if (!resp.ok) throw new Error(`CoinGecko ${resp.status}: ${resp.statusText}`);
  return resp.json();
}

registerSkill({
  name: "crypto.price",
  description:
    "Get current price of one or more cryptocurrencies (e.g. bitcoin, ethereum, solana). Returns price in USD and CAD.",
  argsSchema: {
    type: "object",
    properties: {
      coins: {
        type: "string",
        description:
          "Comma-separated CoinGecko IDs (e.g. 'bitcoin,ethereum,solana')",
      },
    },
    required: ["coins"],
  },
  async execute(args): Promise<string> {
    const coins = (args.coins as string).toLowerCase().trim();
    const data = await cgFetch(
      `/simple/price?ids=${encodeURIComponent(coins)}&vs_currencies=usd,cad&include_24hr_change=true&include_market_cap=true`
    );

    const lines: string[] = [];
    for (const [id, info] of Object.entries(data) as [string, any][]) {
      const usd = info.usd?.toLocaleString("en-US", { maximumFractionDigits: 2 });
      const cad = info.cad?.toLocaleString("en-CA", { maximumFractionDigits: 2 });
      const change = info.usd_24h_change?.toFixed(2);
      const mcap = info.usd_market_cap
        ? `$${(info.usd_market_cap / 1e9).toFixed(2)}B`
        : "?";
      const arrow = Number(change) >= 0 ? "+" : "";
      lines.push(
        `${id.toUpperCase()}: $${usd} USD / $${cad} CAD (${arrow}${change}% 24h) — MCap: ${mcap}`
      );
    }
    return lines.join("\n") || "No data found. Check coin IDs (use CoinGecko IDs like 'bitcoin', 'ethereum').";
  },
});

registerSkill({
  name: "crypto.markets",
  description:
    "Get top cryptocurrencies by market cap with price, change, and volume.",
  argsSchema: {
    type: "object",
    properties: {
      limit: {
        type: "number",
        description: "Number of coins to show (default 10, max 50)",
      },
    },
  },
  async execute(args): Promise<string> {
    const limit = Math.min(Number(args.limit) || 10, 50);
    const data = await cgFetch(
      `/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${limit}&page=1&sparkline=false`
    );

    if (!Array.isArray(data) || data.length === 0) return "No market data available.";

    return data
      .map((c: any, i: number) => {
        const price = c.current_price?.toLocaleString("en-US", { maximumFractionDigits: 2 });
        const change = c.price_change_percentage_24h?.toFixed(2) || "?";
        const arrow = Number(change) >= 0 ? "+" : "";
        const vol = c.total_volume ? `$${(c.total_volume / 1e9).toFixed(1)}B` : "?";
        return `${i + 1}. ${c.symbol?.toUpperCase()} — $${price} (${arrow}${change}%) Vol: ${vol}`;
      })
      .join("\n");
  },
});
