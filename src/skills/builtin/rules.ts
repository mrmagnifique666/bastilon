/**
 * Built-in skills: rules.add, rules.list, rules.approve, rules.test
 * Self-Improving Rules Engine — Kingston learns behavioral rules.
 * Rules are proposed by agents and require Nicolas's approval before activation.
 */
import { registerSkill } from "../loader.js";
import {
  addRule,
  approveRule,
  getActiveRules,
  getAllRules,
  recordRuleOutcome,
  autoDisableFailingRules,
} from "../../storage/store.js";

registerSkill({
  name: "rules.add",
  description:
    "Propose a new behavioral rule. Rules need approval before activation. Categories: trading, communication, client, content, security, general.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      rule_name: { type: "string", description: "Unique rule name (e.g. 'trade-stop-loss-5pct')" },
      condition: { type: "string", description: "When this rule triggers (natural language)" },
      action: { type: "string", description: "What to do when triggered (natural language)" },
      category: { type: "string", description: "trading | communication | client | content | security | general" },
      priority: { type: "number", description: "Priority 1-100 (higher = more important, default 50)" },
    },
    required: ["rule_name", "condition", "action"],
  },
  async execute(args): Promise<string> {
    const ruleName = String(args.rule_name);
    const condition = String(args.condition);
    const action = String(args.action);
    const category = String(args.category || "general");
    const priority = Number(args.priority) || 50;

    const id = addRule(ruleName, condition, action, category, priority, "kingston");
    return (
      `Regle #${id} proposee: "${ruleName}"\n` +
      `  Quand: ${condition}\n` +
      `  Alors: ${action}\n` +
      `  Categorie: ${category} | Priorite: ${priority}\n` +
      `  Status: EN ATTENTE D'APPROBATION\n\n` +
      `Utilise rules.approve(id=${id}) pour activer.`
    );
  },
});

registerSkill({
  name: "rules.list",
  description: "List all behavioral rules (active, pending, disabled).",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      category: { type: "string", description: "Filter by category (optional)" },
      active_only: { type: "string", description: "'true' to show only active approved rules" },
    },
  },
  async execute(args): Promise<string> {
    const category = args.category ? String(args.category) : undefined;
    const activeOnly = String(args.active_only) === "true";

    const rules = activeOnly ? getActiveRules(category) : getAllRules();
    const filtered = category ? rules.filter((r) => r.category === category) : rules;

    if (filtered.length === 0) return "Aucune regle trouvee.";

    const lines = filtered.map((r) => {
      const status = !r.approved ? "⏳ EN ATTENTE" : r.enabled ? "✅ ACTIVE" : "❌ DESACTIVEE";
      const score = r.success_count + r.fail_count > 0
        ? ` | Score: ${r.success_count}/${r.success_count + r.fail_count}`
        : "";
      return (
        `**${r.rule_name}** (#${r.id}) — ${status}\n` +
        `  [${r.category}] Priorite: ${r.priority}${score}\n` +
        `  Quand: ${r.condition.slice(0, 80)}\n` +
        `  Alors: ${r.action.slice(0, 80)}`
      );
    });

    return `**${filtered.length} regle(s):**\n\n${lines.join("\n\n")}`;
  },
});

registerSkill({
  name: "rules.approve",
  description: "Approve a pending rule for activation. Only Nicolas can approve rules.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      id: { type: "number", description: "Rule ID to approve" },
    },
    required: ["id"],
  },
  async execute(args): Promise<string> {
    const id = Number(args.id);
    const ok = approveRule(id);
    return ok ? `Regle #${id} approuvee et activee.` : `Regle #${id} introuvable.`;
  },
});

registerSkill({
  name: "rules.test",
  description:
    "Record the outcome of a rule execution (success or failure). Auto-disables rules with >70% failure rate.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      id: { type: "number", description: "Rule ID" },
      success: { type: "string", description: "'true' or 'false'" },
    },
    required: ["id", "success"],
  },
  async execute(args): Promise<string> {
    const id = Number(args.id);
    const success = String(args.success) === "true";
    recordRuleOutcome(id, success);

    // Check for rules that should be auto-disabled
    const disabled = autoDisableFailingRules();
    const disabledMsg = disabled > 0 ? `\n${disabled} regle(s) auto-desactivee(s) (trop d'echecs).` : "";

    return `Resultat enregistre pour regle #${id}: ${success ? "succes" : "echec"}.${disabledMsg}`;
  },
});
