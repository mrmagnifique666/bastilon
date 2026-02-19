/**
 * account.train — Kingston's autonomous training system for account creation.
 *
 * Systematically tests account creation on websites ranked by difficulty.
 * Logs results, learns from failures, and reports progress.
 *
 * Training tiers:
 *   Tier 1 (Easy): No CAPTCHA, simple forms — httpbin.org, jsonplaceholder
 *   Tier 2 (Medium): Google OAuth or simple CAPTCHA — dev.to, HuggingFace
 *   Tier 3 (Hard): Complex CAPTCHA + 2FA — Binance, Google Cloud, Stripe
 *
 * Each test: navigate → detect form → fill → submit → verify → log result
 */
import { registerSkill } from "../loader.js";
import { browserManager, humanDelay, humanType } from "../../browser/manager.js";
import { CaptchaSolver } from "../../browser/captcha-solver.js";
import { log } from "../../utils/log.js";
import * as fs from "node:fs";
import * as path from "node:path";

const TRAINING_LOG = path.resolve(process.cwd(), "relay", "training-log.json");
const ACCOUNTS_DIR = path.resolve(process.cwd(), "relay", "accounts");

// ─── Training sites, ranked by difficulty ───────────────────────────────

interface TrainingSite {
  name: string;
  url: string;
  signupUrl?: string;
  tier: 1 | 2 | 3;
  hasGoogle: boolean;
  hasCaptcha: boolean;
  notes: string;
  fields: string[]; // expected fields: email, username, password, name, etc.
}

const TRAINING_SITES: TrainingSite[] = [
  // ─── Tier 1: Easy (no CAPTCHA, simple forms) ──────────────
  {
    name: "Hacker News",
    url: "https://news.ycombinator.com",
    signupUrl: "https://news.ycombinator.com/login?creating=t",
    tier: 1,
    hasGoogle: false,
    hasCaptcha: false,
    notes: "Simple form: username + password only. No email required.",
    fields: ["username", "password"],
  },
  {
    name: "Lobsters",
    url: "https://lobste.rs",
    signupUrl: "https://lobste.rs/signup",
    tier: 1,
    hasGoogle: false,
    hasCaptcha: false,
    notes: "Invite-only but form exists. Good for testing form detection.",
    fields: ["email", "username", "password"],
  },
  {
    name: "Dev.to",
    url: "https://dev.to",
    signupUrl: "https://dev.to/enter?state=new-user",
    tier: 1,
    hasGoogle: true,
    hasCaptcha: false,
    notes: "Multiple OAuth options (GitHub, Google, Twitter, Apple). Email signup also available.",
    fields: ["email"],
  },
  {
    name: "Codeberg",
    url: "https://codeberg.org",
    signupUrl: "https://codeberg.org/user/sign_up",
    tier: 1,
    hasGoogle: false,
    hasCaptcha: true,
    notes: "Gitea-based. Simple form with username/email/password. May have basic CAPTCHA.",
    fields: ["username", "email", "password"],
  },

  // ─── Tier 2: Medium (Google OAuth or simple CAPTCHA) ──────
  {
    name: "HuggingFace",
    url: "https://huggingface.co",
    signupUrl: "https://huggingface.co/join",
    tier: 2,
    hasGoogle: false,
    hasCaptcha: true,
    notes: "Email+password form with potential CAPTCHA. Important for AI tools.",
    fields: ["email", "username", "password", "name"],
  },
  {
    name: "RapidAPI",
    url: "https://rapidapi.com",
    signupUrl: "https://rapidapi.com/auth/sign-up",
    tier: 2,
    hasGoogle: true,
    hasCaptcha: false,
    notes: "Google OAuth available. API marketplace — useful for discovering APIs.",
    fields: ["email"],
  },
  {
    name: "Replit",
    url: "https://replit.com",
    signupUrl: "https://replit.com/signup",
    tier: 2,
    hasGoogle: true,
    hasCaptcha: true,
    notes: "Google OAuth + email. May have Cloudflare protection.",
    fields: ["email", "username", "password"],
  },
  {
    name: "OpenWeatherMap",
    url: "https://openweathermap.org",
    signupUrl: "https://home.openweathermap.org/users/sign_up",
    tier: 2,
    hasGoogle: false,
    hasCaptcha: true,
    notes: "Free API key after signup. Good test for API key extraction.",
    fields: ["username", "email", "password"],
  },

  // ─── Tier 3: Hard (complex CAPTCHA + 2FA) ─────────────────
  {
    name: "2Captcha",
    url: "https://2captcha.com",
    signupUrl: "https://2captcha.com/auth/register",
    tier: 2,
    hasGoogle: true,
    hasCaptcha: true,
    notes: "Already have account. Need to extract API key from dashboard.",
    fields: ["email"],
  },
  {
    name: "GitHub",
    url: "https://github.com",
    signupUrl: "https://github.com/signup",
    tier: 3,
    hasGoogle: false,
    hasCaptcha: true,
    notes: "Multi-step signup with CAPTCHA puzzle. Complex form flow.",
    fields: ["email", "password", "username"],
  },
  {
    name: "Google Cloud",
    url: "https://console.cloud.google.com",
    tier: 3,
    hasGoogle: true,
    hasCaptcha: true,
    notes: "Requires Google account (already have). API key creation in console.",
    fields: [],
  },
  {
    name: "Stripe",
    url: "https://dashboard.stripe.com",
    signupUrl: "https://dashboard.stripe.com/register",
    tier: 3,
    hasGoogle: false,
    hasCaptcha: true,
    notes: "Complex form, reCAPTCHA, email verification, possible phone verification.",
    fields: ["email", "name", "password"],
  },
];

