/**
 * Built-in skill: help
 * Lists all available tools.
 */
import { registerSkill, getAllSkills } from "../loader.js";

registerSkill({
  name: "help",
  description: "List all available tools and their descriptions.",
  argsSchema: {
    type: "object",
    properties: {},
  },
  async execute(): Promise<string> {
    const skills = getAllSkills();
    const lines = skills.map((s) => `- ${s.name}: ${s.description}`);
    return `Available tools:\n${lines.join("\n")}`;
  },
});
