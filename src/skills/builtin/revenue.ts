/**
 * Built-in skills: revenue.track, revenue.invoice, revenue.pipeline, revenue.report
 * Revenue tracking and financial management for autonomous business operations.
 */
import { registerSkill } from "../loader.js";
import { getDb } from "../../storage/store.js";

interface RevenueRow {
  id: number;
  source: string;
  amount: number;
  currency: string;
  type: string;
  status: string;
  description: string | null;
  due_date: number | null;
  created_at: number;
}

registerSkill({
  name: "revenue.track",
  description:
    "Record a revenue entry (income, expense, or invoice). Use for all financial tracking.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      source: { type: "string", description: "Client name or source of revenue" },
      amount: { type: "number", description: "Amount (positive for income, negative for expense)" },
      type: { type: "string", description: "Type: income, expense, or invoice (default: income)" },
      description: { type: "string", description: "Description of the transaction" },
      currency: { type: "string", description: "Currency code (default: CAD)" },
      status: { type: "string", description: "Status: recorded, pending, paid, overdue (default: recorded)" },
    },
    required: ["source", "amount"],
  },
  async execute(args): Promise<string> {
    const source = String(args.source);
    const amount = args.amount as number;
    const type = String(args.type || "income");
    const description = args.description ? String(args.description) : null;
    const currency = String(args.currency || "CAD");
    const status = String(args.status || "recorded");

    const d = getDb();
    const info = d
      .prepare(
        "INSERT INTO revenue (source, amount, currency, type, status, description) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(source, amount, currency, type, status, description);

    return `Revenue #${info.lastInsertRowid}: ${type} ${amount >= 0 ? "+" : ""}${amount} ${currency} from ${source} [${status}]`;
  },
});

registerSkill({
  name: "revenue.invoice",
  description:
    "Create an invoice entry with due date. Generates formatted invoice text.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      client: { type: "string", description: "Client name" },
      items: { type: "string", description: 'JSON array of {description, amount}, e.g. [{"description":"Web dev","amount":500}]' },
      due_days: { type: "number", description: "Days until due (default: 30)" },
      currency: { type: "string", description: "Currency (default: CAD)" },
    },
    required: ["client", "items"],
  },
  async execute(args): Promise<string> {
    const client = String(args.client);
    const currency = String(args.currency || "CAD");
    const dueDays = (args.due_days as number) || 30;

    let items: Array<{ description: string; amount: number }>;
    try {
      items = JSON.parse(String(args.items));
      if (!Array.isArray(items)) throw new Error("not array");
    } catch {
      return 'Error: items must be a JSON array of {description, amount}.';
    }

    const total = items.reduce((sum, item) => sum + (item.amount || 0), 0);
    const dueDate = Math.floor(Date.now() / 1000) + dueDays * 86400;

    const d = getDb();
    const info = d
      .prepare(
        "INSERT INTO revenue (source, amount, currency, type, status, description, due_date) VALUES (?, ?, ?, 'invoice', 'pending', ?, ?)",
      )
      .run(
        client,
        total,
        currency,
        items.map((i) => `${i.description}: ${i.amount} ${currency}`).join("; "),
        dueDate,
      );

    const dueDateStr = new Date(dueDate * 1000).toLocaleDateString("fr-CA", {
      timeZone: "America/Toronto",
    });

    let invoice = `**FACTURE #${info.lastInsertRowid}**\n`;
    invoice += `Client: ${client}\n`;
    invoice += `Date: ${new Date().toLocaleDateString("fr-CA", { timeZone: "America/Toronto" })}\n`;
    invoice += `Échéance: ${dueDateStr}\n\n`;
    invoice += `| Description | Montant |\n|---|---|\n`;
    for (const item of items) {
      invoice += `| ${item.description} | ${item.amount} ${currency} |\n`;
    }
    invoice += `\n**Total: ${total} ${currency}**`;

    return invoice;
  },
});

