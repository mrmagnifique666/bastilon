/**
 * Built-in skills: leads.capture, leads.followup, leads.pipeline
 * Automated lead capture and follow-up pipeline.
 * Landing page → webhook → score → email → follow-up cron.
 */
import { registerSkill } from "../loader.js";
import { getDb, addTurn } from "../../storage/store.js";
import { config } from "../../config/env.js";
import { log } from "../../utils/log.js";

/** Ensure leads table exists */
function ensureLeadsTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      name TEXT,
      source TEXT DEFAULT 'landing_page',
      score INTEGER DEFAULT 0,
      status TEXT DEFAULT 'new',
      notes TEXT DEFAULT '',
      followup_count INTEGER DEFAULT 0,
      last_followup TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status, score DESC);
  `);
}

registerSkill({
  name: "leads.capture",
  description:
    "Capture a new lead (email + optional name). Scores the lead, stores it, and schedules follow-up. Use this when a prospect fills out a contact form or when Kingston discovers a potential client.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      email: { type: "string", description: "Lead's email address" },
      name: { type: "string", description: "Lead's name (optional)" },
      source: { type: "string", description: "Where the lead came from (landing_page, moltbook, telegram, referral)" },
      notes: { type: "string", description: "Initial context about the lead" },
    },
    required: ["email"],
  },
  async execute(args): Promise<string> {
    ensureLeadsTable();
    const email = (args.email as string).toLowerCase().trim();
    const name = (args.name as string) || "";
    const source = (args.source as string) || "landing_page";
    const notes = (args.notes as string) || "";

    // Validate email
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return `Error: Invalid email format: ${email}`;
    }

    const db = getDb();

    // Check for duplicate
    const existing = db.prepare("SELECT id, status FROM leads WHERE email = ?").get(email) as any;
    if (existing) {
      return `Lead déjà capturé (id #${existing.id}, status: ${existing.status}). Utilise leads.followup pour relancer.`;
    }

    // Score the lead (basic heuristic)
    let score = 50; // baseline
    if (source === "referral") score += 20;
    if (source === "landing_page") score += 10;
    if (notes.length > 50) score += 10; // engaged enough to leave context
    if (name) score += 5;

    // Insert
    const result = db
      .prepare(
        `INSERT INTO leads (email, name, source, score, notes, status)
         VALUES (?, ?, ?, ?, ?, 'new')`,
      )
      .run(email, name, source, score, notes);

    log.info(`[leads] Captured lead #${result.lastInsertRowid}: ${email} (score ${score}, source ${source})`);

    // Auto-send welcome email if Gmail is available
    let emailResult = "";
    try {
      const { getSkill } = await import("../loader.js");
      const gmailSkill = getSkill("gmail.send");
      if (gmailSkill && config.gmailUser) {
        const subject = name
          ? `${name}, merci pour votre intérêt`
          : "Merci pour votre intérêt";
        const body =
          `Bonjour${name ? " " + name : ""},\n\n` +
          `Merci d'avoir manifesté votre intérêt. Je suis Kingston, l'assistant AI de Nicolas.\n\n` +
          `Je vais revenir vers vous sous 24h avec plus de détails sur comment notre solution peut vous aider.\n\n` +
          `En attendant, n'hésitez pas à répondre à cet email avec vos questions.\n\n` +
          `Cordialement,\nKingston\nBastilon OS`;

        await gmailSkill.execute({
          to: email,
          subject,
          body,
        });
        emailResult = "\nEmail de bienvenue envoyé ✓";
      }
    } catch (err) {
      emailResult = `\n⚠️ Email de bienvenue échoué: ${err instanceof Error ? err.message : String(err)}`;
    }

    // Notify Nicolas
    try {
      const { getBotSendFn } = await import("./telegram.js");
      const send = getBotSendFn();
      if (send && config.adminChatId) {
        await send(
          config.adminChatId,
          `🎯 Nouveau lead capturé!\n\n` +
            `Email: ${email}\n` +
            `Nom: ${name || "—"}\n` +
            `Source: ${source}\n` +
            `Score: ${score}/100\n` +
            `Notes: ${notes || "—"}\n\n` +
            `Follow-up automatique dans 48h.`,
        );
      }
    } catch {
      // Notification failed — non-critical
    }

    return (
      `Lead capturé: ${email} (score ${score}/100)\n` +
      `Source: ${source} | Status: new${emailResult}\n` +
      `Follow-up automatique programmé.`
    );
  },
});

