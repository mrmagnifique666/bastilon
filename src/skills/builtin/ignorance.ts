/**
 * Aveux d'Ignorance — Kingston's self-awareness about what he doesn't know.
 *
 * When Kingston encounters something he can't handle, instead of hallucinating
 * or failing silently, he explicitly admits it, logs WHY, and suggests HOW to fix it.
 *
 * Skills: learn.admit, learn.gaps, learn.resolve, learn.diagnose
 * Table: ignorance_log
 * File: relay/ignorance-log.md (human-readable, always up to date)
 */
import { registerSkill } from "../loader.js";
import { getDb } from "../../storage/store.js";
import { log } from "../../utils/log.js";
import fs from "node:fs";
import path from "node:path";

// ── DB Setup ──

function ensureTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS ignorance_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic TEXT NOT NULL,
      context TEXT NOT NULL,
      what_i_dont_know TEXT NOT NULL,
      why_it_matters TEXT,
      suggested_fix TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      severity TEXT NOT NULL DEFAULT 'medium',
      status TEXT NOT NULL DEFAULT 'open',
      attempts INTEGER NOT NULL DEFAULT 0,
      resolution TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      resolved_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_ignorance_status ON ignorance_log(status, severity);
    CREATE INDEX IF NOT EXISTS idx_ignorance_topic ON ignorance_log(topic);
  `);
}

// ── Types ──

interface IgnoranceEntry {
  id: number;
  topic: string;
  context: string;
  what_i_dont_know: string;
  why_it_matters: string | null;
  suggested_fix: string | null;
  source: string;
  severity: string;
  status: string;
  attempts: number;
  resolution: string | null;
  created_at: number;
  resolved_at: number | null;
}

// ── Core Helper (importable by agents/runners) ──

export function admitIgnorance(opts: {
  topic: string;
  context: string;
  whatIDontKnow: string;
  whyItMatters?: string;
  suggestedFix?: string;
  source?: string;
  severity?: "low" | "medium" | "high" | "critical";
}): number {
  ensureTable();
  const db = getDb();

  // Dedup: don't log identical topic+what combos within 1 hour
  const existing = db.prepare(
    `SELECT id FROM ignorance_log
     WHERE topic = ? AND what_i_dont_know = ? AND status = 'open'
     AND created_at > unixepoch() - 3600`
  ).get(opts.topic, opts.whatIDontKnow) as { id: number } | undefined;

  if (existing) {
    // Bump attempts counter
    db.prepare("UPDATE ignorance_log SET attempts = attempts + 1 WHERE id = ?").run(existing.id);
    return existing.id;
  }

  const result = db.prepare(
    `INSERT INTO ignorance_log (topic, context, what_i_dont_know, why_it_matters, suggested_fix, source, severity)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    opts.topic,
    opts.context,
    opts.whatIDontKnow,
    opts.whyItMatters || null,
    opts.suggestedFix || null,
    opts.source || "auto",
    opts.severity || "medium"
  );

  const id = Number(result.lastInsertRowid);
  log.info(`[ignorance] #${id} Admitted: "${opts.whatIDontKnow}" (topic: ${opts.topic}, severity: ${opts.severity || "medium"})`);

  // Update the human-readable log file
  updateIgnoranceFile();

  return id;
}

export function resolveIgnorance(id: number, resolution: string): boolean {
  ensureTable();
  const db = getDb();
  const info = db.prepare(
    `UPDATE ignorance_log SET status = 'resolved', resolution = ?, resolved_at = unixepoch() WHERE id = ? AND status = 'open'`
  ).run(resolution, id);
  if (info.changes > 0) {
    log.info(`[ignorance] #${id} Resolved: "${resolution}"`);
    updateIgnoranceFile();
    return true;
  }
  return false;
}

export function getOpenGaps(limit = 20): IgnoranceEntry[] {
  ensureTable();
  const db = getDb();
  return db.prepare(
    `SELECT * FROM ignorance_log WHERE status = 'open' ORDER BY
     CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
     attempts DESC, created_at DESC LIMIT ?`
  ).all(limit) as IgnoranceEntry[];
}

// ── Markdown Log File ──

