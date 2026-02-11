/**
 * Built-in skills: printful.store, printful.stores, printful.products, printful.product,
 * printful.delete_product, printful.create_product,
 * printful.orders, printful.order, printful.create_order, printful.shipping_rates,
 * printful.catalog
 * Uses Printful REST API via fetch (no SDK dependency).
 */
import { registerSkill } from "../loader.js";
import { config } from "../../config/env.js";
import { log } from "../../utils/log.js";

const API = "https://api.printful.com";

function checkConfig(): string | null {
  if (!config.printfulApiToken) return "Printful not configured. Set PRINTFUL_API_TOKEN in .env";
  return null;
}

async function printfulFetch(method: string, path: string, body?: unknown): Promise<any> {
  const opts: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${config.printfulApiToken}`,
      "Content-Type": "application/json",
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const resp = await fetch(`${API}${path}`, opts);
  const data = await resp.json();
  if (!resp.ok) throw new Error(`Printful ${resp.status}: ${data.result || JSON.stringify(data)}`);
  return data.result;
}

registerSkill({
  name: "printful.store",
  description: "Get Printful store info — name, type, currency, created date",
  adminOnly: true,
  argsSchema: { type: "object", properties: {} },
  async execute(): Promise<string> {
    const err = checkConfig();
    if (err) return err;
    try {
      const store = await printfulFetch("GET", "/store");
      return `Store: ${store.name} (id: ${store.id})\nType: ${store.type}\nCurrency: ${store.currency}\nCreated: ${store.created}`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

registerSkill({
  name: "printful.products",
  description: "List sync products in the store",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      limit: { type: "number", description: "Max results (default 20)" },
      offset: { type: "number", description: "Offset for pagination (default 0)" },
    },
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;
    try {
      const limit = Math.min(Number(args.limit) || 20, 100);
      const offset = Number(args.offset) || 0;
      const products = await printfulFetch("GET", `/store/products?limit=${limit}&offset=${offset}`);
      if (!products?.length) return "No products in store.";
      const lines = products.map((p: any) =>
        `[${p.id}] ${p.name} — ${p.variants} variant(s) — synced: ${p.synced}`
      );
      return `Products (${products.length}):\n${lines.join("\n")}`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

registerSkill({
  name: "printful.product",
  description: "Get details of a specific sync product by ID",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      id: { type: "number", description: "Sync product ID" },
    },
    required: ["id"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;
    try {
      const data = await printfulFetch("GET", `/store/products/${args.id}`);
      const p = data.sync_product;
      const variants = data.sync_variants || [];
      const lines = [
        `Product: ${p.name} (id: ${p.id})`,
        `Thumbnail: ${p.thumbnail_url || "none"}`,
        `Variants (${variants.length}):`,
      ];
      for (const v of variants.slice(0, 10)) {
        lines.push(`  [${v.id}] ${v.name} — retail: ${v.retail_price} ${v.currency}`);
      }
      if (variants.length > 10) lines.push(`  ... and ${variants.length - 10} more`);
      return lines.join("\n");
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

registerSkill({
  name: "printful.catalog",
  description: "Browse Printful product catalog — list available product types",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      category: { type: "string", description: "Filter by category (e.g. T-shirts, Hats, Posters)" },
    },
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;
    try {
      const products = await printfulFetch("GET", "/products");
      let filtered = products;
      if (args.category) {
        const cat = String(args.category).toLowerCase();
        filtered = products.filter((p: any) =>
          p.type?.toLowerCase().includes(cat) || p.title?.toLowerCase().includes(cat)
        );
      }
      if (!filtered?.length) return "No catalog products found.";
      const lines = filtered.slice(0, 30).map((p: any) =>
        `[${p.id}] ${p.title} — ${p.type} — ${p.variant_count} variants`
      );
      return `Catalog (${filtered.length} products):\n${lines.join("\n")}${filtered.length > 30 ? `\n... and ${filtered.length - 30} more` : ""}`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

registerSkill({
  name: "printful.orders",
  description: "List orders from the store",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      status: { type: "string", description: "Filter by status: draft|pending|failed|canceled|inprocess|onhold|partial|fulfilled" },
      limit: { type: "number", description: "Max results (default 20)" },
    },
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;
    try {
      const limit = Math.min(Number(args.limit) || 20, 100);
      let path = `/orders?limit=${limit}`;
      if (args.status) path += `&status=${args.status}`;
      const orders = await printfulFetch("GET", path);
      if (!orders?.length) return "No orders found.";
      const lines = orders.map((o: any) =>
        `[${o.id}] #${o.external_id || "N/A"} — ${o.status} — ${o.items?.length || 0} items — ${o.retail_costs?.total || "?"} ${o.retail_costs?.currency || ""}`
      );
      return `Orders (${orders.length}):\n${lines.join("\n")}`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

