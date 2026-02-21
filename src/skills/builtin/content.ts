/**
 * Built-in skills: content.draft, content.list, content.schedule, content.publish, content.analytics,
 *                  content.calendar, content.weekly_synthesis
 * Content pipeline for multi-platform publishing.
 */
import { registerSkill } from "../loader.js";
import { getDb } from "../../storage/store.js";
import { log } from "../../utils/log.js";
import { embedText } from "../../memory/semantic.js";
import { cosineSimilarity } from "../../memory/semantic.js";

interface ContentRow {
  id: number;
  topic: string;
  platform: string;
  content_type: string;
  body: string | null;
  status: string;
  scheduled_at: number | null;
  published_at: number | null;
  performance: string | null;
  created_at: number;
  updated_at: number;
}

registerSkill({
  name: "content.draft",
  description:
    "Create a content draft for a specific platform. Stores it in the content pipeline for review.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      topic: { type: "string", description: "Content topic or title" },
      platform: {
        type: "string",
        description: "Target platform: linkedin, moltbook, twitter, blog, email, general (default: general)",
      },
      content_type: {
        type: "string",
        description: "Type: post, article, email, proposal (default: post)",
      },
      body: { type: "string", description: "The content body/text" },
    },
    required: ["topic", "body"],
  },
  async execute(args): Promise<string> {
    const topic = String(args.topic);
    const platform = String(args.platform || "general");
    const contentType = String(args.content_type || "post");
    const body = String(args.body);

    const d = getDb();
    const info = d
      .prepare(
        "INSERT INTO content_items (topic, platform, content_type, body, status) VALUES (?, ?, ?, ?, 'draft')",
      )
      .run(topic, platform, contentType, body);

    // Fire-and-forget: embed topic+body for dedup
    const rowId = info.lastInsertRowid as number;
    embedText(`${topic} ${body}`.slice(0, 2000)).then((emb) => {
      try {
        d.prepare("UPDATE content_items SET embedding = ? WHERE id = ?").run(JSON.stringify(emb), rowId);
      } catch (e) { log.debug(`[content.draft] Embed store failed: ${e}`); }
    }).catch((e) => log.debug(`[content.draft] Embed failed: ${e}`));

    return (
      `Content #${info.lastInsertRowid} created [draft]\n` +
      `Topic: ${topic}\n` +
      `Platform: ${platform} | Type: ${contentType}\n` +
      `Length: ${body.length} chars\n\n` +
      `Use content.schedule to plan publication.`
    );
  },
});

registerSkill({
  name: "content.list",
  description: "List content items, optionally filtered by status or platform.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      status: {
        type: "string",
        description: "Filter: draft, review, scheduled, published (default: all)",
      },
      platform: { type: "string", description: "Filter by platform" },
      limit: { type: "number", description: "Max results (default: 15)" },
    },
  },
  async execute(args): Promise<string> {
    const d = getDb();
    const limit = (args.limit as number) || 15;

    let query = "SELECT * FROM content_items WHERE 1=1";
    const params: unknown[] = [];

    if (args.status) {
      query += " AND status = ?";
      params.push(String(args.status));
    }
    if (args.platform) {
      query += " AND platform = ?";
      params.push(String(args.platform));
    }

    query += " ORDER BY updated_at DESC LIMIT ?";
    params.push(limit);

    const rows = d.prepare(query).all(...params) as ContentRow[];

    if (rows.length === 0) return "No content items found.";

    return rows
      .map((c) => {
        const scheduled = c.scheduled_at
          ? new Date(c.scheduled_at * 1000).toLocaleString("fr-CA", { timeZone: "America/Toronto" })
          : null;
        const preview = c.body ? c.body.slice(0, 80) + (c.body.length > 80 ? "..." : "") : "(empty)";
        return (
          `**#${c.id}** [${c.status}] ${c.topic}\n` +
          `  Platform: ${c.platform} | Type: ${c.content_type}\n` +
          (scheduled ? `  Programmé: ${scheduled}\n` : "") +
          `  ${preview}`
        );
      })
      .join("\n\n");
  },
});

