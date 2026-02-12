/**
 * Built-in skills: client.onboard, client.list, client.update, client.followup, client.proposal
 * Client relationship management for autonomous business operations.
 */
import { registerSkill } from "../loader.js";
import { getDb, kgUpsertEntity, kgGetEntity } from "../../storage/store.js";
import { log } from "../../utils/log.js";

interface ClientRow {
  id: number;
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  status: string;
  needs: string | null;
  notes: string | null;
  last_contact_at: number | null;
  created_at: number;
  updated_at: number;
}

registerSkill({
  name: "client.onboard",
  description:
    "Create a new client/lead in the CRM. Use this when a potential client is identified.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Client name" },
      email: { type: "string", description: "Email address" },
      phone: { type: "string", description: "Phone number" },
      company: { type: "string", description: "Company name" },
      needs: { type: "string", description: "What the client needs" },
      status: { type: "string", description: "Status: lead, prospect, active (default: lead)" },
      notes: { type: "string", description: "Additional notes" },
    },
    required: ["name"],
  },
  async execute(args): Promise<string> {
    const d = getDb();
    const info = d
      .prepare(
        "INSERT INTO clients (name, email, phone, company, status, needs, notes) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        String(args.name),
        args.email ? String(args.email) : null,
        args.phone ? String(args.phone) : null,
        args.company ? String(args.company) : null,
        String(args.status || "lead"),
        args.needs ? String(args.needs) : null,
        args.notes ? String(args.notes) : null,
      );

    return `Client #${info.lastInsertRowid} created: ${args.name} [${args.status || "lead"}]${args.company ? ` @ ${args.company}` : ""}`;
  },
});

registerSkill({
  name: "client.list",
  description: "List clients, optionally filtered by status.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      status: {
        type: "string",
        description: "Filter: lead, prospect, active, inactive (default: all)",
      },
      limit: { type: "number", description: "Max results (default: 20)" },
    },
  },
  async execute(args): Promise<string> {
    const d = getDb();
    const status = args.status as string | undefined;
    const limit = (args.limit as number) || 20;

    let rows: ClientRow[];
    if (status) {
      rows = d
        .prepare("SELECT * FROM clients WHERE status = ? ORDER BY updated_at DESC LIMIT ?")
        .all(status, limit) as ClientRow[];
    } else {
      rows = d
        .prepare("SELECT * FROM clients ORDER BY updated_at DESC LIMIT ?")
        .all(limit) as ClientRow[];
    }

    if (rows.length === 0) return "No clients found.";

    return rows
      .map((c) => {
        const lastContact = c.last_contact_at
          ? new Date(c.last_contact_at * 1000).toLocaleDateString("fr-CA", { timeZone: "America/Toronto" })
          : "jamais";
        return (
          `**#${c.id} ${c.name}** [${c.status}]` +
          (c.company ? ` @ ${c.company}` : "") +
          `\n  ${c.email || ""} ${c.phone || ""}` +
          `\n  Besoins: ${c.needs || "N/A"}` +
          `\n  Dernier contact: ${lastContact}`
        );
      })
      .join("\n\n");
  },
});

registerSkill({
  name: "client.update",
  description: "Update a client's info: status, notes, needs, contact date, etc.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      id: { type: "number", description: "Client ID" },
      status: { type: "string", description: "New status: lead, prospect, active, inactive" },
      needs: { type: "string", description: "Updated needs" },
      notes: { type: "string", description: "New notes (appended to existing)" },
      contacted: {
        type: "string",
        description: "Set to 'now' to update last_contact_at to current time",
      },
    },
    required: ["id"],
  },
  async execute(args): Promise<string> {
    const clientId = args.id as number;
    const d = getDb();

    const row = d.prepare("SELECT * FROM clients WHERE id = ?").get(clientId) as ClientRow | undefined;
    if (!row) return `Client #${clientId} not found.`;

    const updates: string[] = [];
    const params: unknown[] = [];

    if (args.status) {
      updates.push("status = ?");
      params.push(String(args.status));
    }
    if (args.needs) {
      updates.push("needs = ?");
      params.push(String(args.needs));
    }
    if (args.notes) {
      const existing = row.notes || "";
      const combined = existing ? `${existing}\n---\n${args.notes}` : String(args.notes);
      updates.push("notes = ?");
      params.push(combined);
    }
    if (args.contacted === "now") {
      updates.push("last_contact_at = unixepoch()");
      updates.push("interaction_count = interaction_count + 1");
    }

    if (updates.length === 0) return "Nothing to update.";

    updates.push("updated_at = unixepoch()");
    params.push(clientId);

    d.prepare(`UPDATE clients SET ${updates.join(", ")} WHERE id = ?`).run(...params);

    // Auto-rescore after update
    try {
      const updated = d.prepare("SELECT * FROM clients WHERE id = ?").get(clientId) as any;
      if (updated) {
        const newScore = computeClientScore(updated);
        d.prepare("UPDATE clients SET score = ? WHERE id = ?").run(newScore, clientId);
      }
    } catch (e) { log.debug(`[client.update] Auto-rescore failed: ${e}`); }

    return `Client #${clientId} (${row.name}) updated: ${updates.filter((u) => !u.includes("updated_at") && !u.includes("interaction_count")).join(", ")}`;
  },
});

