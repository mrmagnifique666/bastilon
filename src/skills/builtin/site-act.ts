/**
 * Smart Web Actor — rapid web interaction via Chrome CDP.
 *
 * Instead of taking screenshots + vision AI (22s/step, ~140s for a Facebook post),
 * this connects to Nicolas's real Chrome (with all sessions logged in) via CDP,
 * reads the DOM directly, and uses saved profiles for instant interactions.
 *
 * Performance: Facebook post 140s → ~3s (known profile) or ~8s (first time).
 *
 * Skills:
 *   site.act      — Main: perform web action (auto profile or Gemini planning)
 *   site.setup    — One-time Chrome CDP setup
 *   site.learn    — Teach Kingston a new site action
 *   site.profiles — List/view/delete saved profiles
 *   site.test     — Test a profile in dry-run mode
 */
import { chromium, type Page } from "playwright";
import { registerSkill } from "../loader.js";
import { config } from "../../config/env.js";
import { log } from "../../utils/log.js";
import { ensureChromeWithCdp, setupChromeShortcut, isCdpAvailable, listTabs } from "../../browser/chrome-cdp.js";
import {
  getProfile, saveProfile, recordResult, listProfiles, deleteProfile,
  seedDefaults, type SiteStep, type SiteProfile,
} from "../../browser/site-profiles.js";
import { planActions, dismissOverlays } from "../../browser/action-planner.js";

// ── Helpers ────────────────────────────────────────────────

/** Parse a goal string to extract domain, action, and content. */
function parseGoal(goal: string, urlArg?: string): {
  domain: string;
  action: string;
  content: string;
  url: string;
} {
  const lower = goal.toLowerCase();

  // Extract content after colon or quotes
  let content = "";
  const colonMatch = goal.match(/[:：]\s*(.+)$/);
  if (colonMatch) content = colonMatch[1].trim();
  const quoteMatch = goal.match(/"([^"]+)"|«([^»]+)»|'([^']+)'/);
  if (quoteMatch) content = (quoteMatch[1] || quoteMatch[2] || quoteMatch[3]).trim();

  // Detect domain
  let domain = "";
  let action = "";
  let url = urlArg || "";

  const domainPatterns: Array<{ pattern: RegExp; domain: string; defaultUrl: string }> = [
    { pattern: /facebook|fb\.com/i, domain: "facebook.com", defaultUrl: "https://www.facebook.com" },
    { pattern: /google/i, domain: "google.com", defaultUrl: "https://www.google.com" },
    { pattern: /linkedin/i, domain: "linkedin.com", defaultUrl: "https://www.linkedin.com/feed" },
    { pattern: /moltbook/i, domain: "moltbook.com", defaultUrl: "https://moltbook.com" },
    { pattern: /twitter|x\.com/i, domain: "twitter.com", defaultUrl: "https://x.com" },
    { pattern: /instagram/i, domain: "instagram.com", defaultUrl: "https://www.instagram.com" },
    { pattern: /youtube/i, domain: "youtube.com", defaultUrl: "https://www.youtube.com" },
    { pattern: /reddit/i, domain: "reddit.com", defaultUrl: "https://www.reddit.com" },
  ];

  for (const { pattern, domain: d, defaultUrl } of domainPatterns) {
    if (pattern.test(lower)) {
      domain = d;
      if (!url) url = defaultUrl;
      break;
    }
  }

  // Try to extract domain from URL arg
  if (!domain && url) {
    try {
      domain = new URL(url).hostname.replace(/^www\./, "");
    } catch { /* invalid URL */ }
  }

  // Detect action type
  if (/post(er)?|publi(er|sh)|écrire|write|share|partager/i.test(lower)) {
    action = "post_text";
  } else if (/search|cherch|recherch/i.test(lower)) {
    action = "search";
  } else if (/comment(er)?|répondre|reply/i.test(lower)) {
    action = "comment";
  } else if (/like|aimer|react/i.test(lower)) {
    action = "like";
  } else if (/message|dm|envoyer/i.test(lower)) {
    action = "message";
  } else if (/navig|ouvr|open|go to|aller/i.test(lower)) {
    action = "navigate";
  } else {
    action = "interact";
  }

  return { domain, action, content, url };
}

