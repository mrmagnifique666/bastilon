/**
 * Built-in skills: episodic.log, episodic.recall, episodic.timeline
 * Episodic Memory — Kingston's journal of significant events.
 * Unlike semantic memory (facts), episodic memory captures experiences with context and emotion.
 */
import { registerSkill } from "../loader.js";
import {
  logEpisodicEvent,
  recallEvents,
  episodicTimeline,
} from "../../storage/store.js";

registerSkill({
  name: "episodic.log",
  description:
    "Log a significant event in Kingston's episodic memory. Types: interaction, decision, achievement, error, discovery, milestone, emotion.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      event_type: {
        type: "string",
        description: "interaction | decision | achievement | error | discovery | milestone | emotion",
      },
      summary: {
        type: "string",
        description: "Short summary of what happened",
      },
      details: {
        type: "string",
        description: "Detailed description (optional)",
      },
      participants: {
        type: "string",
        description: "Comma-separated list of people involved (optional)",
      },
      importance: {
        type: "number",
        description: "0.0 (trivial) to 1.0 (critical), default 0.5",
      },
      emotional_valence: {
        type: "number",
        description: "-1.0 (very negative) to 1.0 (very positive), default 0.0 (neutral)",
      },
    },
    required: ["event_type", "summary"],
  },
  async execute(args): Promise<string> {
    const eventType = String(args.event_type);
    const summary = String(args.summary);
    const participants = args.participants
      ? String(args.participants).split(",").map((s) => s.trim()).filter(Boolean)
      : [];

    const id = logEpisodicEvent(eventType, summary, {
      details: args.details ? String(args.details) : undefined,
      participants,
      importance: Number(args.importance) || 0.5,
      emotionalValence: Number(args.emotional_valence) || 0.0,
    });

    return `Evenement #${id} enregistre [${eventType}]: ${summary}`;
  },
});

registerSkill({
  name: "episodic.recall",
  description:
    "Recall past events from episodic memory. Filter by type, importance, time range, or search text.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      event_type: { type: "string", description: "Filter by event type (optional)" },
      min_importance: { type: "number", description: "Minimum importance 0.0-1.0 (optional)" },
      since_hours: { type: "number", description: "Events from last N hours (optional)" },
      search: { type: "string", description: "Search text in summary/details (optional)" },
      limit: { type: "number", description: "Max results (default 20)" },
    },
  },
  async execute(args): Promise<string> {
    const events = recallEvents({
      eventType: args.event_type ? String(args.event_type) : undefined,
      minImportance: args.min_importance ? Number(args.min_importance) : undefined,
      sinceHours: args.since_hours ? Number(args.since_hours) : undefined,
      search: args.search ? String(args.search) : undefined,
      limit: Number(args.limit) || 20,
    });

    if (events.length === 0) return "Aucun evenement trouve.";

    const lines = events.map((e) => {
      const date = new Date(e.created_at * 1000).toLocaleString("fr-CA", {
        timeZone: "America/Toronto",
      });
      const valence =
        e.emotional_valence > 0.3 ? "😊" :
        e.emotional_valence < -0.3 ? "😟" : "😐";
      const imp = e.importance >= 0.8 ? "🔴" : e.importance >= 0.5 ? "🟡" : "🟢";
      const parts = e.participants.length > 0 ? ` [${e.participants.join(", ")}]` : "";
      return `${imp}${valence} #${e.id} [${e.event_type}] ${e.summary.slice(0, 80)}${parts}\n     ${date}`;
    });

    return `**${events.length} evenement(s):**\n\n${lines.join("\n\n")}`;
  },
});

registerSkill({
  name: "episodic.timeline",
  description:
    "View a timeline of significant events over the past N days, grouped by date.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      days: { type: "number", description: "Number of days to look back (default 7)" },
    },
  },
  async execute(args): Promise<string> {
    const days = Number(args.days) || 7;
    const timeline = episodicTimeline(days);

    if (timeline.length === 0) return `Aucun evenement dans les ${days} derniers jours.`;

    const lines = timeline.map(({ date, events }) => {
      const dayEvents = events.map((e) => {
        const time = new Date(e.created_at * 1000).toLocaleTimeString("fr-CA", {
          timeZone: "America/Toronto",
          hour: "2-digit",
          minute: "2-digit",
        });
        return `  ${time} [${e.event_type}] ${e.summary.slice(0, 70)}`;
      });
      return `**${date}** (${events.length} evenement(s)):\n${dayEvents.join("\n")}`;
    });

    return lines.join("\n\n");
  },
});
