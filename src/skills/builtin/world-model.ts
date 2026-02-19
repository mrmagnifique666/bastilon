/**
 * Unified World Model — Kingston's coherent understanding of reality.
 *
 * Merges Knowledge Graph + Episodic Memory + Notes + Semantic Memory into
 * a single queryable world state. This is Kingston's "what do I know about
 * everything?" system.
 *
 * world.update   — Update a fact in the world model
 * world.query    — Search the world model
 * world.state    — Full snapshot of current world understanding
 * world.sync     — Sync world model from KG + episodic + notes (auto-enrichment)
 * world.reason   — Given a question, reason about it using world knowledge
 */
import { registerSkill } from "../loader.js";
import { log } from "../../utils/log.js";
import {
  worldSet, worldGet, worldQuery, worldSnapshot,
  getDb, logEpisodicEvent,
} from "../../storage/store.js";

registerSkill({
  name: "world.update",
  description: "Update Kingston's world model with a new fact. Domain: business, trading, personal, technical, social, environment.",
  argsSchema: {
    type: "object",
    properties: {
      domain: { type: "string", description: "Domain: business, trading, personal, technical, social, environment" },
      key: { type: "string", description: "The fact key (e.g. 'nicolas_mood', 'btc_trend', 'moltbook_status')" },
      value: { type: "string", description: "The fact value" },
      confidence: { type: "number", description: "How confident (0-1, default 0.8)" },
      source: { type: "string", description: "Where this info comes from" },
    },
    required: ["domain", "key", "value"],
  },
  async execute(args) {
    const domain = String(args.domain);
    const key = String(args.key);
    const value = String(args.value);
    const confidence = Number(args.confidence) || 0.8;
    const source = args.source ? String(args.source) : undefined;

    const existing = worldGet(domain, key);
    worldSet(domain, key, value, confidence, source);

    if (existing) {
      return `Monde mis a jour: [${domain}] ${key} = "${value}" (etait: "${existing.value}", conf: ${confidence})`;
    }
    return `Nouveau fait: [${domain}] ${key} = "${value}" (conf: ${confidence})`;
  },
});

registerSkill({
  name: "world.query",
  description: "Search Kingston's world model. Find everything Kingston knows about a topic.",
  argsSchema: {
    type: "object",
    properties: {
      domain: { type: "string", description: "Filter by domain (optional)" },
      search: { type: "string", description: "Search term in keys and values (optional)" },
    },
  },
  async execute(args) {
    const domain = args.domain ? String(args.domain) : undefined;
    const search = args.search ? String(args.search) : undefined;

    if (!domain && !search) {
      return "Specifiez un domain ou un terme de recherche. Utilisez world.state pour le snapshot complet.";
    }

    const results = worldQuery(domain, search);

    if (results.length === 0) {
      return `Rien trouve pour ${domain ? `domain="${domain}"` : ""} ${search ? `recherche="${search}"` : ""}. Le monde est encore a decouvrir.`;
    }

    let report = `**Monde: ${domain || "tous"}** ${search ? `(recherche: "${search}")` : ""}\n\n`;
    const byDomain: Record<string, any[]> = {};
    for (const r of results) {
      if (!byDomain[r.domain]) byDomain[r.domain] = [];
      byDomain[r.domain].push(r);
    }

    for (const [d, items] of Object.entries(byDomain)) {
      report += `**[${d}]**\n`;
      for (const item of items) {
        const age = Math.round((Date.now() / 1000 - item.updated_at) / 3600);
        const ageStr = age < 1 ? "< 1h" : age < 24 ? `${age}h` : `${Math.round(age / 24)}j`;
        report += `  ${item.key}: ${item.value} (conf:${(item.confidence * 100).toFixed(0)}%, ${ageStr})\n`;
      }
    }

    return report;
  },
});

