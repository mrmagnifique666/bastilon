/**
 * Gemini Live API — Real-time voice conversations via WebSocket.
 * Single WebSocket hop: audio in → audio out + function calling.
 *
 * Audio: PCM 16kHz mono int16 in → PCM 24kHz mono int16 out (base64 encoded).
 * Supports: function calling (tools), interruption (barge-in), built-in VAD.
 * Session limit: 15 min (auto-reconnect at 14 min).
 *
 * Tools: Dynamically loads ALL Kingston skills from the registry.
 * Dots are converted to underscores for Gemini Live compatibility.
 * Special tools: change_voice, telegram_history.
 */
import WebSocket from "ws";
import { config } from "../config/env.js";
import { log } from "../utils/log.js";
import {
  getAllSkills,
  getSkill,
  validateArgs as validateSkillArgs,
  type Skill,
} from "../skills/loader.js";
import { normalizeArgs, loadSessionLog } from "./gemini.js";
import { isToolPermitted } from "../security/policy.js";
import { buildSemanticContext, extractAndStoreMemories, addMemory } from "../memory/semantic.js";
import { getTurns, getDb, addTurn, dungeonListSessions, dungeonGetSession, dungeonGetCharacters, dungeonGetTurns } from "../storage/store.js";
import { emitHookAsync } from "../hooks/hooks.js";
import fs from "node:fs";
import path from "node:path";

const MODEL = "gemini-2.5-flash-native-audio-latest";
const SESSION_TIMEOUT_MS = 14 * 60 * 1000;
const MAX_RECONNECT_ATTEMPTS = 3;
const MAX_LIVE_TOOLS = 80;
const MAX_PHONE_TOOLS = 25; // Phone calls: keep payload small to avoid 1008 (dungeon.* included via priority)

/** Paths for persistent voice session files */
const VOICE_CONV_FILE = path.resolve("relay/voice-conversation.json");
const VOICE_DND_FILE = path.resolve("relay/voice-dnd-state.md");

/** Blocked prefixes for voice mode — too heavy, slow, or crash-prone */
const BLOCKED_PREFIXES = ["browser.", "ollama.", "pdf."];

/** Additional blocked prefixes for phone calls — prevent infinite loops + reduce tool count */
const PHONE_BLOCKED_PREFIXES = [
  "phone.", "sms.", "wakeword.", "printful.", "shopify.",
  "cohere.", "mistral.", "together.", "replicate.", "workflow.",
  "tutor.", "jobs.", "travel.", "health.", "invoice.", "youtube.",
  "brand.", "autofix.", "price.", "plugin.", "verify.", "xp.",
  "hackernews.", "wiki.", "books.", "archive.", "food.", "worldbank.",
  "finnhub.", "stackexchange.", "nasa.", "pollinations.", "newsdata.",
  "dns.", "dict.", "words.", "holidays.", "qr.", "url.",
  "mcp.", "hooks.", "secrets.", "marketing.", "clients.", "content.",
  "kg.", "episodic.", "rules.", "goal.", "autonomous.", "notify.",
  "planner.", "revenue.", "selfimprove.", "experiment.", "optimize.",
  "linkedin.", "reddit.", "discord.", "facebook.", "instagram.",
  "stripe.", "booking.", "hubspot.", "whatsapp.",
  "registry.", "task_scheduler.", "power.", "windows.", "winget.",
  "pip.", "npm.", "ssh.", "wsl.", "tunnel.", "mouse.", "keyboard.",
  "screenshot.", "desktop.", "app.", "process.",
];

/** Priority prefixes — included first (order matters) */
const PRIORITY_PREFIXES = [
  "help", "notes.", "files.", "shell.", "web.", "telegram.", "system.",
  "code.", "scheduler.", "errors.", "time.", "translate.", "git.",
  "memory.", "ftp.", "contacts.", "gmail.", "calendar.", "phone.",
  "agents.", "config.", "weather.", "network.", "rss.", "math.",
  "hash.", "convert.", "trading.", "mood.", "soul.", "stocks.",
  "crypto.", "desktop.", "app.", "process.", "image.",
  "news.", "forex.", "nlp.", "solutions.", "google.", "validate.", "geo.",
  "cohere.", "mistral.", "together.", "replicate.", "workflow.",
  "dungeon.",
];

/** Phone-only priority — minimal set to keep payload small + dungeon */
const PHONE_PRIORITY_PREFIXES = [
  "help", "notes.", "web.", "memory.", "time.", "weather.",
  "trading.", "stocks.", "crypto.", "calendar.", "scheduler.",
  "image.", "dungeon.",
];

// ── Gemini type mapping ────────────────────────────────────────────

function toGeminiType(t: string): string {
  const map: Record<string, string> = {
    string: "STRING", number: "NUMBER", boolean: "BOOLEAN",
    integer: "INTEGER", array: "ARRAY", object: "OBJECT",
  };
  return map[t] || "STRING";
}

interface LiveToolDecl {
  name: string;
  description: string;
  parameters: object;
}

/** Convert a Kingston skill to a Gemini Live function declaration (dots → underscores). */
function skillToLiveDecl(skill: Skill): LiveToolDecl {
  const properties: Record<string, Record<string, unknown>> = {};
  for (const [key, prop] of Object.entries(skill.argsSchema.properties)) {
    const entry: Record<string, unknown> = {
      type: toGeminiType(prop.type),
    };
    if (prop.description) entry.description = prop.description;
    // Array types MUST have an "items" field for Gemini schema validation
    if (prop.type === "array") {
      entry.items = { type: toGeminiType(prop.items?.type || "string") };
    }
    properties[key] = entry;
  }
  return {
    name: skill.name.replace(/\./g, "_"),
    description: skill.description,
    parameters: {
      type: "OBJECT",
      properties,
      ...(skill.argsSchema.required?.length ? { required: skill.argsSchema.required } : {}),
    },
  };
}

/** Special tools handled internally (not Kingston skills). */
function getSpecialTools(): { decl: LiveToolDecl; handler: string }[] {
  return [
    {
      handler: "SPECIAL:change_voice",
      decl: {
        name: "change_voice",
        description:
          "Change Kingston's voice. Available: Enceladus (deep male), Puck (young male), Charon (calm male), Kore (female), Aoede (female), Fenrir (male)",
        parameters: {
          type: "OBJECT",
          properties: { voice: { type: "STRING", description: "Voice name" } },
          required: ["voice"],
        },
      },
    },
    {
      handler: "SPECIAL:telegram_history",
      decl: {
        name: "telegram_history",
        description:
          "Read recent Telegram conversation messages between Kingston and Nicolas",
        parameters: {
          type: "OBJECT",
          properties: {
            limit: {
              type: "NUMBER",
              description: "Number of recent messages (default 20, max 50)",
            },
          },
        },
      },
    },
  ];
}

