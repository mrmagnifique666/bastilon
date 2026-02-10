/**
 * Built-in skills: sms.send, sms.receive, sms.reply, sms.bulk
 * Uses Twilio REST API (extends existing Twilio config).
 */
import { registerSkill } from "../loader.js";
import { log } from "../../utils/log.js";

const TWILIO_API = "https://api.twilio.com/2010-04-01";

function getConfig() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_PHONE_NUMBER;
  if (!sid || !token || !from) return null;
  return { sid, token, from };
}

function checkConfig(): string | null {
  if (!getConfig()) return "SMS not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER in .env";
  return null;
}

async function twilioFetch(method: string, path: string, body?: Record<string, string>): Promise<any> {
  const config = getConfig()!;
  const auth = Buffer.from(`${config.sid}:${config.token}`).toString("base64");
  const opts: RequestInit = {
    method,
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
  };
  if (body) opts.body = new URLSearchParams(body);

  const resp = await fetch(`${TWILIO_API}/Accounts/${config.sid}${path}`, opts);
  const data = await resp.json();
  if (!resp.ok) throw new Error(`Twilio ${resp.status}: ${data.message || JSON.stringify(data)}`);
  return data;
}

registerSkill({
  name: "sms.send",
  description: "Send an SMS message via Twilio.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      to: { type: "string", description: "Phone number to send to (E.164 format, e.g. +15551234567)" },
      message: { type: "string", description: "SMS message text (max 1600 chars)" },
    },
    required: ["to", "message"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;
    const msg = String(args.message);
    if (msg.length > 1600) return "Error: SMS must be 1600 chars or less.";

    try {
      const data = await twilioFetch("POST", "/Messages.json", {
        To: String(args.to),
        From: getConfig()!.from,
        Body: msg,
      });
      return `SMS sent: sid=${data.sid} to=${data.to} status=${data.status}`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

registerSkill({
  name: "sms.receive",
  description: "Get recently received SMS messages.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      limit: { type: "number", description: "Number of messages (default 10)" },
    },
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;
    const limit = Math.min(Number(args.limit) || 10, 50);

    try {
      const config = getConfig()!;
      const data = await twilioFetch("GET", `/Messages.json?To=${encodeURIComponent(config.from)}&PageSize=${limit}`);
      const messages = data.messages || [];
      if (!messages.length) return "No received messages.";
      const lines = messages.map((m: any) =>
        `[${m.sid}] From: ${m.from} | ${m.date_sent}\n  "${m.body.slice(0, 200)}"`
      );
      return `**Received SMS (${messages.length}):**\n${lines.join("\n\n")}`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

registerSkill({
  name: "sms.reply",
  description: "Reply to a received SMS (sends to the 'from' number of a message).",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      messageSid: { type: "string", description: "SID of the message to reply to" },
      text: { type: "string", description: "Reply text" },
    },
    required: ["messageSid", "text"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;

    try {
      // Get original message to find the sender
      const original = await twilioFetch("GET", `/Messages/${args.messageSid}.json`);
      const data = await twilioFetch("POST", "/Messages.json", {
        To: original.from,
        From: getConfig()!.from,
        Body: String(args.text),
      });
      return `Reply sent to ${original.from}: sid=${data.sid}`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

registerSkill({
  name: "sms.bulk",
  description: "Send the same SMS to multiple numbers.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      numbers: { type: "string", description: "Comma-separated phone numbers (E.164)" },
      message: { type: "string", description: "SMS message text" },
    },
    required: ["numbers", "message"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;
    const numbers = String(args.numbers).split(",").map(n => n.trim()).filter(Boolean);
    if (numbers.length > 50) return "Error: Max 50 numbers per bulk send.";
    const msg = String(args.message);
    if (msg.length > 1600) return "Error: SMS must be 1600 chars or less.";

    const results: string[] = [];
    let sent = 0, failed = 0;
    for (const to of numbers) {
      try {
        await twilioFetch("POST", "/Messages.json", {
          To: to,
          From: getConfig()!.from,
          Body: msg,
        });
        sent++;
      } catch (e) {
        failed++;
        results.push(`Failed: ${to} — ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const summary = `Bulk SMS: ${sent} sent, ${failed} failed (${numbers.length} total)`;
    return results.length ? `${summary}\n${results.join("\n")}` : summary;
  },
});

log.debug("Registered 4 sms.* skills");
