/**
 * Built-in skills: config.set, config.get, config.list, config.reset
 * Lets Nicolas control Kingston settings directly from Telegram.
 * Changes are applied IMMEDIATELY — no code request queue needed.
 */
import fs from "node:fs";
import path from "node:path";
import { registerSkill } from "../loader.js";
import { config, reloadEnv } from "../../config/env.js";
import { getAgent, listAgents, removeAgent, registerAgent, triggerAgent } from "../../agents/registry.js";
import { pauseCronJob, resumeCronJob, listCronJobs } from "../../scheduler/cron.js";
import { log } from "../../utils/log.js";

// ─── Mapping: friendly key → .env key ─────────────────────────────────────
// Nicolas can use either friendly names ("scout_enabled") or env names ("AGENT_SCOUT_ENABLED")

interface ConfigEntry {
  envKey: string;
  configKey: keyof typeof config;
  type: "bool" | "number" | "string";
  category: "agent" | "briefing" | "model" | "system" | "feature";
  description: string;
  /** If changing this key requires agent restart */
  restartAgent?: string;
}

const CONFIG_MAP: Record<string, ConfigEntry> = {
  // ─── Agents ───
  scout_enabled: { envKey: "AGENT_SCOUT_ENABLED", configKey: "agentScoutEnabled", type: "bool", category: "agent", description: "Agent Scout (prospection)", restartAgent: "scout" },
  scout_interval: { envKey: "AGENT_SCOUT_HEARTBEAT_MS", configKey: "agentScoutHeartbeatMs", type: "number", category: "agent", description: "Scout heartbeat (ms)", restartAgent: "scout" },
  analyst_enabled: { envKey: "AGENT_ANALYST_ENABLED", configKey: "agentAnalystEnabled", type: "bool", category: "agent", description: "Agent Analyst (rapports)", restartAgent: "analyst" },
  analyst_interval: { envKey: "AGENT_ANALYST_HEARTBEAT_MS", configKey: "agentAnalystHeartbeatMs", type: "number", category: "agent", description: "Analyst heartbeat (ms)", restartAgent: "analyst" },
  learner_enabled: { envKey: "AGENT_LEARNER_ENABLED", configKey: "agentLearnerEnabled", type: "bool", category: "agent", description: "Agent Learner (auto-amélioration)", restartAgent: "learner" },
  learner_interval: { envKey: "AGENT_LEARNER_HEARTBEAT_MS", configKey: "agentLearnerHeartbeatMs", type: "number", category: "agent", description: "Learner heartbeat (ms)", restartAgent: "learner" },
  executor_enabled: { envKey: "AGENT_EXECUTOR_ENABLED", configKey: "agentExecutorEnabled", type: "bool", category: "agent", description: "Agent Executor (code bridge)", restartAgent: "executor" },
  trading_monitor_enabled: { envKey: "AGENT_TRADING_MONITOR_ENABLED", configKey: "agentTradingMonitorEnabled", type: "bool", category: "agent", description: "Agent Trading Monitor", restartAgent: "trading-monitor" },
  sentinel_enabled: { envKey: "AGENT_SENTINEL_ENABLED", configKey: "agentSentinelEnabled", type: "bool", category: "agent", description: "Agent Sentinel (sécurité)", restartAgent: "sentinel" },
  mind_enabled: { envKey: "AGENT_MIND_ENABLED", configKey: "agentMindEnabled", type: "bool", category: "agent", description: "Kingston Mind (cerveau autonome)", restartAgent: "mind" },
  mind_interval: { envKey: "AGENT_MIND_HEARTBEAT_MS", configKey: "agentMindHeartbeatMs", type: "number", category: "agent", description: "Mind heartbeat (ms)", restartAgent: "mind" },
  agent_notifications: { envKey: "AGENT_NOTIFICATIONS_MUTED", configKey: "agentNotificationsMuted", type: "bool", category: "agent", description: "Muter les notifications agents" },

  // ─── Models ───
  ollama_enabled: { envKey: "OLLAMA_ENABLED", configKey: "ollamaEnabled", type: "bool", category: "model", description: "Ollama local LLM" },
  ollama_model: { envKey: "OLLAMA_MODEL", configKey: "ollamaModel", type: "string", category: "model", description: "Modèle Ollama" },
  gemini_enabled: { envKey: "GEMINI_ORCHESTRATOR_ENABLED", configKey: "geminiOrchestratorEnabled", type: "bool", category: "model", description: "Gemini orchestrateur" },
  streaming: { envKey: "STREAMING_ENABLED", configKey: "streamingEnabled", type: "bool", category: "model", description: "Streaming des réponses" },

  // ─── System ───
  log_level: { envKey: "LOG_LEVEL", configKey: "logLevel", type: "string", category: "system", description: "Niveau de log (debug/info/warn/error)" },
  memory_turns: { envKey: "MEMORY_TURNS", configKey: "memoryTurns", type: "number", category: "system", description: "Tours de contexte" },
  max_tool_chain: { envKey: "MAX_TOOL_CHAIN", configKey: "maxToolChain", type: "number", category: "system", description: "Max outils par requête" },
  rate_limit: { envKey: "RATE_LIMIT_MS", configKey: "rateLimitMs", type: "number", category: "system", description: "Rate limit (ms)" },
  tool_profile: { envKey: "TOOL_PROFILE", configKey: "toolProfile", type: "string", category: "system", description: "Profil outils (default/coding/automation/full)" },

  // ─── Briefings ───
  active_start: { envKey: "HEARTBEAT_ACTIVE_START", configKey: "heartbeatActiveStart", type: "number", category: "briefing", description: "Heure début activité" },
  active_end: { envKey: "HEARTBEAT_ACTIVE_END", configKey: "heartbeatActiveEnd", type: "number", category: "briefing", description: "Heure fin activité" },

  // ─── Features ───
  voice_enabled: { envKey: "VOICE_ENABLED", configKey: "voiceEnabled", type: "bool", category: "feature", description: "Voice / appels téléphoniques" },
  reactions: { envKey: "REACTIONS_ENABLED", configKey: "reactionsEnabled", type: "bool", category: "feature", description: "Réactions emoji Telegram" },
  debounce: { envKey: "DEBOUNCE_ENABLED", configKey: "debounceEnabled", type: "bool", category: "feature", description: "Debounce des messages" },
};

