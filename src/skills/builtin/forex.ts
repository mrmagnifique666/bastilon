/**
 * ExchangeRate API skills — free forex rates.
 * API: https://open.er-api.com — free, no key needed.
 * Skills: forex.rates, forex.convert
 */
import { registerSkill } from "../loader.js";

const BASE_URL = "https://open.er-api.com/v6/latest";

interface ExchangeRateResponse {
  result: string;
  base_code: string;
  rates: Record<string, number>;
  time_last_update_utc: string;
}

registerSkill({
  name: "forex.rates",
  description: "Get current exchange rates. Free, no API key needed. Uses open.er-api.com.",
  argsSchema: {
    type: "object",
    properties: {
      base: { type: "string", description: "Base currency (default: CAD)" },
      targets: { type: "string", description: "Comma-separated target currencies (default: USD,EUR,GBP,BTC)" },
    },
  },
  async execute(args): Promise<string> {
    const base = String(args.base || "CAD").toUpperCase();
    const targets = String(args.targets || "USD,EUR,GBP,JPY,CHF")
      .toUpperCase()
      .split(",")
      .map((s) => s.trim());

    try {
      const res = await fetch(`${BASE_URL}/${base}`, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) return `ExchangeRate API error: ${res.status}`;

      const data = (await res.json()) as ExchangeRateResponse;
      if (data.result !== "success") return `API error: ${data.result}`;

      const lines = targets
        .filter((t) => data.rates[t] !== undefined)
        .map((t) => `  ${base}/${t}: ${data.rates[t].toFixed(4)}`);

      if (lines.length === 0) return `No rates found for: ${targets.join(", ")}`;

      const updated = data.time_last_update_utc?.split(" ").slice(0, 4).join(" ") || "unknown";
      return `**Taux de change (${base})**\n${lines.join("\n")}\n\nMis à jour: ${updated}`;
    } catch (err) {
      return `Forex error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

registerSkill({
  name: "forex.convert",
  description: "Convert an amount between currencies.",
  argsSchema: {
    type: "object",
    properties: {
      amount: { type: "number", description: "Amount to convert" },
      from: { type: "string", description: "Source currency (e.g. CAD)" },
      to: { type: "string", description: "Target currency (e.g. USD)" },
    },
    required: ["amount", "from", "to"],
  },
  async execute(args): Promise<string> {
    const amount = Number(args.amount);
    const from = String(args.from).toUpperCase();
    const to = String(args.to).toUpperCase();

    if (isNaN(amount) || amount <= 0) return "Montant invalide.";

    try {
      const res = await fetch(`${BASE_URL}/${from}`, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) return `ExchangeRate API error: ${res.status}`;

      const data = (await res.json()) as ExchangeRateResponse;
      if (!data.rates) return `API error: rates not available for ${from}`;
      const rate = data.rates[to];
      if (rate === undefined) return `Devise inconnue: ${to}`;

      const result = amount * rate;
      return `${amount.toFixed(2)} ${from} = **${result.toFixed(2)} ${to}** (taux: ${rate.toFixed(4)})`;
    } catch (err) {
      return `Conversion error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});
