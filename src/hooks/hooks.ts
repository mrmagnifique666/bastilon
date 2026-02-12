/**
 * Hooks system — lifecycle event handlers for Bastilon OS.
 * Supports priority ordering, namespaces, and auto-loading plugins.
 *
 * Events:
 * - gateway:startup — bot just started
 * - gateway:shutdown — bot shutting down
 * - session:new — user triggered /new (before clearTurns)
 * - session:reset — user triggered /clear (before clearTurns)
 * - message:received — raw Telegram message arrived
 * - message:routed — message dispatched to LLM provider
 * - message:sent — response delivered to Telegram
 * - agent:cycle:start — agent tick began (after clearSession)
 * - agent:cycle:end — agent tick completed (after logRun/saveState)
 * - agent:start — agent heartbeat loop begins
 * - agent:stop — agent disabled or stopped
 * - llm:before — before any LLM call (provider, model, chatId)
 * - llm:after — after any LLM call (provider, model, durationMs, tokens)
 * - llm:fallback — provider switched (fromProvider, toProvider, reason)
 * - tool:before — before tool execution (tool name, args, chatId)
 * - tool:after — after tool execution (tool name, result, durationMs)
 * - tool:error — tool execution failed with error
 * - memory:added — new memory stored
 * - memory:searched — memory search completed
 * - cron:fired — cron job executed
 * - error:unhandled — uncaught exception in a component
 */
import { log } from "../utils/log.js";

export type HookEvent =
  | "gateway:startup"
  | "gateway:shutdown"
  | "session:new"
  | "session:reset"
  | "message:received"
  | "message:routed"
  | "message:sent"
  | "agent:cycle:start"
  | "agent:cycle:end"
  | "agent:start"
  | "agent:stop"
  | "llm:before"
  | "llm:after"
  | "llm:fallback"
  | "tool:before"
  | "tool:after"
  | "tool:error"
  | "memory:added"
  | "memory:searched"
  | "cron:fired"
  | "error:unhandled"
  | "voice:session:end";

export interface HookContext {
  chatId?: number;
  userId?: number;
  agentId?: string;
  cycle?: number;
  [key: string]: unknown;
}

export type HookPriority = "critical" | "high" | "normal" | "low";

const PRIORITY_ORDER: Record<HookPriority, number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
};

export type HookHandler = (event: HookEvent, context: HookContext) => Promise<void>;

export interface HookRegistration {
  handler: HookHandler;
  priority: HookPriority;
  namespace?: string;
  description?: string;
}

const handlers = new Map<HookEvent, HookRegistration[]>();

/**
 * Register a hook handler for a lifecycle event.
 * @param event - The lifecycle event to listen to
 * @param handler - Async handler function
 * @param options - Optional priority, namespace, description
 */
export function registerHook(
  event: HookEvent,
  handler: HookHandler,
  options?: { priority?: HookPriority; namespace?: string; description?: string }
): void {
  if (!handlers.has(event)) {
    handlers.set(event, []);
  }

  const reg: HookRegistration = {
    handler,
    priority: options?.priority || "normal",
    namespace: options?.namespace,
    description: options?.description,
  };

  const list = handlers.get(event)!;
  list.push(reg);

  // Sort by priority (critical first, low last)
  list.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);

  const ns = options?.namespace ? ` [${options.namespace}]` : "";
  log.info(`[hooks] Registered${ns} handler for ${event} (${reg.priority})`);
}

/**
 * Emit a lifecycle event. Handlers run in priority order.
 * Each handler is error-isolated — one failure doesn't block others.
 */
export async function emitHook(event: HookEvent, context: HookContext): Promise<void> {
  const list = handlers.get(event);
  if (!list || list.length === 0) return;

  log.debug(`[hooks] Emitting ${event} (${list.length} handler${list.length > 1 ? "s" : ""})`);
  for (const reg of list) {
    try {
      await reg.handler(event, context);
    } catch (err) {
      const ns = reg.namespace ? ` [${reg.namespace}]` : "";
      log.warn(`[hooks]${ns} Handler error on ${event}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * Fire-and-forget emit — doesn't await handlers. Use for non-critical events.
 */
export function emitHookAsync(event: HookEvent, context: HookContext): void {
  emitHook(event, context).catch(err =>
    log.warn(`[hooks] Async emit error on ${event}: ${err instanceof Error ? err.message : String(err)}`)
  );
}

/**
 * Remove all handlers for a specific namespace.
 */
export function removeHooksByNamespace(namespace: string): number {
  let removed = 0;
  for (const [event, list] of handlers) {
    const before = list.length;
    const filtered = list.filter(r => r.namespace !== namespace);
    handlers.set(event, filtered);
    removed += before - filtered.length;
  }
  if (removed > 0) log.info(`[hooks] Removed ${removed} handler(s) from namespace "${namespace}"`);
  return removed;
}

/**
 * Get all registered hooks with their metadata.
 */
export function getRegisteredHooks(): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [event, list] of handlers) {
    result[event] = list.length;
  }
  return result;
}

/**
 * Get detailed hook registrations for introspection.
 */
export function getHookDetails(): Array<{
  event: HookEvent;
  namespace?: string;
  priority: HookPriority;
  description?: string;
}> {
  const details: Array<{
    event: HookEvent;
    namespace?: string;
    priority: HookPriority;
    description?: string;
  }> = [];

  for (const [event, list] of handlers) {
    for (const reg of list) {
      details.push({
        event,
        namespace: reg.namespace,
        priority: reg.priority,
        description: reg.description,
      });
    }
  }

  return details;
}

/**
 * Auto-load all plugin files from src/hooks/plugins/.
 * Each plugin should call registerHook() on import.
 */
export async function loadPlugins(): Promise<number> {
  let loaded = 0;
  try {
    // Dynamic import of the plugins directory
    const fs = await import("node:fs");
    const path = await import("node:path");
    const pluginsDir = path.join(import.meta.dirname || ".", "plugins");

    if (!fs.existsSync(pluginsDir)) {
      log.debug("[hooks] No plugins directory found, skipping");
      return 0;
    }

    const files = fs.readdirSync(pluginsDir).filter(
      (f: string) => (f.endsWith(".ts") || f.endsWith(".js")) && !f.endsWith(".d.ts")
    );

    for (const file of files) {
      try {
        await import(`./plugins/${file.replace(/\.ts$/, ".js")}`);
        loaded++;
        log.info(`[hooks] Loaded plugin: ${file}`);
      } catch (err) {
        log.warn(`[hooks] Failed to load plugin ${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    log.debug(`[hooks] Plugin loader error: ${err instanceof Error ? err.message : String(err)}`);
  }

  return loaded;
}