// ─── Training log management ────────────────────────────────────────

interface TrainingResult {
  site: string;
  url: string;
  tier: number;
  timestamp: string;
  success: boolean;
  steps: string[];
  error?: string;
  captchaDetected?: string;
  captchaSolved?: boolean;
  fieldsFound: string[];
  fieldsFilled: string[];
  formSubmitted: boolean;
  timeMs: number;
}

function loadTrainingLog(): TrainingResult[] {
  try {
    if (fs.existsSync(TRAINING_LOG)) {
      return JSON.parse(fs.readFileSync(TRAINING_LOG, "utf-8"));
    }
  } catch { /* corrupted file */ }
  return [];
}

function saveTrainingLog(results: TrainingResult[]): void {
  const dir = path.dirname(TRAINING_LOG);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(TRAINING_LOG, JSON.stringify(results, null, 2));
}

function addTrainingResult(result: TrainingResult): void {
  const log = loadTrainingLog();
  log.push(result);
  // Keep last 200 results
  if (log.length > 200) log.splice(0, log.length - 200);
  saveTrainingLog(log);
}

// ─── Core training: test a single site ──────────────────────────────

async function trainOnSite(
  site: TrainingSite,
  chatId: number,
  dryRun: boolean,
): Promise<TrainingResult> {
  const startTime = Date.now();
  const steps: string[] = [];
  const result: TrainingResult = {
    site: site.name,
    url: site.url,
    tier: site.tier,
    timestamp: new Date().toISOString(),
    success: false,
    steps: [],
    fieldsFound: [],
    fieldsFilled: [],
    formSubmitted: false,
    timeMs: 0,
  };

  try {
    const page = await browserManager.getPage();
    const targetUrl = site.signupUrl || site.url;

    // Step 1: Navigate
    steps.push(`[1] Navigating to ${targetUrl}`);
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await humanDelay(1500, 3000);
    steps.push(`[1] ✓ Page loaded: ${page.url()}`);

    // Step 2: CAPTCHA detection
    const solver = new CaptchaSolver(page);
    const detection = await solver.detect();
    if (detection.type !== "none") {
      result.captchaDetected = detection.type;
      steps.push(`[2] CAPTCHA detected: ${detection.type} (confidence: ${detection.confidence})`);

      if (!dryRun) {
        const solveResult = await solver.solve();
        result.captchaSolved = solveResult.success;
        steps.push(`[2] CAPTCHA solve: ${solveResult.success ? "✓" : "✗"} (${solveResult.method}, ${solveResult.timeMs}ms)`);
        if (!solveResult.success) {
          steps.push(`[2] Error: ${solveResult.error}`);
        }
      } else {
        steps.push(`[2] DRY RUN — skipping CAPTCHA solve`);
      }
    } else {
      steps.push(`[2] No CAPTCHA detected ✓`);
    }

    // Step 3: Find signup form or link
    if (!site.signupUrl) {
      // Need to find signup page
      const signupSelectors = [
        'a:has-text("Sign up")', 'a:has-text("Register")',
        'a:has-text("Create account")', 'a:has-text("Get started")',
        'a:has-text("S\'inscrire")', 'a:has-text("Créer un compte")',
        'button:has-text("Sign up")', 'button:has-text("Register")',
        'button:has-text("Get started")',
      ];

      let foundSignup = false;
      for (const sel of signupSelectors) {
        try {
          const el = page.locator(sel).first();
          if ((await el.count()) > 0 && (await el.isVisible())) {
            steps.push(`[3] Found signup link: ${sel}`);
            if (!dryRun) {
              await el.click();
              await humanDelay(2000, 4000);
              steps.push(`[3] Navigated to signup page: ${page.url()}`);
            }
            foundSignup = true;
            break;
          }
        } catch { continue; }
      }

      if (!foundSignup) {
        steps.push(`[3] ✗ No signup link found on page`);
      }
    }

    // Step 4: Detect form fields
    const fieldSelectors: Record<string, string[]> = {
      email: [
        'input[type="email"]', 'input[name="email"]', '#email',
        'input[placeholder*="email" i]', 'input[autocomplete="email"]',
      ],
      username: [
        'input[name="username"]', '#username', 'input[name="login"]',
        'input[placeholder*="username" i]', 'input[autocomplete="username"]',
      ],
      password: [
        'input[type="password"]', 'input[name="password"]', '#password',
        'input[placeholder*="password" i]', 'input[autocomplete="new-password"]',
      ],
      name: [
        'input[name="name"]', 'input[name="fullname"]', '#name',
        'input[placeholder*="name" i]:not([placeholder*="user"])',
        'input[autocomplete="name"]',
      ],
      firstName: [
        'input[name="first_name"]', 'input[name="firstName"]',
        '#first-name', '#firstName', 'input[placeholder*="first name" i]',
      ],
      lastName: [
        'input[name="last_name"]', 'input[name="lastName"]',
        '#last-name', '#lastName', 'input[placeholder*="last name" i]',
      ],
    };

    for (const [fieldName, selectors] of Object.entries(fieldSelectors)) {
      for (const sel of selectors) {
        try {
          const el = page.locator(sel).first();
          if ((await el.count()) > 0 && (await el.isVisible())) {
            result.fieldsFound.push(fieldName);
            steps.push(`[4] Found field: ${fieldName} via ${sel}`);
            break;
          }
        } catch { continue; }
      }
    }

    steps.push(`[4] Fields found: ${result.fieldsFound.length > 0 ? result.fieldsFound.join(", ") : "NONE"}`);

    // Step 5: Fill fields (only if not dry run)
    if (!dryRun && result.fieldsFound.length > 0) {
      const values: Record<string, string> = {
        email: "kingston.orchestrator@gmail.com",
        username: "Kingston_CDR",
        password: "K!ngst0n_Tr4in_" + Math.random().toString(36).slice(2, 6),
        name: "Kingston CDR",
        firstName: "Kingston",
        lastName: "CDR",
      };

      for (const fieldName of result.fieldsFound) {
        const selectors = fieldSelectors[fieldName];
        if (!selectors) continue;
        for (const sel of selectors) {
          try {
            const el = page.locator(sel).first();
            if ((await el.count()) > 0 && (await el.isVisible())) {
              await el.click();
              await humanDelay(100, 300);
              await page.keyboard.press("Control+a");
              await humanDelay(50, 100);
              // Type char by char for human-like behavior
              const value = values[fieldName] || "";
              for (const char of value) {
                await page.keyboard.type(char, {
                  delay: Math.floor(Math.random() * 80) + 30,
                });
              }
              await humanDelay(200, 500);
              result.fieldsFilled.push(fieldName);
              steps.push(`[5] Filled: ${fieldName}`);
              break;
            }
          } catch { continue; }
        }
      }
    }

    // Step 6: Detect Google OAuth button
    if (site.hasGoogle) {
      const googleSelectors = [
        'button:has-text("Sign in with Google")',
        'button:has-text("Continue with Google")',
        'a:has-text("Google")',
        '[data-provider="google"]',
        'button:has-text("Google")',
        'a[href*="accounts.google.com"]',
      ];

      let foundGoogle = false;
      for (const sel of googleSelectors) {
        try {
          const el = page.locator(sel).first();
          if ((await el.count()) > 0 && (await el.isVisible())) {
            steps.push(`[6] Google OAuth found: ${sel}`);
            foundGoogle = true;
            break;
          }
        } catch { continue; }
      }
      if (!foundGoogle) {
        steps.push(`[6] Google OAuth NOT found (expected: true)`);
      }
    }

    // Step 7: Detect submit button
    const submitSelectors = [
      'button[type="submit"]',
      'button:has-text("Sign up")', 'button:has-text("Register")',
      'button:has-text("Create")', 'button:has-text("Submit")',
      'button:has-text("Join")', 'button:has-text("Get started")',
      'button:has-text("Continue")', 'button:has-text("Next")',
      'input[type="submit"]',
    ];

    let foundSubmit = false;
    for (const sel of submitSelectors) {
      try {
        const el = page.locator(sel).first();
        if ((await el.count()) > 0 && (await el.isVisible())) {
          steps.push(`[7] Submit button found: ${sel}`);
          foundSubmit = true;

          if (!dryRun && result.fieldsFilled.length > 0) {
            // Don't actually submit during training unless explicitly told
            steps.push(`[7] TRAINING MODE — not submitting form`);
          }
          break;
        }
      } catch { continue; }
    }
    if (!foundSubmit) {
      steps.push(`[7] ✗ No submit button found`);
    }

    // Step 8: Take screenshot for review
    if (chatId > 0) {
      try {
        const buf = await page.screenshot({ type: "png", fullPage: false });
        const { getBotPhotoFn } = await import("./telegram.js");
        const sendPhoto = getBotPhotoFn();
        if (sendPhoto) {
          await sendPhoto(chatId, buf, `Training: ${site.name} (Tier ${site.tier})`);
        }
      } catch { /* non-critical */ }
    }

    // Determine success based on what was found
    const expectedFields = site.fields.length;
    const foundFields = result.fieldsFound.length;
    const detectionRate = expectedFields > 0 ? foundFields / expectedFields : 1;

    result.success = detectionRate >= 0.5 || (site.hasGoogle && steps.some(s => s.includes("Google OAuth found")));
    result.formSubmitted = false; // Training mode — never actually submit

    steps.push(`\n[RESULT] Detection rate: ${Math.round(detectionRate * 100)}% (${foundFields}/${expectedFields} fields)`);
    steps.push(`[RESULT] ${result.success ? "PASS ✓" : "FAIL ✗"}`);

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.error = msg;
    steps.push(`[ERROR] ${msg}`);
  }

  result.steps = steps;
  result.timeMs = Date.now() - startTime;
  return result;
}

