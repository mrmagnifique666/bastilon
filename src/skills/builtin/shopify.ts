/**
 * Built-in skills: shopify.shop, shopify.products, shopify.product,
 * shopify.create_product, shopify.update_product, shopify.delete_product,
 * shopify.orders, shopify.order, shopify.collections, shopify.inventory
 * Uses Shopify Admin REST API (2025-01) via fetch.
 */
import { registerSkill } from "../loader.js";
import { config } from "../../config/env.js";
import { log } from "../../utils/log.js";

const API_VERSION = "2025-01";

function checkConfig(): string | null {
  if (!config.shopifyStoreDomain || !config.shopifyAccessToken) {
    return "Shopify not configured. Set SHOPIFY_STORE_DOMAIN and SHOPIFY_ACCESS_TOKEN in .env";
  }
  return null;
}

function shopifyUrl(path: string): string {
  const domain = config.shopifyStoreDomain.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return `https://${domain}/admin/api/${API_VERSION}${path}`;
}

async function shopifyFetch(method: string, path: string, body?: unknown): Promise<any> {
  const opts: RequestInit = {
    method,
    headers: {
      "X-Shopify-Access-Token": config.shopifyAccessToken,
      "Content-Type": "application/json",
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const resp = await fetch(shopifyUrl(path), opts);
  if (method === "DELETE" && resp.ok) return {};
  const data = await resp.json();
  if (!resp.ok) {
    const errMsg = data.errors ? JSON.stringify(data.errors) : JSON.stringify(data);
    throw new Error(`Shopify ${resp.status}: ${errMsg}`);
  }
  return data;
}

// --- shopify.shop ---
registerSkill({
  name: "shopify.shop",
  description: "Get Shopify store info — name, domain, plan, currency, timezone",
  adminOnly: true,
  argsSchema: { type: "object", properties: {} },
  async execute(): Promise<string> {
    const err = checkConfig();
    if (err) return err;
    try {
      const data = await shopifyFetch("GET", "/shop.json");
      const s = data.shop;
      return [
        `Store: ${s.name} (${s.myshopify_domain})`,
        `Plan: ${s.plan_display_name}`,
        `Currency: ${s.currency} | Timezone: ${s.timezone}`,
        `Email: ${s.email}`,
        `Domain: ${s.domain}`,
      ].join("\n");
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

// --- shopify.products ---
registerSkill({
  name: "shopify.products",
  description: "List products in the Shopify store",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      limit: { type: "number", description: "Max results (default 20, max 250)" },
      status: { type: "string", description: "Filter: active, draft, archived (default: any)" },
      collection_id: { type: "string", description: "Filter by collection ID" },
    },
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;
    try {
      const limit = Math.min(Number(args.limit) || 20, 250);
      let path = `/products.json?limit=${limit}`;
      if (args.status) path += `&status=${args.status}`;
      if (args.collection_id) path += `&collection_id=${args.collection_id}`;
      const data = await shopifyFetch("GET", path);
      const products = data.products || [];
      if (!products.length) return "No products found.";
      const lines = products.map((p: any) =>
        `[${p.id}] ${p.title} — ${p.status} — ${p.variants?.length || 0} variant(s) — ${p.variants?.[0]?.price || "?"} ${p.variants?.[0]?.currency || ""}`
      );
      return `Products (${products.length}):\n${lines.join("\n")}`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

// --- shopify.product ---
registerSkill({
  name: "shopify.product",
  description: "Get detailed info for a single Shopify product by ID",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Product ID" },
    },
    required: ["id"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;
    try {
      const data = await shopifyFetch("GET", `/products/${args.id}.json`);
      const p = data.product;
      const lines = [
        `Product: ${p.title} (id: ${p.id})`,
        `Status: ${p.status} | Type: ${p.product_type || "N/A"} | Vendor: ${p.vendor || "N/A"}`,
        `Tags: ${p.tags || "none"}`,
        `Created: ${p.created_at}`,
        `Variants (${p.variants?.length || 0}):`,
      ];
      for (const v of (p.variants || []).slice(0, 15)) {
        lines.push(`  [${v.id}] ${v.title} — $${v.price} — SKU: ${v.sku || "N/A"} — stock: ${v.inventory_quantity ?? "?"}`);
      }
      if ((p.variants?.length || 0) > 15) lines.push(`  ... and ${p.variants.length - 15} more`);
      if (p.images?.length) {
        lines.push(`Images: ${p.images.length} — ${p.images[0].src}`);
      }
      return lines.join("\n");
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

// --- shopify.create_product ---
registerSkill({
  name: "shopify.create_product",
  description: "Create a new product on Shopify with title, price, and optional image",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Product title" },
      body_html: { type: "string", description: "Product description (HTML)" },
      vendor: { type: "string", description: "Vendor name" },
      product_type: { type: "string", description: "Product type (e.g. T-Shirt, Poster)" },
      tags: { type: "string", description: "Comma-separated tags" },
      price: { type: "string", description: "Price for default variant (default: 29.99)" },
      image_url: { type: "string", description: "Product image URL (optional)" },
      status: { type: "string", description: "Product status: active or draft (default: draft)" },
    },
    required: ["title"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;
    try {
      const product: Record<string, unknown> = {
        title: String(args.title),
        status: args.status === "active" ? "active" : "draft",
        variants: [{ price: String(args.price || "29.99") }],
      };
      if (args.body_html) product.body_html = String(args.body_html);
      if (args.vendor) product.vendor = String(args.vendor);
      if (args.product_type) product.product_type = String(args.product_type);
      if (args.tags) product.tags = String(args.tags);
      if (args.image_url) product.images = [{ src: String(args.image_url) }];

      const data = await shopifyFetch("POST", "/products.json", { product });
      const p = data.product;
      return `Product created: id=${p.id} title="${p.title}" status=${p.status} price=${p.variants?.[0]?.price || "?"}`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

// --- shopify.update_product ---
registerSkill({
  name: "shopify.update_product",
  description: "Update an existing Shopify product's fields",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Product ID to update" },
      title: { type: "string", description: "New title" },
      body_html: { type: "string", description: "New description (HTML)" },
      vendor: { type: "string", description: "New vendor" },
      product_type: { type: "string", description: "New product type" },
      tags: { type: "string", description: "New tags (comma-separated)" },
      status: { type: "string", description: "New status: active, draft, archived" },
    },
    required: ["id"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;
    try {
      const product: Record<string, unknown> = { id: Number(args.id) };
      if (args.title) product.title = String(args.title);
      if (args.body_html) product.body_html = String(args.body_html);
      if (args.vendor) product.vendor = String(args.vendor);
      if (args.product_type) product.product_type = String(args.product_type);
      if (args.tags) product.tags = String(args.tags);
      if (args.status) product.status = String(args.status);

      if (Object.keys(product).length <= 1) return "Nothing to update — provide at least one field.";
      const data = await shopifyFetch("PUT", `/products/${args.id}.json`, { product });
      return `Product ${data.product.id} updated: "${data.product.title}" — status: ${data.product.status}`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

// --- shopify.delete_product ---
registerSkill({
  name: "shopify.delete_product",
  description: "Delete a product from Shopify by ID",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Product ID to delete" },
    },
    required: ["id"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;
    try {
      await shopifyFetch("DELETE", `/products/${args.id}.json`);
      return `Product ${args.id} deleted successfully.`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

// --- shopify.orders ---
registerSkill({
  name: "shopify.orders",
  description: "List orders from the Shopify store",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      limit: { type: "number", description: "Max results (default 20, max 250)" },
      status: { type: "string", description: "Filter: open, closed, cancelled, any (default: open)" },
      financial_status: { type: "string", description: "Filter: paid, pending, refunded, etc." },
    },
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;
    try {
      const limit = Math.min(Number(args.limit) || 20, 250);
      let path = `/orders.json?limit=${limit}&status=${args.status || "any"}`;
      if (args.financial_status) path += `&financial_status=${args.financial_status}`;
      const data = await shopifyFetch("GET", path);
      const orders = data.orders || [];
      if (!orders.length) return "No orders found.";
      const lines = orders.map((o: any) =>
        `[${o.id}] #${o.order_number} — ${o.financial_status}/${o.fulfillment_status || "unfulfilled"} — ${o.total_price} ${o.currency} — ${o.line_items?.length || 0} items — ${o.created_at?.slice(0, 10)}`
      );
      return `Orders (${orders.length}):\n${lines.join("\n")}`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

// --- shopify.order ---
registerSkill({
  name: "shopify.order",
  description: "Get detailed info for a single Shopify order by ID",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Order ID" },
    },
    required: ["id"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;
    try {
      const data = await shopifyFetch("GET", `/orders/${args.id}.json`);
      const o = data.order;
      const lines = [
        `Order #${o.order_number} (id: ${o.id})`,
        `Status: ${o.financial_status} / ${o.fulfillment_status || "unfulfilled"}`,
        `Customer: ${o.customer?.first_name || ""} ${o.customer?.last_name || ""} (${o.email || "no email"})`,
        `Created: ${o.created_at}`,
        `Items (${o.line_items?.length || 0}):`,
      ];
      for (const item of (o.line_items || [])) {
        lines.push(`  ${item.title} x${item.quantity} — $${item.price}`);
      }
      lines.push(`\nSubtotal: ${o.subtotal_price} | Shipping: ${o.total_shipping_price_set?.shop_money?.amount || "0"} | Tax: ${o.total_tax} | Total: ${o.total_price} ${o.currency}`);
      if (o.shipping_address) {
        const a = o.shipping_address;
        lines.push(`Ship to: ${a.name}, ${a.address1}, ${a.city} ${a.province_code || ""} ${a.zip}, ${a.country_code}`);
      }
      if (o.fulfillments?.length) {
        for (const f of o.fulfillments) {
          lines.push(`Fulfillment: ${f.status} — tracking: ${f.tracking_number || "none"} (${f.tracking_company || ""})`);
        }
      }
      return lines.join("\n");
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

// --- shopify.collections ---
registerSkill({
  name: "shopify.collections",
  description: "List custom and smart collections from Shopify",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      limit: { type: "number", description: "Max results per type (default 20)" },
    },
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;
    try {
      const limit = Math.min(Number(args.limit) || 20, 250);
      const [customData, smartData] = await Promise.all([
        shopifyFetch("GET", `/custom_collections.json?limit=${limit}`),
        shopifyFetch("GET", `/smart_collections.json?limit=${limit}`),
      ]);
      const custom = customData.custom_collections || [];
      const smart = smartData.smart_collections || [];
      const lines: string[] = [];
      if (custom.length) {
        lines.push(`Custom Collections (${custom.length}):`);
        for (const c of custom) lines.push(`  [${c.id}] ${c.title} — ${c.products_count ?? "?"} products`);
      }
      if (smart.length) {
        lines.push(`Smart Collections (${smart.length}):`);
        for (const c of smart) lines.push(`  [${c.id}] ${c.title} — ${c.products_count ?? "?"} products`);
      }
      if (!lines.length) return "No collections found.";
      return lines.join("\n");
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

// --- shopify.inventory ---
registerSkill({
  name: "shopify.inventory",
  description: "Get inventory levels for items at a location",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      location_id: { type: "string", description: "Location ID (required — get from shop info or locations endpoint)" },
      inventory_item_ids: { type: "string", description: "Comma-separated inventory item IDs (optional, max 50)" },
    },
    required: ["location_id"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;
    try {
      let path = `/inventory_levels.json?location_ids=${args.location_id}&limit=50`;
      if (args.inventory_item_ids) path = `/inventory_levels.json?inventory_item_ids=${args.inventory_item_ids}&limit=50`;
      const data = await shopifyFetch("GET", path);
      const levels = data.inventory_levels || [];
      if (!levels.length) return "No inventory levels found.";
      const lines = levels.map((l: any) =>
        `  Item ${l.inventory_item_id} @ location ${l.location_id}: ${l.available ?? "?"} available`
      );
      return `Inventory (${levels.length} items):\n${lines.join("\n")}`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

log.debug("Registered 10 shopify.* skills");