registerSkill({
  name: "content.schedule",
  description:
    "Schedule a content item for publication at a specific date/time.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      id: { type: "number", description: "Content item ID" },
      datetime: {
        type: "string",
        description: "Publication date/time in ISO format (e.g. 2026-02-15T10:00:00)",
      },
      platform: {
        type: "string",
        description: "Override platform if needed",
      },
    },
    required: ["id", "datetime"],
  },
  async execute(args): Promise<string> {
    const contentId = args.id as number;
    const d = getDb();

    const row = d.prepare("SELECT * FROM content_items WHERE id = ?").get(contentId) as ContentRow | undefined;
    if (!row) return `Content #${contentId} not found.`;

    let scheduledAt: number;
    try {
      const raw = String(args.datetime).trim();
      // Try ISO format first
      let parsed = new Date(raw).getTime();
      // Fallback: if NaN, try to extract hour from natural language (e.g. "10h", "14h30")
      if (isNaN(parsed)) {
        const hourMatch = raw.match(/(\d{1,2})\s*[hH:]?\s*(\d{2})?/);
        if (hourMatch) {
          const now = new Date();
          const h = parseInt(hourMatch[1], 10);
          const m = hourMatch[2] ? parseInt(hourMatch[2], 10) : 0;
          // Use ET timezone (America/Toronto)
          const etDate = new Date(now.toLocaleString("en-US", { timeZone: "America/Toronto" }));
          etDate.setHours(h, m, 0, 0);
          // If the time is in the past today, schedule for tomorrow
          const nowET = new Date(now.toLocaleString("en-US", { timeZone: "America/Toronto" }));
          if (etDate <= nowET) etDate.setDate(etDate.getDate() + 1);
          parsed = etDate.getTime();
        }
      }
      // Final fallback: if still NaN, schedule for next available slot (2h from now, within 10h-20h ET)
      if (isNaN(parsed)) {
        const now = new Date();
        const etNow = new Date(now.toLocaleString("en-US", { timeZone: "America/Toronto" }));
        let target = new Date(etNow);
        target.setMinutes(0, 0, 0);
        target.setHours(target.getHours() + 2);
        if (target.getHours() < 10) target.setHours(10, 0, 0, 0);
        if (target.getHours() >= 20) {
          target.setDate(target.getDate() + 1);
          target.setHours(10, 0, 0, 0);
        }
        parsed = target.getTime();
      }
      scheduledAt = Math.floor(parsed / 1000);
      if (isNaN(scheduledAt)) throw new Error("Invalid date");
    } catch {
      return "Error: invalid datetime format. Use ISO format (e.g. 2026-02-15T10:00:00) or natural language (e.g. '14h', 'demain 10h').";
    }

    const updates: string[] = ["status = 'scheduled'", "scheduled_at = ?", "updated_at = unixepoch()"];
    const params: unknown[] = [scheduledAt];

    if (args.platform) {
      updates.push("platform = ?");
      params.push(String(args.platform));
    }

    params.push(contentId);
    d.prepare(`UPDATE content_items SET ${updates.join(", ")} WHERE id = ?`).run(...params);

    const dateStr = new Date(scheduledAt * 1000).toLocaleString("fr-CA", {
      timeZone: "America/Toronto",
    });

    return `Content #${contentId} scheduled for ${dateStr} on ${args.platform || row.platform}.`;
  },
});

registerSkill({
  name: "content.publish",
  description:
    "Mark a content item as published. Use after actually posting on the platform.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      id: { type: "number", description: "Content item ID" },
      url: { type: "string", description: "URL of the published content (optional)" },
    },
    required: ["id"],
  },
  async execute(args): Promise<string> {
    const contentId = args.id as number;
    const d = getDb();

    const row = d.prepare("SELECT * FROM content_items WHERE id = ?").get(contentId) as ContentRow | undefined;
    if (!row) return `Content #${contentId} not found.`;

    d.prepare(
      "UPDATE content_items SET status = 'published', published_at = unixepoch(), updated_at = unixepoch() WHERE id = ?",
    ).run(contentId);

    let result = `Content #${contentId} marked as published on ${row.platform}.`;
    if (args.url) result += `\nURL: ${args.url}`;
    return result;
  },
});

