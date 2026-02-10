/**
 * Built-in skills: contacts.add, contacts.list, contacts.search, contacts.delete
 * SQLite-backed contact book / mini CRM.
 */
import { registerSkill } from "../loader.js";
import { getDb } from "../../storage/store.js";

function ensureTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      company TEXT,
      role TEXT,
      notes TEXT,
      tags TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_contacts_name ON contacts(name);
  `);
}

registerSkill({
  name: "contacts.add",
  description: "Add a new contact to the CRM. Provide at least a name.",
  argsSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Full name" },
      email: { type: "string", description: "Email address" },
      phone: { type: "string", description: "Phone number" },
      company: { type: "string", description: "Company name" },
      role: { type: "string", description: "Job title / role" },
      notes: { type: "string", description: "Free-text notes about this contact" },
      tags: { type: "string", description: "Comma-separated tags (e.g. 'client,broker,montreal')" },
    },
    required: ["name"],
  },
  async execute(args): Promise<string> {
    ensureTable();
    const db = getDb();
    const info = db
      .prepare(
        `INSERT INTO contacts (name, email, phone, company, role, notes, tags)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        args.name as string,
        (args.email as string) || null,
        (args.phone as string) || null,
        (args.company as string) || null,
        (args.role as string) || null,
        (args.notes as string) || null,
        (args.tags as string) || null
      );
    return `Contact #${info.lastInsertRowid} added: ${args.name}`;
  },
});

registerSkill({
  name: "contacts.list",
  description: "List all contacts, optionally filtered by tag.",
  argsSchema: {
    type: "object",
    properties: {
      tag: { type: "string", description: "Filter by tag (optional)" },
      limit: { type: "number", description: "Max results (default 20)" },
    },
  },
  async execute(args): Promise<string> {
    ensureTable();
    const db = getDb();
    const limit = Math.min(Number(args.limit) || 20, 100);
    const tag = args.tag as string | undefined;

    let rows: any[];
    if (tag) {
      rows = db
        .prepare(
          "SELECT * FROM contacts WHERE tags LIKE ? ORDER BY name ASC LIMIT ?"
        )
        .all(`%${tag}%`, limit);
    } else {
      rows = db
        .prepare("SELECT * FROM contacts ORDER BY name ASC LIMIT ?")
        .all(limit);
    }

    if (rows.length === 0) return tag ? `No contacts with tag "${tag}".` : "No contacts yet.";

    return rows
      .map((c: any) => {
        const parts = [`#${c.id} ${c.name}`];
        if (c.company) parts.push(`@ ${c.company}`);
        if (c.role) parts.push(`(${c.role})`);
        if (c.email) parts.push(`| ${c.email}`);
        if (c.phone) parts.push(`| ${c.phone}`);
        if (c.tags) parts.push(`[${c.tags}]`);
        return parts.join(" ");
      })
      .join("\n");
  },
});

registerSkill({
  name: "contacts.search",
  description: "Search contacts by name, email, company, or notes.",
  argsSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
    },
    required: ["query"],
  },
  async execute(args): Promise<string> {
    ensureTable();
    const db = getDb();
    const q = `%${args.query as string}%`;
    const rows = db
      .prepare(
        `SELECT * FROM contacts
         WHERE name LIKE ? OR email LIKE ? OR company LIKE ? OR notes LIKE ? OR tags LIKE ?
         ORDER BY name ASC LIMIT 20`
      )
      .all(q, q, q, q, q) as any[];

    if (rows.length === 0) return `No contacts matching "${args.query}".`;

    return rows
      .map((c: any) => {
        const parts = [`#${c.id} ${c.name}`];
        if (c.company) parts.push(`@ ${c.company}`);
        if (c.email) parts.push(`| ${c.email}`);
        if (c.phone) parts.push(`| ${c.phone}`);
        if (c.notes) parts.push(`— ${c.notes.slice(0, 60)}`);
        return parts.join(" ");
      })
      .join("\n");
  },
});

registerSkill({
  name: "contacts.update",
  description: "Update an existing contact by ID. Only provided fields are changed.",
  argsSchema: {
    type: "object",
    properties: {
      id: { type: "number", description: "Contact ID to update" },
      name: { type: "string", description: "New name" },
      email: { type: "string", description: "New email" },
      phone: { type: "string", description: "New phone" },
      company: { type: "string", description: "New company" },
      role: { type: "string", description: "New role" },
      notes: { type: "string", description: "New notes" },
      tags: { type: "string", description: "New tags" },
    },
    required: ["id"],
  },
  async execute(args): Promise<string> {
    ensureTable();
    const db = getDb();
    const id = args.id as number;
    const existing = db.prepare("SELECT * FROM contacts WHERE id = ?").get(id) as any;
    if (!existing) return `Contact #${id} not found.`;

    const fields = ["name", "email", "phone", "company", "role", "notes", "tags"];
    const updates: string[] = [];
    const values: any[] = [];
    for (const f of fields) {
      if (args[f] !== undefined) {
        updates.push(`${f} = ?`);
        values.push(args[f]);
      }
    }
    if (updates.length === 0) return "No fields to update.";

    updates.push("updated_at = unixepoch()");
    values.push(id);
    db.prepare(`UPDATE contacts SET ${updates.join(", ")} WHERE id = ?`).run(...values);
    return `Contact #${id} updated.`;
  },
});

registerSkill({
  name: "contacts.delete",
  description: "Delete a contact by ID.",
  argsSchema: {
    type: "object",
    properties: {
      id: { type: "number", description: "Contact ID to delete" },
    },
    required: ["id"],
  },
  async execute(args): Promise<string> {
    ensureTable();
    const db = getDb();
    const info = db.prepare("DELETE FROM contacts WHERE id = ?").run(args.id as number);
    if (info.changes === 0) return `Contact #${args.id} not found.`;
    return `Contact #${args.id} deleted.`;
  },
});