/**
 * Build all tool declarations dynamically from the Kingston registry + special tools.
 * Priority skills first, capped at MAX_LIVE_TOOLS.
 */
function buildLiveTools(isPhoneCall = false): {
  decls: LiveToolDecl[];
  nameMap: Map<string, string>;
} {
  const blocked = [...BLOCKED_PREFIXES, ...(isPhoneCall ? PHONE_BLOCKED_PREFIXES : [])];
  const allSkills = getAllSkills().filter(
    (s) => !blocked.some((p) => s.name.startsWith(p)),
  );

  // Sort: priority prefixes first, then rest
  // Phone calls use a smaller priority set to keep payload under 15KB
  const priorityList = isPhoneCall ? PHONE_PRIORITY_PREFIXES : PRIORITY_PREFIXES;
  const priority: Skill[] = [];
  const rest: Skill[] = [];
  for (const s of allSkills) {
    const isPriority =
      s.name === "help" ||
      priorityList.some((p) => s.name.startsWith(p));
    if (isPriority) priority.push(s);
    else rest.push(s);
  }

  const specials = getSpecialTools();
  const maxTools = isPhoneCall ? MAX_PHONE_TOOLS : MAX_LIVE_TOOLS;
  const cap = maxTools - specials.length;
  const selected = [...priority, ...rest].slice(0, cap);

  const decls: LiveToolDecl[] = [];
  const nameMap = new Map<string, string>(); // gemini_name → kingston.name

  for (const skill of selected) {
    const decl = skillToLiveDecl(skill);
    decls.push(decl);
    nameMap.set(decl.name, skill.name);
  }

  // Add special tools
  for (const special of specials) {
    decls.push(special.decl);
    nameMap.set(special.decl.name, special.handler);
  }

  log.info(
    `[gemini-live] ${decls.length} tools (${priority.length} priority + ` +
      `${Math.min(rest.length, Math.max(0, cap - priority.length))} extra + ` +
      `${specials.length} special)`,
  );
  return { decls, nameMap };
}

// ── Session interfaces ─────────────────────────────────────────────

export interface LiveCallbacks {
  onAudio(base64Pcm24k: string): void;
  onText(text: string, role: "user" | "model"): void;
  onInterrupted(): void;
  onTurnComplete(): void;
  onToolCall(name: string, args: Record<string, unknown>): void;
  onToolResult(name: string, result: string): void;
  onImageGenerated?(url: string, caption: string): void;
  onReady(): void;
  onError(msg: string): void;
  onClose(): void;
}

export interface LiveSessionOptions {
  chatId: number;
  userId: number;
  isAdmin: boolean;
  callbacks: LiveCallbacks;
  voiceName?: string;
  language?: string;
  /** When true, adds phone-specific instructions and blocks telegram.* tools */
  isPhoneCall?: boolean;
}

// ── GeminiLiveSession ──────────────────────────────────────────────

export class GeminiLiveSession {
  private ws: WebSocket | null = null;
  private opts: LiveSessionOptions;
  private sessionTimer: ReturnType<typeof setTimeout> | null = null;
  private connected = false;
  private closed = false;
  private reconnectAttempts = 0;
  private cachedMemoryContext = "";
  private conversationLog: string[] = [];
  private static readonly MAX_CONVERSATION_LOG = 100;
  private lastConnectTime = 0;

  /** Compressed summary of the conversation so far (generated before reconnect). */
  private conversationSummary = "";

  /** Active D&D session context (refreshed on each connect). */
  private dndContext = "";

  // Track current turn for memory extraction
  private currentUserText = "";
  private currentModelText = "";

  // Dynamic tools — built once at construction, rebuilt on reconnect
  private toolDecls: LiveToolDecl[] = [];
  private toolNameMap = new Map<string, string>();

  constructor(opts: LiveSessionOptions) {
    this.opts = opts;
    this.rebuildTools();
    // Restore conversation from a previous session if file exists
    this.restoreConversation();
  }

  /** Add entry to conversation log, capping at MAX_CONVERSATION_LOG. */
  private logConversation(entry: string): void {
    this.conversationLog.push(entry);
    if (this.conversationLog.length > GeminiLiveSession.MAX_CONVERSATION_LOG) {
      this.conversationLog.splice(0, this.conversationLog.length - GeminiLiveSession.MAX_CONVERSATION_LOG);
    }
  }

  /** Rebuild tool declarations from the live registry. */
  private rebuildTools(): void {
    const { decls, nameMap } = buildLiveTools(this.opts.isPhoneCall);
    this.toolDecls = decls;
    this.toolNameMap = nameMap;
  }