registerSkill({
  name: "content.analytics",
  description:
    "Content performance analytics: published items, platform distribution, scheduling stats.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      days: { type: "number", description: "Lookback period in days (default: 30)" },
    },
  },
  async execute(args): Promise<string> {
    const days = (args.days as number) || 30;
    const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
    const d = getDb();

    // Overall stats
    const total = d
      .prepare("SELECT COUNT(*) as c FROM content_items")
      .get() as { c: number };

    const byStatus = d
      .prepare("SELECT status, COUNT(*) as c FROM content_items GROUP BY status")
      .all() as Array<{ status: string; c: number }>;

    // Recent published
    const recentPublished = d
      .prepare(
        `SELECT platform, COUNT(*) as c FROM content_items
         WHERE status = 'published' AND published_at > ?
         GROUP BY platform ORDER BY c DESC`,
      )
      .all(cutoff) as Array<{ platform: string; c: number }>;

    // Upcoming scheduled
    const upcoming = d
      .prepare(
        `SELECT * FROM content_items WHERE status = 'scheduled' AND scheduled_at > ?
         ORDER BY scheduled_at ASC LIMIT 5`,
      )
      .all(Math.floor(Date.now() / 1000)) as ContentRow[];

    let output = `**Content Analytics — ${days} jours**\n\n`;
    output += `**Total:** ${total.c} items\n`;
    output += `**Par statut:** ${byStatus.map((s) => `${s.c} ${s.status}`).join(", ")}\n\n`;

    if (recentPublished.length > 0) {
      output += `**Publié (${days}j) par plateforme:**\n`;
      for (const p of recentPublished) {
        output += `  ${p.platform}: ${p.c} publication(s)\n`;
      }
      output += "\n";
    }

    if (upcoming.length > 0) {
      output += `**Prochaines publications:**\n`;
      for (const c of upcoming) {
        const date = c.scheduled_at
          ? new Date(c.scheduled_at * 1000).toLocaleString("fr-CA", { timeZone: "America/Toronto" })
          : "?";
        output += `  ${date} — ${c.topic} (${c.platform})\n`;
      }
    } else {
      output += "Aucune publication programmée.\n";
    }

    return output;
  },
});

// ── Content Calendar: 7-day schedule with pillar rotation ──

const PILLARS = [
  { name: "insights", weight: 0.30, label: "Insights & Thought Leadership" },
  { name: "behind-scenes", weight: 0.25, label: "Behind the Scenes" },
  { name: "educational", weight: 0.25, label: "Educational & How-To" },
  { name: "personal", weight: 0.15, label: "Personal & Story" },
  { name: "promo", weight: 0.05, label: "Promotion & CTA" },
];

const PLATFORMS = ["moltbook", "linkedin", "twitter"];
const DAYS_FR = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"];

