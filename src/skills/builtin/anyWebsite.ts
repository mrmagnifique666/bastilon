/**
 * any.website — Autonomous website interaction skill.
 * Kingston can:
 *   1. Sign up to any website autonomously (Google or email)
 *   2. Navigate and use the site to achieve a goal
 *   3. Find and extract API keys automatically
 *   4. Verify email confirmations via Gmail
 *
 * This is the "master skill" for autonomous web usage.
 */
import { registerSkill } from "../loader.js";
import { browserManager } from "../../browser/manager.js";
import { log } from "../../utils/log.js";
import * as fs from "node:fs";
import * as path from "node:path";

const GOOGLE_EMAIL = "kingston.orchestrator@gmail.com";
const SESSION_DIR = path.resolve(process.cwd(), "relay", "browser-profile");
const ACCOUNTS_DIR = path.resolve(process.cwd(), "relay", "accounts");
const GOOGLE_COOKIES_FILE = path.join(SESSION_DIR, "google-session.json");

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function hasGoogleSession(): boolean {
  return fs.existsSync(GOOGLE_COOKIES_FILE);
}

function generatePassword(): string {
  const chars = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$";
  let pw = "K!";
  for (let i = 0; i < 14; i++) pw += chars[Math.floor(Math.random() * chars.length)];
  return pw;
}

function saveAccount(domain: string, data: Record<string, string>): void {
  if (!fs.existsSync(ACCOUNTS_DIR)) fs.mkdirSync(ACCOUNTS_DIR, { recursive: true });
  const file = path.join(ACCOUNTS_DIR, `${domain}.json`);
  const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf-8")) : {};
  fs.writeFileSync(file, JSON.stringify({ ...existing, ...data, updated: new Date().toISOString() }, null, 2));
}

function loadAccount(domain: string): Record<string, string> | null {
  const file = path.join(ACCOUNTS_DIR, `${domain}.json`);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, "utf-8")); } catch { return null; }
}

// ─── API key patterns (regex) ────────────────────────────────────────────────
const API_KEY_PATTERNS = [
  /(?:api[_-]?key|apikey|access[_-]?token|secret[_-]?key|bearer|token)\s*[=:'"]\s*([a-zA-Z0-9_\-./+]{20,})/gi,
  /(?:sk|pk|ak|ek|rk)-[a-zA-Z0-9_\-]{20,}/g,
  /[a-f0-9]{32,64}/g, // hex keys
];

function extractApiKeys(text: string): string[] {
  const keys: string[] = [];
  for (const pattern of API_KEY_PATTERNS) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const key = match[1] || match[0];
      if (key.length >= 20 && !keys.includes(key)) keys.push(key);
    }
    pattern.lastIndex = 0;
  }
  return keys.slice(0, 5); // max 5 candidates
}

// ─── Common API page URL patterns ───────────────────────────────────────────
const API_PAGE_PATTERNS = [
  "/api", "/api-keys", "/api/keys", "/settings/api",
  "/settings/developer", "/settings/tokens",
  "/developer", "/developers",
  "/dashboard/api", "/dashboard/settings",
  "/account/api", "/account/developer",
  "/console", "/console/api",
  "/profile/api", "/user/api-keys",
];

// ─── any.website (main skill) ─────────────────────────────────────────────────

