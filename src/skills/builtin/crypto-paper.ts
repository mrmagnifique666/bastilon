/**
 * Crypto Paper Trading — Simulated crypto trading with real-time prices.
 * $10K starting balance, tracks positions, P&L, journal entries.
 * Uses CoinGecko free API for real prices. Zero cost.
 */
import { registerSkill, getSkill } from "../loader.js";
import { getDb } from "../../storage/store.js";
import { log } from "../../utils/log.js";

// ── Helpers ──

async function fetchPrice(coinId: string): Promise<number> {
  const skill = getSkill("crypto.price");
  if (!skill) throw new Error("crypto.price skill not available");
  const result = await skill.execute({ coins: coinId });
  // Parse "$XX,XXX.XX USD" from the result
  const match = result.match(/\$([0-9,]+\.?\d*)\s*USD/);
  if (!match) throw new Error(`Could not parse price for ${coinId}: ${result}`);
  return parseFloat(match[1].replace(/,/g, ""));
}

function ensureAccount(): { id: number; balance: number; initial_balance: number } {
  const d = getDb();
  let acc = d.prepare("SELECT * FROM crypto_paper_account WHERE id = 1").get() as any;
  if (!acc) {
    d.prepare("INSERT INTO crypto_paper_account (id, balance, initial_balance) VALUES (1, 10000.0, 10000.0)").run();
    acc = { id: 1, balance: 10000.0, initial_balance: 10000.0 };
  }
  return acc;
}

function getOpenPositions(): any[] {
  const d = getDb();
  return d.prepare("SELECT * FROM crypto_paper_positions WHERE status = 'open' ORDER BY opened_at DESC").all();
}

function fmt(n: number, decimals = 2): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function fmtPnl(pnl: number): string {
  const sign = pnl >= 0 ? "+" : "";
  return `${sign}$${fmt(pnl)}`;
}

// ── Skills ──

registerSkill({
  name: "crypto_paper.init",
  description: "Initialize crypto paper trading account with $10,000 starting balance. Resets if called again.",
  argsSchema: {
    type: "object",
    properties: {
      reset: { type: "boolean", description: "If true, reset account to $10K (deletes all positions/trades)" },
    },
  },
  async execute(args): Promise<string> {
    const d = getDb();
    if (args.reset) {
      d.prepare("DELETE FROM crypto_paper_trades").run();
      d.prepare("DELETE FROM crypto_paper_positions").run();
      d.prepare("DELETE FROM crypto_paper_journal").run();
      d.prepare("DELETE FROM crypto_paper_account").run();
    }
    const acc = ensureAccount();
    return `💰 Crypto Paper Trading Account\nBalance: $${fmt(acc.balance)}\nInitial: $${fmt(acc.initial_balance)}\nStatus: Ready`;
  },
});

registerSkill({
  name: "crypto_paper.account",
  description: "Show crypto paper trading account: cash balance, open positions with real-time P&L, total portfolio value.",
  argsSchema: { type: "object", properties: {} },
  async execute(): Promise<string> {
    const acc = ensureAccount();
    const positions = getOpenPositions();
    let positionsValue = 0;
    const posLines: string[] = [];

    for (const pos of positions) {
      try {
        const price = await fetchPrice(pos.symbol);
        const value = pos.quantity * price;
        const pnl = value - (pos.quantity * pos.avg_price);
        const pnlPct = ((price / pos.avg_price) - 1) * 100;
        positionsValue += value;
        posLines.push(
          `  ${pos.symbol.toUpperCase()}: ${fmt(pos.quantity, 6)} @ $${fmt(pos.avg_price)} → $${fmt(price)} | ${fmtPnl(pnl)} (${pnl >= 0 ? "+" : ""}${fmt(pnlPct)}%)`
        );
      } catch {
        positionsValue += pos.quantity * pos.avg_price;
        posLines.push(`  ${pos.symbol.toUpperCase()}: ${fmt(pos.quantity, 6)} @ $${fmt(pos.avg_price)} (prix indisponible)`);
      }
    }

    const total = acc.balance + positionsValue;
    const totalPnl = total - acc.initial_balance;
    const totalPnlPct = ((total / acc.initial_balance) - 1) * 100;

    return [
      `💰 Paper Trading Account`,
      `Cash: $${fmt(acc.balance)}`,
      `Positions (${positions.length}): $${fmt(positionsValue)}`,
      `Total: $${fmt(total)} | ${fmtPnl(totalPnl)} (${totalPnl >= 0 ? "+" : ""}${fmt(totalPnlPct)}%)`,
      positions.length ? `\n📊 Open Positions:\n${posLines.join("\n")}` : "\nAucune position ouverte.",
    ].join("\n");
  },
});

