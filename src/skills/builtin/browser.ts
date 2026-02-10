/**
 * Built-in skills: browser.*
 * Puppeteer-based browser automation — admin only.
 */
import { registerSkill } from "../loader.js";
import { browserManager } from "../../browser/manager.js";
import { config } from "../../config/env.js";
import { log } from "../../utils/log.js";
import { getBotPhotoFn } from "./telegram.js";

const MAX_TEXT = 8000;

// ── Semantic Snapshot State ──────────────────────────────────
// Stores the last snapshot's ref→selector mapping for browser.act
let lastRefMap: Map<number, string> = new Map();
let lastSnapshotUrl = "";

// ── Helpers ──────────────────────────────────────────────────

function validateUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (!["http:", "https:"].includes(u.protocol)) {
      return "Only http/https URLs are allowed.";
    }
    return null;
  } catch {
    return `Invalid URL: ${url}`;
  }
}

function truncate(text: string, max = MAX_TEXT): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n... (truncated, ${text.length} total chars)`;
}

async function takeAndSendScreenshot(chatId: number, selector?: string): Promise<string> {
  const page = await browserManager.getPage();
  const sendPhoto = getBotPhotoFn();
  if (!sendPhoto) return "Error: bot photo API not available.";

  // Validate chatId — must be a positive number (not a fake agent chatId like 100-103)
  if (!chatId || isNaN(chatId) || chatId <= 0) {
    log.warn(`[browser] Invalid chatId ${chatId} — skipping screenshot send`);
    return `Screenshot skipped: invalid chatId (${chatId}). Page: ${page.url()}`;
  }

  let buffer: Buffer;
  if (selector) {
    const el = await page.$(selector);
    if (!el) return `Error: element not found for selector "${selector}".`;
    buffer = (await el.screenshot()) as Buffer;
  } else {
    buffer = (await page.screenshot({ fullPage: false })) as Buffer;
  }

  const currentUrl = page.url();
  try {
    await sendPhoto(chatId, buffer, `Screenshot: ${currentUrl}`);
    log.info(`[browser] Screenshot sent to chat ${chatId} (${buffer.length} bytes)`);
    return `Screenshot sent (${buffer.length} bytes). Current page: ${currentUrl}`;
  } catch (err) {
    log.warn(`[browser] Failed to send screenshot to chat ${chatId}: ${err instanceof Error ? err.message : String(err)}`);
    return `Screenshot captured (${buffer.length} bytes) but failed to send to chat. Current page: ${currentUrl}`;
  }
}

// ── Existing Skills ─────────────────────────────────────────

registerSkill({
  name: "browser.navigate",
  description:
    "Navigate to a URL. Returns page title and text content. Optionally takes a screenshot.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL to navigate to" },
      screenshot: { type: "string", description: "If 'true', take a screenshot after loading" },
      chatId: { type: "string", description: "Chat ID for sending screenshot" },
    },
    required: ["url"],
  },
  async execute(args): Promise<string> {
    const url = args.url as string;
    const wantScreenshot = String(args.screenshot) === "true";
    const chatId = Number(args.chatId);

    const urlError = validateUrl(url);
    if (urlError) return `Error: ${urlError}`;

    const page = await browserManager.getPage();
    try {
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: config.browserTimeoutMs,
      });
    } catch (err) {
      return `Error navigating to ${url}: ${err instanceof Error ? err.message : String(err)}`;
    }

    const title = await page.title();
    const text = await page.evaluate(() => document.body?.innerText || "");

    let result = `Navigated to: ${page.url()}\nTitle: ${title}\n\n${truncate(text)}`;

    if (wantScreenshot && chatId) {
      const ssResult = await takeAndSendScreenshot(chatId);
      result += `\n\n${ssResult}`;
    }

    return result;
  },
});

registerSkill({
  name: "browser.screenshot",
  description:
    "Take a screenshot of the current page (or a specific element) and send it to Telegram.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      selector: { type: "string", description: "CSS selector to screenshot a specific element" },
      chatId: { type: "string", description: "Chat ID to send screenshot to" },
    },
    required: ["chatId"],
  },
  async execute(args): Promise<string> {
    const chatId = Number(args.chatId);
    if (!chatId || isNaN(chatId)) return "Error: invalid chatId.";
    return takeAndSendScreenshot(chatId, args.selector as string | undefined);
  },
});

registerSkill({
  name: "browser.click",
  description:
    "Click an element on the page by CSS selector or visible text.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      selector: { type: "string", description: "CSS selector to click" },
      text: { type: "string", description: "Visible text to find and click (uses XPath)" },
    },
  },
  async execute(args): Promise<string> {
    const selector = args.selector as string | undefined;
    const text = args.text as string | undefined;

    if (!selector && !text) return "Error: provide either 'selector' or 'text'.";

    const page = await browserManager.getPage();

    try {
      if (selector) {
        await page.waitForSelector(selector, { timeout: config.browserTimeoutMs });
        await page.click(selector);
        return `Clicked element: ${selector}`;
      }

      // Find by visible text via XPath
      const escaped = text!.replace(/'/g, "\\'");
      const [el] = await page.$$(`xpath/.//a[contains(text(),"${escaped}")] | .//button[contains(text(),"${escaped}")] | .//*[contains(text(),"${escaped}")]`);
      if (!el) return `Error: no element found with text "${text}".`;
      await el.click();
      return `Clicked element with text: "${text}"`;
    } catch (err) {
      return `Error clicking: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

registerSkill({
  name: "browser.type",
  description: "Type text into an input field on the current page.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      selector: { type: "string", description: "CSS selector of the input field" },
      text: { type: "string", description: "Text to type" },
      clear: { type: "string", description: "If 'true', clear the field before typing" },
    },
    required: ["selector", "text"],
  },
  async execute(args): Promise<string> {
    const selector = args.selector as string;
    const text = args.text as string;
    const clear = String(args.clear) === "true";

    const page = await browserManager.getPage();

    try {
      await page.waitForSelector(selector, { timeout: config.browserTimeoutMs });

      if (clear) {
        await page.click(selector, { count: 3 }); // select all
        await page.keyboard.press("Backspace");
      }

      await page.type(selector, text);
      return `Typed "${text.length > 50 ? text.slice(0, 50) + "..." : text}" into ${selector}`;
    } catch (err) {
      return `Error typing: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

registerSkill({
  name: "browser.extract",
  description:
    "Extract content from the current page, optionally from a specific element.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      selector: { type: "string", description: "CSS selector to extract from (default: body)" },
      format: { type: "string", description: "'text' (default) or 'html'" },
    },
  },
  async execute(args): Promise<string> {
    const selector = (args.selector as string) || "body";
    const format = (args.format as string) || "text";

    const page = await browserManager.getPage();

    try {
      const el = await page.$(selector);
      if (!el) return `Error: element not found for selector "${selector}".`;

      let content: string;
      if (format === "html") {
        content = await page.evaluate(
          (el) => el.outerHTML,
          el
        );
      } else {
        content = await page.evaluate(
          (el) => (el as HTMLElement).innerText || el.textContent || "",
          el
        );
      }

      return `Extracted from ${selector} (${format}):\n${truncate(content)}`;
    } catch (err) {
      return `Error extracting: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

registerSkill({
  name: "browser.eval",
  description:
    "Execute JavaScript in the browser page context and return the result.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      code: { type: "string", description: "JavaScript code to execute in the page" },
    },
    required: ["code"],
  },
  async execute(args): Promise<string> {
    const code = args.code as string;
    const page = await browserManager.getPage();

    try {
      const result = await page.evaluate(code);
      const str = typeof result === "string" ? result : JSON.stringify(result, null, 2) ?? "undefined";
      return `Eval result:\n${truncate(str)}`;
    } catch (err) {
      return `Error evaluating JS: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

// ── Phase 2: Computer Use ───────────────────────────────────

const VISION_PROMPT = `You are controlling a browser to accomplish a goal. You see a screenshot.
Respond with EXACTLY ONE JSON action, nothing else. Available actions:
{"action":"click","x":<int>,"y":<int>}
{"action":"double_click","x":<int>,"y":<int>}
{"action":"right_click","x":<int>,"y":<int>}
{"action":"type","text":"<string>"}
{"action":"key","key":"<Enter|Tab|Escape|Backspace|...>"}
{"action":"scroll","x":<int>,"y":<int>,"direction":"up|down","amount":<1-10>}
{"action":"done","summary":"<what was accomplished>"}

Current goal: `;

type CUAction =
  | { action: "click"; x: number; y: number }
  | { action: "double_click"; x: number; y: number }
  | { action: "right_click"; x: number; y: number }
  | { action: "type"; text: string }
  | { action: "key"; key: string }
  | { action: "scroll"; x: number; y: number; direction: "up" | "down"; amount: number }
  | { action: "done"; summary: string };

function parseCUAction(raw: string): CUAction | null {
  try {
    // Extract JSON from potential markdown fences or surrounding text
    const jsonMatch = raw.match(/\{[^{}]*"action"\s*:\s*"[^"]+?"[^{}]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]) as CUAction;
  } catch {
    return null;
  }
}

registerSkill({
  name: "browser.computer_use",
  description:
    "Autonomous browser control via screenshot analysis. Give a goal and the bot takes screenshots, analyzes them with Gemini vision, and clicks/types at coordinates to achieve the goal. Requires GEMINI_API_KEY.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      goal: { type: "string", description: "What to accomplish in the browser" },
      url: { type: "string", description: "Optional starting URL" },
      chatId: { type: "string", description: "Chat ID for sending screenshots" },
      maxSteps: { type: "string", description: "Max iterations (default 10)" },
    },
    required: ["goal", "chatId"],
  },
  async execute(args): Promise<string> {
    const goal = args.goal as string;
    const url = args.url as string | undefined;
    const chatId = Number(args.chatId);
    const maxSteps = Number(args.maxSteps) || 10;

    if (!config.geminiApiKey) {
      return "Error: GEMINI_API_KEY is not set. Computer use requires Gemini for vision.";
    }

    const sendPhoto = getBotPhotoFn();
    if (!sendPhoto) return "Error: bot photo API not available.";

    const page = await browserManager.getPage();

    // Navigate to starting URL if provided
    if (url) {
      const urlError = validateUrl(url);
      if (urlError) return `Error: ${urlError}`;
      try {
        await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: config.browserTimeoutMs,
        });
      } catch (err) {
        return `Error navigating to ${url}: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    const steps: string[] = [];

    for (let step = 1; step <= maxSteps; step++) {
      // Take screenshot
      const screenshotBuffer = (await page.screenshot({ fullPage: false })) as Buffer;
      const base64 = screenshotBuffer.toString("base64");

      // Send screenshot to Telegram
      await sendPhoto(chatId, screenshotBuffer, `Step ${step}/${maxSteps}`);

      // Ask Gemini vision for next action
      let actionText: string;
      try {
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${config.geminiApiKey}`;
        const geminiRes = await fetch(geminiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{
              parts: [
                { inline_data: { mime_type: "image/png", data: base64 } },
                { text: VISION_PROMPT + goal },
              ],
            }],
            generationConfig: { maxOutputTokens: 300 },
          }),
        });

        if (!geminiRes.ok) {
          const errText = await geminiRes.text();
          throw new Error(`Gemini ${geminiRes.status}: ${errText.slice(0, 200)}`);
        }

        const geminiData = (await geminiRes.json()) as any;
        actionText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || "";
      } catch (err) {
        const msg = `Error calling Gemini vision API: ${err instanceof Error ? err.message : String(err)}`;
        log.error(`[browser.computer_use] ${msg}`);
        steps.push(`Step ${step}: ${msg}`);
        break;
      }

      const action = parseCUAction(actionText);
      if (!action) {
        steps.push(`Step ${step}: Could not parse action from: ${actionText.slice(0, 200)}`);
        break;
      }

      log.info(`[browser.computer_use] Step ${step}: ${JSON.stringify(action)}`);

      // Execute the action
      try {
        switch (action.action) {
          case "click":
            await page.mouse.click(action.x, action.y);
            steps.push(`Step ${step}: click(${action.x}, ${action.y})`);
            break;

          case "double_click":
            await page.mouse.click(action.x, action.y, { count: 2 });
            steps.push(`Step ${step}: double_click(${action.x}, ${action.y})`);
            break;

          case "right_click":
            await page.mouse.click(action.x, action.y, { button: "right" });
            steps.push(`Step ${step}: right_click(${action.x}, ${action.y})`);
            break;

          case "type":
            await page.keyboard.type(action.text);
            steps.push(`Step ${step}: type("${action.text.slice(0, 50)}")`);
            break;

          case "key":
            await page.keyboard.press(action.key as any);
            steps.push(`Step ${step}: key(${action.key})`);
            break;

          case "scroll": {
            const delta = (action.direction === "down" ? 1 : -1) * (action.amount || 3) * 100;
            await page.mouse.move(action.x || 640, action.y || 360);
            await page.mouse.wheel({ deltaY: delta });
            steps.push(
              `Step ${step}: scroll(${action.direction}, amount=${action.amount || 3})`
            );
            break;
          }

          case "done":
            steps.push(`Step ${step}: DONE — ${action.summary}`);
            // Send final screenshot
            const finalBuffer = (await page.screenshot({ fullPage: false })) as Buffer;
            await sendPhoto(chatId, finalBuffer, `Done: ${action.summary}`);
            return `Computer use completed in ${step} steps.\n\n${steps.join("\n")}\n\nResult: ${action.summary}`;
        }
      } catch (err) {
        steps.push(
          `Step ${step}: Error executing ${action.action}: ${err instanceof Error ? err.message : String(err)}`
        );
        break;
      }

      // Brief pause between steps to let the page react
      await new Promise((r) => setTimeout(r, 500));
    }

    return `Computer use finished after ${steps.length} steps.\n\n${steps.join("\n")}`;
  },
});

