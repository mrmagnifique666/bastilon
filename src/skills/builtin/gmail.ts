/**
 * Built-in skills: gmail.search, gmail.read, gmail.send, gmail.reply, gmail.labels, gmail.draft
 * Full Gmail access via Google APIs OAuth2.
 */
import { registerSkill } from "../loader.js";
import { getGmailClient } from "../../gmail/auth.js";
import { config } from "../../config/env.js";

function checkGmailConfig(): string | null {
  try {
    getGmailClient();
    return null;
  } catch (err) {
    return `Gmail not configured: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function buildRawEmail(opts: {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
  inReplyTo?: string;
  references?: string;
  threadId?: string;
}): string {
  const lines: string[] = [];
  lines.push(`To: ${opts.to}`);
  if (opts.cc) lines.push(`Cc: ${opts.cc}`);
  if (opts.bcc) lines.push(`Bcc: ${opts.bcc}`);
  lines.push(`Subject: ${opts.subject}`);
  if (opts.inReplyTo) lines.push(`In-Reply-To: ${opts.inReplyTo}`);
  if (opts.references) lines.push(`References: ${opts.references}`);
  lines.push("Content-Type: text/plain; charset=utf-8");
  lines.push("MIME-Version: 1.0");
  lines.push("");
  lines.push(opts.body);

  const raw = lines.join("\r\n");
  // base64url encode
  return Buffer.from(raw).toString("base64url");
}

function extractBody(payload: any): string {
  // Direct body
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, "base64url").toString("utf-8");
  }

  // Multipart — look for text/plain first, then text/html
  if (payload.parts) {
    const textPart = payload.parts.find((p: any) => p.mimeType === "text/plain");
    if (textPart?.body?.data) {
      return Buffer.from(textPart.body.data, "base64url").toString("utf-8");
    }

    const htmlPart = payload.parts.find((p: any) => p.mimeType === "text/html");
    if (htmlPart?.body?.data) {
      const html = Buffer.from(htmlPart.body.data, "base64url").toString("utf-8");
      // Basic HTML strip
      return html.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
    }

    // Nested multipart
    for (const part of payload.parts) {
      if (part.parts) {
        const nested = extractBody(part);
        if (nested) return nested;
      }
    }
  }

  return "";
}

function getHeader(headers: any[], name: string): string {
  const h = headers?.find((h: any) => h.name.toLowerCase() === name.toLowerCase());
  return h?.value || "";
}

// ── gmail.search ──

registerSkill({
  name: "gmail.search",
  description: "Search Gmail using Gmail query syntax (from:, subject:, is:unread, etc.)",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Gmail search query (e.g. 'is:unread', 'from:john subject:invoice')" },
      maxResults: { type: "number", description: "Max results (default 10, max 20)" },
    },
    required: ["query"],
  },
  async execute(args) {
    const configErr = checkGmailConfig();
    if (configErr) return configErr;

    const query = args.query as string;
    const maxResults = Math.min(Number(args.maxResults) || 10, 20);
    const gmail = getGmailClient();

    try {
      const listRes = await gmail.users.messages.list({
        userId: "me",
        q: query,
        maxResults,
      });

      const messages = listRes.data.messages;
      if (!messages || messages.length === 0) {
        return "No messages found.";
      }

      const results: string[] = [];
      for (const msg of messages) {
        const detail = await gmail.users.messages.get({
          userId: "me",
          id: msg.id!,
          format: "metadata",
          metadataHeaders: ["From", "Subject", "Date"],
        });

        const headers = detail.data.payload?.headers || [];
        results.push([
          `ID: ${msg.id}`,
          `From: ${getHeader(headers, "From")}`,
          `Subject: ${getHeader(headers, "Subject")}`,
          `Date: ${getHeader(headers, "Date")}`,
          `Snippet: ${detail.data.snippet || ""}`,
        ].join("\n"));
      }

      return `Found ${messages.length} message(s):\n\n${results.join("\n---\n")}`;
    } catch (err) {
      return `Error searching Gmail: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

// ── gmail.read ──

registerSkill({
  name: "gmail.read",
  description: "Read the full content of an email by message ID",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      messageId: { type: "string", description: "Gmail message ID" },
    },
    required: ["messageId"],
  },
  async execute(args) {
    const configErr = checkGmailConfig();
    if (configErr) return configErr;

    const messageId = args.messageId as string;
    const gmail = getGmailClient();

    try {
      const res = await gmail.users.messages.get({
        userId: "me",
        id: messageId,
        format: "full",
      });

      const headers = res.data.payload?.headers || [];
      const from = getHeader(headers, "From");
      const to = getHeader(headers, "To");
      const subject = getHeader(headers, "Subject");
      const date = getHeader(headers, "Date");

      let body = extractBody(res.data.payload);
      if (!body) body = res.data.snippet || "(no content)";
      if (body.length > 8000) body = body.slice(0, 8000) + "\n...(truncated)";

      return [
        `From: ${from}`,
        `To: ${to}`,
        `Subject: ${subject}`,
        `Date: ${date}`,
        `Thread ID: ${res.data.threadId}`,
        "",
        body,
      ].join("\n");
    } catch (err) {
      return `Error reading message: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

// ── gmail.send ──

registerSkill({
  name: "gmail.send",
  description: "Send an email (plain text)",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      to: { type: "string", description: "Recipient email address" },
      subject: { type: "string", description: "Email subject" },
      body: { type: "string", description: "Email body (plain text)" },
      cc: { type: "string", description: "CC addresses (comma-separated)" },
      bcc: { type: "string", description: "BCC addresses (comma-separated)" },
    },
    required: ["to", "subject", "body"],
  },
  async execute(args) {
    const configErr = checkGmailConfig();
    if (configErr) return configErr;

    const gmail = getGmailClient();

    try {
      const raw = buildRawEmail({
        to: args.to as string,
        subject: args.subject as string,
        body: args.body as string,
        cc: args.cc as string | undefined,
        bcc: args.bcc as string | undefined,
      });

      const res = await gmail.users.messages.send({
        userId: "me",
        requestBody: { raw },
      });

      return `Email sent successfully. Message ID: ${res.data.id}`;
    } catch (err) {
      return `Error sending email: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

// ── gmail.reply ──

registerSkill({
  name: "gmail.reply",
  description: "Reply to an email (stays in the same thread)",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      messageId: { type: "string", description: "ID of the message to reply to" },
      body: { type: "string", description: "Reply body (plain text)" },
    },
    required: ["messageId", "body"],
  },
  async execute(args) {
    const configErr = checkGmailConfig();
    if (configErr) return configErr;

    const messageId = args.messageId as string;
    const gmail = getGmailClient();

    try {
      // Fetch original message for threading info
      const original = await gmail.users.messages.get({
        userId: "me",
        id: messageId,
        format: "metadata",
        metadataHeaders: ["Subject", "Message-ID", "From"],
      });

      const headers = original.data.payload?.headers || [];
      const originalSubject = getHeader(headers, "Subject");
      const originalMessageId = getHeader(headers, "Message-ID");
      const originalFrom = getHeader(headers, "From");
      const threadId = original.data.threadId!;

      const subject = originalSubject.startsWith("Re:") ? originalSubject : `Re: ${originalSubject}`;

      const raw = buildRawEmail({
        to: originalFrom,
        subject,
        body: args.body as string,
        inReplyTo: originalMessageId,
        references: originalMessageId,
      });

      const res = await gmail.users.messages.send({
        userId: "me",
        requestBody: { raw, threadId },
      });

      return `Reply sent successfully. Message ID: ${res.data.id}`;
    } catch (err) {
      return `Error replying: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

// ── gmail.labels ──

registerSkill({
  name: "gmail.labels",
  description: "Manage Gmail labels (list all, add to message, remove from message)",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      action: { type: "string", description: "'list', 'add', or 'remove'" },
      messageId: { type: "string", description: "Message ID (required for add/remove)" },
      labelName: { type: "string", description: "Label name (required for add/remove)" },
    },
    required: ["action"],
  },
  async execute(args) {
    const configErr = checkGmailConfig();
    if (configErr) return configErr;

    const action = args.action as string;
    const gmail = getGmailClient();

    try {
      if (action === "list") {
        const res = await gmail.users.labels.list({ userId: "me" });
        const labels = res.data.labels || [];
        return labels.map((l) => `${l.name} (${l.id})`).join("\n") || "No labels found.";
      }

      const messageId = args.messageId as string;
      const labelName = args.labelName as string;
      if (!messageId || !labelName) {
        return "Error: messageId and labelName are required for add/remove.";
      }

      // Find label ID by name
      const labelsRes = await gmail.users.labels.list({ userId: "me" });
      const label = labelsRes.data.labels?.find(
        (l) => l.name!.toLowerCase() === labelName.toLowerCase()
      );
      if (!label) return `Error: Label "${labelName}" not found.`;

      if (action === "add") {
        await gmail.users.messages.modify({
          userId: "me",
          id: messageId,
          requestBody: { addLabelIds: [label.id!] },
        });
        return `Label "${labelName}" added to message ${messageId}.`;
      }

      if (action === "remove") {
        await gmail.users.messages.modify({
          userId: "me",
          id: messageId,
          requestBody: { removeLabelIds: [label.id!] },
        });
        return `Label "${labelName}" removed from message ${messageId}.`;
      }

      return `Error: Unknown action "${action}". Use list, add, or remove.`;
    } catch (err) {
      return `Error managing labels: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

// ── gmail.draft ──

registerSkill({
  name: "gmail.draft",
  description: "Create a draft email",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      to: { type: "string", description: "Recipient email address" },
      subject: { type: "string", description: "Email subject" },
      body: { type: "string", description: "Email body (plain text)" },
    },
    required: ["to", "subject", "body"],
  },
  async execute(args) {
    const configErr = checkGmailConfig();
    if (configErr) return configErr;

    const gmail = getGmailClient();

    try {
      const raw = buildRawEmail({
        to: args.to as string,
        subject: args.subject as string,
        body: args.body as string,
      });

      const res = await gmail.users.drafts.create({
        userId: "me",
        requestBody: {
          message: { raw },
        },
      });

      return `Draft created successfully. Draft ID: ${res.data.id}`;
    } catch (err) {
      return `Error creating draft: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});