// ─── account.train skill ────────────────────────────────────────────

registerSkill({
  name: "account.train",
  description:
    "Training mode: systematically test account creation on websites ranked by difficulty (Tier 1-3). " +
    "Detects forms, fields, CAPTCHAs, and OAuth buttons without actually creating accounts. " +
    "Use tier:1 for easy sites, tier:2 for medium, tier:3 for hard. Use site:<name> to test a specific site. " +
    "Use submit:true to actually attempt account creation (not just detection).",
  adminOnly: true,
  timeoutMs: 120000, // 2 min per training run
  argsSchema: {
    type: "object",
    properties: {
      tier: {
        type: "string",
        description: 'Tier to train on: "1" (easy), "2" (medium), "3" (hard), "all" (default: "1")',
      },
      site: {
        type: "string",
        description: 'Specific site name to test (e.g. "Dev.to", "HuggingFace")',
      },
      submit: {
        type: "string",
        description: 'Actually submit the form? "true" to attempt real signup. Default: false (detection only).',
      },
      chatId: {
        type: "string",
        description: "Telegram chat ID for screenshots",
      },
    },
  },
  async execute(args): Promise<string> {
    const tier = String(args.tier || "1");
    const specificSite = args.site ? String(args.site).toLowerCase() : null;
    const dryRun = String(args.submit) !== "true";
    const chatId = Number(args.chatId) || 0;

    // Select sites to test
    let sites: TrainingSite[];

    if (specificSite) {
      sites = TRAINING_SITES.filter(s => s.name.toLowerCase().includes(specificSite));
      if (sites.length === 0) {
        return `Site "${args.site}" non trouvé. Sites disponibles:\n${TRAINING_SITES.map(s => `• ${s.name} (Tier ${s.tier})`).join("\n")}`;
      }
    } else if (tier === "all") {
      sites = TRAINING_SITES;
    } else {
      const tierNum = parseInt(tier) || 1;
      sites = TRAINING_SITES.filter(s => s.tier === tierNum);
    }

    const allResults: TrainingResult[] = [];
    const report: string[] = [`**🎯 TRAINING MODE ${dryRun ? "(detection only)" : "(LIVE — will submit!)"}**\n`];
    report.push(`Sites à tester: ${sites.length}\n`);

    for (const site of sites) {
      report.push(`\n--- ${site.name} (Tier ${site.tier}) ---`);
      log.info(`[account.train] Testing: ${site.name}`);

      try {
        const result = await trainOnSite(site, chatId, dryRun);
        allResults.push(result);
        addTrainingResult(result);

        // Summarize result
        const icon = result.success ? "✅" : "❌";
        report.push(`${icon} ${result.success ? "PASS" : "FAIL"} — ${result.timeMs}ms`);
        report.push(`   Fields: ${result.fieldsFound.join(", ") || "none"}`);
        if (result.captchaDetected) {
          report.push(`   CAPTCHA: ${result.captchaDetected} (solved: ${result.captchaSolved ?? "skipped"})`);
        }
        if (result.error) {
          report.push(`   Error: ${result.error.slice(0, 100)}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        report.push(`❌ CRASH: ${msg.slice(0, 100)}`);
      }

      // Brief pause between sites to avoid rate limiting
      await humanDelay(1000, 2000);
    }

    // Summary
    const passed = allResults.filter(r => r.success).length;
    const failed = allResults.filter(r => !r.success).length;
    report.push(`\n**SUMMARY: ${passed}/${allResults.length} passed, ${failed} failed**`);

    if (failed > 0) {
      report.push(`\nÉchecs:`);
      for (const r of allResults.filter(r => !r.success)) {
        report.push(`• ${r.site}: ${r.error || "detection rate < 50%"}`);
      }
    }

    report.push(`\nLog complet: relay/training-log.json`);

    return report.join("\n");
  },
});

// ─── account.train_report — show training history ───────────────────

registerSkill({
  name: "account.train_report",
  description: "Show training history and success rates per site and tier.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      limit: { type: "string", description: "Number of recent results (default: 20)" },
    },
  },
  async execute(args): Promise<string> {
    const limit = parseInt(String(args.limit || "20"));
    const results = loadTrainingLog();

    if (results.length === 0) {
      return "Aucun résultat d'entraînement. Lance `account.train` pour commencer.";
    }

    const recent = results.slice(-limit);
    const report: string[] = [`**📊 Training Report** (${results.length} total runs)\n`];

    // Stats by tier
    const byTier: Record<number, { pass: number; fail: number }> = {};
    for (const r of results) {
      if (!byTier[r.tier]) byTier[r.tier] = { pass: 0, fail: 0 };
      if (r.success) byTier[r.tier].pass++; else byTier[r.tier].fail++;
    }

    report.push("**Par tier:**");
    for (const [tier, stats] of Object.entries(byTier)) {
      const total = stats.pass + stats.fail;
      const rate = Math.round((stats.pass / total) * 100);
      report.push(`  Tier ${tier}: ${rate}% (${stats.pass}/${total})`);
    }

    // Stats by site
    const bySite: Record<string, { pass: number; fail: number; lastError?: string }> = {};
    for (const r of results) {
      if (!bySite[r.site]) bySite[r.site] = { pass: 0, fail: 0 };
      if (r.success) bySite[r.site].pass++; else {
        bySite[r.site].fail++;
        bySite[r.site].lastError = r.error;
      }
    }

    report.push("\n**Par site:**");
    for (const [site, stats] of Object.entries(bySite)) {
      const total = stats.pass + stats.fail;
      const rate = Math.round((stats.pass / total) * 100);
      const icon = rate >= 80 ? "🟢" : rate >= 50 ? "🟡" : "🔴";
      report.push(`${icon} ${site}: ${rate}% (${stats.pass}/${total})${stats.lastError ? ` — ${stats.lastError.slice(0, 60)}` : ""}`);
    }

    // Recent results
    report.push("\n**Derniers résultats:**");
    for (const r of recent.slice(-10)) {
      const icon = r.success ? "✅" : "❌";
      const date = r.timestamp.split("T")[0];
      report.push(`${icon} ${date} ${r.site} (${r.timeMs}ms) — fields: ${r.fieldsFound.join(",") || "none"}`);
    }

    return report.join("\n");
  },
});

// ─── account.sites — list available training sites ──────────────────

registerSkill({
  name: "account.sites",
  description: "List all known websites for account creation training, grouped by difficulty tier.",
  adminOnly: true,
  argsSchema: { type: "object", properties: {} },
  async execute(): Promise<string> {
    const report: string[] = ["**🎯 Sites d'entraînement disponibles:**\n"];

    // Check which sites we already have accounts on
    const existingAccounts = new Set<string>();
    if (fs.existsSync(ACCOUNTS_DIR)) {
      for (const file of fs.readdirSync(ACCOUNTS_DIR)) {
        existingAccounts.add(file.replace(".json", ""));
      }
    }

    for (const tier of [1, 2, 3]) {
      const tierLabel = tier === 1 ? "Easy" : tier === 2 ? "Medium" : "Hard";
      report.push(`\n**Tier ${tier} — ${tierLabel}:**`);

      for (const site of TRAINING_SITES.filter(s => s.tier === tier)) {
        const hostname = new URL(site.url).hostname.replace(/^www\./, "");
        const hasAccount = existingAccounts.has(hostname);
        const icon = hasAccount ? "✅" : "⬜";
        const captcha = site.hasCaptcha ? "🔒" : "🔓";
        const google = site.hasGoogle ? "🔵G" : "";
        report.push(`${icon} ${captcha} ${google} **${site.name}** — ${site.url}`);
        report.push(`   Fields: ${site.fields.join(", ") || "none"} | ${site.notes}`);
      }
    }

    report.push(`\n\n**Légende:** ✅=compte créé ⬜=pas de compte 🔒=CAPTCHA 🔓=pas de CAPTCHA 🔵G=Google OAuth`);
    return report.join("\n");
  },
});

log.info("[account.train] Training skills registered");
