/**
 * JSON protocol parser for Claude CLI output.
 *
 * Expected shapes:
 *   { "type": "message", "text": "..." }
 *   { "type": "tool_call", "tool": "notes.add", "args": {...} }
 *
 * Claude CLI with --output-format json returns:
 *   { "type": "result", "result": "...", "session_id": "..." }
 *
 * STRICT MODE: tool_call is ONLY accepted as pure JSON.
 * Text + embedded JSON → treated as a plain message (prevents injection).
 */

export interface MessageResult {
  type: "message";
  text: string;
  session_id?: string;
}

export interface ToolCallResult {
  type: "tool_call";
  tool: string;
  args: Record<string, unknown>;
  session_id?: string;
}

export type ParsedResult = MessageResult | ToolCallResult;

/**
 * Attempt to parse Claude CLI JSON output into our protocol types.
 * Falls back to plain text extraction on failure.
 */
export function parseClaudeOutput(raw: string): ParsedResult {
  const trimmed = raw.trim();

  // Try parsing as JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Not valid JSON — treat as plain text (STRICT: no embedded JSON extraction)
    return { type: "message", text: extractPlainText(trimmed) };
  }

  // Handle the real Claude CLI --output-format json shape
  if (isObject(parsed) && parsed.type === "result" && typeof parsed.result === "string") {
    const sessionId = typeof parsed.session_id === "string" ? parsed.session_id : undefined;
    return parseResultString(parsed.result, sessionId);
  }

  // Handle arrays (CLI may return an array of content blocks)
  if (Array.isArray(parsed)) {
    let sessionId: string | undefined;
    for (const block of parsed) {
      if (isObject(block) && block.type === "result" && typeof block.result === "string") {
        if (typeof block.session_id === "string") sessionId = block.session_id;
        return parseResultString(block.result, sessionId);
      }
    }
    // Collect text blocks — always treat as message (STRICT: no tool_call extraction)
    const texts = parsed
      .filter((b: unknown) => isObject(b) && b.type === "text" && typeof b.text === "string")
      .map((b: { text: string }) => b.text);
    if (texts.length > 0) {
      return { type: "message", text: texts.join("\n"), session_id: sessionId };
    }
  }

  // Handle our ideal protocol format (direct tool_call or message)
  if (isObject(parsed)) {
    const sessionId = typeof parsed.session_id === "string" ? parsed.session_id : undefined;
    if (parsed.type === "message" && typeof parsed.text === "string") {
      return { type: "message", text: parsed.text, session_id: sessionId };
    }
    if (
      parsed.type === "tool_call" &&
      typeof parsed.tool === "string" &&
      isObject(parsed.args)
    ) {
      // Validate tool name format
      if (!/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(parsed.tool)) {
        return { type: "message", text: extractPlainText(trimmed), session_id: sessionId };
      }
      return {
        type: "tool_call",
        tool: parsed.tool,
        args: parsed.args as Record<string, unknown>,
        session_id: sessionId,
      };
    }
  }

  // Fallback
  return { type: "message", text: extractPlainText(trimmed) };
}

/**
 * Parse a result string.
 * Tries pure JSON first (ideal), then scans for a trailing tool_call JSON
 * in case Claude prefixed thinking/reflection text before the JSON block.
 * Tool name is validated against a strict pattern to prevent injection.
 */
function parseResultString(result: string, sessionId?: string): ParsedResult {
  const trimmed = result.trim();

  // Fast path: pure JSON
  if (trimmed.startsWith("{")) {
    const parsed = tryParseToolOrMessage(trimmed, sessionId);
    if (parsed) return parsed;
  }

  // Slow path: Claude may have prefixed thinking text before the JSON.
  // Look for the last {"type":"tool_call" block.
  const marker = '{"type":"tool_call"';
  const idx = trimmed.lastIndexOf(marker);
  if (idx > 0) {
    const jsonCandidate = trimmed.slice(idx);
    const parsed = tryParseToolOrMessage(jsonCandidate, sessionId);
    if (parsed) return parsed;
  }

  return { type: "message", text: result, session_id: sessionId };
}

/** Try to parse a string as a tool_call or message JSON. Returns null on failure. */
function tryParseToolOrMessage(text: string, sessionId?: string): ParsedResult | null {
  try {
    const inner = JSON.parse(text);
    if (!isObject(inner)) return null;

    if (
      inner.type === "tool_call" &&
      typeof inner.tool === "string" &&
      isObject(inner.args)
    ) {
      if (!/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(inner.tool)) return null;
      return {
        type: "tool_call",
        tool: inner.tool,
        args: inner.args as Record<string, unknown>,
        session_id: sessionId,
      };
    }
    if (inner.type === "message" && typeof inner.text === "string") {
      return { type: "message", text: inner.text, session_id: sessionId };
    }
  } catch { /* not valid JSON */ }
  return null;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function extractPlainText(raw: string): string {
  // Strip ANSI escape codes if any
  const clean = raw.replace(/\x1b\[[0-9;]*m/g, "");
  return clean || "(empty response)";
}
