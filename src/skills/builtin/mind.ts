/**
 * Built-in skills: mind.decide, mind.propose, mind.pending, mind.ask, mind.status
 * Kingston Mind — tiered autonomous decision-making with veto capability.
 *
 * Confidence tiers:
 *   HIGH (default): Auto-execute, log, brief notification to Nicolas
 *   MEDIUM: Log as pending_veto, send Telegram with ✅/❌ buttons, auto-approve after 60s
 *   LOW: Route to mind.ask — ask Nicolas before acting
 */
import { registerSkill } from "../loader.js";
import {
  logDecision,
  getRecentDecisions,
  getPendingQuestions,
  updateDecisionStatus,
  setDecisionTelegramMsg,
  getPendingVetoDecisions,
  getApprovedDecisions,
  getDecisionById,
} from "../../storage/store.js";
import { getBotSendFn, getBotSendWithKeyboardFn } from "./telegram.js";
import { config } from "../../config/env.js";
import { log } from "../../utils/log.js";

// --- Veto Timer Management ---

const vetoTimers = new Map<number, ReturnType<typeof setTimeout>>();

/** Start a 60s auto-approve timer for a pending_veto decision. */
function startVetoTimer(decisionId: number): void {
  // Clear any existing timer
  const existing = vetoTimers.get(decisionId);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    vetoTimers.delete(decisionId);
    const decision = getDecisionById(decisionId);
    if (decision && decision.status === "pending_veto") {
      updateDecisionStatus(decisionId, "auto_approved", "Auto-approved after 60s veto window");
      log.info(`[mind] Decision #${decisionId} auto-approved (no veto within 60s)`);

      // Notify Nicolas that it went through
      const send = getBotSendFn();
      if (send && config.adminChatId) {
        send(config.adminChatId, `✅ Décision #${decisionId} auto-approuvée (pas de veto en 60s):\n${decision.action.slice(0, 100)}`).catch(() => {});
      }
    }
  }, 60_000);

  vetoTimers.set(decisionId, timer);
}

/** Handle a veto/approve callback from Telegram inline keyboard. */
export function handleVetoCallback(decisionId: number, approved: boolean): string {
  const timer = vetoTimers.get(decisionId);
  if (timer) {
    clearTimeout(timer);
    vetoTimers.delete(decisionId);
  }

  const decision = getDecisionById(decisionId);
  if (!decision) return `Décision #${decisionId} introuvable.`;
  if (decision.status !== "pending_veto") return `Décision #${decisionId} n'est plus en attente (status: ${decision.status}).`;

  if (approved) {
    updateDecisionStatus(decisionId, "approved", "Approved by Nicolas");
    log.info(`[mind] Decision #${decisionId} APPROVED by Nicolas`);
    return `✅ Décision #${decisionId} approuvée par Nicolas.`;
  } else {
    updateDecisionStatus(decisionId, "vetoed", "Vetoed by Nicolas");
    log.info(`[mind] Decision #${decisionId} VETOED by Nicolas`);
    return `❌ Décision #${decisionId} VETOED par Nicolas.`;
  }
}

// --- Skills ---

registerSkill({
  name: "mind.decide",
  description:
    "Log an autonomous decision. confidence=high (default, auto-execute), medium (60s veto window), low (asks Nicolas). Categories: trading, merch, client, content, strategy.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      category: {
        type: "string",
        description: "trading | merch | client | content | strategy",
      },
      action: {
        type: "string",
        description: "What was decided/done",
      },
      reasoning: {
        type: "string",
        description: "Why this decision was made",
      },
      confidence: {
        type: "string",
        description: "high (auto-execute) | medium (60s veto window) | low (ask Nicolas first). Default: high",
      },
    },
    required: ["category", "action", "reasoning"],
  },
  async execute(args): Promise<string> {
    const category = String(args.category);
    const action = String(args.action);
    const reasoning = String(args.reasoning);
    const confidence = String(args.confidence || "high").toLowerCase();

    if (confidence === "low") {
      // LOW → redirect to mind.ask
      const id = logDecision(category, `Proposition: ${action}`, `[LOW confidence] ${reasoning}`, undefined, "pending_answer");
      const send = getBotSendFn();
      if (send && config.adminChatId) {
        const msg = `🧠 Kingston Mind — ${category.toUpperCase()}\n` +
          `🔴 Confiance: BASSE — besoin de ton accord\n\n` +
          `${action}\n\n` +
          `Raison: ${reasoning}\n\n` +
          `(Décision #${id}) — Réponds pour approuver ou refuser`;
        await send(config.adminChatId, msg).catch(() => {});
      }
      return `Décision #${id} en attente de Nicolas [${category}/low]: ${action.slice(0, 80)}`;
    }

    if (confidence === "medium") {
      // MEDIUM → pending_veto with 60s timer + inline keyboard
      const id = logDecision(category, action, `[MEDIUM confidence] ${reasoning}`, undefined, "pending_veto");

      const sendKb = getBotSendWithKeyboardFn();
      if (sendKb && config.adminChatId) {
        const msg = `🧠 Kingston Mind — ${category.toUpperCase()}\n` +
          `🟡 Confiance: MOYENNE — auto-exécution dans 60s\n\n` +
          `${action}\n\n` +
          `Raison: ${reasoning}\n\n` +
          `(Décision #${id})`;

        try {
          const msgId = await sendKb(
            config.adminChatId,
            msg,
            [
              [
                { text: "✅ Approuver", callback_data: `approve_${id}` },
                { text: "❌ Veto", callback_data: `veto_${id}` },
              ],
            ],
          );
          if (msgId) setDecisionTelegramMsg(id as number, msgId);
        } catch (err) {
          log.warn(`[mind] Failed to send veto keyboard: ${err}`);
        }
      }

      startVetoTimer(id as number);
      return `Décision #${id} en attente de veto [${category}/medium]: ${action.slice(0, 80)} — auto-approuvée dans 60s si pas de veto`;
    }

    // HIGH (default) → execute immediately, log only (NO Telegram notification)
    const id = logDecision(category, action, reasoning, undefined, "executed");
    log.info(`[mind] Decision #${id} executed [${category}]: ${action.slice(0, 80)}`);

    return `Décision #${id} exécutée [${category}]: ${action}`;
  },
});

