/**
 * CAPTCHA Solver Module v2 — Multi-layered, multi-provider approach:
 *
 * Layer 1: Detection — identify what type of CAPTCHA is on the page
 * Layer 2: Stealth avoidance — enhanced anti-detection to avoid CAPTCHAs entirely
 * Layer 3: Auto-solve — multiple solving backends with failover:
 *   - 2Captcha v2 JSON API (primary, ~$1-3/1K solves)
 *   - Capsolver AI (fallback, faster 3-9s, ~$0.80-1.20/1K)
 *   - Cloudflare JS challenge handler (free, self-implemented)
 *   - cf_clearance cookie persistence (free, avoids re-solving)
 *
 * v2 upgrade: JSON API (createTask/getTaskResult), multi-provider failover,
 * Turnstile token injection, cf_clearance persistence.
 *
 * Usage:
 *   const solver = new CaptchaSolver(page);
 *   const detected = await solver.detect();
 *   if (detected) await solver.solve();
 */

import type { Page } from "playwright";
import { log } from "../utils/log.js";
import { config } from "../config/env.js";

// ── Types ────────────────────────────────────────────────────

export type CaptchaType =
  | "recaptcha-v2"
  | "recaptcha-v3"
  | "hcaptcha"
  | "cloudflare-turnstile"
  | "cloudflare-js-challenge"
  | "text-captcha"
  | "none";

export interface CaptchaDetection {
  type: CaptchaType;
  siteKey?: string;
  pageUrl: string;
  iframeSelector?: string;
  confidence: number; // 0-1
}

export interface SolveResult {
  success: boolean;
  token?: string;
  method: string;
  timeMs: number;
  error?: string;
  provider?: string;
}

// ── Provider Configuration ──────────────────────────────────

interface CaptchaProvider {
  name: string;
  createTaskUrl: string;
  getResultUrl: string;
  apiKey: string | null;
  /** Map our generic task types to provider-specific type names */
  taskTypes: Record<string, string>;
}

function getProviders(): CaptchaProvider[] {
  const providers: CaptchaProvider[] = [];

  // Primary: 2Captcha v2 JSON API
  const twoCaptchaKey = (config as any).twoCaptchaApiKey || process.env.TWO_CAPTCHA_API_KEY || null;
  if (twoCaptchaKey) {
    providers.push({
      name: "2captcha",
      createTaskUrl: "https://api.2captcha.com/createTask",
      getResultUrl: "https://api.2captcha.com/getTaskResult",
      apiKey: twoCaptchaKey,
      taskTypes: {
        "recaptcha-v2": "RecaptchaV2TaskProxyless",
        "recaptcha-v3": "RecaptchaV3TaskProxyless",
        "hcaptcha": "HCaptchaTaskProxyless",
        "cloudflare-turnstile": "TurnstileTaskProxyless",
      },
    });
  }

  // Fallback: Capsolver (AI-powered, faster)
  const capsolverKey = process.env.CAPSOLVER_API_KEY || null;
  if (capsolverKey) {
    providers.push({
      name: "capsolver",
      createTaskUrl: "https://api.capsolver.com/createTask",
      getResultUrl: "https://api.capsolver.com/getTaskResult",
      apiKey: capsolverKey,
      taskTypes: {
        "recaptcha-v2": "ReCaptchaV2TaskProxyLess",
        "recaptcha-v3": "ReCaptchaV3TaskProxyLess",
        "hcaptcha": "HCaptchaTaskProxyLess",
        "cloudflare-turnstile": "AntiTurnstileTaskProxyLess",
      },
    });
  }

  return providers;
}

// ── Enhanced Stealth Scripts ─────────────────────────────────
// These go beyond the basic ones in manager.ts

