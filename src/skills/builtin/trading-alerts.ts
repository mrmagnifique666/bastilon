/**
 * Trading Price Alerts & Auto-Exit System
 *
 * Skills: trading.alert, trading.alerts, trading.auto_exit
 *
 * - Price target alerts (above/below threshold)
 * - Trailing stop alerts
 * - Auto-exit with configurable SL/TP per position
 * - Checks run via cron every 60 seconds during market hours
 */
import { registerSkill } from "../loader.js";
import { log } from "../../utils/log.js";

// ── Types ──

interface PriceAlert {
  id: number;
  symbol: string;
  condition: "above" | "below";
  targetPrice: number;
  createdAt: number;
  triggered: boolean;
  note: string;
}

interface AutoExit {
  symbol: string;
  stopLoss: number;        // absolute price
  takeProfit: number;      // absolute price
  trailingPct: number;     // trailing stop %, 0 = disabled
  highWatermark: number;   // track peak price for trailing
  active: boolean;
  createdAt: number;
}

// ── State ──

let nextAlertId = 1;
const alerts: PriceAlert[] = [];
const autoExits: Record<string, AutoExit> = {};

// ── Helpers ──

const PAPER_URL = "https://paper-api.alpaca.markets";
const YF_URL = "https://query1.finance.yahoo.com/v8/finance/chart";

function getHeaders(): Record<string, string> {
  return {
    "APCA-API-KEY-ID": process.env.ALPACA_API_KEY || "",
    "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY || "",
    "Content-Type": "application/json",
  };
}

// Buffer alerts for daily digest instead of sending immediately
const alertEventBuffer: string[] = [];

async function sendTelegramAlert(text: string): Promise<void> {
  alertEventBuffer.push(`[${new Date().toLocaleTimeString("en-US", { timeZone: "America/Toronto", hour12: false })}] ${text}`);
  log.info(`[trading-alerts] Alert buffered (${alertEventBuffer.length} total)`);
}

/** Get and clear buffered alert events — called by noon digest */
export function flushAlertEventBuffer(): string[] {
  const copy = [...alertEventBuffer];
  alertEventBuffer.length = 0;
  return copy;
}

async function getQuickPrice(symbol: string): Promise<number | null> {
  try {
    const resp = await fetch(`${YF_URL}/${symbol}?interval=1d&range=1d`, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(6000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data?.chart?.result?.[0]?.meta?.regularMarketPrice ?? null;
  } catch { return null; }
}

async function sellPosition(symbol: string, qty: number): Promise<boolean> {
  try {
    const resp = await fetch(`${PAPER_URL}/v2/orders`, {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify({
        symbol, qty: String(qty), side: "sell", type: "market", time_in_force: "day",
      }),
      signal: AbortSignal.timeout(10000),
    });
    return resp.ok;
  } catch { return false; }
}

function fmt(n: number, d = 2): string {
  return n.toFixed(d);
}

// ── trading.alert ──

registerSkill({
  name: "trading.alert",
  description: "Set a price alert. Get notified via Telegram when a stock hits your target price.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      symbol: { type: "string", description: "Stock ticker (e.g. IONQ)" },
      condition: { type: "string", description: "'above' or 'below' (default: above)" },
      price: { type: "number", description: "Target price to trigger alert" },
      note: { type: "string", description: "Note/reason for this alert" },
    },
    required: ["symbol", "price"],
  },
  async execute(args): Promise<string> {
    const symbol = (args.symbol as string).toUpperCase();
    const condition = ((args.condition as string) || "above").toLowerCase() as "above" | "below";
    const targetPrice = Number(args.price);
    const note = (args.note as string) || "";

    if (isNaN(targetPrice) || targetPrice <= 0) return "Prix invalide.";

    const currentPrice = await getQuickPrice(symbol);
    const alert: PriceAlert = {
      id: nextAlertId++,
      symbol,
      condition,
      targetPrice,
      createdAt: Date.now(),
      triggered: false,
      note,
    };

    alerts.push(alert);
    return `\u{1F514} Alerte #${alert.id} créée: ${symbol} ${condition === "above" ? ">" : "<"} $${fmt(targetPrice)}${currentPrice ? ` (actuellement $${fmt(currentPrice)})` : ""}${note ? `\nNote: ${note}` : ""}`;
  },
});

// ── trading.alerts ──

