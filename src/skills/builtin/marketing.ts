/**
 * Marketing skills — hooks, pillars, context, quality scoring, language mining, commitment ladder.
 * Covers: marketing.hooks, marketing.pillars, marketing.context, marketing.score_comment,
 *         marketing.language, clients.stage
 */
import fs from "node:fs";
import path from "node:path";
import { registerSkill } from "../loader.js";
import { getDb, kgUpsertEntity, kgSearchEntities } from "../../storage/store.js";
import { log } from "../../utils/log.js";

// ═══════════════════════════════════════════════════════
// Hook Formula Library (KG-backed)
// ═══════════════════════════════════════════════════════

const HOOK_FORMULAS = [
  // Curiosity
  { name: "curiosity_wrong", category: "curiosity", template: "I was wrong about [X]. Here's what I learned.", example: "I was wrong about cold outreach. Here's what I learned." },
  { name: "curiosity_nobody", category: "curiosity", template: "Nobody talks about [X]. But it's the key to [Y].", example: "Nobody talks about retention. But it's the key to profitability." },
  { name: "curiosity_secret", category: "curiosity", template: "[X] doesn't want you to know this about [Y].", example: "Your competitors don't want you to know this about pricing." },
  { name: "curiosity_number", category: "curiosity", template: "[Number] [things] that changed how I think about [X].", example: "3 conversations that changed how I think about marketing." },
  // Story
  { name: "story_lost", category: "story", template: "I lost [X] because I didn't [Y]. Don't make the same mistake.", example: "I lost my biggest client because I didn't set boundaries." },
  { name: "story_from_to", category: "story", template: "From [bad state] to [good state] in [timeframe]. Here's exactly how.", example: "From 0 to 50 clients in 6 months. Here's exactly how." },
  { name: "story_worst", category: "story", template: "The worst [X] of my career taught me the best lesson.", example: "The worst pitch of my career taught me the best lesson." },
  { name: "story_quit", category: "story", template: "I almost quit [X]. Then [turning point].", example: "I almost quit freelancing. Then I changed one thing." },
  // Value
  { name: "value_stop", category: "value", template: "Stop [common mistake]. Do this instead:", example: "Stop sending generic proposals. Do this instead:" },
  { name: "value_framework", category: "value", template: "The [X] framework that [result]:", example: "The 3-email framework that converts 40% of leads:" },
  { name: "value_checklist", category: "value", template: "[X] checklist I wish I had when I started [Y]:", example: "The pricing checklist I wish I had when I started consulting:" },
  { name: "value_if_then", category: "value", template: "If you're [situation], try [specific action]. Here's why:", example: "If you're under 10 clients, try weekly content. Here's why:" },
  // Contrarian
  { name: "contrarian_unpopular", category: "contrarian", template: "Unpopular opinion: [bold take about X].", example: "Unpopular opinion: cold DMs work better than ads." },
  { name: "contrarian_myth", category: "contrarian", template: "[Common belief] is a myth. The truth about [X]:", example: "'Post daily' is a myth. The truth about content frequency:" },
  { name: "contrarian_overrated", category: "contrarian", template: "[Popular thing] is overrated. Here's what actually works:", example: "Networking events are overrated. Here's what actually works:" },
  { name: "contrarian_hot_take", category: "contrarian", template: "Hot take: [X] is dead. The future is [Y].", example: "Hot take: cold calling is dead. The future is warm DMs." },
  // Question
  { name: "question_why", category: "question", template: "Why do most [people] fail at [X]? (It's not what you think)", example: "Why do most freelancers fail at pricing? (It's not what you think)" },
  { name: "question_what_if", category: "question", template: "What if everything you know about [X] is wrong?", example: "What if everything you know about lead gen is wrong?" },
  { name: "question_how_much", category: "question", template: "How much [X] are you leaving on the table by not [Y]?", example: "How much revenue are you leaving on the table by not upselling?" },
  { name: "question_poll", category: "question", template: "Quick poll: [A] or [B]? (My answer might surprise you)", example: "Quick poll: quality or quantity in content? (My answer might surprise you)" },
];

