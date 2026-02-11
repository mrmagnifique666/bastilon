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
import { buildSemanticContext, extractAndStoreMemories } from "../memory/semantic.js";
import { getTurns, getDb, addTurn } from "../storage/store.js";

const MODEL = "gemini-2.5-flash-native-audio-latest";
const SESSION_TIMEOUT_MS = 14 * 60 * 1000;
const MAX_RECONNECT_ATTEMPTS = 3;
const MAX_LIVE_TOOLS = 80;

/** Blocked prefixes for voice mode — too heavy, slow, or crash-prone */
const BLOCKED_PREFIXES = ["browser.", "ollama.", "pdf."];

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
  const properties: Record<string, { type: string; description?: string }> = {};
  for (const [key, prop] of Object.entries(skill.argsSchema.properties)) {
    properties[key] = {
      type: toGeminiType(prop.type),
      ...(prop.description ? { description: prop.description } : {}),
    };
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
function buildLiveTools(): {
  decls: LiveToolDecl[];
  nameMap: Map<string, string>;
} {
  const allSkills = getAllSkills().filter(
    (s) => !BLOCKED_PREFIXES.some((p) => s.name.startsWith(p)),
  );

  // Sort: priority prefixes first, then rest
  const priority: Skill[] = [];
  const rest: Skill[] = [];
  for (const s of allSkills) {
    const isPriority =
      s.name === "help" ||
      PRIORITY_PREFIXES.some((p) => s.name.startsWith(p));
    if (isPriority) priority.push(s);
    else rest.push(s);
  }

  const specials = getSpecialTools();
  const cap = MAX_LIVE_TOOLS - specials.length;
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

  // Track current turn for memory extraction
  private currentUserText = "";
  private currentModelText = "";

  // Dynamic tools — built once at construction, rebuilt on reconnect
  private toolDecls: LiveToolDecl[] = [];
  private toolNameMap = new Map<string, string>();

  constructor(opts: LiveSessionOptions) {
    this.opts = opts;
    this.rebuildTools();
  }

  /** Rebuild tool declarations from the live registry. */
  private rebuildTools(): void {
    const { decls, nameMap } = buildLiveTools();
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

    const url =
      `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent` +
      `?key=${config.geminiApiKey}`;

    log.info(
      `[gemini-live] Connecting (chatId=${this.opts.chatId}, model=${MODEL}, attempt=${this.reconnectAttempts + 1})...`,
    );

    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      this.reconnectAttempts = 0;
      // Rebuild tools on each connection (picks up any newly registered skills)
      this.rebuildTools();
      const setup = this.buildSetup();
      const payload = JSON.stringify(setup);
      log.info(
        `[gemini-live] WebSocket open, sending setup (${payload.length} bytes, ${this.toolDecls.length} tools)...`,
      );
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
        this.handleMessage(JSON.parse(raw.toString()));
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
      log.info(
        `[gemini-live] WS closed (code=${code}${reasonStr ? ", reason=" + reasonStr : ""})`,
      );
      this.connected = false;
      this.clearTimer();
      if (!this.closed) this.opts.callbacks.onClose();
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

  /** Send a text message (for typed input). */
  sendText(text: string): void {
    if (!this.connected || !this.ws) return;
    this.currentUserText += (this.currentUserText ? " " : "") + text;
    this.conversationLog.push(`[Nicolas] ${text}`);
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

  /** Gracefully close the session, saving conversation summary. */
  close(): void {
    this.closed = true;
    this.clearTimer();
    this.saveConversationSummary();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
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

    // 1. Semantic memories — broad query, more results
    try {
      const mem = await buildSemanticContext(
        "Nicolas profil préférences projets activités récentes travail aujourd'hui Kingston Bastilon",
        15,
      );
      if (mem) parts.push(mem);
    } catch {}

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
    } catch {}

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
    } catch {}

    // 3. Recent episodic events (today)
    try {
      const db = getDb();
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const events = db
        .prepare(
          `SELECT description, event_type, importance FROM episodic_events
           WHERE timestamp > ? ORDER BY timestamp DESC LIMIT 10`,
        )
        .all(todayStart.toISOString()) as { description: string; event_type: string; importance: number }[];
      if (events.length > 0) {
        const lines = events.map(
          (e) => `- [${e.event_type}] ${e.description.slice(0, 150)}`,
        );
        parts.push(`\n[ÉVÉNEMENTS AUJOURD'HUI]\n${lines.join("\n")}`);
      }
    } catch {}

    // 4. Recent notes (last 5)
    try {
      const db = getDb();
      const notes = db
        .prepare(`SELECT text FROM notes ORDER BY created_at DESC LIMIT 5`)
        .all() as { text: string }[];
      if (notes.length > 0) {
        const lines = notes.map((n) => `- ${n.text.slice(0, 150)}`);
        parts.push(`\n[NOTES RÉCENTES]\n${lines.join("\n")}`);
      }
    } catch {}

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
    } catch {}
  }

  private reconnect(): void {
    this.clearTimer();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
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
    const delay = Math.min(1000 * this.reconnectAttempts, 5000);
    setTimeout(() => {
      if (!this.closed) void this.connect();
    }, delay);
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
      `Tu es Kingston, une IA autonome sur Bastilon OS.`,
      `Ton utilisateur est Nicolas, entrepreneur francophone au Canada (Gatineau, Québec).`,
      `Personnalité: direct, proactif, honnête, loyal à Nicolas. Tu tutoies Nicolas.`,
      ``,
      `## Mode vocal`,
      `Conversation vocale temps réel. Parle ${lang === "fr" ? "français" : "anglais"} naturellement.`,
      `Sois concis — pas de markdown, pas de listes. Tu PARLES, tu n'écris pas.`,
      `Si tu ne sais pas, utilise tes outils pour trouver l'information.`,
      `Ne fabrique jamais de données.`,
      ``,
      `## Capacités`,
      `Tu as ${this.toolDecls.length} outils disponibles. Tu peux AGIR, pas juste parler:`,
      `- Lire/écrire des fichiers, exécuter du code, gérer des notes`,
      `- Chercher dans ta mémoire (memory_search), consulter le web (web_search)`,
      `- Envoyer des messages Telegram, gérer les emails, le calendrier`,
      `- Consulter l'historique (telegram_history), les agents, le trading`,
      `- Gérer des cron jobs, des rappels, des plans`,
      `Quand Nicolas te demande quelque chose, FAIS-LE avec les outils. Ne dis pas "je ne peux pas".`,
      ``,
      `## Date et heure`,
      `${dateStr}, ${timeStr} (heure de l'Est / America/Toronto).`,
    ];

    // Inject session log (unified cross-channel knowledge — services, API keys, recent improvements)
    const sessionLog = loadSessionLog();
    if (sessionLog) {
      systemParts.push(``, `## Session Log`, sessionLog);
    }

    // Inject rich context (memories + telegram history + episodic + notes)
    if (this.cachedMemoryContext) {
      systemParts.push(``, `## Contexte`, this.cachedMemoryContext);
    }

    // Inject recent conversation log for continuity across reconnects
    if (this.conversationLog.length > 0) {
      const recent = this.conversationLog.slice(-10).join("\n");
      systemParts.push(``, `## Conversation vocale en cours`, recent);
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

  private handleMessage(msg: any): void {
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
          this.conversationLog.push(`[Nicolas] ${userText.slice(0, 200)}`);
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
            this.conversationLog.push(
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
      }

      return;
    }

    // Tool calls
    if (msg.toolCall?.functionCalls) {
      for (const fc of msg.toolCall.functionCalls) {
        this.executeToolCall(fc.id, fc.name, fc.args || {});
      }
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
    const skillName =
      this.toolNameMap.get(geminiName) || geminiName.replace(/_/g, ".");

    log.info(
      `[gemini-live] Tool call: ${geminiName} → ${skillName}(${JSON.stringify(args).slice(0, 100)})`,
    );
    callbacks.onToolCall(skillName, args);
    this.conversationLog.push(
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

    // ── Standard Kingston skill execution ──
    try {
      // Permission check
      if (!isToolPermitted(skillName, userId)) {
        const err = `Permission denied: ${skillName}`;
        this.sendToolResponse(id, geminiName, { error: err });
        callbacks.onToolResult(skillName, err);
        return;
      }

      // Resolve skill
      const skill = getSkill(skillName);
      if (!skill) {
        const err = `Unknown tool: ${skillName}`;
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

      // Execute
      const result = await skill.execute(normalized);
      const truncated =
        typeof result === "string"
          ? result.slice(0, 4000)
          : JSON.stringify(result).slice(0, 4000);

      this.sendToolResponse(id, geminiName, { result: truncated });
      callbacks.onToolResult(skillName, truncated);
      this.conversationLog.push(`[Result] ${truncated.slice(0, 100)}`);

      log.info(
        `[gemini-live] Tool result: ${skillName} → ${truncated.slice(0, 80)}...`,
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.sendToolResponse(id, geminiName, { error: errMsg });
      callbacks.onToolResult(skillName, `Error: ${errMsg}`);
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
}
