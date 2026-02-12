/**
 * Built-in skills: price.watch, price.check, price.list, price.remove
 * Price Tracker — monitor product prices, alert on drops.
 * Uses web search to check current prices periodically.
 */
import { registerSkill, getSkill } from "../loader.js";
import { getDb } from "../../storage/store.js";
import { log } from "../../utils/log.js";

registerSkill({
  name: "price.watch",
  description: "Add a product to the price watch list. Set a target price for alerts.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      product: { type: "string", description: "Product name/description" },
      url: { type: "string", description: "Product URL (optional)" },
      target_price: { type: "number", description: "Target price — alert when price drops below this" },
      current_price: { type: "number", description: "Current known price (optional)" },
      currency: { type: "string", description: "Currency (default: CAD)" },
    },
    required: ["product", "target_price"],
  },
  async execute(args): Promise<string> {
    const d = getDb();
    const product = String(args.product);
    const targetPrice = Number(args.target_price);
    const currentPrice = args.current_price ? Number(args.current_price) : null;
    const currency = String(args.currency || "CAD");
    const url = args.url ? String(args.url) : null;

    const info = d.prepare(
      `INSERT INTO price_watches (product, url, target_price, current_price, lowest_price, currency)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(product, url, targetPrice, currentPrice, currentPrice, currency);

    return (
      `Price watch #${info.lastInsertRowid} créé:\n` +
      `Produit: ${product}\n` +
      `Prix cible: ${targetPrice} ${currency}` +
      (currentPrice ? `\nPrix actuel: ${currentPrice} ${currency}` : "") +
      `\n\nAlerte quand le prix descend sous ${targetPrice} ${currency}.`
    );
  },
});

registerSkill({
  name: "price.check",
  description: "Check current prices for all watched products via web search. Updates prices and sends alerts.",
  adminOnly: true,
  argsSchema: { type: "object", properties: {} },
  async execute(): Promise<string> {
    const d = getDb();
    const watches = d.prepare(
      "SELECT * FROM price_watches WHERE enabled = 1"
    ).all() as any[];

    if (watches.length === 0) return "Aucun produit surveillé. Utilise price.watch.";

    const webSearch = getSkill("web.search");
    if (!webSearch) return "web.search non disponible — impossible de vérifier les prix.";

    const lines = [`**Price Check — ${watches.length} produit(s)**\n`];
    let alertCount = 0;

    for (const w of watches) {
      try {
        const searchResult = await webSearch.execute({
          query: `${w.product} price ${w.currency}`,
        });

        // Try to extract a price from search results
        const priceMatch = String(searchResult).match(/\$\s*([\d,]+\.?\d*)/);
        if (priceMatch) {
          const foundPrice = parseFloat(priceMatch[1].replace(",", ""));
          const prevPrice = w.current_price;

          // Update price
          d.prepare(
            `UPDATE price_watches SET current_price = ?, lowest_price = MIN(COALESCE(lowest_price, ?), ?),
             last_checked_at = unixepoch() WHERE id = ?`
          ).run(foundPrice, foundPrice, foundPrice, w.id);

          const change = prevPrice ? ((foundPrice - prevPrice) / prevPrice * 100).toFixed(1) : null;
          const icon = foundPrice <= w.target_price ? "🟢" : "🔴";

          lines.push(
            `${icon} **${w.product}**: ${foundPrice} ${w.currency}` +
            (change ? ` (${Number(change) >= 0 ? "+" : ""}${change}%)` : "") +
            ` | Cible: ${w.target_price} ${w.currency}`
          );

          if (foundPrice <= w.target_price && !w.alert_sent) {
            alertCount++;
            d.prepare("UPDATE price_watches SET alert_sent = 1 WHERE id = ?").run(w.id);
            lines.push(`  🎯 **ALERTE: Prix sous la cible!**`);
          }
        } else {
          lines.push(`⚪ ${w.product}: prix non trouvé dans la recherche`);
          d.prepare("UPDATE price_watches SET last_checked_at = unixepoch() WHERE id = ?").run(w.id);
        }
      } catch (err) {
        lines.push(`⚪ ${w.product}: erreur de recherche`);
      }
    }

    if (alertCount > 0) {
      lines.push(`\n🎯 **${alertCount} alerte(s) de prix!**`);
    }

    return lines.join("\n");
  },
});

registerSkill({
  name: "price.list",
  description: "List all price watches with current status.",
  adminOnly: true,
  argsSchema: { type: "object", properties: {} },
  async execute(): Promise<string> {
    const d = getDb();
    const watches = d.prepare(
      "SELECT * FROM price_watches ORDER BY enabled DESC, product"
    ).all() as any[];

    if (watches.length === 0) return "Aucun produit surveillé.";

    return watches.map(w => {
      const lastCheck = w.last_checked_at
        ? new Date(w.last_checked_at * 1000).toLocaleDateString("fr-CA")
        : "jamais";
      const icon = w.enabled ? (w.current_price && w.current_price <= w.target_price ? "🟢" : "🔵") : "⚪";
      return (
        `${icon} **#${w.id} ${w.product}**${w.enabled ? "" : " (désactivé)"}\n` +
        `  Actuel: ${w.current_price || "?"} ${w.currency} | Cible: ${w.target_price} ${w.currency}` +
        (w.lowest_price ? ` | Min: ${w.lowest_price}` : "") +
        `\n  Vérifié: ${lastCheck}`
      );
    }).join("\n\n");
  },
});

registerSkill({
  name: "price.remove",
  description: "Remove or disable a price watch.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      id: { type: "number", description: "Price watch ID" },
      disable: { type: "string", description: "Set to 'yes' to disable instead of delete" },
    },
    required: ["id"],
  },
  async execute(args): Promise<string> {
    const d = getDb();
    if (args.disable === "yes") {
      d.prepare("UPDATE price_watches SET enabled = 0 WHERE id = ?").run(args.id as number);
      return `Price watch #${args.id} désactivé.`;
    }
    d.prepare("DELETE FROM price_watches WHERE id = ?").run(args.id as number);
    return `Price watch #${args.id} supprimé.`;
  },
});

log.debug("Registered 4 price.* skills");
