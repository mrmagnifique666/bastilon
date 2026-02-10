/**
 * Built-in skills: hubspot.contact_create, hubspot.contact_update,
 * hubspot.contact_search, hubspot.deal_create, hubspot.deal_update,
 * hubspot.pipeline, hubspot.activity_log
 * Uses HubSpot REST API v3 via fetch.
 */
import { registerSkill } from "../loader.js";
import { log } from "../../utils/log.js";

const API = "https://api.hubapi.com";

function getKey(): string | null {
  return process.env.HUBSPOT_API_KEY || null;
}

function checkConfig(): string | null {
  if (!getKey()) return "HubSpot not configured. Set HUBSPOT_API_KEY in .env";
  return null;
}

async function hubFetch(method: string, path: string, body?: unknown): Promise<any> {
  const resp = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${getKey()}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (resp.status === 204) return { success: true };
  const data = await resp.json();
  if (!resp.ok) throw new Error(`HubSpot ${resp.status}: ${data.message || JSON.stringify(data)}`);
  return data;
}

registerSkill({
  name: "hubspot.contact_create",
  description: "Create a HubSpot contact.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      email: { type: "string", description: "Contact email" },
      firstName: { type: "string", description: "First name" },
      lastName: { type: "string", description: "Last name" },
      company: { type: "string", description: "Company name (optional)" },
      phone: { type: "string", description: "Phone number (optional)" },
    },
    required: ["email"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;

    try {
      const properties: Record<string, string> = { email: String(args.email) };
      if (args.firstName) properties.firstname = String(args.firstName);
      if (args.lastName) properties.lastname = String(args.lastName);
      if (args.company) properties.company = String(args.company);
      if (args.phone) properties.phone = String(args.phone);

      const data = await hubFetch("POST", "/crm/v3/objects/contacts", { properties });
      return `Contact created: id=${data.id} email=${args.email}`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

registerSkill({
  name: "hubspot.contact_update",
  description: "Update a HubSpot contact's properties.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      contactId: { type: "string", description: "Contact ID" },
      email: { type: "string", description: "Email (optional)" },
      firstName: { type: "string", description: "First name (optional)" },
      lastName: { type: "string", description: "Last name (optional)" },
      company: { type: "string", description: "Company (optional)" },
      phone: { type: "string", description: "Phone (optional)" },
    },
    required: ["contactId"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;

    try {
      const properties: Record<string, string> = {};
      if (args.email) properties.email = String(args.email);
      if (args.firstName) properties.firstname = String(args.firstName);
      if (args.lastName) properties.lastname = String(args.lastName);
      if (args.company) properties.company = String(args.company);
      if (args.phone) properties.phone = String(args.phone);

      if (Object.keys(properties).length === 0) return "No properties to update.";
      await hubFetch("PATCH", `/crm/v3/objects/contacts/${args.contactId}`, { properties });
      return `Contact ${args.contactId} updated.`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

registerSkill({
  name: "hubspot.contact_search",
  description: "Search HubSpot contacts.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query (name, email, company)" },
    },
    required: ["query"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;

    try {
      const data = await hubFetch("POST", "/crm/v3/objects/contacts/search", {
        filterGroups: [{
          filters: [{
            propertyName: "email",
            operator: "CONTAINS_TOKEN",
            value: String(args.query),
          }],
        }],
        properties: ["email", "firstname", "lastname", "company", "phone"],
        limit: 20,
      });
      const contacts = data.results || [];
      if (!contacts.length) return `No contacts found for "${args.query}"`;
      const lines = contacts.map((c: any) => {
        const p = c.properties;
        return `[${c.id}] ${p.firstname || ""} ${p.lastname || ""} — ${p.email || ""} | ${p.company || ""}`;
      });
      return `**Contacts (${contacts.length}):**\n${lines.join("\n")}`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

registerSkill({
  name: "hubspot.deal_create",
  description: "Create a HubSpot deal.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Deal name" },
      amount: { type: "number", description: "Deal amount" },
      stage: { type: "string", description: "Pipeline stage ID" },
      contactId: { type: "string", description: "Associated contact ID (optional)" },
    },
    required: ["name", "amount", "stage"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;

    try {
      const properties: Record<string, string | number> = {
        dealname: String(args.name),
        amount: Number(args.amount),
        dealstage: String(args.stage),
      };
      const data = await hubFetch("POST", "/crm/v3/objects/deals", { properties });

      // Associate contact if provided
      if (args.contactId) {
        await hubFetch("PUT", `/crm/v3/objects/deals/${data.id}/associations/contacts/${args.contactId}/deal_to_contact`);
      }
      return `Deal created: id=${data.id} "${args.name}" $${args.amount}`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

registerSkill({
  name: "hubspot.deal_update",
  description: "Update a HubSpot deal.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      dealId: { type: "string", description: "Deal ID" },
      stage: { type: "string", description: "New stage (optional)" },
      amount: { type: "number", description: "New amount (optional)" },
    },
    required: ["dealId"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;

    try {
      const properties: Record<string, string | number> = {};
      if (args.stage) properties.dealstage = String(args.stage);
      if (args.amount) properties.amount = Number(args.amount);
      if (Object.keys(properties).length === 0) return "No properties to update.";
      await hubFetch("PATCH", `/crm/v3/objects/deals/${args.dealId}`, { properties });
      return `Deal ${args.dealId} updated.`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

registerSkill({
  name: "hubspot.pipeline",
  description: "Get pipeline stages.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      pipelineId: { type: "string", description: "Pipeline ID (default: default)" },
    },
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;

    try {
      const pipelineId = String(args.pipelineId || "default");
      const data = await hubFetch("GET", `/crm/v3/pipelines/deals/${pipelineId}`);
      const stages = data.stages || [];
      const lines = stages
        .sort((a: any, b: any) => a.displayOrder - b.displayOrder)
        .map((s: any) => `${s.displayOrder}. [${s.id}] ${s.label} (${(s.metadata?.probability || 0) * 100}%)`);
      return `**Pipeline "${data.label || pipelineId}":**\n${lines.join("\n")}`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

registerSkill({
  name: "hubspot.activity_log",
  description: "Log a note/activity on a HubSpot contact.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      contactId: { type: "string", description: "Contact ID" },
      note: { type: "string", description: "Note content" },
    },
    required: ["contactId", "note"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;

    try {
      const data = await hubFetch("POST", "/crm/v3/objects/notes", {
        properties: {
          hs_note_body: String(args.note),
          hs_timestamp: new Date().toISOString(),
        },
      });
      // Associate with contact
      await hubFetch("PUT", `/crm/v3/objects/notes/${data.id}/associations/contacts/${args.contactId}/note_to_contact`);
      return `Activity logged on contact ${args.contactId}: id=${data.id}`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

log.debug("Registered 7 hubspot.* skills");
