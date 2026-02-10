/**
 * Built-in skills: scheduler.add / scheduler.list / scheduler.cancel
 * Manages custom reminders via the scheduler module.
 */
import { registerSkill } from "../loader.js";
import {
  addReminder,
  listReminders,
  cancelReminder,
} from "../../scheduler/scheduler.js";

registerSkill({
  name: "scheduler.add",
  description:
    "Add a reminder that will fire at a given Unix epoch timestamp. The bot will send the message at that time.",
  argsSchema: {
    type: "object",
    properties: {
      fireAt: {
        type: "number",
        description: "Unix epoch (seconds) when the reminder should fire",
      },
      message: {
        type: "string",
        description: "Reminder message to deliver",
      },
    },
    required: ["fireAt", "message"],
  },
  async execute(args): Promise<string> {
    const fireAt = args.fireAt as number;
    const message = args.message as string;

    const nowEpoch = Math.floor(Date.now() / 1000);
    if (fireAt <= nowEpoch) {
      return "Error: fireAt must be in the future.";
    }

    const id = addReminder(fireAt, message);
    const dateStr = new Date(fireAt * 1000).toLocaleString("fr-CA", {
      timeZone: "America/Toronto",
    });
    return `Reminder #${id} created — will fire at ${dateStr}.`;
  },
});

registerSkill({
  name: "scheduler.list",
  description: "List all pending (unfired) reminders.",
  argsSchema: {
    type: "object",
    properties: {},
  },
  async execute(): Promise<string> {
    const reminders = listReminders();
    if (reminders.length === 0) return "No pending reminders.";
    return reminders
      .map((r) => {
        const dateStr = new Date(r.fire_at * 1000).toLocaleString("fr-CA", {
          timeZone: "America/Toronto",
        });
        return `#${r.id} — ${dateStr}: ${r.message}`;
      })
      .join("\n");
  },
});

registerSkill({
  name: "scheduler.cancel",
  description: "Cancel a pending reminder by its ID.",
  argsSchema: {
    type: "object",
    properties: {
      id: { type: "number", description: "Reminder ID to cancel" },
    },
    required: ["id"],
  },
  async execute(args): Promise<string> {
    const id = args.id as number;
    const ok = cancelReminder(id);
    if (!ok) return `Reminder #${id} not found or already fired.`;
    return `Reminder #${id} cancelled.`;
  },
});
