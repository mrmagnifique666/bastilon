/**
 * Built-in skills: whatsapp.send, whatsapp.send_template, whatsapp.media,
 * whatsapp.receive, whatsapp.mark_read
 * Uses Meta WhatsApp Business Cloud API v19.0.
 */
import { registerSkill } from "../loader.js";
import { log } from "../../utils/log.js";

const API = "https://graph.facebook.com/v19.0";

function getConfig() {
  const token = process.env.WHATSAPP_API_KEY;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) return null;
  return { token, phoneNumberId };
}

function checkConfig(): string | null {
  if (!getConfig()) return "WhatsApp not configured. Set WHATSAPP_API_KEY and WHATSAPP_PHONE_NUMBER_ID in .env";
  return null;
}

async function waFetch(method: string, path: string, body?: unknown): Promise<any> {
  const config = getConfig()!;
  const resp = await fetch(`${API}/${config.phoneNumberId}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json();
  if (!resp.ok || data.error) {
    throw new Error(`WhatsApp API ${resp.status}: ${data.error?.message || JSON.stringify(data)}`);
  }
  return data;
}

registerSkill({
  name: "whatsapp.send",
  description: "Send a WhatsApp text message.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      to: { type: "string", description: "Phone number (E.164 without +, e.g. 15551234567)" },
      message: { type: "string", description: "Message text" },
    },
    required: ["to", "message"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;

    try {
      const data = await waFetch("POST", "/messages", {
        messaging_product: "whatsapp",
        to: String(args.to).replace(/^\+/, ""),
        type: "text",
        text: { body: String(args.message) },
      });
      const msgId = data.messages?.[0]?.id;
      return `WhatsApp message sent to ${args.to}: id=${msgId || "success"}`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

registerSkill({
  name: "whatsapp.send_template",
  description: "Send a WhatsApp template message (pre-approved by Meta).",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      to: { type: "string", description: "Phone number (E.164 without +)" },
      templateName: { type: "string", description: "Template name" },
      languageCode: { type: "string", description: "Language code (default: fr)" },
      params: { type: "string", description: "Comma-separated template parameters (optional)" },
    },
    required: ["to", "templateName"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;

    try {
      const components: any[] = [];
      if (args.params) {
        const paramList = String(args.params).split(",").map(p => ({ type: "text", text: p.trim() }));
        components.push({ type: "body", parameters: paramList });
      }

      const data = await waFetch("POST", "/messages", {
        messaging_product: "whatsapp",
        to: String(args.to).replace(/^\+/, ""),
        type: "template",
        template: {
          name: String(args.templateName),
          language: { code: String(args.languageCode || "fr") },
          components: components.length ? components : undefined,
        },
      });
      const msgId = data.messages?.[0]?.id;
      return `Template "${args.templateName}" sent to ${args.to}: id=${msgId || "success"}`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

registerSkill({
  name: "whatsapp.media",
  description: "Send an image, video, or document via WhatsApp.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      to: { type: "string", description: "Phone number (E.164 without +)" },
      mediaUrl: { type: "string", description: "Public URL of the media" },
      type: { type: "string", description: "Media type: image, video, document (default: image)" },
      caption: { type: "string", description: "Caption text (optional)" },
    },
    required: ["to", "mediaUrl"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;
    const mediaType = String(args.type || "image");

    try {
      const mediaObj: any = { link: String(args.mediaUrl) };
      if (args.caption) mediaObj.caption = String(args.caption);

      const data = await waFetch("POST", "/messages", {
        messaging_product: "whatsapp",
        to: String(args.to).replace(/^\+/, ""),
        type: mediaType,
        [mediaType]: mediaObj,
      });
      const msgId = data.messages?.[0]?.id;
      return `WhatsApp ${mediaType} sent to ${args.to}: id=${msgId || "success"}`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

registerSkill({
  name: "whatsapp.mark_read",
  description: "Mark a WhatsApp message as read.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      messageId: { type: "string", description: "Message ID to mark as read" },
    },
    required: ["messageId"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;

    try {
      await waFetch("POST", "/messages", {
        messaging_product: "whatsapp",
        status: "read",
        message_id: String(args.messageId),
      });
      return `Message ${args.messageId} marked as read.`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

log.debug("Registered 4 whatsapp.* skills");