registerSkill({
  name: "leads.followup",
  description:
    "Send a follow-up email to a lead. Increments follow-up count and updates status. Kingston uses this to nurture leads autonomously.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      email: { type: "string", description: "Lead's email address" },
      message: { type: "string", description: "Custom follow-up message (optional — AI generates one if not provided)" },
    },
    required: ["email"],
  },
  async execute(args): Promise<string> {
    ensureLeadsTable();
    const email = (args.email as string).toLowerCase().trim();
    const customMessage = args.message as string | undefined;

    const db = getDb();
    const lead = db.prepare("SELECT * FROM leads WHERE email = ?").get(email) as any;
    if (!lead) return `Error: Lead not found: ${email}`;

    // Generate follow-up message if not provided
    let message = customMessage;
    if (!message) {
      const followupNum = (lead.followup_count || 0) + 1;
      if (followupNum === 1) {
        message =
          `Bonjour${lead.name ? " " + lead.name : ""},\n\n` +
          `Je reviens vers vous comme promis. Avez-vous eu le temps de réfléchir à comment l'IA pourrait vous aider dans votre activité?\n\n` +
          `Je serais ravi de planifier un appel de 15 minutes pour discuter de vos besoins spécifiques.\n\n` +
          `Cordialement,\nKingston`;
      } else if (followupNum === 2) {
        message =
          `Bonjour${lead.name ? " " + lead.name : ""},\n\n` +
          `Je voulais m'assurer que mon dernier email ne s'est pas perdu. Si vous avez des questions sur notre solution, n'hésitez pas.\n\n` +
          `Sinon, pas de souci — je ne vous enverrai plus de messages.\n\n` +
          `Bonne journée,\nKingston`;
      } else {
        // 3+ follow-ups — mark as cold and stop
        db.prepare("UPDATE leads SET status = 'cold', updated_at = datetime('now') WHERE email = ?").run(email);
        return `Lead ${email} marqué comme "cold" après ${followupNum} follow-ups sans réponse. Plus de relances.`;
      }
    }

    // Send via Gmail
    try {
      const { getSkill } = await import("../loader.js");
      const gmailSkill = getSkill("gmail.send");
      if (gmailSkill && config.gmailUser) {
        await gmailSkill.execute({
          to: email,
          subject: `Suivi — ${lead.name || "votre projet IA"}`,
          body: message,
        });
      } else {
        return "Error: Gmail not configured — cannot send follow-up";
      }
    } catch (err) {
      return `Error sending follow-up: ${err instanceof Error ? err.message : String(err)}`;
    }

    // Update lead
    db.prepare(
      `UPDATE leads SET
        followup_count = followup_count + 1,
        last_followup = datetime('now'),
        status = CASE WHEN status = 'new' THEN 'contacted' ELSE status END,
        updated_at = datetime('now')
       WHERE email = ?`,
    ).run(email);

    log.info(`[leads] Follow-up #${(lead.followup_count || 0) + 1} sent to ${email}`);
    return `Follow-up envoyé à ${email} (follow-up #${(lead.followup_count || 0) + 1})`;
  },
});

registerSkill({
  name: "leads.pipeline",
  description:
    "View the full lead pipeline: new, contacted, qualified, cold. Shows all leads with scores and follow-up status.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      status: { type: "string", description: "Filter by status: new, contacted, qualified, cold, all (default: all)" },
    },
  },
  async execute(args): Promise<string> {
    ensureLeadsTable();
    const statusFilter = (args.status as string) || "all";
    const db = getDb();

    let leads: any[];
    if (statusFilter === "all") {
      leads = db.prepare("SELECT * FROM leads ORDER BY score DESC, created_at DESC").all();
    } else {
      leads = db
        .prepare("SELECT * FROM leads WHERE status = ? ORDER BY score DESC")
        .all(statusFilter);
    }

    if (leads.length === 0) return "Pipeline vide — aucun lead capturé.";

    const statusEmoji: Record<string, string> = {
      new: "🆕",
      contacted: "📧",
      qualified: "⭐",
      cold: "❄️",
      converted: "💰",
    };

    const lines = leads.map((l: any) => {
      const emoji = statusEmoji[l.status] || "❓";
      const followups = l.followup_count ? ` (${l.followup_count} relances)` : "";
      return `${emoji} ${l.email}${l.name ? ` (${l.name})` : ""} — score ${l.score}, ${l.source}${followups}`;
    });

    // Summary
    const byStatus = leads.reduce((acc: Record<string, number>, l: any) => {
      acc[l.status] = (acc[l.status] || 0) + 1;
      return acc;
    }, {});
    const summary = Object.entries(byStatus)
      .map(([s, c]) => `${s}: ${c}`)
      .join(" | ");

    return `Lead Pipeline (${leads.length} total — ${summary})\n${"─".repeat(40)}\n${lines.join("\n")}`;
  },
});

registerSkill({
  name: "leads.qualify",
  description:
    "Mark a lead as qualified (ready for sales call). Updates status and notifies Nicolas.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      email: { type: "string", description: "Lead's email address" },
      notes: { type: "string", description: "Why this lead is qualified" },
    },
    required: ["email"],
  },
  async execute(args): Promise<string> {
    ensureLeadsTable();
    const email = (args.email as string).toLowerCase().trim();
    const notes = (args.notes as string) || "";

    const db = getDb();
    const lead = db.prepare("SELECT * FROM leads WHERE email = ?").get(email) as any;
    if (!lead) return `Error: Lead not found: ${email}`;

    db.prepare(
      `UPDATE leads SET status = 'qualified', score = MAX(score, 80),
       notes = notes || '\n[QUALIFIED] ' || ?, updated_at = datetime('now') WHERE email = ?`,
    ).run(notes, email);

    // Notify Nicolas
    try {
      const { getBotSendFn } = await import("./telegram.js");
      const send = getBotSendFn();
      if (send && config.adminChatId) {
        await send(
          config.adminChatId,
          `⭐ Lead qualifié!\n\n` +
            `Email: ${email}\n` +
            `Nom: ${lead.name || "—"}\n` +
            `Raison: ${notes || "Qualifié par Kingston"}\n\n` +
            `Action: Planifier un appel de découverte.`,
        );
      }
    } catch {
      // Non-critical
    }

    log.info(`[leads] Qualified: ${email}`);
    return `Lead ${email} qualifié ⭐. Nicolas notifié.`;
  },
});
