/**
 * Built-in skills: time.now, time.parse, time.add
 * Date/time utilities so Kingston always knows the current time.
 */
import { registerSkill } from "../loader.js";

registerSkill({
  name: "time.now",
  description: "Get the current date and time with timezone",
  argsSchema: {
    type: "object",
    properties: {
      format: {
        type: "string",
        description: "Output format: 'iso' (default), 'unix', 'human', 'detailed'",
      },
      timezone: {
        type: "string",
        description: "Timezone (e.g. 'America/New_York', 'UTC'). Default: system timezone.",
      },
    },
  },
  async execute(args) {
    const format = (args.format as string) || "iso";
    const timezone = args.timezone as string | undefined;
    const now = new Date();
    const opts: Intl.DateTimeFormatOptions = timezone ? { timeZone: timezone } : {};

    switch (format) {
      case "unix":
        return String(Math.floor(now.getTime() / 1000));

      case "human":
        return now.toLocaleString("fr-CA", { ...opts, dateStyle: "full", timeStyle: "long" });

      case "detailed": {
        const tzName = new Intl.DateTimeFormat("fr-CA", { ...opts, timeZoneName: "long" })
          .formatToParts(now)
          .find((p) => p.type === "timeZoneName")?.value;
        return [
          `Date: ${now.toLocaleDateString("fr-CA", { ...opts, dateStyle: "full" })}`,
          `Time: ${now.toLocaleTimeString("fr-CA", { ...opts, timeStyle: "long" })}`,
          `Timezone: ${tzName || "Unknown"}`,
          `Unix: ${Math.floor(now.getTime() / 1000)}`,
          `ISO: ${now.toISOString()}`,
        ].join("\n");
      }

      case "iso":
      default:
        return now.toISOString();
    }
  },
});

registerSkill({
  name: "time.parse",
  description: "Parse a date/time string and convert to different formats",
  argsSchema: {
    type: "object",
    properties: {
      input: { type: "string", description: "Date/time string (ISO, unix timestamp, or human-readable)" },
      outputFormat: { type: "string", description: "Output format: 'iso' (default), 'unix', 'human'" },
    },
    required: ["input"],
  },
  async execute(args) {
    const input = args.input as string;
    const outputFormat = (args.outputFormat as string) || "iso";

    let date: Date;
    if (/^\d+$/.test(input)) {
      date = new Date(parseInt(input, 10) * 1000);
    } else {
      date = new Date(input);
    }

    if (isNaN(date.getTime())) return `Error: Could not parse date/time: ${input}`;

    switch (outputFormat) {
      case "unix":
        return String(Math.floor(date.getTime() / 1000));
      case "human":
        return date.toLocaleString("fr-CA", { dateStyle: "full", timeStyle: "long" });
      case "iso":
      default:
        return date.toISOString();
    }
  },
});

registerSkill({
  name: "time.add",
  description: "Add or subtract time from a date. Returns new date.",
  argsSchema: {
    type: "object",
    properties: {
      base: { type: "string", description: "Base date (ISO, unix, or 'now'). Default: 'now'" },
      seconds: { type: "number", description: "Seconds to add (negative to subtract)" },
      minutes: { type: "number", description: "Minutes to add" },
      hours: { type: "number", description: "Hours to add" },
      days: { type: "number", description: "Days to add" },
      outputFormat: { type: "string", description: "Output format: 'iso' (default), 'unix', 'human'" },
    },
  },
  async execute(args) {
    const baseStr = (args.base as string) || "now";
    const seconds = (args.seconds as number) || 0;
    const minutes = (args.minutes as number) || 0;
    const hours = (args.hours as number) || 0;
    const days = (args.days as number) || 0;
    const outputFormat = (args.outputFormat as string) || "iso";

    let base: Date;
    if (baseStr === "now") {
      base = new Date();
    } else if (/^\d+$/.test(baseStr)) {
      base = new Date(parseInt(baseStr, 10) * 1000);
    } else {
      base = new Date(baseStr);
    }

    if (isNaN(base.getTime())) return `Error: Could not parse base date: ${baseStr}`;

    const totalMs =
      seconds * 1000 + minutes * 60_000 + hours * 3_600_000 + days * 86_400_000;
    const result = new Date(base.getTime() + totalMs);

    switch (outputFormat) {
      case "unix":
        return String(Math.floor(result.getTime() / 1000));
      case "human":
        return result.toLocaleString("fr-CA", { dateStyle: "full", timeStyle: "long" });
      case "iso":
      default:
        return result.toISOString();
    }
  },
});