function updateIgnoranceFile(): void {
  try {
    const db = getDb();
    const open = db.prepare(
      `SELECT * FROM ignorance_log WHERE status = 'open' ORDER BY
       CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
       created_at DESC LIMIT 50`
    ).all() as IgnoranceEntry[];

    const recentResolved = db.prepare(
      `SELECT * FROM ignorance_log WHERE status = 'resolved' ORDER BY resolved_at DESC LIMIT 10`
    ).all() as IgnoranceEntry[];

    let md = `# Kingston — Aveux d'Ignorance\n\n`;
    md += `> Ce fichier est auto-généré. ${open.length} lacunes ouvertes.\n`;
    md += `> Dernière mise à jour: ${new Date().toISOString()}\n\n`;

    if (open.length === 0) {
      md += `## Aucune lacune ouverte\n\nTout est sous contrôle.\n\n`;
    } else {
      // Group by severity
      const bySeverity: Record<string, IgnoranceEntry[]> = {};
      for (const e of open) {
        (bySeverity[e.severity] ??= []).push(e);
      }

      for (const sev of ["critical", "high", "medium", "low"]) {
        const entries = bySeverity[sev];
        if (!entries?.length) continue;
        const icon = sev === "critical" ? "🔴" : sev === "high" ? "🟠" : sev === "medium" ? "🟡" : "🟢";
        md += `## ${icon} ${sev.toUpperCase()} (${entries.length})\n\n`;

        for (const e of entries) {
          const date = new Date(e.created_at * 1000).toISOString().slice(0, 16);
          md += `### #${e.id} — ${e.topic}\n`;
          md += `- **Ce que je ne sais pas**: ${e.what_i_dont_know}\n`;
          md += `- **Contexte**: ${e.context}\n`;
          if (e.why_it_matters) md += `- **Pourquoi c'est important**: ${e.why_it_matters}\n`;
          if (e.suggested_fix) md += `- **Comment corriger**: ${e.suggested_fix}\n`;
          md += `- Source: ${e.source} | Tentatives: ${e.attempts} | ${date}\n\n`;
        }
      }
    }

    if (recentResolved.length) {
      md += `---\n\n## ✅ Récemment résolus\n\n`;
      for (const e of recentResolved) {
        md += `- ~~#${e.id} ${e.topic}~~: ${e.resolution || "résolu"}\n`;
      }
      md += `\n`;
    }

    const logPath = path.resolve(process.cwd(), "relay", "ignorance-log.md");
    fs.writeFileSync(logPath, md, "utf8");
  } catch (err) {
    log.debug(`[ignorance] Failed to update log file: ${err}`);
  }
}

// ── Auto-detection: scan a response for hedging/uncertainty ──

const UNCERTAINTY_PATTERNS = [
  /je ne (sais|connais) pas/i,
  /je ne suis pas (sûr|certain|sure|certaine)/i,
  /i don'?t know/i,
  /i'?m not sure/i,
  /impossible de (déterminer|savoir|trouver|vérifier)/i,
  /aucune (donnée|information|idée)/i,
  /je n'ai pas (accès|les données|d'information)/i,
  /je manque (de|d')/i,
  /probablement|peut-être|il se pourrait/i,
  /I cannot (verify|confirm|access|find)/i,
  /no data available/i,
  /unable to (determine|find|access)/i,
  /je ne (peux|saurais) pas (confirmer|vérifier)/i,
];

export function detectIgnoranceInResponse(response: string, context: string, source: string): number | null {
  const matched = UNCERTAINTY_PATTERNS.filter(p => p.test(response));
  if (matched.length === 0) return null;

  // Extract the relevant sentence containing the admission
  const sentences = response.split(/[.!?\n]+/).filter(s => s.trim().length > 10);
  const relevantSentences = sentences.filter(s => matched.some(p => p.test(s)));
  const admission = relevantSentences.slice(0, 2).join(". ").trim() || response.slice(0, 200);

  return admitIgnorance({
    topic: context.slice(0, 60),
    context: context.slice(0, 200),
    whatIDontKnow: admission.slice(0, 300),
    whyItMatters: "Détecté automatiquement dans une réponse — Kingston a exprimé de l'incertitude.",
    suggestedFix: "Vérifier manuellement, ajouter l'info dans les notes/KG, ou configurer un accès aux données manquantes.",
    source,
    severity: matched.length >= 3 ? "high" : matched.length >= 2 ? "medium" : "low",
  });
}

