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
    reloadEnv();
    return "Configuration reloaded from .env.";
  },
});