// Build reverse lookup: env key → friendly key
const ENV_TO_FRIENDLY = new Map<string, string>();
for (const [friendly, entry] of Object.entries(CONFIG_MAP)) {
  ENV_TO_FRIENDLY.set(entry.envKey.toLowerCase(), friendly);
  ENV_TO_FRIENDLY.set(entry.configKey.toLowerCase(), friendly);
}

/** Resolve a user-provided key to our config entry */
function resolveKey(userKey: string): { friendly: string; entry: ConfigEntry } | null {
  const lower = userKey.toLowerCase().replace(/[-\s]/g, "_");
  // Direct match
  if (CONFIG_MAP[lower]) return { friendly: lower, entry: CONFIG_MAP[lower] };
  // Env key match
  const fromEnv = ENV_TO_FRIENDLY.get(lower);
  if (fromEnv) return { friendly: fromEnv, entry: CONFIG_MAP[fromEnv] };
  return null;
}

/** Write a key=value to .env file (update existing or append) */
function writeEnvFile(envKey: string, value: string): void {
  const envPath = path.resolve(".env");
  let content = fs.readFileSync(envPath, "utf-8");
  const regex = new RegExp(`^${envKey}=.*$`, "m");
  if (regex.test(content)) {
    content = content.replace(regex, `${envKey}=${value}`);
  } else {
    content += `\n${envKey}=${value}`;
  }
  fs.writeFileSync(envPath, content, "utf-8");
}

// ─── config.set ────────────────────────────────────────────────────────────

