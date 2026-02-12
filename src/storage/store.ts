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

      -- FTS5 virtual table for BM25 full-text search on memories
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_items_fts USING fts5(
        content,
        category,
        content='memory_items',
        content_rowid='id',
        tokenize='unicode61'
      );

      -- Triggers to keep FTS5 in sync with memory_items
      CREATE TRIGGER IF NOT EXISTS memory_items_ai AFTER INSERT ON memory_items BEGIN
        INSERT INTO memory_items_fts(rowid, content, category) VALUES (new.id, new.content, new.category);
      END;
      CREATE TRIGGER IF NOT EXISTS memory_items_ad AFTER DELETE ON memory_items BEGIN
        INSERT INTO memory_items_fts(memory_items_fts, rowid, content, category) VALUES ('delete', old.id, old.content, old.category);
      END;
      CREATE TRIGGER IF NOT EXISTS memory_items_au AFTER UPDATE ON memory_items BEGIN
        INSERT INTO memory_items_fts(memory_items_fts, rowid, content, category) VALUES ('delete', old.id, old.content, old.category);
        INSERT INTO memory_items_fts(rowid, content, category) VALUES (new.id, new.content, new.category);
      END;

      CREATE TABLE IF NOT EXISTS cron_jobs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        schedule_type TEXT NOT NULL,
        schedule_value TEXT NOT NULL,
        timezone TEXT NOT NULL DEFAULT 'America/Toronto',
        prompt TEXT NOT NULL,
        session_target TEXT NOT NULL DEFAULT 'isolated',
        delivery_mode TEXT NOT NULL DEFAULT 'announce',
        model_override TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        retry_count INTEGER NOT NULL DEFAULT 0,
        max_retries INTEGER NOT NULL DEFAULT 3,
        last_run_at INTEGER,
        next_run_at INTEGER,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_cron_next ON cron_jobs(enabled, next_run_at);

      CREATE TABLE IF NOT EXISTS agent_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_agent TEXT NOT NULL,
        to_agent TEXT NOT NULL,
        instruction TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        result TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        completed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_agent_tasks_to ON agent_tasks(to_agent, status);

      CREATE TABLE IF NOT EXISTS plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        goal TEXT NOT NULL,
        steps TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'pending',
        current_step INTEGER NOT NULL DEFAULT 0,
        created_by TEXT DEFAULT 'kingston',
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS revenue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        amount REAL NOT NULL,
        currency TEXT NOT NULL DEFAULT 'CAD',
        type TEXT NOT NULL DEFAULT 'income',
        status TEXT NOT NULL DEFAULT 'recorded',
        description TEXT,
        due_date INTEGER,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_revenue_type ON revenue(type, created_at DESC);

      CREATE TABLE IF NOT EXISTS clients (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT,
        phone TEXT,
        company TEXT,
        status TEXT NOT NULL DEFAULT 'lead',
        needs TEXT,
        notes TEXT,
        last_contact_at INTEGER,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_clients_status ON clients(status);

      CREATE TABLE IF NOT EXISTS content_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        topic TEXT NOT NULL,
        platform TEXT NOT NULL DEFAULT 'general',
        content_type TEXT NOT NULL DEFAULT 'post',
        body TEXT,
        status TEXT NOT NULL DEFAULT 'draft',
        scheduled_at INTEGER,
        published_at INTEGER,
        performance TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_content_status ON content_items(status, platform);

      CREATE TABLE IF NOT EXISTS conversation_summaries (
        chat_id INTEGER PRIMARY KEY,
        summary TEXT NOT NULL,
        turn_count INTEGER DEFAULT 0,
        topics TEXT DEFAULT '[]',
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS autonomous_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL,
        action TEXT NOT NULL,
        reasoning TEXT,
        outcome TEXT,
        status TEXT NOT NULL DEFAULT 'executed',
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_auto_decisions ON autonomous_decisions(category, created_at DESC);

      -- Knowledge Graph: entities and relationships
      CREATE TABLE IF NOT EXISTS kg_entities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        entity_type TEXT NOT NULL DEFAULT 'concept',
        properties TEXT DEFAULT '{}',
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_kg_entity_name ON kg_entities(name, entity_type);

      CREATE TABLE IF NOT EXISTS kg_relations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_entity_id INTEGER NOT NULL REFERENCES kg_entities(id),
        to_entity_id INTEGER NOT NULL REFERENCES kg_entities(id),
        relation_type TEXT NOT NULL,
        weight REAL NOT NULL DEFAULT 1.0,
        properties TEXT DEFAULT '{}',
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_kg_rel_from ON kg_relations(from_entity_id, relation_type);
      CREATE INDEX IF NOT EXISTS idx_kg_rel_to ON kg_relations(to_entity_id, relation_type);

      -- Episodic Memory: significant events journal
      CREATE TABLE IF NOT EXISTS episodic_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL DEFAULT 'interaction',
        summary TEXT NOT NULL,
        details TEXT,
        participants TEXT DEFAULT '[]',
        emotional_valence REAL DEFAULT 0.0,
        importance REAL NOT NULL DEFAULT 0.5,
        source TEXT DEFAULT 'auto',
        chat_id INTEGER,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_episodic_type ON episodic_events(event_type, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_episodic_importance ON episodic_events(importance DESC, created_at DESC);

      -- Behavioral Rules: self-improving rules engine
      CREATE TABLE IF NOT EXISTS behavioral_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rule_name TEXT NOT NULL UNIQUE,
        condition TEXT NOT NULL,
        action TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'general',
        priority INTEGER NOT NULL DEFAULT 50,
        enabled INTEGER NOT NULL DEFAULT 1,
        success_count INTEGER NOT NULL DEFAULT 0,
        fail_count INTEGER NOT NULL DEFAULT 0,
        proposed_by TEXT DEFAULT 'system',
        approved INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_rules_category ON behavioral_rules(category, enabled, priority DESC);

      -- Dungeon Master tables
      CREATE TABLE IF NOT EXISTS dungeon_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        setting TEXT,
        current_location TEXT DEFAULT 'Taverne du Dragon Endormi',
        turn_number INTEGER DEFAULT 0,
        status TEXT DEFAULT 'active',
        party_level INTEGER DEFAULT 1,
        notes TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS dungeon_characters (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        race TEXT DEFAULT 'Humain',
        class TEXT DEFAULT 'Guerrier',
        level INTEGER DEFAULT 1,
        hp INTEGER DEFAULT 10,
        hp_max INTEGER DEFAULT 10,
        stats TEXT,
        inventory TEXT,
        status TEXT DEFAULT 'alive',
        is_npc INTEGER DEFAULT 0,
        description TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_dungeon_chars_session ON dungeon_characters(session_id);

      CREATE TABLE IF NOT EXISTS dungeon_turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL,
        turn_number INTEGER NOT NULL,
        player_action TEXT,
        dm_narrative TEXT,
        dice_rolls TEXT,
        image_url TEXT,
        event_type TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_dungeon_turns_session ON dungeon_turns(session_id, turn_number DESC);
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

    // Migrate: populate FTS5 index from existing memory_items
    try {
      const ftsCount = (db.prepare("SELECT COUNT(*) as c FROM memory_items_fts").get() as { c: number }).c;
      const memCount = (db.prepare("SELECT COUNT(*) as c FROM memory_items").get() as { c: number }).c;
      if (ftsCount === 0 && memCount > 0) {
        db.exec("INSERT INTO memory_items_fts(rowid, content, category) SELECT id, content, category FROM memory_items");
        log.info(`[store] Populated FTS5 index with ${memCount} existing memories`);
      }
    } catch { /* FTS5 population may fail on first run */ }

    // LLM response cache table
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS llm_cache (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          prompt_hash TEXT NOT NULL,
          model TEXT NOT NULL,
          response TEXT NOT NULL,
          ttl_seconds INTEGER NOT NULL DEFAULT 3600,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE INDEX IF NOT EXISTS idx_llm_cache_lookup ON llm_cache(prompt_hash, model);
      `);
    } catch { /* table may already exist */ }

    // Migrate: add commitment_stage to clients if missing
    try {
      const clientCols = db.prepare("PRAGMA table_info(clients)").all() as Array<{ name: string }>;
      const clientColNames = new Set(clientCols.map((c) => c.name));
      if (!clientColNames.has("commitment_stage")) {
        db.exec("ALTER TABLE clients ADD COLUMN commitment_stage TEXT NOT NULL DEFAULT 'cold'");
      }
    } catch { /* column may already exist */ }

    // Migrate: add pillar, hook_type, embedding to content_items if missing
    try {
      const contentCols = db.prepare("PRAGMA table_info(content_items)").all() as Array<{ name: string }>;
      const contentColNames = new Set(contentCols.map((c) => c.name));
      if (!contentColNames.has("pillar")) {
        db.exec("ALTER TABLE content_items ADD COLUMN pillar TEXT");
      }
      if (!contentColNames.has("hook_type")) {
        db.exec("ALTER TABLE content_items ADD COLUMN hook_type TEXT");
      }
      if (!contentColNames.has("embedding")) {
        db.exec("ALTER TABLE content_items ADD COLUMN embedding TEXT");
      }
    } catch { /* columns may already exist */ }

    // Migrate: add score, tags, interaction_count to clients if missing
    try {
      const clCols = db.prepare("PRAGMA table_info(clients)").all() as Array<{ name: string }>;
      const clColNames = new Set(clCols.map((c) => c.name));
      if (!clColNames.has("score")) {
        db.exec("ALTER TABLE clients ADD COLUMN score INTEGER NOT NULL DEFAULT 50");
      }
      if (!clColNames.has("tags")) {
        db.exec("ALTER TABLE clients ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'");
      }
      if (!clColNames.has("interaction_count")) {
        db.exec("ALTER TABLE clients ADD COLUMN interaction_count INTEGER NOT NULL DEFAULT 0");
      }
    } catch { /* columns may already exist */ }

    // Knowledge ingestion tables
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS knowledge_sources (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          url TEXT,
          url_normalized TEXT UNIQUE,
          title TEXT,
          source_type TEXT NOT NULL DEFAULT 'article',
          summary TEXT,
          raw_content TEXT,
          content_hash TEXT UNIQUE,
          tags TEXT DEFAULT '[]',
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        );

        CREATE TABLE IF NOT EXISTS knowledge_chunks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id INTEGER NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
          chunk_index INTEGER NOT NULL,
          content TEXT NOT NULL,
          embedding TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE INDEX IF NOT EXISTS idx_kchunks_source ON knowledge_chunks(source_id);
      `);
    } catch { /* tables may already exist */ }

    // Council reports table
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS council_reports (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          date TEXT NOT NULL,
          phase1_json TEXT,
          phase2_json TEXT,
          phase3_json TEXT,
          final_recommendations TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
      `);
    } catch { /* table may already exist */ }

    // Notification tiering queue
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS notification_queue (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          level TEXT NOT NULL DEFAULT 'general',
          source TEXT NOT NULL,
          title TEXT NOT NULL,
          body TEXT NOT NULL,
          delivered INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE INDEX IF NOT EXISTS idx_notif_level ON notification_queue(level, delivered, created_at);
      `);
    } catch { /* table may already exist */ }

    // Goals table
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS goals (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          description TEXT,
          target_value REAL,
          current_value REAL NOT NULL DEFAULT 0,
          unit TEXT NOT NULL DEFAULT 'units',
          deadline TEXT,
          milestones TEXT DEFAULT '[]',
          status TEXT NOT NULL DEFAULT 'active',
          category TEXT NOT NULL DEFAULT 'business',
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
      `);
    } catch { /* table may already exist */ }

    // Price watches table
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS price_watches (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          product TEXT NOT NULL,
          url TEXT,
          target_price REAL,
          current_price REAL,
          lowest_price REAL,
          currency TEXT NOT NULL DEFAULT 'CAD',
          last_checked_at INTEGER,
          alert_sent INTEGER NOT NULL DEFAULT 0,
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
      `);
    } catch { /* table may already exist */ }

    // YouTube competitor tracking
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS youtube_competitors (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          channel_id TEXT NOT NULL UNIQUE,
          channel_name TEXT NOT NULL,
          last_video_count INTEGER DEFAULT 0,
          last_checked_at INTEGER,
          notes TEXT,
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE TABLE IF NOT EXISTS youtube_competitor_videos (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          competitor_id INTEGER NOT NULL REFERENCES youtube_competitors(id) ON DELETE CASCADE,
          video_id TEXT NOT NULL UNIQUE,
          title TEXT NOT NULL,
          published_at TEXT,
          views INTEGER DEFAULT 0,
          likes INTEGER DEFAULT 0,
          comments INTEGER DEFAULT 0,
          checked_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE INDEX IF NOT EXISTS idx_yt_comp_vid ON youtube_competitor_videos(competitor_id, checked_at DESC);
      `);
    } catch { /* tables may already exist */ }

    // Invoice tracking
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS invoices (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          vendor TEXT NOT NULL,
          amount REAL NOT NULL,
          currency TEXT NOT NULL DEFAULT 'CAD',
          category TEXT NOT NULL DEFAULT 'other',
          invoice_date TEXT,
          source TEXT DEFAULT 'manual',
          file_path TEXT,
          notes TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE INDEX IF NOT EXISTS idx_invoices_date ON invoices(invoice_date, category);
      `);
    } catch { /* table may already exist */ }

    // Job/opportunity tracking
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS job_opportunities (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          company TEXT,
          url TEXT,
          match_score INTEGER DEFAULT 0,
          salary_range TEXT,
          location TEXT,
          source TEXT DEFAULT 'search',
          status TEXT NOT NULL DEFAULT 'new',
          notes TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE INDEX IF NOT EXISTS idx_jobs_status ON job_opportunities(status, match_score DESC);
      `);
    } catch { /* table may already exist */ }

    log.info(`SQLite store initialised at ${dbPath}`);
  }
  return db;
}

// --- Conversation summaries ---

export interface ConversationSummary {
  chat_id: number;
  summary: string;
  turn_count: number;
  topics: string[];
  updated_at: number;
}

export function getSummary(chatId: number): ConversationSummary | null {
  const d = getDb();
  const row = d
    .prepare("SELECT * FROM conversation_summaries WHERE chat_id = ?")
    .get(chatId) as { chat_id: number; summary: string; turn_count: number; topics: string; updated_at: number } | undefined;
  if (!row) return null;
  let topics: string[] = [];
  try { topics = JSON.parse(row.topics); } catch { /* invalid JSON */ }
  return { ...row, topics };
}

export function saveSummary(chatId: number, summary: string, turnCount: number, topics: string[]): void {
  const d = getDb();
  d.prepare(
    `INSERT INTO conversation_summaries (chat_id, summary, turn_count, topics, updated_at)
     VALUES (?, ?, ?, ?, unixepoch())
     ON CONFLICT(chat_id) DO UPDATE SET
       summary = excluded.summary, turn_count = excluded.turn_count,
       topics = excluded.topics, updated_at = excluded.updated_at`
  ).run(chatId, summary, turnCount, JSON.stringify(topics));
  log.debug(`[summary] Saved summary for chat ${chatId} (${summary.length} chars, ${topics.length} topics)`);
}

export function addTurn(chatId: number, turn: Turn): void {
  const d = getDb();
  d.prepare("INSERT INTO turns (chat_id, role, content) VALUES (?, ?, ?)").run(
    chatId,
    turn.role,
    turn.content
  );

  // Prune old turns beyond the configured limit — with progressive summarization
  const count = d
    .prepare("SELECT COUNT(*) as c FROM turns WHERE chat_id = ?")
    .get(chatId) as { c: number };

  if (count.c > config.memoryTurns) {
    const excess = count.c - config.memoryTurns;

    // Grab turns that are about to be pruned for summarization
    const turnsToSummarize = d
      .prepare(
        `SELECT role, content FROM turns WHERE chat_id = ? ORDER BY id ASC LIMIT ?`
      )
      .all(chatId, excess) as Turn[];

    // Fire-and-forget summarization before pruning
    if (turnsToSummarize.length > 0) {
      import("../memory/summarizer.js").then((mod) => {
        mod.summarizeConversation(chatId, turnsToSummarize).catch((err: unknown) => {
          log.debug(`[summary] Fire-and-forget summarization failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      }).catch(() => { /* summarizer module not loaded */ });
    }

    d.prepare(
      `DELETE FROM turns WHERE id IN (
        SELECT id FROM turns WHERE chat_id = ? ORDER BY id ASC LIMIT ?
      )`
    ).run(chatId, excess);
  }
}