registerSkill({
  name: "client.followup",
  description:
    "Check which clients need follow-up (no contact in N days). Suggests actions.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      days: {
        type: "number",
        description: "Days since last contact to trigger followup (default: 7)",
      },
    },
  },
  async execute(args): Promise<string> {
    const days = (args.days as number) || 7;
    const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
    const d = getDb();

    const stale = d
      .prepare(
        `SELECT * FROM clients
         WHERE status IN ('lead', 'prospect', 'active')
         AND (last_contact_at IS NULL OR last_contact_at < ?)
         ORDER BY last_contact_at ASC NULLS FIRST LIMIT 20`,
      )
      .all(cutoff) as ClientRow[];

    if (stale.length === 0) {
      return `Tous les clients actifs ont été contactés dans les ${days} derniers jours.`;
    }

    let output = `**${stale.length} client(s) à relancer** (>${days} jours sans contact):\n\n`;

    for (const c of stale) {
      const daysSince = c.last_contact_at
        ? Math.round((Date.now() / 1000 - c.last_contact_at) / 86400)
        : "jamais contacté";
      const action =
        c.status === "lead"
          ? "→ Premier contact recommandé"
          : c.status === "prospect"
            ? "→ Relance proposition"
            : "→ Suivi satisfaction";

      output +=
        `**#${c.id} ${c.name}** [${c.status}]` +
        (c.company ? ` @ ${c.company}` : "") +
        `\n  Depuis: ${daysSince}${typeof daysSince === "number" ? " jours" : ""}` +
        `\n  ${c.email ? `Email: ${c.email}` : ""}` +
        `\n  ${action}\n\n`;
    }

    return output;
  },
});

registerSkill({
  name: "client.proposal",
  description:
    "Generate a formatted business proposal for a client based on their needs.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      client_id: { type: "number", description: "Client ID" },
      services: {
        type: "string",
        description: 'JSON array of {name, description, price}, e.g. [{"name":"Website","description":"Modern responsive site","price":2000}]',
      },
      validity_days: { type: "number", description: "Proposal validity in days (default: 15)" },
    },
    required: ["client_id", "services"],
  },
  async execute(args): Promise<string> {
    const clientId = args.client_id as number;
    const validityDays = (args.validity_days as number) || 15;
    const d = getDb();

    const client = d.prepare("SELECT * FROM clients WHERE id = ?").get(clientId) as ClientRow | undefined;
    if (!client) return `Client #${clientId} not found.`;

    let services: Array<{ name: string; description: string; price: number }>;
    try {
      services = JSON.parse(String(args.services));
      if (!Array.isArray(services)) throw new Error("not array");
    } catch {
      return 'Error: services must be a JSON array of {name, description, price}.';
    }

    const total = services.reduce((sum, s) => sum + (s.price || 0), 0);
    const validUntil = new Date(Date.now() + validityDays * 86400000).toLocaleDateString("fr-CA", {
      timeZone: "America/Toronto",
    });

    let proposal = `**PROPOSITION COMMERCIALE**\n\n`;
    proposal += `**Pour:** ${client.name}${client.company ? ` (${client.company})` : ""}\n`;
    proposal += `**Date:** ${new Date().toLocaleDateString("fr-CA", { timeZone: "America/Toronto" })}\n`;
    proposal += `**Validité:** ${validUntil}\n\n`;

    if (client.needs) {
      proposal += `**Contexte:** ${client.needs}\n\n`;
    }

    proposal += `**Services proposés:**\n\n`;
    proposal += `| Service | Description | Prix |\n|---|---|---|\n`;
    for (const s of services) {
      proposal += `| ${s.name} | ${s.description} | ${s.price} CAD |\n`;
    }
    proposal += `\n**Total: ${total} CAD** (taxes en sus)\n\n`;
    proposal += `---\n*Proposition générée par Kingston — Q+ Intelligence*`;

    // Update last contact
    d.prepare(
      "UPDATE clients SET last_contact_at = unixepoch(), updated_at = unixepoch() WHERE id = ?",
    ).run(clientId);

    return proposal;
  },
});