// ── Diagnose: analyze a failure and create a structured ignorance entry ──

export function diagnoseFailure(opts: {
  what_failed: string;
  error_message: string;
  context: string;
  source: string;
}): number {
  // Categorize the failure type
  let suggestedFix = "";
  let severity: "low" | "medium" | "high" | "critical" = "medium";
  const err = opts.error_message.toLowerCase();

  if (err.includes("api") || err.includes("401") || err.includes("403") || err.includes("key")) {
    suggestedFix = "Vérifier les clés API dans .env. Peut nécessiter une nouvelle clé ou un renouvellement.";
    severity = "high";
  } else if (err.includes("timeout") || err.includes("econnrefused") || err.includes("network")) {
    suggestedFix = "Problème réseau/service. Vérifier que le service est en ligne. Ajouter un retry ou un fallback.";
    severity = "medium";
  } else if (err.includes("not found") || err.includes("undefined") || err.includes("null")) {
    suggestedFix = "Donnée manquante. Vérifier que la ressource existe, corriger le chemin/requête.";
    severity = "medium";
  } else if (err.includes("parse") || err.includes("json") || err.includes("syntax")) {
    suggestedFix = "Erreur de format. Le LLM a probablement mal formaté sa réponse. Ajouter un fallback de parsing.";
    severity = "low";
  } else if (err.includes("permission") || err.includes("denied") || err.includes("blocked")) {
    suggestedFix = "Problème de permissions. Vérifier les allowlists, tool profiles, ou les droits filesystem.";
    severity = "high";
  } else if (err.includes("rate limit") || err.includes("429") || err.includes("quota")) {
    suggestedFix = "Rate limiting. Augmenter le délai entre les appels ou basculer vers un modèle alternatif.";
    severity = "medium";
  } else {
    suggestedFix = `Erreur non catégorisée. Analyser le message: "${opts.error_message.slice(0, 100)}". Chercher dans les logs.`;
  }

  return admitIgnorance({
    topic: opts.what_failed.slice(0, 60),
    context: opts.context.slice(0, 200),
    whatIDontKnow: `Échec: ${opts.what_failed}. Erreur: ${opts.error_message.slice(0, 200)}`,
    whyItMatters: `Fonctionnalité bloquée: ${opts.what_failed}`,
    suggestedFix,
    source: opts.source,
    severity,
  });
}

// ── Skills ──

registerSkill({
  name: "learn.admit",
  description: "Admit something Kingston doesn't know. Creates a tracked ignorance entry with suggested fix.",
  adminOnly: false,
  argsSchema: {
    type: "object",
    properties: {
      topic: { type: "string", description: "Topic area (e.g. 'trading', 'shadowrun-rules', 'moltbook-api')" },
      what: { type: "string", description: "What I don't know (e.g. 'How to calculate RSI divergence')" },
      why: { type: "string", description: "Why it matters (e.g. 'Needed for trading signals')" },
      fix: { type: "string", description: "How to learn/fix it (e.g. 'Research RSI divergence formula, add to trading module')" },
      severity: { type: "string", description: "Severity: low, medium, high, or critical" },
    },
    required: ["topic", "what"],
  },
  async execute(args): Promise<string> {
    const id = admitIgnorance({
      topic: String(args.topic),
      context: "Manual admission via learn.admit",
      whatIDontKnow: String(args.what),
      whyItMatters: args.why ? String(args.why) : undefined,
      suggestedFix: args.fix ? String(args.fix) : undefined,
      source: "kingston",
      severity: (args.severity as any) || "medium",
    });

    return `✋ Aveu d'ignorance #${id} enregistré.\n` +
      `Topic: ${args.topic}\n` +
      `Ce que je ne sais pas: ${args.what}\n` +
      (args.fix ? `Comment corriger: ${args.fix}\n` : "") +
      `\nLog mis à jour dans relay/ignorance-log.md`;
  },
});