registerSkill({
  name: "crypto_paper.buy",
  description: "Buy cryptocurrency (paper trade). Fetches real-time price, validates cash & limits. Reasoning required.",
  argsSchema: {
    type: "object",
    properties: {
      symbol: { type: "string", description: "CoinGecko coin ID (e.g. 'bitcoin', 'ethereum', 'solana')" },
      amount: { type: "number", description: "USD amount to invest (max $3000 per position)" },
      reasoning: { type: "string", description: "Why are you buying? (required for journal)" },
    },
    required: ["symbol", "amount", "reasoning"],
  },
  async execute(args): Promise<string> {
    const symbol = (args.symbol as string).toLowerCase().trim();
    const amount = Number(args.amount);
    const reasoning = String(args.reasoning || "").trim();

    if (!reasoning) return "❌ Reasoning is required for every trade.";
    if (amount <= 0) return "❌ Amount must be positive.";
    if (amount > 3000) return "❌ Max $3,000 per position. Risk management!";

    const d = getDb();
    const acc = ensureAccount();

    if (acc.balance < amount) return `❌ Insufficient cash. Available: $${fmt(acc.balance)}, needed: $${fmt(amount)}`;

    const openPositions = getOpenPositions();
    const existingPos = openPositions.find((p: any) => p.symbol === symbol);
    if (!existingPos && openPositions.length >= 3) {
      return `❌ Max 3 positions simultanées. Ferme une position avant d'en ouvrir une nouvelle.\nPositions: ${openPositions.map((p: any) => p.symbol.toUpperCase()).join(", ")}`;
    }

    const price = await fetchPrice(symbol);
    const quantity = amount / price;

    // Record trade
    d.prepare(
      "INSERT INTO crypto_paper_trades (symbol, side, quantity, price, total, reasoning) VALUES (?, 'buy', ?, ?, ?, ?)"
    ).run(symbol, quantity, price, amount, reasoning);

    // Update or create position
    if (existingPos) {
      const newQty = existingPos.quantity + quantity;
      const newAvg = ((existingPos.avg_price * existingPos.quantity) + (price * quantity)) / newQty;
      d.prepare(
        "UPDATE crypto_paper_positions SET quantity = ?, avg_price = ?, current_price = ?, updated_at = unixepoch() WHERE id = ?"
      ).run(newQty, newAvg, price, existingPos.id);
    } else {
      d.prepare(
        "INSERT INTO crypto_paper_positions (symbol, quantity, avg_price, current_price, status) VALUES (?, ?, ?, ?, 'open')"
      ).run(symbol, quantity, price, price);
    }

    // Deduct cash
    d.prepare("UPDATE crypto_paper_account SET balance = balance - ?, updated_at = unixepoch() WHERE id = 1").run(amount);

    log.info(`[crypto_paper] BUY ${fmt(quantity, 6)} ${symbol.toUpperCase()} @ $${fmt(price)} = $${fmt(amount)}`);

    return `🟢 ACHAT ${symbol.toUpperCase()}\nQuantité: ${fmt(quantity, 6)}\nPrix: $${fmt(price)}\nTotal: $${fmt(amount)}\nCash restant: $${fmt(acc.balance - amount)}\nRaison: ${reasoning}`;
  },
});

