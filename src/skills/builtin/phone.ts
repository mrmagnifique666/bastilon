/**
 * Built-in skill: phone.call — outbound call to Nicolas via Twilio
 */
import { registerSkill } from "../loader.js";
import { callNicolas } from "../../voice/outbound.js";
import { config } from "../../config/env.js";

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

registerSkill({
  name: "phone.answer",
  description: "Check inbound phone readiness and enforce Kingston greeting identity for calls.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {},
  },
  async execute(): Promise<string> {
    const checks: string[] = [];

    if (!config.voiceEnabled) checks.push("VOICE_ENABLED=false");
    if (!config.voicePublicUrl) checks.push("VOICE_PUBLIC_URL missing");
    if (!config.twilioAccountSid) checks.push("TWILIO_ACCOUNT_SID missing");
    if (!config.twilioAuthToken) checks.push("TWILIO_AUTH_TOKEN missing");
    if (!config.twilioPhoneNumber) checks.push("TWILIO_PHONE_NUMBER missing");

    const greeting = (config.voiceGreeting || "Bonjour, ici Kingston.").trim();
    const identityOk = /kingston/i.test(greeting) && !/noah/i.test(greeting);

    if (!identityOk) {
      checks.push(`VOICE_GREETING invalid: "${greeting}" (must identify Kingston, not Noah)`);
    }

    if (checks.length > 0) {
      return `Phone readiness: FAIL\n- ${checks.join("\n- ")}`;
    }

    return [
      "Phone readiness: OK",
      `Voice URL: ${config.voicePublicUrl}/voice/incoming`,
      `Phone number: ${config.twilioPhoneNumber}`,
      `Greeting: \"${greeting}\"`,
    ].join("\n");
  },
});
