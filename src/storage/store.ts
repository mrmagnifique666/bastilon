/**
 * Conversation memory store using SQLite (via better-sqlite3).
 * Stores the last N turns per chat for context continuity.
 */
import Database from "better-sqlite3";
import path from "node:path";
import { config } from "../config/env.js";
import { log } from "../utils/log.js";

export interface Turn {
  role: "user" | "assistant";
  content: string;
}

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    const dbPath = path.resolve("relay.db");
    db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_turns_chat ON turns(chat_id, id);

      CREATE TABLE IF NOT EXISTS notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS sessions (
        chat_id INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS admin_sessions (
        user_id INTEGER PRIMARY KEY,
        authenticated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS error_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL DEFAULT (unixepoch()),
        error_message TEXT NOT NULL,
        stack TEXT,
        context TEXT,
        tool_name TEXT,
        pattern_key TEXT,
        resolution_type TEXT,
        resolved INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_error_resolved ON error_log(resolved, timestamp DESC);

      CREATE TABLE IF NOT EXISTS agent_state (
        agent_id TEXT PRIMARY KEY,
        cycle INTEGER NOT NULL DEFAULT 0,
        total_runs INTEGER NOT NULL DEFAULT 0,
        last_run_at INTEGER,
        last_error TEXT,
        consecutive_errors INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS agent_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        cycle INTEGER NOT NULL,
        started_at INTEGER NOT NULL,
        duration_ms INTEGER,
        outcome TEXT NOT NULL DEFAULT 'success',
        error_msg TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_agent_runs_agent ON agent_runs(agent_id, started_at DESC);

      CREATE TABLE IF NOT EXISTS memory_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL DEFAULT 'knowledge',
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        embedding TEXT,
        salience REAL NOT NULL DEFAULT 0.5,
        access_count INTEGER NOT NULL DEFAULT 0,
        last_accessed_at INTEGER NOT NULL DEFAULT (unixepoch()),
        source TEXT DEFAULT 'auto',
        chat_id INTEGER,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_hash ON memory_items(content_hash);
      CREATE INDEX IF NOT EXISTS idx_memory_category ON memory_items(category);
      CREATE INDEX IF NOT EXISTS idx_memory_salience ON memory_items(salience DESC);
    `);
    // Migrate: add new columns to error_log if missing
    try {
      const cols = db.prepare("PRAGMA table_info(error_log)").all() as Array<{ name: string }>;
      const colNames = new Set(cols.map((c) => c.name));
      if (!colNames.has("tool_name")) {
        db.exec("ALTER TABLE error_log ADD COLUMN tool_name TEXT");
      }
      if (!colNames.has("pattern_key")) {
        db.exec("ALTER TABLE error_log ADD COLUMN pattern_key TEXT");
      }
      if (!colNames.has("resolution_type")) {
        db.exec("ALTER TABLE error_log ADD COLUMN resolution_type TEXT");
      }
    } catch { /* columns may already exist */ }

    // Create indexes for new columns (safe to run after migration)
    try {
      db.exec(`CREATE INDEX IF NOT EXISTS idx_error_tool ON error_log(tool_name)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_error_pattern ON error_log(pattern_key)`);
    } catch { /* indexes may already exist */ }

    log.info(`SQLite store initialised at ${dbPath}`);
  }
  return db;
}

export function addTurn(chatId: number, turn: Turn): void {
  const d = getDb();
  d.prepare("INSERT INTO turns (chat_id, role, content) VALUES (?, ?, ?)").run(
    chatId,
    turn.role,
    turn.content
  );

  // Prune old turns beyond the configured limit
  const count = d
    .prepare("SELECT COUNT(*) as c FROM turns WHERE chat_id = ?")
    .get(chatId) as { c: number };

  if (count.c > config.memoryTurns) {
    const excess = count.c - config.memoryTurns;
    d.prepare(
      `DELETE FROM turns WHERE id IN (
        SELECT id FROM turns WHERE chat_id = ? ORDER BY id ASC LIMIT ?
      )`
    ).run(chatId, excess);
  }
}

export function getTurns(chatId: number): Turn[] {
  const d = getDb();
  const rows = d
    .prepare(
      "SELECT role, content FROM turns WHERE chat_id = ? ORDER BY id ASC"
    )
    .all(chatId) as Turn[];
  return rows;
}

export function clearTurns(chatId: number): void {
  const d = getDb();
  d.prepare("DELETE FROM turns WHERE chat_id = ?").run(chatId);
  log.info(`Cleared conversation for chat ${chatId}`);
}

export function getSession(chatId: number): string | null {
  const d = getDb();
  const row = d
    .prepare("SELECT session_id FROM sessions WHERE chat_id = ?")
    .get(chatId) as { session_id: string } | undefined;
  return row?.session_id ?? null;
}

export function saveSession(chatId: number, sessionId: string): void {
  const d = getDb();
  d.prepare(
    `INSERT INTO sessions (chat_id, session_id, updated_at) VALUES (?, ?, unixepoch())
     ON CONFLICT(chat_id) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at`
  ).run(chatId, sessionId);
  log.debug(`Saved session ${sessionId} for chat ${chatId}`);
}

export function clearSession(chatId: number): void {
  const d = getDb();
  d.prepare("DELETE FROM sessions WHERE chat_id = ?").run(chatId);
  log.debug(`Cleared session for chat ${chatId}`);
}

// --- Admin sessions (persistent across restarts) ---

const ADMIN_EXPIRY_SECONDS = 7 * 24 * 60 * 60; // 7 days

export function saveAdminSession(userId: number): void {
  const d = getDb();
  d.prepare(
    `INSERT INTO admin_sessions (user_id, authenticated_at) VALUES (?, unixepoch())
     ON CONFLICT(user_id) DO UPDATE SET authenticated_at = unixepoch()`
  ).run(userId);
}

export function isAdminSession(userId: number): boolean {
  const d = getDb();
  const row = d
    .prepare(
      "SELECT authenticated_at FROM admin_sessions WHERE user_id = ? AND (unixepoch() - authenticated_at) < ?",
    )
    .get(userId, ADMIN_EXPIRY_SECONDS) as { authenticated_at: number } | undefined;
  if (!row) {
    // Check if there's an expired session for diagnostics
    const expired = d
      .prepare("SELECT authenticated_at FROM admin_sessions WHERE user_id = ?")
      .get(userId) as { authenticated_at: number } | undefined;
    if (expired) {
      log.debug(`Admin session for user ${userId} expired (age: ${Math.round((Date.now() / 1000 - expired.authenticated_at) / 3600)}h)`);
    } else {
      log.debug(`No admin session found for user ${userId}`);
    }
  }
  return !!row;
}

export function clearAdminSession(userId: number): void {
  const d = getDb();
  d.prepare("DELETE FROM admin_sessions WHERE user_id = ?").run(userId);
}

// --- Error logging ---

export interface ErrorLogRow {
  id: number;
  timestamp: number;
  error_message: string;
  stack: string | null;
  context: string | null;
  resolved: number;
}

export function logError(error: Error | string, context?: string, toolName?: string): number {
  const d = getDb();
  const message = error instanceof Error ? error.message : error;
  const stack = error instanceof Error ? error.stack ?? null : null;

  // Feed into MISS/FIX auto-graduation system and get the pattern key
  let patternKey: string | null = null;
  try {
    const { recordErrorPattern } = require("../memory/self-review.js");
    recordErrorPattern(context || "unknown", message, toolName);
    // Derive pattern key for linking
    const tokens = message
      .toLowerCase()
      .replace(/["'`]/g, "")
      .replace(/[^a-z0-9_.\s]/g, " ")
      .split(/\s+/)
      .filter((w: string) => w.length > 2)
      .map((w: string) => w.replace(/\d+/g, "N"))
      .slice(0, 5)
      .sort()
      .join("_");
    patternKey = `${(context || "unknown")}:${tokens || "unknown"}`.toLowerCase();
  } catch { /* self-review module may not be loaded yet */ }

  const info = d
    .prepare(
      "INSERT INTO error_log (error_message, stack, context, tool_name, pattern_key) VALUES (?, ?, ?, ?, ?)",
    )
    .run(message, stack, context ?? null, toolName ?? null, patternKey);
  log.debug(`[error_log] Recorded error #${info.lastInsertRowid}: ${message.slice(0, 80)}`);

  return info.lastInsertRowid as number;
}

