/**
 * Proactive Message System — Kingston sends messages to Nicolas proactively.
 * Triggers are evaluated periodically (called from scheduler heartbeat).
 * Each trigger checks a condition and sends a Telegram message if true.
 */
import { getDb } from "../storage/store.js";
import { config } from "../config/env.js";
import { log } from "../utils/log.js";

interface TriggerResult {
  shouldFire: boolean;
  message: string;
}

interface Trigger {
  name: string;
  checkIntervalMs: number;
  lastCheck: number;
  lastFired: number;
  cooldownMs: number;
  condition: () => Promise<TriggerResult | null>;
}

const triggers: Trigger[] = [];
const NICOLAS_CHAT = config.adminChatId;

/** Send a message directly via Telegram Bot API (no LLM, no router overhead) */
async function sendTelegram(text: string): Promise<boolean> {
  if (!NICOLAS_CHAT || !config.telegramToken) return false;
  try {
    const url = `https://api.telegram.org/bot${config.telegramToken}/sendMessage`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: NICOLAS_CHAT,
        text,
        parse_mode: "Markdown",
      }),
    });
    if (!resp.ok) {
      // Retry without Markdown if parse fails
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: NICOLAS_CHAT, text }),
      });
    }
    return true;
  } catch (e) {
    log.error(`[proactive] Telegram send failed: ${e}`);
    return false;
  }
}

/** Log proactive send to episodic memory */
function logProactiveSend(category: string, message: string): void {
  try {
    const db = getDb();
    db.prepare(
      `INSERT INTO episodic_events (event_type, summary, importance, emotional_valence, created_at)
       VALUES ('proactive_send', ?, ?, 1, ?)`
    ).run(`[${category}] ${message.slice(0, 200)}`, 4, Math.floor(Date.now() / 1000));
  } catch {
    /* ignore */
  }
}

function getHourET(): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    hour: "numeric",
    hour12: false,
  }).formatToParts(new Date());
  return Number(parts.find((p) => p.type === "hour")!.value);
}