registerSkill({
  name: "mind.propose",
  description:
    "Propose a MEDIUM-confidence action with 60s veto window. Nicolas gets Telegram buttons to approve/veto. Auto-approves after 60s. Use for significant but non-critical decisions.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      category: {
        type: "string",
        description: "trading | merch | client | content | strategy",
      },
      action: {
        type: "string",
        description: "What you want to do",
      },
      reasoning: {
        type: "string",
        description: "Why this is a good idea",
      },
      plan: {
        type: "string",
        description: "Step-by-step plan to execute if approved (optional)",
      },
    },
    required: ["category", "action", "reasoning"],
  },
  async execute(args): Promise<string> {
    const category = String(args.category);
    const action = String(args.action);
    const reasoning = String(args.reasoning);
    const plan = args.plan ? String(args.plan) : undefined;

    const fullReasoning = plan ? `${reasoning}\n\nPlan: ${plan}` : reasoning;
    const id = logDecision(category, action, `[PROPOSED] ${fullReasoning}`, undefined, "pending_veto");

    const sendKb = getBotSendWithKeyboardFn();
    if (sendKb && config.adminChatId) {
      let msg = `🧠 Kingston Mind — PROPOSITION\n` +
        `📋 ${category.toUpperCase()}\n\n` +
        `${action}\n\n` +
        `💡 ${reasoning}`;
      if (plan) msg += `\n\n📝 Plan:\n${plan}`;
      msg += `\n\n⏱️ Auto-approuvé dans 60s si pas de veto\n(Décision #${id})`;

      try {
        const msgId = await sendKb(
          config.adminChatId,
          msg,
          [
            [
              { text: "✅ Approuver", callback_data: `approve_${id}` },
              { text: "❌ Veto", callback_data: `veto_${id}` },
            ],
          ],
        );
        if (msgId) setDecisionTelegramMsg(id as number, msgId);
      } catch (err) {
        log.warn(`[mind] Failed to send proposal keyboard: ${err}`);
      }
    }

    startVetoTimer(id as number);
    return `Proposition #${id} envoyée [${category}]: ${action.slice(0, 80)} — auto-approuvée dans 60s`;
  },
});

registerSkill({
  name: "mind.pending",
  description:
    "Check pending proposals (awaiting veto) and recently approved/vetoed decisions. Shows what's waiting and what was decided.",
  adminOnly: true,
  argsSchema: { type: "object", properties: {} },
  async execute(): Promise<string> {
    const pendingVeto = getPendingVetoDecisions();
    const approved = getApprovedDecisions();
    const pendingQuestions = getPendingQuestions();

    const lines: string[] = [];

    if (pendingVeto.length > 0) {
      lines.push(`**⏳ ${pendingVeto.length} proposition(s) en attente de veto:**`);
      for (const d of pendingVeto) {
        const secsLeft = d.auto_execute_at ? Math.max(0, d.auto_execute_at - Math.floor(Date.now() / 1000)) : "?";
        lines.push(`  #${d.id} [${d.category}] ${d.action.slice(0, 60)} (${secsLeft}s restantes)`);
      }
      lines.push("");
    }

    if (approved.length > 0) {
      lines.push(`**Décisions récemment traitées:**`);
      for (const d of approved) {
        const icon = d.status === "approved" ? "✅" : d.status === "auto_approved" ? "⚡" : "❓";
        const ago = Math.round((Date.now() / 1000 - d.created_at) / 60);
        lines.push(`  ${icon} #${d.id} [${d.category}] ${d.action.slice(0, 60)} (il y a ${ago}min)`);
      }
      lines.push("");
    }

    if (pendingQuestions.length > 0) {
      lines.push(`**❓ ${pendingQuestions.length} question(s) pour Nicolas:**`);
      for (const q of pendingQuestions) {
        lines.push(`  #${q.id} [${q.category}] ${q.action.slice(0, 60)}`);
      }
    }

    if (lines.length === 0) {
      return "Aucune proposition en attente, aucune décision récente.";
    }

    return lines.join("\n");
  },
});

