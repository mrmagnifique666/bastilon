/**
 * Built-in utility skills: math.eval, hash.compute, convert.units
 * No external dependencies.
 */
import crypto from "node:crypto";
import { registerSkill } from "../loader.js";

// ── math.eval ──

registerSkill({
  name: "math.eval",
  description:
    "Safely evaluate a math expression. Supports +, -, *, /, **, %, sqrt, sin, cos, tan, log, abs, ceil, floor, round, PI, E.",
  argsSchema: {
    type: "object",
    properties: {
      expression: { type: "string", description: "Math expression to evaluate" },
    },
    required: ["expression"],
  },
  async execute(args): Promise<string> {
    const expr = args.expression as string;

    // Whitelist: only allow safe math chars and functions
    const sanitized = expr
      .replace(/\bsqrt\b/g, "Math.sqrt")
      .replace(/\bsin\b/g, "Math.sin")
      .replace(/\bcos\b/g, "Math.cos")
      .replace(/\btan\b/g, "Math.tan")
      .replace(/\blog\b/g, "Math.log")
      .replace(/\babs\b/g, "Math.abs")
      .replace(/\bceil\b/g, "Math.ceil")
      .replace(/\bfloor\b/g, "Math.floor")
      .replace(/\bround\b/g, "Math.round")
      .replace(/\bPI\b/g, "Math.PI")
      .replace(/\bE\b/g, "Math.E")
      .replace(/\bpow\b/g, "Math.pow");

    // Reject anything that isn't math
    if (/[a-zA-Z_$]/.test(sanitized.replace(/Math\.\w+/g, ""))) {
      return "Error: expression contains invalid characters. Only numbers, operators, and math functions are allowed.";
    }

    try {
      // Use Function constructor with no access to globals
      const fn = new Function(`"use strict"; return (${sanitized})`);
      const result = fn();
      if (typeof result !== "number" || !isFinite(result)) {
        return `Result: ${result} (not a finite number)`;
      }
      return `${expr} = ${result}`;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : "Invalid expression"}`;
    }
  },
});

// ── hash.compute ──

registerSkill({
  name: "hash.compute",
  description:
    "Compute a hash of text. Supports: md5, sha1, sha256, sha512.",
  argsSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "Text to hash" },
      algorithm: {
        type: "string",
        description: "Hash algorithm: md5, sha1, sha256, sha512 (default: sha256)",
      },
    },
    required: ["text"],
  },
  async execute(args): Promise<string> {
    const text = args.text as string;
    const algo = (args.algorithm as string) || "sha256";
    const valid = ["md5", "sha1", "sha256", "sha512"];
    if (!valid.includes(algo)) return `Invalid algorithm. Use: ${valid.join(", ")}`;

    const hash = crypto.createHash(algo).update(text, "utf-8").digest("hex");
    return `${algo}: ${hash}`;
  },
});

// ── convert.units ──

const CONVERSIONS: Record<string, Record<string, number>> = {
  // Length (base: meters)
  km: { m: 1000 },
  m: { m: 1 },
  cm: { m: 0.01 },
  mm: { m: 0.001 },
  mi: { m: 1609.344 },
  ft: { m: 0.3048 },
  in: { m: 0.0254 },
  yd: { m: 0.9144 },
  // Weight (base: grams)
  kg: { g: 1000 },
  g: { g: 1 },
  mg: { g: 0.001 },
  lb: { g: 453.592 },
  oz: { g: 28.3495 },
  // Volume (base: liters)
  l: { l: 1 },
  ml: { l: 0.001 },
  gal: { l: 3.78541 },
  qt: { l: 0.946353 },
  cup: { l: 0.236588 },
  // Speed (base: m/s)
  "km/h": { "m/s": 0.277778 },
  "m/s": { "m/s": 1 },
  mph: { "m/s": 0.44704 },
  knot: { "m/s": 0.514444 },
};

function findBase(unit: string): string | null {
  const entry = CONVERSIONS[unit];
  if (!entry) return null;
  return Object.keys(entry)[0];
}

registerSkill({
  name: "convert.units",
  description:
    "Convert between units. Supports length (km/m/cm/mm/mi/ft/in/yd), weight (kg/g/mg/lb/oz), volume (l/ml/gal/qt/cup), speed (km/h, m/s, mph, knot), and temperature (C/F/K).",
  argsSchema: {
    type: "object",
    properties: {
      value: { type: "number", description: "Numeric value to convert" },
      from: { type: "string", description: "Source unit (e.g. 'km', 'lb', 'F')" },
      to: { type: "string", description: "Target unit (e.g. 'mi', 'kg', 'C')" },
    },
    required: ["value", "from", "to"],
  },
  async execute(args): Promise<string> {
    const value = args.value as number;
    const from = (args.from as string).toLowerCase();
    const to = (args.to as string).toLowerCase();

    // Temperature special case
    const tempUnits = ["c", "f", "k"];
    if (tempUnits.includes(from) && tempUnits.includes(to)) {
      let celsius: number;
      if (from === "c") celsius = value;
      else if (from === "f") celsius = (value - 32) * (5 / 9);
      else celsius = value - 273.15;

      let result: number;
      if (to === "c") result = celsius;
      else if (to === "f") result = celsius * (9 / 5) + 32;
      else result = celsius + 273.15;

      return `${value}°${from.toUpperCase()} = ${result.toFixed(2)}°${to.toUpperCase()}`;
    }

    const fromBase = findBase(from);
    const toBase = findBase(to);
    if (!fromBase || !toBase) {
      const allUnits = [...Object.keys(CONVERSIONS), "c", "f", "k"].join(", ");
      return `Unknown unit. Available: ${allUnits}`;
    }
    if (fromBase !== toBase) {
      return `Cannot convert ${from} to ${to} — different unit types.`;
    }

    const inBase = value * CONVERSIONS[from][fromBase];
    const result = inBase / CONVERSIONS[to][toBase];

    return `${value} ${from} = ${result.toFixed(4)} ${to}`;
  },
});

// ── convert.currency ──

registerSkill({
  name: "convert.currency",
  description:
    "Convert between currencies using live exchange rates. Supports all major currencies (USD, CAD, EUR, GBP, etc.).",
  argsSchema: {
    type: "object",
    properties: {
      amount: { type: "number", description: "Amount to convert" },
      from: { type: "string", description: "Source currency code (e.g. 'USD')" },
      to: { type: "string", description: "Target currency code (e.g. 'CAD')" },
    },
    required: ["amount", "from", "to"],
  },
  async execute(args): Promise<string> {
    const amount = args.amount as number;
    const from = (args.from as string).toUpperCase();
    const to = (args.to as string).toUpperCase();

    const resp = await fetch(
      `https://api.exchangerate.host/convert?from=${from}&to=${to}&amount=${amount}`
    );
    if (!resp.ok) {
      // Fallback to alternative API
      const fallback = await fetch(
        `https://open.er-api.com/v6/latest/${from}`
      );
      if (!fallback.ok) return `Error fetching exchange rate: HTTP ${fallback.status}`;
      const data = await fallback.json();
      const rate = data?.rates?.[to];
      if (!rate) return `Currency not found: ${to}`;
      const result = amount * rate;
      return `${amount} ${from} = ${result.toFixed(2)} ${to} (rate: ${rate.toFixed(4)})`;
    }

    const data = await resp.json();
    if (!data.success && !data.result) {
      return `Conversion failed: ${data.error?.info || "Unknown error"}`;
    }

    const result = data.result || (amount * (data.info?.rate || 0));
    const rate = data.info?.rate || (result / amount);
    return `${amount} ${from} = ${result.toFixed(2)} ${to} (rate: ${rate.toFixed(4)})`;
  },
});
