/**
 * Simple levelled logger with secret redaction and ring buffer for dashboard logs.
 */

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof LEVELS;

let currentLevel: Level = "info";

/** Patterns that should be redacted from log output. */
const redactPatterns: RegExp[] = [];

/** Ring buffer for recent log lines (dashboard live logs). */
const RING_BUFFER_SIZE = 500;
const ringBuffer: { level: Level; message: string; timestamp: string }[] = [];

/** Optional broadcast function — set by dashboard to push logs via WS. */
let logBroadcastFn: ((event: string, data: unknown) => void) | null = null;

export function setLogLevel(level: Level) {
  currentLevel = level;
}

export function addRedactPattern(pattern: RegExp) {
  redactPatterns.push(pattern);
}

/** Set the dashboard broadcast function for live log streaming. */
export function setLogBroadcast(fn: (event: string, data: unknown) => void) {
  logBroadcastFn = fn;
}

/** Get recent log entries from the ring buffer. */
export function getRecentLogs(count = 200): typeof ringBuffer {
  return ringBuffer.slice(-count);
}

function redact(msg: string): string {
  let out = msg;
  for (const p of redactPatterns) {
    out = out.replace(p, "***REDACTED***");
  }
  return out;
}

function stamp(): string {
  return new Date().toISOString();
}

function emit(level: Level, ...args: unknown[]) {
  if (LEVELS[level] < LEVELS[currentLevel]) return;
  const parts = args.map((a) =>
    typeof a === "string" ? redact(a) : a
  );
  const prefix = `[${stamp()}] [${level.toUpperCase()}]`;

  // Console output
  switch (level) {
    case "error":
      console.error(prefix, ...parts);
      break;
    case "warn":
      console.warn(prefix, ...parts);
      break;
    default:
      console.log(prefix, ...parts);
  }

  // Ring buffer + WS broadcast
  const message = parts.map(p => typeof p === "string" ? p : JSON.stringify(p)).join(" ");
  const ts = stamp();
  const entry = { level, message: `${prefix} ${message}`, timestamp: ts };
  ringBuffer.push(entry);
  if (ringBuffer.length > RING_BUFFER_SIZE) {
    ringBuffer.shift();
  }

  // Broadcast to dashboard WS clients (if connected)
  if (logBroadcastFn) {
    try {
      logBroadcastFn("log", { level, message: entry.message, timestamp: ts });
    } catch {
      // Never let broadcast errors affect logging
    }
  }
}

export const log = {
  debug: (...args: unknown[]) => emit("debug", ...args),
  info: (...args: unknown[]) => emit("info", ...args),
  warn: (...args: unknown[]) => emit("warn", ...args),
  error: (...args: unknown[]) => emit("error", ...args),
};