export const ENHANCED_STEALTH_SCRIPTS = `
  // === WEBDRIVER ===
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  delete navigator.__proto__.webdriver;

  // === CHROME RUNTIME ===
  if (!window.chrome) {
    window.chrome = {};
  }
  if (!window.chrome.runtime) {
    window.chrome.runtime = {
      onMessage: { addListener: function() {}, removeListener: function() {} },
      sendMessage: function() {},
      connect: function() { return { onMessage: { addListener: function() {} } }; },
    };
  }
  window.chrome.csi = function() { return {}; };
  window.chrome.loadTimes = function() { return {}; };

  // === PERMISSIONS ===
  const origQuery = Permissions.prototype.query;
  Permissions.prototype.query = function(params) {
    if (params.name === 'notifications') {
      return Promise.resolve({ state: Notification.permission });
    }
    return origQuery.call(this, params);
  };

  // === PLUGINS (realistic) ===
  Object.defineProperty(navigator, 'plugins', {
    get: () => {
      const plugins = [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
        { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
      ];
      plugins.length = 3;
      return plugins;
    }
  });

  // === MIME TYPES (realistic) ===
  Object.defineProperty(navigator, 'mimeTypes', {
    get: () => {
      const mimes = [
        { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
        { type: 'application/x-google-chrome-pdf', suffixes: 'pdf', description: 'Portable Document Format' },
      ];
      mimes.length = 2;
      return mimes;
    }
  });

  // === LANGUAGES ===
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en', 'fr-CA', 'fr'] });
  Object.defineProperty(navigator, 'language', { get: () => 'en-US' });

  // === PLATFORM ===
  Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });

  // === HARDWARE CONCURRENCY (realistic) ===
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });

  // === DEVICE MEMORY ===
  Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });

  // === CONNECTION (realistic) ===
  if (navigator.connection) {
    Object.defineProperty(navigator.connection, 'rtt', { get: () => 50 });
  }

  // === WEBGL VENDOR/RENDERER (realistic for Windows) ===
  const getParameter = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function(param) {
    if (param === 37445) return 'Google Inc. (NVIDIA)'; // UNMASKED_VENDOR
    if (param === 37446) return 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)'; // UNMASKED_RENDERER
    return getParameter.call(this, param);
  };

  // Also handle WebGL2
  if (typeof WebGL2RenderingContext !== 'undefined') {
    const getParameter2 = WebGL2RenderingContext.prototype.getParameter;
    WebGL2RenderingContext.prototype.getParameter = function(param) {
      if (param === 37445) return 'Google Inc. (NVIDIA)';
      if (param === 37446) return 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)';
      return getParameter2.call(this, param);
    };
  }

  // === IFRAME CONTENTWINDOW ===
  // Prevent detection via cross-origin iframe access patterns
  const origIframeGetter = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
  if (origIframeGetter && origIframeGetter.get) {
    Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
      get: function() {
        const win = origIframeGetter.get.call(this);
        if (this.src && this.src.includes('recaptcha')) return win;
        return win;
      }
    });
  }

  // === SCREEN (realistic for 1080p) ===
  Object.defineProperty(screen, 'colorDepth', { get: () => 24 });
  Object.defineProperty(screen, 'pixelDepth', { get: () => 24 });

  // === DISABLE AUTOMATION FLAGS ===
  // Remove cdc_ properties that Playwright/Chromium injects
  const cleanAutomation = () => {
    try {
      const props = Object.getOwnPropertyNames(document);
      for (const prop of props) {
        if (prop.match(/^cdc_/)) {
          delete document[prop];
        }
      }
    } catch {}
  };
  cleanAutomation();
  const observer = new MutationObserver(cleanAutomation);
  observer.observe(document, { childList: true, subtree: true });
`;

// ── CAPTCHA Detection ────────────────────────────────────────

export class CaptchaSolver {
  private page: Page;
  private providers: CaptchaProvider[];

  constructor(page: Page) {
    this.page = page;
    this.providers = getProviders();
  }

  /** Check if any solving provider is configured */
  hasProvider(): boolean {
    return this.providers.length > 0;
  }