registerSkill({
  name: "content.calendar",
  description:
    "Generate a 7-day content calendar with pillar rotation, platform assignment, and posting times. " +
    "Optionally auto-creates draft items in the content pipeline.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      start_date: {
        type: "string",
        description: "Start date in YYYY-MM-DD format (default: next Monday)",
      },
      create_drafts: {
        type: "boolean",
        description: "If true, creates draft content_items for each slot (default: false)",
      },
      posts_per_day: {
        type: "number",
        description: "Number of posts per day (default: 2)",
      },
    },
  },
  async execute(args): Promise<string> {
    const postsPerDay = (args.posts_per_day as number) || 2;
    const createDrafts = args.create_drafts === true;
    const d = getDb();

    // Determine start date (default: next Monday)
    let startDate: Date;
    if (args.start_date) {
      startDate = new Date(String(args.start_date) + "T00:00:00");
    } else {
      startDate = new Date();
      const dayOfWeek = startDate.getDay();
      const daysUntilMonday = dayOfWeek === 0 ? 1 : dayOfWeek === 1 ? 0 : 8 - dayOfWeek;
      startDate.setDate(startDate.getDate() + daysUntilMonday);
    }

    // Check current pillar balance (last 30 days)
    const cutoff30d = Math.floor(Date.now() / 1000) - 30 * 86400;
    let pillarCounts: Record<string, number> = {};
    try {
      const rows = d
        .prepare(
          `SELECT pillar, COUNT(*) as c FROM content_items
           WHERE pillar IS NOT NULL AND created_at > ?
           GROUP BY pillar`
        )
        .all(cutoff30d) as Array<{ pillar: string; c: number }>;
      for (const row of rows) pillarCounts[row.pillar] = row.c;
    } catch {
      // pillar column may not exist — that's fine
    }

    // Calculate which pillars need more content
    const totalPosts = Object.values(pillarCounts).reduce((s, n) => s + n, 0) || 1;
    const pillarNeed = PILLARS.map(p => ({
      ...p,
      current: (pillarCounts[p.name] || 0) / totalPosts,
      deficit: p.weight - ((pillarCounts[p.name] || 0) / totalPosts),
    })).sort((a, b) => b.deficit - a.deficit);

    // Build 7-day calendar
    const calendar: Array<{
      day: string;
      date: string;
      slots: Array<{ pillar: string; platform: string; time: string; topic: string }>;
    }> = [];

    const postingTimes = ["10:00", "14:00", "18:00"].slice(0, postsPerDay);
    let pillarIndex = 0;

    for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
      const date = new Date(startDate);
      date.setDate(startDate.getDate() + dayOffset);
      const dayName = DAYS_FR[date.getDay() === 0 ? 6 : date.getDay() - 1];
      const dateStr = date.toISOString().slice(0, 10);

      const slots: Array<{ pillar: string; platform: string; time: string; topic: string }> = [];

      for (let slotIdx = 0; slotIdx < postsPerDay; slotIdx++) {
        // Round-robin through pillars weighted by deficit
        const pillar = pillarNeed[pillarIndex % pillarNeed.length];
        const platform = PLATFORMS[(dayOffset + slotIdx) % PLATFORMS.length];
        const time = postingTimes[slotIdx] || "12:00";
        const topic = `[${pillar.label}] ${dayName} ${time} — ${platform}`;

        slots.push({ pillar: pillar.name, platform, time, topic });
        pillarIndex++;
      }

      calendar.push({ day: dayName, date: dateStr, slots });
    }

    // Optionally create drafts
    let draftsCreated = 0;
    if (createDrafts) {
      for (const day of calendar) {
        for (const slot of day.slots) {
          const scheduledAt = Math.floor(new Date(`${day.date}T${slot.time}:00`).getTime() / 1000);
          try {
            d.prepare(
              `INSERT INTO content_items (topic, platform, content_type, body, status, scheduled_at, pillar)
               VALUES (?, ?, 'post', '', 'draft', ?, ?)`
            ).run(slot.topic, slot.platform, scheduledAt, slot.pillar);
            draftsCreated++;
          } catch (err) {
            log.debug(`[content.calendar] Failed to create draft: ${err}`);
          }
        }
      }
    }

    // Build output
    let output = `**Calendrier de contenu — Semaine du ${calendar[0]?.date}**\n\n`;
    output += `**Rotation des piliers** (equilibrage basé sur les 30 derniers jours):\n`;
    for (const p of pillarNeed) {
      const bar = "█".repeat(Math.round(p.current * 20)) + "░".repeat(Math.max(0, Math.round(p.weight * 20) - Math.round(p.current * 20)));
      output += `  ${p.label}: ${(p.current * 100).toFixed(0)}% (cible: ${(p.weight * 100).toFixed(0)}%) ${bar}\n`;
    }
    output += "\n";

    for (const day of calendar) {
      output += `**${day.day} ${day.date}**\n`;
      for (const slot of day.slots) {
        output += `  ${slot.time} | ${slot.platform} | ${slot.pillar} — ${slot.topic}\n`;
      }
      output += "\n";
    }

    if (draftsCreated > 0) {
      output += `\n${draftsCreated} brouillons créés dans le pipeline. Utilise content.list pour les voir.`;
    } else {
      output += `Ajoute create_drafts=true pour créer les brouillons automatiquement.`;
    }

    return output;
  },
});

// ── Weekly Synthesis Report ──

