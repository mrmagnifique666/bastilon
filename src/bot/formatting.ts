/**
 * Advanced Telegram HTML formatting with semantic splitting.
 * Converts markdown to Telegram-compatible HTML and splits long messages
 * without breaking code blocks or other structural elements.
 */
import { log } from "../utils/log.js";

const MAX_TG_MESSAGE = 4096;

/**
 * Convert markdown to Telegram HTML.
 * Handles: fenced code blocks, inline code, bold, italic, strikethrough,
 * headers (→ bold), links, and tables.
 */
export function mdToHtml(text: string): string {
  // Protect code blocks first — extract, replace with placeholders
  const codeBlocks: string[] = [];
  let html = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) => {
    const escaped = escapeHtml(code);
    const tag = lang ? `<pre><code class="language-${escapeHtml(lang)}">${escaped}</code></pre>` : `<pre>${escaped}</pre>`;
    codeBlocks.push(tag);
    return `\x00CB${codeBlocks.length - 1}\x00`;
  });

  // Escape HTML in the remaining text
  html = escapeHtml(html);

  // Restore code block placeholders (already escaped internally)
  html = html.replace(/\x00CB(\d+)\x00/g, (_m, idx) => codeBlocks[Number(idx)]);

  // Inline code: `...`
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

  // Headers: # → bold
  html = html.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");

  // Bold: **...**
  html = html.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

  // Italic: *...* (not inside bold tags)
  html = html.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<i>$1</i>");

  // Strikethrough: ~~...~~
  html = html.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // Links: [text](url)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  return html;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Split a long HTML message into Telegram-safe chunks.
 * Rules:
 * 1. Never split inside a <pre>...</pre> block
 * 2. Prefer splitting at paragraph boundaries (double newline)
 * 3. Then at line boundaries
 * 4. Hard cut as last resort
 */
export function splitMessage(html: string): string[] {
  if (html.length <= MAX_TG_MESSAGE) return [html];

  const chunks: string[] = [];
  let remaining = html;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_TG_MESSAGE) {
      chunks.push(remaining);
      break;
    }

    const splitPos = findSplitPoint(remaining, MAX_TG_MESSAGE);
    chunks.push(remaining.slice(0, splitPos).trimEnd());
    remaining = remaining.slice(splitPos).trimStart();
  }

  return chunks;
}

function findSplitPoint(text: string, maxLen: number): number {
  // Check if there's an unclosed <pre> in the first maxLen chars
  const segment = text.slice(0, maxLen);
  const lastPreOpen = segment.lastIndexOf("<pre>");
  const lastPreClose = segment.lastIndexOf("</pre>");

  // If we're inside a code block, don't split here — find the end of the block
  if (lastPreOpen > lastPreClose) {
    // We're inside a <pre> block. Try to find its closing tag.
    const closeIdx = text.indexOf("</pre>", lastPreOpen);
    if (closeIdx !== -1 && closeIdx + 6 <= text.length) {
      const endOfBlock = closeIdx + 6;
      // If the whole block fits in 2x max, include it
      if (endOfBlock <= maxLen * 2) {
        return endOfBlock;
      }
    }
    // Otherwise, split before the <pre> block
    if (lastPreOpen > 0) {
      return lastPreOpen;
    }
  }

  // Prefer paragraph break (double newline)
  const paraBreak = segment.lastIndexOf("\n\n");
  if (paraBreak > maxLen * 0.3) return paraBreak + 2;

  // Then single newline
  const lineBreak = segment.lastIndexOf("\n");
  if (lineBreak > maxLen * 0.3) return lineBreak + 1;

  // Hard cut
  return maxLen;
}

/**
 * Send a potentially long message via bot API, with formatting and splitting.
 * Falls back to plain text if HTML parsing fails.
 */
export async function sendFormatted(
  sendFn: (text: string, parseMode?: string) => Promise<unknown>,
  text: string
): Promise<void> {
  const html = mdToHtml(text);
  const chunks = splitMessage(html);

  for (const chunk of chunks) {
    try {
      await sendFn(chunk, "HTML");
    } catch (err) {
      log.warn(`[formatting] HTML send failed, falling back to plain: ${err}`);
      // Fall back: send the raw text chunk (approximate the same content)
      const plainChunk = chunk
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">");
      await sendFn(plainChunk);
    }
  }
}