// ── Contact Scoring Intelligence ──

function computeClientScore(client: any): number {
  let score = 50;
  const now = Math.floor(Date.now() / 1000);

  // +2 per interaction (max +20)
  const interactions = Math.min(10, client.interaction_count || 0);
  score += interactions * 2;

  // Recency bonus/penalty
  if (client.last_contact_at) {
    const daysSince = (now - client.last_contact_at) / 86400;
    if (daysSince < 7) score += 10;
    else if (daysSince < 30) score += 5;
    else if (daysSince > 90) score -= 10;
  }

  // Commitment stage bonus
  const stageBonus: Record<string, number> = {
    cold: 0, warm: 5, engaged: 10, customer: 15, advocate: 20,
  };
  score += stageBonus[client.commitment_stage] || 0;

  // Profile completeness
  if (client.email && client.phone) score += 5;
  if (client.company) score += 3;
  if (client.needs) score += 5;

  return Math.max(0, Math.min(100, score));
}

registerSkill({
  name: "client.score",
  description: "Calculate/recalculate client scores. Call with id for one client, or without to rescore all.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      id: { type: "number", description: "Client ID (optional — omit to rescore all)" },
    },
  },
  async execute(args): Promise<string> {
    const d = getDb();

    if (args.id) {
      const client = d.prepare("SELECT * FROM clients WHERE id = ?").get(args.id as number) as any;
      if (!client) return `Client #${args.id} not found.`;
      const newScore = computeClientScore(client);
      d.prepare("UPDATE clients SET score = ? WHERE id = ?").run(newScore, client.id);
      return `Client #${client.id} (${client.name}): score = ${newScore}/100`;
    }

    // Rescore all
    const clients = d.prepare("SELECT * FROM clients").all() as any[];
    let updated = 0;
    for (const client of clients) {
      const newScore = computeClientScore(client);
      d.prepare("UPDATE clients SET score = ? WHERE id = ?").run(newScore, client.id);
      updated++;
    }
    return `${updated} client(s) rescored.`;
  },
});

registerSkill({
  name: "client.smart_search",
  description: "Search clients across name, company, needs, notes. Results sorted by score (highest first).",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      limit: { type: "number", description: "Max results (default: 10)" },
    },
    required: ["query"],
  },
  async execute(args): Promise<string> {
    const query = `%${String(args.query)}%`;
    const limit = Number(args.limit) || 10;
    const d = getDb();

    const rows = d.prepare(
      `SELECT * FROM clients
       WHERE name LIKE ? OR company LIKE ? OR needs LIKE ? OR notes LIKE ?
       ORDER BY score DESC, updated_at DESC LIMIT ?`
    ).all(query, query, query, query, limit) as any[];

    if (rows.length === 0) return `Aucun client trouvé pour "${args.query}".`;

    return rows.map((c: any) => {
      const lastContact = c.last_contact_at
        ? new Date(c.last_contact_at * 1000).toLocaleDateString("fr-CA", { timeZone: "America/Toronto" })
        : "jamais";
      return (
        `**#${c.id} ${c.name}** [${c.status}] Score: ${c.score || 50}/100` +
        (c.company ? ` @ ${c.company}` : "") +
        `\n  ${c.email || ""} ${c.phone || ""}` +
        `\n  Besoins: ${c.needs || "N/A"} | Contact: ${lastContact}`
      );
    }).join("\n\n");
  },
});

registerSkill({
  name: "client.learn",
  description: "Store client intelligence config in KG (skip_domains, prefer_titles, min_exchanges for prospection).",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      key: { type: "string", description: "Config key: skip_domains, prefer_titles, min_exchanges" },
      value: { type: "string", description: "Config value (JSON array for lists, number for min_exchanges)" },
    },
    required: ["key", "value"],
  },
  async execute(args): Promise<string> {
    const key = String(args.key);
    const value = String(args.value);
    const allowed = ["skip_domains", "prefer_titles", "min_exchanges"];
    if (!allowed.includes(key)) {
      return `Clé invalide. Clés supportées: ${allowed.join(", ")}`;
    }

    kgUpsertEntity(`client_config:${key}`, "config", { value });
    return `Client intelligence config stockée: ${key} = ${value}`;
  },
});