registerSkill({
  name: "content.weekly_synthesis",
  description:
    "Generate a comprehensive weekly synthesis: content published, engagement metrics, " +
    "trading P&L, agent performance, pipeline status, and recommendations for next week.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      days: { type: "number", description: "Lookback period (default: 7)" },
    },
  },
  async execute(args): Promise<string> {
    const days = (args.days as number) || 7;
    const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
    const d = getDb();

    let output = `**Synthèse hebdomadaire — ${days} derniers jours**\n`;
    output += `Générée le ${new Date().toLocaleString("fr-CA", { timeZone: "America/Toronto" })}\n\n`;

    // 1. Content performance
    output += `## Contenu\n`;
    try {
      const published = d
        .prepare(`SELECT COUNT(*) as c FROM content_items WHERE status = 'published' AND published_at > ?`)
        .get(cutoff) as { c: number };
      const drafted = d
        .prepare(`SELECT COUNT(*) as c FROM content_items WHERE created_at > ?`)
        .get(cutoff) as { c: number };
      const byPlatform = d
        .prepare(
          `SELECT platform, COUNT(*) as c FROM content_items WHERE status = 'published' AND published_at > ? GROUP BY platform`
        ).all(cutoff) as Array<{ platform: string; c: number }>;
      output += `  Publié: ${published.c} | Brouillons créés: ${drafted.c}\n`;
      if (byPlatform.length > 0) {
        output += `  Par plateforme: ${byPlatform.map(p => `${p.platform} (${p.c})`).join(", ")}\n`;
      }
    } catch { output += `  (données non disponibles)\n`; }

    // 2. Agent performance
    output += `\n## Agents\n`;
    try {
      const agentStats = d
        .prepare(
          `SELECT agent_id, COUNT(*) as runs,
                  SUM(CASE WHEN outcome='success' THEN 1 ELSE 0 END) as ok,
                  SUM(CASE WHEN outcome='error' THEN 1 ELSE 0 END) as err
           FROM agent_runs WHERE started_at > ? GROUP BY agent_id ORDER BY runs DESC`
        ).all(cutoff) as Array<{ agent_id: string; runs: number; ok: number; err: number }>;
      for (const a of agentStats) {
        const rate = a.runs > 0 ? Math.round(a.ok / a.runs * 100) : 0;
        output += `  ${a.agent_id}: ${a.runs} runs (${rate}% succès, ${a.err} erreurs)\n`;
      }
    } catch { output += `  (données non disponibles)\n`; }

    // 3. Autonomous decisions
    output += `\n## Décisions autonomes\n`;
    try {
      const decisions = d
        .prepare(
          `SELECT category, COUNT(*) as c FROM autonomous_decisions WHERE created_at > ? GROUP BY category ORDER BY c DESC`
        ).all(cutoff) as Array<{ category: string; c: number }>;
      const total = decisions.reduce((s, d) => s + d.c, 0);
      output += `  Total: ${total} décisions\n`;
      for (const dec of decisions) {
        output += `  ${dec.category}: ${dec.c}\n`;
      }
    } catch { output += `  (données non disponibles)\n`; }

    // 4. Lead pipeline
    output += `\n## Pipeline clients\n`;
    try {
      const clients = d
        .prepare(`SELECT status, COUNT(*) as c FROM clients GROUP BY status ORDER BY c DESC`)
        .all() as Array<{ status: string; c: number }>;
      const total = clients.reduce((s, c) => s + c.c, 0);
      output += `  Total: ${total} contacts\n`;
      for (const c of clients) {
        output += `  ${c.status}: ${c.c}\n`;
      }
    } catch { output += `  (données non disponibles)\n`; }

    // 5. Revenue
    output += `\n## Revenus\n`;
    try {
      const income = d
        .prepare(`SELECT COALESCE(SUM(amount), 0) as t FROM revenue WHERE type = 'income' AND created_at > ?`)
        .get(cutoff) as { t: number };
      const expense = d
        .prepare(`SELECT COALESCE(SUM(amount), 0) as t FROM revenue WHERE type = 'expense' AND created_at > ?`)
        .get(cutoff) as { t: number };
      output += `  Revenus: $${income.t.toFixed(2)} | Dépenses: $${expense.t.toFixed(2)} | Net: $${(income.t - expense.t).toFixed(2)}\n`;
    } catch { output += `  (données non disponibles)\n`; }

    // 6. Token usage
    output += `\n## Utilisation tokens\n`;
    try {
      const tokens = d
        .prepare(
          `SELECT provider, SUM(requests) as req, SUM(input_tokens + output_tokens) as tok, SUM(estimated_cost_usd) as cost
           FROM token_usage WHERE date >= date('now', '-${days} days') GROUP BY provider ORDER BY tok DESC`
        ).all() as Array<{ provider: string; req: number; tok: number; cost: number }>;
      for (const t of tokens) {
        output += `  ${t.provider}: ${t.req} req, ${(t.tok || 0).toLocaleString()} tokens ($${(t.cost || 0).toFixed(4)})\n`;
      }
    } catch { output += `  (données non disponibles)\n`; }

    // 7. Memory growth
    output += `\n## Mémoire\n`;
    try {
      const mem = d.prepare(`SELECT COUNT(*) as c FROM memory_items`).get() as { c: number };
      const recent = d
        .prepare(`SELECT COUNT(*) as c FROM memory_items WHERE created_at > ?`)
        .get(cutoff) as { c: number };
      output += `  Total: ${mem.c} items (${recent.c} nouveaux cette semaine)\n`;
    } catch { output += `  (données non disponibles)\n`; }

    output += `\n---\n_Rapport auto-généré par Kingston._`;
    return output;
  },
});

