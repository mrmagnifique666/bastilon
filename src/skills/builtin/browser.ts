/**
 * Built-in skills: browser.*
 * Playwright-based browser automation — admin only (migrated from Puppeteer).
 */
import { registerSkill } from "../loader.js";
import { browserManager, type Page } from "../../browser/manager.js";
import { config } from "../../config/env.js";
import { log } from "../../utils/log.js";
import { getBotPhotoFn } from "./telegram.js";
import { handleCaptchaIfPresent, CaptchaSolver } from "../../browser/captcha-solver.js";

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

  // Validate chatId — must be a positive number (not a fake agent chatId like 100-106)
  if (!chatId || isNaN(chatId) || chatId <= 0) {
    log.warn(`[browser] Invalid chatId ${chatId} — skipping screenshot send`);
    return `Screenshot skipped: invalid chatId (${chatId}). Page: ${page.url()}`;
  }

  let buffer: Buffer;
  if (selector) {
    const el = page.locator(selector).first();
    const count = await el.count();
    if (count === 0) return `Error: element not found for selector "${selector}".`;
    buffer = Buffer.from(await el.screenshot());
  } else {
    buffer = Buffer.from(await page.screenshot({ fullPage: false }));
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

// ── Skills ───────────────────────────────────────────────────

registerSkill({
  name: "browser.navigate",
  description:
    "Navigate to a URL. Returns page title and text content. Optionally takes a screenshot.",
  adminOnly: false,
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

    // Auto-detect and solve CAPTCHAs after navigation
    let captchaInfo = "";
    try {
      const captchaResult = await handleCaptchaIfPresent(page);
      if (captchaResult) {
        if (captchaResult.success) {
          captchaInfo = `\n🔓 CAPTCHA (${captchaResult.method}) solved in ${captchaResult.timeMs}ms`;
          // Wait for page to update after CAPTCHA solve
          await page.waitForTimeout(2000);
        } else {
          captchaInfo = `\n⚠️ CAPTCHA detected (${captchaResult.method}) but solve failed: ${captchaResult.error}`;
        }
      }
    } catch (err) {
      log.warn(`[browser] CAPTCHA handler error: ${err instanceof Error ? err.message : String(err)}`);
    }

    const title = await page.title();
    const text = await page.evaluate(() => document.body?.innerText || "");

    let result = `Navigated to: ${page.url()}\nTitle: ${title}${captchaInfo}\n\n${truncate(text)}`;

    if (wantScreenshot && chatId) {
      const ssResult = await takeAndSendScreenshot(chatId);
      result += `\n\n${ssResult}`;
    }

    return result;
  },
});

