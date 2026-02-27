/**
 * Environment configuration loader.
 * All secrets come from .env — never hardcoded.
 * Supports hot-reload via reloadEnv() and watchEnv().
 */
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { log } from "../utils/log.js";

// Initial load
dotenv.config();

function required(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}

function optional(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

function csvList(key: string, fallback: string = ""): string[] {
  const raw = process.env[key] || fallback;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function buildConfig() {
  const relayDir = optional("RELAY_DIR", "./relay");
  return {
    telegramToken: optional("TELEGRAM_BOT_TOKEN", ""),
    telegramEnabled: optional("TELEGRAM_ENABLED", "true") === "true",
    allowedUsers: csvList("TELEGRAM_ALLOWED_USERS").map(Number),
    adminChatId: Number(optional("TELEGRAM_ADMIN_CHAT_ID", "0")),
    sandboxDir: optional("SANDBOX_DIR", "./sandbox"),
    claudeBin: optional("CLAUDE_BIN", "claude"),
    allowedTools: csvList(
      "CLAUDE_ALLOWED_TOOLS",
      "help,notes.*,files.*,web.fetch,system.*,shell.exec,code.*,api.*,db.*,telegram.*,scheduler.*"
    ),
    memoryTurns: Number(optional("MEMORY_TURNS", "12")),
    rateLimitMs: Number(optional("RATE_LIMIT_MS", "2000")),
    maxToolChain: Number(optional("MAX_TOOL_CHAIN", "20")),
    shellTimeout: Number(optional("SHELL_TIMEOUT_MS", "30000")),
    codeTimeout: Number(optional("CODE_TIMEOUT_MS", "30000")),
    cliTimeoutMs: Number(optional("CLI_TIMEOUT_MS", "300000")),
    claudeModel: optional("CLAUDE_MODEL", "claude-sonnet-4-6"),
    claudeModelHaiku: optional("CLAUDE_MODEL_HAIKU", "claude-haiku-4-5-20251001"),
    claudeModelSonnet: optional("CLAUDE_MODEL_SONNET", "claude-sonnet-4-6"),
    claudeModelOpus: optional("CLAUDE_MODEL_OPUS", "claude-opus-4-6"),
    logLevel: optional("LOG_LEVEL", "info") as "debug" | "info" | "warn" | "error",
    relayDir,
    uploadsDir: path.join(relayDir, "uploads"),
    adminPassphrase: process.env["ADMIN_PASSPHRASE"] || "",
    elevenlabsApiKey: optional("ELEVENLABS_API_KEY", ""),
    elevenlabsVoiceId: optional("ELEVENLABS_VOICE_ID", "onwK4e9ZLuTAKqWW03F9"),

    // Voice (Twilio phone calls)
    voiceEnabled: optional("VOICE_ENABLED", "false") === "true",
    voicePort: Number(optional("VOICE_PORT", "3100")),
    voicePublicUrl: optional("VOICE_PUBLIC_URL", ""),
    twilioAccountSid: optional("TWILIO_ACCOUNT_SID", ""),
    twilioAuthToken: optional("TWILIO_AUTH_TOKEN", ""),
    deepgramApiKey: optional("DEEPGRAM_API_KEY", ""),
    voiceChatId: Number(optional("VOICE_CHAT_ID", "0")),
    voiceUserId: Number(optional("VOICE_USER_ID", "0")),
    voiceLanguage: optional("VOICE_LANGUAGE", "fr"),
    voiceGreeting: optional("VOICE_GREETING", "Bonjour, ici Kingston."),

    // Outbound calls
    twilioPhoneNumber: optional("TWILIO_PHONE_NUMBER", ""),
    nicolasPhoneNumber: optional("NICOLAS_PHONE_NUMBER", ""),

    // Gemini (image generation + orchestrator)
    geminiApiKey: optional("GEMINI_API_KEY", ""),
    geminiOrchestratorEnabled: optional("GEMINI_ORCHESTRATOR_ENABLED", "true") === "true",
    geminiOrchestratorModel: optional("GEMINI_ORCHESTRATOR_MODEL", "gemini-2.0-flash"),
    geminiTimeoutMs: Number(optional("GEMINI_TIMEOUT_MS", "25000")),

    // Anthropic API (for vision / computer-use)
    anthropicApiKey: optional("ANTHROPIC_API_KEY", ""),

    // Browser (Puppeteer)
    browserMode: optional("BROWSER_MODE", "visible") as "headless" | "visible" | "connect",
    browserCdpUrl: optional("BROWSER_CDP_URL", ""),
    browserChromePath: optional("BROWSER_CHROME_PATH", ""),
    browserViewportWidth: Number(optional("BROWSER_VIEWPORT_WIDTH", "1280")),
    browserViewportHeight: Number(optional("BROWSER_VIEWPORT_HEIGHT", "720")),
    browserTimeoutMs: Number(optional("BROWSER_TIMEOUT_MS", "30000")),
    browserIdleMs: Number(optional("BROWSER_IDLE_MS", "300000")),

    // CAPTCHA Solving
    twoCaptchaApiKey: optional("TWO_CAPTCHA_API_KEY", ""),

    // Gmail
    gmailCredentialsPath: optional("GMAIL_CREDENTIALS_PATH", "./relay/gmail/credentials.json"),
    gmailTokenPath: optional("GMAIL_TOKEN_PATH", "./relay/gmail/token.json"),

    // Brave Search
    braveSearchApiKey: optional("BRAVE_SEARCH_API_KEY", ""),

    // Printful
    printfulApiToken: optional("PRINTFUL_API_TOKEN", ""),
    printfulStoreId: optional("PRINTFUL_STORE_ID", "17697469"),

    // Shopify
    shopifyStoreDomain: optional("SHOPIFY_STORE_DOMAIN", ""),
    shopifyAccessToken: optional("SHOPIFY_ACCESS_TOKEN", ""),

    // Dashboard
    dashboardToken: optional("DASHBOARD_TOKEN", ""),

    // Ollama (local LLM tier)
    ollamaEnabled: optional("OLLAMA_ENABLED", "false") === "true",
    ollamaModel: optional("OLLAMA_MODEL", "qwen2.5:14b"),
    ollamaUrl: optional("OLLAMA_URL", "http://localhost:11434"),
    ollamaTimeoutMs: Number(optional("OLLAMA_TIMEOUT_MS", "120000")),
    ollamaMaxTools: Number(optional("OLLAMA_MAX_TOOLS", "40")),
    ollamaNumPredict: Number(optional("OLLAMA_NUM_PREDICT", "2048")),

    // Heartbeat + Cron
    heartbeatActiveStart: Number(optional("HEARTBEAT_ACTIVE_START", "8")),
    heartbeatActiveEnd: Number(optional("HEARTBEAT_ACTIVE_END", "22")),
    cronChatIdBase: Number(optional("CRON_CHATID_BASE", "200")),
    cronMaxRetries: Number(optional("CRON_MAX_RETRIES", "3")),

    // Groq (free cloud LLM tier)
    groqApiKey: optional("GROQ_API_KEY", ""),
    groqModel: optional("GROQ_MODEL", "llama-3.3-70b-versatile"),
    groqTimeoutMs: Number(optional("GROQ_TIMEOUT_MS", "30000")),

    // OpenRouter (unified gateway — 100+ models, free tiers available)
    openrouterApiKey: optional("OPENROUTER_API_KEY", ""),
    openrouterModel: optional("OPENROUTER_MODEL", "deepseek/deepseek-r1-0528:free"),
    openrouterTimeoutMs: Number(optional("OPENROUTER_TIMEOUT_MS", "60000")),

    // Bridge (bot-to-bot communication in shared Telegram groups)
    bridgePartnerUrl: optional("BRIDGE_PARTNER_URL", ""),
    bridgePartnerName: optional("BRIDGE_PARTNER_NAME", "Anti-Claw"),

    // WebSocket Bridge (inter-agent communication — Kingston ↔ external CLI agents)
    bridgeWsToken: optional("BRIDGE_WS_TOKEN", ""),
    bridgeDebatePeer: optional("BRIDGE_DEBATE_PEER", "antigravity"),

    // Weather location for mood skill
    weatherLocation: optional("WEATHER_LOCATION", "Ottawa"),

    // Claude memory directory (auto-detected if not set)
    claudeMemoryDir: optional("CLAUDE_MEMORY_DIR", ""),

    // Tool profiles (OpenClaw-like): "default" | "coding" | "automation" | "full"
    toolProfile: optional("TOOL_PROFILE", "full") as "default" | "coding" | "automation" | "full",

    // OpenClaw enhancements
    reactionsEnabled: optional("REACTIONS_ENABLED", "true") === "true",
    debounceEnabled: optional("DEBOUNCE_ENABLED", "true") === "true",
    debounceMs: Number(optional("DEBOUNCE_MS", "1500")),
    streamingEnabled: optional("STREAMING_ENABLED", "true") === "true",
    draftEditIntervalMs: Number(optional("DRAFT_EDIT_INTERVAL_MS", "300")),
    draftStartThreshold: Number(optional("DRAFT_START_THRESHOLD", "10")),

    // Alpaca (paper trading)
    alpacaApiKey: optional("ALPACA_API_KEY", ""),
    alpacaSecretKey: optional("ALPACA_SECRET_KEY", ""),
    alpacaBaseUrl: optional("ALPACA_BASE_URL", "https://paper-api.alpaca.markets/v2"),

    // Facebook / Meta Graph API
    facebookAppId: optional("FACEBOOK_APP_ID", ""),
    facebookAppSecret: optional("FACEBOOK_APP_SECRET", ""),
    facebookPageAccessToken: optional("FACEBOOK_PAGE_ACCESS_TOKEN", ""),
    facebookPageId: optional("FACEBOOK_PAGE_ID", ""),
    instagramBusinessAccountId: optional("INSTAGRAM_BUSINESS_ACCOUNT_ID", ""),

    // Agent notification mute (agents run but don't send to Telegram)
    agentNotificationsMuted: optional("AGENT_NOTIFICATIONS_MUTED", "false") === "true",

    // Agents
    agentScoutEnabled: optional("AGENT_SCOUT_ENABLED", "false") === "true",
    agentScoutHeartbeatMs: Number(optional("AGENT_SCOUT_HEARTBEAT_MS", "1800000")),
    agentAnalystEnabled: optional("AGENT_ANALYST_ENABLED", "false") === "true",
    agentAnalystHeartbeatMs: Number(optional("AGENT_ANALYST_HEARTBEAT_MS", "3600000")),
    agentLearnerEnabled: optional("AGENT_LEARNER_ENABLED", "false") === "true",
    agentLearnerHeartbeatMs: Number(optional("AGENT_LEARNER_HEARTBEAT_MS", "7200000")),
    agentExecutorEnabled: optional("AGENT_EXECUTOR_ENABLED", "true") === "true",
    agentExecutorHeartbeatMs: Number(optional("AGENT_EXECUTOR_HEARTBEAT_MS", "300000")),
    agentTradingMonitorEnabled: optional("AGENT_TRADING_MONITOR_ENABLED", "true") === "true",
    agentTradingMonitorHeartbeatMs: Number(optional("AGENT_TRADING_MONITOR_HEARTBEAT_MS", "60000")),
    agentSentinelEnabled: optional("AGENT_SENTINEL_ENABLED", "true") === "true",
    agentSentinelHeartbeatMs: Number(optional("AGENT_SENTINEL_HEARTBEAT_MS", "1800000")),

    // Kingston Mind (autonomous business brain)
    agentMindEnabled: optional("AGENT_MIND_ENABLED", "true") === "true",
    agentMindHeartbeatMs: Number(optional("AGENT_MIND_HEARTBEAT_MS", "1200000")), // 20min

    // XTTS Voice Cloning
    xttsPort: Number(optional("XTTS_PORT", "3300")),
    xttsEnabled: optional("XTTS_ENABLED", "true") === "true",

    // Free API keys
    newsApiKey: optional("NEWS_API_KEY", ""),
    huggingfaceApiKey: optional("HUGGINGFACE_API_KEY", ""),
    serperApiKey: optional("SERPER_API_KEY", ""),
    abstractEmailApiKey: optional("ABSTRACT_EMAIL_API_KEY", ""),
    abstractPhoneApiKey: optional("ABSTRACT_PHONE_API_KEY", ""),
    cohereApiKey: optional("COHERE_API_KEY", ""),
    mistralApiKey: optional("MISTRAL_API_KEY", ""),
    togetherApiKey: optional("TOGETHER_API_KEY", ""),
    replicateApiKey: optional("REPLICATE_API_KEY", ""),

    // Noah Bridge (Kingston ↔ Noah persistent JSONL communication)
    voiceMode: optional("VOICE_MODE", "gemini_live") as "gemini_live" | "noah_bridge",
    noahBridgeEnabled: optional("NOAH_BRIDGE_ENABLED", "false") === "true",
    noahBridgeTimeoutMs: Number(optional("NOAH_BRIDGE_TIMEOUT_MS", "12000")),
    noahBridgeInbox: optional("NOAH_BRIDGE_INBOX", "data/kingston-to-noah.jsonl"),
    noahBridgeOutbox: optional("NOAH_BRIDGE_OUTBOX", "data/noah-to-kingston.jsonl"),

    // Memory management
    memoryMaxItems: Number(optional("MEMORY_MAX_ITEMS", "1500")),
    memoryPruneTarget: Number(optional("MEMORY_PRUNE_TARGET", "1000")),
    memoryDedupThreshold: Number(optional("MEMORY_DEDUP_THRESHOLD", "0.92")),
  };
}

export const config: ReturnType<typeof buildConfig> = buildConfig();

/** Validate critical env vars exist — logs warnings (doesn't crash) for optional but important ones */
export function validateEnv(): void {
  const critical = ["TELEGRAM_BOT_TOKEN"];
  const important = [
    { key: "TELEGRAM_ALLOWED_USERS", desc: "No allowed users — bot won't respond to anyone" },
    { key: "TELEGRAM_ADMIN_CHAT_ID", desc: "No admin chat ID — alerts won't be delivered" },
    { key: "CLAUDE_ALLOWED_TOOLS", desc: "No tool allowlist — Kingston has no skills" },
  ];
  for (const key of critical) {
    if (!process.env[key]) {
      throw new Error(`[config] CRITICAL: Missing required env var: ${key} — bot cannot start`);
    }
  }
  for (const { key, desc } of important) {
    if (!process.env[key]) {
      log.warn(`[config] WARNING: ${key} not set — ${desc}`);
    }
  }
}

export function reloadEnv(): string[] {
  const before: Record<string, string> = {};
  for (const key of Object.keys(config) as Array<keyof typeof config>) {
    before[key] = String(config[key]);
  }

  dotenv.config({ override: true });
  try {
    Object.assign(config, buildConfig());

    // Detect what changed
    const changed: string[] = [];
    for (const key of Object.keys(config) as Array<keyof typeof config>) {
      if (String(config[key]) !== before[key]) {
        changed.push(key);
      }
    }

    if (changed.length > 0) {
      log.info(`[config] Reloaded — changed: ${changed.join(", ")}`);
    } else {
      log.debug("[config] Reloaded — no changes");
    }

    return changed;
  } catch (err) {
    log.warn(`[config] Reload failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

export function watchEnv(): void {
  const envPath = path.resolve(".env");
  if (!fs.existsSync(envPath)) return;
  fs.watchFile(envPath, { interval: 2000 }, () => {
    log.info("[config] .env file changed — reloading");
    reloadEnv();
  });
  log.info("[config] Watching .env for changes");
}