  /** Detect what type of CAPTCHA (if any) is present on the current page */
  async detect(): Promise<CaptchaDetection> {
    const pageUrl = this.page.url();

    try {
      const result = await this.page.evaluate(() => {
        // Check for Cloudflare JS challenge ("Just a moment..." / "Checking your browser...")
        const cfChallenge = document.querySelector('#cf-challenge-running, .cf-browser-verification');
        const titleCheck = document.title.toLowerCase().includes('just a moment');
        const bodyCheck = document.body?.textContent?.includes('Checking your browser') || false;
        if (cfChallenge || titleCheck || bodyCheck) {
          return { type: 'cloudflare-js-challenge', confidence: 0.95 };
        }

        // Check for Cloudflare Turnstile
        const turnstile = document.querySelector('[data-sitekey].cf-turnstile, .cf-turnstile iframe, .cf-turnstile');
        if (turnstile) {
          const siteKey = turnstile.getAttribute('data-sitekey') ||
            turnstile.closest('[data-sitekey]')?.getAttribute('data-sitekey') || '';
          return { type: 'cloudflare-turnstile', siteKey, confidence: 0.95 };
        }

        // Check for Turnstile via script tag (some sites load it dynamically)
        const turnstileScript = document.querySelector('script[src*="challenges.cloudflare.com/turnstile"]');
        if (turnstileScript) {
          // Find sitekey from any rendered widget
          const widget = document.querySelector('[data-sitekey]');
          return { type: 'cloudflare-turnstile', siteKey: widget?.getAttribute('data-sitekey') || '', confidence: 0.8 };
        }

        // Check for reCAPTCHA v2 (visible checkbox)
        const recaptchaV2 = document.querySelector('.g-recaptcha, [data-sitekey][data-size]');
        const recaptchaIframe = document.querySelector('iframe[src*="recaptcha/api2/anchor"]');
        if (recaptchaV2 || recaptchaIframe) {
          const siteKey = recaptchaV2?.getAttribute('data-sitekey') || '';
          return { type: 'recaptcha-v2', siteKey, confidence: 0.9 };
        }

        // Check for reCAPTCHA v3 (invisible — detected by script presence)
        const recaptchaV3Script = document.querySelector('script[src*="recaptcha/api.js?render="]');
        if (recaptchaV3Script) {
          const src = recaptchaV3Script.getAttribute('src') || '';
          const match = src.match(/render=([^&]+)/);
          return { type: 'recaptcha-v3', siteKey: match?.[1] || '', confidence: 0.8 };
        }

        // Check for hCaptcha
        const hcaptcha = document.querySelector('.h-captcha, [data-sitekey].h-captcha');
        const hcaptchaIframe = document.querySelector('iframe[src*="hcaptcha.com"]');
        if (hcaptcha || hcaptchaIframe) {
          const siteKey = hcaptcha?.getAttribute('data-sitekey') || '';
          return { type: 'hcaptcha', siteKey, confidence: 0.9 };
        }

        // Check for generic text/image CAPTCHA
        const captchaInput = document.querySelector('input[name*="captcha" i], input[id*="captcha" i]');
        const captchaImg = document.querySelector('img[src*="captcha" i], img[alt*="captcha" i]');
        if (captchaInput || captchaImg) {
          return { type: 'text-captcha', confidence: 0.7 };
        }

        return { type: 'none', confidence: 1.0 };
      });

      return {
        ...result,
        pageUrl,
      } as CaptchaDetection;
    } catch (err) {
      log.warn(`[captcha] Detection failed: ${err instanceof Error ? err.message : String(err)}`);
      return { type: 'none', pageUrl, confidence: 0 };
    }
  }

  /** Wait for Cloudflare JS challenge to auto-resolve (they often do within 5-10s) */
  async waitForCloudflareChallenge(timeoutMs = 20000): Promise<boolean> {
    log.info("[captcha] Waiting for Cloudflare JS challenge to resolve...");
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      // Check for cf_clearance cookie — indicates challenge passed
      const hasClearance = await this.hasCfClearance();
      if (hasClearance) {
        log.info(`[captcha] cf_clearance cookie obtained in ${Date.now() - start}ms`);
        return true;
      }

      const detection = await this.detect();
      if (detection.type !== 'cloudflare-js-challenge') {
        log.info(`[captcha] Cloudflare challenge resolved in ${Date.now() - start}ms`);
        return true;
      }
      await new Promise(r => setTimeout(r, 1000));
    }