registerSkill({
  name: "trading.alerts",
  description: "List all active price alerts. Delete alerts by ID.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      delete: { type: "number", description: "Alert ID to delete" },
      clear: { type: "string", description: "Set to 'all' to clear all alerts" },
    },
  },
  async execute(args): Promise<string> {
    if (args.clear === "all") {
      const count = alerts.length;
      alerts.length = 0;
      return `\u2705 ${count} alertes supprimées.`;
    }

    if (args.delete) {
      const id = Number(args.delete);
      const idx = alerts.findIndex(a => a.id === id);
      if (idx === -1) return `Alerte #${id} non trouvée.`;
      alerts.splice(idx, 1);
      return `\u2705 Alerte #${id} supprimée.`;
    }

    const active = alerts.filter(a => !a.triggered);
    if (active.length === 0) return "Aucune alerte active.";

    const lines = [`\u{1F514} **Alertes actives (${active.length})**\n`];
    for (const a of active) {
      const currentPrice = await getQuickPrice(a.symbol);
      const dist = currentPrice ? ` (actuel: $${fmt(currentPrice)}, distance: ${fmt(Math.abs(currentPrice - a.targetPrice) / currentPrice * 100)}%)` : "";
      lines.push(`#${a.id} ${a.symbol} ${a.condition === "above" ? "\u2191" : "\u2193"} $${fmt(a.targetPrice)}${dist}${a.note ? ` — ${a.note}` : ""}`);
    }

    return lines.join("\n");
  },
});

// ── trading.auto_exit ──

registerSkill({
  name: "trading.auto_exit",
  description: "Set automatic stop-loss, take-profit, and trailing stop for a position. Auto-sells when triggered.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      symbol: { type: "string", description: "Stock ticker (e.g. DKNG)" },
      stop_loss: { type: "number", description: "Stop-loss price (absolute, e.g. 20.00)" },
      take_profit: { type: "number", description: "Take-profit price (absolute, e.g. 25.00)" },
      trailing_pct: { type: "number", description: "Trailing stop % (e.g. 3 = sell if drops 3% from peak). 0 = disabled." },
      action: { type: "string", description: "'set' (default), 'remove', 'list'" },
    },
  },
  async execute(args): Promise<string> {
    const action = ((args.action as string) || "set").toLowerCase();

    if (action === "list") {
      const keys = Object.keys(autoExits);
      if (keys.length === 0) return "Aucun auto-exit configuré.";

      const lines = [`\u{1F6E1}\uFE0F **Auto-Exits actifs (${keys.length})**\n`];
      for (const sym of keys) {
        const e = autoExits[sym];
        if (!e.active) continue;
        const currentPrice = await getQuickPrice(sym);
        const cp = currentPrice ? `$${fmt(currentPrice)}` : "?";
        lines.push(
          `**${sym}** (prix: ${cp})`,
          `  SL: $${fmt(e.stopLoss)} | TP: $${fmt(e.takeProfit)}${e.trailingPct > 0 ? ` | Trailing: ${fmt(e.trailingPct, 1)}% (peak: $${fmt(e.highWatermark)})` : ""}`,
          ""
        );
      }
      return lines.join("\n");
    }

    if (action === "remove") {
      const symbol = (args.symbol as string)?.toUpperCase();
      if (!symbol) return "Symbole requis.";
      if (!autoExits[symbol]) return `Aucun auto-exit pour ${symbol}.`;
      delete autoExits[symbol];
      return `\u2705 Auto-exit retiré pour ${symbol}.`;
    }

    // Set
    const symbol = (args.symbol as string)?.toUpperCase();
    if (!symbol) return "Symbole requis.";

    const stopLoss = Number(args.stop_loss) || 0;
    const takeProfit = Number(args.take_profit) || 0;
    const trailingPct = Number(args.trailing_pct) || 0;

    if (stopLoss <= 0 && takeProfit <= 0 && trailingPct <= 0) {
      return "Au moins un paramètre requis: stop_loss, take_profit, ou trailing_pct.";
    }

    const currentPrice = await getQuickPrice(symbol);

    autoExits[symbol] = {
      symbol,
      stopLoss,
      takeProfit,
      trailingPct,
      highWatermark: currentPrice || 0,
      active: true,
      createdAt: Date.now(),
    };

    const parts = [];
    if (stopLoss > 0) parts.push(`SL: $${fmt(stopLoss)}`);
    if (takeProfit > 0) parts.push(`TP: $${fmt(takeProfit)}`);
    if (trailingPct > 0) parts.push(`Trailing: ${fmt(trailingPct, 1)}%`);

    return `\u{1F6E1}\uFE0F Auto-exit configuré pour ${symbol}: ${parts.join(" | ")}${currentPrice ? ` (prix actuel: $${fmt(currentPrice)})` : ""}`;
  },
});

