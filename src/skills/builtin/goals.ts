/**
 * Built-in skills: goals.set, goals.update, goals.review, goals.list, goals.milestones
 * Goal Decomposition — set revenue/business goals, auto-break into milestones, weekly review.
 * Inspired by OpenClaw "John Wick" pattern: high-level goal → quarterly milestones → weekly tracking.
 */
import { registerSkill } from "../loader.js";
import { getDb } from "../../storage/store.js";
import { config } from "../../config/env.js";
import { log } from "../../utils/log.js";

interface GoalRow {
  id: number;
  title: string;
  description: string | null;
  target_value: number | null;
  current_value: number;
  unit: string;
  deadline: string | null;
  milestones: string;
  status: string;
  category: string;
  created_at: number;
  updated_at: number;
}

interface Milestone {
  label: string;
  target: number;
  reached: boolean;
  reached_at?: string;
}

// --- Gemini helper for milestone generation ---

async function generateMilestones(
  title: string, target: number, unit: string, deadline: string | null
): Promise<Milestone[]> {
  if (!config.geminiApiKey) {
    // Manual fallback: 4 equal milestones
    const step = target / 4;
    return [
      { label: "25% — Premier quart", target: Math.round(step), reached: false },
      { label: "50% — Mi-parcours", target: Math.round(step * 2), reached: false },
      { label: "75% — Trois quarts", target: Math.round(step * 3), reached: false },
      { label: "100% — Objectif atteint", target, reached: false },
    ];
  }

  const prompt = `Generate 4-6 milestones for this business goal:
Goal: "${title}"
Target: ${target} ${unit}
${deadline ? `Deadline: ${deadline}` : "No specific deadline"}

Return a JSON array of milestones, each with:
- label: short description (French)
- target: numeric value to reach at this milestone

Example: [{"label":"Phase 1 — Validation","target":500},{"label":"Phase 2 — Croissance","target":2000}]

Only JSON array, no explanation.`;

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${config.geminiApiKey}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.5, maxOutputTokens: 1024 },
      }),
    });
    if (!res.ok) throw new Error(`Gemini ${res.status}`);
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const match = text.match(/\[[\s\S]*\]/);
    if (match) {
      const milestones = JSON.parse(match[0]) as Array<{ label: string; target: number }>;
      return milestones.map(m => ({ ...m, reached: false }));
    }
  } catch (err) {
    log.debug(`[goals] Gemini milestone generation failed: ${err}`);
  }

  // Fallback
  const step = target / 4;
  return [
    { label: "25%", target: Math.round(step), reached: false },
    { label: "50%", target: Math.round(step * 2), reached: false },
    { label: "75%", target: Math.round(step * 3), reached: false },
    { label: "100%", target, reached: false },
  ];
}

registerSkill({
  name: "goals.set",
  description: "Set a new business/personal goal with target value and optional deadline. Auto-generates milestones.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Goal title (e.g. '$20K MRR en 6 mois')" },
      description: { type: "string", description: "Detailed description" },
      target: { type: "number", description: "Target value (e.g. 20000)" },
      unit: { type: "string", description: "Unit (e.g. CAD, clients, posts) — default: units" },
      deadline: { type: "string", description: "Deadline YYYY-MM-DD (optional)" },
      category: { type: "string", description: "Category: business, revenue, growth, personal (default: business)" },
    },
    required: ["title", "target"],
  },
  async execute(args): Promise<string> {
    const title = String(args.title);
    const target = Number(args.target);
    const unit = String(args.unit || "units");
    const deadline = args.deadline ? String(args.deadline) : null;
    const category = String(args.category || "business");
    const description = args.description ? String(args.description) : null;

    const milestones = await generateMilestones(title, target, unit, deadline);
    const d = getDb();

    const info = d.prepare(
      `INSERT INTO goals (title, description, target_value, unit, deadline, milestones, category)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(title, description, target, unit, deadline, JSON.stringify(milestones), category);

    const lines = [
      `**Objectif #${info.lastInsertRowid} créé**`,
      `${title}`,
      `Cible: ${target} ${unit}${deadline ? ` — Échéance: ${deadline}` : ""}`,
      `Catégorie: ${category}`,
      `\n**Milestones (${milestones.length}):**`,
    ];
    for (const m of milestones) {
      lines.push(`  ⬜ ${m.label}: ${m.target} ${unit}`);
    }

    return lines.join("\n");
  },
});