// Seed hooks into KG on first load
function seedHookFormulas(): void {
  try {
    const db = getDb();
    const existing = db.prepare("SELECT COUNT(*) as c FROM kg_entities WHERE entity_type = 'hook_formula'").get() as { c: number };
    if (existing.c >= HOOK_FORMULAS.length) return;

    for (const hook of HOOK_FORMULAS) {
      kgUpsertEntity(hook.name, "hook_formula", {
        category: hook.category,
        template: hook.template,
        example: hook.example,
      });
    }
    log.info(`[marketing] Seeded ${HOOK_FORMULAS.length} hook formulas into KG`);
  } catch (err) {
    log.debug(`[marketing] Hook seed failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Seed on import
try { seedHookFormulas(); } catch (e) { log.debug(`[marketing] Hook seed on import: ${e}`); }

registerSkill({
  name: "marketing.hooks",
  description: "Browse or search hook formulas for social media posts. Categories: curiosity, story, value, contrarian, question.",
  argsSchema: {
    type: "object",
    properties: {
      category: { type: "string", description: "Filter by category: curiosity|story|value|contrarian|question" },
      random: { type: "boolean", description: "Get a random hook (default false)" },
    },
  },
  async execute(args) {
    const category = args.category as string | undefined;
    const random = args.random as boolean | undefined;

    let hooks = HOOK_FORMULAS;
    if (category) hooks = hooks.filter(h => h.category === category);

    if (random) {
      if (hooks.length === 0) return "No hooks found for this category.";
      const hook = hooks[Math.floor(Math.random() * hooks.length)];
      return `[${hook.category}] ${hook.template}\nExample: ${hook.example}`;
    }

    const grouped: Record<string, typeof HOOK_FORMULAS> = {};
    for (const h of hooks) {
      if (!grouped[h.category]) grouped[h.category] = [];
      grouped[h.category].push(h);
    }

    const lines: string[] = [];
    for (const [cat, items] of Object.entries(grouped)) {
      lines.push(`\n## ${cat.toUpperCase()} (${items.length})`);
      for (const h of items) {
        lines.push(`  ${h.template}`);
        lines.push(`    → ${h.example}`);
      }
    }
    return `Hook Formulas (${hooks.length} total):${lines.join("\n")}`;
  },
});

// ═══════════════════════════════════════════════════════
// Content Pillars System
// ═══════════════════════════════════════════════════════

const PILLARS = [
  { name: "insights", target_pct: 30, description: "Industry insights, trends, data" },
  { name: "behind_scenes", target_pct: 25, description: "Behind-the-scenes of building" },
  { name: "educational", target_pct: 25, description: "How-to, tutorials, tips" },
  { name: "personal", target_pct: 15, description: "Personal stories, lessons, values" },
  { name: "promo", target_pct: 5, description: "Promotional, offers, CTAs" },
];

registerSkill({
  name: "marketing.pillars",
  description: "View content pillar distribution and balance for Moltbook posts",
  argsSchema: {
    type: "object",
    properties: {
      days: { type: "number", description: "Look-back period in days (default 30)" },
    },
  },
  async execute(args) {
    const days = (args.days as number) || 30;
    const db = getDb();
    const cutoff = Math.floor(Date.now() / 1000) - days * 86400;

    const rows = db.prepare(
      `SELECT pillar, COUNT(*) as c FROM content_items
       WHERE platform = 'moltbook' AND created_at > ? AND pillar IS NOT NULL
       GROUP BY pillar`
    ).all(cutoff) as Array<{ pillar: string; c: number }>;

    const total = rows.reduce((s, r) => s + r.c, 0) || 1;
    const actual: Record<string, number> = {};
    for (const r of rows) actual[r.pillar] = r.c;

    const lines = PILLARS.map(p => {
      const count = actual[p.name] || 0;
      const pct = Math.round((count / total) * 100);
      const diff = pct - p.target_pct;
      const status = Math.abs(diff) <= 5 ? "OK" : diff > 0 ? "OVER" : "UNDER";
      return `  ${p.name}: ${count} posts (${pct}% vs ${p.target_pct}% target) [${status}] — ${p.description}`;
    });

    return `Content Pillars (last ${days} days, ${total} posts):\n${lines.join("\n")}`;
  },
});