// ── trading.alert_check ──

registerSkill({
  name: "trading.alert_check",
  description: "Check all alerts and auto-exits. Called by cron every 60 seconds during market hours. Triggers Telegram notifications.",
  adminOnly: true,
  argsSchema: { type: "object", properties: {} },
  async execute(): Promise<string> {
    const results: string[] = [];

    // 1. Check price alerts
    const activeAlerts = alerts.filter(a => !a.triggered);
    for (const alert of activeAlerts) {
      try {
        const price = await getQuickPrice(alert.symbol);
        if (!price) continue;

        let triggered = false;
        if (alert.condition === "above" && price >= alert.targetPrice) triggered = true;
        if (alert.condition === "below" && price <= alert.targetPrice) triggered = true;

        if (triggered) {
          alert.triggered = true;
          const msg = `\u{1F6A8} **ALERTE PRIX DÉCLENCHÉE**\n${alert.symbol} est ${alert.condition === "above" ? "au-dessus" : "en-dessous"} de $${fmt(alert.targetPrice)}\nPrix actuel: $${fmt(price)}${alert.note ? `\nNote: ${alert.note}` : ""}`;
          results.push(msg);
          sendTelegramAlert(msg).catch(() => {});
        }
      } catch { /* skip */ }
    }

    // 2. Check auto-exits
    for (const [symbol, exit] of Object.entries(autoExits)) {
      if (!exit.active) continue;
      try {
        const price = await getQuickPrice(symbol);
        if (!price) continue;

        // Update high watermark
        if (price > exit.highWatermark) {
          exit.highWatermark = price;
        }

        let reason = "";

        // Stop-loss
        if (exit.stopLoss > 0 && price <= exit.stopLoss) {
          reason = `STOP-LOSS $${fmt(exit.stopLoss)}`;
        }
        // Take-profit
        else if (exit.takeProfit > 0 && price >= exit.takeProfit) {
          reason = `TAKE-PROFIT $${fmt(exit.takeProfit)}`;
        }
        // Trailing stop
        else if (exit.trailingPct > 0 && exit.highWatermark > 0) {
          const trailingStop = exit.highWatermark * (1 - exit.trailingPct / 100);
          if (price <= trailingStop) {
            reason = `TRAILING STOP -${fmt(exit.trailingPct, 1)}% (peak: $${fmt(exit.highWatermark)}, trigger: $${fmt(trailingStop)})`;
          }
        }

        if (reason) {
          // Try to sell the position
          let sold = false;
          try {
            const posResp = await fetch(`${PAPER_URL}/v2/positions/${symbol}`, {
              headers: getHeaders(), signal: AbortSignal.timeout(8000),
            });
            if (posResp.ok) {
              const pos = await posResp.json();
              const qty = parseFloat(pos.qty);
              if (qty > 0) {
                sold = await sellPosition(symbol, qty);
              }
            }
          } catch { /* no position to sell */ }

          exit.active = false;
          const msg = `\u{1F6A8} **AUTO-EXIT: ${symbol}**\nRaison: ${reason}\nPrix: $${fmt(price)}\n${sold ? "\u2705 Position vendue" : "\u26A0\uFE0F Vente non exécutée (pas de position?)"}`;
          results.push(msg);
          sendTelegramAlert(msg).catch(() => {});
        }
      } catch { /* skip */ }
    }

    // Clean triggered alerts older than 24h
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (let i = alerts.length - 1; i >= 0; i--) {
      if (alerts[i].triggered && alerts[i].createdAt < cutoff) {
        alerts.splice(i, 1);
      }
    }

    if (results.length === 0) {
      const activeCount = alerts.filter(a => !a.triggered).length;
      const exitCount = Object.values(autoExits).filter(e => e.active).length;
      return `[alert_check] OK — ${activeCount} alertes, ${exitCount} auto-exits actifs.`;
    }

    return results.join("\n\n");
  },
});

log.info("[trading-alerts] Price alerts & auto-exit skills loaded (trading.alert, trading.alerts, trading.auto_exit, trading.alert_check)");
