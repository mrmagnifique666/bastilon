/**
 * Built-in skill: context.load
 * Pre-loads relevant context before responding to a topic.
 * This is Kingston's "context stuffing" system — instead of being amnesiacs,
 * we arrive PREPARED with the right data already loaded.
 *
 * Usage: context.load(topic: "trading") → returns all trading-relevant data
 *        context.load(topic: "briefing") → returns briefing preferences + news
 *        context.load(topic: "courtiers") → returns client pipeline + competitors
 *        context.load(topic: "tshirts") → returns Printful/Shopify status
 *        context.load(topic: "moltbook") → returns Moltbook stats + recent posts
 */
import { registerSkill } from "../loader.js";
import { getDb } from "../../storage/store.js";
import { searchMemoriesFTS } from "../../memory/semantic.js";
import fs from "node:fs";
import path from "node:path";

// ── Helpers ──

function readFileIfExists(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function queryNotes(keyword: string, limit = 5): string[] {
  try {
    const db = getDb();
    const rows = db
      .prepare(
        "SELECT id, text FROM notes WHERE text LIKE ? ORDER BY id DESC LIMIT ?"
      )
      .all(`%${keyword}%`, limit) as { id: number; text: string }[];
    return rows.map((r) => `#${r.id}: ${r.text.slice(0, 200)}`);
  } catch {
    return [];
  }
}

function queryEpisodic(keyword: string, limit = 5): string[] {
  try {
    const db = getDb();
    const rows = db
      .prepare(
        "SELECT summary, details FROM episodic_events WHERE summary LIKE ? OR details LIKE ? ORDER BY created_at DESC LIMIT ?"
      )
      .all(`%${keyword}%`, `%${keyword}%`, limit) as {
      summary: string;
      details: string;
    }[];
    return rows.map((r) => `- ${r.summary}`);
  } catch {
    return [];
  }
}

function getRecentCronRuns(name: string): string {
  try {
    const db = getDb();
    const row = db
      .prepare(
        "SELECT * FROM crons WHERE name = ?"
      )
      .get(name) as any;
    if (!row) return `Cron "${name}": not found`;
    return `Cron "${name}": enabled=${row.enabled}, lastRun=${row.last_run_at || "never"}, schedule=${row.schedule_type}:${row.schedule_value}`;
  } catch {
    return "Cron data unavailable";
  }
}

// ── Topic Loaders ──

async function loadTrading(): Promise<string> {
  const sections: string[] = ["## CONTEXT: Trading\n"];

  // KINGSTON_MIND.md trading section
  const mindPath = path.resolve("relay/KINGSTON_MIND.md");
  const mind = readFileIfExists(mindPath);
  if (mind) {
    const tradingSection = mind.match(
      /## Trading[\s\S]*?(?=\n## [^#]|\n# |$)/
    );
    if (tradingSection) sections.push(tradingSection[0].slice(0, 1000));
  }

  // Recent trading notes
  const tradingNotes = queryNotes("trading", 5);
  if (tradingNotes.length > 0) {
    sections.push("\n### Recent Trading Notes:");
    sections.push(tradingNotes.join("\n"));
  }

  // Trading episodes
  const episodes = queryEpisodic("trading", 3);
  if (episodes.length > 0) {
    sections.push("\n### Recent Trading Events:");
    sections.push(episodes.join("\n"));
  }

  // Cron status
  sections.push("\n### Trading Crons:");
  sections.push(getRecentCronRuns("noon_trading_digest"));
  sections.push(getRecentCronRuns("alert_check"));

  // Market hours reminder
  const now = new Date();
  const etHour = parseInt(
    now.toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false })
  );
  const dayOfWeek = parseInt(
    now.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "narrow" })
  ) || now.getDay();
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
  const isMarketOpen = !isWeekend && etHour >= 9 && etHour < 16;
  sections.push(
    `\n### Market Status: ${isMarketOpen ? "OPEN" : "CLOSED"} (${etHour}h ET, ${isWeekend ? "weekend" : "weekday"})`
  );

  return sections.join("\n");
}

async function loadBriefing(): Promise<string> {
  const sections: string[] = ["## CONTEXT: Briefing\n"];

  // Nicolas's preferences
  sections.push("### Nicolas's Briefing Preferences:");
  sections.push("1. Blagues (ce qu'il aime le plus le matin)");
  sections.push("2. Nouvelles IA (contre-courant et nouveau)");
  sections.push("3. Résumé FOX News style (controversé/différent)");
  sections.push("4. Résumé Moltbook (monde des bots)");
  sections.push("5. Portfolio rapide (juste les chiffres)");
  sections.push("- Veut être SURPRIS, pas juste informé");
  sections.push("- Doit INFORMER + DIVERTIR");
  sections.push("- Kingston doit avoir des OPINIONS");

  // Briefing cron status
  sections.push("\n### Briefing Crons:");
  sections.push(getRecentCronRuns("morning_briefing"));
  sections.push(getRecentCronRuns("midday_briefing"));
  sections.push(getRecentCronRuns("afternoon_briefing"));
  sections.push(getRecentCronRuns("evening_briefing"));

  // Recent briefing notes
  const briefingNotes = queryNotes("briefing", 3);
  if (briefingNotes.length > 0) {
    sections.push("\n### Recent Briefing Notes:");
    sections.push(briefingNotes.join("\n"));
  }

  return sections.join("\n");
}