    log.warn(`[captcha] Cloudflare challenge did NOT resolve within ${timeoutMs}ms`);
    return false;
  }

  /** Check if the page has a cf_clearance cookie */
  async hasCfClearance(): Promise<boolean> {
    try {
      const cookies = await this.page.context().cookies();
      return cookies.some(c => c.name === 'cf_clearance');
    } catch {
      return false;
    }
  }

  /** Get cf_clearance cookie details for persistence */
  async getCfClearance(): Promise<{ value: string; domain: string; expires: number } | null> {
    try {
      const cookies = await this.page.context().cookies();
      const cf = cookies.find(c => c.name === 'cf_clearance');
      if (cf) {
        return { value: cf.value, domain: cf.domain, expires: cf.expires };
      }
    } catch {}
    return null;
  }

  // ── Unified v2 JSON API Solver ────────────────────────────

  /**
   * Solve a CAPTCHA using the v2 JSON API (createTask/getTaskResult).
   * Tries each configured provider in order until one succeeds.
   */
  private async solveViaProvider(
    captchaType: CaptchaType,
    siteKey: string,
    extraTaskParams?: Record<string, any>
  ): Promise<SolveResult> {
    const start = Date.now();

    if (this.providers.length === 0) {
      return {
        success: false,
        method: 'none',
        timeMs: 0,
        error: 'No CAPTCHA solving provider configured. Set TWO_CAPTCHA_API_KEY or CAPSOLVER_API_KEY in .env',
      };
    }

    for (const provider of this.providers) {
      const taskType = provider.taskTypes[captchaType];
      if (!taskType) {
        log.warn(`[captcha] ${provider.name} does not support ${captchaType}, trying next...`);
        continue;
      }

      try {
        log.info(`[captcha] Solving ${captchaType} via ${provider.name} (siteKey: ${siteKey.slice(0, 20)}...)`);

        // Build task payload
        const task: Record<string, any> = {
          type: taskType,
          websiteURL: this.page.url(),
          websiteKey: siteKey,
          ...extraTaskParams,
        };

        // Submit task
        const submitRes = await fetch(provider.createTaskUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clientKey: provider.apiKey, task }),
        });
        const submitData = await submitRes.json() as any;

        if (submitData.errorId && submitData.errorId !== 0) {
          throw new Error(`${provider.name} submit error: ${submitData.errorCode || submitData.errorDescription || JSON.stringify(submitData)}`);
        }

        const taskId = submitData.taskId;
        if (!taskId) {
          throw new Error(`${provider.name} returned no taskId: ${JSON.stringify(submitData)}`);
        }
        log.info(`[captcha] ${provider.name} task submitted: ${taskId}`);

        // Poll for result (max 120s)
        for (let i = 0; i < 24; i++) {
          await new Promise(r => setTimeout(r, 5000));

          const resultRes = await fetch(provider.getResultUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ clientKey: provider.apiKey, taskId }),
          });
          const resultData = await resultRes.json() as any;

          if (resultData.errorId && resultData.errorId !== 0) {
            throw new Error(`${provider.name} result error: ${resultData.errorCode || resultData.errorDescription}`);
          }

          if (resultData.status === 'ready') {
            const token = resultData.solution?.gRecaptchaResponse ||
                          resultData.solution?.token ||
                          resultData.solution?.text || '';
            const solveTime = Date.now() - start;
            log.info(`[captcha] ${captchaType} solved via ${provider.name} in ${solveTime}ms`);

            return {
              success: true,
              token,
              method: `${provider.name}-v2`,
              timeMs: solveTime,
              provider: provider.name,
            };
          }

          // Still processing
          if (resultData.status === 'processing') continue;

          // Unknown status — log and continue polling
          log.debug(`[captcha] ${provider.name} poll ${i + 1}: ${JSON.stringify(resultData)}`);
        }

        throw new Error(`${provider.name} timeout (120s)`);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        log.warn(`[captcha] ${provider.name} failed for ${captchaType}: ${errorMsg}`);

        // If this is the last provider, return the error
        if (provider === this.providers[this.providers.length - 1]) {
          return {
            success: false,
            method: `${provider.name}-v2`,
            timeMs: Date.now() - start,
            error: errorMsg,
            provider: provider.name,
          };
        }
        // Otherwise, try next provider
        log.info(`[captcha] Trying next provider...`);
      }
    }

    return {
      success: false,
      method: 'all-providers',
      timeMs: Date.now() - start,
      error: 'All providers failed',
    };
  }

  /**
   * Auto-solve: detect CAPTCHA type and apply appropriate solution.
   * Uses v2 JSON API with multi-provider failover.
   */
  async solve(): Promise<SolveResult> {
    const detection = await this.detect();
    log.info(`[captcha] Detected: ${detection.type} (confidence: ${detection.confidence})`);

    switch (detection.type) {
      case 'none':
        return { success: true, method: 'none-needed', timeMs: 0 };

      case 'cloudflare-js-challenge': {
        // First try: wait for auto-resolution (free)
        const resolved = await this.waitForCloudflareChallenge(20000);
        if (resolved) {
          return { success: true, method: 'cloudflare-wait', timeMs: 20000 };
        }
        // If it didn't resolve, check if it escalated to Turnstile
        const recheck = await this.detect();
        if (recheck.type === 'cloudflare-turnstile' && recheck.siteKey) {
          log.info('[captcha] CF challenge escalated to Turnstile — solving...');
          const result = await this.solveViaProvider('cloudflare-turnstile', recheck.siteKey);
          if (result.success && result.token) {
            await this.injectTurnstileToken(result.token);
          }
          return result;
        }
        return {
          success: false,
          method: 'cloudflare-wait',
          timeMs: 20000,
          error: 'Cloudflare challenge did not auto-resolve and no Turnstile fallback found',
        };
      }

      case 'recaptcha-v2':
        if (!detection.siteKey) return { success: false, method: 'recaptcha-v2', timeMs: 0, error: 'No siteKey found' };
        {
          const result = await this.solveViaProvider('recaptcha-v2', detection.siteKey);
          if (result.success && result.token) await this.injectRecaptchaToken(result.token);
          return result;
        }

      case 'recaptcha-v3':
        if (!detection.siteKey) return { success: false, method: 'recaptcha-v3', timeMs: 0, error: 'No siteKey found' };
        {
          const result = await this.solveViaProvider('recaptcha-v3', detection.siteKey, {
            minScore: 0.9,
            pageAction: 'verify',
          });
          if (result.success && result.token) await this.injectRecaptchaToken(result.token);
          return result;
        }

      case 'hcaptcha':
        if (!detection.siteKey) return { success: false, method: 'hcaptcha', timeMs: 0, error: 'No siteKey found' };
        {
          const result = await this.solveViaProvider('hcaptcha', detection.siteKey);
          if (result.success && result.token) await this.injectHcaptchaToken(result.token);
          return result;
        }

      case 'cloudflare-turnstile':
        if (!detection.siteKey) return { success: false, method: 'turnstile', timeMs: 0, error: 'No siteKey found' };
        {
          const result = await this.solveViaProvider('cloudflare-turnstile', detection.siteKey);
          if (result.success && result.token) await this.injectTurnstileToken(result.token);
          return result;
        }

      case 'text-captcha':
        return { success: false, method: 'text-captcha', timeMs: 0, error: 'Text/image CAPTCHAs not yet supported' };

      default:
        return { success: false, method: 'unknown', timeMs: 0, error: `Unknown CAPTCHA type: ${detection.type}` };
    }
  }

  // ── Token Injection Helpers ────────────────────────────────

  private async injectRecaptchaToken(token: string): Promise<void> {
    await this.page.evaluate((t: string) => {
      // Set the response textarea
      const textarea = document.querySelector('#g-recaptcha-response, [name="g-recaptcha-response"]') as HTMLTextAreaElement;
      if (textarea) {
        textarea.value = t;
        textarea.style.display = 'block';
      }

      // Try to call the callback function
      try {
        // Method 1: ___grecaptcha_cfg.clients
        if ((window as any).___grecaptcha_cfg?.clients) {
          for (const client of Object.values((window as any).___grecaptcha_cfg.clients) as any[]) {
            const findCallback = (obj: any, depth = 0): Function | null => {
              if (depth > 5 || !obj) return null;
              for (const key of Object.keys(obj)) {
                if (typeof obj[key] === 'function' && key !== 'bind') return obj[key];
                if (typeof obj[key] === 'object') {
                  const found = findCallback(obj[key], depth + 1);
                  if (found) return found;
                }
              }
              return null;
            };
            const cb = findCallback(client);
            if (cb) cb(t);
          }
        }
      } catch {}

      // Method 2: data-callback attribute
      try {
        const el = document.querySelector('.g-recaptcha[data-callback]');
        if (el) {
          const callbackName = el.getAttribute('data-callback');
          if (callbackName && typeof (window as any)[callbackName] === 'function') {
            (window as any)[callbackName](t);
          }
        }
      } catch {}
    }, token);
  }

  private async injectHcaptchaToken(token: string): Promise<void> {
    await this.page.evaluate((t: string) => {
      const textarea = document.querySelector('[name="h-captcha-response"], [name="g-recaptcha-response"]') as HTMLTextAreaElement;
      if (textarea) textarea.value = t;

      try {
        const el = document.querySelector('.h-captcha[data-callback]');
        if (el) {
          const callbackName = el.getAttribute('data-callback');
          if (callbackName && typeof (window as any)[callbackName] === 'function') {
            (window as any)[callbackName](t);
          }
        }
      } catch {}
    }, token);
  }

  /** Inject Cloudflare Turnstile token into the page */
  private async injectTurnstileToken(token: string): Promise<void> {
    await this.page.evaluate((t: string) => {
      // Set the hidden input
      const input = document.querySelector('[name="cf-turnstile-response"]') as HTMLInputElement;
      if (input) input.value = t;

      // Also check for generic response fields
      const generic = document.querySelector('input[name*="turnstile" i]') as HTMLInputElement;
      if (generic && generic !== input) generic.value = t;

      // Trigger Turnstile callback if available
      try {
        const widgets = document.querySelectorAll('.cf-turnstile, [data-sitekey]');
        widgets.forEach(w => {
          const cb = w.getAttribute('data-callback');
          if (cb && typeof (window as any)[cb] === 'function') {
            (window as any)[cb](t);
          }
        });
      } catch {}

      // Try Turnstile global API
      try {
        if ((window as any).turnstile) {
          // Some implementations use turnstile.getResponse()
          // We can try to find and set it
        }
      } catch {}
    }, token);
  }
}

