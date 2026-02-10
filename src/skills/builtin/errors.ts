/**
 * Built-in skill: error tracking (recent / resolve)
 */
import { registerSkill } from "../loader.js";
import { getRecentErrors, resolveError } from "../../storage/store.js";

registerSkill({
  name: "errors.recent",
  description: "Show recent errors from the error log.",
  argsSchema: {
    type: "object",
    properties: {
      count: { type: "number", description: "Number of errors to show (default 20)" },
    },
  },
  async execute(args): Promise<string> {
    const count = (args.count as number) || 20;
    const rows = getRecentErrors(count);
    if (rows.length === 0) return "No errors recorded.";
    return rows
      .map((e) => {
        const date = new Date(e.timestamp * 1000).toISOString();
        const status = e.resolved ? "✅" : "❌";
        const ctx = e.context ? ` [${e.context}]` : "";
        return `#${e.id} ${status} ${date}${ctx}\n  ${e.error_message}`;
      })
      .join("\n");
  },
});

registerSkill({
  name: "errors.resolve",
  description: "Mark an error as resolved by its ID.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      id: { type: "number", description: "Error ID to resolve" },
    },
    required: ["id"],
  },
  async execute(args): Promise<string> {
    const id = args.id as number;
    const ok = resolveError(id);
    return ok ? `Error #${id} marked as resolved.` : `Error #${id} not found.`;
  },
});