  /** Open the WebSocket connection to Gemini Live. */
  async connect(): Promise<void> {
    if (!config.geminiApiKey) {
      this.opts.callbacks.onError("GEMINI_API_KEY not configured");
      return;
    }

    // Pre-fetch rich context (fire once, cached for session)
    if (!this.cachedMemoryContext) {
      this.cachedMemoryContext = await this.buildRichContext();
    }

    // Load D&D context if a session is active
    this.refreshDndContext();

    const url =
      `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent` +
      `?key=${config.geminiApiKey}`;

    log.info(
      `[gemini-live] Connecting (chatId=${this.opts.chatId}, model=${MODEL}, attempt=${this.reconnectAttempts + 1})...`,
    );

    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      this.reconnectAttempts = 0;
      this.lastConnectTime = Date.now();
      // Rebuild tools on each connection (picks up any newly registered skills)
      this.rebuildTools();
      const setup = this.buildSetup();
      const payload = JSON.stringify(setup);
      log.info(
        `[gemini-live] WebSocket open, sending setup (${payload.length} bytes, ${this.toolDecls.length} tools)...`,
      );
      if (payload.length > 15000 && this.opts.isPhoneCall) {
        log.warn(`[gemini-live] ⚠️ Phone setup payload is ${payload.length} bytes — may cause 1008. Consider reducing tools/context.`);
      }
      this.ws!.send(payload);

      // Auto-reconnect before 15min session limit
      this.sessionTimer = setTimeout(() => {
        log.info(
          "[gemini-live] Session nearing 15min limit, reconnecting...",
        );
        this.reconnect();
      }, SESSION_TIMEOUT_MS);
    });

    this.ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        this.handleMessage(msg).catch((err) => {
          log.error(`[gemini-live] Async message handler error: ${(err as Error).message}`);
        });
      } catch (err) {
        log.warn(
          `[gemini-live] Failed to parse message: ${(err as Error).message}`,
        );
      }
    });

    this.ws.on("error", (err) => {
      log.error(`[gemini-live] WS error: ${err.message}`);
      this.opts.callbacks.onError(err.message);
    });

    this.ws.on("close", (code, reason) => {
      const reasonStr = reason ? reason.toString() : "";
      const sessionDuration = Date.now() - this.lastConnectTime;
      log.info(
        `[gemini-live] WS closed (code=${code}${reasonStr ? ", reason=" + reasonStr : ""}, after ${Math.round(sessionDuration / 1000)}s)`,
      );
      this.connected = false;
      this.clearTimer();
      // Auto-reconnect on ANY non-intentional close (this.closed is only true when close() is called explicitly)
      if (!this.closed) {
        // If 1008 happens within 15s of connect, it's likely a payload/model issue, not transient
        if (code === 1008 && sessionDuration < 15000 && this.reconnectAttempts >= 1) {
          log.warn(`[gemini-live] Fast 1008 crash (${Math.round(sessionDuration / 1000)}s) — likely payload issue, not retrying`);
          this.opts.callbacks.onError("Connection rejected — try reducing context or tools");
          return;
        }
        log.info(`[gemini-live] Session ended (code=${code}), attempting reconnect...`);
        this.reconnect();
        return;
      }
    });
  }

  /** Stream microphone audio (PCM 16kHz mono int16, base64). */
  sendAudio(base64Pcm16k: string): void {
    if (!this.connected || !this.ws) return;
    this.ws.send(
      JSON.stringify({
        realtimeInput: {
          mediaChunks: [
            { mimeType: "audio/pcm;rate=16000", data: base64Pcm16k },
          ],
        },
      }),
    );
  }

  /** Send a text message (for typed input or system triggers). */
  sendText(text: string): void {
    if (!this.connected || !this.ws) return;
    // Don't pollute user text tracking with system triggers
    const isSystem = text.startsWith("[SYSTÈME") || text.startsWith("[SYSTEM");
    if (!isSystem) {
      this.currentUserText += (this.currentUserText ? " " : "") + text;
    }
    this.logConversation(isSystem ? `[System] ${text.slice(0, 100)}` : `[Nicolas] ${text}`);
    this.ws.send(
      JSON.stringify({
        clientContent: {
          turns: [{ role: "user", parts: [{ text }] }],
          turnComplete: true,
        },
      }),
    );
  }

  /** Send a webcam frame for visual context. */
  sendImage(base64Jpeg: string): void {
    if (!this.connected || !this.ws) return;
    this.ws.send(
      JSON.stringify({
        clientContent: {
          turns: [
            {
              role: "user",
              parts: [
                { inlineData: { mimeType: "image/jpeg", data: base64Jpeg } },
              ],
            },
          ],
          turnComplete: false,
        },
      }),
    );
  }

  /** Gracefully close the session, saving conversation summary + emitting hook. */
  close(): void {
    this.closed = true;
    this.clearTimer();
    this.saveConversationSummary();
    this.saveEpisodicSummary();
    this.persistConversation();
    // No longer delete — let the file expire naturally via TTL (4h)
    // so Nicolas can hang up and call back with context preserved
    // Emit voice session end hook (fire-and-forget)
    emitHookAsync("voice:session:end", {
      chatId: this.opts.chatId,
      userId: this.opts.userId,
      turnCount: this.conversationLog.length,
      conversationLog: this.conversationLog.slice(-30),
    });
    if (this.ws) {
      try {
        this.ws.close();
      } catch (e) { log.debug(`[gemini-live] Cleanup: ${e}`); }
      this.ws = null;
    }
    this.connected = false;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  // ── Private ────────────────────────────────────────────────────

  private clearTimer(): void {
    if (this.sessionTimer) {
      clearTimeout(this.sessionTimer);
      this.sessionTimer = null;
    }
  }

  /** Build rich context: memories + recent Telegram + episodic events + notes. */
  private async buildRichContext(): Promise<string> {
    const parts: string[] = [];
    const isPhone = this.opts.isPhoneCall;

    // 1. Semantic memories — phone uses focused query to avoid agent pollution
    try {
      const query = isPhone
        ? "Nicolas préférences projets personnels trading agenda rendez-vous"
        : "Nicolas profil préférences projets activités récentes travail aujourd'hui Kingston Bastilon";
      const limit = isPhone ? 8 : 15;
      const mem = await buildSemanticContext(query, limit);
      if (mem) parts.push(mem);
    } catch (e) { log.warn(`[gemini-live] Failed to load semantic memories: ${e}`); }

    // 2. Recent Telegram conversation (last 20 turns from main chat)
    try {
      const telegramChatId = config.allowedUsers?.[0] || this.opts.userId;
      const turns = getTurns(telegramChatId);
      const recent = turns.slice(-20);
      if (recent.length > 0) {
        const lines = recent.map(
          (t) => `[${t.role === "user" ? "Nicolas" : "Kingston"}] ${(t.content || "").slice(0, 200)}`,
        );
        parts.push(`\n[HISTORIQUE TELEGRAM RÉCENT — ${recent.length} messages]\n${lines.join("\n")}`);
      }
    } catch (e) { log.warn(`[gemini-live] Failed to load Telegram history: ${e}`); }

    // 2b. Previous voice conversation turns (chatId 5)
    try {
      const voiceTurns = getTurns(this.opts.chatId);
      const recentVoice = voiceTurns.slice(-20);
      if (recentVoice.length > 0) {
        const lines = recentVoice.map(
          (t) => `[${t.role === "user" ? "Nicolas (voice)" : "Kingston"}] ${(t.content || "").slice(0, 200)}`,
        );
        parts.push(`\n[HISTORIQUE VOICE RÉCENT — ${recentVoice.length} messages]\n${lines.join("\n")}`);
      }
    } catch (e) { log.warn(`[gemini-live] Failed to load voice history: ${e}`); }

    // 3. Recent episodic events (today)
    try {
      const db = getDb();
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      // Phone: exclude agent-generated events to prevent identity confusion
      const agentExclude = isPhone
        ? ` AND event_type NOT IN ('agent_cycle', 'agent_action', 'cron_execution', 'content_posted', 'moltbook_post', 'engagement_batch')`
        : "";
      const events = db
        .prepare(
          `SELECT summary, event_type, importance FROM episodic_events
           WHERE created_at > ?${agentExclude} ORDER BY created_at DESC LIMIT ${isPhone ? 5 : 10}`,
        )
        .all(Math.floor(todayStart.getTime() / 1000)) as { summary: string; event_type: string; importance: number }[];
      if (events.length > 0) {
        const lines = events.map(
          (e) => `- [${e.event_type}] ${e.summary.slice(0, 150)}`,
        );
        parts.push(`\n[ÉVÉNEMENTS AUJOURD'HUI]\n${lines.join("\n")}`);
      }
    } catch (e) { log.warn(`[gemini-live] Failed to load episodic events: ${e}`); }

    // 3b. Previous voice session summaries (last 3) for cross-session memory
    try {
      const db = getDb();
      const voiceSessions = db
        .prepare(
          `SELECT summary, details FROM episodic_events
           WHERE event_type = 'voice_session' ORDER BY created_at DESC LIMIT 3`,
        )
        .all() as { summary: string; details: string }[];
      if (voiceSessions.length > 0) {
        const lines = voiceSessions.map(
          (s) => `- ${s.summary}: ${(s.details || "").slice(0, 300)}`,
        );
        parts.push(`\n[SESSIONS VOICE PRÉCÉDENTES]\n${lines.join("\n")}`);
      }
    } catch (e) { log.warn(`[gemini-live] Failed to load voice session history: ${e}`); }

    // 4. Recent notes (last 5, fewer for phone)
    try {
      const db = getDb();
      const notes = db
        .prepare(`SELECT text FROM notes ORDER BY created_at DESC LIMIT ${isPhone ? 3 : 5}`)
        .all() as { text: string }[];
      if (notes.length > 0) {
        const lines = notes.map((n) => `- ${n.text.slice(0, 150)}`);
        parts.push(`\n[NOTES RÉCENTES]\n${lines.join("\n")}`);
      }
    } catch (e) { log.warn(`[gemini-live] Failed to load recent notes: ${e}`); }

    const ctx = parts.join("\n");
    log.info(`[gemini-live] Rich context: ${ctx.length} chars (mem+telegram+episodic+notes)`);
    return ctx;
  }

  /** Save current turn to DB and extract memories (fire-and-forget). */
  private saveTurnAndExtract(): void {
    const userText = this.currentUserText.trim();
    const modelText = this.currentModelText.trim();

    // Reset for next turn
    this.currentUserText = "";
    this.currentModelText = "";

    if (!userText && !modelText) return;

    const chatId = this.opts.chatId;

    // Save turns to DB (same as Telegram flow)
    if (userText) {
      addTurn(chatId, { role: "user", content: `[voice] ${userText}` });
    }
    if (modelText) {
      addTurn(chatId, { role: "assistant", content: modelText });
    }

    // Extract memories (fire-and-forget, no latency impact)
    if (userText && modelText) {
      extractAndStoreMemories(
        chatId,
        `User (voice): ${userText}\nAssistant: ${modelText}`,
      )
        .then((count) => {
          if (count > 0) log.debug(`[gemini-live] Extracted ${count} memories from voice turn`);
        })
        .catch((err) => {
          log.debug(`[gemini-live] Memory extraction failed: ${err instanceof Error ? err.message : String(err)}`);
        });
    }
  }

  /** Save conversation log as a note so Kingston remembers next session. */
  private saveConversationSummary(): void {
    if (this.conversationLog.length < 2) return;
    try {
      const summary = this.conversationLog.slice(-20).join("\n");
      const skill = getSkill("notes.add");
      if (skill) {
        skill
          .execute({
            text: `[Voice session ${new Date().toISOString().slice(0, 16)}]\n${summary}`,
          })
          .catch(() => {});
      }
    } catch (e) { log.warn(`[gemini-live] Failed to save conversation summary: ${e}`); }
  }

  /** Save a consolidated episodic memory of the voice session for cross-session recall. */
  private saveEpisodicSummary(): void {
    if (this.conversationLog.length < 4) return;
    try {
      const logText = this.conversationLog.slice(-30).join("\n");
      // Store as episodic event for later recall
      const episodicSkill = getSkill("episodic.log");
      if (episodicSkill) {
        episodicSkill.execute({
          event_type: "voice_session",
          summary: `Voice session with ${this.conversationLog.length} exchanges`,
          details: logText.slice(0, 2000),
          participants: "Nicolas, Kingston",
          importance: Math.min(Math.floor(this.conversationLog.length / 4), 8),
          emotional_valence: 0,
        }).catch(() => {});
      }
      // Also store a semantic memory summary for the next voice session context
      const topics = this.conversationLog
        .filter(l => !l.startsWith("[Tool]") && !l.startsWith("[Result]"))
        .slice(-10)
        .join(" ")
        .slice(0, 500);
      if (topics.length > 50) {
        addMemory(
          `[Voice ${new Date().toISOString().slice(0, 16)}] ${topics}`,
          "event",
          "voice-session",
          this.opts.chatId,
        ).catch(() => {});
      }
    } catch (e) { log.warn(`[gemini-live] Failed to save episodic summary: ${e}`); }
  }

  private reconnect(): void {
    this.clearTimer();
    if (this.ws) {
      try {
        this.ws.close();
      } catch (e) { log.debug(`[gemini-live] Cleanup: ${e}`); }
      this.ws = null;
    }
    this.connected = false;
    this.reconnectAttempts++;
    if (this.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
      log.error(
        `[gemini-live] Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached, giving up`,
      );
      this.opts.callbacks.onError(
        `Connection failed after ${MAX_RECONNECT_ATTEMPTS} attempts`,
      );
      return;
    }

    // Before reconnecting: persist conversation + generate summary
    this.persistConversation();
    this.generateConversationSummary()
      .then(() => {
        this.refreshDndContext();
        const delay = Math.min(1000 * this.reconnectAttempts, 5000);
        setTimeout(() => {
          if (!this.closed) void this.connect();
        }, delay);
      })
      .catch(() => {
        // Summary failed — reconnect anyway with raw conversation log
        this.refreshDndContext();
        const delay = Math.min(1000 * this.reconnectAttempts, 5000);
        setTimeout(() => {
          if (!this.closed) void this.connect();
        }, delay);
      });
  }

  private buildSetup(): object {
    const lang = this.opts.language || "fr";
    const voiceName = this.opts.voiceName || "Enceladus";

    // Current date/time with timezone (fixes "doesn't know the time" issue)
    const now = new Date();
    const dateStr = now.toLocaleDateString("fr-CA", {
      timeZone: "America/Toronto",
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    const timeStr = now.toLocaleTimeString("fr-CA", {
      timeZone: "America/Toronto",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });

    // Rich system prompt — same level of context as Telegram Kingston
    const systemParts: string[] = [
      `## IDENTITÉ (OBLIGATOIRE)`,
      `Tu es Kingston, l'assistant IA personnel de Nicolas. Tu fais partie de Bastilon OS.`,
      `Tu n'es PAS un agent automatisé. Tu n'es PAS le "Moltbook agent", le "Scout", le "Sentinel", ni aucun autre agent.`,
      `Tu es Kingston, l'IA principale qui parle DIRECTEMENT à Nicolas.`,
      `Ton utilisateur est Nicolas, entrepreneur francophone au Canada (Gatineau, Québec).`,
      `Personnalité: direct, proactif, honnête, loyal à Nicolas. Tu tutoies Nicolas.`,
      ``,
      `## DATE ET HEURE (OBLIGATOIRE — NE JAMAIS CALCULER TOI-MÊME)`,
      `Date: ${dateStr}`,
      `Heure: ${timeStr} (heure de l'Est / America/Toronto, fuseau de Gatineau)`,
      `UTILISE UNIQUEMENT cette heure. Ne calcule PAS l'heure toi-même, ne devine pas, ne dis pas une autre heure.`,
      ``,
    ];

    if (this.opts.isPhoneCall) {
      systemParts.push(
        `## MODE APPEL TÉLÉPHONIQUE (CRITIQUE)`,
        `Tu es en APPEL TÉLÉPHONIQUE avec Nicolas via Twilio.`,
        `RAPPEL: Tu es KINGSTON, l'assistant personnel de Nicolas. Tu n'es PAS un agent (Scout, Analyst, Mind, Sentinel, etc.). Les agents sont des sous-systèmes qui travaillent en arrière-plan. TOI tu es Kingston, celui qui parle à Nicolas.`,
        `IMMÉDIAT: Dès que la session audio démarre, parle IMMÉDIATEMENT pour te présenter. Dis "Bonjour, ici Kingston." d'une voix chaleureuse. N'attends PAS que l'utilisateur parle en premier.`,
        `RÈGLE #1: Tes RÉPONSES doivent être VOCALES. Tu parles, l'audio sort dans le téléphone. Ne réponds PAS par telegram.send ou telegram.voice — parle directement.`,
        `RÈGLE #2: Si Nicolas te demande d'ENVOYER quelque chose sur Telegram (image, meme, message, lien), utilise telegram.send ou image.generate — c'est OK. Mais confirme vocalement que tu l'as fait.`,
        `RÈGLE #3: Sois CONCIS. Phrases courtes, naturelles, comme une vraie conversation téléphonique.`,
        `RÈGLE #4: Pas de markdown, pas de listes, pas de formatage. Tu PARLES, tu n'écris pas. Ne génère JAMAIS de texte markdown comme **bold** ou des listes. Tout ce que tu produis doit être de la parole naturelle.`,
        `RÈGLE #5: Ne raccroche JAMAIS. Reste en ligne tant que Nicolas n'a pas dit au revoir.`,
        `RÈGLE #6: Tu te présentes UNE SEULE FOIS au début de l'appel. Après ça, NE RÉPÈTE PLUS JAMAIS la salutation. Même après un outil, une pause, ou une reconnexion, continue la conversation naturellement.`,
        ``,
      );
      // D&D DM instructions for phone mode (only when a session is active)
      if (this.dndContext) {
        systemParts.push(
          `## MODE DUNGEON MASTER (TÉLÉPHONE)`,
          `Tu es aussi le Dungeon Master de la partie D&D en cours.`,
          `Narration immersive et concise — décris les scènes avec ambiance mais en phrases courtes.`,
          `Annonce les jets de dés à voix haute: "Tu lances un d20... 14 plus 3, ça fait 17, c'est une réussite!"`,
          `Pas de markdown, pas de tableaux. Tout doit être parlé naturellement.`,
          `Utilise dungeon_play pour les actions, dungeon_roll pour les jets, dungeon_status pour l'état.`,
          ``,
        );
      }
    } else {
      systemParts.push(
        `## Mode vocal`,
        `Conversation vocale temps réel. Parle ${lang === "fr" ? "français" : "anglais"} naturellement.`,
        `Sois concis — pas de markdown, pas de listes. Tu PARLES, tu n'écris pas.`,
        ``,
      );
    }

    systemParts.push(
      `## FLUIDITÉ VOCALE (CRITIQUE)`,
      `- AVANT d'appeler un outil, dis une courte phrase naturelle: "Un instant...", "Laisse-moi vérifier...", "Je regarde ça..."`,
      `- Ne reste JAMAIS silencieux. Parle d'abord, PUIS appelle l'outil.`,
      `- Si tu appelles PLUSIEURS outils, mentionne-le: "Je vérifie plusieurs choses..."`,
      `- Quand tu reçois le résultat d'un outil, reformule-le naturellement. Ne lis pas le JSON brut.`,
      ``,
      `## RÈGLES ANTI-HALLUCINATION (CRITIQUE)`,
      `1. **JAMAIS inventer de données.** Si tu ne sais pas → utilise un outil pour vérifier.`,
      `2. **JAMAIS donner de chiffres, prix, dates, statistiques de mémoire.** Utilise TOUJOURS un outil (web_search, trading_positions, memory_search, telegram_history) pour obtenir les données réelles.`,
      `3. Si on te demande "qu'est-ce qui s'est passé aujourd'hui" → utilise telegram_history et memory_search. Ne résume PAS de mémoire.`,
      `4. Si on te demande un prix, une position, un P&L → utilise trading_positions ou stocks_quote. Ne devine JAMAIS.`,
      `5. Si tu n'as pas l'info après avoir cherché, dis "je n'ai pas trouvé cette information" plutôt qu'inventer.`,
      `6. Quand tu rapportes des faits, cite ta source ("d'après ton historique Telegram...", "selon ta note du...").`,
      `7. Distingue clairement ce que tu SAIS (de tes outils) vs ce que tu PENSES (opinion).`,
      ``,
      `## Capacités`,
      `Tu as ${this.toolDecls.length} outils disponibles. Tu peux AGIR, pas juste parler:`,
      `- Chercher dans ta mémoire (memory_search), consulter le web (web_search)`,
      `- Consulter l'historique (telegram_history) — TOUJOURS utiliser avant de répondre sur les activités récentes`,
      `- Lire/écrire des fichiers, exécuter du code, gérer des notes`,
      `- Consulter les agents, le trading, les positions`,
      `- Gérer des cron jobs, des rappels, des plans`,
      `Quand Nicolas te demande quelque chose, FAIS-LE avec les outils. Ne dis pas "je ne peux pas".`,
      `**Règle d'or: Appelle un outil AVANT de répondre. Ne réponds jamais avec des données que tu n'as pas vérifiées.**`,
    );

    // For phone calls: keep prompt SHORT to avoid 1008 crashes (target < 8K chars)
    // For dashboard voice: full context is fine
    if (!this.opts.isPhoneCall) {
      // Inject session log (unified cross-channel knowledge)
      const sessionLog = loadSessionLog();
      if (sessionLog) {
        systemParts.push(``, `## Session Log`, sessionLog);
      }
    }

    // Inject rich context (memories + telegram history + episodic + notes)
    // For phone: truncate aggressively to keep setup payload small (avoid 1008)
    if (this.cachedMemoryContext) {
      // Phone: aggressive truncation to keep total payload < 15KB
      // On reconnect, summary + conv log add ~2KB so we need less memory context
      const hasReconnectData = this.conversationSummary || this.conversationLog.length > 0;
      const phoneLimit = this.opts.isPhoneCall
        ? (hasReconnectData ? 800 : (this.dndContext ? 1200 : 2000))
        : Infinity;
      const ctx = this.opts.isPhoneCall
        ? this.cachedMemoryContext.slice(0, phoneLimit)
        : this.cachedMemoryContext;
      systemParts.push(``, `## Contexte`, ctx);
    }

    // Inject D&D context if a session is active
    if (this.dndContext) {
      if (this.opts.isPhoneCall) {
        // Phone: compact D&D context (~600-800 chars) to avoid 1008
        systemParts.push(``, `## PARTIE D&D EN COURS`, this.buildCompactDndContext());
      } else {
        // Dashboard voice: full context
        systemParts.push(``, `## PARTIE D&D EN COURS`, this.dndContext);
        systemParts.push(
          `Tu es aussi le Dungeon Master. Continue la narration en cours.`,
          `Utilise les outils dungeon_play, dungeon_roll, dungeon_status pour gérer la partie.`,
          `Garde le même ton, les mêmes personnages, et l'intrigue en cours.`,
        );
      }
    }

    // Inject conversation summary (compressed by Gemini Flash before reconnect)
    if (this.conversationSummary) {
      const summary = this.opts.isPhoneCall
        ? this.conversationSummary.slice(0, 400)
        : this.conversationSummary;
      systemParts.push(``, `## Résumé de la conversation précédente`, summary);
    }

    // Inject recent conversation log for continuity across reconnects
    if (this.conversationLog.length > 0) {
      const maxEntries = this.opts.isPhoneCall ? 8 : 40;
      const recent = this.conversationLog.slice(-maxEntries).join("\n");
      systemParts.push(``, `## Conversation vocale en cours (${this.conversationLog.length} échanges total)`, recent);
    }

    const systemText = systemParts.join("\n");
    log.info(
      `[gemini-live] System prompt: ${systemText.length} chars, ` +
        `voice=${voiceName}, tools=${this.toolDecls.length}`,
    );

    return {
      setup: {
        model: `models/${MODEL}`,
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName },
            },
          },
        },
        systemInstruction: {
          parts: [{ text: systemText }],
        },
        tools: [
          { functionDeclarations: this.toolDecls },
        ],
      },
    };
  }

  private async handleMessage(msg: any): Promise<void> {
    // Setup complete
    if (msg.setupComplete) {
      log.info("[gemini-live] Session ready");
      this.connected = true;
      this.opts.callbacks.onReady();
      return;
    }

    // Server content (audio, text, interruption, turn complete)
    if (msg.serverContent) {
      const sc = msg.serverContent;

      // User speech transcript (Gemini sends back what it heard)
      if (sc.inputTranscript) {
        const userText = sc.inputTranscript.trim();
        if (userText) {
          this.currentUserText += (this.currentUserText ? " " : "") + userText;
          this.opts.callbacks.onText(userText, "user");
          this.logConversation(`[Nicolas] ${userText.slice(0, 200)}`);
        }
      }

      if (sc.modelTurn?.parts) {
        for (const part of sc.modelTurn.parts) {
          if (part.inlineData?.data) {
            this.opts.callbacks.onAudio(part.inlineData.data);
          }
          if (part.text) {
            this.opts.callbacks.onText(part.text, "model");
            this.currentModelText += part.text;
            this.logConversation(
              `[Kingston] ${part.text.slice(0, 200)}`,
            );
          }
        }
      }

      if (sc.interrupted) {
        this.opts.callbacks.onInterrupted();
      }

      if (sc.turnComplete) {
        this.opts.callbacks.onTurnComplete();
        // Save turn + extract memories
        this.saveTurnAndExtract();
        // Persist conversation to disk every 5 turns (cheap, prevents data loss)
        if (this.conversationLog.length % 5 === 0) {
          this.persistConversation();
        }
      }

      return;
    }

    // Tool calls — execute in parallel for speed
    if (msg.toolCall?.functionCalls) {
      const calls = msg.toolCall.functionCalls;
      // Fire all tool calls concurrently (don't wait sequentially)
      await Promise.all(
        calls.map((fc: { id: string; name: string; args?: Record<string, unknown> }) =>
          this.executeToolCall(fc.id, fc.name, fc.args || {}),
        ),
      );
      return;
    }

    // Tool call cancellation
    if (msg.toolCallCancellation) {
      log.info(
        `[gemini-live] Tool calls cancelled: ${msg.toolCallCancellation.ids?.join(", ")}`,
      );
      return;
    }
  }

  private async executeToolCall(
    id: string,
    geminiName: string,
    args: Record<string, unknown>,
  ): Promise<void> {
    const { userId, isAdmin, callbacks } = this.opts;

    // Map Gemini tool name (underscores) → Kingston skill name (dots)
    // Priority: exact map lookup → underscore replacement → fuzzy via getSkill
    const mappedName = this.toolNameMap.get(geminiName);
    const skillName = mappedName || geminiName.replace(/_/g, ".");
    if (!mappedName) {
      log.warn(
        `[gemini-live] Tool "${geminiName}" not in nameMap — using fallback: "${skillName}"`,
      );
    }

    log.info(
      `[gemini-live] Tool call: ${geminiName} → ${skillName}(${JSON.stringify(args).slice(0, 100)})`,
    );
    callbacks.onToolCall(skillName, args);
    this.logConversation(
      `[Tool] ${skillName}(${JSON.stringify(args).slice(0, 80)})`,
    );

    // ── Special: change_voice ──
    if (skillName === "SPECIAL:change_voice") {
      const newVoice = String(args.voice || "Enceladus");
      log.info(`[gemini-live] Changing voice to: ${newVoice}`);
      this.opts.voiceName = newVoice;
      this.sendToolResponse(id, geminiName, {
        result: `Voice changed to ${newVoice}. Reconnecting...`,
      });
      callbacks.onToolResult("change_voice", `Voice → ${newVoice}`);
      setTimeout(() => this.reconnect(), 500);
      return;
    }

    // ── Special: telegram_history ──
    if (skillName === "SPECIAL:telegram_history") {
      const limit = Math.min(Number(args.limit) || 20, 50);
      try {
        // Use first allowed user's Telegram chatId (DM chatId = userId)
        const telegramChatId =
          config.allowedUsers?.[0] || this.opts.userId;
        const turns = getTurns(telegramChatId);
        const recent = turns.slice(-limit);
        if (recent.length === 0) {
          this.sendToolResponse(id, geminiName, {
            result: "Aucun historique Telegram trouvé.",
          });
        } else {
          const formatted = recent
            .map(
              (t) =>
                `[${t.role === "user" ? "Nicolas" : "Kingston"}] ${(t.content || "").slice(0, 300)}`,
            )
            .join("\n");
          this.sendToolResponse(id, geminiName, { result: formatted });
        }
        callbacks.onToolResult("telegram_history", `${recent.length} messages`);
      } catch (err) {
        const errMsg = (err as Error).message;
        this.sendToolResponse(id, geminiName, { error: errMsg });
        callbacks.onToolResult("telegram_history", `Error: ${errMsg}`);
      }
      return;
    }

    // ── Standard Kingston skill execution (non-blocking for slow tools) ──
    try {
      // Permission check
      if (!isToolPermitted(skillName, userId)) {
        const err = `Permission denied: ${skillName}`;
        this.sendToolResponse(id, geminiName, { error: err });
        callbacks.onToolResult(skillName, err);
        return;
      }

      // Resolve skill (getSkill now includes Levenshtein fuzzy matching)
      const skill = getSkill(skillName);
      if (!skill) {
        log.warn(`[gemini-live] Unknown tool after fuzzy matching: "${geminiName}" → "${skillName}"`);
        const err = `Unknown tool: ${skillName}. Check the tool name spelling.`;
        this.sendToolResponse(id, geminiName, { error: err });
        callbacks.onToolResult(skillName, err);
        return;
      }

      // Normalize args (inject chatId, defaults, etc.)
      const normalized = normalizeArgs(
        skillName,
        args,
        this.opts.chatId,
        skill,
      );

      // Validate against skill schema
      const validationError = validateSkillArgs(
        normalized,
        skill.argsSchema,
      );
      if (validationError) {
        this.sendToolResponse(id, geminiName, { error: validationError });
        callbacks.onToolResult(skillName, validationError);
        return;
      }

      // Tool execution: wait for the result with a generous timeout.
      // Phone calls use a longer timeout (8s) because injecting deferred results
      // via clientContent can confuse Gemini Live and cause session restarts.
      // Dashboard voice uses the original fast path (500ms) since it's more tolerant.
      const TOOL_TIMEOUT_MS = this.opts.isPhoneCall ? 8000 : 500;
      const execPromise = skill.execute(normalized);

      const race = await Promise.race([
        execPromise.then((r) => ({ done: true as const, result: r })),
        new Promise<{ done: false }>((resolve) =>
          setTimeout(() => resolve({ done: false }), TOOL_TIMEOUT_MS),
        ),
      ]);

      if (race.done) {
        // Got result in time — send via proper toolResponse
        const maxLen = this.opts.isPhoneCall ? 2000 : 4000;
        const truncated =
          typeof race.result === "string"
            ? race.result.slice(0, maxLen)
            : JSON.stringify(race.result).slice(0, maxLen);
        this.sendToolResponse(id, geminiName, { result: truncated });
        callbacks.onToolResult(skillName, truncated);
        this.logConversation(`[Result] ${truncated.slice(0, 100)}`);
        this.handleImageResult(skillName, truncated, normalized);
        log.info(`[gemini-live] Tool result (fast): ${skillName} → ${truncated.slice(0, 80)}...`);
      } else {
        // Tool is too slow — send a brief ack so Gemini doesn't hang
        log.info(`[gemini-live] Tool slow (>${TOOL_TIMEOUT_MS}ms), sending ack: ${skillName}`);
        this.sendToolResponse(id, geminiName, {
          result: `L'outil ${skillName} prend plus de temps que prévu. Le résultat sera disponible sous peu.`,
        });

        // For phone calls: DON'T inject deferred result via clientContent
        // (causes session instability / conversation restarts).
        // Just log it for the conversation history.
        // For dashboard voice: inject as before (more tolerant).
        execPromise
          .then((result) => {
            const truncated =
              typeof result === "string"
                ? result.slice(0, 2000)
                : JSON.stringify(result).slice(0, 2000);
            callbacks.onToolResult(skillName, truncated);
            this.logConversation(`[Result] ${truncated.slice(0, 100)}`);
            this.handleImageResult(skillName, truncated, normalized);

            if (!this.opts.isPhoneCall && this.connected && this.ws) {
              // Dashboard voice: inject as context (safe)
              this.ws.send(JSON.stringify({
                clientContent: {
                  turns: [{ role: "user", parts: [{ text: `[RÉSULTAT ${skillName}]: ${truncated}` }] }],
                  turnComplete: true,
                },
              }));
            }
            log.info(`[gemini-live] Tool result (deferred): ${skillName} → ${truncated.slice(0, 80)}...`);
          })
          .catch((err) => {
            const errMsg = err instanceof Error ? err.message : String(err);
            callbacks.onToolResult(skillName, `Error: ${errMsg}`);
            log.error(`[gemini-live] Tool error (deferred): ${skillName} → ${errMsg}`);
          });
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.sendToolResponse(id, geminiName, { error: errMsg });
      callbacks.onToolResult(skillName, `Error: ${errMsg}`);
    }
  }

  /** Handle image results — forward to dashboard + Telegram */
  private handleImageResult(
    skillName: string,
    truncated: string,
    normalized: Record<string, unknown>,
  ): void {
    if (!skillName.startsWith("image.") && skillName !== "pollinations.image") return;
    const imageUrlMatch = truncated.match(/!\[.*?\]\((.*?)\)/);
    const uploadMatch = truncated.match(/\/uploads\/[^\s)]+/);
    const imageUrl = imageUrlMatch?.[1] || (uploadMatch ? `http://localhost:3200${uploadMatch[0]}` : null);
    if (imageUrl) {
      const caption = String(normalized.prompt || normalized.concept || "Generated image");
      this.opts.callbacks.onImageGenerated?.(imageUrl, caption);
      try {
        const telegramSkill = getSkill("telegram.send");
        const adminChatId = config.allowedUsers?.[0] || this.opts.userId;
        if (telegramSkill && adminChatId) {
          telegramSkill.execute({
            chatId: String(adminChatId),
            text: `🖼️ Image générée (voice): ${caption}\n${imageUrl}`,
          }).catch(() => {});
        }
      } catch (e) { log.warn(`[gemini-live] Telegram image forward failed: ${e}`); }
    }
  }

  private sendToolResponse(
    id: string,
    name: string,
    response: Record<string, unknown>,
  ): void {
    if (!this.ws || !this.connected) return;
    this.ws.send(
      JSON.stringify({
        toolResponse: {
          functionResponses: [{ id, name, response }],
        },
      }),
    );
  }

  // ── Conversation persistence ─────────────────────────────────

  /** Save conversation log to disk so it survives reconnects and even restarts. */
  private persistConversation(): void {
    try {
      const data = {
        timestamp: new Date().toISOString(),
        chatId: this.opts.chatId,
        summary: this.conversationSummary,
        logCount: this.conversationLog.length,
        log: this.conversationLog,
      };
      fs.writeFileSync(VOICE_CONV_FILE, JSON.stringify(data, null, 2));
      log.debug(`[gemini-live] Persisted ${this.conversationLog.length} conversation entries to disk`);
    } catch (err) {
      log.warn(`[gemini-live] Failed to persist conversation: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Restore conversation from a previous session file (if recent — within 4h). */
  private restoreConversation(): void {
    try {
      if (!fs.existsSync(VOICE_CONV_FILE)) return;
      const raw = fs.readFileSync(VOICE_CONV_FILE, "utf-8");
      const data = JSON.parse(raw);

      // Only restore if the saved conversation is recent (< 4h old)
      const savedAt = new Date(data.timestamp).getTime();
      const age = Date.now() - savedAt;
      if (age > 4 * 60 * 60 * 1000) {
        log.debug(`[gemini-live] Saved conversation too old (${Math.round(age / 60000)}min), ignoring`);
        return;
      }

      if (Array.isArray(data.log) && data.log.length > 0) {
        this.conversationLog = data.log;
        this.conversationSummary = data.summary || "";
        log.info(`[gemini-live] Restored ${data.log.length} conversation entries from disk (${Math.round(age / 1000)}s old)`);
      }
    } catch (e) {
      log.warn(`[gemini-live] Failed to load conversation file: ${e}`);
    }
  }

  /**
   * Generate a compressed summary of the conversation so far using Gemini Flash.
   * Called before reconnect to ensure continuity.
   */
  private async generateConversationSummary(): Promise<void> {
    if (this.conversationLog.length < 4) return; // Too short to summarize

    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${config.geminiApiKey}`;
      const conversationText = this.conversationLog
        .filter(l => !l.startsWith("[Result]")) // Skip verbose tool results
        .slice(-60) // Last 60 entries
        .join("\n");

      const prompt = `Résume cette conversation vocale entre Nicolas et Kingston en 5-10 phrases concises.
Garde: les sujets discutés, les décisions prises, les informations importantes, l'état d'une partie de D&D si en cours.
Si c'est une partie de D&D: garde les noms des personnages, leur situation, le lieu, l'intrigue en cours, et les dernières actions.
Sois factuel et concis.

CONVERSATION:
${conversationText}`;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);

      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 500 },
        }),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (resp.ok) {
        const data = await resp.json() as any;
        const summary = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
        if (summary.length > 20) {
          this.conversationSummary = summary;
          log.info(`[gemini-live] Generated conversation summary: ${summary.length} chars`);
        }
      }
    } catch (err) {
      log.debug(`[gemini-live] Summary generation failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // ── D&D context ──────────────────────────────────────────────

  /** Check if there's an active D&D session and build context for the voice prompt. */
  private refreshDndContext(): void {
    try {
      const sessions = dungeonListSessions();
      const active = sessions.find((s: any) => s.status === "active");
      if (!active) {
        this.dndContext = "";
        return;
      }

      const session = dungeonGetSession(active.id);
      if (!session) {
        this.dndContext = "";
        return;
      }

      const characters = dungeonGetCharacters(active.id);
      const recentTurns = dungeonGetTurns(active.id, 15);

      // Build character descriptions
      const charLines = characters.map((c: any) => {
        const inv = Array.isArray(c.inventory) ? c.inventory.join(", ") : "rien";
        const tag = c.is_npc ? " (PNJ)" : "";
        return `- ${c.name}${tag}: ${c.race} ${c.class} Niv.${c.level}, HP:${c.hp}/${c.hp_max}, Inventaire:[${inv}]`;
      });

      // Build recent narrative
      const turnLines = recentTurns.reverse().map((t: any) => {
        let line = `Tour ${t.turn_number} (${t.event_type}):`;
        if (t.player_action) line += ` [Action] ${t.player_action}`;
        if (t.dm_narrative) line += `\n  [DM] ${t.dm_narrative.slice(0, 300)}`;
        return line;
      });

      this.dndContext = [
        `Campagne: "${session.name}" — ${session.setting || "Fantasy"}`,
        `Lieu actuel: ${session.current_location}`,
        `Tour: ${session.turn_number}`,
        `Session ID: ${active.id}`,
        ``,
        `Personnages:`,
        ...charLines,
        ``,
        `Derniers événements:`,
        ...turnLines,
      ].join("\n");

      // Also persist D&D state to file for cross-session recall
      this.persistDndState(session, characters, recentTurns);

      log.info(`[gemini-live] D&D context loaded: "${session.name}" (${characters.length} chars, ${recentTurns.length} turns)`);
    } catch (err) {
      log.debug(`[gemini-live] D&D context check failed: ${err instanceof Error ? err.message : err}`);
      this.dndContext = "";
    }
  }

  /** Build a compact D&D context for phone calls (~600-800 chars instead of full context). */
  private buildCompactDndContext(): string {
    try {
      const sessions = dungeonListSessions();
      const active = sessions.find((s: any) => s.status === "active");
      if (!active) return "";

      const session = dungeonGetSession(active.id);
      if (!session) return "";

      const characters = dungeonGetCharacters(active.id);
      const recentTurns = dungeonGetTurns(active.id, 3);

      // Compact character summaries (name + class + HP only)
      const chars = characters
        .map((c: any) => `${c.name}${c.is_npc ? "(PNJ)" : ""}: ${c.class} HP:${c.hp}/${c.hp_max}`)
        .join(", ");

      // Last 3 turns — truncated narratives
      const turns = recentTurns.reverse()
        .map((t: any) => {
          const action = t.player_action ? `[Action] ${t.player_action.slice(0, 80)}` : "";
          const dm = t.dm_narrative ? `[DM] ${t.dm_narrative.slice(0, 120)}` : "";
          return `T${t.turn_number}: ${action} ${dm}`.trim();
        })
        .join("\n");

      return [
        `"${session.name}" — ${session.current_location} (Tour ${session.turn_number})`,
        `Persos: ${chars}`,
        turns,
      ].join("\n");
    } catch (err) {
      log.debug(`[gemini-live] Compact D&D context failed: ${err instanceof Error ? err.message : err}`);
      return this.dndContext.slice(0, 700); // Fallback: truncate full context
    }
  }

  /** Save D&D state to a persistent markdown file for cross-session memory. */
  private persistDndState(session: any, characters: any[], turns: any[]): void {
    try {
      const charSection = characters.map((c: any) => {
        const inv = Array.isArray(c.inventory) ? c.inventory.join(", ") : "rien";
        const tag = c.is_npc ? " (PNJ)" : "";
        return `### ${c.name}${tag}\n- Race: ${c.race}, Classe: ${c.class}, Niveau: ${c.level}\n- HP: ${c.hp}/${c.hp_max}\n- Inventaire: ${inv}\n- Status: ${c.status || "alive"}`;
      }).join("\n\n");

      const turnSection = turns.reverse().slice(-20).map((t: any) => {
        let entry = `**Tour ${t.turn_number}** (${t.event_type})`;
        if (t.player_action) entry += `\n> ${t.player_action}`;
        if (t.dm_narrative) entry += `\n${t.dm_narrative.slice(0, 500)}`;
        return entry;
      }).join("\n\n---\n\n");

      const md = `# D&D Voice Session — ${session.name}
*Dernière MAJ: ${new Date().toISOString().slice(0, 16)}*
*Setting: ${session.setting || "Fantasy"}*
*Lieu: ${session.current_location}*
*Tour: ${session.turn_number}*
*Session ID: ${session.id}*

## Personnages

${charSection}

## Chronique récente

${turnSection}
`;
      fs.writeFileSync(VOICE_DND_FILE, md);
    } catch (e) { log.debug(`[gemini-live] Cleanup: ${e}`); }
  }
}