registerSkill({
  name: "config.set",
  description:
    "Change a Kingston setting immediately from Telegram. Examples: config.set(key='scout_enabled', value='false') to disable Scout agent. config.set(key='log_level', value='debug'). Use config.list to see all available keys.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      key: { type: "string", description: "Setting name (e.g. 'scout_enabled', 'log_level', 'mind_interval')" },
      value: { type: "string", description: "New value ('true'/'false' for bools, number for intervals)" },
    },
    required: ["key", "value"],
  },
  async execute(args): Promise<string> {
    const userKey = String(args.key).trim();
    const userValue = String(args.value).trim();

    const resolved = resolveKey(userKey);
    if (!resolved) {
      const suggestions = Object.keys(CONFIG_MAP)
        .filter(k => k.includes(userKey.toLowerCase().replace(/[-\s]/g, "_")))
        .slice(0, 5);
      return `Clé "${userKey}" inconnue.${suggestions.length ? ` Suggestions: ${suggestions.join(", ")}` : ""}\nUtilise config.list pour voir toutes les clés.`;
    }

    const { friendly, entry } = resolved;

    // Validate type
    let envValue = userValue;
    if (entry.type === "bool") {
      const boolMap: Record<string, string> = {
        true: "true", false: "false", oui: "true", non: "false",
        on: "true", off: "false", "1": "true", "0": "false",
        yes: "true", no: "false", activer: "true", desactiver: "false",
      };
      const mapped = boolMap[userValue.toLowerCase()];
      if (!mapped) return `Valeur invalide pour "${friendly}" (bool). Utilise: true/false/oui/non/on/off`;
      envValue = mapped;
    } else if (entry.type === "number") {
      const num = Number(userValue);
      if (isNaN(num)) return `Valeur invalide pour "${friendly}" (nombre). Ex: 300000`;
      envValue = String(num);
    }

    // Get old value for confirmation
    const oldValue = String(config[entry.configKey]);

    // 1. Write to .env file
    try {
      writeEnvFile(entry.envKey, envValue);
    } catch (err) {
      return `Erreur écriture .env: ${err instanceof Error ? err.message : String(err)}`;
    }

    // 2. Hot-reload config
    const changed = reloadEnv();

    // 3. Handle agent restart if needed
    let agentAction = "";
    if (entry.restartAgent) {
      const agent = getAgent(entry.restartAgent);
      if (agent) {
        if (entry.type === "bool" && envValue === "false") {
          agent.stop();
          agentAction = `\n🔴 Agent "${entry.restartAgent}" arrêté`;
        } else if (entry.type === "bool" && envValue === "true") {
          agent.start();
          agentAction = `\n🟢 Agent "${entry.restartAgent}" démarré`;
        } else {
          // Interval or other change — just log, will take effect on next cycle
          agentAction = `\n🔄 Prise en compte au prochain cycle de "${entry.restartAgent}"`;
        }
      }
    }

    const newValue = String(config[entry.configKey]);
    log.info(`[config.set] ${friendly} (${entry.envKey}): ${oldValue} → ${newValue}`);

    return (
      `✅ ${entry.description}\n` +
      `  ${friendly}: ${oldValue} → ${newValue}\n` +
      `  .env: ${entry.envKey}=${envValue}\n` +
      `  Config reloaded: ${changed.length > 0 ? changed.join(", ") : "ok"}` +
      agentAction
    );
  },
});

// ─── config.get ────────────────────────────────────────────────────────────

registerSkill({
  name: "config.get",
  description: "Read the current value of a Kingston setting. Example: config.get(key='scout_enabled')",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      key: { type: "string", description: "Setting name" },
    },
    required: ["key"],
  },
  async execute(args): Promise<string> {
    const userKey = String(args.key).trim();
    const resolved = resolveKey(userKey);
    if (!resolved) {
      return `Clé "${userKey}" inconnue. Utilise config.list pour voir toutes les clés.`;
    }
    const { friendly, entry } = resolved;
    const value = config[entry.configKey];
    return `${entry.description}\n  ${friendly} = ${String(value)}\n  .env: ${entry.envKey}`;
  },
});

// ─── config.list ───────────────────────────────────────────────────────────

registerSkill({
  name: "config.list",
  description: "List all configurable settings. Optional filter by category: agent, briefing, model, system, feature.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      category: { type: "string", description: "Filter: agent, briefing, model, system, feature (or 'all')" },
    },
  },
  async execute(args): Promise<string> {
    const filter = args.category ? String(args.category).toLowerCase() : "all";

    const lines: string[] = ["⚙️ Configuration Kingston\n"];
    const categories = filter === "all"
      ? ["agent", "model", "briefing", "system", "feature"]
      : [filter];

    for (const cat of categories) {
      const entries = Object.entries(CONFIG_MAP).filter(([, e]) => e.category === cat);
      if (entries.length === 0) continue;

      const catLabels: Record<string, string> = {
        agent: "🤖 Agents",
        model: "🧠 Modèles",
        briefing: "📋 Briefings",
        system: "⚙️ Système",
        feature: "✨ Fonctionnalités",
      };
      lines.push(`${catLabels[cat] || cat}:`);

      for (const [friendly, entry] of entries) {
        const value = config[entry.configKey];
        const displayValue = entry.type === "bool"
          ? (value ? "✅" : "❌")
          : String(value);
        lines.push(`  ${friendly} = ${displayValue}`);
      }
      lines.push("");
    }

    // Also show active agents status
    if (filter === "all" || filter === "agent") {
      const agents = listAgents();
      lines.push("📊 Agents actifs:");
      for (const a of agents) {
        const status = a.enabled ? (a.running ? "🟢" : "⏸️") : "🔴";
        lines.push(`  ${status} ${a.id} — cycles: ${a.totalCycles}, erreurs: ${a.errors}`);
      }
    }

    return lines.join("\n");
  },
});

// ─── config.agents ─────────────────────────────────────────────────────────

