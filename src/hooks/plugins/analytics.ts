/**
 * Analytics Plugin — tracks message volume, tool usage, LLM latency.
 * Stores metrics in-memory (resets on restart).
 * Data accessible via hooks.details or the analytics.hooks skill.
 */
import { registerHook, type HookEvent, type HookContext } from "../hooks.js";
import { log } from "../../utils/log.js";

const NS = "analytics";

// In-memory counters (reset on restart)
const counters = {
  messagesReceived: 0,
  messagesSent: 0,
  toolCalls: 0,
  toolErrors: 0,
  llmCalls: 0,
  llmFallbacks: 0,
  agentCycles: 0,
  cronFired: 0,
};

const llmLatencies: number[] = []; // last 100 latency values

export function getAnalyticsCounters() {
  return { ...counters };
}

export function getAvgLlmLatency(): number {
  if (llmLatencies.length === 0) return 0;
  return Math.round(llmLatencies.reduce((a, b) => a + b, 0) / llmLatencies.length);
}

// --- Hook Handlers ---

registerHook("message:received", async (_e: HookEvent, _ctx: HookContext) => {
  counters.messagesReceived++;
}, { namespace: NS, priority: "low", description: "Count incoming messages" });

registerHook("message:sent", async (_e: HookEvent, _ctx: HookContext) => {
  counters.messagesSent++;
}, { namespace: NS, priority: "low", description: "Count outgoing messages" });

registerHook("tool:before", async (_e: HookEvent, _ctx: HookContext) => {
  counters.toolCalls++;
}, { namespace: NS, priority: "low", description: "Count tool invocations" });

registerHook("tool:error", async (_e: HookEvent, _ctx: HookContext) => {
  counters.toolErrors++;
}, { namespace: NS, priority: "low", description: "Count tool errors" });

registerHook("llm:after", async (_e: HookEvent, ctx: HookContext) => {
  counters.llmCalls++;
  const durationMs = ctx.durationMs as number | undefined;
  if (durationMs) {
    llmLatencies.push(durationMs);
    if (llmLatencies.length > 100) llmLatencies.shift();
  }
}, { namespace: NS, priority: "low", description: "Track LLM call count and latency" });

registerHook("llm:fallback", async (_e: HookEvent, _ctx: HookContext) => {
  counters.llmFallbacks++;
}, { namespace: NS, priority: "low", description: "Count LLM provider fallbacks" });

registerHook("agent:cycle:end", async (_e: HookEvent, _ctx: HookContext) => {
  counters.agentCycles++;
}, { namespace: NS, priority: "low", description: "Count agent cycles" });

registerHook("cron:fired", async (_e: HookEvent, _ctx: HookContext) => {
  counters.cronFired++;
}, { namespace: NS, priority: "low", description: "Count cron job executions" });

log.info(`[${NS}] Analytics plugin loaded (8 hooks)`);