registerSkill({
  name: "marketing.pillar_suggest",
  description: "Suggest which content pillar to use next based on balance",
  argsSchema: { type: "object", properties: {} },
  async execute() {
    const db = getDb();
    const cutoff = Math.floor(Date.now() / 1000) - 30 * 86400;

    const rows = db.prepare(
      `SELECT pillar, COUNT(*) as c FROM content_items
       WHERE platform = 'moltbook' AND created_at > ? AND pillar IS NOT NULL
       GROUP BY pillar`
    ).all(cutoff) as Array<{ pillar: string; c: number }>;

    const total = rows.reduce((s, r) => s + r.c, 0) || 1;
    const actual: Record<string, number> = {};
    for (const r of rows) actual[r.pillar] = r.c;

    // Find most underrepresented pillar
    let bestPillar = PILLARS[0];
    let bestGap = -Infinity;
    for (const p of PILLARS) {
      const pct = ((actual[p.name] || 0) / total) * 100;
      const gap = p.target_pct - pct;
      if (gap > bestGap) { bestGap = gap; bestPillar = p; }
    }

    return `Suggested pillar: **${bestPillar.name}** (${bestPillar.description})\nGap: ${bestGap.toFixed(0)}% below target.`;
  },
});

// ═══════════════════════════════════════════════════════
// Product Marketing Context
// ═══════════════════════════════════════════════════════

const MARKETING_CONTEXT_PATH = path.resolve("relay/MARKETING_CONTEXT.md");

const DEFAULT_MARKETING_CONTEXT = `# Kingston — Marketing Context

## Value Proposition
Kingston is an autonomous AI business assistant that manages prospection, trading, content creation, and business operations 24/7.

## Ideal Customer Profile (ICP)
- Solo entrepreneurs and small business owners
- Tech-savvy professionals who want AI automation
- People who value time over money

## Brand Voice
- Professional but approachable
- Technically competent, not jargon-heavy
- Bilingual (French/English), casual French preferred
- Confident, not arrogant

## Competitive Positioning
- Full autonomy (7 agents working 24/7)
- $0/month cost (local LLMs + free tiers)
- Privacy-first (all data stays local)
- Not just a chatbot — a full business OS

## Key Messages
1. "Your AI business partner, not just a chatbot"
2. "7 agents working while you sleep"
3. "Enterprise AI at $0/month"
`;

registerSkill({
  name: "marketing.context",
  description: "View or update the marketing context document (value proposition, ICP, brand voice)",
  argsSchema: {
    type: "object",
    properties: {
      action: { type: "string", description: "view or update (default: view)" },
      content: { type: "string", description: "New content (only for update)" },
    },
  },
  async execute(args) {
    const action = (args.action as string) || "view";

    if (action === "update" && args.content) {
      fs.mkdirSync(path.dirname(MARKETING_CONTEXT_PATH), { recursive: true });
      fs.writeFileSync(MARKETING_CONTEXT_PATH, args.content as string);
      return "Marketing context updated.";
    }

    // View
    if (fs.existsSync(MARKETING_CONTEXT_PATH)) {
      return fs.readFileSync(MARKETING_CONTEXT_PATH, "utf-8");
    }
    // Create default
    fs.mkdirSync(path.dirname(MARKETING_CONTEXT_PATH), { recursive: true });
    fs.writeFileSync(MARKETING_CONTEXT_PATH, DEFAULT_MARKETING_CONTEXT);
    return DEFAULT_MARKETING_CONTEXT;
  },
});