function initTriggers(): void {
  // 1. Inactivity check — if Nicolas hasn't messaged in >6h during active hours
  triggers.push({
    name: "lonely_check",
    checkIntervalMs: 60 * 60 * 1000, // 1h
    lastCheck: 0,
    lastFired: 0,
    cooldownMs: 6 * 60 * 60 * 1000, // Max once per 6h
    async condition() {
      const h = getHourET();
      if (h < 9 || h > 21) return null;
      try {
        const db = getDb();
        const lastMsg = db.prepare(
          "SELECT MAX(ts) as last_ts FROM turns WHERE chat_id = ? AND role = 'user'"
        ).get(NICOLAS_CHAT) as any;
        if (!lastMsg?.last_ts) return null;
        const hoursSince = (Date.now() / 1000 - lastMsg.last_ts) / 3600;
        if (hoursSince > 6) {
          const messages = [
            "Hé, ça fait un moment! Si tu veux, je peux te faire un point rapide sur les goals et le trading.",
            "J'ai bossé sur quelques trucs pendant ton absence. Tu veux un résumé?",
            "Quiet moment. J'ai scanné le marché et avancé les goals. Besoin de quelque chose?",
          ];
          return {
            shouldFire: true,
            message: messages[Math.floor(Math.random() * messages.length)],
          };
        }
      } catch {
        /* ignore */
      }
      return null;
    },
  });

  // 2. Morning greeting — context-aware
  triggers.push({
    name: "morning_greeting",
    checkIntervalMs: 30 * 60 * 1000,
    lastCheck: 0,
    lastFired: 0,
    cooldownMs: 20 * 60 * 60 * 1000, // Once per 20h
    async condition() {
      const h = getHourET();
      if (h !== 8) return null;
      try {
        const db = getDb();
        // Check if already sent today
        const sent = db.prepare(
          `SELECT COUNT(*) as c FROM episodic_events
           WHERE event_type = 'proactive_send' AND description LIKE '%morning%'
           AND timestamp > ?`
        ).get(Math.floor(Date.now() / 1000) - 72000) as any; // 20h ago
        if (sent?.c > 0) return null;

        const dayFR = new Intl.DateTimeFormat("fr-CA", {
          timeZone: "America/Toronto",
          weekday: "long",
        }).format(new Date());

        let greeting = `Bon ${dayFR} matin!\n`;

        // Check active goals
        try {
          const activeGoals = db.prepare(
            "SELECT COUNT(*) as c FROM goal_tree WHERE parent_id IS NULL AND status = 'active'"
          ).get() as any;
          if (activeGoals?.c > 0) {
            greeting += `${activeGoals.c} goal(s) actif(s) à avancer aujourd'hui.\n`;
          }
        } catch {
          /* ignore */
        }

        // Check pending agent tasks
        try {
          const tasks = db.prepare(
            "SELECT COUNT(*) as c FROM agent_tasks WHERE status = 'pending'"
          ).get() as any;
          if (tasks?.c > 0) {
            greeting += `${tasks.c} tâche(s) en attente pour l'Executor.\n`;
          }
        } catch {
          /* ignore */
        }

        greeting += "Dis-moi si tu as besoin de quelque chose!";
        return { shouldFire: true, message: greeting };
      } catch {
        return null;
      }
    },
  });

  // 3. Cron failure alert
  triggers.push({
    name: "cron_failure",
    checkIntervalMs: 15 * 60 * 1000,
    lastCheck: 0,
    lastFired: 0,
    cooldownMs: 60 * 60 * 1000, // Once per hour
    async condition() {
      try {
        const db = getDb();
        const failing = db.prepare(
          "SELECT name, retry_count FROM cron_jobs WHERE retry_count >= 3 AND enabled = 1"
        ).all() as any[];
        if (failing.length > 0) {
          const names = failing.map((f: any) => f.name).join(", ");
          return {
            shouldFire: true,
            message: `⚠️ Cron(s) en échec répété: ${names}\nTu veux que je les debug ou que je les pause?`,
          };
        }
      } catch {
        /* ignore */
      }
      return null;
    },
  });

  // 4. Goal milestone — when a root goal completes
  triggers.push({
    name: "goal_milestone",
    checkIntervalMs: 10 * 60 * 1000,
    lastCheck: 0,
    lastFired: 0,
    cooldownMs: 5 * 60 * 1000,
    async condition() {
      try {
        const db = getDb();
        const tenMinAgo = Math.floor(Date.now() / 1000) - 600;
        const completed = db.prepare(
          "SELECT goal FROM goal_tree WHERE parent_id IS NULL AND status = 'completed' AND updated_at > ?"
        ).all(tenMinAgo) as any[];
        if (completed.length > 0) {
          const names = completed.map((g: any) => g.goal).join(", ");
          return {
            shouldFire: true,
            message: `🎯 Goal complété: ${names}\nNice, on avance!`,
          };
        }
      } catch {
        /* ignore */
      }
      return null;
    },
  });

  // 5. Trading significant move
  triggers.push({
    name: "trading_move",
    checkIntervalMs: 30 * 60 * 1000,
    lastCheck: 0,
    lastFired: 0,
    cooldownMs: 2 * 60 * 60 * 1000,
    async condition() {
      const h = getHourET();
      if (h < 9 || h > 16) return null;
      try {
        const db = getDb();
        const recentTrades = db.prepare(
          `SELECT action, reasoning FROM autonomous_decisions
           WHERE category = 'trading' AND created_at > ?
           ORDER BY created_at DESC LIMIT 5`
        ).all(Math.floor(Date.now() / 1000) - 3600) as any[];

        for (const trade of recentTrades) {
          if (
            trade.action &&
            (trade.action.includes("buy") || trade.action.includes("sell"))
          ) {
            return {
              shouldFire: true,
              message: `📈 Trade exécuté: ${trade.action.slice(0, 100)}\n${trade.reasoning?.slice(0, 100) || ""}`,
            };
          }
        }
      } catch {
        /* ignore */
      }
      return null;
    },
  });
}

/** Main check loop — called from scheduler/heartbeat */
export async function checkProactiveTriggers(): Promise<void> {
  const now = Date.now();
  const h = getHourET();

  // Only active during waking hours
  if (h < 7 || h >= 23) return;

  for (const trigger of triggers) {
    if (now - trigger.lastCheck < trigger.checkIntervalMs) continue;
    trigger.lastCheck = now;

    // Cooldown check
    if (now - trigger.lastFired < trigger.cooldownMs) continue;

    try {
      const result = await trigger.condition();
      if (result?.shouldFire) {
        const sent = await sendTelegram(result.message);
        if (sent) {
          trigger.lastFired = now;
          logProactiveSend(trigger.name, result.message);
          log.info(
            `[proactive] Fired trigger "${trigger.name}": ${result.message.slice(0, 80)}...`
          );
        }
      }
    } catch (e) {
      log.warn(`[proactive] Trigger "${trigger.name}" error: ${e}`);
    }
  }
}

// Initialize triggers on module load
initTriggers();
