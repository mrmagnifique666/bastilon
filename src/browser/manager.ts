/**
 * Browser manager — lazy singleton for Puppeteer.
 * Supports three modes: headless, visible, connect.
 * Auto-closes/disconnects after idle timeout.
 */
import puppeteer, { type Browser, type Page } from "puppeteer";
import { config } from "../config/env.js";
import { log } from "../utils/log.js";

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
          const url = config.browserCdpUrl || "http://localhost:9222";
          log.info(`[browser] Connecting to existing Chrome at ${url}...`);
          this.browser = await puppeteer.connect({
            browserURL: url,
            defaultViewport: null, // keep native Chrome size
          });
          // Grab first existing tab or create one
          const pages = await this.browser.pages();
          this.page = pages[0] || (await this.browser.newPage());
          log.info("[browser] Connected to existing Chrome");
          break;
        }

        case "visible": {
          log.info("[browser] Launching visible Chrome...");
          this.browser = await puppeteer.launch({
            headless: false,
            defaultViewport: null,
            executablePath: config.browserChromePath || undefined,
            args: [
              `--window-size=${config.browserViewportWidth},${config.browserViewportHeight}`,
              "--no-sandbox",
              "--disable-setuid-sandbox",
            ],
          });
          log.info("[browser] Visible Chrome launched");
          break;
        }

        default: {
          // headless
          log.info("[browser] Launching headless Chromium...");
          this.browser = await puppeteer.launch({
            headless: true,
            args: [
              "--no-sandbox",
              "--disable-setuid-sandbox",
              "--disable-dev-shm-usage",
            ],
          });
          log.info("[browser] Headless Chromium launched");
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
      this.page = await this.browser.newPage();
      // In connect mode, viewport is already set by Chrome window.
      // In visible mode with defaultViewport: null, it uses the window size.
      // In headless mode, set viewport explicitly.
      if (this.mode === "headless") {
        await this.page.setViewport({
          width: config.browserViewportWidth,
          height: config.browserViewportHeight,
        });
      }
      log.debug(
        `[browser] New page created (${config.browserViewportWidth}x${config.browserViewportHeight})`
      );
    }

    this.resetIdleTimer();
    return this.page;
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
