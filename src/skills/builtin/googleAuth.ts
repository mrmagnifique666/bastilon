/**
 * Google authentication & account creation skills.
 * Allows Kingston to:
 *   1. Log into Google via browser automation (google.login)
 *   2. Sign up to websites using "Sign in with Google" (google.signup)
 *   3. Create accounts with email+password fallback (account.create)
 *
 * Uses Playwright browser with stealth + saved session cookies.
 * Kingston's Google account: kingston.orchestrator@gmail.com
 */
import { registerSkill } from "../loader.js";
import { browserManager, humanDelay, humanType, humanClick } from "../../browser/manager.js";
import { handleCaptchaIfPresent, CaptchaSolver } from "../../browser/captcha-solver.js";
import { config } from "../../config/env.js";
import { log } from "../../utils/log.js";
import { getBotPhotoFn } from "./telegram.js";
import * as fs from "node:fs";
import * as path from "node:path";

const GOOGLE_EMAIL = "kingston.orchestrator@gmail.com";
const GOOGLE_PW_ENV = "KINGSTON_EMAIL_PW";
const SESSION_DIR = path.resolve(process.cwd(), "relay", "browser-profile");
const GOOGLE_COOKIES_FILE = path.join(SESSION_DIR, "google-session.json");

// ─── Helpers ────────────────────────────────────────────────────────

async function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Check if we have saved Google cookies */
function hasGoogleSession(): boolean {
  return fs.existsSync(GOOGLE_COOKIES_FILE);
}

/** Take screenshot and send to chat if possible */
async function screenshotToChat(chatId: number, label: string): Promise<void> {
  try {
    const page = await browserManager.getPage();
    const sendPhoto = getBotPhotoFn();
    if (!sendPhoto || !chatId || chatId <= 0) return;
    const buf = await page.screenshot({ type: "png", fullPage: false });
    await sendPhoto(chatId, buf, label);
  } catch {
    // Non-critical, ignore
  }
}

// ─── google.login ───────────────────────────────────────────────────

registerSkill({
  name: "google.login",
  description:
    "Log into Google (kingston.orchestrator@gmail.com) via browser automation. Saves session cookies for future use. Must be done once — then all 'Sign in with Google' flows work automatically.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      chatId: {
        type: "string",
        description: "Telegram chat ID to send screenshots to (optional)",
      },
      force: {
        type: "string",
        description: 'Set to "true" to force re-login even if session exists',
      },
    },
  },
  async execute(args): Promise<string> {
    const chatId = Number(args.chatId) || 0;
    const force = String(args.force) === "true";

    // Check if already logged in
    if (hasGoogleSession() && !force) {
      return "Session Google déjà sauvegardée. Utilise force:true pour te reconnecter.";
    }

    const password = process.env[GOOGLE_PW_ENV];
    if (!password) {
      return `Erreur: ${GOOGLE_PW_ENV} manquant dans .env. Ajoute-le d'abord.`;
    }

    log.info("[google.login] Starting Google login flow...");

    try {
      const page = await browserManager.getPage();

      // Navigate to Google sign-in
      await page.goto("https://accounts.google.com/signin", {
        waitUntil: "networkidle",
        timeout: 30000,
      });
      await delay(2000);

      // Check if already logged in (redirected to myaccount)
      const currentUrl = page.url();
      if (currentUrl.includes("myaccount.google.com")) {
        // Already logged in, save session
        await saveGoogleSession();
        return "Déjà connecté à Google! Session sauvegardée.";
      }

      // Enter email
      const emailInput = page.locator('input[type="email"]');
      await emailInput.waitFor({ state: "visible", timeout: 10000 });
      await emailInput.fill(GOOGLE_EMAIL);
      await delay(500);

      // Click Next
      const nextBtn = page.locator("#identifierNext, button:has-text('Next'), button:has-text('Suivant')");
      await nextBtn.click();
      await delay(3000);

      // Enter password
      const pwInput = page.locator('input[type="password"]');
      await pwInput.waitFor({ state: "visible", timeout: 10000 });
      await pwInput.fill(password);
      await delay(500);

      // Click Next (password)
      const pwNext = page.locator("#passwordNext, button:has-text('Next'), button:has-text('Suivant')");
      await pwNext.click();
      await delay(5000);

      // Check for 2FA or verification challenges
      const url = page.url();
      if (url.includes("challenge") || url.includes("signin/v2")) {
        if (chatId > 0) await screenshotToChat(chatId, "Google demande une vérification");
        return "⚠️ Google demande une vérification supplémentaire (2FA/captcha). Utilise browser.setup_session pour te connecter manuellement, puis browser.save_session. Je récupérerai les cookies après.";
      }

      // Check if login successful
      if (
        url.includes("myaccount") ||
        url.includes("accounts.google.com/b/") ||
        url.includes("google.com/?")
      ) {
        await saveGoogleSession();
        if (chatId > 0) await screenshotToChat(chatId, "Connecté à Google ✅");
        return `✅ Connecté à Google (${GOOGLE_EMAIL}). Session sauvegardée. Je peux maintenant utiliser "Sign in with Google" sur n'importe quel site.`;
      }

      // Unknown state — screenshot for debug
      if (chatId > 0) await screenshotToChat(chatId, "État inconnu après login");
      return `Login en cours... URL actuelle: ${url}. Vérifie le browser ou utilise browser.setup_session pour compléter manuellement.`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`[google.login] Error: ${msg}`);
      return `Erreur login Google: ${msg}`;
    }
  },
});

