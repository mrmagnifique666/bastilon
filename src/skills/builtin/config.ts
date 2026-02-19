/**
 * Built-in skill: config reload
 */
import { registerSkill } from "../loader.js";
import { reloadEnv } from "../../config/env.js";

registerSkill({
  name: "config.reload",
  description: "Reload .env configuration without restarting (admin only).",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {},
  },
  async execute(): Promise<string> {
    const changed = reloadEnv();
    if (changed.length === 0) return "Configuration reloaded — no changes detected.";
    return `Configuration reloaded. Changed keys: ${changed.join(", ")}`;
  },
});