registerSkill({
  name: "browser.captcha",
  description:
    "Detect and solve CAPTCHAs on the current page. Supports reCAPTCHA v2/v3, hCaptcha, Cloudflare Turnstile, and Cloudflare JS challenges.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      action: { type: "string", description: "'detect' to check for CAPTCHAs, 'solve' to attempt solving" },
    },
  },
  async execute(args): Promise<string> {
    const action = (args.action as string) || "solve";
    const page = await browserManager.getPage();
    const solver = new CaptchaSolver(page);

    if (action === "detect") {
      const detection = await solver.detect();
      return `CAPTCHA Detection:\n- Type: ${detection.type}\n- Site Key: ${detection.siteKey || 'N/A'}\n- Page: ${detection.pageUrl}\n- Confidence: ${(detection.confidence * 100).toFixed(0)}%`;
    }

    const result = await solver.solve();
    if (result.success) {
      return `✅ CAPTCHA solved!\n- Method: ${result.method}\n- Time: ${result.timeMs}ms${result.token ? `\n- Token: ${result.token.slice(0, 30)}...` : ''}`;
    } else {
      return `❌ CAPTCHA solve failed\n- Method: ${result.method}\n- Error: ${result.error}\n- Time: ${result.timeMs}ms`;
    }
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
      text: { type: "string", description: "Visible text to find and click" },
    },
  },
  async execute(args): Promise<string> {
    const selector = args.selector as string | undefined;
    const text = args.text as string | undefined;

    if (!selector && !text) return "Error: provide either 'selector' or 'text'.";

    const page = await browserManager.getPage();

    try {
      if (selector) {
        await page.locator(selector).first().click({ timeout: config.browserTimeoutMs });
      } else {
        // Playwright native text-based click — much better than XPath
        await page.getByText(text!, { exact: false }).first().click({ timeout: config.browserTimeoutMs });
      }

      // Wait for page to settle after click
      await page.waitForTimeout(1500);
      const url = page.url();
      const title = await page.title();
      const visibleText = await page.evaluate(() => {
        const body = document.body?.innerText || "";
        return body.slice(0, 800);
      }).catch(() => "");
      return `Clicked ${selector || `"${text}"`}.\n\nPage after click:\n- URL: ${url}\n- Title: ${title}\n- Visible text (first 800 chars):\n${visibleText}\n\nTIP: Use browser.screenshot() if you need to see the page visually. Use browser.click or browser.type to continue.`;
    } catch (err) {
      return `Error clicking: ${err instanceof Error ? err.message : String(err)}.\n\nTIP: Take a browser.screenshot() to see the current state of the page and find the right selector.`;
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
      const locator = page.locator(selector).first();
      await locator.waitFor({ timeout: config.browserTimeoutMs });

      if (clear) {
        await locator.fill(""); // Playwright's fill() clears first
      }

      await locator.fill(text); // fill() is more reliable than type() for forms

      const url = page.url();
      const title = await page.title();
      return `Typed "${text.length > 50 ? text.slice(0, 50) + "..." : text}" into ${selector}.\n\nPage: ${url} — ${title}\nTIP: Use browser.click() to submit the form, or browser.screenshot() to see the current state.`;
    } catch (err) {
      return `Error typing: ${err instanceof Error ? err.message : String(err)}.\n\nTIP: Take a browser.screenshot() to see the page and find the right selector.`;
    }
  },
});

registerSkill({
  name: "browser.extract",
  description:
    "Extract content from the current page, optionally from a specific element.",
  adminOnly: false,
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
      const locator = page.locator(selector).first();
      const count = await locator.count();
      if (count === 0) return `Error: element not found for selector "${selector}".`;

      let content: string;
      if (format === "html") {
        content = await locator.evaluate(el => el.outerHTML);
      } else {
        content = await locator.innerText();
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

// ── Computer Use (Vision-based) ─────────────────────────────

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
    "Autonomous browser control via screenshot analysis. Give a goal and the bot takes screenshots, analyzes them with Gemini vision, and clicks/types at coordinates to achieve the goal.",
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
      const screenshotBuffer = Buffer.from(await page.screenshot({ fullPage: false }));
      const base64 = screenshotBuffer.toString("base64");

      await sendPhoto(chatId, screenshotBuffer, `Step ${step}/${maxSteps}`);

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

      try {
        switch (action.action) {
          case "click":
            await page.mouse.click(action.x, action.y);
            steps.push(`Step ${step}: click(${action.x}, ${action.y})`);
            break;

          case "double_click":
            await page.mouse.dblclick(action.x, action.y);
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
            await page.keyboard.press(action.key);
            steps.push(`Step ${step}: key(${action.key})`);
            break;

          case "scroll": {
            const delta = (action.direction === "down" ? 1 : -1) * (action.amount || 3) * 100;
            await page.mouse.move(action.x || 640, action.y || 360);
            await page.mouse.wheel(0, delta);
            steps.push(
              `Step ${step}: scroll(${action.direction}, amount=${action.amount || 3})`
            );
            break;
          }

          case "done":
            steps.push(`Step ${step}: DONE — ${action.summary}`);
            const finalBuffer = Buffer.from(await page.screenshot({ fullPage: false }));
            await sendPhoto(chatId, finalBuffer, `Done: ${action.summary}`);
            return `Computer use completed in ${step} steps.\n\n${steps.join("\n")}\n\nResult: ${action.summary}`;
        }
      } catch (err) {
        steps.push(
          `Step ${step}: Error executing ${action.action}: ${err instanceof Error ? err.message : String(err)}`
        );
        break;
      }

      await page.waitForTimeout(500);
    }

    return `Computer use finished after ${steps.length} steps.\n\n${steps.join("\n")}`;
  },
});

