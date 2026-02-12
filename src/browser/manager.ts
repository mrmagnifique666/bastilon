/**
 * Browser manager — lazy singleton for Playwright with PROCESS ISOLATION.
 * Uses launchServer() + connect() so the browser runs in a SEPARATE process.
 * If the browser hangs or crashes, we kill and restart it without affecting the bot.
 *
 * Supports three modes: headless, visible, connect (CDP).
 * Features: stealth scripts (anti-detection), auto-connect fallback,
 * human-like behavior helpers, auto-restart on failure.
 * Auto-closes/disconnects after idle timeout.
 */
import { chromium, type Browser, type BrowserContext, type BrowserServer, type Page } from "playwright";
import { config } from "../config/env.js";
import { log } from "../utils/log.js";

// Re-export Page type for consumers
export type { Page } from "playwright";

/** Human-like random delay */
export function humanDelay(minMs = 50, maxMs = 300): Promise<void> {
  const ms = Math.floor(Math.random() * (maxMs - minMs) + minMs);
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Human-like mouse click — random offset within element, curved movement */
export async function humanClick(page: Page, selector: string): Promise<void> {
  const el = page.locator(selector).first();
  await el.waitFor({ timeout: 10_000 });
  const box = await el.boundingBox();
  if (!box) throw new Error(`No bounding box for: ${selector}`);

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
      delay: Math.floor(Math.random() * 120) + 30,
    });
  }
}