export function getTurns(chatId: number, limit?: number): Turn[] {
  const d = getDb();
  const maxTurns = limit || config.memoryTurns || 30;
  const rows = d
    .prepare(
      "SELECT role, content FROM turns WHERE chat_id = ? ORDER BY id DESC LIMIT ?"
    )
    .all(chatId, maxTurns) as Turn[];
  return rows.reverse(); // Return in chronological order
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
// Old cleanupDatabase moved to comprehensive version at bottom of file

// --- Autonomous decisions (Kingston Mind) ---

export interface AutonomousDecision {
  id: number;
  category: string;
  action: string;
  reasoning: string | null;
  outcome: string | null;
  status: string;
  created_at: number;
}

export function logDecision(
  category: string,
  action: string,
  reasoning?: string,
  outcome?: string,
  status: string = "executed",
): number {
  const d = getDb();
  const info = d
    .prepare(
      "INSERT INTO autonomous_decisions (category, action, reasoning, outcome, status) VALUES (?, ?, ?, ?, ?)",
    )
    .run(category, action, reasoning ?? null, outcome ?? null, status);
  log.info(`[mind] Decision #${info.lastInsertRowid}: [${category}] ${action.slice(0, 80)}`);
  return info.lastInsertRowid as number;
}

export function getRecentDecisions(limit = 10, category?: string): AutonomousDecision[] {
  const d = getDb();
  if (category) {
    return d
      .prepare(
        "SELECT * FROM autonomous_decisions WHERE category = ? ORDER BY created_at DESC LIMIT ?",
      )
      .all(category, limit) as AutonomousDecision[];
  }
  return d
    .prepare("SELECT * FROM autonomous_decisions ORDER BY created_at DESC LIMIT ?")
    .all(limit) as AutonomousDecision[];
}

export function getPendingQuestions(): AutonomousDecision[] {
  const d = getDb();
  return d
    .prepare(
      "SELECT * FROM autonomous_decisions WHERE status = 'pending_answer' ORDER BY created_at DESC",
    )
    .all() as AutonomousDecision[];
}

// --- Knowledge Graph ---

export interface KGEntity {
  id: number;
  name: string;
  entity_type: string;
  properties: Record<string, unknown>;
  created_at: number;
  updated_at: number;
}

export interface KGRelation {
  id: number;
  from_entity_id: number;
  to_entity_id: number;
  relation_type: string;
  weight: number;
  properties: Record<string, unknown>;
  created_at: number;
}

/** Upsert an entity — returns id */
export function kgUpsertEntity(name: string, entityType: string, properties?: Record<string, unknown>): number {
  const d = getDb();
  const props = JSON.stringify(properties || {});
  const existing = d
    .prepare("SELECT id FROM kg_entities WHERE name = ? AND entity_type = ?")
    .get(name, entityType) as { id: number } | undefined;
  if (existing) {
    d.prepare("UPDATE kg_entities SET properties = ?, updated_at = unixepoch() WHERE id = ?")
      .run(props, existing.id);
    return existing.id;
  }
  const info = d
    .prepare("INSERT INTO kg_entities (name, entity_type, properties) VALUES (?, ?, ?)")
    .run(name, entityType, props);
  log.debug(`[kg] Entity created: ${name} (${entityType}) #${info.lastInsertRowid}`);
  return info.lastInsertRowid as number;
}

/** Get entity by name + type */
export function kgGetEntity(name: string, entityType?: string): KGEntity | null {
  const d = getDb();
  const row = entityType
    ? d.prepare("SELECT * FROM kg_entities WHERE name = ? AND entity_type = ?").get(name, entityType)
    : d.prepare("SELECT * FROM kg_entities WHERE name = ? LIMIT 1").get(name);
  if (!row) return null;
  const r = row as any;
  let props = {};
  try { props = JSON.parse(r.properties); } catch { /* invalid JSON */ }
  return { ...r, properties: props };
}

/** Create a relation between two entities */
export function kgAddRelation(fromId: number, toId: number, relationType: string, weight = 1.0, properties?: Record<string, unknown>): number {
  const d = getDb();
  const props = JSON.stringify(properties || {});
  const info = d
    .prepare("INSERT INTO kg_relations (from_entity_id, to_entity_id, relation_type, weight, properties) VALUES (?, ?, ?, ?, ?)")
    .run(fromId, toId, relationType, weight, props);
  log.debug(`[kg] Relation: ${fromId} -[${relationType}]-> ${toId}`);
  return info.lastInsertRowid as number;
}

/** Get all relations from/to an entity */
export function kgGetRelations(entityId: number, direction: "from" | "to" | "both" = "both"): Array<KGRelation & { from_name: string; to_name: string }> {
  const d = getDb();
  let sql: string;
  if (direction === "from") {
    sql = `SELECT r.*, e1.name as from_name, e2.name as to_name FROM kg_relations r
           JOIN kg_entities e1 ON r.from_entity_id = e1.id
           JOIN kg_entities e2 ON r.to_entity_id = e2.id
           WHERE r.from_entity_id = ? ORDER BY r.weight DESC`;
  } else if (direction === "to") {
    sql = `SELECT r.*, e1.name as from_name, e2.name as to_name FROM kg_relations r
           JOIN kg_entities e1 ON r.from_entity_id = e1.id
           JOIN kg_entities e2 ON r.to_entity_id = e2.id
           WHERE r.to_entity_id = ? ORDER BY r.weight DESC`;
  } else {
    sql = `SELECT r.*, e1.name as from_name, e2.name as to_name FROM kg_relations r
           JOIN kg_entities e1 ON r.from_entity_id = e1.id
           JOIN kg_entities e2 ON r.to_entity_id = e2.id
           WHERE r.from_entity_id = ? OR r.to_entity_id = ? ORDER BY r.weight DESC`;
    return d.prepare(sql).all(entityId, entityId) as any[];
  }
  return d.prepare(sql).all(entityId) as any[];
}

/** Search entities by name pattern */
export function kgSearchEntities(query: string, limit = 20): KGEntity[] {
  const d = getDb();
  const rows = d
    .prepare("SELECT * FROM kg_entities WHERE name LIKE ? ORDER BY updated_at DESC LIMIT ?")
    .all(`%${query}%`, limit) as any[];
  return rows.map((r) => {
    let props = {};
    try { props = JSON.parse(r.properties); } catch { /* invalid */ }
    return { ...r, properties: props };
  });
}

/** Traverse: find all entities connected to a given entity within N hops */
export function kgTraverse(entityId: number, maxHops = 2): Array<{ entity: KGEntity; relation: string; depth: number }> {
  const d = getDb();
  const visited = new Set<number>([entityId]);
  const results: Array<{ entity: KGEntity; relation: string; depth: number }> = [];

  let frontier = [entityId];
  for (let depth = 1; depth <= maxHops && frontier.length > 0; depth++) {
    const nextFrontier: number[] = [];
    for (const fid of frontier) {
      const rels = d.prepare(
        `SELECT r.relation_type, r.to_entity_id as eid, e.* FROM kg_relations r
         JOIN kg_entities e ON r.to_entity_id = e.id
         WHERE r.from_entity_id = ?
         UNION
         SELECT r.relation_type, r.from_entity_id as eid, e.* FROM kg_relations r
         JOIN kg_entities e ON r.from_entity_id = e.id
         WHERE r.to_entity_id = ?`
      ).all(fid, fid) as any[];

      for (const rel of rels) {
        if (!visited.has(rel.eid)) {
          visited.add(rel.eid);
          let props = {};
          try { props = JSON.parse(rel.properties); } catch { /* */ }
          results.push({
            entity: { id: rel.id, name: rel.name, entity_type: rel.entity_type, properties: props, created_at: rel.created_at, updated_at: rel.updated_at },
            relation: rel.relation_type,
            depth,
          });
          nextFrontier.push(rel.eid);
        }
      }
    }
    frontier = nextFrontier;
  }
  return results;
}

/** Get KG stats */
export function kgStats(): { entities: number; relations: number; types: string[] } {
  const d = getDb();
  const entities = (d.prepare("SELECT COUNT(*) as c FROM kg_entities").get() as { c: number }).c;
  const relations = (d.prepare("SELECT COUNT(*) as c FROM kg_relations").get() as { c: number }).c;
  const types = (d.prepare("SELECT DISTINCT entity_type FROM kg_entities ORDER BY entity_type").all() as Array<{ entity_type: string }>).map(r => r.entity_type);
  return { entities, relations, types };
}

// --- Episodic Memory ---

export interface EpisodicEvent {
  id: number;
  event_type: string;
  summary: string;
  details: string | null;
  participants: string[];
  emotional_valence: number;
  importance: number;
  source: string;
  chat_id: number | null;
  created_at: number;
}

/** Log a significant event */
export function logEpisodicEvent(
  eventType: string,
  summary: string,
  opts?: {
    details?: string;
    participants?: string[];
    emotionalValence?: number;
    importance?: number;
    source?: string;
    chatId?: number;
  },
): number {
  const d = getDb();
  const info = d
    .prepare(
      `INSERT INTO episodic_events (event_type, summary, details, participants, emotional_valence, importance, source, chat_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      eventType,
      summary,
      opts?.details ?? null,
      JSON.stringify(opts?.participants || []),
      opts?.emotionalValence ?? 0.0,
      opts?.importance ?? 0.5,
      opts?.source ?? "auto",
      opts?.chatId ?? null,
    );
  log.debug(`[episodic] Event #${info.lastInsertRowid}: [${eventType}] ${summary.slice(0, 60)}`);
  return info.lastInsertRowid as number;
}

/** Recall events by type, time range, or importance */
export function recallEvents(opts?: {
  eventType?: string;
  minImportance?: number;
  sinceHours?: number;
  limit?: number;
  search?: string;
}): EpisodicEvent[] {
  const d = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (opts?.eventType) {
    conditions.push("event_type = ?");
    params.push(opts.eventType);
  }
  if (opts?.minImportance) {
    conditions.push("importance >= ?");
    params.push(opts.minImportance);
  }
  if (opts?.sinceHours) {
    conditions.push("created_at > unixepoch() - ?");
    params.push(opts.sinceHours * 3600);
  }
  if (opts?.search) {
    conditions.push("(summary LIKE ? OR details LIKE ?)");
    params.push(`%${opts.search}%`, `%${opts.search}%`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = opts?.limit || 20;
  params.push(limit);

  const rows = d
    .prepare(`SELECT * FROM episodic_events ${where} ORDER BY created_at DESC LIMIT ?`)
    .all(...params) as any[];

  return rows.map((r) => {
    let participants: string[] = [];
    try { participants = JSON.parse(r.participants); } catch { /* */ }
    return { ...r, participants };
  });
}

/** Get episodic timeline — events grouped by day */
export function episodicTimeline(days = 7): Array<{ date: string; events: EpisodicEvent[] }> {
  const events = recallEvents({ sinceHours: days * 24, limit: 100 });
  const byDay = new Map<string, EpisodicEvent[]>();
  for (const e of events) {
    const date = new Date(e.created_at * 1000).toISOString().slice(0, 10);
    if (!byDay.has(date)) byDay.set(date, []);
    byDay.get(date)!.push(e);
  }
  return Array.from(byDay.entries())
    .map(([date, events]) => ({ date, events }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

// --- Behavioral Rules Engine ---

export interface BehavioralRule {
  id: number;
  rule_name: string;
  condition: string;
  action: string;
  category: string;
  priority: number;
  enabled: number;
  success_count: number;
  fail_count: number;
  proposed_by: string;
  approved: number;
  created_at: number;
  updated_at: number;
}

/** Add a new behavioral rule (requires approval by default) */
export function addRule(
  ruleName: string,
  condition: string,
  action: string,
  category = "general",
  priority = 50,
  proposedBy = "system",
): number {
  const d = getDb();
  const info = d
    .prepare(
      `INSERT OR REPLACE INTO behavioral_rules (rule_name, condition, action, category, priority, proposed_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, unixepoch())`,
    )
    .run(ruleName, condition, action, category, priority, proposedBy);
  log.info(`[rules] Rule proposed: "${ruleName}" by ${proposedBy}`);
  return info.lastInsertRowid as number;
}

/** Approve a rule for execution */
export function approveRule(ruleId: number): boolean {
  const d = getDb();
  const info = d.prepare("UPDATE behavioral_rules SET approved = 1, updated_at = unixepoch() WHERE id = ?").run(ruleId);
  return info.changes > 0;
}

/** Get active rules for a category */
export function getActiveRules(category?: string): BehavioralRule[] {
  const d = getDb();
  if (category) {
    return d
      .prepare("SELECT * FROM behavioral_rules WHERE enabled = 1 AND approved = 1 AND category = ? ORDER BY priority DESC")
      .all(category) as BehavioralRule[];
  }
  return d
    .prepare("SELECT * FROM behavioral_rules WHERE enabled = 1 AND approved = 1 ORDER BY priority DESC")
    .all() as BehavioralRule[];
}

/** Get all rules (including unapproved/disabled) */
export function getAllRules(): BehavioralRule[] {
  const d = getDb();
  return d.prepare("SELECT * FROM behavioral_rules ORDER BY category, priority DESC").all() as BehavioralRule[];
}

/** Record success or failure of a rule */
export function recordRuleOutcome(ruleId: number, success: boolean): void {
  const d = getDb();
  if (success) {
    d.prepare("UPDATE behavioral_rules SET success_count = success_count + 1, updated_at = unixepoch() WHERE id = ?").run(ruleId);
  } else {
    d.prepare("UPDATE behavioral_rules SET fail_count = fail_count + 1, updated_at = unixepoch() WHERE id = ?").run(ruleId);
  }
}

/** Disable rules that fail too often (>70% fail rate with 5+ attempts) */
export function autoDisableFailingRules(): number {
  const d = getDb();
  const info = d.prepare(
    `UPDATE behavioral_rules SET enabled = 0, updated_at = unixepoch()
     WHERE enabled = 1 AND (success_count + fail_count) >= 5
       AND CAST(fail_count AS REAL) / (success_count + fail_count) > 0.7`,
  ).run();
  if (info.changes > 0) {
    log.info(`[rules] Auto-disabled ${info.changes} failing rule(s)`);
  }
  return info.changes;
}

// --- Dungeon Master CRUD ---

export function dungeonCreateSession(name: string, setting?: string): number {
  const d = getDb();
  const info = d.prepare(
    "INSERT INTO dungeon_sessions (name, setting) VALUES (?, ?)"
  ).run(name, setting ?? null);
  log.info(`[dungeon] Session created: "${name}" #${info.lastInsertRowid}`);
  return info.lastInsertRowid as number;
}

export function dungeonGetSession(id: number): any | null {
  const d = getDb();
  return d.prepare("SELECT * FROM dungeon_sessions WHERE id = ?").get(id) ?? null;
}

export function dungeonListSessions(): any[] {
  const d = getDb();
  return d.prepare("SELECT * FROM dungeon_sessions ORDER BY updated_at DESC").all();
}

export function dungeonUpdateSession(id: number, fields: Record<string, unknown>): void {
  const d = getDb();
  const allowed = ["name", "setting", "current_location", "turn_number", "status", "party_level", "notes"];
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (allowed.includes(k)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
  }
  if (sets.length === 0) return;
  sets.push("updated_at = unixepoch()");
  vals.push(id);
  d.prepare(`UPDATE dungeon_sessions SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
}

export function dungeonDeleteSession(id: number): void {
  const d = getDb();
  d.prepare("DELETE FROM dungeon_turns WHERE session_id = ?").run(id);
  d.prepare("DELETE FROM dungeon_characters WHERE session_id = ?").run(id);
  d.prepare("DELETE FROM dungeon_sessions WHERE id = ?").run(id);
  log.info(`[dungeon] Session #${id} deleted`);
}

export function dungeonAddCharacter(sessionId: number, char: {
  name: string; race?: string; class?: string; level?: number;
  hp?: number; hp_max?: number; stats?: Record<string, number>;
  inventory?: string[]; is_npc?: boolean; description?: string;
}): number {
  const d = getDb();
  const hpMax = char.hp_max || char.hp || 10;
  const info = d.prepare(
    `INSERT INTO dungeon_characters (session_id, name, race, class, level, hp, hp_max, stats, inventory, is_npc, description)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    sessionId, char.name, char.race || "Humain", char.class || "Guerrier",
    char.level || 1, char.hp || hpMax, hpMax,
    JSON.stringify(char.stats || {}), JSON.stringify(char.inventory || []),
    char.is_npc ? 1 : 0, char.description || null
  );
  return info.lastInsertRowid as number;
}

export function dungeonGetCharacters(sessionId: number): any[] {
  const d = getDb();
  const rows = d.prepare("SELECT * FROM dungeon_characters WHERE session_id = ? ORDER BY is_npc, name").all(sessionId) as any[];
  return rows.map((r) => {
    let stats = {}; let inventory: string[] = [];
    try { stats = JSON.parse(r.stats || "{}"); } catch { /* */ }
    try { inventory = JSON.parse(r.inventory || "[]"); } catch { /* */ }
    return { ...r, stats, inventory };
  });
}

export function dungeonUpdateCharacter(id: number, fields: Record<string, unknown>): void {
  const d = getDb();
  const allowed = ["name", "race", "class", "level", "hp", "hp_max", "stats", "inventory", "status", "description"];
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (allowed.includes(k)) {
      sets.push(`${k} = ?`);
      vals.push(k === "stats" || k === "inventory" ? JSON.stringify(v) : v);
    }
  }
  if (sets.length === 0) return;
  vals.push(id);
  d.prepare(`UPDATE dungeon_characters SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
}

export function dungeonAddTurn(sessionId: number, turn: {
  turn_number: number; player_action?: string; dm_narrative?: string;
  dice_rolls?: any[]; image_url?: string; event_type?: string;
}): number {
  const d = getDb();
  const info = d.prepare(
    `INSERT INTO dungeon_turns (session_id, turn_number, player_action, dm_narrative, dice_rolls, image_url, event_type)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    sessionId, turn.turn_number, turn.player_action || null,
    turn.dm_narrative || null, JSON.stringify(turn.dice_rolls || []),
    turn.image_url || null, turn.event_type || "exploration"
  );
  // Update session turn_number
  d.prepare("UPDATE dungeon_sessions SET turn_number = ?, updated_at = unixepoch() WHERE id = ?")
    .run(turn.turn_number, sessionId);
  return info.lastInsertRowid as number;
}

export function dungeonGetTurns(sessionId: number, limit = 20): any[] {
  const d = getDb();
  const rows = d.prepare(
    "SELECT * FROM dungeon_turns WHERE session_id = ? ORDER BY turn_number DESC LIMIT ?"
  ).all(sessionId, limit) as any[];
  return rows.reverse().map((r) => {
    let dice_rolls: any[] = [];
    try { dice_rolls = JSON.parse(r.dice_rolls || "[]"); } catch { /* */ }
    return { ...r, dice_rolls };
  });
}

// ── Database maintenance — prevents unbounded table growth ──────────
export function cleanupDatabase(): { purged: Record<string, number> } {
  const d = getDb();
  const now = Math.floor(Date.now() / 1000);
  const thirtyDaysAgo = now - 30 * 86400;
  const ninetyDaysAgo = now - 90 * 86400;
  const sevenDaysAgo = now - 7 * 86400;
  const purged: Record<string, number> = {};

  // 1. agent_runs older than 90 days
  const agentRuns = d.prepare("DELETE FROM agent_runs WHERE started_at < ?").run(ninetyDaysAgo);
  purged.agent_runs = agentRuns.changes;

  // 2. error_log resolved older than 30 days, unresolved older than 90 days
  const errResolved = d.prepare("DELETE FROM error_log WHERE resolved = 1 AND timestamp < ?").run(thirtyDaysAgo);
  const errOld = d.prepare("DELETE FROM error_log WHERE timestamp < ?").run(ninetyDaysAgo);
  purged.error_log = errResolved.changes + errOld.changes;

  // 3. llm_cache expired entries
  const cacheExpired = d.prepare("DELETE FROM llm_cache WHERE (unixepoch() - created_at) > ttl_seconds").run();
  purged.llm_cache = cacheExpired.changes;

  // 4. Expired admin sessions (>7 days)
  const adminExpired = d.prepare("DELETE FROM admin_sessions WHERE (unixepoch() - authenticated_at) >= ?").run(7 * 86400);
  purged.admin_sessions = adminExpired.changes;

  // 5. autonomous_decisions older than 90 days
  const decisions = d.prepare("DELETE FROM autonomous_decisions WHERE created_at < ?").run(ninetyDaysAgo);
  purged.autonomous_decisions = decisions.changes;

  // 6. episodic_events low-importance older than 90 days (keep high-importance)
  const episodic = d.prepare("DELETE FROM episodic_events WHERE importance < 0.7 AND created_at < ?").run(ninetyDaysAgo);
  purged.episodic_events = episodic.changes;

  // 7. Old turns from inactive chats (no activity in 30 days, keep agent/scheduler chats)
  const staleChats = d.prepare(
    `DELETE FROM turns WHERE chat_id IN (
       SELECT DISTINCT chat_id FROM turns
       WHERE chat_id > 1000
       GROUP BY chat_id
       HAVING MAX(created_at) < ?
     )`
  ).run(thirtyDaysAgo);
  purged.stale_turns = staleChats.changes;

  // 8. Old conversation summaries for stale chats
  const staleSummaries = d.prepare(
    `DELETE FROM conversation_summaries WHERE chat_id > 1000 AND updated_at < ?`
  ).run(thirtyDaysAgo);
  purged.stale_summaries = staleSummaries.changes;

  const total = Object.values(purged).reduce((a, b) => a + b, 0);
  if (total > 0) {
    log.info(`[db-cleanup] Purged ${total} rows: ${JSON.stringify(purged)}`);
  }

  return { purged };
}