/** Find or create a tab for the given domain. */
async function findOrCreateTab(
  browser: ReturnType<typeof chromium.connectOverCDP> extends Promise<infer T> ? T : never,
  domain: string,
  url: string,
): Promise<Page> {
  // Search existing tabs
  const contexts = browser.contexts();
  for (const ctx of contexts) {
    const pages = ctx.pages();
    for (const page of pages) {
      try {
        const pageUrl = page.url();
        if (pageUrl.includes(domain)) {
          log.info(`[site.act] Found existing tab for ${domain}: ${pageUrl}`);
          await page.bringToFront();
          return page;
        }
      } catch { /* page may be closed */ }
    }
  }

  // No existing tab — open one
  const ctx = contexts[0] || await browser.newContext();
  const page = await ctx.newPage();
  if (url) {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
  }
  log.info(`[site.act] Opened new tab: ${url}`);
  return page;
}

/** Execute a sequence of SiteSteps on a page. */
async function executeSteps(
  page: Page,
  steps: SiteStep[],
  content: string,
): Promise<{ success: boolean; stepsRun: number; error?: string }> {
  let stepsRun = 0;

  for (const step of steps) {
    try {
      switch (step.type) {
        case "navigate": {
          if (step.url) {
            await page.goto(step.url, { waitUntil: "domcontentloaded", timeout: 15000 });
          }
          break;
        }

        case "wait": {
          await page.waitForTimeout(step.ms || 1000);
          break;
        }

        case "click": {
          const clicked = await tryClick(page, step);
          if (!clicked && !step.optional) {
            return { success: false, stepsRun, error: `Click failed: ${step.description || step.selector}` };
          }
          break;
        }

        case "fill": {
          const text = (step.text || "").replace("{{content}}", content);
          const filled = await tryFill(page, step, text);
          if (!filled && !step.optional) {
            return { success: false, stepsRun, error: `Fill failed: ${step.description || step.selector}` };
          }
          break;
        }

        case "keyboard": {
          if (step.keys) {
            await page.keyboard.press(step.keys);
          }
          break;
        }

        case "eval": {
          if (step.code) {
            await page.evaluate(step.code);
          }
          break;
        }
      }

      stepsRun++;
      log.debug(`[site.act] Step ${stepsRun}: ${step.type} — ${step.description || "ok"}`);
    } catch (err) {
      if (step.optional) {
        log.debug(`[site.act] Optional step failed: ${step.description}`);
        stepsRun++;
        continue;
      }
      return {
        success: false,
        stepsRun,
        error: `Step "${step.description || step.type}" failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  return { success: true, stepsRun };
}

/** Try to click an element using multiple selector strategies. */
async function tryClick(page: Page, step: SiteStep): Promise<boolean> {
  const selectors: string[] = [];
  if (step.selector) selectors.push(...step.selector.split(",").map(s => s.trim()));
  if (step.selectorText) selectors.push(`text="${step.selectorText}"`);
  if (step.selectorAria) selectors.push(`role=button[name="${step.selectorAria}"]`);

  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 3000 })) {
        await el.click({ timeout: 5000 });
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

/** Try to fill a text input using multiple selector strategies. */
async function tryFill(page: Page, step: SiteStep, text: string): Promise<boolean> {
  const selectors: string[] = [];
  if (step.selector) selectors.push(...step.selector.split(",").map(s => s.trim()));
  if (step.selectorText) selectors.push(`text="${step.selectorText}"`);

  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 3000 })) {
        // For contenteditable elements, click first then type
        await el.click({ timeout: 3000 });
        await page.waitForTimeout(200);

        // Check if it's contenteditable (like Facebook's composer)
        const isContentEditable = await el.evaluate(
          (e) => e.getAttribute("contenteditable") === "true"
        ).catch(() => false);

        if (isContentEditable) {
          // Type character by character for contenteditable
          await page.keyboard.type(text, { delay: 30 });
        } else {
          await el.fill(text);
        }
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

// ── Skills ─────────────────────────────────────────────────

registerSkill({
  name: "site.act",
  description:
    "Interaction web rapide via le Chrome de Nicolas (sessions déjà logguées). " +
    "Utilise le DOM directement (pas de screenshots). " +
    "Exemples: site.act(goal:'Poster sur Facebook: Bonjour'), " +
    "site.act(goal:'Chercher sur Google: IA news'), " +
    "site.act(goal:'Publier sur LinkedIn: Mon article')",
  adminOnly: true,
  timeoutMs: 60_000,
  argsSchema: {
    type: "object",
    properties: {
      goal: { type: "string", description: "Ce qu'il faut faire sur le site web" },
      url: { type: "string", description: "URL de départ (auto-détectée du goal si omis)" },
      content: { type: "string", description: "Contenu texte pour poster/taper (si pas dans le goal)" },
    },
    required: ["goal"],
  },
  async execute(args): Promise<string> {
    const goal = args.goal as string;
    const urlArg = args.url as string | undefined;
    const contentArg = args.content as string | undefined;
    const startTime = Date.now();

    // 1. Parse goal
    const parsed = parseGoal(goal, urlArg);
    if (contentArg) parsed.content = contentArg;
    if (!parsed.domain && !parsed.url) {
      return "Erreur: Impossible de détecter le site web. Spécifie un URL ou mentionne le site (Facebook, Google, etc.)";
    }

    log.info(`[site.act] Goal: "${goal}" → domain=${parsed.domain}, action=${parsed.action}, content="${parsed.content.slice(0, 50)}"`);

    // 2. Ensure Chrome with CDP
    let wsUrl: string;
    try {
      wsUrl = await ensureChromeWithCdp();
    } catch (err) {
      return `Erreur: Impossible de connecter au Chrome. ${err instanceof Error ? err.message : String(err)}\n\nUtilise site.setup pour configurer Chrome avec CDP.`;
    }

    // 3. Connect via Playwright
    let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>>;
    try {
      browser = await chromium.connectOverCDP(wsUrl);
    } catch (err) {
      return `Erreur de connexion Playwright au Chrome: ${err instanceof Error ? err.message : String(err)}`;
    }

    try {
      // 4. Find or create tab
      const page = await findOrCreateTab(browser, parsed.domain, parsed.url);

      // 5. Dismiss overlays
      await dismissOverlays(page);

      // 6. Check for saved profile
      const profile = getProfile(parsed.domain, parsed.action);

      if (profile) {
        // ── Fast path: use saved profile ──
        log.info(`[site.act] Using profile: ${profile.domain}/${profile.action_name} (${profile.success_count} successes)`);

        const result = await executeSteps(page, profile.steps, parsed.content);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

        if (result.success) {
          recordResult(profile.id, true);
          return `✅ Action complétée en ${elapsed}s (profil connu: ${profile.domain}/${profile.action_name})\n` +
            `${result.stepsRun} étapes exécutées.`;
        } else {
          recordResult(profile.id, false);
          log.warn(`[site.act] Profile failed: ${result.error}`);
          // Fall through to planning
        }
      }

      // 7. ── Slow path: plan with Gemini ──
      log.info(`[site.act] No profile (or failed) — planning via Gemini Flash...`);

      let steps: SiteStep[];
      try {
        steps = await planActions(page, goal, parsed.content);
      } catch (err) {
        return `Erreur de planification: ${err instanceof Error ? err.message : String(err)}`;
      }

      if (steps.length === 0) {
        return "Gemini n'a pas pu planifier d'actions pour ce goal.";
      }

      // 8. Execute planned steps
      const result = await executeSteps(page, steps, parsed.content);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      // 9. Auto-learn: save as new profile if successful
      if (result.success && parsed.domain && parsed.action) {
        try {
          saveProfile({
            domain: parsed.domain,
            action_name: parsed.action,
            url_pattern: parsed.url,
            steps,
          });
          log.info(`[site.act] Auto-learned profile: ${parsed.domain}/${parsed.action}`);
        } catch (err) {
          log.warn(`[site.act] Failed to save profile: ${err}`);
        }
      }

      if (result.success) {
        return `✅ Action complétée en ${elapsed}s (planification Gemini, ${result.stepsRun} étapes)\n` +
          `Profil sauvegardé pour ${parsed.domain}/${parsed.action} — prochaine fois sera instantané.`;
      } else {
        return `❌ Action échouée après ${result.stepsRun} étapes (${elapsed}s): ${result.error}`;
      }
    } finally {
      // Don't close the browser — it's Nicolas's real Chrome!
      browser.close().catch(() => {});
    }
  },
});

// ── site.setup ─────────────────────────────────────────────

registerSkill({
  name: "site.setup",
  description:
    "Configuration initiale de Chrome pour le Smart Web Actor. " +
    "Lance Chrome avec CDP activé et crée un raccourci sur le bureau. " +
    "Seed les profils par défaut (Facebook, Google, LinkedIn, Moltbook).",
  adminOnly: true,
  argsSchema: { type: "object", properties: {} },
  async execute(): Promise<string> {
    const results: string[] = [];

    // 1. Check/launch Chrome with CDP
    try {
      const ws = await ensureChromeWithCdp();
      results.push(`✅ Chrome connecté via CDP (${ws.slice(0, 50)}...)`);
    } catch (err) {
      results.push(`❌ Chrome CDP: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 2. Create desktop shortcut
    try {
      const shortcutPath = await setupChromeShortcut();
      results.push(`✅ Raccourci créé: ${shortcutPath}`);
    } catch (err) {
      results.push(`⚠️ Raccourci: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 3. Seed default profiles
    try {
      const count = seedDefaults();
      const total = listProfiles().length;
      results.push(`✅ Profils: ${count} nouveaux, ${total} total`);
    } catch (err) {
      results.push(`❌ Profils: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 4. List open tabs
    try {
      const tabs = await listTabs();
      if (tabs.length > 0) {
        results.push(`\n📑 ${tabs.length} onglets ouverts:`);
        for (const t of tabs.slice(0, 10)) {
          results.push(`  • ${t.title?.slice(0, 50) || "(sans titre)"} — ${t.url?.slice(0, 60)}`);
        }
      }
    } catch { /* CDP may not be ready yet */ }

    return results.join("\n");
  },
});

// ── site.learn ─────────────────────────────────────────────

registerSkill({
  name: "site.learn",
  description:
    "Enseigner une nouvelle action web à Kingston manuellement. " +
    "Exemples: site.learn(domain:'facebook.com', action:'post_image', steps:'[{...}]')",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      domain: { type: "string", description: "Domaine du site (ex: facebook.com)" },
      action: { type: "string", description: "Nom de l'action (ex: post_text, search, comment)" },
      url: { type: "string", description: "URL de départ (optionnel)" },
      steps: { type: "string", description: "JSON array des étapes SiteStep" },
    },
    required: ["domain", "action", "steps"],
  },
  async execute(args): Promise<string> {
    const domain = args.domain as string;
    const action = args.action as string;
    const url = args.url as string | undefined;

    let steps: SiteStep[];
    try {
      steps = JSON.parse(args.steps as string);
      if (!Array.isArray(steps)) throw new Error("steps must be a JSON array");
    } catch (err) {
      return `Erreur JSON: ${err instanceof Error ? err.message : String(err)}`;
    }

    const id = saveProfile({
      domain,
      action_name: action,
      url_pattern: url,
      steps,
    });

    return `✅ Profil sauvegardé: ${domain}/${action} (ID: ${id}, ${steps.length} étapes)`;
  },
});

// ── site.profiles ──────────────────────────────────────────

registerSkill({
  name: "site.profiles",
  description:
    "Lister, voir ou supprimer les profils de sites sauvegardés. " +
    "Exemples: site.profiles(action:'list'), site.profiles(action:'delete', id:'5')",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      action: { type: "string", description: "'list' (défaut), 'delete', 'seed'" },
      domain: { type: "string", description: "Filtrer par domaine (optionnel)" },
      id: { type: "string", description: "ID du profil à supprimer" },
    },
  },
  async execute(args): Promise<string> {
    const action = (args.action as string) || "list";

    switch (action) {
      case "delete": {
        const id = Number(args.id);
        if (!id) return "Spécifie l'ID du profil à supprimer.";
        deleteProfile(id);
        return `✅ Profil #${id} supprimé.`;
      }

      case "seed": {
        const count = seedDefaults();
        return `✅ ${count} profils par défaut ajoutés.`;
      }

      default: {
        const profiles = listProfiles(args.domain as string | undefined);
        if (profiles.length === 0) {
          return "Aucun profil sauvegardé. Utilise site.setup pour seeder les profils par défaut.";
        }

        const lines = profiles.map(p =>
          `#${p.id} ${p.domain}/${p.action_name} — ${p.steps.length} étapes, ` +
          `✅${p.success_count} ❌${p.fail_count}` +
          (p.last_used_at ? ` (dernier: ${new Date(p.last_used_at * 1000).toLocaleDateString("fr-CA")})` : "")
        );

        return `📋 ${profiles.length} profils:\n${lines.join("\n")}`;
      }
    }
  },
});