// ── Additional Skills ────────────────────────────────────────

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
        await page.locator(selector).first().evaluate(
          (el: HTMLElement, opts: { dir: string; amt: number }) => {
            el.scrollBy(0, opts.dir === "down" ? opts.amt : -opts.amt);
          },
          { dir: direction, amt: amount }
        );
        return `Scrolled ${direction} ${amount}px within ${selector}`;
      }

      const delta = direction === "down" ? amount : -amount;
      await page.mouse.wheel(0, delta);
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
      const result = await page.locator(selector).first().selectOption(value);
      return `Selected value "${value}" in ${selector}. Selected: [${Array.isArray(result) ? result.join(", ") : result}]`;
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
        await page.waitForTimeout(Math.min(delay, 30000));
        return `Waited ${delay}ms.`;
      }

      if (selector) {
        await page.locator(selector).first().waitFor({ timeout });
        return `Element appeared: ${selector}`;
      }

      if (text) {
        await page.getByText(text).first().waitFor({ timeout });
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

    const ctx = browserManager.getContext();
    if (!ctx) return "Error: no browser context active.";

    try {
      const pages = ctx.pages();

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
          const newPage = await ctx.newPage();
          if (url) {
            const urlError = validateUrl(url);
            if (urlError) return `Error: ${urlError}`;
            await newPage.goto(url, {
              waitUntil: "domcontentloaded",
              timeout: config.browserTimeoutMs,
            });
          }
          await newPage.bringToFront();
          const updatedPages = ctx.pages();
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
    const ctx = browserManager.getContext();
    const page = await browserManager.getPage();

    if (!ctx) return "Error: no browser context active.";

    try {
      switch (action) {
        case "get": {
          const cookies = await ctx.cookies();
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
          await ctx.addCookies([{
            name,
            value: value || "",
            domain: domain || currentUrl.hostname,
            path: "/",
          }]);
          return `Cookie set: ${name}=${value}`;
        }

        case "clear": {
          await ctx.clearCookies(name ? { name } : undefined);
          return name ? `Cleared cookies named "${name}".` : "Cleared all cookies.";
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
      // Playwright natively supports combos like "Control+a"
      await page.keyboard.press(keys);
      return `Pressed: ${keys}`;
    } catch (err) {
      return `Error pressing keys: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

// ── Semantic Snapshots (OpenClaw-inspired) ───────────────────

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
  adminOnly: false,
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
      // Use Playwright's built-in accessibility tree API
      if (!page.accessibility) return "Error: browser accessibility API not available. Navigate to a page first.";
      const accessibilityTree = await page.accessibility.snapshot({ interestingOnly: interactiveOnly });

      if (!accessibilityTree) {
        return "Error: could not capture accessibility tree.";
      }

      // Also inject data-bastilon-ref for browser.act compatibility
      const snapshot = await page.evaluate((interactiveFlag: boolean) => {
        const INTERACTIVE_SELECTOR = [
          "a[href]", "button", "input:not([type=hidden])", "select", "textarea",
          "[role=button]", "[role=tab]", "[role=menuitem]",
          "[role=checkbox]", "[role=radio]", "[role=slider]",
          "[role=textbox]", "[role=combobox]", "[role=searchbox]",
          "[role=option]", "[onclick]", "[tabindex]",
        ].join(",");

        const LANDMARK_SELECTOR = [
          "h1", "h2", "h3", "h4", "h5", "h6",
          "nav", "main", "header", "footer", "aside", "section", "form",
          "[role=heading]", "[role=navigation]", "[role=main]", "[role=banner]",
          "[role=dialog]", "[role=alert]", "img[alt]",
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
            case "form": return "form";
            case "details": return "group";
            case "summary": return "button";
            default: return tag;
          }
        }

        function getName(el: Element): string {
          const ariaLabel = el.getAttribute("aria-label");
          if (ariaLabel) return ariaLabel.trim();
          const labelledBy = el.getAttribute("aria-labelledby");
          if (labelledBy) {
            const ref = document.getElementById(labelledBy);
            if (ref) return ref.textContent?.trim() || "";
          }
          if (el.tagName === "IMG") return (el as HTMLImageElement).alt || "";
          const placeholder = (el as HTMLInputElement).placeholder;
          if (placeholder) return placeholder;
          const title = el.getAttribute("title");
          if (title) return title.trim();
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
          if ((el as HTMLInputElement).value) {
            const v = (el as HTMLInputElement).value;
            if (v.length > 0 && v.length <= 40) states.push(`value="${v}"`);
            else if (v.length > 40) states.push(`value="${v.slice(0, 37)}..."`);
          }
          return states;
        }

        const selector = interactiveFlag
          ? INTERACTIVE_SELECTOR + "," + LANDMARK_SELECTOR
          : "*";
        const elements = document.querySelectorAll(selector);
        const results: Array<{
          ref: number; role: string; name: string; states: string[];
          depth: number; selector: string;
        }> = [];

        let refCounter = 1;
        elements.forEach((el) => {
          const style = window.getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden") return;
          if ((el as HTMLElement).offsetWidth === 0 && (el as HTMLElement).offsetHeight === 0) return;
          const role = getRole(el);
          if (role === "generic") return;
          const name = getName(el);
          const states = getState(el);
          const ref = refCounter++;
          el.setAttribute("data-bastilon-ref", String(ref));
          let depth = 0;
          let parent = el.parentElement;
          while (parent) {
            if (parent.hasAttribute("data-bastilon-ref")) depth++;
            parent = parent.parentElement;
          }
          results.push({ ref, role, name, states, depth, selector: `[data-bastilon-ref="${ref}"]` });
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
Actions: click, type, fill, clear, hover, focus, select, check, uncheck.
Much more reliable than CSS selectors — uses the ref from the last semantic snapshot.

Examples:
  browser.act(ref=3, action=click)
  browser.act(ref=5, action=fill, text="hello world")
  browser.act(ref=8, action=select, value="option2")`,
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      ref: { type: "string", description: "Element ref number from browser.snapshot" },
      action: {
        type: "string",
        description: "Action: click, type, fill, clear, hover, focus, select, check, uncheck",
      },
      text: { type: "string", description: "Text for action=type or action=fill" },
      value: { type: "string", description: "Value for action=select" },
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
      const locator = page.locator(selector).first();
      const count = await locator.count();
      if (count === 0) {
        return `Error: element [ref=${ref}] no longer exists in the DOM. The page may have changed — take a new browser.snapshot.`;
      }

      switch (action) {
        case "click":
          await locator.click();
          return `Clicked [ref=${ref}]. Page: ${page.url()}`;

        case "type":
          if (!text) return "Error: 'text' is required for action=type.";
          await locator.pressSequentially(text, { delay: 50 });
          return `Typed "${text.length > 50 ? text.slice(0, 50) + "..." : text}" into [ref=${ref}].`;

        case "fill":
          if (!text) return "Error: 'text' is required for action=fill.";
          await locator.fill(text);
          return `Filled "${text.length > 50 ? text.slice(0, 50) + "..." : text}" into [ref=${ref}].`;

        case "clear":
          await locator.fill("");
          return `Cleared [ref=${ref}].`;

        case "hover":
          await locator.hover();
          return `Hovering [ref=${ref}].`;

        case "focus":
          await locator.focus();
          return `Focused [ref=${ref}].`;

        case "select":
          if (!value) return "Error: 'value' is required for action=select.";
          await locator.selectOption(value);
          return `Selected "${value}" in [ref=${ref}].`;

        case "check":
          await locator.check();
          return `Checked [ref=${ref}].`;

        case "uncheck":
          await locator.uncheck();
          return `Unchecked [ref=${ref}].`;

        default:
          return `Error: unknown action "${action}". Use: click, type, fill, clear, hover, focus, select, check, uncheck.`;
      }
    } catch (err) {
      return `Error acting on [ref=${ref}]: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

// ── Browser Management ──────────────────────────────────────

registerSkill({
  name: "browser.restart",
  description:
    "Force restart the browser process. Use when the browser is hung, unresponsive, or in a bad state. The browser runs in an isolated process, so restart is safe.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {},
  },
  async execute(): Promise<string> {
    try {
      await browserManager.restart();
      return "Browser server restarted successfully. Take a new browser.snapshot or browser.navigate to use it.";
    } catch (err) {
      return `Error restarting browser: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

registerSkill({
  name: "browser.status",
  description: "Check if the browser is running and connected.",
  adminOnly: false,
  argsSchema: {
    type: "object",
    properties: {},
  },
  async execute(): Promise<string> {
    const alive = browserManager.isAlive();
    if (alive) {
      try {
        const page = await browserManager.getPage();
        const url = page.url();
        const title = await page.title();
        return `Browser: RUNNING (Playwright + Chromium, process isolated)\nCurrent page: ${url}\nTitle: ${title}`;
      } catch {
        return "Browser: CONNECTED but page error. Try browser.restart().";
      }
    }
    return "Browser: NOT RUNNING (will auto-launch on next browser.* call)";
  },
});

// ── browser.setup_session — Launch visible browser for manual login ──

registerSkill({
  name: "browser.setup_session",
  description:
    "Launch a VISIBLE browser for Nicolas to log into websites (Facebook, Gmail, etc.). Sessions are saved and reused by Kingston. Call browser.save_session when done.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "URL to open (e.g. 'https://facebook.com'). Default: blank tab",
      },
    },
  },
  async execute(args): Promise<string> {
    const url = args.url ? String(args.url) : undefined;
    try {
      await browserManager.launchForLogin(url);
      return `Browser VISIBLE lancé${url ? ` sur ${url}` : ""}. Connecte-toi à tes comptes, puis dis-moi quand c'est fait — j'appellerai browser.save_session pour sauvegarder.`;
    } catch (err) {
      return `Erreur lancement browser: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

// ── browser.save_session — Save cookies/localStorage after manual login ──

registerSkill({
  name: "browser.save_session",
  description:
    "Save current browser session (cookies, localStorage) to disk. Also extracts per-domain sessions. Call after browser.setup_session when user has finished logging in.",
  adminOnly: true,
  argsSchema: { type: "object", properties: {} },
  async execute(): Promise<string> {
    try {
      const stateFile = await browserManager.saveSession();

      // Also save per-domain session files for targeted reuse
      const fs = await import("node:fs");
      const sessionData = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      const domains = new Set<string>();

      // Extract unique domains from cookies
      if (sessionData.cookies) {
        for (const cookie of sessionData.cookies) {
          const domain = cookie.domain.replace(/^\./, "");
          domains.add(domain);
        }
      }

      // Save per-domain session info in accounts dir
      const accountsDir = path.join(process.cwd(), "relay", "accounts");
      if (!fs.existsSync(accountsDir)) fs.mkdirSync(accountsDir, { recursive: true });

      const savedDomains: string[] = [];
      for (const domain of domains) {
        // Filter cookies for this domain
        const domainCookies = sessionData.cookies.filter((c: any) =>
          c.domain === domain || c.domain === `.${domain}` || domain.endsWith(c.domain.replace(/^\./, ""))
        );
        if (domainCookies.length === 0) continue;

        // Check if we have a meaningful session (auth cookies)
        const hasAuth = domainCookies.some((c: any) =>
          /session|token|auth|sid|user|login|csrf|_id/i.test(c.name)
        );
        if (!hasAuth) continue;

        const accountFile = path.join(accountsDir, `${domain}.json`);
        const existing = fs.existsSync(accountFile)
          ? JSON.parse(fs.readFileSync(accountFile, "utf-8"))
          : {};

        // Update with session info
        existing.domain = domain;
        existing.has_session = true;
        existing.session_saved = new Date().toISOString();
        existing.cookie_count = domainCookies.length;
        existing.method = existing.method || "manual_login";

        fs.writeFileSync(accountFile, JSON.stringify(existing, null, 2));
        savedDomains.push(domain);
      }

      const domainList = savedDomains.length > 0
        ? `\nSessions par domaine: ${savedDomains.join(", ")}`
        : "";
      return `Session globale sauvegardée dans ${stateFile}.${domainList}\nKingston réutilisera ces cookies pour naviguer. Le browser reste ouvert — ferme-le quand tu veux.`;
    } catch (err) {
      return `Erreur sauvegarde session: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

// ── browser.grab_session — Import cookies from Nicolas's Chrome ──────────

registerSkill({
  name: "browser.grab_session",
  description:
    "Connect to Nicolas's running Chrome (via CDP) to grab his active sessions/cookies. " +
    "If Chrome isn't running with CDP, launches it with --remote-debugging-port. " +
    "After Nicolas logs into sites in his Chrome, Kingston can grab those cookies. " +
    "Usage: 1) Nicolas opens a site and logs in. 2) Kingston calls browser.grab_session to import cookies. " +
    "Optional: specify domain to only grab cookies for that domain.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      domain: {
        type: "string",
        description: "Only grab cookies for this domain (e.g. 'reddit.com'). Default: grab all.",
      },
      cdp_url: {
        type: "string",
        description: "CDP URL (default: http://localhost:9222)",
      },
      launch: {
        type: "string",
        description: 'Set to "true" to launch Chrome with CDP enabled if not running',
      },
    },
  },
  async execute(args): Promise<string> {
    const targetDomain = args.domain ? String(args.domain).replace(/^www\./, "") : null;
    const cdpUrl = String(args.cdp_url || "http://localhost:9222");
    const shouldLaunch = String(args.launch) === "true";
    const fs = await import("node:fs");
    const path = await import("node:path");

    const results: string[] = ["**browser.grab_session**\n"];

    try {
      // Step 1: Try connecting to Chrome via CDP
      let cdpBrowser: import("playwright").Browser | null = null;

      try {
        // Try to discover the WebSocket endpoint
        const resp = await fetch(`${cdpUrl}/json/version`, { signal: AbortSignal.timeout(3000) });
        const data = await resp.json();
        const wsUrl = data.webSocketDebuggerUrl;
        if (wsUrl) {
          const { chromium } = await import("playwright");
          cdpBrowser = await chromium.connectOverCDP(wsUrl);
          results.push(`Connecté au Chrome de Nicolas via CDP (${wsUrl.slice(0, 40)}...)`);
        }
      } catch {
        // CDP not available — try direct URL
        try {
          const { chromium } = await import("playwright");
          cdpBrowser = await chromium.connectOverCDP(cdpUrl);
          results.push(`Connecté via CDP direct: ${cdpUrl}`);
        } catch {
          if (shouldLaunch) {
            // Launch Chrome with CDP
            const chromePath = config.browserChromePath ||
              "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
            try {
              const { exec } = await import("node:child_process");
              exec(`"${chromePath}" --remote-debugging-port=9222 --no-first-run`);
              results.push("Chrome lancé avec CDP (port 9222). Attente 3s...");
              await new Promise(r => setTimeout(r, 3000));

              // Retry connection
              const { chromium } = await import("playwright");
              cdpBrowser = await chromium.connectOverCDP(cdpUrl);
              results.push("Connecté au Chrome fraîchement lancé!");
            } catch (launchErr) {
              return `${results.join("\n")}\n\n❌ Impossible de lancer Chrome: ${launchErr instanceof Error ? launchErr.message : String(launchErr)}\n\nSolution: Lance Chrome manuellement avec:\nchrome.exe --remote-debugging-port=9222`;
            }
          } else {
            return `${results.join("\n")}\n\n❌ Chrome n'est pas joignable via CDP sur ${cdpUrl}.\n\n**2 solutions:**\n1. Lance Chrome avec CDP:\n   chrome.exe --remote-debugging-port=9222\n2. Utilise browser.grab_session(launch:"true") pour que je le lance.\n3. Ou utilise browser.setup_session → je t'ouvre MON browser, tu te connectes, puis browser.save_session.`;
          }
        }
      }

      if (!cdpBrowser) {
        return `${results.join("\n")}\n\n❌ Connexion CDP échouée.`;
      }

      // Step 2: Extract cookies from all contexts
      const contexts = cdpBrowser.contexts();
      let allCookies: any[] = [];

      for (const ctx of contexts) {
        const cookies = await ctx.cookies();
        allCookies.push(...cookies);
      }

      // If no contexts have cookies, try default context pages
      if (allCookies.length === 0) {
        const pages = cdpBrowser.contexts().flatMap(c => c.pages());
        if (pages.length > 0) {
          results.push(`Chrome a ${pages.length} onglet(s) ouvert(s), mais 0 cookies accessibles via contexts.`);
          // Try to get cookies from CDP directly
          for (const page of pages) {
            try {
              const cdpSession = await page.context().newCDPSession(page);
              const { cookies } = await cdpSession.send("Network.getAllCookies");
              allCookies.push(...(cookies as any[]));
              await cdpSession.detach();
              break; // Got cookies from one page, that's enough
            } catch { continue; }
          }
        }
      }

      results.push(`${allCookies.length} cookies récupérés depuis Chrome.`);

      // Step 3: Filter by domain if specified
      let filteredCookies = allCookies;
      if (targetDomain) {
        filteredCookies = allCookies.filter((c: any) => {
          const cookieDomain = (c.domain || "").replace(/^\./, "");
          return cookieDomain === targetDomain ||
            cookieDomain.endsWith(`.${targetDomain}`) ||
            targetDomain.endsWith(cookieDomain);
        });
        results.push(`${filteredCookies.length} cookies pour ${targetDomain}.`);
      }

      if (filteredCookies.length === 0) {
        // Disconnect cleanly
        try { await cdpBrowser.close(); } catch { /* ignore */ }
        return `${results.join("\n")}\n\n⚠️ Aucun cookie trouvé${targetDomain ? ` pour ${targetDomain}` : ""}. Nicolas doit d'abord se connecter au site dans Chrome.`;
      }

      // Step 4: Convert CDP cookies to Playwright format and merge with existing state
      const profileDir = path.join(process.cwd(), "relay", "browser-profile");
      if (!fs.existsSync(profileDir)) fs.mkdirSync(profileDir, { recursive: true });
      const stateFile = path.join(profileDir, "state.json");

      let existingState: { cookies: any[]; origins: any[] } = { cookies: [], origins: [] };
      if (fs.existsSync(stateFile)) {
        try {
          existingState = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
        } catch { /* corrupt state, start fresh */ }
      }

      // Convert cookies to Playwright storageState format
      const playwrightCookies = filteredCookies.map((c: any) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path || "/",
        expires: c.expires || -1,
        httpOnly: c.httpOnly || false,
        secure: c.secure || false,
        sameSite: (c.sameSite === "strict" ? "Strict" : c.sameSite === "lax" ? "Lax" : "None") as "Strict" | "Lax" | "None",
      }));

      // Merge: replace existing cookies for same domain/name/path, add new ones
      const cookieKey = (c: any) => `${c.domain}|${c.name}|${c.path}`;
      const existingMap = new Map(existingState.cookies.map((c: any) => [cookieKey(c), c]));

      for (const cookie of playwrightCookies) {
        existingMap.set(cookieKey(cookie), cookie);
      }

      existingState.cookies = Array.from(existingMap.values());
      fs.writeFileSync(stateFile, JSON.stringify(existingState, null, 2), "utf-8");

      // Step 5: Also save per-domain account metadata
      const domains = new Set<string>();
      for (const c of filteredCookies) {
        const d = (c.domain || "").replace(/^\./, "");
        if (d) domains.add(d);
      }

      const accountsDir = path.join(process.cwd(), "relay", "accounts");
      if (!fs.existsSync(accountsDir)) fs.mkdirSync(accountsDir, { recursive: true });

      const savedDomains: string[] = [];
      for (const domain of domains) {
        const domainCookies = filteredCookies.filter((c: any) => {
          const d = (c.domain || "").replace(/^\./, "");
          return d === domain || d.endsWith(`.${domain}`);
        });

        const hasAuth = domainCookies.some((c: any) =>
          /session|token|auth|sid|user|login|csrf|_id|access/i.test(c.name)
        );
        if (!hasAuth && domainCookies.length < 3) continue;

        const accountFile = path.join(accountsDir, `${domain}.json`);
        const existing = fs.existsSync(accountFile)
          ? JSON.parse(fs.readFileSync(accountFile, "utf-8"))
          : {};

        existing.domain = domain;
        existing.has_session = true;
        existing.session_grabbed = new Date().toISOString();
        existing.cookie_count = domainCookies.length;
        existing.method = existing.method || "grabbed_from_chrome";

        fs.writeFileSync(accountFile, JSON.stringify(existing, null, 2));
        savedDomains.push(domain);
      }

      // Disconnect from Nicolas's Chrome (don't close it!)
      try { await cdpBrowser.close(); } catch { /* ignore */ }

      results.push(`\n✅ **${playwrightCookies.length} cookies importés** dans state.json`);
      if (savedDomains.length > 0) {
        results.push(`Domaines avec sessions auth: ${savedDomains.join(", ")}`);
      }
      results.push(`\nKingston peut maintenant naviguer ces sites avec les sessions de Nicolas.`);
      results.push(`Utilise browser.navigate(url:"...") pour aller sur le site — les cookies seront chargés automatiquement.`);

      return results.join("\n");
    } catch (err) {
      return `${results.join("\n")}\n\n❌ Erreur: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});
