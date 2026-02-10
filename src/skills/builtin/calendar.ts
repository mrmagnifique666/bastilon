/**
 * Built-in skills: calendar.today, calendar.upcoming, calendar.create, calendar.search, calendar.delete
 * Google Calendar integration via OAuth2.
 */
import { registerSkill } from "../loader.js";
import { getCalendarClient } from "../../gmail/auth.js";

const TZ = "America/Toronto";

function checkCalendarConfig(): string | null {
  try {
    getCalendarClient();
    return null;
  } catch (err) {
    return `Calendar not configured: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function formatEvent(event: any): string {
  const start = event.start?.dateTime || event.start?.date || "?";
  const end = event.end?.dateTime || event.end?.date || "";
  const startStr = event.start?.dateTime
    ? new Date(start).toLocaleString("fr-CA", { timeZone: TZ, dateStyle: "short", timeStyle: "short" })
    : start; // all-day event, just show date
  const endStr = event.end?.dateTime
    ? new Date(end).toLocaleTimeString("fr-CA", { timeZone: TZ, timeStyle: "short" })
    : "";
  const time = endStr ? `${startStr} — ${endStr}` : startStr;
  const location = event.location ? `\n  Location: ${event.location}` : "";
  const desc = event.description ? `\n  Description: ${event.description.slice(0, 200)}` : "";
  return `ID: ${event.id}\n  ${event.summary || "(no title)"}\n  ${time}${location}${desc}`;
}

// ── calendar.today ──

registerSkill({
  name: "calendar.today",
  description: "Show today's calendar events",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {},
  },
  async execute() {
    const configErr = checkCalendarConfig();
    if (configErr) return configErr;

    const calendar = getCalendarClient();
    const now = new Date();
    const startOfDay = new Date(now.toLocaleDateString("en-CA", { timeZone: TZ }) + "T00:00:00");
    const endOfDay = new Date(now.toLocaleDateString("en-CA", { timeZone: TZ }) + "T23:59:59");

    try {
      const res = await calendar.events.list({
        calendarId: "primary",
        timeMin: startOfDay.toISOString(),
        timeMax: endOfDay.toISOString(),
        singleEvents: true,
        orderBy: "startTime",
        timeZone: TZ,
      });

      const events = res.data.items;
      if (!events || events.length === 0) return "No events today.";

      return `Today's events (${events.length}):\n\n${events.map(formatEvent).join("\n---\n")}`;
    } catch (err) {
      return `Error fetching today's events: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

// ── calendar.upcoming ──

registerSkill({
  name: "calendar.upcoming",
  description: "Show upcoming calendar events (next N hours, default 24)",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      hours: { type: "number", description: "How many hours ahead to look (default 24, max 168)" },
      maxResults: { type: "number", description: "Max events to return (default 10)" },
    },
  },
  async execute(args) {
    const configErr = checkCalendarConfig();
    if (configErr) return configErr;

    const hours = Math.min(Number(args.hours) || 24, 168);
    const maxResults = Math.min(Number(args.maxResults) || 10, 25);
    const calendar = getCalendarClient();
    const now = new Date();
    const until = new Date(now.getTime() + hours * 3_600_000);

    try {
      const res = await calendar.events.list({
        calendarId: "primary",
        timeMin: now.toISOString(),
        timeMax: until.toISOString(),
        singleEvents: true,
        orderBy: "startTime",
        maxResults,
        timeZone: TZ,
      });

      const events = res.data.items;
      if (!events || events.length === 0) return `No events in the next ${hours} hours.`;

      return `Upcoming events (next ${hours}h):\n\n${events.map(formatEvent).join("\n---\n")}`;
    } catch (err) {
      return `Error fetching upcoming events: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

// ── calendar.create ──

registerSkill({
  name: "calendar.create",
  description: "Create a calendar event",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Event title" },
      start: { type: "string", description: "Start time (ISO 8601, e.g. '2026-02-07T14:00:00')" },
      end: { type: "string", description: "End time (ISO 8601). If omitted, defaults to 1 hour after start" },
      description: { type: "string", description: "Event description (optional)" },
      location: { type: "string", description: "Event location (optional)" },
      allDay: { type: "string", description: "Set to 'true' for all-day event. start/end should be dates (YYYY-MM-DD)" },
    },
    required: ["title", "start"],
  },
  async execute(args) {
    const configErr = checkCalendarConfig();
    if (configErr) return configErr;

    const calendar = getCalendarClient();
    const title = args.title as string;
    const startStr = args.start as string;
    const isAllDay = (args.allDay as string) === "true";

    let event: any;

    if (isAllDay) {
      const endStr = (args.end as string) || startStr;
      // All-day events: add 1 day to end date for Google Calendar convention
      const endDate = new Date(endStr);
      endDate.setDate(endDate.getDate() + 1);
      event = {
        summary: title,
        start: { date: startStr },
        end: { date: endDate.toISOString().split("T")[0] },
      };
    } else {
      const startDate = new Date(startStr);
      const endStr = args.end as string;
      const endDate = endStr ? new Date(endStr) : new Date(startDate.getTime() + 3_600_000);
      event = {
        summary: title,
        start: { dateTime: startDate.toISOString(), timeZone: TZ },
        end: { dateTime: endDate.toISOString(), timeZone: TZ },
      };
    }

    if (args.description) event.description = args.description as string;
    if (args.location) event.location = args.location as string;

    try {
      const res = await calendar.events.insert({
        calendarId: "primary",
        requestBody: event,
      });
      return `Event created: "${title}" (ID: ${res.data.id})`;
    } catch (err) {
      return `Error creating event: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

// ── calendar.search ──

registerSkill({
  name: "calendar.search",
  description: "Search calendar events by text query",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search text (matches title, description, location)" },
      maxResults: { type: "number", description: "Max results (default 10)" },
    },
    required: ["query"],
  },
  async execute(args) {
    const configErr = checkCalendarConfig();
    if (configErr) return configErr;

    const calendar = getCalendarClient();
    const query = args.query as string;
    const maxResults = Math.min(Number(args.maxResults) || 10, 25);

    try {
      const res = await calendar.events.list({
        calendarId: "primary",
        q: query,
        singleEvents: true,
        orderBy: "startTime",
        maxResults,
        timeMin: new Date().toISOString(),
        timeZone: TZ,
      });

      const events = res.data.items;
      if (!events || events.length === 0) return `No events matching "${query}".`;

      return `Found ${events.length} event(s):\n\n${events.map(formatEvent).join("\n---\n")}`;
    } catch (err) {
      return `Error searching events: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

// ── calendar.delete ──

registerSkill({
  name: "calendar.delete",
  description: "Delete a calendar event by ID",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      eventId: { type: "string", description: "Event ID to delete" },
    },
    required: ["eventId"],
  },
  async execute(args) {
    const configErr = checkCalendarConfig();
    if (configErr) return configErr;

    const calendar = getCalendarClient();
    const eventId = args.eventId as string;

    try {
      await calendar.events.delete({
        calendarId: "primary",
        eventId,
      });
      return `Event ${eventId} deleted.`;
    } catch (err) {
      return `Error deleting event: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});
