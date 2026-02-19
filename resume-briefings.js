#!/usr/bin/env node
/**
 * Resume all paused briefing cron jobs
 */
import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, "relay.db");

const db = new Database(dbPath);

console.log("🔍 Finding paused briefing jobs...");

const pausedBriefings = db
  .prepare("SELECT id, name, enabled FROM cron_jobs WHERE name LIKE '%briefing%'")
  .all();

console.log(`Found ${pausedBriefings.length} briefing jobs:`);
pausedBriefings.forEach((job) => {
  console.log(`  - ${job.name} (${job.id}): ${job.enabled ? "✅ enabled" : "⏸️ paused"}`);
});

// Resume all paused ones
const pausedOnes = pausedBriefings.filter((j) => !j.enabled);

if (pausedOnes.length === 0) {
  console.log("\n✅ All briefing jobs are already enabled!");
  process.exit(0);
}

console.log(`\n🔄 Resuming ${pausedOnes.length} paused briefings...`);

const updateStmt = db.prepare("UPDATE cron_jobs SET enabled = 1, updated_at = ? WHERE id = ?");
const now = Math.floor(Date.now() / 1000);

for (const job of pausedOnes) {
  updateStmt.run(now, job.id);
  console.log(`  ✅ Resumed: ${job.name}`);
}

console.log("\n✨ All briefing jobs have been resumed!");
console.log("⚠️  NOTE: You need to restart the relay bot for changes to take effect.");

db.close();