registerSkill({
  name: "world.state",
  description: "Full snapshot of Kingston's world understanding — all domains, all facts.",
  argsSchema: { type: "object", properties: {} },
  async execute() {
    const snapshot = worldSnapshot();
    const domains = Object.keys(snapshot);

    if (domains.length === 0) {
      return "Le modele du monde est vide. Utilisez world.update ou world.sync pour le remplir.";
    }

    let report = `**Modele du Monde de Kingston** (${domains.length} domaines)\n\n`;
    for (const [domain, facts] of Object.entries(snapshot)) {
      const entries = Object.entries(facts);
      report += `**[${domain}]** (${entries.length} faits)\n`;
      for (const [key, value] of entries) {
        report += `  ${key}: ${String(value).slice(0, 100)}\n`;
      }
      report += "\n";
    }

    return report;
  },
});

registerSkill({
  name: "world.sync",
  description: "Auto-enrich the world model from Knowledge Graph, episodic memory, and agent data. Run periodically to keep the world model fresh.",
  argsSchema: {
    type: "object",
    properties: {
      hours: { type: "number", description: "Sync from last N hours (default 24)" },
    },
  },
  async execute(args) {
    const hours = Number(args.hours) || 24;
    const cutoff = Math.floor(Date.now() / 1000) - hours * 3600;
    const d = getDb();
    let synced = 0;

    // 1. Sync from KG entities (high-weight ones)
    try {
      const entities = d.prepare(
        "SELECT name, type, properties FROM kg_entities WHERE weight >= 0.5 ORDER BY weight DESC LIMIT 50"
      ).all() as any[];
      for (const e of entities) {
        const domain = e.type.includes("business") ? "business" :
          e.type.includes("trade") || e.type.includes("stock") ? "trading" :
          e.type.includes("person") || e.type.includes("contact") ? "social" :
          e.type.includes("tech") || e.type.includes("code") ? "technical" : "environment";
        worldSet(domain, `kg:${e.name}`, `[${e.type}] ${(e.properties || "").slice(0, 150)}`, 0.7, "kg_sync");
        synced++;
      }
    } catch { /* KG might not have data */ }

    // 2. Sync from recent episodic events (important ones)
    try {
      const events = d.prepare(
        "SELECT event_type, description, importance FROM episodic_events WHERE importance >= 0.6 AND created_at > ? ORDER BY created_at DESC LIMIT 30"
      ).all(cutoff) as any[];
      for (const e of events) {
        const domain = e.event_type.includes("trade") || e.event_type.includes("market") ? "trading" :
          e.event_type.includes("business") || e.event_type.includes("client") ? "business" :
          e.event_type.includes("dungeon") || e.event_type.includes("game") ? "personal" : "environment";
        worldSet(domain, `event:${e.event_type}:${e.description.slice(0, 30)}`, e.description.slice(0, 200), e.importance, "episodic_sync");
        synced++;
      }
    } catch { /* episodic might not have data */ }

    // 3. Sync agent states
    try {
      const agents = d.prepare(
        "SELECT agent_id, cycle, total_runs, last_error, consecutive_errors FROM agent_state"
      ).all() as any[];
      for (const a of agents) {
        const health = a.consecutive_errors > 2 ? "unhealthy" : a.consecutive_errors > 0 ? "degraded" : "healthy";
        worldSet("technical", `agent:${a.agent_id}`, `cycle:${a.cycle}, runs:${a.total_runs}, health:${health}${a.last_error ? ", err:" + a.last_error.slice(0, 50) : ""}`, 0.9, "agent_sync");
        synced++;
      }
    } catch { /* agent_state might not exist */ }

    // 4. Sync cron job statuses
    try {
      const crons = d.prepare(
        "SELECT id, name, enabled, last_run_at, retry_count FROM cron_jobs ORDER BY last_run_at DESC LIMIT 20"
      ).all() as any[];
      for (const c of crons) {
        const status = !c.enabled ? "disabled" : c.retry_count >= 3 ? "failing" : "active";
        worldSet("technical", `cron:${c.name || c.id}`, `status:${status}, retries:${c.retry_count}`, 0.9, "cron_sync");
        synced++;
      }
    } catch { /* no cron data */ }

    // 5. Sync performance metrics
    try {
      const recentEvals = d.prepare(
        "SELECT AVG(score) as avg, COUNT(*) as cnt FROM metacognition_evals WHERE created_at > ?"
      ).get(cutoff) as { avg: number | null; cnt: number };
      if (recentEvals.cnt > 0) {
        worldSet("performance", "recent_avg_score", String(Math.round(recentEvals.avg || 50)), 0.9, "meta_sync");
        worldSet("performance", "recent_eval_count", String(recentEvals.cnt), 0.9, "meta_sync");
        synced += 2;
      }
    } catch { /* no meta data */ }

    logEpisodicEvent("world_sync", `World model synced: ${synced} facts from KG+episodic+agents (${hours}h)`, {
      importance: 0.3,
      source: "world.sync",
    });

    return `**World Model Sync** (${hours}h): ${synced} faits synchronises depuis KG, memoire episodique, agents, et crons.`;
  },
});