registerSkill({
  name: "crypto_paper.sell",
  description: "Sell cryptocurrency (paper trade). Specify quantity or 'all' to close entire position.",
  argsSchema: {
    type: "object",
    properties: {
      symbol: { type: "string", description: "CoinGecko coin ID" },
      quantity: { type: "string", description: "Amount to sell (number or 'all' for entire position)" },
      reasoning: { type: "string", description: "Why are you selling? (required)" },
    },
    required: ["symbol", "reasoning"],
  },
  async execute(args): Promise<string> {
    const symbol = (args.symbol as string).toLowerCase().trim();
    const reasoning = String(args.reasoning || "").trim();
    if (!reasoning) return "❌ Reasoning is required for every trade.";

    const d = getDb();
    const pos = d.prepare("SELECT * FROM crypto_paper_positions WHERE symbol = ? AND status = 'open'").get(symbol) as any;
    if (!pos) return `❌ Aucune position ouverte pour ${symbol.toUpperCase()}.`;

    const sellAll = !args.quantity || String(args.quantity).toLowerCase() === "all";
    const qty = sellAll ? pos.quantity : Math.min(Number(args.quantity), pos.quantity);
    if (qty <= 0) return "❌ Quantity must be positive.";

    const price = await fetchPrice(symbol);
    const proceeds = qty * price;
    const costBasis = qty * pos.avg_price;
    const pnl = proceeds - costBasis;
    const pnlPct = ((price / pos.avg_price) - 1) * 100;

    // Record trade
    d.prepare(
      "INSERT INTO crypto_paper_trades (symbol, side, quantity, price, total, reasoning) VALUES (?, 'sell', ?, ?, ?, ?)"
    ).run(symbol, qty, price, proceeds, reasoning);

    // Update position
    const remaining = pos.quantity - qty;
    if (remaining < 0.000001) {
      d.prepare(
        "UPDATE crypto_paper_positions SET quantity = 0, current_price = ?, pnl = ?, pnl_percent = ?, status = 'closed', updated_at = unixepoch() WHERE id = ?"
      ).run(price, pnl, pnlPct, pos.id);
    } else {
      d.prepare(
        "UPDATE crypto_paper_positions SET quantity = ?, current_price = ?, updated_at = unixepoch() WHERE id = ?"
      ).run(remaining, price, pos.id);
    }

    // Add cash
    d.prepare("UPDATE crypto_paper_account SET balance = balance + ?, updated_at = unixepoch() WHERE id = 1").run(proceeds);

    const emoji = pnl >= 0 ? "🟢" : "🔴";
    log.info(`[crypto_paper] SELL ${fmt(qty, 6)} ${symbol.toUpperCase()} @ $${fmt(price)} = $${fmt(proceeds)} | P&L: ${fmtPnl(pnl)}`);

    return `${emoji} VENTE ${symbol.toUpperCase()}\nQuantité: ${fmt(qty, 6)}\nPrix: $${fmt(price)}\nProceeds: $${fmt(proceeds)}\nP&L: ${fmtPnl(pnl)} (${pnl >= 0 ? "+" : ""}${fmt(pnlPct)}%)\nRaison: ${reasoning}`;
  },
});

registerSkill({
  name: "crypto_paper.close",
  description: "Close entire position for a given cryptocurrency (sells all).",
  argsSchema: {
    type: "object",
    properties: {
      symbol: { type: "string", description: "CoinGecko coin ID to close" },
      reasoning: { type: "string", description: "Why closing?" },
    },
    required: ["symbol", "reasoning"],
  },
  async execute(args): Promise<string> {
    const skill = getSkill("crypto_paper.sell");
    if (!skill) return "❌ crypto_paper.sell not available";
    return skill.execute({ symbol: args.symbol, quantity: "all", reasoning: args.reasoning });
  },
});

registerSkill({
  name: "crypto_paper.positions",
  description: "Show all open crypto paper positions with real-time P&L.",
  argsSchema: { type: "object", properties: {} },
  async execute(): Promise<string> {
    const positions = getOpenPositions();
    if (positions.length === 0) return "Aucune position ouverte.";

    const lines: string[] = ["📊 Positions ouvertes:"];
    let totalPnl = 0;

    for (const pos of positions) {
      try {
        const price = await fetchPrice(pos.symbol);
        const value = pos.quantity * price;
        const pnl = value - (pos.quantity * pos.avg_price);
        const pnlPct = ((price / pos.avg_price) - 1) * 100;
        totalPnl += pnl;
        const emoji = pnl >= 0 ? "🟢" : "🔴";
        lines.push(
          `${emoji} ${pos.symbol.toUpperCase()}: ${fmt(pos.quantity, 6)} × $${fmt(price)} = $${fmt(value)} | ${fmtPnl(pnl)} (${pnl >= 0 ? "+" : ""}${fmt(pnlPct)}%)`
        );
      } catch {
        lines.push(`⚪ ${pos.symbol.toUpperCase()}: ${fmt(pos.quantity, 6)} @ $${fmt(pos.avg_price)} (prix indisponible)`);
      }
    }

    lines.push(`\nP&L total positions: ${fmtPnl(totalPnl)}`);
    return lines.join("\n");
  },
});

registerSkill({
  name: "crypto_paper.scan",
  description: "Scan crypto market for paper trading opportunities: high volatility, high volume coins.",
  argsSchema: {
    type: "object",
    properties: {
      limit: { type: "number", description: "Number of coins to scan (default 15)" },
    },
  },
  async execute(args): Promise<string> {
    const skill = getSkill("crypto.markets");
    if (!skill) return "❌ crypto.markets not available";

    const limit = Number(args.limit) || 15;
    const raw = await skill.execute({ limit });

    // Also get our open positions for context
    const positions = getOpenPositions();
    const posSymbols = positions.map(p => p.symbol);

    const lines: string[] = ["🔍 Scan Crypto — Opportunités Paper Trading\n"];
    lines.push(raw);

    if (positions.length > 0) {
      lines.push(`\n📍 Positions actuelles: ${posSymbols.map(s => s.toUpperCase()).join(", ")}`);
    }
    lines.push(`\n💡 Slots dispo: ${3 - positions.length}/3`);

    return lines.join("\n");
  },
});

