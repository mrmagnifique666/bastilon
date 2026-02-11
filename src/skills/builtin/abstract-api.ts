/**
 * Abstract API skills — free utilities.
 * Email validation, IP geolocation, phone validation.
 * API: https://www.abstractapi.com — free tier per service.
 * Skills: validate.email, validate.phone, geo.ip
 */
import { registerSkill } from "../loader.js";
import { config } from "../../config/env.js";

registerSkill({
  name: "validate.email",
  description: "Validate an email address (deliverability, format, disposable check). Free via Abstract API.",
  argsSchema: {
    type: "object",
    properties: {
      email: { type: "string", description: "Email to validate" },
    },
    required: ["email"],
  },
  async execute(args): Promise<string> {
    const email = String(args.email);
    if (!config.abstractEmailApiKey) {
      // Basic local validation as fallback
      const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
      return valid
        ? `${email} — format valide (validation avancée nécessite ABSTRACT_EMAIL_API_KEY)`
        : `${email} — format INVALIDE`;
    }

    try {
      const url = `https://emailvalidation.abstractapi.com/v1/?api_key=${config.abstractEmailApiKey}&email=${encodeURIComponent(email)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) return `API error: ${res.status}`;

      const data = (await res.json()) as {
        email: string;
        deliverability: string;
        is_valid_format: { value: boolean };
        is_disposable_email: { value: boolean };
        is_free_email: { value: boolean };
        quality_score: string;
      };

      return [
        `**${data.email}**`,
        `  Livrable: ${data.deliverability}`,
        `  Format valide: ${data.is_valid_format?.value ? "oui" : "non"}`,
        `  Jetable: ${data.is_disposable_email?.value ? "OUI ⚠️" : "non"}`,
        `  Gratuit: ${data.is_free_email?.value ? "oui" : "non"}`,
        `  Score qualité: ${data.quality_score}`,
      ].join("\n");
    } catch (err) {
      return `Erreur: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

registerSkill({
  name: "geo.ip",
  description: "Get geolocation for an IP address. Free via Abstract API or ip-api.com.",
  argsSchema: {
    type: "object",
    properties: {
      ip: { type: "string", description: "IP address (leave empty for your own IP)" },
    },
  },
  async execute(args): Promise<string> {
    const ip = args.ip ? String(args.ip) : "";

    // Use free ip-api.com (no key needed, 45 req/min)
    try {
      const url = ip
        ? `http://ip-api.com/json/${ip}?fields=status,message,country,regionName,city,zip,lat,lon,timezone,isp,org,as,query`
        : `http://ip-api.com/json/?fields=status,message,country,regionName,city,zip,lat,lon,timezone,isp,org,as,query`;

      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) return `API error: ${res.status}`;

      const data = (await res.json()) as {
        status: string;
        query: string;
        country: string;
        regionName: string;
        city: string;
        zip: string;
        lat: number;
        lon: number;
        timezone: string;
        isp: string;
        org: string;
      };

      if (data.status !== "success") return `IP lookup failed for: ${ip}`;

      return [
        `**IP:** ${data.query}`,
        `  Pays: ${data.country}`,
        `  Région: ${data.regionName}`,
        `  Ville: ${data.city} ${data.zip}`,
        `  Coordonnées: ${data.lat}, ${data.lon}`,
        `  Fuseau: ${data.timezone}`,
        `  ISP: ${data.isp}`,
        `  Org: ${data.org}`,
      ].join("\n");
    } catch (err) {
      return `Erreur: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

registerSkill({
  name: "validate.phone",
  description: "Validate a phone number format and carrier lookup. Free via Abstract API.",
  argsSchema: {
    type: "object",
    properties: {
      phone: { type: "string", description: "Phone number (with country code, e.g. +14185551234)" },
    },
    required: ["phone"],
  },
  async execute(args): Promise<string> {
    const phone = String(args.phone);

    if (!config.abstractPhoneApiKey) {
      // Basic local validation
      const clean = phone.replace(/[\s\-\(\)]/g, "");
      const valid = /^\+?\d{10,15}$/.test(clean);
      return valid
        ? `${phone} — format valide (validation avancée nécessite ABSTRACT_PHONE_API_KEY)`
        : `${phone} — format INVALIDE (attendu: +14185551234)`;
    }

    try {
      const url = `https://phonevalidation.abstractapi.com/v1/?api_key=${config.abstractPhoneApiKey}&phone=${encodeURIComponent(phone)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) return `API error: ${res.status}`;

      const data = (await res.json()) as {
        phone: string;
        valid: boolean;
        format: { international: string; local: string };
        country: { name: string; code: string };
        location: string;
        type: string;
        carrier: string;
      };

      return [
        `**${data.format?.international || phone}**`,
        `  Valide: ${data.valid ? "oui" : "non ⚠️"}`,
        `  Type: ${data.type}`,
        `  Pays: ${data.country?.name} (${data.country?.code})`,
        `  Localisation: ${data.location || "N/A"}`,
        `  Opérateur: ${data.carrier || "N/A"}`,
      ].join("\n");
    } catch (err) {
      return `Erreur: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});