registerSkill({
  name: "learn.gaps",
  description: "List Kingston's current knowledge gaps (open ignorance entries).",
  adminOnly: false,
  argsSchema: {
    type: "object",
    properties: {
      severity: { type: "string", description: "Filter by severity: low/medium/high/critical (optional)" },
      topic: { type: "string", description: "Filter by topic (optional)" },
      limit: { type: "number", description: "Max results (default 15)" },
    },
  },
  async execute(args): Promise<string> {
    ensureTable();
    const db = getDb();
    let query = "SELECT * FROM ignorance_log WHERE status = 'open'";
    const params: any[] = [];

    if (args.severity) {
      query += " AND severity = ?";
      params.push(String(args.severity));
    }
    if (args.topic) {
      query += " AND topic LIKE ?";
      params.push(`%${String(args.topic)}%`);
    }

    query += ` ORDER BY
      CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
      attempts DESC, created_at DESC LIMIT ?`;
    params.push(Number(args.limit) || 15);

    const gaps = db.prepare(query).all(...params) as IgnoranceEntry[];

    if (gaps.length === 0) return "Aucune lacune ouverte" + (args.topic ? ` pour le topic "${args.topic}"` : "") + ".";

    const icons: Record<string, string> = { critical: "🔴", high: "🟠", medium: "🟡", low: "🟢" };
    const lines = gaps.map(g => {
      const date = new Date(g.created_at * 1000).toLocaleDateString("fr-CA");
      return `${icons[g.severity] || "⚪"} #${g.id} [${g.topic}] ${g.what_i_dont_know.slice(0, 80)}${g.attempts > 0 ? ` (${g.attempts}x)` : ""} — ${date}${g.suggested_fix ? `\n   💡 ${g.suggested_fix.slice(0, 100)}` : ""}`;
    });

    return `📋 **${gaps.length} lacune(s) ouverte(s)**:\n\n${lines.join("\n\n")}`;
  },
});

registerSkill({
  name: "learn.resolve",
  description: "Mark a knowledge gap as resolved. Explain what was learned.",
  adminOnly: false,
  argsSchema: {
    type: "object",
    properties: {
      id: { type: "number", description: "Ignorance entry ID to resolve" },
      resolution: { type: "string", description: "What was learned / how it was fixed" },
    },
    required: ["id", "resolution"],
  },
  async execute(args): Promise<string> {
    const success = resolveIgnorance(Number(args.id), String(args.resolution));
    if (success) {
      return `✅ Lacune #${args.id} résolue: ${args.resolution}`;
    }
    return `❌ Lacune #${args.id} non trouvée ou déjà résolue.`;
  },
});

registerSkill({
  name: "learn.diagnose",
  description: "Analyze a failure/error and create a structured ignorance entry with diagnosis and suggested fix.",
  adminOnly: false,
  argsSchema: {
    type: "object",
    properties: {
      what_failed: { type: "string", description: "What failed (e.g. 'Trading signal generation')" },
      error: { type: "string", description: "The error message" },
      context: { type: "string", description: "What was happening when it failed" },
    },
    required: ["what_failed", "error"],
  },
  async execute(args): Promise<string> {
    const id = diagnoseFailure({
      what_failed: String(args.what_failed),
      error_message: String(args.error),
      context: args.context ? String(args.context) : String(args.what_failed),
      source: "kingston-diagnose",
    });

    ensureTable();
    const entry = getDb().prepare("SELECT * FROM ignorance_log WHERE id = ?").get(id) as IgnoranceEntry | undefined;
    if (!entry) return `Diagnostic enregistré #${id}`;

    return `🔍 **Diagnostic #${id}**\n` +
      `Problème: ${entry.what_i_dont_know.slice(0, 150)}\n` +
      `Sévérité: ${entry.severity}\n` +
      `💡 Suggestion: ${entry.suggested_fix || "Aucune"}\n` +
      `\nLog mis à jour dans relay/ignorance-log.md`;
  },
});

log.debug("Registered 4 learn.admit/gaps/resolve/diagnose skills (ignorance awareness)");
