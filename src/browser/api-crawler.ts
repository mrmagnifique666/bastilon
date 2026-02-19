/**
 * API Guide Crawler — Autonomous web crawler for documenting real API setup procedures.
 *
 * How it works:
 * 1. Navigate to an API provider's site
 * 2. Detect CAPTCHA/login walls → handle via captcha-solver
 * 3. Extract page structure, screenshots, and step-by-step flows
 * 4. Generate a structured guide with real screenshots
 *
 * Output: JSON guide that can be rendered into HTML for bastilon.org/api-guide/
 */

import type { Page } from "playwright";
import { browserManager } from "./manager.js";
import { CaptchaSolver } from "./captcha-solver.js";
import { log } from "../utils/log.js";
import fs from "node:fs";
import path from "node:path";

// ── Types ────────────────────────────────────────────────────

export interface ApiGuideStep {
  stepNumber: number;
  action: string;           // What to do (e.g., "Click 'Create API Key'")
  url?: string;             // URL at this step
  selector?: string;        // CSS selector of the element to interact with
  screenshotPath?: string;  // Path to saved screenshot
  notes?: string;           // Additional context
  captchaEncountered?: boolean;
}

export interface ApiGuide {
  apiName: string;
  provider: string;
  baseUrl: string;
  difficulty: "easy" | "medium" | "hard";  // How hard is it to get an API key
  requirements: string[];    // What you need (email, credit card, phone, etc.)
  steps: ApiGuideStep[];
  gotchas: string[];         // Common pitfalls
  envVarName: string;        // Suggested env var name (e.g., OPENAI_API_KEY)
  lastVerified: string;      // ISO date
  captchaTypes: string[];    // What CAPTCHAs were encountered
}

// ── Known API Providers ──────────────────────────────────────
// Pre-configured starting points for common APIs

export const KNOWN_PROVIDERS: Record<string, {
  name: string;
  signupUrl: string;
  dashboardUrl: string;
  apiKeyPage: string;
  difficulty: "easy" | "medium" | "hard";
  requirements: string[];
  envVarName: string;
}> = {
  openai: {
    name: "OpenAI",
    signupUrl: "https://platform.openai.com/signup",
    dashboardUrl: "https://platform.openai.com/",
    apiKeyPage: "https://platform.openai.com/api-keys",
    difficulty: "medium",
    requirements: ["email", "phone number", "credit card (for paid usage)"],
    envVarName: "OPENAI_API_KEY",
  },
  anthropic: {
    name: "Anthropic (Claude)",
    signupUrl: "https://console.anthropic.com/",
    dashboardUrl: "https://console.anthropic.com/",
    apiKeyPage: "https://console.anthropic.com/settings/keys",
    difficulty: "medium",
    requirements: ["email", "credit card"],
    envVarName: "ANTHROPIC_API_KEY",
  },
  google_gemini: {
    name: "Google Gemini",
    signupUrl: "https://aistudio.google.com/",
    dashboardUrl: "https://aistudio.google.com/",
    apiKeyPage: "https://aistudio.google.com/app/apikey",
    difficulty: "easy",
    requirements: ["Google account"],
    envVarName: "GEMINI_API_KEY",
  },
  telegram: {
    name: "Telegram Bot API",
    signupUrl: "https://telegram.org/",
    dashboardUrl: "https://t.me/BotFather",
    apiKeyPage: "https://t.me/BotFather",
    difficulty: "easy",
    requirements: ["Telegram account", "phone number"],
    envVarName: "TELEGRAM_BOT_TOKEN",
  },
  stripe: {
    name: "Stripe",
    signupUrl: "https://dashboard.stripe.com/register",
    dashboardUrl: "https://dashboard.stripe.com/",
    apiKeyPage: "https://dashboard.stripe.com/apikeys",
    difficulty: "medium",
    requirements: ["email", "business info (for live keys)"],
    envVarName: "STRIPE_SECRET_KEY",
  },
  binance: {
    name: "Binance",
    signupUrl: "https://www.binance.com/en/register",
    dashboardUrl: "https://www.binance.com/en/my/settings/api-management",
    apiKeyPage: "https://www.binance.com/en/my/settings/api-management",
    difficulty: "hard",
    requirements: ["email", "phone number", "ID verification (KYC)", "2FA"],
    envVarName: "BINANCE_API_KEY",
  },
  alpaca: {
    name: "Alpaca Markets",
    signupUrl: "https://app.alpaca.markets/signup",
    dashboardUrl: "https://app.alpaca.markets/paper/dashboard/overview",
    apiKeyPage: "https://app.alpaca.markets/paper/dashboard/overview",
    difficulty: "easy",
    requirements: ["email"],
    envVarName: "ALPACA_API_KEY",
  },
  github: {
    name: "GitHub",
    signupUrl: "https://github.com/signup",
    dashboardUrl: "https://github.com/settings/tokens",
    apiKeyPage: "https://github.com/settings/tokens",
    difficulty: "easy",
    requirements: ["email"],
    envVarName: "GITHUB_TOKEN",
  },
  twilio: {
    name: "Twilio",
    signupUrl: "https://www.twilio.com/try-twilio",
    dashboardUrl: "https://console.twilio.com/",
    apiKeyPage: "https://console.twilio.com/",
    difficulty: "medium",
    requirements: ["email", "phone number"],
    envVarName: "TWILIO_AUTH_TOKEN",
  },
  printful: {
    name: "Printful",
    signupUrl: "https://www.printful.com/auth/register",
    dashboardUrl: "https://www.printful.com/dashboard",
    apiKeyPage: "https://www.printful.com/dashboard/developer/api",
    difficulty: "easy",
    requirements: ["email"],
    envVarName: "PRINTFUL_API_TOKEN",
  },
  brave_search: {
    name: "Brave Search API",
    signupUrl: "https://brave.com/search/api/",
    dashboardUrl: "https://api.search.brave.com/app/dashboard",
    apiKeyPage: "https://api.search.brave.com/app/keys",
    difficulty: "easy",
    requirements: ["email", "credit card (free tier available)"],
    envVarName: "BRAVE_SEARCH_API_KEY",
  },
  elevenlabs: {
    name: "ElevenLabs",
    signupUrl: "https://elevenlabs.io/sign-up",
    dashboardUrl: "https://elevenlabs.io/app/settings/api-keys",
    apiKeyPage: "https://elevenlabs.io/app/settings/api-keys",
    difficulty: "easy",
    requirements: ["email"],
    envVarName: "ELEVENLABS_API_KEY",
  },
  deepgram: {
    name: "Deepgram",
    signupUrl: "https://console.deepgram.com/signup",
    dashboardUrl: "https://console.deepgram.com/",
    apiKeyPage: "https://console.deepgram.com/project/keys",
    difficulty: "easy",
    requirements: ["email"],
    envVarName: "DEEPGRAM_API_KEY",
  },
  "2captcha": {
    name: "2Captcha",
    signupUrl: "https://2captcha.com/auth/register",
    dashboardUrl: "https://2captcha.com/enterpage",
    apiKeyPage: "https://2captcha.com/enterpage",
    difficulty: "easy",
    requirements: ["email", "$3 minimum deposit"],
    envVarName: "TWO_CAPTCHA_API_KEY",
  },
  shopify: {
    name: "Shopify Admin API",
    signupUrl: "https://www.shopify.com/signup",
    dashboardUrl: "https://admin.shopify.com/",
    apiKeyPage: "https://admin.shopify.com/store/{store}/settings/apps/development",
    difficulty: "hard",
    requirements: ["email", "store name", "custom app creation"],
    envVarName: "SHOPIFY_ACCESS_TOKEN",
  },
};

