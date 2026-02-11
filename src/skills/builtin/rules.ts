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
import { config } from "../../config/env.js";
import { log } from "../../utils/log.js";

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

// ── rules.merge — LLM-assisted behavior merge ─────────────────────────
registerSkill({
  name: "rules.merge",
  description:
    "Intelligently merge a new behavior instruction into the existing ruleset. " +
    "Uses Ollama/Groq to detect duplicates, resolve conflicts, and create clean rules. " +
    "Auto-approves the result. Example: 'reponds toujours en bullets' → creates/updates a communication rule.",
  argsSchema: {
    type: "object",
    properties: {
      instruction: {
        type: "string",
        description: "The new behavior instruction in natural language (e.g. 'always respond with a summary at the top')",
      },
      category: {
        type: "string",
        description: "Rule category (optional, auto-detected): trading | communication | client | content | security | general",
      },
    },
    required: ["instruction"],
  },
  async execute(args): Promise<string> {
    const instruction = String(args.instruction);
    const categoryHint = args.category ? String(args.category) : "";

    // Get current active rules
    const currentRules = getActiveRules();
    const rulesText = currentRules.length > 0
      ? currentRules.map(r => `- [${r.category}] "${r.rule_name}": WHEN ${r.condition} → THEN ${r.action}`).join("\n")
      : "(no active rules)";

    // Use Ollama to analyze and merge
    const mergePrompt = `You are a rule-merging system. Analyze the new instruction and existing rules.

EXISTING RULES:
${rulesText}

NEW INSTRUCTION: "${instruction}"
${categoryHint ? `CATEGORY HINT: ${categoryHint}` : ""}

Respond with EXACTLY one JSON object (no markdown):
{
  "action": "create" | "update" | "skip",
  "reason": "why this action",
  "rule_name": "short-kebab-case-name",
  "condition": "when this triggers",
  "rule_action": "what to do",
  "category": "trading|communication|client|content|security|general",
  "priority": 50,
  "conflicts_with": [list of rule_names that conflict, or empty],
  "replaces": "rule_name to replace, or null"
}

Rules:
- If the instruction duplicates an existing rule, action="skip"
- If it conflicts with an existing rule, action="update" and set replaces
- If it's genuinely new, action="create"
- Keep rule_name short and descriptive (kebab-case)
- Priority 1-100 (higher=more important)`;

    try {
      // Try Ollama first (free), then Groq, then Gemini
      let responseText = "";

      if (config.ollamaEnabled) {
        const ollamaRes = await fetch(`${config.ollamaUrl}/api/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: config.ollamaModel,
            prompt: mergePrompt,
            stream: false,
            options: { temperature: 0.1, num_predict: 512 },
          }),
          signal: AbortSignal.timeout(30000),
        });
        if (ollamaRes.ok) {
          const data = await ollamaRes.json();
          responseText = data.response || "";
        }
      }

      if (!responseText && config.groqApiKey) {
        const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${config.groqApiKey}`,
          },
          body: JSON.stringify({
            model: config.groqModel,
            messages: [{ role: "user", content: mergePrompt }],
            temperature: 0.1,
            max_tokens: 512,
          }),
          signal: AbortSignal.timeout(15000),
        });
        if (groqRes.ok) {
          const data = await groqRes.json();
          responseText = data.choices?.[0]?.message?.content || "";
        }
      }

      if (!responseText) {
        // Direct fallback: just create the rule without LLM analysis
        const id = addRule(
          instruction.slice(0, 40).replace(/\s+/g, "-").toLowerCase(),
          "always",
          instruction,
          categoryHint || "general",
          50,
          "merge",
        );
        approveRule(id);
        return `Regle #${id} creee directement (LLM indisponible): "${instruction}"`;
      }

      // Parse LLM response
      const jsonStr = responseText.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
      const result = JSON.parse(jsonStr);

      if (result.action === "skip") {
        return `Instruction ignoree: ${result.reason}`;
      }

      if (result.action === "update" && result.replaces) {
        // Find and disable the old rule
        const allRules = getAllRules();
        const oldRule = allRules.find(r => r.rule_name === result.replaces);
        if (oldRule) {
          const db = (await import("../../storage/store.js")).getDb();
          db.prepare("UPDATE behavioral_rules SET enabled = 0, updated_at = unixepoch() WHERE id = ?").run(oldRule.id);
          log.info(`[rules.merge] Disabled old rule #${oldRule.id} (${result.replaces})`);
        }
      }

      // Create the new/updated rule and auto-approve
      const id = addRule(
        result.rule_name || "merged-rule",
        result.condition || "always",
        result.rule_action || instruction,
        result.category || categoryHint || "general",
        result.priority || 50,
        "merge",
      );
      approveRule(id);

      const actionLabel = result.action === "update" ? "mise a jour" : "creee";
      const conflictMsg = result.conflicts_with?.length > 0
        ? `\nConflits resolus avec: ${result.conflicts_with.join(", ")}`
        : "";

      return (
        `Regle #${id} ${actionLabel} et activee: **${result.rule_name}**\n` +
        `  Quand: ${result.condition}\n` +
        `  Alors: ${result.rule_action}\n` +
        `  Categorie: ${result.category} | Priorite: ${result.priority}` +
        conflictMsg
      );
    } catch (err) {
      // Fallback: create directly
      const id = addRule(
        instruction.slice(0, 40).replace(/\s+/g, "-").toLowerCase(),
        "always",
        instruction,
        categoryHint || "general",
        50,
        "merge",
      );
      approveRule(id);
      return `Regle #${id} creee (fallback): "${instruction}"`;
    }
  },
});