registerSkill({
  name: "any.website",
  description:
    "Autonomously interact with any website: sign up (Google or email), navigate, use the site, find and return API keys. Kingston handles everything — signup, email confirmation, navigation, key extraction.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "Base URL of the website (e.g. https://openweathermap.org)",
      },
      goal: {
        type: "string",
        description:
          'What to do on the site: "get_api_key", "signup", "login", "use:<describe action>", or free text describing the goal',
      },
      chatId: {
        type: "string",
        description: "Telegram chat ID for progress screenshots (optional)",
      },
    },
    required: ["url", "goal"],
  },
  async execute(args): Promise<string> {
    const url = String(args.url).trim();
    const goal = String(args.goal || "get_api_key").toLowerCase().trim();
    const chatId = Number(args.chatId) || 0;

    let hostname: string;
    try {
      hostname = new URL(url.startsWith("http") ? url : `https://${url}`).hostname.replace(/^www\./, "");
    } catch {
      return `URL invalide: ${url}`;
    }

    const baseUrl = url.startsWith("http") ? url : `https://${url}`;
    const results: string[] = [`**any.website → ${hostname}**\nObjectif: ${goal}\n`];

    log.info(`[any.website] Starting: ${hostname}, goal: ${goal}`);

    try {
      const page = await browserManager.getPage();

      // ─── STEP 1: Check if we have an account ────────────────────────
      const account = loadAccount(hostname);
      let isLoggedIn = false;

      if (account?.email) {
        results.push(`📂 Compte existant: ${account.email}`);
      }

      // ─── STEP 2: Navigate to site ────────────────────────────────────
      await page.goto(baseUrl, { waitUntil: "networkidle", timeout: 30000 });
      await delay(2000);

      // Take screenshot for context
      if (chatId > 0) {
        try {
          const buf = await page.screenshot({ type: "png", fullPage: false });
          const { getBotPhotoFn } = await import("./telegram.js");
          const sendPhoto = getBotPhotoFn();
          if (sendPhoto) await sendPhoto(chatId, buf, `📸 ${hostname} — page d'accueil`);
        } catch { /* non-critical */ }
      }

      // ─── STEP 3: Sign up or log in ──────────────────────────────────
      if (!account) {
        results.push("\n🔐 Inscription en cours...");
        const signupResult = await attemptSignup(page, baseUrl, hostname, chatId);
        results.push(signupResult.message);
        if (signupResult.email) {
          saveAccount(hostname, {
            email: signupResult.email,
            password: signupResult.password || "",
            signedUpAt: new Date().toISOString(),
          });
        }
        isLoggedIn = signupResult.success;

        // Check Gmail for confirmation if needed
        if (signupResult.needsEmailConfirm) {
          results.push("\n📧 Vérification email en cours...");
          await delay(5000); // wait for email to arrive
          const confirmResult = await checkGmailConfirmation(page, hostname);
          results.push(confirmResult);
          await delay(3000);
        }
      } else {
        // Try to log in
        results.push("\n🔑 Connexion avec compte existant...");
        const loginResult = await attemptLogin(page, baseUrl, hostname, account, chatId);
        results.push(loginResult.message);
        isLoggedIn = loginResult.success;
      }

      // ─── STEP 4: Execute goal ────────────────────────────────────────
      if (goal === "signup" || goal === "login") {
        results.push("\n✅ Objectif atteint.");
        return results.join("\n");
      }

      if (goal === "get_api_key" || goal.includes("api")) {
        results.push("\n🔍 Recherche de la clé API...");
        const keyResult = await findApiKey(page, baseUrl, hostname, chatId);
        results.push(keyResult.message);

        if (keyResult.keys.length > 0) {
          saveAccount(hostname, { apiKey: keyResult.keys[0], apiKeyFoundAt: new Date().toISOString() });
          results.push(`\n✅ Clé API trouvée et sauvegardée dans relay/accounts/${hostname}.json`);
        }
        return results.join("\n");
      }

      // Free-form goal — describe what's visible
      if (goal.startsWith("use:")) {
        const action = goal.replace("use:", "").trim();
        results.push(`\n⚡ Action: ${action}`);
        const pageText = await page.evaluate(() => document.body.innerText);
        results.push(`Contenu visible (extrait): ${pageText.slice(0, 500)}...`);
        results.push("\nUtilise browser.* pour continuer manuellement.");
      }

      return results.join("\n");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`[any.website] Error: ${msg}`);
      return `${results.join("\n")}\n\n❌ Erreur: ${msg}`;
    }
  },
});

// ─── Helper: attempt signup ──────────────────────────────────────────────────

