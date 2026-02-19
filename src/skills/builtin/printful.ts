/**
 * Built-in skills: printful.*
 * Uses Printful REST API v1 via fetch (no SDK dependency).
 * Store type: Shopify — sync products managed via Shopify integration.
 * Supports: catalog browsing, file upload, mockup generation, orders, shipping.
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
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.printfulApiToken}`,
    "Content-Type": "application/json",
  };
  // Add store ID header — required for multi-store tokens
  const storeId = config.printfulStoreId;
  if (storeId) headers["X-PF-Store-Id"] = storeId;

  const opts: RequestInit = { method, headers };
  if (body) opts.body = JSON.stringify(body);

  const resp = await fetch(`${API}${path}`, opts);
  const data = await resp.json();
  if (!resp.ok) throw new Error(`Printful ${resp.status}: ${data.result || data.error?.message || JSON.stringify(data)}`);
  return data.result;
}

// ── Store Info ────────────────────────────────────────

registerSkill({
  name: "printful.store",
  description: "Get Printful store info — name, type, website, created date",
  adminOnly: true,
  argsSchema: { type: "object", properties: {} },
  async execute(): Promise<string> {
    const err = checkConfig();
    if (err) return err;
    try {
      const store = await printfulFetch("GET", "/store");
      return [
        `Store: ${store.name} (id: ${store.id})`,
        `Type: ${store.type}`,
        `Website: ${store.website || "none"}`,
        `Created: ${new Date(store.created * 1000).toISOString().split("T")[0]}`,
      ].join("\n");
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

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

// ── Catalog Browsing ─────────────────────────────────

registerSkill({
  name: "printful.catalog",
  description: "Browse Printful product catalog — list available product types. Filter by category.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      category: { type: "string", description: "Filter: T-shirt, Hoodie, Hat, Mug, Poster, All-over, etc." },
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
          p.type?.toLowerCase().includes(cat) ||
          p.title?.toLowerCase().includes(cat) ||
          p.type_name?.toLowerCase().includes(cat)
        );
      }
      if (!filtered?.length) return "No catalog products found for that filter.";
      const lines = filtered.slice(0, 30).map((p: any) =>
        `[${p.id}] ${p.title} — ${p.type_name || p.type} — ${p.variant_count} variants`
      );
      const extra = filtered.length > 30 ? `\n... and ${filtered.length - 30} more` : "";
      return `Catalog (${filtered.length} products):\n${lines.join("\n")}${extra}`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

registerSkill({
  name: "printful.catalog_product",
  description: "Get details of a catalog product by ID — variants, print files, options",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      id: { type: "number", description: "Catalog product ID (e.g. 71 for Bella+Canvas 3001)" },
    },
    required: ["id"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;
    try {
      const data = await printfulFetch("GET", `/products/${args.id}`);
      const p = data.product;
      const variants = data.variants || [];
      const lines = [
        `${p.title} (id: ${p.id})`,
        `Type: ${p.type_name || p.type} | Brand: ${p.brand || "N/A"}`,
        `Description: ${(p.description || "").slice(0, 200)}...`,
        `\nVariants (${variants.length} total):`,
      ];
      // Group by color for readability
      const colors = new Map<string, any[]>();
      for (const v of variants) {
        const c = v.color || "Default";
        if (!colors.has(c)) colors.set(c, []);
        colors.get(c)!.push(v);
      }
      let shown = 0;
      for (const [color, vars] of Array.from(colors.entries())) {
        if (shown >= 20) { lines.push(`  ... and more`); break; }
        const sizes = vars.map((v: any) => `${v.size}[${v.id}]`).join(", ");
        lines.push(`  ${color}: ${sizes}`);
        shown += vars.length;
      }
      return lines.join("\n");
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

registerSkill({
  name: "printful.printfiles",
  description: "Get print file specifications for a catalog product — dimensions, DPI, placements",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      product_id: { type: "number", description: "Catalog product ID (e.g. 71)" },
    },
    required: ["product_id"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;
    try {
      const data = await printfulFetch("GET", `/mockup-generator/printfiles/${args.product_id}`);
      const printfiles = data.printfiles || [];
      const lines = [`Print file specs for product ${args.product_id}:`];
      for (const pf of printfiles) {
        lines.push(`  [${pf.printfile_id}] ${pf.width}x${pf.height}px (${pf.dpi}dpi) — placements: ${(pf.available_placements || []).map((p: any) => p.placement).join(", ")}`);
      }
      return lines.join("\n") || "No printfile specs found.";
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

// ── File Library ─────────────────────────────────────

registerSkill({
  name: "printful.upload_file",
  description: "Upload a design file to Printful File Library from a public URL",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "Public URL of the file (PNG/JPG/SVG)" },
      filename: { type: "string", description: "Filename to store as (optional)" },
    },
    required: ["url"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;
    try {
      const body: Record<string, unknown> = { url: String(args.url) };
      if (args.filename) body.filename = String(args.filename);
      const result = await printfulFetch("POST", "/files", body);
      return [
        `File uploaded: id=${result.id}`,
        `Type: ${result.type} | Size: ${result.size}`,
        `Status: ${result.status}`,
        `Preview: ${result.preview_url || "processing..."}`,
        `URL: ${result.url || "processing..."}`,
      ].join("\n");
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

registerSkill({
  name: "printful.file_status",
  description: "Check the status of an uploaded file by ID",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      id: { type: "number", description: "File ID from printful.upload_file" },
    },
    required: ["id"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;
    try {
      const f = await printfulFetch("GET", `/files/${args.id}`);
      return [
        `File ${f.id}: ${f.filename || "unnamed"}`,
        `Type: ${f.type} | Size: ${f.size} | Status: ${f.status}`,
        `Dimensions: ${f.width || "?"}x${f.height || "?"}px`,
        `DPI: ${f.dpi || "?"}`,
        `Preview: ${f.preview_url || "N/A"}`,
        `URL: ${f.url || "N/A"}`,
      ].join("\n");
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

// ── Mockup Generation ────────────────────────────────

registerSkill({
  name: "printful.create_mockup",
  description: "Start a mockup generation task for a product — returns a task_key for polling",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      product_id: { type: "number", description: "Catalog product ID (e.g. 71 for Bella+Canvas 3001)" },
      image_url: { type: "string", description: "Public URL of the design image (PNG, min 3600x4800 for front)" },
      variant_ids: { type: "string", description: "Comma-separated variant IDs for mockups (optional)" },
      placement: { type: "string", description: "Placement: front (default), back, left, right" },
    },
    required: ["product_id", "image_url"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;
    try {
      const placement = String(args.placement || "front");
      const body: Record<string, unknown> = {
        files: [{ placement, image_url: String(args.image_url) }],
      };
      if (args.variant_ids) {
        body.variant_ids = String(args.variant_ids).split(",").map(Number);
      }
      const result = await printfulFetch("POST", `/mockup-generator/create-task/${args.product_id}`, body);
      return `Mockup task started: task_key=${result.task_key} status=${result.status}\nPoll with printful.get_mockup(task_key="${result.task_key}")`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

registerSkill({
  name: "printful.get_mockup",
  description: "Get mockup generation results by task key — returns image URLs when ready",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      task_key: { type: "string", description: "Task key from printful.create_mockup" },
    },
    required: ["task_key"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;
    try {
      const result = await printfulFetch("GET", `/mockup-generator/task?task_key=${args.task_key}`);
      if (result.status === "pending") return "Mockup still generating... try again in 5-10 seconds.";
      if (result.status === "completed") {
        const mockups = result.mockups || [];
        if (!mockups.length) return "Mockup completed but no images returned.";
        const lines = mockups.slice(0, 10).map((m: any, i: number) =>
          `  [${i + 1}] ${m.placement || "front"} (${m.variant_ids?.join(",") || "all"}): ${m.mockup_url}`
        );
        const extra = result.extra || [];
        const extraLines = extra.slice(0, 5).map((e: any) =>
          `  Extra: ${e.title}: ${e.url}`
        );
        return `Mockup ready (${mockups.length} images):\n${lines.join("\n")}${extraLines.length ? "\n" + extraLines.join("\n") : ""}`;
      }
      return `Mockup status: ${result.status} — ${JSON.stringify(result).slice(0, 300)}`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

// ── Sync Products (Shopify-integrated store) ─────────
// Note: For Shopify stores, /store/products endpoints return 400.
// Products are managed through Shopify. Use printful.push_product instead.

registerSkill({
  name: "printful.products",
  description: "List sync products in the store (only works for Manual/API stores, not Shopify)",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      limit: { type: "number", description: "Max results (default 20)" },
    },
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;
    try {
      const limit = Math.min(Number(args.limit) || 20, 100);
      const products = await printfulFetch("GET", `/store/products?limit=${limit}`);
      if (!products?.length) return "No sync products. Note: For Shopify stores, products are managed through Shopify.";
      const lines = products.map((p: any) =>
        `[${p.id}] ${p.name} — ${p.variants} variant(s) — synced: ${p.synced}`
      );
      return `Products (${products.length}):\n${lines.join("\n")}`;
    } catch (e: any) {
      if (e.message?.includes("Manual Order")) {
        return "This is a Shopify-integrated store. Sync products are managed through Shopify.\nUse printful.push_product to create products that sync to Shopify automatically.";
      }
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

registerSkill({
  name: "printful.push_product",
  description: "Create a product on Printful that auto-syncs to your Shopify store. Provide design URL (3600x4800px PNG for t-shirts).",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Product name" },
      image_url: { type: "string", description: "Public URL of the design image (PNG, 3600x4800px recommended)" },
      product_id: { type: "number", description: "Catalog product ID (default: 71 = Bella+Canvas 3001 T-Shirt)" },
      colors: { type: "string", description: "Comma-separated colors: black,white,navy (default: black)" },
      sizes: { type: "string", description: "Comma-separated sizes: S,M,L,XL,2XL (default: S,M,L,XL)" },
      price: { type: "string", description: "Retail price per variant in USD (default: 29.99)" },
      placement: { type: "string", description: "Print placement: front, back, front+back (default: front)" },
      back_image_url: { type: "string", description: "Public URL for back design (if placement includes back)" },
    },
    required: ["name", "image_url"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;
    try {
      const name = String(args.name);
      const imageUrl = String(args.image_url);
      const productId = Number(args.product_id) || 71;
      const price = String(args.price || "29.99");
      const placement = String(args.placement || "front");

      // Get available variants for the product
      const catalogData = await printfulFetch("GET", `/products/${productId}`);
      const allVariants = catalogData.variants || [];

      // Filter by requested colors and sizes
      const requestedColors = args.colors
        ? String(args.colors).split(",").map(c => c.trim().toLowerCase())
        : ["black"];
      const requestedSizes = args.sizes
        ? String(args.sizes).split(",").map(s => s.trim().toUpperCase())
        : ["S", "M", "L", "XL"];

      const matchedVariants = allVariants.filter((v: any) => {
        const colorMatch = requestedColors.some(c =>
          v.color?.toLowerCase().includes(c)
        );
        const sizeMatch = requestedSizes.includes(v.size);
        return colorMatch && sizeMatch;
      });

      if (!matchedVariants.length) {
        return `No variants found matching colors=[${requestedColors}] sizes=[${requestedSizes}] for product ${productId}.\nAvailable colors: ${Array.from(new Set(allVariants.map((v: any) => v.color))).slice(0, 10).join(", ")}`;
      }

      // Build files array based on placement
      const files: Array<{ url: string; type: string }> = [
        { url: imageUrl, type: "front" },
      ];
      if (placement.includes("back") && args.back_image_url) {
        files.push({ url: String(args.back_image_url), type: "back" });
      }

      const productData = {
        sync_product: { name, thumbnail: imageUrl },
        sync_variants: matchedVariants.map((v: any) => ({
          variant_id: v.id,
          retail_price: price,
          files,
        })),
      };

      const result = await printfulFetch("POST", "/store/products", productData);
      const variantSummary = matchedVariants.map((v: any) => `${v.color} ${v.size}`).join(", ");
      return [
        `Product created and syncing to Shopify!`,
        `Name: "${name}" (Printful ID: ${result.id})`,
        `Variants (${matchedVariants.length}): ${variantSummary}`,
        `Price: $${price}/unit`,
        `Placement: ${placement}`,
        `\nThe product will appear in your Shopify store (bastilon-designs.myshopify.com) within a few minutes.`,
      ].join("\n");
    } catch (e: any) {
      if (e.message?.includes("Manual Order")) {
        return "Error: The Printful store uses Shopify integration. The /store/products endpoint requires a Manual Order/API store type.\n\nTo create products, you can:\n1. Use the Printful Dashboard directly\n2. Create products via Shopify Admin and link them to Printful\n3. Use the Shopify API to create products that Printful will sync";
      }
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

// ── Orders ───────────────────────────────────────────

registerSkill({
  name: "printful.orders",
  description: "List orders from the store",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      status: { type: "string", description: "Filter: draft|pending|failed|canceled|inprocess|onhold|partial|fulfilled" },
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
      return lines.join("\n");
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

registerSkill({
  name: "printful.create_order",
  description: "Create a new order (draft or for fulfillment) — uses catalog variant_ids + design URLs",
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
      items: { type: "string", description: "JSON array: [{variant_id, quantity, files:[{url,type}]}]" },
      confirm: { type: "boolean", description: "Submit for fulfillment immediately (default false = draft)" },
    },
    required: ["recipient_name", "address1", "city", "country_code", "zip", "items"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;
    try {
      let items: Array<any>;
      try {
        items = JSON.parse(String(args.items));
      } catch {
        return 'Error: items must be valid JSON, e.g. [{"variant_id":4017,"quantity":1,"files":[{"url":"https://...","type":"front"}]}]';
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
        items,
      };

      const confirm = args.confirm === true;
      const data = await printfulFetch("POST", `/orders${confirm ? "?confirm=true" : ""}`, order);
      return [
        `Order created: id=${data.id} status=${data.status}`,
        `Items: ${data.items?.length || 0}`,
        confirm ? "Submitted for fulfillment!" : "Draft — use printful.confirm_order to submit.",
      ].join("\n");
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

registerSkill({
  name: "printful.confirm_order",
  description: "Confirm a draft order — submits it for fulfillment",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      id: { type: "number", description: "Order ID to confirm" },
    },
    required: ["id"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;
    try {
      const result = await printfulFetch("POST", `/orders/${args.id}/confirm`);
      return `Order ${args.id} confirmed — status: ${result.status}`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

// ── Shipping & Estimates ─────────────────────────────

registerSkill({
  name: "printful.shipping_rates",
  description: "Estimate shipping rates for items to a destination",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      country_code: { type: "string", description: "Country code (e.g. CA, US)" },
      state_code: { type: "string", description: "State/province code" },
      city: { type: "string", description: "City" },
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
        return "Error: items must be valid JSON";
      }
      const body = {
        recipient: {
          country_code: String(args.country_code),
          state_code: args.state_code ? String(args.state_code) : undefined,
          city: args.city ? String(args.city) : undefined,
          zip: args.zip ? String(args.zip) : undefined,
        },
        items,
      };
      const rates = await printfulFetch("POST", "/shipping/rates", body);
      if (!rates?.length) return "No shipping rates available.";
      const lines = rates.map((r: any) =>
        `${r.name}: $${r.rate} ${r.currency} — ${r.minDeliveryDays}-${r.maxDeliveryDays} business days`
      );
      return `Shipping rates:\n${lines.join("\n")}`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

registerSkill({
  name: "printful.estimate_order",
  description: "Estimate total costs for an order before placing it",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      country_code: { type: "string", description: "Country code (e.g. CA, US)" },
      zip: { type: "string", description: "Postal/ZIP code" },
      items: { type: "string", description: "JSON array: [{variant_id, quantity, files:[{url, type}]}]" },
    },
    required: ["country_code", "zip", "items"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;
    try {
      let items: Array<any>;
      try {
        items = JSON.parse(String(args.items));
      } catch {
        return "Error: items must be valid JSON";
      }
      const body = {
        recipient: {
          name: "Estimate",
          address1: "123 Test St",
          city: "Test",
          country_code: String(args.country_code),
          zip: String(args.zip),
        },
        items,
      };
      const result = await printfulFetch("POST", "/orders/estimate", body);
      const c = result.costs || {};
      return `Estimate:\n  Subtotal: $${c.subtotal}\n  Shipping: $${c.shipping}\n  Tax: $${c.tax}\n  Total: $${c.total} ${c.currency || "USD"}`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

// ── Product Management ───────────────────────────────

registerSkill({
  name: "printful.product",
  description: "Get details of a sync product by ID",
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
    } catch (e: any) {
      if (e.message?.includes("Manual Order")) {
        return "This endpoint requires a Manual Order/API store. For Shopify stores, manage products through Shopify.";
      }
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
      return `Product ${args.id} deleted.`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

registerSkill({
  name: "printful.update_product",
  description: "Update a sync product's name or thumbnail",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      id: { type: "number", description: "Sync product ID" },
      name: { type: "string", description: "New product name" },
      thumbnail: { type: "string", description: "New thumbnail URL" },
    },
    required: ["id"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;
    try {
      const body: Record<string, unknown> = {};
      if (args.name) body.name = String(args.name);
      if (args.thumbnail) body.thumbnail = String(args.thumbnail);
      if (!Object.keys(body).length) return "Nothing to update — provide name or thumbnail.";
      const result = await printfulFetch("PUT", `/store/products/${args.id}`, { sync_product: body });
      return `Product ${args.id} updated: ${result.sync_product?.name || "ok"}`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

// ── Convenience: Full Pipeline ───────────────────────

registerSkill({
  name: "printful.design_tshirt",
  description: "Full pipeline: upload design → create mockup → return mockup URL. For Bella+Canvas 3001 (product 71).",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      image_url: { type: "string", description: "Public URL of the design (PNG, 3600x4800px recommended)" },
      variant_ids: { type: "string", description: "Comma-separated variant IDs for mockup (default: 4017 = Black M)" },
    },
    required: ["image_url"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;
    try {
      const imageUrl = String(args.image_url);
      const variantIds = args.variant_ids
        ? String(args.variant_ids).split(",").map(Number)
        : [4017]; // Black Medium

      // Step 1: Upload file
      const file = await printfulFetch("POST", "/files", { url: imageUrl });
      const fileInfo = `File uploaded: id=${file.id} (${file.status})`;

      // Step 2: Create mockup
      const mockupBody: Record<string, unknown> = {
        variant_ids: variantIds,
        files: [{ placement: "front", image_url: imageUrl }],
      };
      const task = await printfulFetch("POST", "/mockup-generator/create-task/71", mockupBody);
      const taskKey = task.task_key;

      // Step 3: Poll for mockup (max 30s)
      let mockupResult = "";
      for (let i = 0; i < 6; i++) {
        await new Promise(r => setTimeout(r, 5000));
        const status = await printfulFetch("GET", `/mockup-generator/task?task_key=${taskKey}`);
        if (status.status === "completed") {
          const mockups = status.mockups || [];
          mockupResult = mockups.map((m: any) => m.mockup_url).join("\n");
          break;
        }
      }

      if (!mockupResult) {
        return `${fileInfo}\nMockup task started (task_key=${taskKey}) but still processing.\nUse printful.get_mockup(task_key="${taskKey}") to check later.`;
      }

      return `${fileInfo}\n\nMockup ready:\n${mockupResult}`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

log.debug("Registered printful.* skills (21 total)");
