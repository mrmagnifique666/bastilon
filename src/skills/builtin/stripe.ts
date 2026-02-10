/**
 * Built-in skills: stripe.charge, stripe.customer_create, stripe.subscription_create,
 * stripe.subscription_cancel, stripe.invoices, stripe.balance, stripe.refund
 * Uses Stripe REST API via fetch (no SDK dependency).
 */
import { registerSkill } from "../loader.js";
import { log } from "../../utils/log.js";

const API = "https://api.stripe.com/v1";

function getKey(): string | null {
  return process.env.STRIPE_SECRET_KEY || null;
}

function checkConfig(): string | null {
  if (!getKey()) return "Stripe not configured. Set STRIPE_SECRET_KEY in .env";
  return null;
}

async function stripeFetch(method: string, path: string, body?: Record<string, string>): Promise<any> {
  const auth = Buffer.from(`${getKey()}:`).toString("base64");
  const opts: RequestInit = {
    method,
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
  };
  if (body) opts.body = new URLSearchParams(body);

  const resp = await fetch(`${API}${path}`, opts);
  const data = await resp.json();
  if (!resp.ok) throw new Error(`Stripe ${resp.status}: ${data.error?.message || JSON.stringify(data)}`);
  return data;
}

registerSkill({
  name: "stripe.charge",
  description: "Create a payment intent / charge a customer.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      amount: { type: "number", description: "Amount in cents (e.g. 2000 = $20.00)" },
      currency: { type: "string", description: "Currency code (default: cad)" },
      customerId: { type: "string", description: "Stripe customer ID" },
      description: { type: "string", description: "Payment description" },
    },
    required: ["amount", "customerId"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;
    try {
      const data = await stripeFetch("POST", "/payment_intents", {
        amount: String(Math.round(Number(args.amount))),
        currency: String(args.currency || "cad"),
        customer: String(args.customerId),
        description: String(args.description || ""),
        confirm: "true",
        automatic_payment_methods: JSON.stringify({ enabled: true, allow_redirects: "never" }),
      });
      return `Payment created: id=${data.id} status=${data.status} amount=$${(data.amount / 100).toFixed(2)} ${data.currency}`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

registerSkill({
  name: "stripe.customer_create",
  description: "Create a Stripe customer.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      email: { type: "string", description: "Customer email" },
      name: { type: "string", description: "Customer name" },
    },
    required: ["email"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;
    try {
      const body: Record<string, string> = { email: String(args.email) };
      if (args.name) body.name = String(args.name);
      const data = await stripeFetch("POST", "/customers", body);
      return `Customer created: id=${data.id} email=${data.email}`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

registerSkill({
  name: "stripe.subscription_create",
  description: "Create a subscription for a customer.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      customerId: { type: "string", description: "Stripe customer ID" },
      priceId: { type: "string", description: "Stripe price ID" },
    },
    required: ["customerId", "priceId"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;
    try {
      const data = await stripeFetch("POST", "/subscriptions", {
        customer: String(args.customerId),
        "items[0][price]": String(args.priceId),
      });
      return `Subscription created: id=${data.id} status=${data.status}`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

registerSkill({
  name: "stripe.subscription_cancel",
  description: "Cancel a subscription.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      subscriptionId: { type: "string", description: "Subscription ID to cancel" },
    },
    required: ["subscriptionId"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;
    try {
      const data = await stripeFetch("DELETE", `/subscriptions/${args.subscriptionId}`);
      return `Subscription ${data.id} cancelled (status: ${data.status})`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

registerSkill({
  name: "stripe.invoices",
  description: "List invoices, optionally for a customer.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      customerId: { type: "string", description: "Filter by customer (optional)" },
      limit: { type: "number", description: "Number of invoices (default 10)" },
    },
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;
    try {
      let path = `/invoices?limit=${Math.min(Number(args.limit) || 10, 50)}`;
      if (args.customerId) path += `&customer=${args.customerId}`;
      const data = await stripeFetch("GET", path);
      if (!data.data?.length) return "No invoices found.";
      const lines = data.data.map((inv: any) =>
        `[${inv.id}] $${(inv.amount_due / 100).toFixed(2)} ${inv.currency} — ${inv.status} — ${inv.customer_email || inv.customer}`
      );
      return `**Invoices (${data.data.length}):**\n${lines.join("\n")}`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

registerSkill({
  name: "stripe.balance",
  description: "Get Stripe account balance.",
  adminOnly: true,
  argsSchema: { type: "object", properties: {} },
  async execute(): Promise<string> {
    const err = checkConfig();
    if (err) return err;
    try {
      const data = await stripeFetch("GET", "/balance");
      const lines = data.available?.map((b: any) =>
        `${b.currency.toUpperCase()}: $${(b.amount / 100).toFixed(2)} available, $${((data.pending?.find((p: any) => p.currency === b.currency)?.amount || 0) / 100).toFixed(2)} pending`
      ) || ["No balance data"];
      return `**Stripe Balance:**\n${lines.join("\n")}`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

registerSkill({
  name: "stripe.refund",
  description: "Refund a payment.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      paymentIntentId: { type: "string", description: "Payment Intent ID to refund" },
      amount: { type: "number", description: "Amount in cents (optional, full refund if omitted)" },
    },
    required: ["paymentIntentId"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;
    try {
      const body: Record<string, string> = { payment_intent: String(args.paymentIntentId) };
      if (args.amount) body.amount = String(Math.round(Number(args.amount)));
      const data = await stripeFetch("POST", "/refunds", body);
      return `Refund created: id=${data.id} amount=$${(data.amount / 100).toFixed(2)} status=${data.status}`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

log.debug("Registered 7 stripe.* skills");
