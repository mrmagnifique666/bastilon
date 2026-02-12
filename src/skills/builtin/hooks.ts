/**
 * Hooks introspection skills — list, inspect, and manage lifecycle hooks.
 */
import { registerSkill } from "../loader.js";
import {
  getRegisteredHooks,
  getHookDetails,
  removeHooksByNamespace,
} from "../../hooks/hooks.js";

registerSkill({
  name: "hooks.list",
  description: "List all registered lifecycle hooks with their event counts",
  argsSchema: {
    type: "object",
    properties: {},
  },
  async execute(): Promise<string> {
    const hooks = getRegisteredHooks();
    const entries = Object.entries(hooks);
    if (entries.length === 0) return "No hooks registered.";

    const total = entries.reduce((sum, [, count]) => sum + count, 0);
    const lines = entries.map(([event, count]) => `  ${event}: ${count} handler(s)`);
    return `Lifecycle hooks (${total} total):\n${lines.join("\n")}`;
  },
});

registerSkill({
  name: "hooks.details",
  description: "Show detailed hook registrations including namespace and priority",
  argsSchema: {
    type: "object",
    properties: {
      event: { type: "string", description: "Filter by event name (optional)" },
    },
  },
  async execute(args): Promise<string> {
    let details = getHookDetails();
    const filterEvent = args.event as string | undefined;

    if (filterEvent) {
      details = details.filter(d => d.event === filterEvent);
    }

    if (details.length === 0) {
      return filterEvent ? `No hooks registered for "${filterEvent}".` : "No hooks registered.";
    }

    const lines = details.map(d => {
      const ns = d.namespace ? `[${d.namespace}]` : "[core]";
      const desc = d.description ? ` — ${d.description}` : "";
      return `  ${d.event} ${ns} (${d.priority})${desc}`;
    });
    return `Hook registrations (${details.length}):\n${lines.join("\n")}`;
  },
});

registerSkill({
  name: "hooks.remove",
  description: "Remove all hooks for a given namespace (plugin unload)",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      namespace: { type: "string", description: "Namespace to remove (e.g. 'analytics')" },
    },
    required: ["namespace"],
  },
  async execute(args): Promise<string> {
    const ns = args.namespace as string;
    const removed = removeHooksByNamespace(ns);
    return removed > 0
      ? `Removed ${removed} hook(s) from namespace "${ns}".`
      : `No hooks found for namespace "${ns}".`;
  },
});
