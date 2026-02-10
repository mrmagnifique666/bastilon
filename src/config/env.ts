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
    maxToolChain: Number(optional("MAX_TOOL_CHAIN", "5")),
    shellTimeout: Number(optional("SHELL_TIMEOUT_MS", "30000")),
    codeTimeout: Number(optional("CODE_TIMEOUT_MS", "30000")),
    cliTimeoutMs: Number(optional("CLI_TIMEOUT_MS", "300000")),
    claudeModel: optional("CLAUDE_MODEL", "claude-sonnet-4-5-20250929"),
    claudeModelHaiku: optional("CLAUDE_MODEL_HAIKU", "claude-haiku-4-5-20251001"),
    claudeModelSonnet: optional("CLAUDE_MODEL_SONNET", "claude-sonnet-4-5-20250929"),
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

    // Gmail
    gmailCredentialsPath: optional("GMAIL_CREDENTIALS_PATH", "./relay/gmail/credentials.json"),
    gmailTokenPath: optional("GMAIL_TOKEN_PATH", "./relay/gmail/token.json"),

    // Brave Search
    braveSearchApiKey: optional("BRAVE_SEARCH_API_KEY", ""),

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
  };
}

export const config: ReturnType<typeof buildConfig> = buildConfig();

export function reloadEnv(): void {
  dotenv.config({ override: true });
  try {
    Object.assign(config, buildConfig());
    log.info("[config] Environment reloaded");
  } catch (err) {
    log.warn(`[config] Reload failed (missing required var?): ${err instanceof Error ? err.message : String(err)}`);
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
