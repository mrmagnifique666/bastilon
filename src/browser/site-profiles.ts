/**
 * Site profiles — saved interaction patterns for known websites.
 * When Kingston has already interacted with a site, the CSS selectors and steps
 * are saved so subsequent interactions are instant (no DOM analysis needed).
 *
 * Default profiles ship for Facebook, Google, LinkedIn, and Moltbook.
 */
import { getDb } from "../storage/store.js";
import { log } from "../utils/log.js";

// ── Types ──────────────────────────────────────────────────

export interface SiteStep {
  type: "navigate" | "click" | "fill" | "wait" | "keyboard" | "eval";
  /** CSS selector (primary) */
  selector?: string;
  /** Fallback: match by visible text content */
  selectorText?: string;
  /** Fallback: match by ARIA role+name */
  selectorAria?: string;
  /** For fill: text to type. Use {{content}} as placeholder for dynamic content */
  text?: string;
  /** For navigate: target URL */
  url?: string;
  /** For keyboard: key name (Enter, Tab, Escape, etc.) */
  keys?: string;
  /** For wait: milliseconds */
  ms?: number;
  /** For eval: JavaScript code to execute in page context */
  code?: string;
  /** Human-readable description of this step */
  description?: string;
  /** If true, failure doesn't stop the sequence */
  optional?: boolean;
}

export interface SiteProfile {
  id: number;
  domain: string;
  action_name: string;
  url_pattern?: string;
  steps: SiteStep[];
  success_count: number;
  fail_count: number;
  last_used_at: number | null;
  created_at: number;
}

// ── CRUD ───────────────────────────────────────────────────

export function getProfile(domain: string, action: string): SiteProfile | null {
  const d = getDb();
  const row = d.prepare(
    "SELECT * FROM site_profiles WHERE domain = ? AND action_name = ?"
  ).get(domain, action) as any;
  if (!row) return null;
  return { ...row, steps: JSON.parse(row.steps) };
}

export function saveProfile(profile: Partial<SiteProfile> & { domain: string; action_name: string; steps: SiteStep[] }): number {
  const d = getDb();
  const existing = d.prepare(
    "SELECT id FROM site_profiles WHERE domain = ? AND action_name = ?"
  ).get(profile.domain, profile.action_name) as { id: number } | undefined;

  if (existing) {
    d.prepare(`
      UPDATE site_profiles SET steps = ?, url_pattern = ?, last_used_at = unixepoch()
      WHERE id = ?
    `).run(JSON.stringify(profile.steps), profile.url_pattern || null, existing.id);
    log.info(`[site-profiles] Updated profile: ${profile.domain}/${profile.action_name}`);
    return existing.id;
  }

  const info = d.prepare(`
    INSERT INTO site_profiles (domain, action_name, url_pattern, steps)
    VALUES (?, ?, ?, ?)
  `).run(profile.domain, profile.action_name, profile.url_pattern || null, JSON.stringify(profile.steps));
  log.info(`[site-profiles] Created profile: ${profile.domain}/${profile.action_name}`);
  return Number(info.lastInsertRowid);
}

export function recordResult(id: number, success: boolean): void {
  const d = getDb();
  if (success) {
    d.prepare("UPDATE site_profiles SET success_count = success_count + 1, last_used_at = unixepoch() WHERE id = ?").run(id);
  } else {
    d.prepare("UPDATE site_profiles SET fail_count = fail_count + 1, last_used_at = unixepoch() WHERE id = ?").run(id);
  }
}

export function listProfiles(domain?: string): SiteProfile[] {
  const d = getDb();
  let rows: any[];
  if (domain) {
    rows = d.prepare("SELECT * FROM site_profiles WHERE domain = ? ORDER BY action_name").all(domain);
  } else {
    rows = d.prepare("SELECT * FROM site_profiles ORDER BY domain, action_name").all();
  }
  return rows.map(r => ({ ...r, steps: JSON.parse(r.steps) }));
}

export function deleteProfile(id: number): void {
  const d = getDb();
  d.prepare("DELETE FROM site_profiles WHERE id = ?").run(id);
  log.info(`[site-profiles] Deleted profile #${id}`);
}

// ── Default Profiles ───────────────────────────────────────

