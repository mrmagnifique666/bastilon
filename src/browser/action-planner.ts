/**
 * Action planner — when no saved profile exists for a site, takes a DOM accessibility
 * snapshot and asks Gemini Flash to plan the interaction steps in a single API call.
 *
 * This replaces the old approach of taking 8+ screenshots + 8 vision calls (~140s)
 * with 1 DOM snapshot + 1 text API call (~3-5s).
 */
import type { Page } from "playwright";
import type { SiteStep } from "./site-profiles.js";
import { config } from "../config/env.js";
import { log } from "../utils/log.js";

// ── Accessibility Snapshot ─────────────────────────────────

interface A11yNode {
  ref: number;
  role: string;
  name: string;
  value?: string;
  description?: string;
  states?: string[];
  children?: A11yNode[];
}

/**
 * Take a compact accessibility snapshot of the current page via DOM evaluation.
 * Uses page.evaluate() to query interactive elements directly from the DOM.
 * Returns a flat array of interactive elements with ref numbers.
 */
export async function getAccessibilitySnapshot(page: Page): Promise<A11yNode[]> {
  const rawNodes = await page.evaluate(() => {
    const results: Array<{
      role: string;
      name: string;
      value?: string;
      tag: string;
      selector: string;
    }> = [];

    // Selectors for interactive elements
    const interactiveSelectors = [
      'button', 'a[href]', 'input', 'textarea', 'select',
      '[role="button"]', '[role="link"]', '[role="textbox"]',
      '[role="combobox"]', '[role="checkbox"]', '[role="radio"]',
      '[role="tab"]', '[role="menuitem"]', '[role="searchbox"]',
      '[role="switch"]', '[role="slider"]', '[role="dialog"]',
      '[contenteditable="true"]',
      'h1', 'h2', 'h3',
    ];

    const seen = new Set<Element>();

    for (const sel of interactiveSelectors) {
      const els = Array.from(document.querySelectorAll(sel));
      for (const el of els) {
        if (seen.has(el)) continue;
        seen.add(el);

        // Skip hidden elements
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") continue;

        const role = el.getAttribute("role")
          || (el.tagName === "BUTTON" ? "button"
            : el.tagName === "A" ? "link"
              : el.tagName === "INPUT" ? (el as HTMLInputElement).type || "textbox"
                : el.tagName === "TEXTAREA" ? "textbox"
                  : el.tagName === "SELECT" ? "combobox"
                    : el.getAttribute("contenteditable") === "true" ? "textbox"
                      : /^H[1-6]$/.test(el.tagName) ? "heading"
                        : "generic");

        // Enhanced name detection — handles icon-only elements (SVG, icon fonts)
        const name = el.getAttribute("aria-label")
          || el.getAttribute("title")
          || el.getAttribute("placeholder")
          || el.getAttribute("alt")
          // data-testid (Facebook, modern React apps)
          || el.getAttribute("data-testid")
          || el.getAttribute("data-tooltip-content")
          || el.getAttribute("data-tooltip")
          // SVG <title> child — standard SVG accessibility
          || el.querySelector("svg title")?.textContent?.trim()
          // aria-label on child elements (icon inside button)
          || el.querySelector("[aria-label]")?.getAttribute("aria-label")
          // img alt inside the element
          || el.querySelector("img[alt]")?.getAttribute("alt")
          // href path hints for links (e.g. /messages/ → messages)
          || (() => {
            const href = el.getAttribute("href");
            if (!href || href === "#" || href === "/") return "";
            const match = href.match(/^\/([a-z_-]+)/i);
            return match ? match[1].replace(/[-_]/g, " ") : "";
          })()
          // CSS class hints for icon libraries (fa-home, bi-bell, icon-messenger)
          || (() => {
            const iconEl = el.querySelector("i[class], span[class*='icon'], svg[class]") || el;
            const cls = iconEl.className?.toString() || "";
            const iconMatch = cls.match(/(?:fa|bi|icon|glyphicon)[-_]([a-z-]+)/i);
            return iconMatch ? iconMatch[1].replace(/-/g, " ") : "";
          })()
          || (el.textContent || "").trim().slice(0, 100)
          || "";

        const value = (el as HTMLInputElement).value || undefined;

        // Build a useful CSS selector
        let cssSelector = el.tagName.toLowerCase();
        if (el.id) cssSelector += `#${el.id}`;
        const ariaLabel = el.getAttribute("aria-label");
        if (ariaLabel) cssSelector = `[aria-label="${ariaLabel.replace(/"/g, '\\"')}"]`;
        else if (el.getAttribute("data-testid")) cssSelector = `[data-testid="${el.getAttribute("data-testid")}"]`;
        else if (el.getAttribute("role")) cssSelector = `[role="${el.getAttribute("role")}"]`;
        const name2 = el.getAttribute("name");
        if (name2) cssSelector += `[name="${name2}"]`;

        results.push({
          role,
          name: name.slice(0, 120),
          ...(value ? { value: value.slice(0, 80) } : {}),
          tag: el.tagName.toLowerCase(),
          selector: cssSelector,
        });
      }
    }

    return results.slice(0, 200);
  });

  return rawNodes.map((n, i) => ({
    ref: i,
    role: n.role,
    name: n.name,
    ...(n.value ? { value: n.value } : {}),
  }));
}

