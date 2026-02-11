/**
 * Deferred Memory Operations Queue.
 * Batches and processes memory operations in the background
 * to avoid blocking LLM response times.
 *
 * Operations: embedding, KG insertions, episodic logging, rule checks.
 * Processes every 5 seconds or when queue reaches 10 items.
 */
import { log } from "../utils/log.js";

type DeferredOp = () => Promise<void>;

const queue: DeferredOp[] = [];
let processing = false;
let timer: ReturnType<typeof setInterval> | null = null;

const BATCH_SIZE = 10;
const FLUSH_INTERVAL_MS = 5000;

/** Add an operation to the deferred queue. Never blocks. */
export function defer(op: DeferredOp): void {
  queue.push(op);
  // Auto-flush if batch is full
  if (queue.length >= BATCH_SIZE && !processing) {
    processQueue().catch(() => {});
  }
}

/** Process all queued operations. */
async function processQueue(): Promise<void> {
  if (processing || queue.length === 0) return;
  processing = true;

  const batch = queue.splice(0, BATCH_SIZE);
  const start = Date.now();

  let success = 0;
  let errors = 0;

  for (const op of batch) {
    try {
      await op();
      success++;
    } catch (err) {
      errors++;
      log.debug(`[deferred] Op failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const elapsed = Date.now() - start;
  if (success + errors > 0) {
    log.debug(`[deferred] Processed ${success}/${success + errors} ops in ${elapsed}ms (${queue.length} remaining)`);
  }

  processing = false;

  // Continue if more items queued during processing
  if (queue.length > 0) {
    setImmediate(() => processQueue().catch(() => {}));
  }
}

/** Start the periodic flush timer. */
export function startDeferredQueue(): void {
  if (timer) return;
  timer = setInterval(() => {
    processQueue().catch(() => {});
  }, FLUSH_INTERVAL_MS);
  log.info("[deferred] Memory queue started (flush every 5s)");
}

/** Stop the queue and process remaining items. */
export async function stopDeferredQueue(): Promise<void> {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  // Flush remaining
  while (queue.length > 0) {
    await processQueue();
  }
  log.info("[deferred] Memory queue stopped, all ops flushed");
}

/** Get queue stats. */
export function getDeferredStats(): { pending: number; processing: boolean } {
  return { pending: queue.length, processing };
}
