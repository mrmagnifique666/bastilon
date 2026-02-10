/**
 * Built-in skills: booking.availability, booking.create, booking.cancel,
 * booking.reschedule, booking.list
 * Supports both Calendly and Cal.com APIs.
 */
import { registerSkill } from "../loader.js";
import { log } from "../../utils/log.js";

function getCalendlyKey(): string | null {
  return process.env.CALENDLY_API_KEY || null;
}

function getCalComKey(): string | null {
  return process.env.CAL_COM_API_KEY || null;
}

function checkConfig(): string | null {
  if (!getCalendlyKey() && !getCalComKey()) return "Booking not configured. Set CALENDLY_API_KEY or CAL_COM_API_KEY in .env";
  return null;
}

function getProvider(): "calendly" | "calcom" {
  return getCalendlyKey() ? "calendly" : "calcom";
}

// ── Calendly helpers ──
const CALENDLY_API = "https://api.calendly.com";

async function calendlyFetch(method: string, path: string, body?: unknown): Promise<any> {
  const resp = await fetch(`${CALENDLY_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${getCalendlyKey()}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`Calendly ${resp.status}: ${data.message || JSON.stringify(data)}`);
  return data;
}

// ── Cal.com helpers ──
const CALCOM_API = "https://api.cal.com/v1";

async function calcomFetch(method: string, path: string, body?: unknown): Promise<any> {
  const sep = path.includes("?") ? "&" : "?";
  const resp = await fetch(`${CALCOM_API}${path}${sep}apiKey=${getCalComKey()}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`Cal.com ${resp.status}: ${data.message || JSON.stringify(data)}`);
  return data;
}

registerSkill({
  name: "booking.availability",
  description: "Check available time slots for booking.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      eventTypeId: { type: "string", description: "Event type ID (required for Cal.com)" },
      dateFrom: { type: "string", description: "Start date (YYYY-MM-DD, default: today)" },
      dateTo: { type: "string", description: "End date (YYYY-MM-DD, default: +7 days)" },
    },
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;
    const from = String(args.dateFrom || new Date().toISOString().split("T")[0]);
    const to = String(args.dateTo || new Date(Date.now() + 7 * 86400000).toISOString().split("T")[0]);

    try {
      if (getProvider() === "calendly") {
        const me = await calendlyFetch("GET", "/users/me");
        const userUri = me.resource.uri;
        const data = await calendlyFetch("GET",
          `/user_availability_schedules?user=${encodeURIComponent(userUri)}`
        );
        const schedules = data.collection || [];
        return schedules.length
          ? `**Availability schedules (${schedules.length}):**\n${schedules.map((s: any) => `- ${s.name}: ${s.timezone}`).join("\n")}`
          : "No availability schedules found.";
      } else {
        const data = await calcomFetch("GET",
          `/availability?dateFrom=${from}&dateTo=${to}${args.eventTypeId ? `&eventTypeId=${args.eventTypeId}` : ""}`
        );
        const slots = data.slots || data.busy || [];
        return slots.length
          ? `**Available slots (${from} to ${to}):**\n${JSON.stringify(slots, null, 2).slice(0, 2000)}`
          : "No available slots found.";
      }
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

registerSkill({
  name: "booking.create",
  description: "Create a booking/scheduled event.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      eventTypeId: { type: "string", description: "Event type ID" },
      startTime: { type: "string", description: "Start time (ISO 8601)" },
      inviteeEmail: { type: "string", description: "Invitee email address" },
      inviteeName: { type: "string", description: "Invitee name" },
    },
    required: ["eventTypeId", "startTime", "inviteeEmail"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;

    try {
      if (getProvider() === "calcom") {
        const data = await calcomFetch("POST", "/bookings", {
          eventTypeId: Number(args.eventTypeId),
          start: String(args.startTime),
          responses: {
            name: String(args.inviteeName || "Guest"),
            email: String(args.inviteeEmail),
          },
          timeZone: "America/Toronto",
        });
        return `Booking created: id=${data.id || data.uid} at ${args.startTime}`;
      } else {
        return "Calendly booking creation requires webhook-based flow. Use Cal.com for programmatic booking or share your Calendly link.";
      }
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

registerSkill({
  name: "booking.cancel",
  description: "Cancel a booking.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      bookingId: { type: "string", description: "Booking ID to cancel" },
      reason: { type: "string", description: "Cancellation reason (optional)" },
    },
    required: ["bookingId"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;

    try {
      if (getProvider() === "calcom") {
        await calcomFetch("DELETE", `/bookings/${args.bookingId}`, {
          reason: String(args.reason || "Cancelled"),
        });
        return `Booking ${args.bookingId} cancelled.`;
      } else {
        await calendlyFetch("POST", `/scheduled_events/${args.bookingId}/cancellation`, {
          reason: String(args.reason || "Cancelled"),
        });
        return `Calendly event ${args.bookingId} cancelled.`;
      }
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

registerSkill({
  name: "booking.reschedule",
  description: "Reschedule a booking to a new time.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      bookingId: { type: "string", description: "Booking ID to reschedule" },
      newTime: { type: "string", description: "New start time (ISO 8601)" },
    },
    required: ["bookingId", "newTime"],
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;

    try {
      if (getProvider() === "calcom") {
        const data = await calcomFetch("PATCH", `/bookings/${args.bookingId}`, {
          start: String(args.newTime),
          timeZone: "America/Toronto",
        });
        return `Booking rescheduled to ${args.newTime}`;
      } else {
        return "Calendly rescheduling requires user action via the Calendly link. Use Cal.com for programmatic rescheduling.";
      }
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

registerSkill({
  name: "booking.list",
  description: "List upcoming bookings.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      status: { type: "string", description: "Filter: upcoming, past, cancelled (default: upcoming)" },
    },
  },
  async execute(args): Promise<string> {
    const err = checkConfig();
    if (err) return err;

    try {
      if (getProvider() === "calcom") {
        const data = await calcomFetch("GET", "/bookings");
        const bookings = (data.bookings || []).slice(0, 20);
        if (!bookings.length) return "No bookings found.";
        const lines = bookings.map((b: any) =>
          `[${b.id}] ${b.title} — ${b.startTime} | ${b.attendees?.map((a: any) => a.email).join(", ") || "no attendees"} | ${b.status}`
        );
        return `**Bookings (${bookings.length}):**\n${lines.join("\n")}`;
      } else {
        const me = await calendlyFetch("GET", "/users/me");
        const userUri = me.resource.uri;
        const data = await calendlyFetch("GET",
          `/scheduled_events?user=${encodeURIComponent(userUri)}&count=20&status=active`
        );
        const events = data.collection || [];
        if (!events.length) return "No upcoming events.";
        const lines = events.map((e: any) =>
          `[${e.uri.split("/").pop()}] ${e.name} — ${e.start_time} | ${e.status}`
        );
        return `**Upcoming events (${events.length}):**\n${lines.join("\n")}`;
      }
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

log.debug("Registered 5 booking.* skills");