/**
 * Build a compact text representation of the accessibility tree for the LLM.
 */
function formatSnapshot(nodes: A11yNode[]): string {
  return nodes.map(n => {
    let line = `[${n.ref}] ${n.role}: "${n.name}"`;
    if (n.value) line += ` (value: "${n.value}")`;
    if (n.description) line += ` — ${n.description}`;
    return line;
  }).join("\n");
}

// ── Gemini Flash Planning ──────────────────────────────────

const PLANNER_PROMPT = `You are a web automation planner. Given a page's accessibility tree and a user goal,
output a JSON array of steps to accomplish the goal.

Each step is an object with these fields:
- type: "navigate" | "click" | "fill" | "wait" | "keyboard" | "eval"
- selector: CSS selector to target (prefer [role="X"][name="Y"] patterns)
- selectorText: fallback text to find the element by visible text
- selectorAria: fallback ARIA selector (role:name format)
- text: for "fill" — the text to type. Use {{content}} for dynamic user content
- url: for "navigate" — the URL
- keys: for "keyboard" — key name (Enter, Tab, Escape)
- ms: for "wait" — milliseconds (100-3000)
- code: for "eval" — JavaScript to run in page
- description: short French description of what this step does
- optional: true if failure should not stop the sequence

Rules:
- Output ONLY a JSON array, no markdown, no explanation
- Keep steps minimal — typically 3-8 steps
- Always include wait steps after navigation or clicks that trigger loading
- Use {{content}} placeholder in fill steps for the user's dynamic content
- For clicks, prefer selectors with role attributes: [role="button"][name="..."]
- If text contains accented characters (French), include them in selectorText
- Wait times: page load = 2000ms, dialog open = 1000ms, short = 500ms
`;

/**
 * Ask Gemini Flash to plan the interaction steps based on accessibility snapshot.
 * Single API call — replaces 8+ vision calls.
 */
export async function planActions(
  page: Page,
  goal: string,
  content?: string,
): Promise<SiteStep[]> {
  if (!config.geminiApiKey) {
    throw new Error("GEMINI_API_KEY required for action planning");
  }

  const url = page.url();
  const title = await page.title();
  const nodes = await getAccessibilitySnapshot(page);
  const snapshotText = formatSnapshot(nodes);

  log.info(`[action-planner] Planning for: "${goal}" on ${url} (${nodes.length} nodes)`);

  const userPrompt = `Page URL: ${url}
Page title: ${title}
Goal: ${goal}
${content ? `Content to use: "${content.slice(0, 500)}"` : ""}

Accessibility tree (ref, role, name):
${snapshotText}

Output the steps as a JSON array:`;

  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${config.geminiApiKey}`;
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), 15000);

  try {
    const res = await fetch(geminiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: ac.signal,
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: PLANNER_PROMPT },
            { text: userPrompt },
          ],
        }],
        generationConfig: {
          maxOutputTokens: 1500,
          temperature: 0.1,
          responseMimeType: "application/json",
        },
      }),
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini ${res.status}: ${errText.slice(0, 200)}`);
    }

    const data = await res.json() as any;
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "[]";

    // Parse JSON — handle potential markdown wrapping
    let cleaned = text.trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }

    const steps = JSON.parse(cleaned) as SiteStep[];
    log.info(`[action-planner] Planned ${steps.length} steps`);
    return steps;
  } catch (err) {
    clearTimeout(timeout);
    log.error(`[action-planner] Planning failed: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}

// ── Overlay Dismissal ──────────────────────────────────────

/**
 * Dismiss common overlays: cookie banners, notification popups, GDPR dialogs.
 * Runs before the main action to clear the way.
 */
export async function dismissOverlays(page: Page): Promise<number> {
  let dismissed = 0;

  // Common cookie/GDPR/notification dismiss patterns
  const dismissSelectors = [
    // Cookie banners
    '[aria-label="Accept all"], [aria-label="Tout accepter"]',
    'button:has-text("Accept All"), button:has-text("Tout accepter")',
    'button:has-text("Accept Cookies"), button:has-text("Accepter")',
    '[data-testid="cookie-policy-manage-dialog-accept-button"]',
    '#onetrust-accept-btn-handler',
    '.cc-accept, .cc-allow, .cc-btn-accept',
    // Facebook-specific
    '[aria-label="Allow all cookies"], [aria-label="Autoriser tous les cookies"]',
    '[aria-label="Close"], [aria-label="Fermer"]',
    // Notification prompts
    'button:has-text("Not Now"), button:has-text("Pas maintenant")',
    'button:has-text("Block"), button:has-text("Bloquer")',
    'button:has-text("Decline"), button:has-text("Refuser")',
  ];

  for (const sel of dismissSelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 300 })) {
        await el.click({ timeout: 2000 });
        dismissed++;
        await page.waitForTimeout(500);
      }
    } catch {
      // Element not found or not clickable — that's fine
    }
  }

  if (dismissed > 0) {
    log.info(`[action-planner] Dismissed ${dismissed} overlays`);
  }
  return dismissed;
}
