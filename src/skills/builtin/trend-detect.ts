/**
 * Built-in skills: trend.detect, trend.emerging
 * Trend detection engine — scans HackerNews, Reddit, and Moltbook for rising topics.
 * Identifies what's gaining momentum BEFORE it goes mainstream.
 */
import { registerSkill, getSkill } from "../loader.js";
import { log } from "../../utils/log.js";
import { runClaude, type ParsedResult } from "../../llm/claudeCli.js";

const TREND_CHAT_ID = 116;

async function askClaude(prompt: string): Promise<string> {
  try {
    const result: ParsedResult = await runClaude(TREND_CHAT_ID, prompt, true, "haiku");
    if (result.text) return result.text;
    if (result.toolResults?.length) {
      return result.toolResults.map(t => t.result).join("\n");
    }
    return "";
  } catch (err) {
    log.error(`[trend] Claude failed: ${err}`);
    return "";
  }
}

interface TrendSignal {
  source: string;
  title: string;
  score: number;
  url?: string;
}

// ── trend.detect — Full scan across multiple sources ──

registerSkill({
  name: "trend.detect",
  description:
    "Scan HackerNews, Reddit (via web search), and Moltbook for emerging trends. " +
    "Returns topics gaining momentum that haven't gone mainstream yet. " +
    "Use before writing briefings or Moltbook posts to stay ahead.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      focus: {
        type: "string",
        description: "Focus area: 'ai', 'tech', 'crypto', 'business', 'all' (default: 'all')",
      },
      limit: {
        type: "number",
        description: "Max trends to return (default: 5)",
      },
    },
  },
  async execute(args): Promise<string> {
    const focus = String(args.focus || "all");
    const limit = Number(args.limit || 5);
    const signals: TrendSignal[] = [];

    log.info(`[trend] Scanning for emerging trends (focus: ${focus})...`);

    // Source 1: HackerNews top stories
    try {
      const hnSkill = getSkill("hackernews.top");
      if (hnSkill) {
        const hnResult = await hnSkill.execute({ limit: 15 });
        const hnText = typeof hnResult === "string" ? hnResult : JSON.stringify(hnResult);
        // Parse HN titles and scores
        const lines = hnText.split("\n").filter(l => l.trim());
        for (const line of lines) {
          const scoreMatch = line.match(/(\d+)\s*(?:pts?|points?)/i);
          const score = scoreMatch ? parseInt(scoreMatch[1]) : 0;
          signals.push({ source: "HackerNews", title: line.slice(0, 200), score, url: "" });
        }
      }
    } catch (err) {
      log.warn(`[trend] HN scan failed: ${err}`);
    }

    // Source 2: Web search for trending topics
    try {
      const searchSkill = getSkill("web.search");
      if (searchSkill) {
        const queries = focus === "all"
          ? ["trending tech topics today 2026", "emerging AI trends February 2026"]
          : [`trending ${focus} topics today 2026`];

        for (const q of queries) {
          const searchResult = await searchSkill.execute({ query: q });
          const searchText = typeof searchResult === "string" ? searchResult : JSON.stringify(searchResult);
          const lines = searchText.split("\n").filter(l => l.trim() && l.length > 20);
          for (const line of lines.slice(0, 5)) {
            signals.push({ source: "WebSearch", title: line.slice(0, 200), score: 50 });
          }
        }
      }
    } catch (err) {
      log.warn(`[trend] Web search failed: ${err}`);
    }

    // Source 3: Moltbook feed
    try {
      const moltSkill = getSkill("moltbook.feed");
      if (moltSkill) {
        const moltResult = await moltSkill.execute({ sort: "hot", limit: 10 });
        const moltText = typeof moltResult === "string" ? moltResult : JSON.stringify(moltResult);
        const lines = moltText.split("\n").filter(l => l.trim() && l.length > 15);
        for (const line of lines.slice(0, 5)) {
          signals.push({ source: "Moltbook", title: line.slice(0, 200), score: 30 });
        }
      }
    } catch (err) {
      log.warn(`[trend] Moltbook scan failed: ${err}`);
    }

    if (signals.length === 0) {
      return "Aucun signal detecte. Sources possiblement down.";
    }

    // Use Claude to analyze and synthesize the signals into trends
    const signalsSummary = signals
      .map(s => `[${s.source}] ${s.title}`)
      .join("\n");

    const analysisPrompt =
      `Tu es Kingston, analyste de tendances. Voici les signaux bruts de HackerNews, Reddit, et Moltbook:\n\n` +
      `${signalsSummary}\n\n` +
      `MISSION: Identifie les ${limit} tendances EMERGENTES les plus interessantes.\n` +
      `Pour chaque tendance:\n` +
      `1. NOM COURT (3-5 mots)\n` +
      `2. POURQUOI c'est important (1 phrase)\n` +
      `3. PREDICTION: ou ca va dans 1 mois (1 phrase)\n` +
      `4. SCORE DE CONFIANCE: 1-10\n\n` +
      `Focus: ${focus}\n` +
      `Filtre: ignore les sujets deja mainstream (tout le monde en parle depuis des semaines).\n` +
      `Priorise: les sujets qui MONTENT mais que la majorite ne voit pas encore.`;

    const analysis = await askClaude(analysisPrompt);

    return `TREND SCAN (${focus}) — ${signals.length} signaux analyses\n\n${analysis}`;
  },
});

// ── trend.emerging — Quick check for a specific domain ──

registerSkill({
  name: "trend.emerging",
  description:
    "Quick trend check for a specific domain. Faster than trend.detect — " +
    "uses only HackerNews search for a focused topic.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Topic to check trends for (e.g. 'autonomous AI agents', 'quantum computing')",
      },
    },
    required: ["query"],
  },
  async execute(args): Promise<string> {
    const query = String(args.query);
    log.info(`[trend] Quick check: "${query}"`);

    const results: string[] = [];

    // HN search
    try {
      const hnSearch = getSkill("hackernews.search");
      if (hnSearch) {
        const hnResult = await hnSearch.execute({ query, limit: 5 });
        results.push(`HACKERNEWS:\n${typeof hnResult === "string" ? hnResult : JSON.stringify(hnResult)}`);
      }
    } catch (err) {
      results.push(`HN: erreur ${err}`);
    }

    // Web search for recent mentions
    try {
      const webSearch = getSkill("web.search");
      if (webSearch) {
        const webResult = await webSearch.execute({ query: `${query} trending 2026` });
        results.push(`WEB:\n${typeof webResult === "string" ? webResult : JSON.stringify(webResult)}`);
      }
    } catch (err) {
      results.push(`Web: erreur ${err}`);
    }

    return `TREND CHECK: "${query}"\n\n${results.join("\n\n")}`;
  },
});
