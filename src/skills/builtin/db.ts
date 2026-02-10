/**
 * Built-in skill: db.query
 * Run SQL queries against SQLite databases (admin only).
 */
import Database from "better-sqlite3";
import { registerSkill } from "../loader.js";

const MAX_ROWS = 100;

const WRITE_PREFIX = /^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i;

registerSkill({
  name: "db.query",
  description:
    "Run a SQL query against a SQLite database file and return the results (admin only).",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      database: {
        type: "string",
        description: "Path to the .db / .sqlite file",
      },
      sql: { type: "string", description: "SQL query to execute" },
    },
    required: ["database", "sql"],
  },
  async execute(args): Promise<string> {
    const dbPath = args.database as string;
    const sql = args.sql as string;

    const isWrite = WRITE_PREFIX.test(sql);
    let db: Database.Database | null = null;

    try {
      db = new Database(dbPath);

      // Enable read-only unless the query is a write operation
      if (!isWrite) {
        db.pragma("query_only = 1");
      }

      if (isWrite) {
        const result = db.prepare(sql).run();
        return `OK — changes: ${result.changes}, lastInsertRowid: ${result.lastInsertRowid}`;
      }

      const rows = db.prepare(sql).all() as Record<string, unknown>[];

      if (rows.length === 0) {
        return "(no rows returned)";
      }

      // Build a text table
      const columns = Object.keys(rows[0]);
      const display = rows.slice(0, MAX_ROWS);
      const lines: string[] = [];

      // Header
      lines.push(columns.join(" | "));
      lines.push(columns.map((c) => "-".repeat(c.length)).join("-+-"));

      // Rows
      for (const row of display) {
        lines.push(columns.map((c) => String(row[c] ?? "NULL")).join(" | "));
      }

      if (rows.length > MAX_ROWS) {
        lines.push(`\n...(${rows.length - MAX_ROWS} more rows omitted)`);
      }

      return lines.join("\n");
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      db?.close();
    }
  },
});