// ═══════════════════════════════════════════════════════
// Engagement Quality Scoring
// ═══════════════════════════════════════════════════════

registerSkill({
  name: "marketing.score_comment",
  description: "Score a social media comment's quality before posting (0-100). Checks: substance, insight, relevance.",
  argsSchema: {
    type: "object",
    properties: {
      comment: { type: "string", description: "The comment text to score" },
      context: { type: "string", description: "The original post being commented on (optional)" },
    },
    required: ["comment"],
  },
  async execute(args) {
    const comment = args.comment as string;
    let score = 0;
    const feedback: string[] = [];

    // Length check (>20 words = substantive)
    const wordCount = comment.split(/\s+/).length;
    if (wordCount >= 30) { score += 25; feedback.push("Good length"); }
    else if (wordCount >= 20) { score += 15; feedback.push("Adequate length"); }
    else if (wordCount >= 10) { score += 5; feedback.push("Short — could add more"); }
    else { feedback.push("Too short — generic feel"); }

    // Question (asks thoughtful follow-up)
    if (/\?/.test(comment)) { score += 15; feedback.push("Asks a question"); }

    // Personal experience (shares related experience)
    if (/\b(j'ai|I've|I had|dans mon|in my|personnellement|from my experience)\b/i.test(comment)) {
      score += 20; feedback.push("Shares personal experience");
    }

    // New insight (adds value)
    if (/\b(d'ailleurs|en plus|also|additionally|un point important|key point|overlooked)\b/i.test(comment)) {
      score += 15; feedback.push("Adds new insight");
    }

    // Specific examples or data
    if (/\d+%|\d+ (clients|users|people|personnes|jours|days)|\$\d+/i.test(comment)) {
      score += 15; feedback.push("Includes specifics/data");
    }

    // Not generic (avoid "Great post!", "Totally agree", etc.)
    if (/^(great|super|totally|absolutely|love this|bien dit|exactement|100%)/i.test(comment.trim())) {
      score -= 20; feedback.push("Starts generic — rephrase");
    }

    // Emoji spam
    const emojiCount = (comment.match(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}]/gu) || []).length;
    if (emojiCount > 3) { score -= 10; feedback.push("Too many emojis"); }

    score = Math.max(0, Math.min(100, score));
    const quality = score >= 70 ? "HIGH" : score >= 40 ? "MEDIUM" : "LOW";

    return `Quality: ${quality} (${score}/100)\n${feedback.map(f => `  - ${f}`).join("\n")}${score < 40 ? "\n\nRecommendation: Rewrite with more substance, personal experience, or a question." : ""}`;
  },
});

// ═══════════════════════════════════════════════════════
// Customer Language Mining
// ═══════════════════════════════════════════════════════