registerSkill({
  name: "revenue.pipeline",
  description:
    "Show the sales pipeline: pending invoices, recent income, and summary by status.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      days: { type: "number", description: "Lookback period in days (default: 30)" },
    },
  },
  async execute(args): Promise<string> {
    const days = (args.days as number) || 30;
    const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
    const d = getDb();

    // Pending invoices
    const pending = d
      .prepare(
        "SELECT * FROM revenue WHERE type = 'invoice' AND status IN ('pending', 'overdue') ORDER BY due_date ASC",
      )
      .all() as RevenueRow[];

    // Summary by type
    const summary = d
      .prepare(
        `SELECT type, status, COUNT(*) as count, SUM(amount) as total, currency
         FROM revenue WHERE created_at > ? GROUP BY type, status, currency ORDER BY type`,
      )
      .all(cutoff) as Array<{
      type: string;
      status: string;
      count: number;
      total: number;
      currency: string;
    }>;

    // Total income vs expenses
    const totals = d
      .prepare(
        `SELECT type, SUM(amount) as total, currency FROM revenue
         WHERE created_at > ? GROUP BY type, currency`,
      )
      .all(cutoff) as Array<{ type: string; total: number; currency: string }>;

    let output = `**Pipeline — ${days} derniers jours**\n\n`;

    // Pending invoices
    if (pending.length > 0) {
      output += `**Factures en attente (${pending.length}):**\n`;
      for (const inv of pending) {
        const due = inv.due_date
          ? new Date(inv.due_date * 1000).toLocaleDateString("fr-CA", { timeZone: "America/Toronto" })
          : "N/A";
        const overdue = inv.due_date && inv.due_date < Date.now() / 1000 ? " ⚠️ EN RETARD" : "";
        output += `  #${inv.id} ${inv.source}: ${inv.amount} ${inv.currency} — échéance ${due}${overdue}\n`;
      }
      output += "\n";
    }

    // Totals
    if (totals.length > 0) {
      output += "**Totaux:**\n";
      for (const t of totals) {
        output += `  ${t.type}: ${t.total >= 0 ? "+" : ""}${t.total} ${t.currency}\n`;
      }
      const net = totals.reduce((sum, t) => {
        if (t.type === "expense") return sum - Math.abs(t.total);
        return sum + t.total;
      }, 0);
      output += `  **Net: ${net >= 0 ? "+" : ""}${net.toFixed(2)} CAD**\n\n`;
    }

    // Summary breakdown
    if (summary.length > 0) {
      output += "**Détail:**\n";
      for (const s of summary) {
        output += `  ${s.type} [${s.status}]: ${s.count} entrée(s), ${s.total} ${s.currency}\n`;
      }
    }

    if (totals.length === 0 && pending.length === 0) {
      output += "Aucune donnée financière pour cette période.";
    }

    return output;
  },
});

registerSkill({
  name: "revenue.report",
  description:
    "Generate a financial report for a given period (daily, weekly, monthly).",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      period: { type: "string", description: "Period: day, week, month (default: month)" },
    },
  },
  async execute(args): Promise<string> {
    const period = String(args.period || "month");
    const daysMap: Record<string, number> = { day: 1, week: 7, month: 30 };
    const days = daysMap[period] || 30;
    const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
    const d = getDb();

    const rows = d
      .prepare("SELECT * FROM revenue WHERE created_at > ? ORDER BY created_at DESC")
      .all(cutoff) as RevenueRow[];

    if (rows.length === 0) {
      return `Aucune transaction dans les ${days} derniers jours.`;
    }

    let income = 0;
    let expenses = 0;
    let invoiced = 0;

    for (const r of rows) {
      if (r.type === "income") income += r.amount;
      else if (r.type === "expense") expenses += Math.abs(r.amount);
      else if (r.type === "invoice") invoiced += r.amount;
    }

    let report = `**Rapport financier — ${days} jours**\n\n`;
    report += `Revenus: +${income.toFixed(2)} CAD\n`;
    report += `Dépenses: -${expenses.toFixed(2)} CAD\n`;
    report += `Facturé: ${invoiced.toFixed(2)} CAD\n`;
    report += `**Profit net: ${(income - expenses).toFixed(2)} CAD**\n\n`;

    report += `**Dernières transactions (${Math.min(rows.length, 10)}):**\n`;
    for (const r of rows.slice(0, 10)) {
      const date = new Date(r.created_at * 1000).toLocaleDateString("fr-CA", {
        timeZone: "America/Toronto",
      });
      const sign = r.type === "expense" ? "-" : "+";
      report += `  ${date} | ${sign}${Math.abs(r.amount)} ${r.currency} | ${r.source} | ${r.description || ""}\n`;
    }

    return report;
  },
});