/** Save Google session cookies to dedicated file */
async function saveGoogleSession(): Promise<void> {
  try {
    const context = browserManager.getContext();
    if (!context) return;
    if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });
    await context.storageState({ path: GOOGLE_COOKIES_FILE });
    // Also save to general state.json
    const generalState = path.join(SESSION_DIR, "state.json");
    await context.storageState({ path: generalState });
    log.info(`[google.login] Session saved to ${GOOGLE_COOKIES_FILE}`);
  } catch (err) {
    log.error(`[google.login] Failed to save session: ${err}`);
  }
}

// ─── google.signup ──────────────────────────────────────────────────

registerSkill({
  name: "google.signup",
  description:
    'Navigate to a website and click "Sign in with Google" to create an account or log in. Requires google.login to have been done first.',
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "URL of the website to sign up on (e.g. https://rapidapi.com)",
      },
      chatId: {
        type: "string",
        description: "Telegram chat ID for progress screenshots",
      },
    },
    required: ["url"],
  },
  async execute(args): Promise<string> {
    const url = String(args.url);
    const chatId = Number(args.chatId) || 0;

    if (!hasGoogleSession()) {
      return "Pas de session Google. Lance google.login d'abord.";
    }

    log.info(`[google.signup] Signing up on ${url} via Google...`);

    try {
      const page = await browserManager.getPage();

      await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
      await delay(2000);

      // Try to find "Sign in with Google" button — multiple common patterns
      const googleBtn = page.locator([
        'button:has-text("Sign in with Google")',
        'button:has-text("Continue with Google")',
        'button:has-text("Se connecter avec Google")',
        'button:has-text("Continuer avec Google")',
        'a:has-text("Sign in with Google")',
        'a:has-text("Continue with Google")',
        'a:has-text("Google")',
        '[data-provider="google"]',
        '.google-login',
        '.social-google',
        'button:has-text("Google")',
        'a[href*="accounts.google.com"]',
      ].join(", "));

      const count = await googleBtn.count();
      if (count === 0) {
        // Try to find a general sign-up/login page first
        const signupLink = page.locator([
          'a:has-text("Sign up")',
          'a:has-text("Sign in")',
          'a:has-text("Log in")',
          'a:has-text("Register")',
          'button:has-text("Sign up")',
          'button:has-text("Get started")',
          'a:has-text("S\'inscrire")',
          'a:has-text("Connexion")',
        ].join(", "));

        const signupCount = await signupLink.count();
        if (signupCount > 0) {
          await signupLink.first().click();
          await delay(3000);

          // Try again for Google button
          const googleBtn2 = page.locator([
            'button:has-text("Google")',
            'a:has-text("Google")',
            '[data-provider="google"]',
            'a[href*="accounts.google.com"]',
          ].join(", "));

          const count2 = await googleBtn2.count();
          if (count2 > 0) {
            await googleBtn2.first().click();
            await delay(5000);
          } else {
            if (chatId > 0) await screenshotToChat(chatId, "Pas de bouton Google trouvé");
            return `Pas de bouton "Sign in with Google" trouvé sur ${url}. Le site ne supporte peut-être pas Google auth. Utilise account.create pour un signup email+password.`;
          }
        } else {
          if (chatId > 0) await screenshotToChat(chatId, "Pas de signup/login trouvé");
          return `Pas de page signup/login trouvée sur ${url}.`;
        }
      } else {
        await googleBtn.first().click();
        await delay(5000);
      }

      // Handle Google consent screen (popup or redirect)
      const pages = page.context().pages();
      const googlePage = pages.find(
        (p) =>
          p.url().includes("accounts.google.com") ||
          p.url().includes("consent"),
      );

      if (googlePage) {
        // If there's a Google popup, handle account selection
        const accountBtn = googlePage.locator(
          `div[data-email="${GOOGLE_EMAIL}"], li:has-text("${GOOGLE_EMAIL}")`,
        );
        const accountCount = await accountBtn.count();
        if (accountCount > 0) {
          await accountBtn.first().click();
          await delay(3000);
        }

        // Allow permissions if prompted
        const allowBtn = googlePage.locator(
          'button:has-text("Allow"), button:has-text("Autoriser"), button:has-text("Continue")',
        );
        const allowCount = await allowBtn.count();
        if (allowCount > 0) {
          await allowBtn.first().click();
          await delay(3000);
        }
      }

      await delay(3000);
      const finalUrl = page.url();

      // Save updated session
      await saveGoogleSession();

      if (chatId > 0) await screenshotToChat(chatId, `Signup Google terminé: ${new URL(finalUrl).hostname}`);
      return `✅ Signup Google terminé sur ${new URL(finalUrl).hostname}.\nURL: ${finalUrl}\nSession cookies mise à jour.`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`[google.signup] Error: ${msg}`);
      return `Erreur signup Google: ${msg}`;
    }
  },
});