async function loadCourtiers(): Promise<string> {
  const sections: string[] = ["## CONTEXT: AI pour Courtiers\n"];

  // Client pipeline
  try {
    const db = getDb();
    const clients = db
      .prepare("SELECT * FROM clients ORDER BY id DESC LIMIT 10")
      .all() as any[];
    if (clients.length > 0) {
      sections.push("### Client Pipeline:");
      clients.forEach((c: any) => {
        sections.push(
          `- ${c.name} (${c.company || "N/A"}) — status: ${c.status || "new"}, needs: ${c.needs || "N/A"}`
        );
      });
    }
  } catch {
    sections.push("### Client Pipeline: DB unavailable");
  }

  // Competitor notes
  const competitorNotes = queryNotes("concurrentielle", 3);
  if (competitorNotes.length > 0) {
    sections.push("\n### Veille Concurrentielle:");
    sections.push(competitorNotes.join("\n"));
  }

  // qplus.plus services
  sections.push("\n### Services qplus.plus:");
  sections.push("1. AI Réceptionniste — répond aux appels 24/7");
  sections.push("2. Clonage Publicitaire — clone vidéo HeyGen + ElevenLabs");
  sections.push("3. Assistant Email AI — gère la boîte mail");
  sections.push("4. AI Photo Editor — retouche photos listings");
  sections.push(
    "\nPrix: Starter $149/mois, Pro $299/mois, Elite $499/mois"
  );

  // Strategy
  sections.push("\n### Stratégie:");
  sections.push(
    "Landing page + demo video + LinkedIn outreach à 50 courtiers Gatineau/Ottawa"
  );
  sections.push(
    "Compétiteurs: AVA Client (QC), Valery (ON), OACIQ Élise, UpFirst.ai, Dialzara, Phonely, Smith.ai"
  );

  return sections.join("\n");
}

async function loadTshirts(): Promise<string> {
  const sections: string[] = ["## CONTEXT: T-shirts (Bastilon Designs)\n"];

  sections.push("### Status:");
  sections.push("- Objectif: $150 revenue via Printful/Shopify");
  sections.push("- 11 designs uploaded to qplus.plus/designs/");
  sections.push("- 8 en Printful File Library");
  sections.push("- Printful file IDs: 944192247-944192272");
  sections.push("- Blocker: SHOPIFY_ACCESS_TOKEN missing in .env");

  // Printful product notes
  const tshirtNotes = queryNotes("printful", 3);
  if (tshirtNotes.length > 0) {
    sections.push("\n### Recent Notes:");
    sections.push(tshirtNotes.join("\n"));
  }

  return sections.join("\n");
}

async function loadMoltbook(): Promise<string> {
  const sections: string[] = ["## CONTEXT: Moltbook\n"];

  sections.push("### Account: @Kingston_CDR");
  sections.push("- Current: 8 karma, 0 followers, 6 posts, 31 comments");
  sections.push("- Strategy: Post trading story + engage on popular posts");

  // Moltbook notes
  const moltNotes = queryNotes("moltbook", 3);
  if (moltNotes.length > 0) {
    sections.push("\n### Recent Notes:");
    sections.push(moltNotes.join("\n"));
  }

  // Moltbook episodes
  const episodes = queryEpisodic("moltbook", 3);
  if (episodes.length > 0) {
    sections.push("\n### Recent Events:");
    sections.push(episodes.join("\n"));
  }

  return sections.join("\n");
}

async function loadAll(): Promise<string> {
  const parts = await Promise.all([
    loadTrading(),
    loadBriefing(),
    loadCourtiers(),
    loadTshirts(),
    loadMoltbook(),
  ]);
  return parts.join("\n\n---\n\n");
}

// ── Skill Registration ──

const TOPIC_MAP: Record<string, () => Promise<string>> = {
  trading: loadTrading,
  briefing: loadBriefing,
  courtiers: loadCourtiers,
  realtors: loadCourtiers,
  tshirts: loadTshirts,
  printful: loadTshirts,
  shopify: loadTshirts,
  moltbook: loadMoltbook,
  all: loadAll,
};

registerSkill({
  name: "context.load",
  description:
    "Pre-load relevant context for a topic. Topics: trading, briefing, courtiers, tshirts, moltbook, all. " +
    "Returns structured data from notes, episodic memory, KINGSTON_MIND.md, cron status, and known facts. " +
    "Use BEFORE responding to ensure Kingston is always prepared.",
  argsSchema: {
    type: "object",
    properties: {
      topic: {
        type: "string",
        description:
          "Topic to load context for: trading, briefing, courtiers, tshirts, moltbook, all",
      },
    },
    required: ["topic"],
  },
  async execute(args): Promise<string> {
    const topic = (args.topic as string).toLowerCase().trim();
    const loader = TOPIC_MAP[topic];

    if (!loader) {
      // Fallback: search notes + episodic + semantic memory for the keyword
      const notes = queryNotes(topic, 5);
      const episodes = queryEpisodic(topic, 5);
      const parts = [`## CONTEXT: ${topic}\n`];

      // Semantic memory search (FTS5 — fast keyword search)
      try {
        const semanticResults = await searchMemoriesFTS(topic, 5);
        if (semanticResults.length > 0) {
          parts.push("### Semantic Memory:");
          for (const r of semanticResults) {
            parts.push(`- [${r.category}] ${r.content.slice(0, 150)}`);
          }
        }
      } catch { /* semantic search unavailable */ }

      if (notes.length > 0) {
        parts.push("\n### Notes:");
        parts.push(notes.join("\n"));
      }
      if (episodes.length > 0) {
        parts.push("\n### Events:");
        parts.push(episodes.join("\n"));
      }
      if (notes.length === 0 && episodes.length === 0) {
        parts.push(`No stored context found for "${topic}". Proceeding with general knowledge.`);
      }
      return parts.join("\n");
    }

    return loader();
  },
});
