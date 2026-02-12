/**
 * Built-in skills: invoice.add, invoice.scan_email, invoice.summary
 * Invoice/Receipt Scanner — track expenses, categorize, monthly reports.
 * Inspired by OpenClaw: email scan → PDF extraction → categorization → monthly summary.
 */
import { registerSkill, getSkill } from "../loader.js";
import { getDb } from "../../storage/store.js";
import { config } from "../../config/env.js";
import { log } from "../../utils/log.js";

const CATEGORIES = ["software", "hosting", "marketing", "office", "food", "transport", "services", "other"];

registerSkill({
  name: "invoice.add",
  description: "Manually add an invoice/receipt to the tracker.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      vendor: { type: "string", description: "Vendor/company name" },
      amount: { type: "number", description: "Amount" },
      currency: { type: "string", description: "Currency (default: CAD)" },
      category: { type: "string", description: "Category: software, hosting, marketing, office, food, transport, services, other" },
      date: { type: "string", description: "Invoice date YYYY-MM-DD (default: today)" },
      notes: { type: "string", description: "Additional notes" },
    },
    required: ["vendor", "amount"],
  },
  async execute(args): Promise<string> {
    const vendor = String(args.vendor);
    const amount = Number(args.amount);
    const currency = String(args.currency || "CAD");
    const category = String(args.category || "other");
    const date = args.date ? String(args.date) : new Date().toISOString().slice(0, 10);
    const notes = args.notes ? String(args.notes) : null;

    const d = getDb();
    const info = d.prepare(
      "INSERT INTO invoices (vendor, amount, currency, category, invoice_date, notes) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(vendor, amount, currency, category, date, notes);

    return `Facture #${info.lastInsertRowid} ajoutée: ${vendor} — ${amount} ${currency} [${category}] (${date})`;
  },
});

registerSkill({
  name: "invoice.scan_email",
  description:
    "Scan Gmail for invoices/receipts from the last N days. Extracts vendor, amount, date using Gemini. " +
    "Requires Gmail OAuth to be configured.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      days: { type: "number", description: "Lookback days (default: 7)" },
      auto_add: { type: "string", description: "Set to 'yes' to auto-add found invoices" },
    },
  },
  async execute(args): Promise<string> {
    const days = Number(args.days) || 7;
    const autoAdd = String(args.auto_add || "") === "yes";

    const gmailSearch = getSkill("gmail.search");
    if (!gmailSearch) return "Gmail non configuré. Ajoute les invoices manuellement avec invoice.add.";

    try {
      const emailResult = await gmailSearch.execute({
        query: `(invoice OR receipt OR facture OR reçu) newer_than:${days}d`,
        limit: 20,
      });

      if (!emailResult || emailResult.includes("No emails")) {
        return `Aucun email de facture trouvé (${days} derniers jours).`;
      }

      // Use Gemini to extract invoice data
      if (!config.geminiApiKey) {
        return `Emails trouvés mais Gemini nécessaire pour extraction.\n\n${emailResult.slice(0, 500)}`;
      }

      const prompt = `Extract invoice/receipt information from these emails. For each invoice found, return:
- vendor: company name
- amount: numeric amount
- currency: CAD/USD/EUR
- category: ${CATEGORIES.join("/")}
- date: YYYY-MM-DD

Emails:
${emailResult.slice(0, 4000)}

Return as JSON array: [{"vendor":"...","amount":N,"currency":"...","category":"...","date":"..."}]
Only JSON, no markdown.`;

      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${config.geminiApiKey}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 2048 },
        }),
      });

      if (!res.ok) return `Erreur Gemini (${res.status})`;
      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
      const match = text.match(/\[[\s\S]*\]/);
      if (!match) return "Aucune facture extraite.";

      const invoices = JSON.parse(match[0]) as Array<{
        vendor: string; amount: number; currency: string; category: string; date: string;
      }>;

      if (invoices.length === 0) return "Aucune facture détectée dans les emails.";

      const d = getDb();
      const lines = [`**${invoices.length} facture(s) détectée(s):**\n`];
      let added = 0;

      for (const inv of invoices) {
        lines.push(`  ${inv.vendor}: ${inv.amount} ${inv.currency} [${inv.category}] — ${inv.date}`);
        if (autoAdd) {
          d.prepare(
            "INSERT INTO invoices (vendor, amount, currency, category, invoice_date, source) VALUES (?, ?, ?, ?, ?, 'email')"
          ).run(inv.vendor, inv.amount, inv.currency || "CAD", inv.category || "other", inv.date);
          added++;
        }
      }

      if (added > 0) lines.push(`\n✅ ${added} facture(s) ajoutée(s) automatiquement.`);
      else lines.push(`\nUtilise auto_add=yes pour les ajouter automatiquement.`);

      return lines.join("\n");
    } catch (err) {
      return `Erreur scan: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

registerSkill({
  name: "invoice.summary",
  description: "Monthly expense summary: total by category, vendor breakdown, month-over-month comparison.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      month: { type: "string", description: "Month YYYY-MM (default: current month)" },
    },
  },
  async execute(args): Promise<string> {
    const now = new Date();
    const month = args.month ? String(args.month) : `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const d = getDb();

    const rows = d.prepare(
      "SELECT * FROM invoices WHERE invoice_date LIKE ? ORDER BY invoice_date, vendor"
    ).all(`${month}%`) as Array<{
      id: number; vendor: string; amount: number; currency: string; category: string; invoice_date: string;
    }>;

    if (rows.length === 0) return `Aucune facture pour ${month}.`;

    // By category
    const byCategory: Record<string, number> = {};
    const byVendor: Record<string, number> = {};
    let total = 0;

    for (const r of rows) {
      byCategory[r.category] = (byCategory[r.category] || 0) + r.amount;
      byVendor[r.vendor] = (byVendor[r.vendor] || 0) + r.amount;
      total += r.amount;
    }

    // Previous month comparison
    const prevDate = new Date(now.getFullYear(), now.getMonth() - 1);
    const prevMonth = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, "0")}`;
    const prevTotal = (d.prepare(
      "SELECT COALESCE(SUM(amount), 0) as t FROM invoices WHERE invoice_date LIKE ?"
    ).get(`${prevMonth}%`) as { t: number }).t;

    const lines = [`**Résumé des dépenses — ${month}**\n`];
    lines.push(`**Total: $${total.toFixed(2)}**`);
    if (prevTotal > 0) {
      const change = ((total - prevTotal) / prevTotal * 100).toFixed(1);
      lines.push(`Mois précédent: $${prevTotal.toFixed(2)} (${Number(change) >= 0 ? "+" : ""}${change}%)\n`);
    }

    lines.push(`**Par catégorie:**`);
    for (const [cat, amt] of Object.entries(byCategory).sort((a, b) => b[1] - a[1])) {
      const pct = Math.round(amt / total * 100);
      lines.push(`  ${cat}: $${amt.toFixed(2)} (${pct}%)`);
    }

    lines.push(`\n**Par fournisseur:**`);
    for (const [vendor, amt] of Object.entries(byVendor).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
      lines.push(`  ${vendor}: $${amt.toFixed(2)}`);
    }

    lines.push(`\n${rows.length} facture(s) ce mois.`);
    return lines.join("\n");
  },
});

log.debug("Registered 3 invoice.* skills");
