/**
 * Scheduler Agent — autonomous timed task executor.
 * Heartbeat: 60 seconds. Checks ET time, fires events when due.
 *
 * Architecture: 100% onTick (NO LLM cost)
 * - Calls deterministic briefing functions from briefings.ts
 * - Each function: fetch API → format message → send Telegram
 * - Retry once on failure, alert Nicolas on double-fail
 * - Tracks fired events per day to prevent duplicates
 *
 * Replaces: heartbeat.ts (separate process with dual-polling conflicts)
 * Keeps: All other agents, cron system, morning call
 */
import type { AgentConfig } from "../base.js";
import { config } from "../../config/env.js";
import { log } from "../../utils/log.js";

const TZ = "America/Toronto";

// ── Deduplication ──
const firedToday = new Map<string, string>(); // eventKey → YYYY-MM-DD

// ── Schedule definition ──
interface ScheduledTask {
  key: string;
  hour: number;
  minute: number;
  description: string;
  weekdaysOnly?: boolean;
  handler: () => Promise<unknown>;
}

const SCHEDULE: ScheduledTask[] = [
  {
    key: "night_self_review",
    hour: 3, minute: 0,
    description: "Night Self-Review",
    handler: async () => {
      const m = await import("../../scheduler/briefings.js");
      return m.sendNightSelfReview();
    },
  },
  {
    key: "api_health_check",
    hour: 4, minute: 0,
    description: "API Health Check",
    handler: async () => {
      const m = await import("../../scheduler/briefings.js");
      return m.sendApiHealthCheck();
    },
  },
  {
    key: "briefing_prep",
    hour: 5, minute: 0,
    description: "Briefing Prep",
    handler: async () => {
      const m = await import("../../scheduler/briefings.js");
      return m.sendBriefingPrep();
    },
  },
  {
    key: "morning_briefing",
    hour: 6, minute: 30,
    description: "Morning Journal",
    handler: async () => {
      const m = await import("../../scheduler/briefings.js");
      return m.sendMorningBriefing();
    },
  },
  {
    key: "morning_call",
    hour: 8, minute: 0,
    description: "Morning Call",
    weekdaysOnly: true,
    handler: async () => {
      const { callNicolas } = await import("../../voice/outbound.js");
      return callNicolas(
        "Bonjour Nicolas, c'est Kingston avec ton briefing du matin. " +
        "J'ai ton résumé trading, tes rendez-vous, et les nouvelles importantes.",
      );
    },
  },
  {
    key: "noon_briefing",
    hour: 12, minute: 0,
    description: "Noon Journal",
    handler: async () => {
      const m = await import("../../scheduler/briefings.js");
      return m.sendNoonBriefing();
    },
  },
  {
    key: "afternoon_briefing",
    hour: 15, minute: 30,
    description: "Afternoon Update",
    weekdaysOnly: true,
    handler: async () => {
      const m = await import("../../scheduler/briefings.js");
      return m.sendAfternoonBriefing();
    },
  },
  {
    key: "evening_briefing",
    hour: 20, minute: 0,
    description: "Evening Briefing",
    handler: async () => {
      const m = await import("../../scheduler/briefings.js");
      return m.sendEveningBriefing();
    },
  },
  {
    key: "night_journal",
    hour: 23, minute: 30,
    description: "Night Journal",
    handler: async () => {
      const m = await import("../../scheduler/briefings.js");
      return m.generateNightSummary();
    },
  },
];

// ── Time helpers (ET timezone) ──

function getET(): { hour: number; minute: number; dateStr: string; dayOfWeek: number } {
  const now = new Date();

  // Get hour and minute in ET
  const hourStr = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour: "numeric",
    hour12: false,
  }).format(now);
  const minuteStr = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    minute: "numeric",
  }).format(now);

  // Get date string and day of week in ET
  const dateStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now); // YYYY-MM-DD

  // Day of week in ET (not local!)
  const dayName = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    weekday: "short",
  }).format(now);
  const dayMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };

  return {
    hour: parseInt(hourStr),
    minute: parseInt(minuteStr),
    dateStr,
    dayOfWeek: dayMap[dayName] ?? now.getDay(),
  };
}

// ── Agent config ──

export function createSchedulerAgentConfig(): AgentConfig {
  // Tell the old scheduler that briefings are handled here
  process.env.__KINGSTON_LAUNCHER = "1";

  return {
    id: "scheduler",
    name: "Scheduler",
    role: "Autonomous task scheduler — fires briefings and timed events at exact times. Zero LLM cost.",
    heartbeatMs: 60_000, // Check every 60 seconds
    enabled: true,
    chatId: 109,
    userId: config.voiceUserId,
    cycleCount: 1,

    onTick: async (_cycle: number, sendAlert: (msg: string) => void): Promise<void> => {
      const { hour, minute, dateStr, dayOfWeek } = getET();
      const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;

      // Clean dedup map at midnight
      if (hour === 0 && minute <= 1) {
        firedToday.clear();
      }

      for (const task of SCHEDULE) {
        // Already fired today?
        if (firedToday.get(task.key) === dateStr) continue;

        // Right time? (2-minute window to account for tick timing)
        if (hour !== task.hour) continue;
        if (minute < task.minute || minute > task.minute + 1) continue;

        // Weekday check
        if (task.weekdaysOnly && !isWeekday) continue;

        // Mark as fired BEFORE executing (prevents duplicate if handler is slow)
        firedToday.set(task.key, dateStr);

        log.info(`[scheduler-agent] ⏰ Firing: ${task.description} (${hour}:${String(minute).padStart(2, "0")} ET)`);

        try {
          await Promise.race([
            task.handler(),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error("timeout after 90s")), 90_000),
            ),
          ]);
          log.info(`[scheduler-agent] ✅ ${task.description} — done`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error(`[scheduler-agent] ❌ ${task.description} failed: ${msg}`);

          // One retry after 30 seconds
          setTimeout(async () => {
            try {
              log.info(`[scheduler-agent] 🔄 Retrying: ${task.description}`);
              await Promise.race([
                task.handler(),
                new Promise((_, reject) =>
                  setTimeout(() => reject(new Error("retry timeout")), 90_000),
                ),
              ]);
              log.info(`[scheduler-agent] ✅ ${task.description} — retry OK`);
            } catch (retryErr) {
              const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
              log.error(`[scheduler-agent] ❌ ${task.description} retry failed: ${retryMsg}`);
              sendAlert(`⚠️ ${task.description} a échoué 2x: ${retryMsg}`);
            }
          }, 30_000);
        }
      }
    },

    // Pure onTick — no LLM ever
    buildPrompt: (): string | null => null,
  };
}
