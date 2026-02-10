/**
 * Built-in skill: notes (add / list / search / delete)
 * Persistent SQLite-backed note store.
 */
import { registerSkill } from "../loader.js";
import { getDb } from "../../storage/store.js";
import { annotateWithTrust } from "../../memory/trust-decay.js";

registerSkill({
  name: "notes.add",
  description: "Add a new note.",
  argsSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "The note content" },
    },
    required: ["text"],
  },
  async execute(args): Promise<string> {
    const text = args.text as string;
    const db = getDb();
    const info = db
      .prepare("INSERT INTO notes (text) VALUES (?)")
      .run(text);
    return `Note #${info.lastInsertRowid} saved.`;
  },
});

registerSkill({
  name: "notes.list",
  description: "List all saved notes.",
  argsSchema: {
    type: "object",
    properties: {},
  },
  async execute(): Promise<string> {
    const db = getDb();
    const rows = db
      .prepare("SELECT id, text, created_at FROM notes ORDER BY id ASC")
      .all() as { id: number; text: string; created_at: number }[];
    if (rows.length === 0) return "No notes yet.";
    return annotateWithTrust(rows, "observation");
  },
});

registerSkill({
  name: "notes.search",
  description: "Search notes by keyword.",
  argsSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search keyword" },
    },
    required: ["query"],
  },
  async execute(args): Promise<string> {
    const query = args.query as string;
    const db = getDb();
    const rows = db
      .prepare("SELECT id, text FROM notes WHERE text LIKE ? ORDER BY id ASC")
      .all(`%${query}%`) as { id: number; text: string }[];
    if (rows.length === 0) return `No notes matching "${query}".`;
    return rows.map((n) => `#${n.id}: ${n.text}`).join("\n");
  },
});

registerSkill({
  name: "notes.delete",
  description: "Delete a note by its ID.",
  argsSchema: {
    type: "object",
    properties: {
      id: { type: "number", description: "Note ID to delete" },
    },
    required: ["id"],
  },
  async execute(args): Promise<string> {
    const id = args.id as number;
    const db = getDb();
    const info = db.prepare("DELETE FROM notes WHERE id = ?").run(id);
    if (info.changes === 0) return `Note #${id} not found.`;
    return `Note #${id} deleted.`;
  },
});
