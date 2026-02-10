/**
 * Browser manager — lazy singleton for Puppeteer.
 * Supports three modes: headless, visible, connect.
 * Features: stealth plugin (anti-detection), auto-connect fallback,
 * human-like behavior helpers, persistent profile support.
 * Auto-closes/disconnects after idle timeout.
 */
import puppeteerExtra from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import puppeteerVanilla, { type Browser, type Page } from "puppeteer";
import { config } from "../config/env.js";
import { log } from "../utils/log.js";

// Activate stealth plugin — patches ~10 bot detection vectors:
// navigator.webdriver, chrome.runtime, WebGL fingerprint, permissions, etc.
puppeteerExtra.use(StealthPlugin());

/** Human-like random delay */
export function humanDelay(minMs = 50, maxMs = 300): Promise<void> {
  const ms = Math.floor(Math.random() * (maxMs - minMs) + minMs);
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Human-like mouse click — random offset within element, curved movement */
export async function humanClick(page: Page, selector: string): Promise<void> {
  const el = await page.waitForSelector(selector, { timeout: 10_000 });
  if (!el) throw new Error(`Element not found: ${selector}`);
  const box = await el.boundingBox();
  if (!box) throw new Error(`No bounding box for: ${selector}`);

  // Random point within element (not dead center)
  const x = box.x + box.width * (0.2 + Math.random() * 0.6);
  const y = box.y + box.height * (0.2 + Math.random() * 0.6);

  const steps = Math.floor(Math.random() * 15) + 10;
  await page.mouse.move(x, y, { steps });
  await humanDelay(30, 150);
  await page.mouse.click(x, y);
  await humanDelay(100, 400);
}

/** Human-like typing — variable delay per keystroke */
export async function humanType(page: Page, selector: string, text: string): Promise<void> {
  await humanClick(page, selector);
  for (const char of text) {
    await page.keyboard.type(char, {
      delay: Math.floor(Math.random() * 120) + 30, // 30-150ms per key
    });
  }
}

/** Try to discover CDP WebSocket endpoint from a running Chrome */
async function discoverCdpEndpoint(url: string): Promise<string | null> {
  try {
    const res = await fetch(`${url}/json/version`);
    const data = await res.json() as { webSocketDebuggerUrl?: string };
    return data.webSocketDebuggerUrl || null;
  } catch {
    return null;
  }
}

class BrowserManager {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private mode: "headless" | "visible" | "connect" = "headless";

  /** Get (or lazily create) the shared page */
  async getPage(): Promise<Page> {
    // If browser died or was disconnected, clean up
    if (this.browser && !this.browser.connected) {
      log.warn("[browser] Browser disconnected — will relaunch");
      this.browser = null;
      this.page = null;
    }

    if (!this.browser) {
      this.mode = config.browserMode;

      switch (this.mode) {
        case "connect": {
          this.browser = await this.connectToChrome();
          break;
        }

        case "visible": {
          log.info("[browser] Launching visible Chrome with stealth...");
          this.browser = await puppeteerExtra.launch({
            headless: false,
            defaultViewport: null,
            executablePath: config.browserChromePath || undefined,
            args: [
              `--window-size=${config.browserViewportWidth},${config.browserViewportHeight}`,
              "--no-sandbox",
              "--disable-setuid-sandbox",
              "--disable-blink-features=AutomationControlled",
            ],
          });
          log.info("[browser] Visible Chrome launched (stealth active)");
          break;
        }

        default: {
          // headless
          log.info("[browser] Launching headless Chromium with stealth...");
          this.browser = await puppeteerExtra.launch({
            headless: true,
            args: [
              "--no-sandbox",
              "--disable-setuid-sandbox",
              "--disable-dev-shm-usage",
              "--disable-blink-features=AutomationControlled",
            ],
          });
          log.info("[browser] Headless Chromium launched (stealth active)");
          break;
        }
      }

      this.browser.on("disconnected", () => {
        log.warn("[browser] Browser process disconnected");
        this.browser = null;
        this.page = null;
      });
    }

    if (!this.page || this.page.isClosed()) {
      if (this.mode === "connect") {
        // In connect mode, reuse first existing tab
        const pages = await this.browser.pages();
        this.page = pages[0] || (await this.browser.newPage());
      } else {
        this.page = await this.browser.newPage();
      }
      // Apply stealth patches to new pages in connect mode
      // (puppeteer-extra patches launch() pages automatically, but not connect())
      if (this.mode === "connect") {
        await this.applyStealthToPage(this.page);
      }
      // In headless mode, set viewport explicitly
      if (this.mode === "headless") {
        await this.page.setViewport({
          width: config.browserViewportWidth,
          height: config.browserViewportHeight,
        });
      }
      log.debug(
        `[browser] Page ready (${config.browserViewportWidth}x${config.browserViewportHeight})`
      );
    }

    this.resetIdleTimer();
    return this.page;
  }

  /** Connect to an existing Chrome with auto-discovery fallback */
  private async connectToChrome(): Promise<Browser> {
    const url = config.browserCdpUrl || "http://localhost:9222";

    // Try WebSocket endpoint first (more reliable)
    const wsEndpoint = await discoverCdpEndpoint(url);
    if (wsEndpoint) {
      log.info(`[browser] Connecting via WebSocket: ${wsEndpoint}`);
      const browser = await puppeteerVanilla.connect({
        browserWSEndpoint: wsEndpoint,
        defaultViewport: null,
      });
      const pages = await browser.pages();
      this.page = pages[0] || (await browser.newPage());
      log.info(`[browser] Connected to Chrome (${pages.length} existing tabs)`);
      return browser;
    }

    // Fallback: try browserURL
    try {
      log.info(`[browser] Connecting via browserURL: ${url}`);
      const browser = await puppeteerVanilla.connect({
        browserURL: url,
        defaultViewport: null,
      });
      const pages = await browser.pages();
      this.page = pages[0] || (await browser.newPage());
      log.info(`[browser] Connected to Chrome (${pages.length} existing tabs)`);
      return browser;
    } catch (err) {
      log.warn(`[browser] Cannot connect to Chrome at ${url}: ${err instanceof Error ? err.message : String(err)}`);
      log.info("[browser] Falling back to visible Chrome with stealth...");
      // Launch visible Chrome with stealth as fallback
      const browser = await puppeteerExtra.launch({
        headless: false,
        defaultViewport: null,
        executablePath: config.browserChromePath || undefined,
        args: [
          `--window-size=${config.browserViewportWidth},${config.browserViewportHeight}`,
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-blink-features=AutomationControlled",
          "--remote-debugging-port=9222", // Enable CDP for future connect
        ],
      });
      log.info("[browser] Launched visible Chrome (stealth, CDP port 9222)");
      this.mode = "visible"; // Update mode for close() behavior
      return browser;
    }
  }

  /** Apply anti-detection patches to a page (for connect mode) */
  private async applyStealthToPage(page: Page): Promise<void> {
    try {
      await page.evaluateOnNewDocument(() => {
        // Remove webdriver flag
        Object.defineProperty(navigator, "webdriver", { get: () => undefined });
        // Ensure chrome object exists (real Chrome has this)
        if (!(window as any).chrome) {
          (window as any).chrome = { runtime: {} };
        }
        // Spoof permissions
        const origQuery = Permissions.prototype.query;
        Permissions.prototype.query = function (params: any) {
          if (params.name === "notifications") {
            return Promise.resolve({ state: "denied" } as PermissionStatus);
          }
          return origQuery.call(this, params);
        };
      });
      log.debug("[browser] Stealth patches applied to connect-mode page");
    } catch (err) {
      log.debug(`[browser] Stealth patch warning: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Get the underlying browser instance (for tabs management) */
  getBrowser(): Browser | null {
    return this.browser;
  }

  /** Reset the idle auto-close timer */
  resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.mode === "connect") {
        log.info("[browser] Idle timeout — disconnecting from Chrome");
      } else {
        log.info("[browser] Idle timeout — closing browser");
      }
      this.close();
    }, config.browserIdleMs);
  }

  /** Close or disconnect browser and clean up */
  async close(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.browser) {
      try {
        if (this.mode === "connect") {
          // Don't kill the user's Chrome — just disconnect Puppeteer
          this.browser.disconnect();
          log.info("[browser] Disconnected from Chrome (browser still running)");
        } else {
          await this.browser.close();
          log.info("[browser] Browser closed");
        }
      } catch {
        // already closed/disconnected
      }
      this.browser = null;
      this.page = null;
    }
  }
}

export const browserManager = new BrowserManager();

// Clean up on process exit
const cleanup = () => {
  browserManager.close().catch(() => {});
};
process.on("exit", cleanup);
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
