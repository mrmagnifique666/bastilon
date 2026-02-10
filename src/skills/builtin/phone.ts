/**
 * Built-in skill: phone.call — outbound call to Nicolas via Twilio
 */
import { registerSkill } from "../loader.js";
import { callNicolas } from "../../voice/outbound.js";

registerSkill({
  name: "phone.call",
  description: "Call Nicolas on his phone with a spoken reason, then connect to voice pipeline (admin only).",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      reason: { type: "string", description: "The reason for the call (will be spoken)" },
    },
    required: ["reason"],
  },
  async execute(args): Promise<string> {
    const reason = args.reason as string;
    try {
      const sid = await callNicolas(reason);
      return `Call initiated — SID: ${sid}`;
    } catch (err) {
      return `Call failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});