/** Stealth scripts injected into every page context */
const STEALTH_SCRIPTS = `
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  if (!window.chrome) window.chrome = { runtime: {} };
  const origQuery = Permissions.prototype.query;
  Permissions.prototype.query = function(params) {
    if (params.name === 'notifications') return Promise.resolve({ state: 'denied' });
    return origQuery.call(this, params);
  };
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en', 'fr'] });
`;

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
  private server: BrowserServer | null = null; // Separate browser process
  private browser: Browser | null = null;      // Client connection to it
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private mode: "headless" | "visible" | "connect" = "headless";
  private restartCount = 0;
  private maxRestarts = 3;

  /** Get (or lazily create) the shared page */
  async getPage(): Promise<Page> {
    // If browser died or was disconnected, clean up and auto-restart
    if (this.browser && !this.browser.isConnected()) {
      log.warn("[browser] Browser disconnected — will restart");
      await this.cleanup(false); // Don't kill server yet
    }

    if (!this.browser) {
      this.mode = config.browserMode;

      switch (this.mode) {
        case "connect": {
          this.browser = await this.connectToChrome();
          break;
        }

        case "visible": {
          log.info("[browser] Launching visible Chromium server (isolated process)...");
          this.server = await chromium.launchServer({
            headless: false,
            executablePath: config.browserChromePath || undefined,
            args: [
              `--window-size=${config.browserViewportWidth},${config.browserViewportHeight}`,
              "--no-sandbox",
              "--disable-blink-features=AutomationControlled",
            ],
          });
          this.browser = await chromium.connect(this.server.wsEndpoint());
          log.info(`[browser] Visible Chromium launched (PID isolated, ws: ${this.server.wsEndpoint().slice(0, 40)}...)`);
          break;
        }

        default: {
          // headless — separate process via launchServer
          log.info("[browser] Launching headless Chromium server (isolated process)...");
          this.server = await chromium.launchServer({
            headless: true,
            args: [
              "--no-sandbox",
              "--disable-dev-shm-usage",
              "--disable-blink-features=AutomationControlled",
            ],
          });
          this.browser = await chromium.connect(this.server.wsEndpoint());
          log.info(`[browser] Headless Chromium launched (PID isolated, ws: ${this.server.wsEndpoint().slice(0, 40)}...)`);
          break;
        }
      }

      this.browser.on("disconnected", () => {
        log.warn("[browser] Browser client disconnected from server");
        this.browser = null;
        this.context = null;
        this.page = null;
      });

      this.restartCount = 0; // Reset on successful launch
    }

    if (!this.context) {
      if (this.mode === "connect") {
        const contexts = this.browser.contexts();
        this.context = contexts[0] || await this.browser.newContext({
          viewport: { width: config.browserViewportWidth, height: config.browserViewportHeight },
        });
      } else {
        this.context = await this.browser.newContext({
          viewport: { width: config.browserViewportWidth, height: config.browserViewportHeight },
          userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          locale: "en-US",
          timezoneId: "America/New_York",
        });
      }

      // Inject stealth scripts into every new page
      await this.context.addInitScript(STEALTH_SCRIPTS);
    }

    if (!this.page || this.page.isClosed()) {
      if (this.mode === "connect") {
        const pages = this.context.pages();
        this.page = pages[0] || await this.context.newPage();
      } else {
        this.page = await this.context.newPage();
      }
      log.debug(
        `[browser] Page ready (${config.browserViewportWidth}x${config.browserViewportHeight})`
      );
    }

    this.resetIdleTimer();
    return this.page;
  }

  /** Force restart the browser (kill server + relaunch) */
  async restart(): Promise<void> {
    if (this.restartCount >= this.maxRestarts) {
      log.error(`[browser] Max restarts (${this.maxRestarts}) reached — refusing to restart`);
      throw new Error("Browser max restarts reached. Manual intervention needed.");
    }
    this.restartCount++;
    log.warn(`[browser] Force restarting browser (attempt ${this.restartCount}/${this.maxRestarts})...`);

    await this.close();
    // getPage() will relaunch
  }

  /** Connect to an existing Chrome with auto-discovery fallback */
  private async connectToChrome(): Promise<Browser> {
    const url = config.browserCdpUrl || "http://localhost:9222";

    const wsEndpoint = await discoverCdpEndpoint(url);
    if (wsEndpoint) {
      log.info(`[browser] Connecting via CDP WebSocket: ${wsEndpoint}`);
      const browser = await chromium.connectOverCDP(wsEndpoint);
      log.info("[browser] Connected to Chrome via CDP");
      return browser;
    }

    try {
      log.info(`[browser] Connecting via CDP URL: ${url}`);
      const browser = await chromium.connectOverCDP(url);
      log.info("[browser] Connected to Chrome via CDP");
      return browser;
    } catch (err) {
      log.warn(`[browser] Cannot connect to Chrome at ${url}: ${err instanceof Error ? err.message : String(err)}`);
      log.info("[browser] Falling back to visible Chromium server...");

      this.server = await chromium.launchServer({
        headless: false,
        executablePath: config.browserChromePath || undefined,
        args: [
          `--window-size=${config.browserViewportWidth},${config.browserViewportHeight}`,
          "--no-sandbox",
          "--disable-blink-features=AutomationControlled",
          "--remote-debugging-port=9222",
        ],
      });
      const browser = await chromium.connect(this.server.wsEndpoint());
      log.info("[browser] Launched visible Chromium server (CDP port 9222)");
      this.mode = "visible";
      return browser;
    }
  }

  /** Get the underlying browser instance */
  getBrowser(): Browser | null {
    return this.browser;
  }

  /** Get the browser context */
  getContext(): BrowserContext | null {
    return this.context;
  }

  /** Check if browser is alive */
  isAlive(): boolean {
    return this.browser !== null && this.browser.isConnected();
  }

  /** Reset the idle auto-close timer */
  resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.mode === "connect") {
        log.info("[browser] Idle timeout — disconnecting from Chrome");
      } else {
        log.info("[browser] Idle timeout — closing browser server");
      }
      this.close();
    }, config.browserIdleMs);
  }

  /** Internal cleanup without killing server */
  private async cleanup(killServer = true): Promise<void> {
    if (this.browser) {
      try { await this.browser.close(); } catch { /* already closed */ }
      this.browser = null;
      this.context = null;
      this.page = null;
    }
    if (killServer && this.server) {
      try { await this.server.close(); } catch { /* already closed */ }
      this.server = null;
    }
  }

  /** Close browser and server, full cleanup */
  async close(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    await this.cleanup(true);
    log.info("[browser] Browser and server closed");
  }
}

export const browserManager = new BrowserManager();

// Clean up on process exit
const exitCleanup = () => {
  browserManager.close().catch(() => {});
};
process.on("exit", exitCleanup);
process.on("SIGINT", exitCleanup);
process.on("SIGTERM", exitCleanup);