async function attemptSignup(
  page: Awaited<ReturnType<typeof browserManager.getPage>>,
  baseUrl: string,
  hostname: string,
  chatId: number,
): Promise<{ success: boolean; message: string; email?: string; password?: string; needsEmailConfirm?: boolean }> {
  const email = GOOGLE_EMAIL;
  const password = generatePassword();

  // Try Google first
  if (hasGoogleSession()) {
    const googleBtn = page.locator([
      'button:has-text("Sign in with Google")',
      'button:has-text("Continue with Google")',
      'a:has-text("Google")',
      '[data-provider="google"]',
      'button:has-text("Google")',
    ].join(", "));

    if ((await googleBtn.count()) > 0) {
      await googleBtn.first().click();
      await delay(4000);

      const pages = page.context().pages();
      const gPage = pages.find((p) => p.url().includes("accounts.google.com"));
      if (gPage) {
        const acctBtn = gPage.locator(`div[data-email="${email}"], li:has-text("${email}")`);
        if ((await acctBtn.count()) > 0) await acctBtn.first().click();
        await delay(2000);
        const allow = gPage.locator('button:has-text("Allow"), button:has-text("Autoriser"), button:has-text("Continue")');
        if ((await allow.count()) > 0) await allow.first().click();
        await delay(3000);
      }

      return { success: true, message: `✅ Inscrit via Google (${email})`, email };
    }
  }

  // Navigate to signup page
  const signupLinks = ["/signup", "/register", "/sign-up", "/create-account", "/join"];
  let foundSignup = false;

  for (const link of signupLinks) {
    try {
      await page.goto(`${baseUrl}${link}`, { waitUntil: "networkidle", timeout: 10000 });
      await delay(1000);
      const emailInput = page.locator('input[type="email"]').first();
      if ((await emailInput.count()) > 0 && (await emailInput.isVisible())) {
        foundSignup = true;
        break;
      }
    } catch { continue; }
  }

  if (!foundSignup) {
    // Try clicking signup links on current page
    const signupLink = page.locator([
      'a:has-text("Sign up")', 'a:has-text("Register")', 'a:has-text("Get started")',
      'a:has-text("Create account")', 'button:has-text("Sign up")',
      'a:has-text("S\'inscrire")', 'a:has-text("Créer un compte")',
    ].join(", "));

    if ((await signupLink.count()) > 0) {
      await signupLink.first().click();
      await delay(3000);
    }
  }

  // Fill form
  const fields: Record<string, string[]> = {
    email: ['input[type="email"]', 'input[name="email"]', '#email'],
    password: ['input[type="password"]', 'input[name="password"]', '#password'],
    username: ['input[name="username"]', '#username', 'input[placeholder*="username" i]'],
    name: ['input[name="name"]', 'input[name="fullname"]', '#name', 'input[placeholder*="name" i]'],
    firstName: ['input[name="first_name"]', 'input[name="firstName"]', '#first-name', '#firstName'],
    lastName: ['input[name="last_name"]', 'input[name="lastName"]', '#last-name', '#lastName'],
  };

  let filled = 0;
  for (const [field, selectors] of Object.entries(fields)) {
    for (const sel of selectors) {
      const el = page.locator(sel).first();
      if ((await el.count()) > 0 && (await el.isVisible())) {
        const value = field === "email" ? email
          : field === "password" ? password
          : field === "username" ? "Kingston_CDR"
          : field === "name" ? "Kingston CDR"
          : field === "firstName" ? "Kingston"
          : "CDR";
        await el.fill(value);
        filled++;
        break;
      }
    }
  }

  // Confirm password
  const confirmPw = page.locator('input[name="password_confirmation"], input[name="confirmPassword"], input[name="confirm_password"]').first();
  if ((await confirmPw.count()) > 0 && (await confirmPw.isVisible())) {
    await confirmPw.fill(password);
  }

  // Check terms
  const terms = page.locator('input[type="checkbox"][name*="terms" i], input[type="checkbox"][name*="agree" i]').first();
  if ((await terms.count()) > 0) await terms.check().catch(() => {});

  if (filled === 0) {
    return { success: false, message: "❌ Formulaire d'inscription non trouvé ou non reconnu." };
  }

  // Submit
  const submitBtn = page.locator([
    'button[type="submit"]', 'button:has-text("Sign up")', 'button:has-text("Register")',
    'button:has-text("Create")', 'button:has-text("Créer")', 'input[type="submit"]',
  ].join(", "));

  if ((await submitBtn.count()) > 0) {
    await submitBtn.first().click();
    await delay(5000);
  }

  const finalUrl = page.url();
  const needsEmailConfirm = finalUrl.includes("verify") || finalUrl.includes("confirm") ||
    (await page.locator("text=/confirm.*email|verify.*email|vérif/i").count()) > 0;

  return {
    success: true,
    message: `✅ Formulaire rempli (${email})\nURL: ${finalUrl}${needsEmailConfirm ? "\n⚠️ Confirmation email requise" : ""}`,
    email,
    password,
    needsEmailConfirm,
  };
}

// ─── Helper: attempt login ───────────────────────────────────────────────────

async function attemptLogin(
  page: Awaited<ReturnType<typeof browserManager.getPage>>,
  baseUrl: string,
  hostname: string,
  account: Record<string, string>,
  chatId: number,
): Promise<{ success: boolean; message: string }> {
  // Navigate to login page
  const loginPaths = ["/login", "/signin", "/sign-in", "/auth", "/account/login"];
  for (const p of loginPaths) {
    try {
      await page.goto(`${baseUrl}${p}`, { waitUntil: "networkidle", timeout: 10000 });
      const emailInput = page.locator('input[type="email"]').first();
      if ((await emailInput.count()) > 0 && (await emailInput.isVisible())) break;
    } catch { continue; }
  }

  const emailInput = page.locator('input[type="email"]').first();
  if ((await emailInput.count()) === 0) {
    return { success: false, message: "Page de login non trouvée." };
  }

  await emailInput.fill(account.email || GOOGLE_EMAIL);
  await delay(300);

  const pwInput = page.locator('input[type="password"]').first();
  if ((await pwInput.count()) > 0) await pwInput.fill(account.password || "");
  await delay(300);

  const submitBtn = page.locator('button[type="submit"], button:has-text("Login"), button:has-text("Sign in")').first();
  if ((await submitBtn.count()) > 0) {
    await submitBtn.click();
    await delay(4000);
  }

  return { success: true, message: `✅ Login tenté avec ${account.email}. URL: ${page.url()}` };
}

