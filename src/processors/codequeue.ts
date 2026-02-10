/**
 * Code request queue processor.
 * On startup, reads code-requests.json and logs pending requests
 * for manual or automated execution.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { log } from "../utils/log.js";

const QUEUE_FILE = path.join(process.cwd(), "code-requests.json");

interface CodeRequest {
  id: number;
  timestamp: string;
  task: string;
  priority: string;
  files: string[];
  status: string;
  result: string | null;
}

export async function processCodeRequests(): Promise<void> {
  let queue: CodeRequest[];
  try {
    const data = await fs.readFile(QUEUE_FILE, "utf-8");
    queue = JSON.parse(data);
  } catch {
    // No queue file — nothing to process
    return;
  }

  const pending = queue.filter((r) => r.status === "pending");

  if (pending.length === 0) {
    log.info("No pending code requests.");
    return;
  }

  log.info(`Found ${pending.length} pending code request(s). Processing...`);

  for (const request of pending) {
    const sep = "=".repeat(60);
    log.info(`\n${sep}`);
    log.info(`[Request #${request.id}] ${request.task}`);
    log.info(`${sep}\n`);

    // Mark as in-progress
    request.status = "in-progress";
    await fs.writeFile(QUEUE_FILE, JSON.stringify(queue, null, 2));

    console.log("\nKINGSTON'S CODE REQUEST:\n");
    console.log(`Task: ${request.task}`);
    console.log(`Priority: ${request.priority}`);
    if (request.files.length > 0) {
      console.log(`Files: ${request.files.join(", ")}`);
    }
    console.log(`\n${sep}\n`);

    // Mark as awaiting manual execution
    request.status = "awaiting_execution";
    await fs.writeFile(QUEUE_FILE, JSON.stringify(queue, null, 2));
  }
}
