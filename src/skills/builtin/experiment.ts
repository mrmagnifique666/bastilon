/**
 * Built-in skills: experiment.create, experiment.run, experiment.results, experiment.winner
 * Simple A/B testing framework for Kingston.
 */
import { registerSkill } from "../loader.js";
import { getDb } from "../../storage/store.js";
import { log } from "../../utils/log.js";

function ensureTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS experiments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      variant_a TEXT NOT NULL,
      variant_b TEXT NOT NULL,
      metric TEXT NOT NULL,
      status TEXT DEFAULT 'active',
      created_at INTEGER NOT NULL,
      winner TEXT
    );
    CREATE TABLE IF NOT EXISTS experiment_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      experiment_id INTEGER NOT NULL,
      variant TEXT NOT NULL,
      value REAL NOT NULL,
      timestamp INTEGER NOT NULL,
      FOREIGN KEY (experiment_id) REFERENCES experiments(id)
    );
  `);
}

registerSkill({
  name: "experiment.create",
  description: "Create an A/B experiment to test two approaches.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Experiment name (e.g. 'email-subject-style')" },
      variantA: { type: "string", description: "Description of variant A" },
      variantB: { type: "string", description: "Description of variant B" },
      metric: { type: "string", description: "What metric to track (e.g. 'open_rate', 'engagement', 'response_time')" },
    },
    required: ["name", "variantA", "variantB", "metric"],
  },
  async execute(args): Promise<string> {
    ensureTable();
    const db = getDb();
    const info = db.prepare(
      "INSERT INTO experiments (name, variant_a, variant_b, metric, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(String(args.name), String(args.variantA), String(args.variantB), String(args.metric), Math.floor(Date.now() / 1000));
    return `Experiment #${info.lastInsertRowid} created: "${args.name}"\n  A: ${args.variantA}\n  B: ${args.variantB}\n  Metric: ${args.metric}`;
  },
});

registerSkill({
  name: "experiment.run",
  description: "Record a result for an experiment variant.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      experimentId: { type: "number", description: "Experiment ID" },
      variant: { type: "string", description: "Which variant: A or B" },
      value: { type: "number", description: "Metric value observed" },
    },
    required: ["experimentId", "variant", "value"],
  },
  async execute(args): Promise<string> {
    ensureTable();
    const db = getDb();
    const exp = db.prepare("SELECT * FROM experiments WHERE id = ?").get(Number(args.experimentId)) as any;
    if (!exp) return `Experiment #${args.experimentId} not found.`;
    if (exp.status !== "active") return `Experiment #${args.experimentId} is ${exp.status}.`;

    const variant = String(args.variant).toUpperCase();
    if (variant !== "A" && variant !== "B") return "Variant must be A or B.";

    db.prepare(
      "INSERT INTO experiment_results (experiment_id, variant, value, timestamp) VALUES (?, ?, ?, ?)"
    ).run(Number(args.experimentId), variant, Number(args.value), Math.floor(Date.now() / 1000));

    const count = (db.prepare(
      "SELECT COUNT(*) as c FROM experiment_results WHERE experiment_id = ? AND variant = ?"
    ).get(Number(args.experimentId), variant) as any).c;

    return `Recorded: Experiment #${args.experimentId}, variant ${variant} = ${args.value} (${count} samples total)`;
  },
});

registerSkill({
  name: "experiment.results",
  description: "Get current results of an experiment.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      experimentId: { type: "number", description: "Experiment ID" },
    },
    required: ["experimentId"],
  },
  async execute(args): Promise<string> {
    ensureTable();
    const db = getDb();
    const exp = db.prepare("SELECT * FROM experiments WHERE id = ?").get(Number(args.experimentId)) as any;
    if (!exp) return `Experiment #${args.experimentId} not found.`;

    const statsA = db.prepare(
      "SELECT COUNT(*) as n, AVG(value) as avg, MIN(value) as min, MAX(value) as max FROM experiment_results WHERE experiment_id = ? AND variant = 'A'"
    ).get(Number(args.experimentId)) as any;
    const statsB = db.prepare(
      "SELECT COUNT(*) as n, AVG(value) as avg, MIN(value) as min, MAX(value) as max FROM experiment_results WHERE experiment_id = ? AND variant = 'B'"
    ).get(Number(args.experimentId)) as any;

    const leading = statsA.avg > statsB.avg ? "A" : statsB.avg > statsA.avg ? "B" : "TIE";
    const diff = statsA.n > 0 && statsB.n > 0
      ? `${((Math.abs(statsA.avg - statsB.avg) / Math.max(statsA.avg, statsB.avg)) * 100).toFixed(1)}%`
      : "N/A";

    return [
      `**Experiment #${args.experimentId}: "${exp.name}"** (${exp.status})`,
      `Metric: ${exp.metric}`,
      ``,
      `**Variant A** — ${exp.variant_a}`,
      `  Samples: ${statsA.n} | Avg: ${statsA.avg?.toFixed(2) || "N/A"} | Range: ${statsA.min?.toFixed(2) || "?"}-${statsA.max?.toFixed(2) || "?"}`,
      ``,
      `**Variant B** — ${exp.variant_b}`,
      `  Samples: ${statsB.n} | Avg: ${statsB.avg?.toFixed(2) || "N/A"} | Range: ${statsB.min?.toFixed(2) || "?"}-${statsB.max?.toFixed(2) || "?"}`,
      ``,
      `Leading: **${leading}** (${diff} difference)`,
      `Min samples for significance: ~30 per variant`,
    ].join("\n");
  },
});

registerSkill({
  name: "experiment.winner",
  description: "Declare a winner and close an experiment.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      experimentId: { type: "number", description: "Experiment ID" },
      winner: { type: "string", description: "Winner: A or B" },
    },
    required: ["experimentId", "winner"],
  },
  async execute(args): Promise<string> {
    ensureTable();
    const db = getDb();
    const winner = String(args.winner).toUpperCase();
    if (winner !== "A" && winner !== "B") return "Winner must be A or B.";

    const exp = db.prepare("SELECT * FROM experiments WHERE id = ?").get(Number(args.experimentId)) as any;
    if (!exp) return `Experiment #${args.experimentId} not found.`;

    db.prepare("UPDATE experiments SET status = 'completed', winner = ? WHERE id = ?")
      .run(winner, Number(args.experimentId));

    const desc = winner === "A" ? exp.variant_a : exp.variant_b;
    return `Experiment #${args.experimentId} concluded. Winner: **Variant ${winner}** — ${desc}`;
  },
});

log.debug("Registered 4 experiment.* skills");