// ─── account.create (v2 — human-like + CAPTCHA + email verify) ──────

/** Human-like form filling: clicks field, clears it, types char by char */
async function humanFill(page: import("playwright").Page, selector: string, value: string): Promise<boolean> {
  try {
    const el = page.locator(selector).first();
    if ((await el.count()) === 0 || !(await el.isVisible())) return false;
    await el.click();
    await humanDelay(200, 500);
    // Select all + delete to clear
    await page.keyboard.press("Control+a");
    await humanDelay(50, 150);
    // Type character by character with variable delay
    for (const char of value) {
      await page.keyboard.type(char, { delay: Math.floor(Math.random() * 100) + 40 });
    }
    await humanDelay(300, 800);
    return true;
  } catch {
    return false;
  }
}

/** Try multiple selectors, return the first visible match */
async function findVisibleField(page: import("playwright").Page, selectors: string[]): Promise<string | null> {
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if ((await el.count()) > 0 && (await el.isVisible())) return sel;
    } catch { /* skip invalid selectors */ }
  }
  return null;
}

registerSkill({
  name: "account.create",
  description:
    "Create an account on any website. Uses human-like typing, CAPTCHA solving, and auto email verification. Tries Google sign-in first, then email+password fallback.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL of the website signup page" },
      email: { type: "string", description: `Email to use (default: ${GOOGLE_EMAIL})` },
      username: { type: "string", description: 'Username (default: "Kingston_CDR")' },
      password: { type: "string", description: "Password. If not provided, generates a secure one." },
      name: { type: "string", description: 'Full name (default: "Kingston")' },
      chatId: { type: "string", description: "Telegram chat ID for screenshots" },
      prefer_google: { type: "string", description: 'Try Google sign-in first (default: true)' },
      verify_email: { type: "string", description: 'Auto-check Gmail for verification email after signup (default: true)' },
    },
    required: ["url"],
  },
  async execute(args): Promise<string> {
    const url = String(args.url);
    const email = String(args.email || GOOGLE_EMAIL);
    const username = String(args.username || "Kingston_CDR");
    const fullName = String(args.name || "Kingston");
    const chatId = Number(args.chatId) || 0;
    const preferGoogle = String(args.prefer_google) !== "false";
    const shouldVerifyEmail = String(args.verify_email) !== "false";
    const steps: string[] = [];

    log.info(`[account.create] Creating account on ${url} (email: ${email})`);

    try {
      const page = await browserManager.getPage();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await humanDelay(1500, 3000);
      steps.push("1. Page chargée");

      // ── CAPTCHA check on landing ──
      const solver = new CaptchaSolver(page);
      const detection = await solver.detect();
      if (detection.type !== "none") {
        const solveResult = await solver.solve();
        steps.push(`2. CAPTCHA détecté: ${detection.type} → ${solveResult.success ? "résolu ✅" : "échec ❌"}`);
        if (!solveResult.success) {
          if (chatId > 0) await screenshotToChat(chatId, "CAPTCHA bloquant");
          return `❌ CAPTCHA bloquant sur ${url}: ${detection.type}\n${solveResult.error || "Résolution échouée"}\n\nEssaie browser.setup_session pour passer manuellement.`;
        }
      }

      // ── Try Google sign-in first ──
      if (preferGoogle && hasGoogleSession()) {
        const googleBtn = page.locator([
          'button:has-text("Sign in with Google")',
          'button:has-text("Continue with Google")',
          'button:has-text("Se connecter avec Google")',
          'a:has-text("Sign in with Google")',
          'a:has-text("Continue with Google")',
          'button:has-text("Google")',
          'a:has-text("Google")',
          '[data-provider="google"]',
          'a[href*="accounts.google.com"]',
        ].join(", "));

        if ((await googleBtn.count()) > 0) {
          log.info("[account.create] Google sign-in found, using it...");
          await googleBtn.first().click();
          await humanDelay(3000, 6000);

          const pages = page.context().pages();
          const gPage = pages.find((p) => p.url().includes("accounts.google.com"));
          if (gPage) {
            const acctBtn = gPage.locator(`div[data-email="${email}"], li:has-text("${email}")`);
            if ((await acctBtn.count()) > 0) {
              await acctBtn.first().click();
              await humanDelay(2000, 4000);
            }
            const allow = gPage.locator('button:has-text("Allow"), button:has-text("Continue"), button:has-text("Autoriser")');
            if ((await allow.count()) > 0) {
              await allow.first().click();
              await humanDelay(2000, 4000);
            }
          }

          await humanDelay(2000, 4000);
          await saveGoogleSession();
          saveCredentials(url, { email, username, method: "google" });
          if (chatId > 0) await screenshotToChat(chatId, "Compte créé via Google ✅");
          return `✅ Compte créé via Google sur ${new URL(page.url()).hostname}.\nEmail: ${email}\nMéthode: Google OAuth`;
        }
      }

      // ── Email+Password signup ──
      const password = String(args.password || generatePassword());
      steps.push("2. Remplissage formulaire (human-like)...");

      // Field selector maps — ordered by specificity
      const fieldMap: Record<string, { selectors: string[]; value: string }> = {
        email: {
          selectors: ['input[name="email"]', 'input[type="email"]', '#email', '#signup-email',
            'input[placeholder*="email" i]', 'input[placeholder*="courriel" i]',
            'input[autocomplete="email"]', 'input[data-testid*="email" i]'],
          value: email,
        },
        username: {
          selectors: ['input[name="username"]', '#username', 'input[name="login"]', '#signup-username',
            'input[placeholder*="username" i]', 'input[placeholder*="nom d\'utilisateur" i]',
            'input[autocomplete="username"]', 'input[data-testid*="username" i]'],
          value: username,
        },
        password: {
          selectors: ['input[name="password"]', 'input[type="password"]', '#password', '#signup-password',
            'input[placeholder*="password" i]', 'input[placeholder*="mot de passe" i]',
            'input[autocomplete="new-password"]'],
          value: password,
        },
        name: {
          selectors: ['input[name="name"]', 'input[name="fullname"]', 'input[name="full_name"]',
            '#name', '#fullname', 'input[placeholder*="full name" i]', 'input[placeholder*="nom complet" i]',
            'input[autocomplete="name"]'],
          value: fullName,
        },
        firstName: {
          selectors: ['input[name="first_name"]', 'input[name="firstName"]', 'input[name="fname"]',
            '#first-name', '#firstName', 'input[placeholder*="first name" i]', 'input[placeholder*="prénom" i]',
            'input[autocomplete="given-name"]'],
          value: fullName.split(" ")[0],
        },
        lastName: {
          selectors: ['input[name="last_name"]', 'input[name="lastName"]', 'input[name="lname"]',
            '#last-name', '#lastName', 'input[placeholder*="last name" i]', 'input[placeholder*="nom" i]:not([placeholder*="complet"])',
            'input[autocomplete="family-name"]'],
          value: fullName.split(" ").slice(1).join(" ") || "CDR",
        },
      };

      let filled = 0;
      const filledFields: string[] = [];

      for (const [fieldName, { selectors, value }] of Object.entries(fieldMap)) {
        const sel = await findVisibleField(page, selectors);
        if (sel) {
          const success = await humanFill(page, sel, value);
          if (success) {
            filled++;
            filledFields.push(fieldName);
            log.info(`[account.create] Filled ${fieldName} via ${sel}`);
          }
        }
      }

      // Password confirmation
      const confirmPwSelectors = [
        'input[name="password_confirmation"]', 'input[name="confirmPassword"]',
        'input[name="password2"]', 'input[name="confirm_password"]',
        'input[name="repassword"]', '#confirm-password', '#password-confirm',
        'input[placeholder*="confirm" i]', 'input[placeholder*="retype" i]',
        'input[autocomplete="new-password"]:nth-of-type(2)',
      ];
      const confirmSel = await findVisibleField(page, confirmPwSelectors);
      if (confirmSel) {
        await humanFill(page, confirmSel, password);
        filledFields.push("confirmPassword");
      }

      if (filled === 0) {
        // Maybe we need to find the signup page first
        const signupLink = page.locator([
          'a:has-text("Sign up")', 'a:has-text("Register")', 'a:has-text("Create account")',
          'a:has-text("S\'inscrire")', 'a:has-text("Créer un compte")',
          'button:has-text("Sign up")', 'button:has-text("Register")',
          'button:has-text("Get started")', 'a:has-text("Get started")',
        ].join(", "));

        if ((await signupLink.count()) > 0) {
          await signupLink.first().click();
          await humanDelay(2000, 4000);
          steps.push("   → Navigué vers la page d'inscription");

          // CAPTCHA check after navigation
          await handleCaptchaIfPresent(page);

          // Retry form filling
          for (const [fieldName, { selectors, value }] of Object.entries(fieldMap)) {
            const sel = await findVisibleField(page, selectors);
            if (sel) {
              const success = await humanFill(page, sel, value);
              if (success) { filled++; filledFields.push(fieldName); }
            }
          }
          const confirmSel2 = await findVisibleField(page, confirmPwSelectors);
          if (confirmSel2) await humanFill(page, confirmSel2, password);
        }
      }

      if (filled === 0) {
        // ── FALLBACK: Use accessibility snapshot to find form fields ──
        steps.push("2b. CSS selectors failed — trying accessibility snapshot...");
        try {
          const { getAccessibilitySnapshot } = await import("../../browser/action-planner.js");
          const { dismissOverlays } = await import("../../browser/action-planner.js");
          await dismissOverlays(page);
          const nodes = await getAccessibilitySnapshot(page);

          // Find input-like nodes by role
          const inputNodes = nodes.filter(n =>
            ["textbox", "email", "password", "text", "searchbox"].includes(n.role)
          );

          for (const node of inputNodes) {
            const nameLower = (node.name || "").toLowerCase();
            let fieldValue = "";
            let fieldName = "";

            if (nameLower.includes("email") || nameLower.includes("courriel") || node.role === "email") {
              fieldValue = email;
              fieldName = "email";
            } else if (nameLower.includes("password") || nameLower.includes("mot de passe") || node.role === "password") {
              fieldValue = password;
              fieldName = "password";
            } else if (nameLower.includes("username") || nameLower.includes("utilisateur") || nameLower.includes("login")) {
              fieldValue = username;
              fieldName = "username";
            } else if (nameLower.includes("name") || nameLower.includes("nom")) {
              fieldValue = fullName;
              fieldName = "name";
            }

            if (fieldValue && fieldName) {
              // Use ref-based approach: find element by data attribute
              try {
                // Try to find by the node's name as aria-label or placeholder
                const possibleSelectors = [
                  `input[aria-label="${node.name}"]`,
                  `input[placeholder="${node.name}"]`,
                  `input[name="${node.name}"]`,
                  `textarea[aria-label="${node.name}"]`,
                ];
                for (const sel of possibleSelectors) {
                  const el = page.locator(sel).first();
                  if ((await el.count()) > 0 && (await el.isVisible())) {
                    const success = await humanFill(page, sel, fieldValue);
                    if (success) {
                      filled++;
                      filledFields.push(fieldName);
                      log.info(`[account.create] Smart-filled ${fieldName} via a11y snapshot`);
                    }
                    break;
                  }
                }
              } catch { /* skip this field */ }
            }
          }
          steps.push(`2b. A11y snapshot found ${inputNodes.length} inputs, filled ${filled} fields`);
        } catch (err) {
          steps.push(`2b. A11y fallback failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (filled === 0) {
        if (chatId > 0) await screenshotToChat(chatId, "Formulaire non reconnu");
        return `❌ Formulaire non reconnu sur ${url}.\nAucun champ détecté par CSS ni par A11y snapshot.\nUtilise browser.computer_use pour une approche visuelle.`;
      }

      steps.push(`3. Champs remplis: ${filledFields.join(", ")}`);

      // ── Terms & conditions checkbox (with CSS overlay workaround) ──
      let termsChecked = false;

      // Strategy 1: Click the label wrapping the checkbox (handles CSS overlay interception)
      const labelSelectors = [
        'label[for="tos"]', 'label:has(input[type="checkbox"])',
        'label:has-text("agree")', 'label:has-text("terms")', 'label:has-text("accept")',
        'label:has-text("accepte")', 'label:has-text("J\'accepte")',
        '.checkbox label', '.terms label',
      ];
      for (const lSel of labelSelectors) {
        if (termsChecked) break;
        try {
          const label = page.locator(lSel).first();
          if ((await label.count()) > 0 && (await label.isVisible())) {
            await label.click({ timeout: 5000 });
            termsChecked = true;
            log.info(`[account.create] Checkbox toggled via label: ${lSel}`);
          }
        } catch { /* try next */ }
      }

      // Strategy 2: JS force-check (bypasses CSS overlay entirely)
      if (!termsChecked) {
        const jsResult = await page.evaluate(() => {
          const cbs = document.querySelectorAll('input[type="checkbox"]');
          for (const cb of cbs) {
            const inp = cb as HTMLInputElement;
            if (inp.name?.match(/terms|agree|accept|tos|privacy/i) ||
                inp.id?.match(/terms|agree|accept|tos|privacy/i)) {
              inp.checked = true;
              inp.dispatchEvent(new Event('change', { bubbles: true }));
              inp.dispatchEvent(new Event('input', { bubbles: true }));
              return true;
            }
          }
          return false;
        });
        if (jsResult) termsChecked = true;
      }

      if (termsChecked) steps.push("4. Checkbox conditions acceptée");

      await humanDelay(500, 1200);

      // ── Submit ──
      const submitSelectors = [
        'button[type="submit"]',
        'button:has-text("Sign up")', 'button:has-text("Register")', 'button:has-text("Create account")',
        'button:has-text("Create")', 'button:has-text("Submit")', 'button:has-text("Join")',
        'button:has-text("S\'inscrire")', 'button:has-text("Créer")', 'button:has-text("Inscription")',
        'input[type="submit"]',
        'button:has-text("Get started")', 'button:has-text("Continue")', 'button:has-text("Next")',
      ];
      const submitSel = await findVisibleField(page, submitSelectors);
      if (submitSel) {
        await page.locator(submitSel).first().click();
        steps.push("5. Formulaire soumis");
        await humanDelay(3000, 6000);
      } else {
        steps.push("5. ⚠️ Pas de bouton submit trouvé");
      }

      // ── Post-submit CAPTCHA check ──
      const postDetection = await solver.detect();
      if (postDetection.type !== "none") {
        const postSolve = await solver.solve();
        steps.push(`6. CAPTCHA post-submit: ${postDetection.type} → ${postSolve.success ? "résolu ✅" : "échec ❌"}`);
        if (postSolve.success) {
          // Re-click submit if CAPTCHA was blocking it
          await humanDelay(1000, 2000);
          const resubmit = await findVisibleField(page, submitSelectors);
          if (resubmit) {
            await page.locator(resubmit).first().click();
            await humanDelay(3000, 6000);
          }
        }
      }

      // ── Check for errors on page ──
      const pageErrors = await page.evaluate(() => {
        const errorSels = [
          '.error', '.alert-danger', '.form-error', '[role="alert"]',
          '.error-message', '.field-error', '.validation-error',
          '.text-danger', '.text-red-500', '.invalid-feedback',
        ];
        const errors: string[] = [];
        for (const sel of errorSels) {
          document.querySelectorAll(sel).forEach(el => {
            const text = el.textContent?.trim();
            if (text && text.length > 2 && text.length < 200) errors.push(text);
          });
        }
        return errors;
      });

      if (pageErrors.length > 0) {
        steps.push(`⚠️ Erreurs détectées: ${pageErrors.join(" | ")}`);
      }

      const finalUrl = page.url();
      await saveGoogleSession();

      // ── Save credentials ──
      const domain = new URL(url).hostname.replace(/^www\./, "");
      saveCredentials(url, { email, username, password, method: "email+password" });

      if (chatId > 0) await screenshotToChat(chatId, `Compte créé sur ${domain}`);

      // ── Auto email verification ──
      let verifyResult = "";
      if (shouldVerifyEmail) {
        try {
          verifyResult = await checkVerificationEmail(domain, page);
          if (verifyResult) steps.push(`7. Email: ${verifyResult}`);
        } catch (err) {
          steps.push(`7. Email check failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      const report = [
        `✅ Compte créé sur ${domain}`,
        `Email: ${email}`,
        `Username: ${username}`,
        `Mot de passe: sauvegardé dans relay/accounts/${domain}.json`,
        `URL finale: ${finalUrl}`,
        pageErrors.length > 0 ? `\n⚠️ Erreurs page: ${pageErrors.join(", ")}` : "",
        `\n--- Étapes ---`,
        ...steps,
      ].filter(Boolean).join("\n");

      return report;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`[account.create] Error: ${msg}`);
      return `❌ Erreur création compte: ${msg}\n\nÉtapes complétées:\n${steps.join("\n")}`;
    }
  },
});

