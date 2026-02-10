/**
 * SOUL.md skills — read and edit Kingston's personality file.
 * Changes take effect on the next new session.
 */
import fs from "node:fs";
import path from "node:path";
import { registerSkill } from "../loader.js";

const SOUL_PATH = path.resolve(process.cwd(), "relay", "SOUL.md");

registerSkill({
  name: "soul.read",
  description: "Read Kingston's SOUL.md personality file",
  argsSchema: { type: "object", properties: {}, required: [] },
  adminOnly: false,
  async execute(): Promise<string> {
    if (!fs.existsSync(SOUL_PATH)) {
      return "SOUL.md not found. Create it at relay/SOUL.md.";
    }
    return fs.readFileSync(SOUL_PATH, "utf-8");
  },
});

registerSkill({
  name: "soul.edit",
  description: "Overwrite Kingston's SOUL.md personality file (changes effective on next new session)",
  argsSchema: {
    type: "object",
    properties: {
      content: { type: "string", description: "New SOUL.md content (Markdown)" },
    },
    required: ["content"],
  },
  adminOnly: true,
  async execute(args): Promise<string> {
    const content = args.content as string;
    if (!content || content.trim().length < 10) {
      return "Error: content too short. SOUL.md must have meaningful content.";
    }
    const dir = path.dirname(SOUL_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(SOUL_PATH, content, "utf-8");
    return `SOUL.md updated (${content.length} chars). Changes will take effect on the next new session.`;
  },
});
