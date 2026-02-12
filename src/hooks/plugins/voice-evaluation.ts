/**
 * Voice Evaluation Plugin — auto-evaluates Kingston's performance after voice sessions.
 * Triggers on "voice:session:end" hook.
 * Uses Ollama (local, $0 cost) for lightweight sentiment/quality evaluation.
 * Logs results to episodic memory and creates code requests for weaknesses.
 */
import { registerHook, type HookEvent, type HookContext } from "../hooks.js";
import { log } from "../../utils/log.js";
import { logEpisodicEvent } from "../../storage/store.js";
import { isOllamaAvailable, runOllama } from "../../llm/ollamaClient.js";

const NS = "voice-evaluation";

registerHook("voice:session:end", async (_e: HookEvent, ctx: HookContext) => {
  const conversationLog = ctx.conversationLog as string[] | undefined;
  const turnCount = (ctx.turnCount as number) || 0;

  // Skip very short sessions (< 4 exchanges = not enough to evaluate)
  if (!conversationLog || turnCount < 4) {
    log.debug(`[${NS}] Skipping — only ${turnCount} turns`);
    return;
  }

  // Build conversation text for evaluation
  const text = conversationLog.slice(-20).join("\n").slice(0, 3000);

  // Check if Ollama is available (free, local evaluation)
  const ollamaUp = await isOllamaAvailable();
  if (!ollamaUp) {
    log.debug(`[${NS}] Ollama unavailable — skipping evaluation`);
    return;
  }

  try {
    const evalPrompt = [
      "Évalue cette conversation voice entre Kingston (AI) et Nicolas (user).",
      "Réponds en JSON strict, rien d'autre:",
      '{"score": 1-10, "satisfied": true/false, "strengths": "...", "weaknesses": "...", "suggestion": "..."}',
      "",
      "Critères:",
      "- Score 8-10: réponses utiles, outils utilisés correctement, conversation fluide",
      "- Score 5-7: correct mais des erreurs mineures ou lenteur",
      "- Score 1-4: hallucinations, outils échoués, utilisateur frustré",
      "",
      "Conversation:",
      text,
    ].join("\n");

    const result = await runOllama(9998, evalPrompt);
    const responseText = result.text.trim();

    // Try to parse JSON from the response
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      log.warn(`[${NS}] Could not parse evaluation JSON`);
      logEpisodicEvent(
        "voice_evaluation",
        `Voice session eval (${turnCount} turns): raw response`,
        {
          details: responseText.slice(0, 500),
          participants: ["Kingston"],
          importance: 3,
          source: NS,
        },
      );
      return;
    }

    const eval_ = JSON.parse(jsonMatch[0]) as {
      score: number;
      satisfied: boolean;
      strengths: string;
      weaknesses: string;
      suggestion: string;
    };

    const score = Math.max(1, Math.min(10, eval_.score || 5));
    const importance = score <= 4 ? 8 : score <= 6 ? 5 : 3;

    // Log to episodic memory
    logEpisodicEvent(
      "voice_evaluation",
      `Voice eval: ${score}/10 — ${eval_.satisfied ? "satisfied" : "unsatisfied"} (${turnCount} turns)`,
      {
        details: `Strengths: ${eval_.strengths}\nWeaknesses: ${eval_.weaknesses}\nSuggestion: ${eval_.suggestion}`,
        participants: ["Kingston", "Nicolas"],
        emotionalValence: eval_.satisfied ? 1 : -1,
        importance,
        source: NS,
        chatId: ctx.chatId as number | undefined,
      },
    );

    log.info(`[${NS}] Voice session score: ${score}/10 (${eval_.satisfied ? "✓" : "✗"})`);

    // If score is low, auto-create a code request for improvement
    if (score <= 4) {
      log.warn(`[${NS}] Low score (${score}/10) — logging improvement suggestion`);
      logEpisodicEvent(
        "self_improvement",
        `Auto-flagged weakness: ${eval_.weaknesses}`,
        {
          details: `Suggestion: ${eval_.suggestion}\nScore: ${score}/10`,
          participants: ["Kingston"],
          importance: 9,
          source: NS,
        },
      );
    }
  } catch (err) {
    log.warn(`[${NS}] Evaluation failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}, { namespace: NS, priority: "low", description: "Auto-evaluate voice session quality" });

log.info(`[${NS}] Voice evaluation plugin loaded`);