registerSkill({
  name: "crypto_paper.journal",
  description: "Add a journal entry for a trade or general market observation.",
  argsSchema: {
    type: "object",
    properties: {
      trade_id: { type: "number", description: "Optional trade ID to link to" },
      reasoning: { type: "string", description: "Your reasoning, observation, or lesson" },
      outcome: { type: "string", description: "success, failure, or pending" },
      lesson: { type: "string", description: "Lesson learned from this trade" },
    },
    required: ["reasoning"],
  },
  async execute(args): Promise<string> {
    const d = getDb();
    d.prepare(
      "INSERT INTO crypto_paper_journal (trade_id, reasoning, outcome, lesson) VALUES (?, ?, ?, ?)"
    ).run(
      args.trade_id || null,
      String(args.reasoning),
      args.outcome || "pending",
      args.lesson || null
    );
    return `📝 Journal entry added.${args.lesson ? ` Lesson: ${args.lesson}` : ""}`;
  },
});

registerSkill({
  name: "crypto_paper.pnl",
  description: "Show P&L summary for crypto paper trading. Period: today, week, month, or all.",
  argsSchema: {
    type: "object",
    properties: {
      period: { type: "string", description: "today, week, month, or all (default: all)" },
    },
  },
  async execute(args): Promise<string> {
    const d = getDb();
    const acc = ensureAccount();
    const period = String(args.period || "all").toLowerCase();

    let since = 0;
    const now = Math.floor(Date.now() / 1000);
    if (period === "today") since = now - 86400;
    else if (period === "week") since = now - 604800;
    else if (period === "month") since = now - 2592000;

    const trades = d.prepare(
      "SELECT * FROM crypto_paper_trades WHERE executed_at >= ? ORDER BY executed_at DESC"
    ).all(since) as any[];

    const buys = trades.filter(t => t.side === "buy");
    const sells = trades.filter(t => t.side === "sell");

    // Calculate realized P&L from sells
    let realizedPnl = 0;
    for (const sell of sells) {
      // Find matching buy avg price from positions history
      const closedPos = d.prepare(
        "SELECT * FROM crypto_paper_positions WHERE symbol = ? AND status = 'closed' ORDER BY updated_at DESC LIMIT 1"
      ).get(sell.symbol) as any;
      if (closedPos) {
        realizedPnl += closedPos.pnl || 0;
      }
    }

    // Unrealized P&L from open positions
    let unrealizedPnl = 0;
    const openPos = getOpenPositions();
    for (const pos of openPos) {
      try {
        const price = await fetchPrice(pos.symbol);
        unrealizedPnl += (price - pos.avg_price) * pos.quantity;
      } catch { /* skip */ }
    }

    const totalPnl = (acc.balance + openPos.reduce((s, p) => {
      try { return s + p.quantity * (p.current_price || p.avg_price); } catch { return s; }
    }, 0)) - acc.initial_balance;

    const winTrades = sells.filter(t => {
      const pos = d.prepare("SELECT pnl FROM crypto_paper_positions WHERE symbol = ? AND status = 'closed' ORDER BY updated_at DESC LIMIT 1").get(t.symbol) as any;
      return pos && pos.pnl > 0;
    });

    const winRate = sells.length > 0 ? ((winTrades.length / sells.length) * 100).toFixed(0) : "N/A";

    // Best and worst trades
    const closedPositions = d.prepare(
      "SELECT * FROM crypto_paper_positions WHERE status = 'closed' ORDER BY pnl DESC"
    ).all() as any[];
    const best = closedPositions[0];
    const worst = closedPositions[closedPositions.length - 1];

    return [
      `📈 P&L Summary (${period})`,
      `━━━━━━━━━━━━━━━━━━━━━`,
      `Total trades: ${trades.length} (${buys.length} buys, ${sells.length} sells)`,
      `Win rate: ${winRate}%`,
      `Realized P&L: ${fmtPnl(realizedPnl)}`,
      `Unrealized P&L: ${fmtPnl(unrealizedPnl)}`,
      `Total P&L: ${fmtPnl(totalPnl)} (${((totalPnl / acc.initial_balance) * 100).toFixed(2)}%)`,
      `Cash: $${fmt(acc.balance)} / Initial: $${fmt(acc.initial_balance)}`,
      best ? `Best trade: ${best.symbol.toUpperCase()} ${fmtPnl(best.pnl)}` : "",
      worst && worst.pnl < 0 ? `Worst trade: ${worst.symbol.toUpperCase()} ${fmtPnl(worst.pnl)}` : "",
    ].filter(Boolean).join("\n");
  },
});