// ── Crawler Class ────────────────────────────────────────────

export class ApiCrawler {
  private outputDir: string;

  constructor(outputDir?: string) {
    this.outputDir = outputDir || path.join(process.cwd(), "relay", "api-guides");
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
  }

  /** Crawl a known API provider and document the setup process */
  async crawlProvider(providerId: string): Promise<ApiGuide | null> {
    const provider = KNOWN_PROVIDERS[providerId];
    if (!provider) {
      log.error(`[api-crawler] Unknown provider: ${providerId}`);
      return null;
    }

    log.info(`[api-crawler] Starting crawl for ${provider.name} (${provider.apiKeyPage})`);

    const page = await browserManager.getPage();
    const solver = new CaptchaSolver(page);
    const steps: ApiGuideStep[] = [];
    const gotchas: string[] = [];
    const captchaTypes: string[] = [];

    try {
      // Step 1: Navigate to the API key page
      await page.goto(provider.apiKeyPage, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      await page.waitForTimeout(2000);

      // Check for CAPTCHA
      const captchaResult = await solver.detect();
      if (captchaResult.type !== 'none') {
        captchaTypes.push(captchaResult.type);
        gotchas.push(`${captchaResult.type} detected on ${provider.name} — may need manual intervention`);
      }

      // Screenshot the page
      const ssPath = path.join(this.outputDir, `${providerId}_step1.png`);
      await page.screenshot({ path: ssPath, fullPage: false });

      steps.push({
        stepNumber: 1,
        action: `Navigate to ${provider.apiKeyPage}`,
        url: page.url(),
        screenshotPath: ssPath,
        captchaEncountered: captchaResult.type !== 'none',
      });

      // Check if we're on a login page
      const isLoginPage = await page.evaluate(() => {
        const inputs = document.querySelectorAll('input[type="email"], input[type="password"], input[name="email"], input[name="login"]');
        const loginButtons = document.querySelectorAll('button[type="submit"], input[type="submit"]');
        return inputs.length > 0 && loginButtons.length > 0;
      });

      if (isLoginPage) {
        steps.push({
          stepNumber: 2,
          action: `Login required. Sign up at ${provider.signupUrl} if you don't have an account.`,
          url: page.url(),
          notes: "You need to be logged in to access API keys.",
        });
        gotchas.push("Login required — the crawler can only document public-facing pages without credentials");
      }

      // Extract page structure
      const pageInfo = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a')).map(a => ({
          text: a.textContent?.trim().slice(0, 100) || '',
          href: a.href,
        })).filter(l => l.text.length > 0);