registerSkill({
  name: "printful.order",
  description: "Get details of a specific order by ID",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      id: { type: "number", description: "Order ID" },
    },
    required: ["id"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;
    try {
      const o = await printfulFetch("GET", `/orders/${args.id}`);
      const lines = [
        `Order #${o.id} — Status: ${o.status}`,
        `Created: ${o.created}`,
        `Recipient: ${o.recipient?.name || "N/A"} — ${o.recipient?.city || ""}, ${o.recipient?.country_code || ""}`,
        `Items (${o.items?.length || 0}):`,
      ];
      for (const item of (o.items || [])) {
        lines.push(`  ${item.name} x${item.quantity} — retail: ${item.retail_price} ${item.currency}`);
      }
      if (o.retail_costs) {
        lines.push(`\nCosts: subtotal ${o.retail_costs.subtotal}, shipping ${o.retail_costs.shipping}, tax ${o.retail_costs.tax}, total ${o.retail_costs.total} ${o.retail_costs.currency}`);
      }
      if (o.shipments?.length) {
        for (const s of o.shipments) {
          lines.push(`Shipment: ${s.carrier} ${s.service} — tracking: ${s.tracking_number || "pending"}`);
        }
      }
      return lines.join("\n");
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

registerSkill({
  name: "printful.create_order",
  description: "Create a new order (draft or for fulfillment)",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      recipient_name: { type: "string", description: "Recipient full name" },
      address1: { type: "string", description: "Street address" },
      city: { type: "string", description: "City" },
      state_code: { type: "string", description: "State/province code (e.g. QC, ON)" },
      country_code: { type: "string", description: "Country code (e.g. CA, US)" },
      zip: { type: "string", description: "Postal/ZIP code" },
      items: { type: "string", description: "JSON array of items: [{sync_variant_id, quantity}]" },
      confirm: { type: "boolean", description: "Submit for fulfillment immediately (default false = draft)" },
    },
    required: ["recipient_name", "address1", "city", "country_code", "zip", "items"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;
    try {
      let items: Array<{ sync_variant_id: number; quantity: number }>;
      try {
        items = JSON.parse(String(args.items));
      } catch {
        return "Error: items must be a valid JSON array, e.g. [{\"sync_variant_id\":123,\"quantity\":1}]";
      }

      const order = {
        recipient: {
          name: String(args.recipient_name),
          address1: String(args.address1),
          city: String(args.city),
          state_code: args.state_code ? String(args.state_code) : undefined,
          country_code: String(args.country_code),
          zip: String(args.zip),
        },
        items: items.map(i => ({ sync_variant_id: i.sync_variant_id, quantity: i.quantity })),
      };

      const confirm = args.confirm === true;
      const data = await printfulFetch("POST", `/orders${confirm ? "?confirm=true" : ""}`, order);
      return `Order created: id=${data.id} status=${data.status} items=${data.items?.length || 0}${confirm ? " (submitted for fulfillment)" : " (draft)"}`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

registerSkill({
  name: "printful.shipping_rates",
  description: "Estimate shipping rates for an order",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      address1: { type: "string", description: "Recipient street address" },
      city: { type: "string", description: "City" },
      country_code: { type: "string", description: "Country code (e.g. CA, US)" },
      state_code: { type: "string", description: "State/province code" },
      zip: { type: "string", description: "Postal/ZIP code" },
      items: { type: "string", description: "JSON array: [{variant_id, quantity}] (catalog variant IDs)" },
    },
    required: ["country_code", "items"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;
    try {
      let items: Array<{ variant_id: number; quantity: number }>;
      try {
        items = JSON.parse(String(args.items));
      } catch {
        return "Error: items must be a valid JSON array";
      }

      const body = {
        recipient: {
          address1: args.address1 ? String(args.address1) : undefined,
          city: args.city ? String(args.city) : undefined,
          country_code: String(args.country_code),
          state_code: args.state_code ? String(args.state_code) : undefined,
          zip: args.zip ? String(args.zip) : undefined,
        },
        items,
      };

      const rates = await printfulFetch("POST", "/shipping/rates", body);
      if (!rates?.length) return "No shipping rates available for this destination.";
      const lines = rates.map((r: any) =>
        `${r.name} (${r.id}): $${r.rate} ${r.currency} — ${r.minDeliveryDays}-${r.maxDeliveryDays} days`
      );
      return `Shipping rates:\n${lines.join("\n")}`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

// --- New skills: stores, delete_product, create_product ---

registerSkill({
  name: "printful.stores",
  description: "List all Printful stores accessible with the current API token",
  adminOnly: true,
  argsSchema: { type: "object", properties: {} },
  async execute(): Promise<string> {
    const err = checkConfig();
    if (err) return err;
    try {
      const stores = await printfulFetch("GET", "/stores");
      if (!stores?.length) return "No stores found.";
      const lines = stores.map((s: any) =>
        `[${s.id}] ${s.name} — type: ${s.type}`
      );
      return `Stores (${stores.length}):\n${lines.join("\n")}`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

registerSkill({
  name: "printful.delete_product",
  description: "Delete a sync product from the store by ID",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      id: { type: "number", description: "Sync product ID to delete" },
    },
    required: ["id"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;
    try {
      await printfulFetch("DELETE", `/store/products/${args.id}`);
      return `Product ${args.id} deleted successfully.`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

registerSkill({
  name: "printful.create_product",
  description: "Create a new sync product with variants. Requires a public image URL.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Product name" },
      image_url: { type: "string", description: "Public URL of the design image (PNG/JPG)" },
      variant_ids: { type: "string", description: "Comma-separated catalog variant IDs (default: 4016,4017,4018,4019 for Bella+Canvas 3001 S-XL)" },
      price: { type: "string", description: "Retail price per variant (default: 29.99)" },
    },
    required: ["name", "image_url"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;
    try {
      const name = String(args.name);
      const imageUrl = String(args.image_url);
      const price = String(args.price || "29.99");
      const variantIds = args.variant_ids
        ? String(args.variant_ids).split(",").map(Number)
        : [4016, 4017, 4018, 4019]; // Bella+Canvas 3001 Black S-XL

      const productData = {
        sync_product: { name, thumbnail: imageUrl },
        sync_variants: variantIds.map((vid: number) => ({
          variant_id: vid,
          retail_price: price,
          files: [{ url: imageUrl, type: "front" }],
        })),
      };

      const result = await printfulFetch("POST", "/store/products", productData);
      return `Product created: id=${result.id} name="${name}" variants=${variantIds.length}`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

log.debug("Registered 11 printful.* skills");
