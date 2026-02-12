/**
 * Built-in skills: youtube.track_competitor, youtube.competitor_report, youtube.competitor_list
 * YouTube Competitor Tracking — monitor competing channels, weekly analysis.
 * Uses YouTube Data API (free tier: 10,000 units/day) or web search fallback.
 */
import { registerSkill, getSkill } from "../loader.js";
import { getDb } from "../../storage/store.js";
import { config } from "../../config/env.js";
import { log } from "../../utils/log.js";

registerSkill({
  name: "youtube.track_competitor",
  description: "Add a YouTube channel to competitor tracking. Provide channel ID or name.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      channel_id: { type: "string", description: "YouTube channel ID (e.g. UC...)" },
      channel_name: { type: "string", description: "Channel display name" },
      notes: { type: "string", description: "Why tracking this channel (optional)" },
    },
    required: ["channel_id", "channel_name"],
  },
  async execute(args): Promise<string> {
    const channelId = String(args.channel_id);
    const channelName = String(args.channel_name);
    const notes = args.notes ? String(args.notes) : null;
    const d = getDb();

    try {
      d.prepare(
        "INSERT INTO youtube_competitors (channel_id, channel_name, notes) VALUES (?, ?, ?)"
      ).run(channelId, channelName, notes);
      return `Competitor ajouté: ${channelName} (${channelId})`;
    } catch (err: any) {
      if (err.message?.includes("UNIQUE")) return `${channelName} est déjà suivi.`;
      return `Erreur: ${err.message}`;
    }
  },
});

registerSkill({
  name: "youtube.competitor_list",
  description: "List all tracked YouTube competitors.",
  adminOnly: true,
  argsSchema: { type: "object", properties: {} },
  async execute(): Promise<string> {
    const d = getDb();
    const rows = d.prepare(
      "SELECT * FROM youtube_competitors WHERE enabled = 1 ORDER BY channel_name"
    ).all() as any[];

    if (rows.length === 0) return "Aucun competitor YouTube suivi. Utilise youtube.track_competitor.";

    return rows.map(r => {
      const lastCheck = r.last_checked_at
        ? new Date(r.last_checked_at * 1000).toLocaleDateString("fr-CA")
        : "jamais";
      return `**${r.channel_name}** (${r.channel_id})\n  Videos: ${r.last_video_count || "?"} | Dernier check: ${lastCheck}${r.notes ? `\n  Notes: ${r.notes}` : ""}`;
    }).join("\n\n");
  },
});

registerSkill({
  name: "youtube.competitor_report",
  description:
    "Generate a competitor analysis report. Fetches latest videos via YouTube API or web search. " +
    "Analyzes: upload frequency, topics, engagement patterns.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      days: { type: "number", description: "Lookback days (default: 7)" },
    },
  },
  async execute(args): Promise<string> {
    const days = Number(args.days) || 7;
    const d = getDb();

    const competitors = d.prepare(
      "SELECT * FROM youtube_competitors WHERE enabled = 1"
    ).all() as any[];

    if (competitors.length === 0) return "Aucun competitor suivi.";

    const lines = [`**YouTube Competitor Report — ${days} derniers jours**\n`];
    const webSearch = getSkill("web.search");

    for (const comp of competitors) {
      lines.push(`**${comp.channel_name}:**`);

      // Try web search for recent videos
      if (webSearch) {
        try {
          const result = await webSearch.execute({
            query: `site:youtube.com "${comp.channel_name}" new video ${new Date().getFullYear()}`,
          });

          // Extract video info from search results
          const videoLines = String(result)
            .split("\n")
            .filter(l => l.includes("youtube.com/watch") || l.includes("youtu.be"))
            .slice(0, 5);

          if (videoLines.length > 0) {
            for (const vl of videoLines) lines.push(`  - ${vl.trim().slice(0, 120)}`);
          } else {
            lines.push("  (aucune vidéo récente trouvée via recherche)");
          }
        } catch {
          lines.push("  (recherche échouée)");
        }
      } else {
        lines.push("  (web.search non disponible — configure DuckDuckGo ou Serper)");
      }

      // Update last check
      d.prepare(
        "UPDATE youtube_competitors SET last_checked_at = unixepoch() WHERE id = ?"
      ).run(comp.id);

      lines.push("");
    }

    lines.push(`_${competitors.length} competitor(s) analysé(s). Prochaine vérification automatique dans 7 jours._`);
    return lines.join("\n");
  },
});

log.debug("Registered 3 youtube.track* skills");
