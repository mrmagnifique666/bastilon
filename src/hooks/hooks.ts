/**
 * Hooks system — lifecycle event handlers for Bastilon OS.
 * Inspired by OpenClaw's hooks pattern.
 *
 * Events:
 * - gateway:startup — bot just started
 * - session:new — user triggered /new (before clearTurns)
 * - session:reset — user triggered /clear (before clearTurns)
 * - agent:cycle:start — agent tick began (after clearSession)
 * - agent:cycle:end — agent tick completed (after logRun/saveState)
 */
import { log } from "../utils/log.js";

export type HookEvent =
  | "gateway:startup"
  | "session:new"
  | "session:reset"
  | "agent:cycle:start"
  | "agent:cycle:end";

export interface HookContext {
  chatId?: number;
  userId?: number;
  agentId?: string;
  cycle?: number;
  [key: string]: unknown;
}

export type HookHandler = (event: HookEvent, context: HookContext) => Promise<void>;

const handlers = new Map<HookEvent, HookHandler[]>();

export function registerHook(event: HookEvent, handler: HookHandler): void {
  if (!handlers.has(event)) {
    handlers.set(event, []);
  }
  handlers.get(event)!.push(handler);
  log.info(`[hooks] Registered handler for ${event}`);
}

export async function emitHook(event: HookEvent, context: HookContext): Promise<void> {
  const list = handlers.get(event);
  if (!list || list.length === 0) return;

  log.debug(`[hooks] Emitting ${event} (${list.length} handler${list.length > 1 ? "s" : ""})`);
  for (const handler of list) {
    try {
      await handler(event, context);
    } catch (err) {
      log.warn(`[hooks] Handler error on ${event}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export function getRegisteredHooks(): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [event, list] of handlers) {
    result[event] = list.length;
  }
  return result;
}
