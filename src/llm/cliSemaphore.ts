/**
 * Global semaphore for Claude CLI process spawning.
 *
 * Limits concurrent Claude CLI processes to prevent RAM saturation.
 * When the limit is reached, new requests wait in a FIFO queue.
 *
 * Also includes a pre-spawn RAM check: if available memory is below
 * a threshold, the spawn is delayed until memory frees up.
 */
import { execSync } from "node:child_process";
import { log } from "../utils/log.js";

const MAX_CONCURRENT_CLI = 2;
const MIN_FREE_RAM_MB = 512;
const RAM_CHECK_INTERVAL_MS = 3000;
const RAM_CHECK_MAX_WAIT_MS = 30_000;

let activeCount = 0;
const waitQueue: Array<() => void> = [];

/**
 * Get available RAM in MB (Windows-specific).
 */
function getAvailableRamMb(): number {
  try {
    const out = execSync(
      `powershell -NoProfile -Command "(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory"`,
      { encoding: "utf-8", timeout: 5000 },
    ).trim();
    const kb = Number(out);
    return Math.round(kb / 1024);
  } catch {
    return 9999; // assume plenty of RAM on error
  }
}

/**
 * Wait until available RAM is above threshold.
 * Returns true if OK, false if timed out.
 */
async function waitForRam(): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < RAM_CHECK_MAX_WAIT_MS) {
    const free = getAvailableRamMb();
    if (free >= MIN_FREE_RAM_MB) return true;
    log.warn(`[cliSemaphore] Low RAM: ${free}MB free (need ${MIN_FREE_RAM_MB}MB). Waiting...`);
    await new Promise((r) => setTimeout(r, RAM_CHECK_INTERVAL_MS));
  }
  log.error(`[cliSemaphore] RAM still low after ${RAM_CHECK_MAX_WAIT_MS / 1000}s — proceeding anyway`);
  return false;
}

/**
 * Acquire a slot in the CLI semaphore.
 * Waits if max concurrent processes are already running.
 * Also checks RAM before proceeding.
 */
export async function acquireCli(): Promise<void> {
  // Wait for a free slot
  if (activeCount >= MAX_CONCURRENT_CLI) {
    log.debug(`[cliSemaphore] ${activeCount}/${MAX_CONCURRENT_CLI} CLI processes active — queuing`);
    await new Promise<void>((resolve) => {
      waitQueue.push(resolve);
    });
  }

  // Check RAM before spawning
  await waitForRam();

  activeCount++;
  log.debug(`[cliSemaphore] Acquired slot (${activeCount}/${MAX_CONCURRENT_CLI})`);
}

/**
 * Release a slot in the CLI semaphore.
 */
export function releaseCli(): void {
  activeCount = Math.max(0, activeCount - 1);
  log.debug(`[cliSemaphore] Released slot (${activeCount}/${MAX_CONCURRENT_CLI})`);

  // Wake the next waiter
  if (waitQueue.length > 0) {
    const next = waitQueue.shift()!;
    next();
  }
}

/**
 * Get current semaphore status.
 */
export function getCliSemaphoreStatus(): { active: number; waiting: number; max: number } {
  return { active: activeCount, waiting: waitQueue.length, max: MAX_CONCURRENT_CLI };
}
