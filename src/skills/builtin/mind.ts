/**
 * Built-in skills: mind.decide, mind.ask, mind.status
 * Kingston Mind — autonomous decision-making and communication with Nicolas.
 */
import { registerSkill } from "../loader.js";
import {
  logDecision,
  getRecentDecisions,
  getPendingQuestions,
} from "../../storage/store.js";
import { getBotSendFn } from "./telegram.js";
import { config } from "../../config/env.js";
import { log } from "../../utils/log.js";

registerSkill({
  name: "mind.decide",
  description:
    "Log an autonomous decision made by Kingston Mind. Categories: trading, merch, client, content, strategy.",
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
    },
    required: ["category", "action", "reasoning"],
  },
  async execute(args): Promise<string> {
    const category = String(args.category);
    const action = String(args.action);
    const reasoning = String(args.reasoning);

    const id = logDecision(category, action, reasoning, undefined, "executed");
    return `Décision #${id} enregistrée [${category}]: ${action}`;
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
    "View recent autonomous decisions and pending questions. Shows what Kingston Mind has done and what's waiting for Nicolas.",
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

    const lines: string[] = [];

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
        const statusIcon = d.status === "executed" ? "✅" : "⏳";
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