export function getErrorsByPattern(patternKey: string, limit = 20): ErrorLogRow[] {
  const d = getDb();
  return d
    .prepare("SELECT * FROM error_log WHERE pattern_key = ? ORDER BY id DESC LIMIT ?")
    .all(patternKey, limit) as ErrorLogRow[];
}

export function getErrorTrends(hours = 24): Array<{ hour: string; count: number; context: string | null }> {
  const d = getDb();
  const cutoff = Math.floor(Date.now() / 1000) - hours * 3600;
  return d
    .prepare(
      `SELECT strftime('%Y-%m-%d %H:00', timestamp, 'unixepoch', 'localtime') as hour,
              COUNT(*) as count,
              context
       FROM error_log WHERE timestamp > ?
       GROUP BY hour, context ORDER BY hour`,
    )
    .all(cutoff) as Array<{ hour: string; count: number; context: string | null }>;
}

export function autoResolveByPattern(patternKey: string): number {
  const d = getDb();
  const info = d
    .prepare(
      "UPDATE error_log SET resolved = 1, resolution_type = 'auto' WHERE pattern_key = ? AND resolved = 0",
    )
    .run(patternKey);
  return info.changes;
}

export function getRecentErrors(count = 20): ErrorLogRow[] {
  const d = getDb();
  return d
    .prepare("SELECT * FROM error_log ORDER BY id DESC LIMIT ?")
    .all(count) as ErrorLogRow[];
}

export function resolveError(id: number): boolean {
  const d = getDb();
  const info = d.prepare("UPDATE error_log SET resolved = 1 WHERE id = ?").run(id);
  return info.changes > 0;
}

/**
 * Delete old errors and expired admin sessions.
 * Called on startup and periodically by the scheduler.
 */
export function cleanupDatabase(errorMaxAgeDays = 30): { errors: number; sessions: number } {
  const d = getDb();
  const errorResult = d
    .prepare("DELETE FROM error_log WHERE resolved = 1 AND (unixepoch() - timestamp) > ?")
    .run(errorMaxAgeDays * 86400);
  const sessionResult = d
    .prepare("DELETE FROM admin_sessions WHERE (unixepoch() - authenticated_at) >= ?")
    .run(ADMIN_EXPIRY_SECONDS);
  const removed = { errors: errorResult.changes, sessions: sessionResult.changes };
  if (removed.errors > 0 || removed.sessions > 0) {
    log.info(`[cleanup] Removed ${removed.errors} old error(s), ${removed.sessions} expired session(s)`);
  }
  return removed;
}