registerSkill({
  name: "marketing.language",
  description: "Search or add customer language phrases (pain points, desires, objections) from prospect conversations",
  argsSchema: {
    type: "object",
    properties: {
      action: { type: "string", description: "search, add, or list (default: list)" },
      phrase: { type: "string", description: "Phrase to add (for action=add)" },
      category: { type: "string", description: "pain_point, desire, or objection" },
      query: { type: "string", description: "Search query (for action=search)" },
    },
  },
  async execute(args) {
    const action = (args.action as string) || "list";

    if (action === "add") {
      const phrase = args.phrase as string;
      const category = (args.category as string) || "pain_point";
      if (!phrase) return "Error: phrase required";
      kgUpsertEntity(phrase, "customer_language", { category, added_at: Date.now() });
      return `Added customer language [${category}]: "${phrase}"`;
    }

    if (action === "search") {
      const query = args.query as string;
      if (!query) return "Error: query required";
      const results = kgSearchEntities(query, 20)
        .filter(e => e.entity_type === "customer_language");
      if (results.length === 0) return "No matching customer language found.";
      return results.map(r => {
        const cat = (r.properties as any).category || "unknown";
        return `[${cat}] "${r.name}"`;
      }).join("\n");
    }

    // List all
    const db = getDb();
    const rows = db.prepare(
      "SELECT name, properties FROM kg_entities WHERE entity_type = 'customer_language' ORDER BY created_at DESC LIMIT 50"
    ).all() as Array<{ name: string; properties: string }>;

    if (rows.length === 0) return "No customer language stored yet. Use marketing.language with action=add to start collecting.";

    const grouped: Record<string, string[]> = {};
    for (const r of rows) {
      let cat = "unknown";
      try { cat = (JSON.parse(r.properties) as any).category || "unknown"; } catch (e) { log.debug(`[marketing] Failed to parse language properties: ${e}`); }
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(r.name);
    }

    const lines: string[] = [];
    for (const [cat, phrases] of Object.entries(grouped)) {
      lines.push(`\n## ${cat.toUpperCase()} (${phrases.length})`);
      for (const p of phrases) lines.push(`  - "${p}"`);
    }
    return `Customer Language (${rows.length} phrases):${lines.join("\n")}`;
  },
});

// ═══════════════════════════════════════════════════════
// Commitment Ladder Tracking
// ═══════════════════════════════════════════════════════

const COMMITMENT_STAGES = ["cold", "aware", "engaged", "interested", "qualified", "customer", "advocate"];

registerSkill({
  name: "clients.stage",
  description: "View or update a client's commitment stage (cold → aware → engaged → interested → qualified → customer → advocate)",
  argsSchema: {
    type: "object",
    properties: {
      client_id: { type: "number", description: "Client ID" },
      stage: { type: "string", description: "New stage (to update)" },
      list: { type: "boolean", description: "List all clients by stage" },
    },
  },
  async execute(args) {
    const db = getDb();

    if (args.list) {
      const rows = db.prepare(
        "SELECT id, name, commitment_stage, last_contact_at FROM clients ORDER BY commitment_stage, name"
      ).all() as Array<{ id: number; name: string; commitment_stage: string; last_contact_at: number | null }>;

      if (rows.length === 0) return "No clients found.";

      const grouped: Record<string, typeof rows> = {};
      for (const r of rows) {
        const stage = r.commitment_stage || "cold";
        if (!grouped[stage]) grouped[stage] = [];
        grouped[stage].push(r);
      }

      const lines: string[] = [];
      for (const stage of COMMITMENT_STAGES) {
        const clients = grouped[stage] || [];
        if (clients.length === 0) continue;
        lines.push(`\n## ${stage.toUpperCase()} (${clients.length})`);
        for (const c of clients) {
          const lastContact = c.last_contact_at ? new Date(c.last_contact_at * 1000).toLocaleDateString("fr-CA") : "jamais";
          lines.push(`  #${c.id} ${c.name} — last contact: ${lastContact}`);
        }
      }
      return `Commitment Ladder:${lines.join("\n")}`;
    }

    if (args.client_id && args.stage) {
      const stage = args.stage as string;
      if (!COMMITMENT_STAGES.includes(stage)) {
        return `Invalid stage. Valid: ${COMMITMENT_STAGES.join(", ")}`;
      }
      const info = db.prepare(
        "UPDATE clients SET commitment_stage = ?, updated_at = unixepoch() WHERE id = ?"
      ).run(stage, args.client_id);
      return info.changes > 0
        ? `Client #${args.client_id} moved to stage: ${stage}`
        : `Client #${args.client_id} not found.`;
    }

    return `Usage: clients.stage with list=true to see all, or client_id + stage to update.\nStages: ${COMMITMENT_STAGES.join(" → ")}`;
  },
});
