<?php
header('Content-Type: application/json');
 = [];

// Check PHP version
['php_version'] = PHP_VERSION;

// Check SQLite extension
['sqlite3_loaded'] = extension_loaded('sqlite3');
['pdo_sqlite_loaded'] = extension_loaded('pdo_sqlite');

// Check available PDO drivers
['pdo_drivers'] = PDO::getAvailableDrivers();

// Check data dir
 = __DIR__ . '/data';
['data_dir_exists'] = is_dir();
['data_dir_writable'] = is_writable();

// Try to create SQLite DB
try {
    if (!is_dir()) mkdir(, 0755, true);
     =  . '/brokers.db';
     = new PDO('sqlite:' . );
    ->exec('PRAGMA journal_mode=WAL');
    ['sqlite_connect'] = 'success';
    ['db_path'] = ;
    
    // Create tables
    ->exec('CREATE TABLE IF NOT EXISTS brokers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        name TEXT NOT NULL,
        company TEXT DEFAULT '',
        plan TEXT DEFAULT 'starter',
        credits INTEGER DEFAULT 10,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )');
    ->exec('CREATE TABLE IF NOT EXISTS usage_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        broker_id INTEGER,
        action TEXT,
        credits_used INTEGER DEFAULT 1,
        details TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (broker_id) REFERENCES brokers(id)
    )');
    ['tables_created'] = true;
    
    // Check file was created
    ['db_file_exists'] = file_exists();
    ['db_file_size'] = file_exists() ? filesize() : 0;
    
} catch (Exception ) {
    ['sqlite_connect'] = 'failed';
    ['sqlite_error'] = ->getMessage();
}

echo json_encode(, JSON_PRETTY_PRINT);
