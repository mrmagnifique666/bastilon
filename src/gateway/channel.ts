/**
 * Channel abstraction — decouples the core from any specific messaging platform.
 * Each channel (Telegram, Discord, WhatsApp, CLI, WebSocket) implements this interface.
 *
 * The gateway routes incoming messages to the orchestrator and outgoing responses
 * back to the correct channel.
 */

/** Incoming message from any channel */
export interface IncomingMessage {
  /** Unique message ID within the channel */
  messageId: string;
  /** Channel type */
  channel: ChannelType;
  /** User ID within the channel */
  userId: string;
  /** Numeric user ID (for Bastilon internal routing) */
  numericUserId: number;
  /** Chat/conversation ID */
  chatId: number;
  /** Text content */
  text: string;
  /** Optional: reply-to message ID */
  replyTo?: string;
  /** Optional: attached media */
  media?: MessageMedia[];
  /** Optional: raw platform-specific data */
  raw?: unknown;
  /** Timestamp */
  timestamp: number;
}

/** Outgoing message to any channel */
export interface OutgoingMessage {
  /** Target chat ID */
  chatId: number;
  /** Text content */
  text: string;
  /** Optional: parse mode */
  parseMode?: "Markdown" | "HTML" | "plain";
  /** Optional: voice/audio buffer */
  audio?: Buffer;
  /** Optional: image */
  image?: { source: string | Buffer; caption?: string };
}

/** Media attachment */
export interface MessageMedia {
  type: "photo" | "voice" | "document" | "video" | "audio";
  fileId?: string;
  url?: string;
  buffer?: Buffer;
  mimeType?: string;
  fileName?: string;
}

/** Supported channel types */
export type ChannelType = "telegram" | "discord" | "whatsapp" | "websocket" | "cli";

/**
 * Channel interface — implement this for each messaging platform.
 * The gateway manages all channels and routes messages through the orchestrator.
 */
export interface Channel {
  /** Channel type identifier */
  readonly type: ChannelType;
  /** Human-readable name */
  readonly name: string;
  /** Is this channel currently connected? */
  isConnected(): boolean;
  /** Send a text message */
  sendText(chatId: number, text: string, parseMode?: string): Promise<void>;
  /** Send a typing/processing indicator */
  sendTyping(chatId: number): Promise<void>;
  /** Send voice/audio */
  sendVoice?(chatId: number, audio: Buffer, filename: string): Promise<void>;
  /** Send a photo/image */
  sendPhoto?(chatId: number, source: string | Buffer, caption?: string): Promise<void>;
  /** Start the channel (connect, listen) */
  start(): Promise<void>;
  /** Stop the channel (disconnect, cleanup) */
  stop(): Promise<void>;
}

// ── Gateway: channel registry ────────────────────────────────────────

const channels = new Map<ChannelType, Channel>();
const messageHandlers: Array<(msg: IncomingMessage) => Promise<void>> = [];

/** Register a channel with the gateway */
export function registerChannel(channel: Channel): void {
  channels.set(channel.type, channel);
}

/** Get a specific channel */
export function getChannel(type: ChannelType): Channel | undefined {
  return channels.get(type);
}

/** Get all registered channels */
export function listChannels(): Array<{ type: ChannelType; name: string; connected: boolean }> {
  return Array.from(channels.values()).map((ch) => ({
    type: ch.type,
    name: ch.name,
    connected: ch.isConnected(),
  }));
}

/** Register a handler for incoming messages (the orchestrator hook) */
export function onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
  messageHandlers.push(handler);
}

/** Dispatch an incoming message to all registered handlers */
export async function dispatchMessage(msg: IncomingMessage): Promise<void> {
  for (const handler of messageHandlers) {
    try {
      await handler(msg);
    } catch (err) {
      // Don't let one handler crash others
    }
  }
}

/** Send a message through the appropriate channel */
export async function sendToChannel(
  channelType: ChannelType,
  msg: OutgoingMessage,
): Promise<void> {
  const channel = channels.get(channelType);
  if (!channel) throw new Error(`Channel ${channelType} not registered`);
  if (!channel.isConnected()) throw new Error(`Channel ${channelType} not connected`);

  if (msg.audio && channel.sendVoice) {
    await channel.sendVoice(msg.chatId, msg.audio, "response.mp3");
  } else if (msg.image && channel.sendPhoto) {
    await channel.sendPhoto(msg.chatId, msg.image.source, msg.image.caption);
  } else {
    await channel.sendText(msg.chatId, msg.text, msg.parseMode);
  }
}