const DEFAULT_PROFILES: Array<{
  domain: string;
  action_name: string;
  url_pattern?: string;
  steps: SiteStep[];
}> = [
  {
    domain: "facebook.com",
    action_name: "post_text",
    url_pattern: "https://www.facebook.com",
    steps: [
      { type: "navigate", url: "https://www.facebook.com", description: "Aller sur Facebook" },
      { type: "wait", ms: 2000, description: "Attendre le chargement" },
      {
        type: "click",
        selector: '[role="textbox"][data-lexical-editor="true"]',
        selectorAria: "What's on your mind",
        selectorText: "quoi de neuf",
        description: "Ouvrir le compositeur",
      },
      { type: "wait", ms: 1500, description: "Attendre l'ouverture du dialog" },
      {
        type: "fill",
        selector: '[role="textbox"][contenteditable="true"][data-lexical-editor="true"]',
        text: "{{content}}",
        description: "Taper le contenu du post",
      },
      { type: "wait", ms: 500, description: "Attendre" },
      {
        type: "click",
        selector: '[aria-label="Post"], [aria-label="Publier"], div[role="button"] span:text-is("Publier"), div[role="button"] span:text-is("Post")',
        selectorAria: "Post",
        description: "Cliquer Publier",
      },
      { type: "wait", ms: 2000, description: "Attendre la publication" },
    ],
  },
  {
    domain: "google.com",
    action_name: "search",
    url_pattern: "https://www.google.com",
    steps: [
      { type: "navigate", url: "https://www.google.com", description: "Aller sur Google" },
      { type: "wait", ms: 1000, description: "Attendre le chargement" },
      {
        type: "fill",
        selector: 'textarea[name="q"], input[name="q"]',
        text: "{{content}}",
        description: "Taper la recherche",
      },
      { type: "keyboard", keys: "Enter", description: "Lancer la recherche" },
      { type: "wait", ms: 2000, description: "Attendre les résultats" },
    ],
  },
  {
    domain: "linkedin.com",
    action_name: "post_text",
    url_pattern: "https://www.linkedin.com/feed",
    steps: [
      { type: "navigate", url: "https://www.linkedin.com/feed", description: "Aller sur LinkedIn" },
      { type: "wait", ms: 2000, description: "Attendre le chargement" },
      {
        type: "click",
        selector: '.share-box-feed-entry__trigger, button.artdeco-button:has-text("Start a post")',
        selectorText: "Start a post",
        description: "Ouvrir le compositeur",
      },
      { type: "wait", ms: 1500, description: "Attendre le dialog" },
      {
        type: "fill",
        selector: '[role="textbox"][contenteditable="true"], .ql-editor',
        text: "{{content}}",
        description: "Taper le contenu",
      },
      { type: "wait", ms: 500, description: "Attendre" },
      {
        type: "click",
        selector: 'button.share-actions__primary-action, button:has-text("Post")',
        selectorText: "Post",
        description: "Publier",
      },
      { type: "wait", ms: 2000, description: "Attendre la publication" },
    ],
  },
  {
    domain: "moltbook.com",
    action_name: "post_text",
    url_pattern: "https://moltbook.com",
    steps: [
      { type: "navigate", url: "https://moltbook.com", description: "Aller sur Moltbook" },
      { type: "wait", ms: 2000, description: "Attendre le chargement" },
      {
        type: "click",
        selector: '[data-testid="create-post"], button:has-text("Publier"), .new-post-button',
        selectorText: "Publier",
        description: "Ouvrir le compositeur",
      },
      { type: "wait", ms: 1000, description: "Attendre" },
      {
        type: "fill",
        selector: 'textarea, [contenteditable="true"]',
        text: "{{content}}",
        description: "Taper le contenu",
      },
      { type: "wait", ms: 500, description: "Attendre" },
      {
        type: "click",
        selector: 'button[type="submit"], button:has-text("Publier"), button:has-text("Post")',
        selectorText: "Publier",
        description: "Publier",
      },
      { type: "wait", ms: 2000, description: "Attendre la publication" },
    ],
  },
];

/**
 * Seed default profiles into DB if they don't exist yet.
 * Called on first use or explicitly via site.setup.
 */
export function seedDefaults(): number {
  const d = getDb();
  let count = 0;
  for (const p of DEFAULT_PROFILES) {
    const existing = d.prepare(
      "SELECT id FROM site_profiles WHERE domain = ? AND action_name = ?"
    ).get(p.domain, p.action_name);
    if (!existing) {
      d.prepare(`
        INSERT INTO site_profiles (domain, action_name, url_pattern, steps)
        VALUES (?, ?, ?, ?)
      `).run(p.domain, p.action_name, p.url_pattern || null, JSON.stringify(p.steps));
      count++;
    }
  }
  if (count > 0) log.info(`[site-profiles] Seeded ${count} default profiles`);
  return count;
}