registerSkill({
  name: "world.reason",
  description: "Reason about a question using everything in the world model. Kingston combines facts to derive new understanding.",
  argsSchema: {
    type: "object",
    properties: {
      question: { type: "string", description: "What to reason about" },
    },
    required: ["question"],
  },
  async execute(args) {
    const question = String(args.question);

    // Extract keywords from question
    const keywords = question.toLowerCase()
      .split(/\s+/)
      .filter(w => w.length > 3 && !["what", "when", "where", "comment", "pourquoi", "quand", "quel", "quelle", "dans", "pour", "avec", "est-ce"].includes(w));

    // Search world model for relevant facts
    const allFacts: any[] = [];
    for (const kw of keywords.slice(0, 5)) {
      const results = worldQuery(undefined, kw);
      allFacts.push(...results);
    }

    // Deduplicate
    const seen = new Set<number>();
    const uniqueFacts = allFacts.filter(f => { if (seen.has(f.id)) return false; seen.add(f.id); return true; });

    // Also check KG for entity relations
    const d = getDb();
    let kgRelations: any[] = [];
    try {
      for (const kw of keywords.slice(0, 3)) {
        const rels = d.prepare(
          `SELECT e1.name as from_name, r.relation_type, e2.name as to_name
           FROM kg_relations r
           JOIN kg_entities e1 ON r.from_entity_id = e1.id
           JOIN kg_entities e2 ON r.to_entity_id = e2.id
           WHERE e1.name LIKE ? OR e2.name LIKE ?
           LIMIT 10`
        ).all(`%${kw}%`, `%${kw}%`) as any[];
        kgRelations.push(...rels);
      }
    } catch { /* KG might not exist */ }

    if (uniqueFacts.length === 0 && kgRelations.length === 0) {
      return `Kingston ne sait rien de pertinent sur: "${question}"\n\nUtilisez world.sync pour enrichir le modele, ou world.update pour ajouter des faits manuellement.`;
    }

    let report = `**Raisonnement: "${question}"**\n\n`;
    report += `**Faits pertinents** (${uniqueFacts.length}):\n`;
    for (const f of uniqueFacts.slice(0, 10)) {
      report += `  [${f.domain}] ${f.key}: ${f.value.slice(0, 120)}\n`;
    }

    if (kgRelations.length > 0) {
      report += `\n**Relations connues** (${kgRelations.length}):\n`;
      for (const r of kgRelations.slice(0, 8)) {
        report += `  ${r.from_name} —[${r.relation_type}]→ ${r.to_name}\n`;
      }
    }

    // Synthesize
    const highConfFacts = uniqueFacts.filter(f => f.confidence >= 0.7);
    report += `\n**Synthese**: ${highConfFacts.length} faits a haute confiance sur ${uniqueFacts.length} total.`;
    if (highConfFacts.length >= 3) {
      report += " Kingston a suffisamment de donnees pour raisonner avec confiance.";
    } else {
      report += " Donnees insuffisantes pour un raisonnement fiable — collecter plus d'information.";
    }

    return report;
  },
});

log.info("[world-model] 5 world.* skills registered — Kingston has a unified understanding of reality");
