/**
 * Built-in skills: jobs.search, jobs.profile, jobs.list, jobs.daily
 * Job/Opportunity Scout — automated opportunity matching against a profile.
 * Inspired by OpenClaw: daily job search → match scoring → top 5 via Telegram.
 */
import { registerSkill, getSkill } from "../loader.js";
import { getDb, kgUpsertEntity, kgGetEntity } from "../../storage/store.js";
import { config } from "../../config/env.js";
import { log } from "../../utils/log.js";

const JOB_PROFILE_KEY = "job_search_profile";
const JOB_PROFILE_TYPE = "config";

interface JobProfile {
  title: string;
  skills: string[];
  preferred_type: string; // freelance, contract, full-time
  min_rate: number;
  currency: string;
  location: string;
  remote_ok: boolean;
  keywords: string[];
}

function getProfile(): JobProfile | null {
  const entity = kgGetEntity(JOB_PROFILE_KEY, JOB_PROFILE_TYPE);
  if (entity?.properties?.title) return entity.properties as unknown as JobProfile;
  return null;
}

registerSkill({
  name: "jobs.profile",
  description: "Set your job search profile: skills, preferred type, rate, location.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Job title (e.g. 'Full-Stack Developer')" },
      skills: { type: "string", description: "Comma-separated skills (e.g. 'TypeScript, React, Node.js')" },
      type: { type: "string", description: "Preferred: freelance, contract, full-time (default: freelance)" },
      min_rate: { type: "number", description: "Minimum hourly rate (default: 75)" },
      currency: { type: "string", description: "Currency (default: CAD)" },
      location: { type: "string", description: "Preferred location (default: Remote)" },
      keywords: { type: "string", description: "Extra search keywords (comma-separated)" },
    },
    required: ["title", "skills"],
  },
  async execute(args): Promise<string> {
    const profile: JobProfile = {
      title: String(args.title),
      skills: String(args.skills).split(",").map(s => s.trim()),
      preferred_type: String(args.type || "freelance"),
      min_rate: Number(args.min_rate) || 75,
      currency: String(args.currency || "CAD"),
      location: String(args.location || "Remote"),
      remote_ok: true,
      keywords: args.keywords ? String(args.keywords).split(",").map(s => s.trim()) : [],
    };

    kgUpsertEntity(JOB_PROFILE_KEY, JOB_PROFILE_TYPE, profile as any);

    return (
      `**Job Profile configuré:**\n` +
      `Titre: ${profile.title}\n` +
      `Skills: ${profile.skills.join(", ")}\n` +
      `Type: ${profile.preferred_type}\n` +
      `Taux minimum: ${profile.min_rate} ${profile.currency}/h\n` +
      `Location: ${profile.location}\n\n` +
      `Utilise jobs.search pour chercher des opportunités.`
    );
  },
});

registerSkill({
  name: "jobs.search",
  description: "Search for job opportunities matching your profile via web search. Scores and stores matches.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Custom search query (uses profile if omitted)" },
      limit: { type: "number", description: "Max results (default: 10)" },
    },
  },
  async execute(args): Promise<string> {
    const profile = getProfile();
    const webSearch = getSkill("web.search");
    if (!webSearch) return "web.search non disponible.";

    const customQuery = args.query ? String(args.query) : null;
    const limit = Number(args.limit) || 10;

    const searchQuery = customQuery || (profile
      ? `${profile.title} ${profile.preferred_type} ${profile.skills.slice(0, 3).join(" ")} ${profile.location} job`
      : "developer freelance remote job");

    try {
      const result = await webSearch.execute({ query: searchQuery });
      const resultText = String(result);

      if (!resultText || resultText.length < 50) return "Aucun résultat trouvé.";

      // Use Gemini to extract and score jobs
      if (!config.geminiApiKey) {
        return `**Résultats bruts:**\n${resultText.slice(0, 2000)}`;
      }

      const profileContext = profile
        ? `\nCandidate profile: ${profile.title}, skills: ${profile.skills.join(", ")}, rate: ${profile.min_rate} ${profile.currency}/h`
        : "";

      const prompt = `Extract job listings from these search results and score them for relevance.${profileContext}

Search results:
${resultText.slice(0, 4000)}

For each job found (max ${limit}), return:
- title: job title
- company: company name
- url: job URL (if found)
- match_score: 0-100 relevance score
- salary: salary info (if found)
- location: location

Return as JSON array: [{"title":"...","company":"...","url":"...","match_score":N,"salary":"...","location":"..."}]
Only JSON.`;

      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${config.geminiApiKey}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 2048 },
        }),
      });

      if (!res.ok) return `Erreur Gemini (${res.status})`;
      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
      const match = text.match(/\[[\s\S]*\]/);
      if (!match) return "Aucun emploi extrait des résultats.";

      const jobs = JSON.parse(match[0]) as Array<{
        title: string; company: string; url: string; match_score: number; salary: string; location: string;
      }>;

      // Store in DB
      const d = getDb();
      for (const job of jobs) {
        try {
          d.prepare(
            `INSERT OR IGNORE INTO job_opportunities (title, company, url, match_score, salary_range, location, source)
             VALUES (?, ?, ?, ?, ?, ?, 'search')`
          ).run(job.title, job.company || null, job.url || null, job.match_score, job.salary || null, job.location || null);
        } catch { /* dupe or error */ }
      }

      // Format
      const sorted = jobs.sort((a, b) => b.match_score - a.match_score);
      const lines = [`**${sorted.length} opportunité(s) trouvée(s):**\n`];
      for (const j of sorted) {
        const icon = j.match_score >= 70 ? "🟢" : j.match_score >= 40 ? "🟡" : "⚪";
        lines.push(
          `${icon} **${j.title}** @ ${j.company || "?"} (${j.match_score}%)`,
          `  ${j.location || "?"} | ${j.salary || "?"}`,
          j.url ? `  ${j.url}` : "",
          "",
        );
      }

      return lines.filter(Boolean).join("\n");
    } catch (err) {
      return `Erreur: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

registerSkill({
  name: "jobs.list",
  description: "List saved job opportunities, sorted by match score.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      status: { type: "string", description: "Filter: new, applied, interview, rejected (default: new)" },
      limit: { type: "number", description: "Max results (default: 15)" },
    },
  },
  async execute(args): Promise<string> {
    const status = String(args.status || "new");
    const limit = Number(args.limit) || 15;
    const d = getDb();

    const rows = d.prepare(
      "SELECT * FROM job_opportunities WHERE status = ? ORDER BY match_score DESC LIMIT ?"
    ).all(status, limit) as any[];

    if (rows.length === 0) return `Aucune opportunité [${status}].`;

    return rows.map(j => {
      const icon = j.match_score >= 70 ? "🟢" : j.match_score >= 40 ? "🟡" : "⚪";
      return (
        `${icon} **#${j.id} ${j.title}** @ ${j.company || "?"} — ${j.match_score}%\n` +
        `  ${j.location || "?"} | ${j.salary_range || "?"}\n` +
        (j.url ? `  ${j.url}` : "")
      );
    }).join("\n\n");
  },
});

log.debug("Registered 3 jobs.* skills");
