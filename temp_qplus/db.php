<?php
/**
 * qplus.plus - Database Backend (SQLite)
 * Merged version: server schema + auth functions + API compatibility
 */

session_start();

function getDB(): PDO {
    static $db = null;
    if ($db !== null) return $db;

    $dataDir = __DIR__ . '/data';
    if (!is_dir($dataDir)) mkdir($dataDir, 0755, true);

    $dbPath = $dataDir . '/brokers.db';
    $isNew = !file_exists($dbPath);

    $db = new PDO('sqlite:' . $dbPath);
    $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $db->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
    $db->exec('PRAGMA journal_mode = WAL');
    $db->exec('PRAGMA foreign_keys = ON');

    initDB($db);
    return $db;
}

function initDB(PDO $db): void {
    $db->exec('CREATE TABLE IF NOT EXISTS brokers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT "",
        company TEXT NOT NULL DEFAULT "",
        credits INTEGER NOT NULL DEFAULT 100,
        plan TEXT NOT NULL DEFAULT "free",
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )');

    $db->exec('CREATE TABLE IF NOT EXISTS usage_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        broker_id INTEGER NOT NULL,
        action TEXT NOT NULL,
        credits_used INTEGER DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (broker_id) REFERENCES brokers(id) ON DELETE CASCADE
    )');

    $db->exec('CREATE TABLE IF NOT EXISTS uploads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        broker_id INTEGER NOT NULL,
        filename TEXT NOT NULL,
        original_name TEXT NOT NULL DEFAULT "",
        type TEXT DEFAULT "photo",
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (broker_id) REFERENCES brokers(id) ON DELETE CASCADE
    )');

    // Add missing columns to existing tables (safe — SQLite ignores if already exists)
    try { $db->exec('ALTER TABLE usage_log ADD COLUMN credits_used INTEGER DEFAULT 1'); } catch (Exception $e) {}
    try { $db->exec('ALTER TABLE uploads ADD COLUMN type TEXT DEFAULT "photo"'); } catch (Exception $e) {}
}

function isLoggedIn(): bool {
    return isset($_SESSION['broker_id']);
}

function requireLogin(): void {
    if (!isLoggedIn()) {
        header('Location: index.php');
        exit;
    }
}

function getConfig(string $key = ''): mixed {
    static $config = null;
    if ($config === null) {
        $configFile = __DIR__ . '/data/config.json';
        $config = file_exists($configFile) ? (json_decode(file_get_contents($configFile), true) ?: []) : [];
    }
    return $key ? ($config[$key] ?? null) : $config;
}