// ─── account.list ───────────────────────────────────────────────────

registerSkill({
  name: "account.list",
  description: "List all accounts Kingston has created on various websites.",
  adminOnly: true,
  argsSchema: { type: "object", properties: {} },
  async execute(): Promise<string> {
    const credDir = path.resolve(process.cwd(), "relay", "accounts");
    if (!fs.existsSync(credDir)) return "Aucun compte créé.";

    const files = fs.readdirSync(credDir).filter((f) => f.endsWith(".json"));
    if (files.length === 0) return "Aucun compte créé.";

    const lines: string[] = [`**${files.length} comptes Kingston:**\n`];
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(credDir, file), "utf-8"));
        lines.push(
          `• **${data.domain}** — ${data.email}${data.username ? ` (@${data.username})` : ""} (${data.created?.split("T")[0] || "?"})`,
        );
      } catch {
        lines.push(`• ${file} (erreur lecture)`);
      }
    }
    return lines.join("\n");
  },
});

// ─── account.verify_email ────────────────────────────────────────────

registerSkill({
  name: "account.verify_email",
  description:
    "Check Gmail for a verification/confirmation email from a domain and click the verification link. Use after account.create.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      domain: { type: "string", description: "Domain to search for (e.g. '2captcha.com')" },
      chatId: { type: "string", description: "Telegram chat ID for screenshots" },
    },
    required: ["domain"],
  },
  async execute(args): Promise<string> {
    const domain = String(args.domain);
    const chatId = Number(args.chatId) || 0;

    try {
      const page = await browserManager.getPage();
      const result = await checkVerificationEmail(domain, page);
      if (chatId > 0) await screenshotToChat(chatId, `Vérification email: ${domain}`);
      return result || `Aucun email de vérification trouvé pour ${domain}. Il peut falloir attendre quelques minutes.`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Erreur vérification email: ${msg}`;
    }
  },
});

// ─── Helpers ─────────────────────────────────────────────────────────

/** Save account credentials to relay/accounts/{domain}.json */
function saveCredentials(
  url: string,
  creds: { email: string; username?: string; password?: string; method: string },
): void {
  try {
    const domain = new URL(url).hostname.replace(/^www\./, "");
    const credDir = path.resolve(process.cwd(), "relay", "accounts");
    if (!fs.existsSync(credDir)) fs.mkdirSync(credDir, { recursive: true });
    const credInfo = {
      ...creds,
      domain,
      url,
      created: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(credDir, `${domain}.json`), JSON.stringify(credInfo, null, 2), "utf-8");
    log.info(`[account] Credentials saved for ${domain}`);
  } catch (err) {
    log.error(`[account] Failed to save credentials: ${err}`);
  }
}

/** Check Gmail for a verification email from a domain and click the verify link */
async function checkVerificationEmail(domain: string, page: import("playwright").Page): Promise<string> {
  try {
    const { getGmailClient } = await import("../../gmail/auth.js");
    const gmail = getGmailClient();

    // Search for recent emails from the domain
    const res = await gmail.users.messages.list({
      userId: "me",
      q: `from:${domain} newer_than:1h (verify OR confirm OR activate OR "click here" OR validation)`,
      maxResults: 5,
    });

    if (!res.data.messages || res.data.messages.length === 0) {
      // Broader search without keyword filter
      const res2 = await gmail.users.messages.list({
        userId: "me",
        q: `from:${domain} newer_than:1h`,
        maxResults: 5,
      });
      if (!res2.data.messages || res2.data.messages.length === 0) {
        return `Aucun email de ${domain} dans les dernières 60 min.`;
      }
      res.data.messages = res2.data.messages;
    }

    // Read the first matching email
    const msgId = res.data.messages[0].id!;
    const msg = await gmail.users.messages.get({
      userId: "me",
      id: msgId,
      format: "full",
    });

    const headers = msg.data.payload?.headers || [];
    const subject = headers.find(h => h.name?.toLowerCase() === "subject")?.value || "(no subject)";
    const from = headers.find(h => h.name?.toLowerCase() === "from")?.value || "";

    // Extract body
    const body = extractEmailBody(msg.data.payload);

    // Find verification links in the email body
    const urlRegex = /https?:\/\/[^\s<>"')\]]+(?:verify|confirm|activate|validation|token|click|auth|register|email)[^\s<>"')\]]*/gi;
    const links: string[] = body.match(urlRegex) || [];

    // Also try generic links if no specific verify links found
    if (links.length === 0) {
      const allLinks = body.match(/https?:\/\/[^\s<>"')\]]{20,}/g) || [];
      // Filter out common non-verify links
      const filtered = allLinks.filter(l =>
        !l.includes("unsubscribe") &&
        !l.includes("privacy") &&
        !l.includes("terms") &&
        !l.includes("support") &&
        !l.includes("logo") &&
        !l.includes(".png") &&
        !l.includes(".jpg")
      );
      if (filtered.length > 0) links.push(filtered[0]);
    }

    if (links.length > 0) {
      const verifyLink = links[0];
      log.info(`[account.verify] Found verification link: ${verifyLink.slice(0, 80)}...`);

      // Navigate to the verification link
      await page.goto(verifyLink, { waitUntil: "domcontentloaded", timeout: 30000 });
      await humanDelay(2000, 4000);

      // Handle any CAPTCHA on the verification page
      await handleCaptchaIfPresent(page);

      const finalUrl = page.url();
      return `✅ Email vérifié!\nSujet: ${subject}\nDe: ${from}\nLien: ${verifyLink.slice(0, 60)}...\nURL finale: ${finalUrl}`;
    }

    return `📧 Email trouvé mais pas de lien de vérification.\nSujet: ${subject}\nDe: ${from}\nContenu (extrait): ${body.slice(0, 300)}...`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("not configured") || msg.includes("not found")) {
      return `Gmail API non configurée. Lance 'npm run gmail:auth' d'abord.`;
    }
    throw err;
  }
}