// ─── Helper: find API key ────────────────────────────────────────────────────

async function findApiKey(
  page: Awaited<ReturnType<typeof browserManager.getPage>>,
  baseUrl: string,
  hostname: string,
  chatId: number,
): Promise<{ keys: string[]; message: string }> {
  const allKeys: string[] = [];
  const checked: string[] = [];

  for (const pattern of API_PAGE_PATTERNS) {
    const target = `${baseUrl}${pattern}`;
    try {
      await page.goto(target, { waitUntil: "networkidle", timeout: 10000 });
      await delay(1500);
      checked.push(pattern);

      const pageText = await page.evaluate(() => document.body.innerText);
      const keys = extractApiKeys(pageText);

      if (keys.length > 0) {
        allKeys.push(...keys);
        log.info(`[any.website] Found ${keys.length} key(s) on ${target}`);

        // Screenshot the page with the key
        if (chatId > 0) {
          try {
            const buf = await page.screenshot({ type: "png" });
            const { getBotPhotoFn } = await import("./telegram.js");
            const sendPhoto = getBotPhotoFn();
            if (sendPhoto) await sendPhoto(chatId, buf, `🔑 Clé API trouvée sur ${pattern}`);
          } catch { /* non-critical */ }
        }

        break; // Found one, stop
      }

      // Look for "Generate" or "Create" key button
      const genBtn = page.locator([
        'button:has-text("Generate")', 'button:has-text("Create")',
        'button:has-text("New key")', 'button:has-text("Add key")',
        'button:has-text("Générer")', 'button:has-text("Créer une clé")',
      ].join(", "));

      if ((await genBtn.count()) > 0) {
        await genBtn.first().click();
        await delay(3000);

        const newPageText = await page.evaluate(() => document.body.innerText);
        const newKeys = extractApiKeys(newPageText);
        if (newKeys.length > 0) {
          allKeys.push(...newKeys);
          log.info(`[any.website] Generated ${newKeys.length} key(s) via button`);
          break;
        }
      }
    } catch { continue; }
  }

  if (allKeys.length === 0) {
    return {
      keys: [],
      message: `❌ Clé API non trouvée automatiquement.\nPages vérifiées: ${checked.slice(0, 5).join(", ")}\n\nUtilise browser.screenshot() + browser.navigate() pour trouver la page API manuellement.`,
    };
  }

  const uniqueKeys = [...new Set(allKeys)];
  return {
    keys: uniqueKeys,
    message: `🔑 **${uniqueKeys.length} clé(s) API trouvée(s):**\n${uniqueKeys.map((k, i) => `${i + 1}. \`${k.slice(0, 20)}...\``).join("\n")}\n\n✅ Clé complète sauvegardée dans relay/accounts/${hostname}.json`,
  };
}

// ─── Helper: check Gmail confirmation ───────────────────────────────────────

async function checkGmailConfirmation(
  page: Awaited<ReturnType<typeof browserManager.getPage>>,
  hostname: string,
): Promise<string> {
  // Wait a few seconds for the email to arrive, then check via browser
  await delay(8000);

  try {
    // Navigate to Gmail and search for confirmation email
    await page.goto(`https://mail.google.com/mail/u/0/#search/from%3A${encodeURIComponent(hostname)}+newer_than%3A1h`, {
      waitUntil: "networkidle",
      timeout: 15000,
    });
    await delay(3000);

    // Look for confirmation link in emails
    const emailRow = page.locator('tr.zA').first();
    if ((await emailRow.count()) > 0) {
      await emailRow.click();
      await delay(2000);

      // Look for "confirm" or "verify" links
      const confirmLink = page.locator('a[href*="confirm"], a[href*="verify"], a[href*="activate"]').first();
      if ((await confirmLink.count()) > 0) {
        const href = await confirmLink.getAttribute("href");
        if (href) {
          await page.goto(href, { waitUntil: "networkidle", timeout: 15000 });
          await delay(3000);
          return `✅ Email confirmé automatiquement! URL: ${page.url()}`;
        }
      }
    }

    return `📧 Email de confirmation de ${hostname} non trouvé ou déjà expiré. Vérifie Gmail manuellement.`;
  } catch {
    return `📧 Vérifie Kingston.orchestrator@gmail.com pour confirmer l'inscription à ${hostname}.`;
  }
}

log.info("[any.website] Skill registered");
