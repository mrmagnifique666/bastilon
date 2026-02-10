/**
 * Built-in skills: discord.send, discord.reply, discord.dm,
 * discord.channels, discord.members, discord.join
 * Uses Discord REST API v10 via fetch (no discord.js dependency).
 */
import { registerSkill } from "../loader.js";
import { log } from "../../utils/log.js";

const API = "https://discord.com/api/v10";

function getToken(): string | null {
  return process.env.DISCORD_BOT_TOKEN || null;
}

function checkConfig(): string | null {
  if (!getToken()) return "Discord not configured. Set DISCORD_BOT_TOKEN in .env";
  return null;
}

async function discordFetch(method: string, path: string, body?: unknown): Promise<any> {
  const resp = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bot ${getToken()}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (resp.status === 204) return { success: true };
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`Discord API ${resp.status}: ${data?.message || JSON.stringify(data)}`);
  }
  return data;
}

// ── discord.send ──
registerSkill({
  name: "discord.send",
  description: "Send a message to a Discord channel. Supports text and embeds.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      channelId: { type: "string", description: "Channel ID to send to" },
      text: { type: "string", description: "Message text" },
      embedTitle: { type: "string", description: "Optional embed title" },
      embedDescription: { type: "string", description: "Optional embed description" },
      embedColor: { type: "number", description: "Optional embed color (decimal, e.g. 5814783 for blue)" },
    },
    required: ["channelId", "text"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;

    try {
      const body: any = { content: String(args.text) };
      if (args.embedTitle || args.embedDescription) {
        body.embeds = [{
          title: args.embedTitle ? String(args.embedTitle) : undefined,
          description: args.embedDescription ? String(args.embedDescription) : undefined,
          color: args.embedColor ? Number(args.embedColor) : undefined,
        }];
      }
      const data = await discordFetch("POST", `/channels/${args.channelId}/messages`, body);
      return `Message sent to channel ${args.channelId}: id=${data.id}`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

// ── discord.reply ──
registerSkill({
  name: "discord.reply",
  description: "Reply to a specific Discord message.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      channelId: { type: "string", description: "Channel ID where the message is" },
      messageId: { type: "string", description: "Message ID to reply to" },
      text: { type: "string", description: "Reply text" },
    },
    required: ["channelId", "messageId", "text"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;

    try {
      const data = await discordFetch("POST", `/channels/${args.channelId}/messages`, {
        content: String(args.text),
        message_reference: { message_id: String(args.messageId) },
      });
      return `Reply sent: id=${data.id}`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

// ── discord.dm ──
registerSkill({
  name: "discord.dm",
  description: "Send a direct message to a Discord user.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      userId: { type: "string", description: "Discord user ID to DM" },
      text: { type: "string", description: "Message text" },
    },
    required: ["userId", "text"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;

    try {
      // Create DM channel first
      const channel = await discordFetch("POST", "/users/@me/channels", {
        recipient_id: String(args.userId),
      });
      const data = await discordFetch("POST", `/channels/${channel.id}/messages`, {
        content: String(args.text),
      });
      return `DM sent to user ${args.userId}: id=${data.id}`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

// ── discord.channels ──
registerSkill({
  name: "discord.channels",
  description: "List channels in a Discord server (guild).",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      guildId: { type: "string", description: "Guild (server) ID" },
    },
    required: ["guildId"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;

    try {
      const channels = await discordFetch("GET", `/guilds/${args.guildId}/channels`);
      if (!Array.isArray(channels) || !channels.length) return "No channels found.";

      const typeNames: Record<number, string> = {
        0: "text", 2: "voice", 4: "category", 5: "announcement",
        13: "stage", 15: "forum", 16: "media",
      };

      const lines = channels
        .sort((a: any, b: any) => (a.position || 0) - (b.position || 0))
        .map((c: any) => {
          const type = typeNames[c.type] || `type:${c.type}`;
          return `[${c.id}] #${c.name} (${type})`;
        });
      return `**Channels in guild ${args.guildId}:**\n${lines.join("\n")}`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

// ── discord.members ──
registerSkill({
  name: "discord.members",
  description: "List members of a Discord server.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      guildId: { type: "string", description: "Guild (server) ID" },
      limit: { type: "number", description: "Number of members (default 20, max 100)" },
    },
    required: ["guildId"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;
    const limit = Math.min(Number(args.limit) || 20, 100);

    try {
      const members = await discordFetch("GET", `/guilds/${args.guildId}/members?limit=${limit}`);
      if (!Array.isArray(members) || !members.length) return "No members found.";
      const lines = members.map((m: any) => {
        const user = m.user;
        const nick = m.nick ? ` (${m.nick})` : "";
        const bot = user.bot ? " [BOT]" : "";
        return `${user.username}#${user.discriminator}${nick}${bot}`;
      });
      return `**Members (${members.length}):**\n${lines.join("\n")}`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

// ── discord.join ──
registerSkill({
  name: "discord.join",
  description: "Get info about a Discord invite (bot cannot self-join, but can inspect invites).",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      inviteCode: { type: "string", description: "Invite code (e.g. 'abc123' from discord.gg/abc123)" },
    },
    required: ["inviteCode"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;

    try {
      const code = String(args.inviteCode).replace(/^https?:\/\/(www\.)?discord\.(gg|com\/invite)\//i, "");
      const data = await discordFetch("GET", `/invites/${code}?with_counts=true`);
      return [
        `**Invite: ${code}**`,
        `Server: ${data.guild?.name || "N/A"} (${data.guild?.id || "?"})`,
        `Channel: #${data.channel?.name || "N/A"}`,
        `Members: ~${data.approximate_member_count || "?"} (${data.approximate_presence_count || "?"} online)`,
        `Expires: ${data.expires_at || "never"}`,
      ].join("\n");
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

log.debug("Registered 6 discord.* skills");