/** Extract text body from Gmail message payload */
function extractEmailBody(payload: any): string {
  if (!payload) return "";

  if (payload.body?.data) {
    return Buffer.from(payload.body.data, "base64url").toString("utf-8");
  }

  if (payload.parts) {
    // Prefer text/plain
    const textPart = payload.parts.find((p: any) => p.mimeType === "text/plain");
    if (textPart?.body?.data) {
      return Buffer.from(textPart.body.data, "base64url").toString("utf-8");
    }
    // Fall back to text/html
    const htmlPart = payload.parts.find((p: any) => p.mimeType === "text/html");
    if (htmlPart?.body?.data) {
      return Buffer.from(htmlPart.body.data, "base64url").toString("utf-8");
    }
    // Nested multipart
    for (const part of payload.parts) {
      if (part.parts) {
        const nested = extractEmailBody(part);
        if (nested) return nested;
      }
    }
  }
  return "";
}

function generatePassword(): string {
  const lower = "abcdefghijkmnopqrstuvwxyz";
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const digits = "23456789";
  const special = "!@#$%&*";
  const all = lower + upper + digits + special;
  // Ensure at least one of each category
  let pw = "";
  pw += lower[Math.floor(Math.random() * lower.length)];
  pw += upper[Math.floor(Math.random() * upper.length)];
  pw += digits[Math.floor(Math.random() * digits.length)];
  pw += special[Math.floor(Math.random() * special.length)];
  for (let i = 4; i < 18; i++) {
    pw += all[Math.floor(Math.random() * all.length)];
  }
  // Shuffle
  return pw.split("").sort(() => Math.random() - 0.5).join("");
}