registerSkill({
  name: "goals.update",
  description: "Update progress on a goal. Auto-checks milestone completion.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      id: { type: "number", description: "Goal ID" },
      value: { type: "number", description: "New current value" },
      add: { type: "number", description: "Add to current value (alternative to setting value)" },
      status: { type: "string", description: "New status: active, paused, completed, abandoned" },
    },
    required: ["id"],
  },
  async execute(args): Promise<string> {
    const d = getDb();
    const goal = d.prepare("SELECT * FROM goals WHERE id = ?").get(args.id as number) as GoalRow | undefined;
    if (!goal) return `Goal #${args.id} not found.`;

    let newValue = goal.current_value;
    if (args.value !== undefined) newValue = Number(args.value);
    else if (args.add !== undefined) newValue += Number(args.add);

    let milestones: Milestone[] = [];
    try { milestones = JSON.parse(goal.milestones); } catch { /* */ }

    // Check milestone completion
    const newlyReached: string[] = [];
    for (const m of milestones) {
      if (!m.reached && newValue >= m.target) {
        m.reached = true;
        m.reached_at = new Date().toISOString().slice(0, 10);
        newlyReached.push(m.label);
      }
    }

    const newStatus = args.status ? String(args.status) : (newValue >= (goal.target_value || Infinity) ? "completed" : goal.status);

    d.prepare(
      "UPDATE goals SET current_value = ?, milestones = ?, status = ?, updated_at = unixepoch() WHERE id = ?"
    ).run(newValue, JSON.stringify(milestones), newStatus, goal.id);

    const pct = goal.target_value ? Math.round((newValue / goal.target_value) * 100) : 0;
    const bar = "█".repeat(Math.round(pct / 5)) + "░".repeat(Math.max(0, 20 - Math.round(pct / 5)));

    let result = `**Goal #${goal.id}** — ${goal.title}\n${bar} ${pct}% (${newValue}/${goal.target_value} ${goal.unit})\nStatus: ${newStatus}`;

    if (newlyReached.length > 0) {
      result += `\n\n🎉 **Milestones atteints:** ${newlyReached.join(", ")}`;
    }

    return result;
  },
});

registerSkill({
  name: "goals.list",
  description: "List all goals with progress bars.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      status: { type: "string", description: "Filter: active, completed, paused, all (default: active)" },
    },
  },
  async execute(args): Promise<string> {
    const d = getDb();
    const status = String(args.status || "active");
    const query = status === "all"
      ? "SELECT * FROM goals ORDER BY updated_at DESC"
      : "SELECT * FROM goals WHERE status = ? ORDER BY updated_at DESC";
    const rows = (status === "all" ? d.prepare(query).all() : d.prepare(query).all(status)) as GoalRow[];

    if (rows.length === 0) return `Aucun objectif ${status === "all" ? "" : status}.`;

    return rows.map(g => {
      const pct = g.target_value ? Math.round((g.current_value / g.target_value) * 100) : 0;
      const bar = "█".repeat(Math.round(pct / 5)) + "░".repeat(Math.max(0, 20 - Math.round(pct / 5)));
      let milestones: Milestone[] = [];
      try { milestones = JSON.parse(g.milestones); } catch { /* */ }
      const reached = milestones.filter(m => m.reached).length;
      return (
        `**#${g.id} ${g.title}** [${g.status}] — ${g.category}\n` +
        `${bar} ${pct}% (${g.current_value}/${g.target_value} ${g.unit})\n` +
        `Milestones: ${reached}/${milestones.length}` +
        (g.deadline ? ` | Échéance: ${g.deadline}` : "")
      );
    }).join("\n\n");
  },
});

registerSkill({
  name: "goals.review",
  description: "Generate a weekly goal review: progress, blockers, next steps. Uses Gemini for analysis.",
  adminOnly: true,
  argsSchema: { type: "object", properties: {} },
  async execute(): Promise<string> {
    const d = getDb();
    const goals = d.prepare("SELECT * FROM goals WHERE status = 'active'").all() as GoalRow[];

    if (goals.length === 0) return "Aucun objectif actif. Utilise goals.set pour en créer un.";

    const summaries = goals.map(g => {
      const pct = g.target_value ? Math.round((g.current_value / g.target_value) * 100) : 0;
      let milestones: Milestone[] = [];
      try { milestones = JSON.parse(g.milestones); } catch { /* */ }
      const nextMilestone = milestones.find(m => !m.reached);
      const daysLeft = g.deadline
        ? Math.round((new Date(g.deadline).getTime() - Date.now()) / 86400000)
        : null;

      return {
        id: g.id,
        title: g.title,
        pct,
        current: g.current_value,
        target: g.target_value,
        unit: g.unit,
        nextMilestone: nextMilestone?.label || "Tous atteints",
        nextTarget: nextMilestone?.target,
        daysLeft,
        onTrack: daysLeft && g.target_value
          ? (g.current_value / g.target_value) >= ((Date.now() - g.created_at * 1000) / (new Date(g.deadline!).getTime() - g.created_at * 1000))
          : null,
      };
    });

    const lines = [`**Revue hebdomadaire des objectifs — ${new Date().toISOString().slice(0, 10)}**\n`];

    for (const s of summaries) {
      const icon = s.pct >= 100 ? "✅" : (s.onTrack === false ? "⚠️" : "🔵");
      const bar = "█".repeat(Math.round(s.pct / 5)) + "░".repeat(Math.max(0, 20 - Math.round(s.pct / 5)));
      lines.push(
        `${icon} **#${s.id} ${s.title}**`,
        `${bar} ${s.pct}% (${s.current}/${s.target} ${s.unit})`,
        `Prochain milestone: ${s.nextMilestone}${s.nextTarget ? ` (${s.nextTarget} ${s.unit})` : ""}`,
        s.daysLeft !== null ? `Jours restants: ${s.daysLeft}${s.onTrack === false ? " ⚠️ EN RETARD" : ""}` : "",
        "",
      );
    }

    return lines.filter(Boolean).join("\n");
  },
});

log.debug("Registered 4 goals.* skills");