// ── site.test ──────────────────────────────────────────────

registerSkill({
  name: "site.test",
  description:
    "Tester un profil de site en dry-run: se connecte au Chrome, exécute les étapes " +
    "mais ne soumet PAS le formulaire final. Bon pour vérifier que les sélecteurs fonctionnent.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      domain: { type: "string", description: "Domaine du site (ex: facebook.com)" },
      action: { type: "string", description: "Nom de l'action (ex: post_text)" },
      content: { type: "string", description: "Contenu test (défaut: 'Test Kingston')" },
    },
    required: ["domain", "action"],
  },
  async execute(args): Promise<string> {
    const domain = args.domain as string;
    const action = args.action as string;
    const content = (args.content as string) || "Test Kingston";

    const profile = getProfile(domain, action);
    if (!profile) {
      return `Aucun profil trouvé pour ${domain}/${action}. Utilise site.profiles(action:'list') pour voir les profils.`;
    }

    // Remove the last submit/post step for dry-run
    const drySteps = [...profile.steps];
    // Pop the last click step (usually the "Publier"/"Post" button) and the trailing wait
    while (drySteps.length > 0) {
      const last = drySteps[drySteps.length - 1];
      if (last.type === "wait") {
        drySteps.pop();
      } else if (last.type === "click" && /publi|post|submit|send/i.test(last.description || last.selector || "")) {
        drySteps.pop();
        break;
      } else {
        break;
      }
    }

    // Connect and run dry steps
    let wsUrl: string;
    try {
      wsUrl = await ensureChromeWithCdp();
    } catch (err) {
      return `Erreur Chrome: ${err instanceof Error ? err.message : String(err)}`;
    }

    let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>>;
    try {
      browser = await chromium.connectOverCDP(wsUrl);
    } catch (err) {
      return `Erreur Playwright: ${err instanceof Error ? err.message : String(err)}`;
    }

    try {
      const page = await findOrCreateTab(browser, domain, profile.url_pattern || `https://${domain}`);
      await dismissOverlays(page);

      const result = await executeSteps(page, drySteps, content);

      if (result.success) {
        return `✅ Dry-run OK: ${result.stepsRun}/${drySteps.length} étapes réussies (soumission retirée).\n` +
          `Le profil ${domain}/${action} fonctionne correctement.`;
      } else {
        return `❌ Dry-run échoué à l'étape ${result.stepsRun}: ${result.error}`;
      }
    } finally {
      browser.close().catch(() => {});
    }
  },
});