registerSkill({
  name: "config.agents",
  description: "Quick agent management: enable/disable/trigger/status. Examples: config.agents(action='disable', agent='scout'), config.agents(action='trigger', agent='mind'), config.agents(action='status')",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      action: { type: "string", description: "'enable' | 'disable' | 'trigger' | 'status'" },
      agent: { type: "string", description: "Agent ID (scout, analyst, learner, executor, trading-monitor, sentinel, mind)" },
    },
    required: ["action"],
  },
  async execute(args): Promise<string> {
    const action = String(args.action).toLowerCase();
    const agentId = args.agent ? String(args.agent).toLowerCase() : "";

    if (action === "status") {
      const agents = listAgents();
      if (agents.length === 0) return "Aucun agent enregistré.";
      const lines = ["📊 Status Agents:\n"];
      for (const a of agents) {
        const status = a.enabled ? (a.running ? "🟢 Actif" : "⏸️ Pausé") : "🔴 Désactivé";
        const lastRun = a.lastRunAt ? new Date(a.lastRunAt).toLocaleString("fr-CA", { timeZone: "America/Toronto" }) : "jamais";
        lines.push(`${status} **${a.id}** (${a.name})`);
        lines.push(`  Cycles: ${a.totalCycles} | Erreurs: ${a.errors} | Dernier: ${lastRun}`);
      }
      return lines.join("\n");
    }

    if (!agentId) return "Spécifie un agent: scout, analyst, learner, executor, trading-monitor, sentinel, mind";

    if (action === "trigger") {
      const ok = triggerAgent(agentId);
      return ok ? `⚡ Agent "${agentId}" déclenché immédiatement.` : `Agent "${agentId}" introuvable.`;
    }

    if (action === "enable" || action === "disable") {
      // Map agent ID to config key
      const agentConfigMap: Record<string, string> = {
        scout: "scout_enabled",
        analyst: "analyst_enabled",
        learner: "learner_enabled",
        executor: "executor_enabled",
        "trading-monitor": "trading_monitor_enabled",
        sentinel: "sentinel_enabled",
        mind: "mind_enabled",
      };
      const configKey = agentConfigMap[agentId];
      if (!configKey) return `Agent "${agentId}" inconnu. Disponibles: ${Object.keys(agentConfigMap).join(", ")}`;

      const entry = CONFIG_MAP[configKey];
      const newValue = action === "enable" ? "true" : "false";
      writeEnvFile(entry.envKey, newValue);
      reloadEnv();

      const agent = getAgent(agentId);
      if (agent) {
        if (action === "disable") {
          agent.stop();
        } else {
          agent.start();
        }
      }

      const emoji = action === "enable" ? "🟢" : "🔴";
      return `${emoji} Agent "${agentId}" ${action === "enable" ? "activé" : "désactivé"} (persisté dans .env)`;
    }

    return `Action inconnue "${action}". Utilise: enable, disable, trigger, status`;
  },
});

// ─── config.crons ──────────────────────────────────────────────────────────

registerSkill({
  name: "config.crons",
  description: "Quick cron job management from Telegram. Actions: 'list', 'pause ID', 'resume ID'. Example: config.crons(action='pause', id='3')",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      action: { type: "string", description: "'list' | 'pause' | 'resume'" },
      id: { type: "string", description: "Cron job ID (for pause/resume)" },
    },
    required: ["action"],
  },
  async execute(args): Promise<string> {
    const action = String(args.action).toLowerCase();

    if (action === "list") {
      const jobs = listCronJobs();
      if (jobs.length === 0) return "Aucun cron job.";
      const lines = ["⏰ Cron Jobs:\n"];
      for (const j of jobs) {
        const status = j.enabled ? "🟢" : "🔴";
        const next = j.next_run_at
          ? new Date(j.next_run_at * 1000).toLocaleString("fr-CA", { timeZone: "America/Toronto" })
          : "N/A";
        lines.push(`${status} [${j.id}] ${j.name} — ${j.schedule_type}(${j.schedule_value}) — prochain: ${next}`);
      }
      return lines.join("\n");
    }

    const jobId = Number(args.id);
    if (isNaN(jobId)) return "ID invalide. Utilise config.crons(action='list') pour voir les IDs.";

    if (action === "pause") {
      const ok = pauseCronJob(jobId);
      return ok ? `⏸️ Cron job #${jobId} mis en pause.` : `Cron job #${jobId} introuvable.`;
    }

    if (action === "resume") {
      const ok = resumeCronJob(jobId);
      return ok ? `▶️ Cron job #${jobId} repris.` : `Cron job #${jobId} introuvable.`;
    }

    return `Action "${action}" inconnue. Utilise: list, pause, resume`;
  },
});

log.info(`[skills] Registered config.set/get/list/agents/crons (5 config control skills)`);
