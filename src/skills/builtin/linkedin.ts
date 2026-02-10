/**
 * Built-in skills: linkedin.post, linkedin.comment, linkedin.search,
 * linkedin.profile, linkedin.connect, linkedin.message, linkedin.company
 * Uses LinkedIn REST API v2 with OAuth2 Bearer token.
 */
import { registerSkill } from "../loader.js";
import { log } from "../../utils/log.js";

const API = "https://api.linkedin.com/v2";
const COMMUNITY_API = "https://api.linkedin.com/rest";

function getToken(): string | null {
  return process.env.LINKEDIN_ACCESS_TOKEN || null;
}

function checkConfig(): string | null {
  if (!getToken()) return "LinkedIn not configured. Set LINKEDIN_ACCESS_TOKEN in .env (get via OAuth2 flow).";
  return null;
}

async function linkedinFetch(method: string, path: string, body?: unknown, useRest = false): Promise<any> {
  const base = useRest ? COMMUNITY_API : API;
  const resp = await fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${getToken()}`,
      "Content-Type": "application/json",
      "X-Restli-Protocol-Version": "2.0.0",
      "LinkedIn-Version": "202401",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (resp.status === 204) return { success: true };
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`LinkedIn API ${resp.status}: ${data?.message || JSON.stringify(data)}`);
  }
  return data;
}

// ── linkedin.post ──
registerSkill({
  name: "linkedin.post",
  description: "Share a post on LinkedIn. Supports text, media, and article URLs.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "Post text content" },
      articleUrl: { type: "string", description: "URL to share (optional)" },
    },
    required: ["text"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;

    try {
      // Get user URN
      const me = await linkedinFetch("GET", "/userinfo");
      const personUrn = `urn:li:person:${me.sub}`;

      const postBody: any = {
        author: personUrn,
        lifecycleState: "PUBLISHED",
        specificContent: {
          "com.linkedin.ugc.ShareContent": {
            shareCommentary: { text: String(args.text) },
            shareMediaCategory: args.articleUrl ? "ARTICLE" : "NONE",
          },
        },
        visibility: {
          "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC",
        },
      };

      if (args.articleUrl) {
        postBody.specificContent["com.linkedin.ugc.ShareContent"].media = [{
          status: "READY",
          originalUrl: String(args.articleUrl),
        }];
      }

      const data = await linkedinFetch("POST", "/ugcPosts", postBody);
      return `LinkedIn post published: ${data.id || "success"}`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

// ── linkedin.comment ──
registerSkill({
  name: "linkedin.comment",
  description: "Comment on a LinkedIn post.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      postId: { type: "string", description: "Post URN or ID to comment on" },
      text: { type: "string", description: "Comment text" },
    },
    required: ["postId", "text"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;

    try {
      const me = await linkedinFetch("GET", "/userinfo");
      const actorUrn = `urn:li:person:${me.sub}`;
      const postUrn = String(args.postId).startsWith("urn:") ? args.postId : `urn:li:ugcPost:${args.postId}`;

      await linkedinFetch("POST", `/socialActions/${encodeURIComponent(String(postUrn))}/comments`, {
        actor: actorUrn,
        message: { text: String(args.text) },
      });
      return `Comment posted on ${postUrn}`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

// ── linkedin.search ──
registerSkill({
  name: "linkedin.search",
  description: "Search LinkedIn for people or companies (requires LinkedIn Marketing API access).",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      type: { type: "string", description: "Type: people or companies (default: people)" },
    },
    required: ["query"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;
    const type = String(args.type || "people");

    try {
      // LinkedIn search API is restricted — use keyword search
      const endpoint = type === "companies"
        ? `/organizationSearch?q=search&keywords=${encodeURIComponent(String(args.query))}&count=10`
        : `/peopleSearch?q=search&keywords=${encodeURIComponent(String(args.query))}&count=10`;
      const data = await linkedinFetch("GET", endpoint);
      const elements = data.elements || [];
      if (!elements.length) return `No ${type} found for "${args.query}"`;
      const lines = elements.map((e: any) =>
        `- ${e.title?.text || e.name || e.id}: ${e.headline?.text || e.description || ""}`
      );
      return `**LinkedIn search "${args.query}" (${type}):**\n${lines.join("\n")}`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}. Note: LinkedIn search requires Marketing API access.`;
    }
  },
});

// ── linkedin.profile ──
registerSkill({
  name: "linkedin.profile",
  description: "Get your LinkedIn profile info.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {},
  },
  async execute(): Promise<string> {
    const err = checkConfig();
    if (err) return err;

    try {
      const me = await linkedinFetch("GET", "/userinfo");
      const lines = [
        `**Name:** ${me.name || "N/A"}`,
        `**Email:** ${me.email || "N/A"}`,
        `**Sub:** ${me.sub || "N/A"}`,
        `**Locale:** ${me.locale || "N/A"}`,
      ];
      return lines.join("\n");
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

// ── linkedin.connect ──
registerSkill({
  name: "linkedin.connect",
  description: "Send a connection request to a LinkedIn user.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      personUrn: { type: "string", description: "Person URN (urn:li:person:XXXXX)" },
      message: { type: "string", description: "Optional connection message (max 300 chars)" },
    },
    required: ["personUrn"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;

    try {
      const body: any = {
        invitee: String(args.personUrn),
      };
      if (args.message) {
        const msg = String(args.message);
        if (msg.length > 300) return "Error: Connection message must be 300 chars or less.";
        body.message = msg;
      }
      await linkedinFetch("POST", "/invitations", body);
      return `Connection request sent to ${args.personUrn}`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

// ── linkedin.message ──
registerSkill({
  name: "linkedin.message",
  description: "Send a message to a LinkedIn connection.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      personUrn: { type: "string", description: "Person URN of the recipient (must be a connection)" },
      text: { type: "string", description: "Message text" },
    },
    required: ["personUrn", "text"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;

    try {
      const me = await linkedinFetch("GET", "/userinfo");
      const senderUrn = `urn:li:person:${me.sub}`;

      await linkedinFetch("POST", "/messages", {
        recipients: [String(args.personUrn)],
        subject: "Message from Kingston",
        body: { text: String(args.text) },
        sender: senderUrn,
      });
      return `Message sent to ${args.personUrn}`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

// ── linkedin.company ──
registerSkill({
  name: "linkedin.company",
  description: "Get company info from LinkedIn.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      companyId: { type: "string", description: "Company ID or vanity name" },
    },
    required: ["companyId"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;

    try {
      const data = await linkedinFetch("GET", `/organizations/${encodeURIComponent(String(args.companyId))}`);
      const lines = [
        `**Name:** ${data.localizedName || data.name || "N/A"}`,
        `**Industry:** ${data.industries?.[0] || "N/A"}`,
        `**Size:** ${data.staffCount || data.staffCountRange?.start || "N/A"} employees`,
        `**Website:** ${data.localizedWebsite || "N/A"}`,
        `**Description:** ${(data.localizedDescription || "").slice(0, 300)}`,
      ];
      return lines.join("\n");
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

log.debug("Registered 7 linkedin.* skills");
