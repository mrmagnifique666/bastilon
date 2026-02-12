/**
 * Built-in skills: calendar.auto_schedule, calendar.time_blocks
 * Auto-scheduling: pull tasks by priority, auto-block time on Google Calendar, conflict resolution.
 * Inspired by OpenClaw: Todoist tasks → Google Calendar time blocks.
 */
import { registerSkill, getSkill } from "../loader.js";
import { getDb } from "../../storage/store.js";
import { log } from "../../utils/log.js";

interface TaskBlock {
  title: string;
  priority: "high" | "medium" | "low";
  duration_min: number;
  preferred_time?: string; // "morning", "afternoon", "evening"
}

const TIME_SLOTS: Record<string, { start: number; end: number }> = {
  morning: { start: 9, end: 12 },
  afternoon: { start: 13, end: 17 },
  evening: { start: 18, end: 21 },
};

const PRIORITY_SLOT: Record<string, string> = {
  high: "morning",     // deep work
  medium: "afternoon",
  low: "evening",
};

registerSkill({
  name: "calendar.auto_schedule",
  description:
    "Auto-schedule tasks on Google Calendar. Pulls from planner/goals, assigns time blocks by priority. " +
    "High priority = morning, Medium = afternoon, Low = evening. Avoids conflicts with existing events.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      tasks: {
        type: "string",
        description: 'JSON array of tasks: [{"title":"...","priority":"high|medium|low","duration_min":60}]',
      },
      date: { type: "string", description: "Target date YYYY-MM-DD (default: tomorrow)" },
      buffer_min: { type: "number", description: "Buffer minutes between tasks (default: 15)" },
    },
    required: ["tasks"],
  },
  async execute(args): Promise<string> {
    let tasks: TaskBlock[];
    try {
      tasks = JSON.parse(String(args.tasks));
      if (!Array.isArray(tasks)) throw new Error("not array");
    } catch {
      return 'Erreur: tasks doit être un JSON array de {title, priority, duration_min}.';
    }

    const bufferMin = Number(args.buffer_min) || 15;
    const targetDate = args.date ? String(args.date) : (() => {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      return d.toISOString().slice(0, 10);
    })();

    // Sort: high priority first
    const priorityOrder = { high: 0, medium: 1, low: 2 };
    tasks.sort((a, b) => (priorityOrder[a.priority] || 2) - (priorityOrder[b.priority] || 2));

    // Check existing events via calendar skill
    const calendarList = getSkill("calendar.list");
    let existingBlocks: Array<{ start: number; end: number }> = [];
    if (calendarList) {
      try {
        const result = await calendarList.execute({ date: targetDate });
        // Parse existing events to find blocked times
        const timeRegex = /(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})/g;
        let match;
        while ((match = timeRegex.exec(result)) !== null) {
          existingBlocks.push({
            start: parseInt(match[1]) * 60 + parseInt(match[2]),
            end: parseInt(match[3]) * 60 + parseInt(match[4]),
          });
        }
      } catch { /* no calendar access */ }
    }

    // Schedule tasks into time slots
    const scheduled: Array<TaskBlock & { startTime: string; endTime: string }> = [];
    const slotUsage: Record<string, number> = { morning: 9 * 60, afternoon: 13 * 60, evening: 18 * 60 };

    for (const task of tasks) {
      const preferredSlot = task.preferred_time || PRIORITY_SLOT[task.priority] || "afternoon";
      const slot = TIME_SLOTS[preferredSlot] || TIME_SLOTS.afternoon;
      let startMin = Math.max(slotUsage[preferredSlot] || slot.start * 60, slot.start * 60);

      // Find next available slot avoiding conflicts
      let placed = false;
      while (startMin + task.duration_min <= slot.end * 60) {
        const endMin = startMin + task.duration_min;
        const conflicts = existingBlocks.some(b =>
          (startMin < b.end && endMin > b.start)
        );

        if (!conflicts) {
          const startH = Math.floor(startMin / 60).toString().padStart(2, "0");
          const startM = (startMin % 60).toString().padStart(2, "0");
          const endH = Math.floor(endMin / 60).toString().padStart(2, "0");
          const endM = (endMin % 60).toString().padStart(2, "0");

          scheduled.push({
            ...task,
            startTime: `${startH}:${startM}`,
            endTime: `${endH}:${endM}`,
          });

          slotUsage[preferredSlot] = endMin + bufferMin;
          existingBlocks.push({ start: startMin, end: endMin });
          placed = true;
          break;
        }
        startMin += 15; // try next 15-min slot
      }

      if (!placed) {
        scheduled.push({ ...task, startTime: "N/A", endTime: "N/A" });
      }
    }

    // Create calendar events if calendar.create is available
    const calendarCreate = getSkill("calendar.create");
    let created = 0;
    if (calendarCreate) {
      for (const s of scheduled) {
        if (s.startTime === "N/A") continue;
        try {
          await calendarCreate.execute({
            title: `[${s.priority.toUpperCase()}] ${s.title}`,
            start: `${targetDate}T${s.startTime}:00`,
            end: `${targetDate}T${s.endTime}:00`,
          });
          created++;
        } catch { /* skip */ }
      }
    }

    // Format output
    const lines = [`**Auto-Schedule — ${targetDate}**\n`];
    const bySlot: Record<string, typeof scheduled> = {};
    for (const s of scheduled) {
      const slot = s.preferred_time || PRIORITY_SLOT[s.priority] || "afternoon";
      if (!bySlot[slot]) bySlot[slot] = [];
      bySlot[slot].push(s);
    }

    for (const [slot, tasks] of Object.entries(bySlot)) {
      const icon = slot === "morning" ? "🌅" : slot === "afternoon" ? "☀️" : "🌙";
      lines.push(`${icon} **${slot.charAt(0).toUpperCase() + slot.slice(1)}:**`);
      for (const t of tasks) {
        const pIcon = t.priority === "high" ? "🔴" : t.priority === "medium" ? "🟡" : "🟢";
        lines.push(`  ${pIcon} ${t.startTime}-${t.endTime} — ${t.title} (${t.duration_min}min)`);
      }
      lines.push("");
    }

    if (created > 0) {
      lines.push(`✅ ${created} événement(s) créé(s) dans Google Calendar.`);
    } else if (!calendarCreate) {
      lines.push(`ℹ️ calendar.create non disponible — planification affichée uniquement.`);
    }

    return lines.join("\n");
  },
});

log.debug("Registered 1 calendar.auto_schedule skill");