registerSkill({
  name: "mind.ask",
  description:
    "Ask Nicolas a question via Telegram. Use when you need his input for a decision. Urgency: low (can wait), medium (today), high (now).",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "The question to ask Nicolas",
      },
      category: {
        type: "string",
        description: "trading | merch | client | content | strategy",
      },
      urgency: {
        type: "string",
        description: "low | medium | high",
      },
    },
    required: ["question", "category"],
  },
  async execute(args): Promise<string> {
    const question = String(args.question);
    const category = String(args.category);
    const urgency = String(args.urgency || "medium");

    // Log as pending question
    const id = logDecision(
      category,
      `Question: ${question}`,
      `Urgence: ${urgency}`,
      undefined,
      "pending_answer",
    );

    // Send to Nicolas via Telegram
    const urgencyEmoji =
      urgency === "high" ? "🔴" : urgency === "medium" ? "🟡" : "🟢";
    const message =
      `🧠 Kingston Mind — ${category.toUpperCase()}\n` +
      `${urgencyEmoji} Urgence: ${urgency}\n\n` +
      `${question}\n\n` +
      `(Décision #${id})`;

    const send = getBotSendFn();
    const targetChat = config.adminChatId;
    if (send && targetChat) {
      try {
        await send(targetChat, message);
        log.info(`[mind] Question #${id} sent to Nicolas: ${question.slice(0, 60)}`);
      } catch (err) {
        log.warn(`[mind] Failed to send question: ${err}`);
        return `Question #${id} enregistrée mais envoi Telegram échoué: ${err}`;
      }
    } else {
      log.warn(`[mind] No Telegram send function available — question logged only`);
      return `Question #${id} enregistrée (pas de connexion Telegram active)`;
    }

    return `Question #${id} envoyée à Nicolas [${category}/${urgency}]: ${question.slice(0, 80)}`;
  },
});

registerSkill({
  name: "mind.status",
  description:
    "View recent autonomous decisions, pending proposals, and questions. Shows what Kingston Mind has done and what's waiting.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      limit: {
        type: "number",
        description: "Number of recent decisions to show (default 10)",
      },
      category: {
        type: "string",
        description: "Filter by category (optional)",
      },
    },
  },
  async execute(args): Promise<string> {
    const limit = Number(args.limit) || 10;
    const category = args.category ? String(args.category) : undefined;

    const decisions = getRecentDecisions(limit, category);
    const pending = getPendingQuestions();
    const pendingVeto = getPendingVetoDecisions();

    const lines: string[] = [];

    if (pendingVeto.length > 0) {
      lines.push(`**⏳ ${pendingVeto.length} proposition(s) en attente de veto:**`);
      for (const d of pendingVeto) {
        lines.push(`  #${d.id} [${d.category}] ${d.action.slice(0, 60)}`);
      }
      lines.push("");
    }

    if (pending.length > 0) {
      lines.push(`**${pending.length} question(s) en attente:**`);
      for (const q of pending) {
        const date = new Date(q.created_at * 1000).toLocaleString("fr-CA", {
          timeZone: "America/Toronto",
        });
        lines.push(`  #${q.id} [${q.category}] ${q.action} (${date})`);
      }
      lines.push("");
    }

    if (decisions.length > 0) {
      lines.push(`**${decisions.length} décision(s) récente(s):**`);
      for (const d of decisions) {
        const date = new Date(d.created_at * 1000).toLocaleString("fr-CA", {
          timeZone: "America/Toronto",
        });
        const statusIcon =
          d.status === "executed" ? "✅" :
          d.status === "auto_approved" ? "⚡" :
          d.status === "approved" ? "✅" :
          d.status === "vetoed" ? "❌" :
          d.status === "pending_veto" ? "⏳" : "❓";
        lines.push(
          `  ${statusIcon} #${d.id} [${d.category}] ${d.action.slice(0, 60)} (${date})`,
        );
      }
    } else {
      lines.push("Aucune décision récente.");
    }

    return lines.join("\n");
  },
});