// ── Phase 3: Additional Skills ──────────────────────────────

registerSkill({
  name: "browser.scroll",
  description: "Scroll the page or a specific element up or down.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      direction: { type: "string", description: "up or down (default: down)" },
      amount: { type: "string", description: "Pixels to scroll (default: 300)" },
      selector: { type: "string", description: "Optional CSS selector to scroll within" },
    },
  },
  async execute(args): Promise<string> {
    const direction = (args.direction as string) || "down";
    const amount = Number(args.amount) || 300;
    const selector = args.selector as string | undefined;
    const page = await browserManager.getPage();

    try {
      if (selector) {
        await page.evaluate(
          (sel: string, dir: string, amt: number) => {
            const el = document.querySelector(sel);
            if (!el) throw new Error(`Element not found: ${sel}`);
            el.scrollBy(0, dir === "down" ? amt : -amt);
          },
          selector,
          direction,
          amount
        );
        return `Scrolled ${direction} ${amount}px within ${selector}`;
      }

      const delta = direction === "down" ? amount : -amount;
      await page.mouse.wheel({ deltaY: delta });
      return `Scrolled ${direction} ${amount}px`;
    } catch (err) {
      return `Error scrolling: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

registerSkill({
  name: "browser.select",
  description: "Select an option in a <select> element.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      selector: { type: "string", description: "CSS selector of the <select> element" },
      value: { type: "string", description: "Option value to select" },
    },
    required: ["selector", "value"],
  },
  async execute(args): Promise<string> {
    const selector = args.selector as string;
    const value = args.value as string;
    const page = await browserManager.getPage();

    try {
      const result = await page.select(selector, value);
      return `Selected value "${value}" in ${selector}. Selected: [${result.join(", ")}]`;
    } catch (err) {
      return `Error selecting: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

registerSkill({
  name: "browser.wait",
  description: "Wait for a CSS selector to appear, text to be visible, or a fixed delay.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      selector: { type: "string", description: "CSS selector to wait for" },
      text: { type: "string", description: "Text content to wait for on the page" },
      timeout: { type: "string", description: "Timeout in ms (default: 10000)" },
      delay: { type: "string", description: "Fixed delay in ms (just wait, no condition)" },
    },
  },
  async execute(args): Promise<string> {
    const selector = args.selector as string | undefined;
    const text = args.text as string | undefined;
    const timeout = Number(args.timeout) || 10000;
    const delay = Number(args.delay) || 0;
    const page = await browserManager.getPage();

    try {
      if (delay > 0) {
        await new Promise((r) => setTimeout(r, Math.min(delay, 30000)));
        return `Waited ${delay}ms.`;
      }

      if (selector) {
        await page.waitForSelector(selector, { timeout });
        return `Element appeared: ${selector}`;
      }

      if (text) {
        await page.waitForFunction(
          (t: string) => document.body?.innerText?.includes(t),
          { timeout },
          text
        );
        return `Text found: "${text}"`;
      }

      return "Error: provide selector, text, or delay.";
    } catch (err) {
      return `Error waiting: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

registerSkill({
  name: "browser.tabs",
  description: "List, switch, close, or open browser tabs.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "list, switch, close, or new",
      },
      index: { type: "string", description: "Tab index (0-based) for switch/close" },
      url: { type: "string", description: "URL for new tab" },
    },
    required: ["action"],
  },
  async execute(args): Promise<string> {
    const action = args.action as string;
    const index = Number(args.index);
    const url = args.url as string | undefined;

    const browser = browserManager.getBrowser();
    if (!browser) return "Error: no browser instance active.";

    try {
      const pages = await browser.pages();

      switch (action) {
        case "list": {
          const tabs = await Promise.all(
            pages.map(async (p, i) => {
              const title = await p.title().catch(() => "(untitled)");
              return `[${i}] ${p.url()} — ${title}`;
            })
          );
          return `${pages.length} tab(s):\n${tabs.join("\n")}`;
        }

        case "switch": {
          if (isNaN(index) || index < 0 || index >= pages.length) {
            return `Error: invalid tab index ${index}. Have ${pages.length} tab(s).`;
          }
          await pages[index].bringToFront();
          return `Switched to tab ${index}: ${pages[index].url()}`;
        }

        case "close": {
          if (isNaN(index) || index < 0 || index >= pages.length) {
            return `Error: invalid tab index ${index}. Have ${pages.length} tab(s).`;
          }
          if (pages.length <= 1) {
            return "Error: cannot close the last tab.";
          }
          const closedUrl = pages[index].url();
          await pages[index].close();
          return `Closed tab ${index}: ${closedUrl}`;
        }

        case "new": {
          const newPage = await browser.newPage();
          if (url) {
            const urlError = validateUrl(url);
            if (urlError) return `Error: ${urlError}`;
            await newPage.goto(url, {
              waitUntil: "domcontentloaded",
              timeout: config.browserTimeoutMs,
            });
          }
          await newPage.bringToFront();
          const updatedPages = await browser.pages();
          return `Opened new tab (index ${updatedPages.length - 1}): ${newPage.url()}`;
        }

        default:
          return `Error: unknown action "${action}". Use list, switch, close, or new.`;
      }
    } catch (err) {
      return `Error managing tabs: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

registerSkill({
  name: "browser.back",
  description: "Go back in the browser history.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {},
  },
  async execute(): Promise<string> {
    const page = await browserManager.getPage();
    try {
      const response = await page.goBack({
        waitUntil: "domcontentloaded",
        timeout: config.browserTimeoutMs,
      });
      if (!response) return "Error: no previous page in history.";
      return `Navigated back to: ${page.url()}`;
    } catch (err) {
      return `Error going back: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

registerSkill({
  name: "browser.cookies",
  description: "Get, set, or clear browser cookies.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      action: { type: "string", description: "get, set, or clear" },
      name: { type: "string", description: "Cookie name (for set/clear)" },
      value: { type: "string", description: "Cookie value (for set)" },
      domain: { type: "string", description: "Cookie domain (for set/clear)" },
    },
    required: ["action"],
  },
  async execute(args): Promise<string> {
    const action = args.action as string;
    const name = args.name as string | undefined;
    const value = args.value as string | undefined;
    const domain = args.domain as string | undefined;
    const page = await browserManager.getPage();

    try {
      switch (action) {
        case "get": {
          const cookies = await page.cookies();
          if (name) {
            const found = cookies.filter((c) => c.name === name);
            if (found.length === 0) return `No cookie found with name "${name}".`;
            return `Cookie:\n${JSON.stringify(found, null, 2)}`;
          }
          return `${cookies.length} cookie(s):\n${truncate(JSON.stringify(cookies, null, 2))}`;
        }

        case "set": {
          if (!name || value === undefined) {
            return "Error: name and value are required for set.";
          }
          const currentUrl = new URL(page.url());
          await page.setCookie({
            name,
            value: value || "",
            domain: domain || currentUrl.hostname,
          });
          return `Cookie set: ${name}=${value}`;
        }

        case "clear": {
          if (name) {
            const cookies = await page.cookies();
            const toDelete = cookies.filter((c) => c.name === name);
            if (toDelete.length === 0) return `No cookie found with name "${name}".`;
            await page.deleteCookie(...toDelete);
            return `Deleted ${toDelete.length} cookie(s) named "${name}".`;
          }
          const all = await page.cookies();
          if (all.length === 0) return "No cookies to clear.";
          await page.deleteCookie(...all);
          return `Cleared ${all.length} cookie(s).`;
        }

        default:
          return `Error: unknown action "${action}". Use get, set, or clear.`;
      }
    } catch (err) {
      return `Error managing cookies: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

registerSkill({
  name: "browser.keyboard",
  description:
    "Press keyboard keys or shortcuts (e.g. Enter, Escape, Control+a, Control+c).",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      keys: {
        type: "string",
        description:
          "Key or combo to press. Examples: Enter, Escape, Tab, Control+a, Shift+Tab, Alt+F4. Use + for combos.",
      },
    },
    required: ["keys"],
  },
  async execute(args): Promise<string> {
    const keys = args.keys as string;
    const page = await browserManager.getPage();

    try {
      const parts = keys.split("+").map((k) => k.trim());

      if (parts.length === 1) {
        // Single key press
        await page.keyboard.press(parts[0] as any);
        return `Pressed: ${parts[0]}`;
      }

      // Key combo: hold modifiers, press last key, release modifiers
      const modifiers = parts.slice(0, -1);
      const mainKey = parts[parts.length - 1];

      for (const mod of modifiers) {
        await page.keyboard.down(mod as any);
      }
      await page.keyboard.press(mainKey as any);
      for (const mod of modifiers.reverse()) {
        await page.keyboard.up(mod as any);
      }

      return `Pressed: ${keys}`;
    } catch (err) {
      return `Error pressing keys: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

// ── Phase 4: Semantic Snapshots (OpenClaw-inspired) ─────────

registerSkill({
  name: "browser.snapshot",
  description:
    `Take a semantic snapshot of the current page — returns the accessibility tree with numbered refs instead of a screenshot. Much cheaper than screenshots (~50KB text vs 5MB image), more precise for navigation. Use browser.act to interact with elements by ref number.

Example output:
  page: https://example.com — "Example Site"
  [1] heading "Welcome"
  [2] link "About Us"
  [3] textbox "Search..." (focused)
  [4] button "Search"
  [5] link "Sign In"`,
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "Optional URL to navigate to first" },
      interactive_only: { type: "string", description: "If 'true' (default), only show interactive elements. Set 'false' for full tree." },
      compact: { type: "string", description: "If 'true' (default), flatten the tree. Set 'false' for indented hierarchy." },
    },
  },
  async execute(args): Promise<string> {
    const url = args.url as string | undefined;
    const interactiveOnly = String(args.interactive_only) !== "false";
    const compact = String(args.compact) !== "false";

    const page = await browserManager.getPage();

    // Navigate if URL provided
    if (url) {
      const urlError = validateUrl(url);
      if (urlError) return `Error: ${urlError}`;
      try {
        await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: config.browserTimeoutMs,
        });
      } catch (err) {
        return `Error navigating to ${url}: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    try {
      // Inject data-bastilon-ref attributes and collect the tree
      const snapshot = await page.evaluate((interactiveFlag: boolean) => {
        const INTERACTIVE_ROLES = new Set([
          "a", "button", "input", "select", "textarea", "details", "summary",
          "[role=button]", "[role=link]", "[role=tab]", "[role=menuitem]",
          "[role=checkbox]", "[role=radio]", "[role=switch]", "[role=slider]",
          "[role=textbox]", "[role=combobox]", "[role=searchbox]",
          "[role=option]", "[role=listbox]",
        ]);

        const INTERACTIVE_SELECTOR = [
          "a[href]", "button", "input:not([type=hidden])", "select", "textarea",
          "details", "summary",
          "[role=button]", "[role=link]", "[role=tab]", "[role=menuitem]",
          "[role=checkbox]", "[role=radio]", "[role=switch]", "[role=slider]",
          "[role=textbox]", "[role=combobox]", "[role=searchbox]",
          "[role=option]", "[role=listbox]",
          "[onclick]", "[tabindex]",
        ].join(",");

        const LANDMARK_SELECTOR = [
          "h1", "h2", "h3", "h4", "h5", "h6",
          "nav", "main", "header", "footer", "aside", "section", "article", "form",
          "[role=heading]", "[role=navigation]", "[role=main]", "[role=banner]",
          "[role=contentinfo]", "[role=complementary]", "[role=form]", "[role=search]",
          "[role=region]", "[role=dialog]", "[role=alert]", "[role=alertdialog]",
          "img[alt]", "[role=img]",
        ].join(",");

        function getRole(el: Element): string {
          const ariaRole = el.getAttribute("role");
          if (ariaRole) return ariaRole;

          const tag = el.tagName.toLowerCase();
          const type = (el as HTMLInputElement).type?.toLowerCase();
          switch (tag) {
            case "a": return el.hasAttribute("href") ? "link" : "generic";
            case "button": return "button";
            case "input":
              if (type === "submit" || type === "button") return "button";
              if (type === "checkbox") return "checkbox";
              if (type === "radio") return "radio";
              if (type === "search") return "searchbox";
              return "textbox";
            case "select": return "combobox";
            case "textarea": return "textbox";
            case "img": return "img";
            case "h1": case "h2": case "h3": case "h4": case "h5": case "h6":
              return `heading (level ${tag[1]})`;
            case "nav": return "navigation";
            case "main": return "main";
            case "header": return "banner";
            case "footer": return "contentinfo";
            case "aside": return "complementary";
            case "section": return "region";
            case "article": return "article";
            case "form": return "form";
            case "details": return "group";
            case "summary": return "button";
            default: return tag;
          }
        }

        function getName(el: Element): string {
          // aria-label takes priority
          const ariaLabel = el.getAttribute("aria-label");
          if (ariaLabel) return ariaLabel.trim();

          // aria-labelledby
          const labelledBy = el.getAttribute("aria-labelledby");
          if (labelledBy) {
            const ref = document.getElementById(labelledBy);
            if (ref) return ref.textContent?.trim() || "";
          }

          // alt for images
          if (el.tagName === "IMG") return (el as HTMLImageElement).alt || "";

          // placeholder for inputs
          const placeholder = (el as HTMLInputElement).placeholder;
          if (placeholder) return placeholder;

          // title attribute
          const title = el.getAttribute("title");
          if (title) return title.trim();

          // innerText (limited)
          const text = (el as HTMLElement).innerText?.trim() || "";
          return text.length > 80 ? text.slice(0, 77) + "..." : text;
        }

        function getState(el: Element): string[] {
          const states: string[] = [];
          if (document.activeElement === el) states.push("focused");
          if ((el as HTMLInputElement).disabled) states.push("disabled");
          if ((el as HTMLInputElement).checked) states.push("checked");
          if ((el as HTMLInputElement).readOnly) states.push("readonly");
          if (el.getAttribute("aria-expanded") === "true") states.push("expanded");
          if (el.getAttribute("aria-selected") === "true") states.push("selected");
          if (el.getAttribute("aria-pressed") === "true") states.push("pressed");
          if ((el as HTMLInputElement).value) {
            const v = (el as HTMLInputElement).value;
            if (v.length > 0 && v.length <= 40) states.push(`value="${v}"`);
            else if (v.length > 40) states.push(`value="${v.slice(0, 37)}..."`);
          }
          return states;
        }

        // Collect elements
        const selector = interactiveFlag
          ? INTERACTIVE_SELECTOR + "," + LANDMARK_SELECTOR
          : "*";
        const elements = document.querySelectorAll(selector);

        const results: Array<{
          ref: number;
          role: string;
          name: string;
          states: string[];
          depth: number;
          selector: string;
        }> = [];

        let refCounter = 1;

        elements.forEach((el) => {
          // Skip invisible elements
          const style = window.getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden") return;
          if ((el as HTMLElement).offsetWidth === 0 && (el as HTMLElement).offsetHeight === 0) return;

          const role = getRole(el);
          if (role === "generic") return; // skip non-semantic

          const name = getName(el);
          const states = getState(el);
          const ref = refCounter++;

          // Inject data attribute for later retrieval
          el.setAttribute("data-bastilon-ref", String(ref));

          // Compute depth for hierarchy
          let depth = 0;
          let parent = el.parentElement;
          while (parent) {
            if (parent.hasAttribute("data-bastilon-ref")) depth++;
            parent = parent.parentElement;
          }

          // Build a stable selector
          const stableSelector = `[data-bastilon-ref="${ref}"]`;

          results.push({ ref, role, name, states, depth, selector: stableSelector });
        });

        return results;
      }, interactiveOnly);

      // Update ref map
      lastRefMap = new Map();
      for (const item of snapshot) {
        lastRefMap.set(item.ref, item.selector);
      }
      lastSnapshotUrl = page.url();

      // Format output
      const title = await page.title();
      const lines: string[] = [`page: ${page.url()} — "${title}"`, ""];

      for (const item of snapshot) {
        const indent = compact ? "" : "  ".repeat(item.depth);
        const stateStr = item.states.length > 0 ? ` (${item.states.join(", ")})` : "";
        const nameStr = item.name ? ` "${item.name}"` : "";
        lines.push(`${indent}[${item.ref}] ${item.role}${nameStr}${stateStr}`);
      }

      lines.push("");
      lines.push(`${snapshot.length} elements indexed. Use browser.act(ref, action) to interact.`);

      return truncate(lines.join("\n"), MAX_TEXT * 2);
    } catch (err) {
      return `Error taking snapshot: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

registerSkill({
  name: "browser.act",
  description:
    `Perform an action on a page element identified by its ref number from browser.snapshot.
Actions: click, type, clear, hover, focus, select.
Much more reliable than CSS selectors — uses the ref from the last semantic snapshot.

Examples:
  browser.act(ref=3, action=click)
  browser.act(ref=5, action=type, text="hello world")
  browser.act(ref=8, action=select, value="option2")`,
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      ref: { type: "string", description: "Element ref number from browser.snapshot" },
      action: {
        type: "string",
        description: "Action: click, type, clear, hover, focus, select, check, uncheck",
      },
      text: { type: "string", description: "Text to type (for action=type)" },
      value: { type: "string", description: "Value to select (for action=select)" },
    },
    required: ["ref", "action"],
  },
  async execute(args): Promise<string> {
    const ref = Number(args.ref);
    const action = args.action as string;
    const text = args.text as string | undefined;
    const value = args.value as string | undefined;

    if (isNaN(ref) || ref < 1) return "Error: ref must be a positive number from browser.snapshot.";

    const selector = lastRefMap.get(ref);
    if (!selector) {
      return `Error: ref ${ref} not found. Take a new browser.snapshot first — refs expire when the page changes. Last snapshot was for: ${lastSnapshotUrl || "none"}`;
    }

    const page = await browserManager.getPage();

    try {
      const el = await page.$(selector);
      if (!el) {
        return `Error: element [ref=${ref}] no longer exists in the DOM. The page may have changed — take a new browser.snapshot.`;
      }

      switch (action) {
        case "click":
          await el.click();
          return `Clicked [ref=${ref}]. Page: ${page.url()}`;

        case "type":
          if (!text) return "Error: 'text' is required for action=type.";
          await el.click();
          await el.type(text);
          return `Typed "${text.length > 50 ? text.slice(0, 50) + "..." : text}" into [ref=${ref}].`;

        case "clear":
          await el.click({ count: 3 }); // select all
          await page.keyboard.press("Backspace");
          return `Cleared [ref=${ref}].`;

        case "hover":
          await el.hover();
          return `Hovering [ref=${ref}].`;

        case "focus":
          await el.focus();
          return `Focused [ref=${ref}].`;

        case "select":
          if (!value) return "Error: 'value' is required for action=select.";
          await page.select(selector, value);
          return `Selected "${value}" in [ref=${ref}].`;

        case "check":
          await page.evaluate((s: string) => {
            const el = document.querySelector(s) as HTMLInputElement;
            if (el && !el.checked) el.click();
          }, selector);
          return `Checked [ref=${ref}].`;

        case "uncheck":
          await page.evaluate((s: string) => {
            const el = document.querySelector(s) as HTMLInputElement;
            if (el && el.checked) el.click();
          }, selector);
          return `Unchecked [ref=${ref}].`;

        default:
          return `Error: unknown action "${action}". Use: click, type, clear, hover, focus, select, check, uncheck.`;
      }
    } catch (err) {
      return `Error acting on [ref=${ref}]: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});