/**
 * Middleware: Auto-detect and solve CAPTCHAs after page navigation.
 * Call this after any page.goto() to handle CAPTCHAs transparently.
 */
export async function handleCaptchaIfPresent(page: Page): Promise<SolveResult | null> {
  const solver = new CaptchaSolver(page);
  const detection = await solver.detect();

  if (detection.type === 'none') return null;

  log.info(`[captcha] Auto-handling ${detection.type} on ${detection.pageUrl}`);
  return solver.solve();
}

/**
 * Wait for a Cloudflare-protected page to become accessible.
 * Checks for cf_clearance cookie as success indicator.
 * Use this after navigating to a CF-protected site.
 */
export async function waitForCfClearance(page: Page, timeoutMs = 20000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const cookies = await page.context().cookies();
      const clearance = cookies.find(c => c.name === 'cf_clearance');
      if (clearance) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

/**
 * Get a summary of available CAPTCHA solving capabilities.
 * Useful for diagnostics and status reporting.
 */
export function getCaptchaStatus(): {
  providers: string[];
  canSolve: string[];
  missing: string[];
} {
  const providers = getProviders();
  const providerNames = providers.map(p => p.name);

  const canSolve: string[] = [];
  if (providers.length > 0) {
    canSolve.push('reCAPTCHA v2', 'reCAPTCHA v3', 'hCaptcha', 'Cloudflare Turnstile');
  }
  canSolve.push('Cloudflare JS Challenge (free)');

  const missing: string[] = [];
  if (!process.env.TWO_CAPTCHA_API_KEY) missing.push('TWO_CAPTCHA_API_KEY');
  if (!process.env.CAPSOLVER_API_KEY) missing.push('CAPSOLVER_API_KEY (optional fallback)');

  return { providers: providerNames, canSolve, missing };
}