        const buttons = Array.from(document.querySelectorAll('button, [role="button"]')).map(b => ({
          text: b.textContent?.trim().slice(0, 100) || '',
          id: b.id,
          classes: b.className,
        })).filter(b => b.text.length > 0);

        const headings = Array.from(document.querySelectorAll('h1, h2, h3')).map(h => h.textContent?.trim() || '');

        return { links: links.slice(0, 30), buttons: buttons.slice(0, 20), headings: headings.slice(0, 10), title: document.title };
      });

      // Look for API-key related elements
      const apiKeyElements = await page.evaluate(() => {
        const selectors = [
          '[data-testid*="api"], [data-testid*="key"], [data-testid*="token"]',
          'button:has-text("Create"), button:has-text("Generate"), button:has-text("New")',
          'input[placeholder*="key" i], input[placeholder*="token" i]',
          'code, pre',
          '.api-key, .token, .secret-key',
        ];

        const found: string[] = [];
        for (const sel of selectors) {
          try {
            const els = document.querySelectorAll(sel);
            if (els.length > 0) found.push(`Found ${els.length} elements matching: ${sel}`);
          } catch { /* invalid selector */ }
        }
        return found;
      });

      if (apiKeyElements.length > 0) {
        steps.push({
          stepNumber: steps.length + 1,
          action: "API key elements detected on page",
          notes: apiKeyElements.join('\n'),
        });
      }

      // Build the guide
      const guide: ApiGuide = {
        apiName: provider.name,
        provider: providerId,
        baseUrl: provider.apiKeyPage,
        difficulty: provider.difficulty,
        requirements: provider.requirements,
        steps,
        gotchas,
        envVarName: provider.envVarName,
        lastVerified: new Date().toISOString().split('T')[0],
        captchaTypes,
      };

      // Save the guide
      const guidePath = path.join(this.outputDir, `${providerId}.json`);
      fs.writeFileSync(guidePath, JSON.stringify(guide, null, 2));
      log.info(`[api-crawler] Guide saved: ${guidePath}`);

      return guide;
    } catch (err) {
      log.error(`[api-crawler] Crawl failed for ${provider.name}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /** Crawl multiple providers */
  async crawlAll(providerIds?: string[]): Promise<Map<string, ApiGuide | null>> {
    const ids = providerIds || Object.keys(KNOWN_PROVIDERS);
    const results = new Map<string, ApiGuide | null>();

    for (const id of ids) {
      const guide = await this.crawlProvider(id);
      results.set(id, guide);
      // Wait between crawls to avoid rate limiting
      await new Promise(r => setTimeout(r, 3000));
    }

    return results;
  }

  /** Generate an HTML page from a guide */
  static guideToHtml(guide: ApiGuide): string {
    const stepsHtml = guide.steps.map(step => `
      <div class="step">
        <div class="step-number">${step.stepNumber}</div>
        <div class="step-content">
          <h3>${escapeHtml(step.action)}</h3>
          ${step.url ? `<p class="step-url"><code>${escapeHtml(step.url)}</code></p>` : ''}
          ${step.notes ? `<p class="step-notes">${escapeHtml(step.notes)}</p>` : ''}
          ${step.captchaEncountered ? '<p class="captcha-warning">⚠️ CAPTCHA detected at this step</p>' : ''}
          ${step.screenshotPath ? `<img src="screenshots/${path.basename(step.screenshotPath)}" alt="Step ${step.stepNumber}" class="step-screenshot">` : ''}
        </div>
      </div>
    `).join('\n');

    const gotchasHtml = guide.gotchas.length > 0
      ? `<div class="gotchas"><h2>⚠️ Gotchas</h2><ul>${guide.gotchas.map(g => `<li>${escapeHtml(g)}</li>`).join('')}</ul></div>`
      : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(guide.apiName)} API Guide — Bastilon</title>
  <link rel="stylesheet" href="../style.css">
</head>
<body>
  <nav><a href="../">← Back to all guides</a></nav>
  <main class="container">
    <header>
      <h1>${escapeHtml(guide.apiName)} API Setup Guide</h1>
      <div class="meta">
        <span class="difficulty difficulty-${guide.difficulty}">${guide.difficulty}</span>
        <span class="env-var"><code>${escapeHtml(guide.envVarName)}</code></span>
        <span class="verified">Last verified: ${guide.lastVerified}</span>
      </div>
    </header>

    <section class="requirements">
      <h2>What you need</h2>
      <ul>
        ${guide.requirements.map(r => `<li>${escapeHtml(r)}</li>`).join('\n        ')}
      </ul>
    </section>

    <section class="steps">
      <h2>Steps</h2>
      ${stepsHtml}
    </section>

    ${gotchasHtml}

    <section class="env-setup">
      <h2>Environment Variable</h2>
      <pre><code>${escapeHtml(guide.envVarName)}=your_api_key_here</code></pre>
    </section>

    <footer>
      <p>Built by <a href="https://bastilon.org">Kingston</a> — an AI that got tired of broken API docs.</p>
    </footer>
  </main>
</body>
</html>`;
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