// ── Semantic Dedupe Gate ──

function keywordOverlap(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  if (wordsA.size === 0 && wordsB.size === 0) return 0;
  let intersection = 0;
  for (const w of wordsA) { if (wordsB.has(w)) intersection++; }
  const union = new Set([...wordsA, ...wordsB]).size;
  return union > 0 ? intersection / union : 0;
}

registerSkill({
  name: "content.check_duplicate",
  description:
    "Check if a content topic is too similar to existing content. Uses hybrid semantic (70%) + keyword (30%) matching. Threshold: >40% = REJECT.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      topic: { type: "string", description: "Content topic to check" },
      body: { type: "string", description: "Content body (optional, improves accuracy)" },
      platform: { type: "string", description: "Filter by platform (optional)" },
    },
    required: ["topic"],
  },
  async execute(args): Promise<string> {
    const topic = String(args.topic);
    const body = args.body ? String(args.body) : "";
    const platform = args.platform ? String(args.platform) : undefined;
    const combined = `${topic} ${body}`.trim();

    const d = getDb();

    // Get existing content with embeddings
    let query = "SELECT id, topic, body, embedding, platform FROM content_items WHERE embedding IS NOT NULL";
    const params: unknown[] = [];
    if (platform) {
      query += " AND platform = ?";
      params.push(platform);
    }
    const existing = d.prepare(query).all(...params) as Array<{
      id: number; topic: string; body: string | null; embedding: string; platform: string;
    }>;

    if (existing.length === 0) {
      return "No existing content with embeddings to compare against. No duplicates.";
    }

    // Embed the candidate
    let candidateEmb: number[];
    try {
      candidateEmb = await embedText(combined.slice(0, 2000));
    } catch (err) {
      return `Erreur d'embedding: ${err instanceof Error ? err.message : String(err)}`;
    }

    // Find best match
    let bestScore = 0;
    let bestMatch: { id: number; topic: string; platform: string } | null = null;

    for (const row of existing) {
      let emb: number[];
      try { emb = JSON.parse(row.embedding); } catch { continue; }

      const semantic = cosineSimilarity(candidateEmb, emb);
      const keyword = keywordOverlap(combined, `${row.topic} ${row.body || ""}`);
      const hybrid = semantic * 0.7 + keyword * 0.3;

      if (hybrid > bestScore) {
        bestScore = hybrid;
        bestMatch = { id: row.id, topic: row.topic, platform: row.platform };
      }
    }

    const pct = Math.round(bestScore * 100);

    if (pct > 40 && bestMatch) {
      return (
        `🚫 **DUPLICATE DETECTED (${pct}%)**\n\n` +
        `Match: Content #${bestMatch.id} — "${bestMatch.topic}" (${bestMatch.platform})\n` +
        `Similarity: ${pct}% (seuil: 40%)\n\n` +
        `Recommandation: modifier l'angle ou choisir un sujet différent.`
      );
    }

    return `✅ No duplicates found. Best match: ${pct}% (seuil: 40%)${bestMatch ? ` — #${bestMatch.id} "${bestMatch.topic}"` : ""}`;
  },
});
