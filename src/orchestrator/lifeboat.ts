/**
 * Context Lifeboat + Handoff Packets.
 *
 * Saves a structured handoff packet before context compression so that
 * critical state survives across sessions. The lifeboat is injected into
 * the system prompt on every new session, giving Claude immediate context.
 *
 * Handoff packet format (7 fields):
 *   1. goal       — current primary objective (1 sentence)
 *   2. state      — what is already true / done
 *   3. nextAction — the very next concrete step
 *   4. constraints— hard rules, safety, deadlines
 *   5. unknowns   — what to verify / investigate
 *   6. artifacts  — paths, IDs, links relevant to current work
 *   7. stopConditions — when to halt and ask the user
 */
import fs from "node:fs";
import path from "node:path";
import { getTurns } from "../storage/store.js";
import { runClaude } from "../llm/claudeCli.js";
import { log } from "../utils/log.js";

const LIFEBOAT_DIR = path.resolve(process.cwd(), "relay");

export interface HandoffPacket {
  timestamp: string;
  chatId: number;
  goal: string;
  state: string;
  nextAction: string;
  constraints: string;
  unknowns: string;
  artifacts: string;
  stopConditions: string;
}

function lifeboatPath(chatId: number): string {
  return path.join(LIFEBOAT_DIR, `lifeboat-${chatId}.json`);
}

/** Load an existing lifeboat for a chat, or null if none exists. */
export function loadLifeboat(chatId: number): HandoffPacket | null {
  const p = lifeboatPath(chatId);
  try {
    if (!fs.existsSync(p)) return null;
    const data = JSON.parse(fs.readFileSync(p, "utf-8"));
    return data as HandoffPacket;
  } catch (err) {
    log.debug(`[lifeboat] Failed to load for chat ${chatId}: ${err}`);
    return null;
  }
}

/** Save a handoff packet for a chat. */
export function saveLifeboat(chatId: number, packet: HandoffPacket): void {
  if (!fs.existsSync(LIFEBOAT_DIR)) fs.mkdirSync(LIFEBOAT_DIR, { recursive: true });
  fs.writeFileSync(lifeboatPath(chatId), JSON.stringify(packet, null, 2));
  log.info(`[lifeboat] Saved handoff packet for chat ${chatId}`);
}

/** Save a lifeboat manually with raw fields. */
export function saveLifeboatRaw(
  chatId: number,
  fields: Omit<HandoffPacket, "timestamp" | "chatId">
): void {
  saveLifeboat(chatId, {
    ...fields,
    timestamp: new Date().toISOString(),
    chatId,
  });
}

/**
 * Format the lifeboat as a prompt section for injection into the system prompt.
 * Returns empty string if no lifeboat exists.
 */
export function getLifeboatPrompt(chatId: number): string {
  const packet = loadLifeboat(chatId);
  if (!packet) return "";

  const age = Math.round((Date.now() - new Date(packet.timestamp).getTime()) / 60_000);
  const ageStr = age < 60 ? `${age}min ago` : `${Math.round(age / 60)}h ago`;

  return [
    `## Context Lifeboat (saved ${ageStr})`,
    `**Goal:** ${packet.goal}`,
    `**State:** ${packet.state}`,
    `**Next Action:** ${packet.nextAction}`,
    `**Constraints:** ${packet.constraints}`,
    `**Unknowns:** ${packet.unknowns}`,
    `**Artifacts:** ${packet.artifacts}`,
    `**Stop Conditions:** ${packet.stopConditions}`,
  ].join("\n");
}

const EXTRACT_PROMPT = `Extract a structured handoff packet from this conversation. Return ONLY valid JSON with these exact fields (all strings, be concise):
{
  "goal": "current primary objective (1 sentence)",
  "state": "what is already true/done",
  "nextAction": "the very next concrete step",
  "constraints": "hard rules, safety, deadlines",
  "unknowns": "what to verify or investigate",
  "artifacts": "relevant file paths, IDs, links",
  "stopConditions": "when to halt and ask the user"
}
If there is no clear context, use "none" for each field. Return ONLY the JSON object, no markdown fences.`;

/**
 * Auto-extract a handoff packet from current conversation history.
 * Called before compaction to preserve critical state.
 */
export async function extractAndSaveLifeboat(chatId: number): Promise<boolean> {
  const turns = getTurns(chatId);
  if (turns.length < 3) {
    log.debug(`[lifeboat] Too few turns (${turns.length}) to extract — skipping`);
    return false;
  }

  // Build conversation summary for extraction (last 8 turns max)
  const recent = turns.slice(-8);
  const convo = recent
    .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.content.slice(0, 500)}`)
    .join("\n\n");

  const prompt = `${EXTRACT_PROMPT}\n\nConversation:\n${convo}`;

  try {
    const result = await runClaude(chatId, prompt, false);
    if (result.type !== "message") {
      log.warn("[lifeboat] Claude returned non-message response");
      return false;
    }

    // Parse the JSON response
    const text = result.text.trim();
    // Try to extract JSON from the response (handle markdown fences if present)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      log.warn("[lifeboat] Could not find JSON in Claude response");
      return false;
    }

    const fields = JSON.parse(jsonMatch[0]);
    saveLifeboatRaw(chatId, {
      goal: fields.goal || "none",
      state: fields.state || "none",
      nextAction: fields.nextAction || "none",
      constraints: fields.constraints || "none",
      unknowns: fields.unknowns || "none",
      artifacts: fields.artifacts || "none",
      stopConditions: fields.stopConditions || "none",
    });
    return true;
  } catch (err) {
    log.error(`[lifeboat] Failed to extract handoff packet: ${err}`);
    return false;
  }
}
