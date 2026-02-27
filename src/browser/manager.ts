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
import path from "node:path";
import fs from "node:fs";
import { config } from "../config/env.js";
import { log } from "../utils/log.js";
import { ENHANCED_STEALTH_SCRIPTS, handleCaptchaIfPresent, waitForCfClearance } from "./captcha-solver.js";

/** Persistent profile directory — stores cookies, localStorage, sessions */
export const BROWSER_PROFILE_DIR = path.join(process.cwd(), "relay", "browser-profile");

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

/** Stealth scripts injected into every page context.
 *  Uses ENHANCED_STEALTH_SCRIPTS from captcha-solver.ts which includes:
 *  - WebGL vendor/renderer spoofing (realistic NVIDIA GPU)
 *  - Realistic plugins/mimeTypes arrays
 *  - Hardware concurrency & device memory spoofing
 *  - Chrome runtime API spoofing
 *  - cdc_ automation property removal
 *  - Platform, language, and screen depth spoofing
 */
const STEALTH_SCRIPTS = ENHANCED_STEALTH_SCRIPTS;

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
        // Try to load saved session state for persistent cookies/localStorage
        let storageState: string | undefined;
        try {
          const stateFile = path.join(BROWSER_PROFILE_DIR, "state.json");
          if (fs.existsSync(stateFile)) {
            storageState = stateFile;
            log.info("[browser] Loading persistent session state from state.json");
          }
        } catch { /* no saved state */ }

        this.context = await this.browser.newContext({
          viewport: { width: config.browserViewportWidth, height: config.browserViewportHeight },
          userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
          locale: "en-US",
          timezoneId: "America/New_York",
          ...(storageState ? { storageState } : {}),
        });
      }

      // Inject stealth scripts — but NOT when connected to user's real Chrome via CDP
      // (stealth scripts can break sites when injected into a real profile)
      if (this.mode !== "connect") {
        await this.context.addInitScript(STEALTH_SCRIPTS);
      }
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

  /** Connect to an existing Chrome with auto-discovery fallback.
   *  Uses ensureChromeWithCdp() from chrome-cdp.ts to guarantee CDP availability. */
  private async connectToChrome(): Promise<Browser> {
    const url = config.browserCdpUrl || "http://localhost:9222";

    // First try: direct CDP discovery
    const wsEndpoint = await discoverCdpEndpoint(url);
    if (wsEndpoint) {
      log.info(`[browser] Connecting via CDP WebSocket: ${wsEndpoint}`);
      const browser = await chromium.connectOverCDP(wsEndpoint);
      log.info("[browser] Connected to Chrome via CDP");
      return browser;
    }

    // Second try: use chrome-cdp.ts to ensure Chrome has CDP enabled
    try {
      const { ensureChromeWithCdp } = await import("./chrome-cdp.js");
      const ws = await ensureChromeWithCdp();
      log.info(`[browser] Connected via ensureChromeWithCdp: ${ws.slice(0, 50)}...`);
      const browser = await chromium.connectOverCDP(ws);
      log.info("[browser] Connected to Nicolas's Chrome via CDP");
      return browser;
    } catch (err) {
      log.warn(`[browser] ensureChromeWithCdp failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Fallback: launch isolated Chromium
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

  /** Save current session state (cookies, localStorage) to disk */
  async saveSession(): Promise<string> {
    if (!this.context) throw new Error("No browser context to save");
    if (!fs.existsSync(BROWSER_PROFILE_DIR)) {
      fs.mkdirSync(BROWSER_PROFILE_DIR, { recursive: true });
    }
    const stateFile = path.join(BROWSER_PROFILE_DIR, "state.json");
    await this.context.storageState({ path: stateFile });
    log.info(`[browser] Session state saved to ${stateFile}`);
    return stateFile;
  }

  /**
   * Save cookies for a specific domain (useful for cf_clearance persistence).
   * These are saved separately from the full state to allow domain-specific restoring.
   */
  async saveDomainCookies(domain: string): Promise<void> {
    if (!this.context) return;
    if (!fs.existsSync(BROWSER_PROFILE_DIR)) {
      fs.mkdirSync(BROWSER_PROFILE_DIR, { recursive: true });
    }
    try {
      const cookies = await this.context.cookies();
      const domainCookies = cookies.filter(c =>
        c.domain === domain || c.domain === `.${domain}` || domain.endsWith(c.domain.replace(/^\./, ''))
      );
      if (domainCookies.length > 0) {
        const cookieFile = path.join(BROWSER_PROFILE_DIR, `cookies_${domain.replace(/\./g, '_')}.json`);
        fs.writeFileSync(cookieFile, JSON.stringify(domainCookies, null, 2));
        log.info(`[browser] Saved ${domainCookies.length} cookies for ${domain}`);
      }
    } catch (err) {
      log.warn(`[browser] Failed to save domain cookies: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Restore cookies for a specific domain from saved file.
   * Useful for restoring cf_clearance and login sessions.
   */
  async restoreDomainCookies(domain: string): Promise<boolean> {
    if (!this.context) return false;
    try {
      const cookieFile = path.join(BROWSER_PROFILE_DIR, `cookies_${domain.replace(/\./g, '_')}.json`);
      if (!fs.existsSync(cookieFile)) return false;

      const cookies = JSON.parse(fs.readFileSync(cookieFile, 'utf-8'));
      // Filter out expired cookies
      const now = Date.now() / 1000;
      const validCookies = cookies.filter((c: any) => !c.expires || c.expires > now);

      if (validCookies.length > 0) {
        await this.context.addCookies(validCookies);
        log.info(`[browser] Restored ${validCookies.length} cookies for ${domain}`);
        return true;
      }
    } catch (err) {
      log.warn(`[browser] Failed to restore domain cookies: ${err instanceof Error ? err.message : String(err)}`);
    }
    return false;
  }

  /** Launch a VISIBLE browser for the user to log into sites manually.
   *  Returns the page. Call saveSession() after user is done logging in. */
  async launchForLogin(url?: string): Promise<Page> {
    // Close existing browser if any
    await this.close();

    // Force visible mode
    this.mode = "visible";
    log.info("[browser] Launching VISIBLE browser for manual login session...");

    this.server = await chromium.launchServer({
      headless: false,
      executablePath: config.browserChromePath || undefined,
      args: [
        `--window-size=1280,900`,
        "--no-sandbox",
        "--disable-blink-features=AutomationControlled",
        "--start-maximized",
      ],
    });
    this.browser = await chromium.connect(this.server.wsEndpoint());

    this.browser.on("disconnected", () => {
      this.browser = null;
      this.context = null;
      this.page = null;
    });

    // Load existing state if available
    let storageState: string | undefined;
    try {
      const stateFile = path.join(BROWSER_PROFILE_DIR, "state.json");
      if (fs.existsSync(stateFile)) {
        storageState = stateFile;
        log.info("[browser] Loaded existing session state for login browser");
      }
    } catch { /* no state */ }

    this.context = await this.browser.newContext({
      viewport: null, // Use full window
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
      locale: "fr-CA",
      timezoneId: "America/Toronto",
      ...(storageState ? { storageState } : {}),
    });
    await this.context.addInitScript(STEALTH_SCRIPTS);

    this.page = await this.context.newPage();
    if (url) await this.page.goto(url, { waitUntil: "domcontentloaded" });

    // No idle timer for login sessions
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }

    return this.page;
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

  /**
   * Navigate to a URL with automatic CAPTCHA detection and solving.
   * Includes cf_clearance cookie persistence — restores saved cookies
   * before navigation and saves new ones after solving.
   */
  async navigateWithCaptcha(url: string, opts?: { waitUntil?: "load" | "domcontentloaded" | "networkidle"; timeout?: number }): Promise<{ page: Page; captchaResult: any }> {
    const page = await this.getPage();

    // Try to restore cached cookies for this domain first
    try {
      const urlObj = new URL(url);
      const domain = urlObj.hostname;
      await this.restoreDomainCookies(domain);
    } catch (e) { log.debug?.(`Cookie restore failed: ${e instanceof Error ? e.message : e}`); }

    await page.goto(url, {
      waitUntil: opts?.waitUntil || "domcontentloaded",
      timeout: opts?.timeout || 30000,
    });

    // Auto-detect and solve CAPTCHAs
    const captchaResult = await handleCaptchaIfPresent(page);
    if (captchaResult && !captchaResult.success) {
      log.warn(`[browser] CAPTCHA detected but solve failed: ${captchaResult.error}`);
    }

    // If CAPTCHA was solved, save the cookies (especially cf_clearance)
    if (captchaResult?.success) {
      try {
        const urlObj = new URL(url);
        await this.saveDomainCookies(urlObj.hostname);
      } catch (e) { log.debug?.(`Cookie save failed: ${e instanceof Error ? e.message : e}`); }
    }

    return { page, captchaResult };
  }

  /**
   * Find an existing tab matching a domain, or create a new one.
   * Useful for site.act to reuse open tabs instead of creating duplicates.
   */
  async findOrCreateTab(domain: string, url?: string): Promise<Page> {
    if (!this.browser || !this.browser.isConnected()) {
      await this.getPage(); // ensure browser is up
    }

    // Search existing pages
    if (this.context) {
      const pages = this.context.pages();
      for (const p of pages) {
        try {
          if (p.url().includes(domain)) {
            await p.bringToFront();
            this.resetIdleTimer();
            return p;
          }
        } catch { /* page may be closed */ }
      }
    }

    // Not found — create new tab
    if (!this.context) {
      await this.getPage();
    }
    const page = await this.context!.newPage();
    if (url) {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
    }
    this.resetIdleTimer();
    return page;
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
