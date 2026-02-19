/**
 * Kingston Training System — Teach Kingston to navigate the real world.
 *
 * train.exercise  — Run a progressive training exercise
 * train.api_hunt  — Find API docs for any service (structured web research)
 * train.recipe    — Store/retrieve learned patterns
 * train.progress  — Track training progress
 * train.browse    — Guided web browsing practice
 */
import { registerSkill, getSkill } from "../loader.js";
import { config } from "../../config/env.js";
import { log } from "../../utils/log.js";
import { getBotSendFn } from "./telegram.js";

// ── Helpers ──────────────────────────────────────────────────────

async function notify(text: string): Promise<void> {
  const send = getBotSendFn();
  if (send) {
    try {
      await send(Number(config.adminChatId) || 8189338836, text);
    } catch {}
  }
}

async function runSkill(name: string, args: Record<string, unknown>): Promise<string> {
  const skill = getSkill(name);
  if (!skill) return `[ERROR] Skill "${name}" not found`;
  try {
    return await skill.execute(args);
  } catch (e) {
    return `[ERROR] ${name}: ${(e as Error).message}`;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ── Recipe Storage (in-memory + KG) ─────────────────────────────

interface Recipe {
  name: string;
  description: string;
  steps: string[];
  skills_used: string[];
  success_patterns: string[];
  learned_at?: number;
}

const recipes = new Map<string, Recipe>();

// Pre-loaded recipes — Kingston's starting knowledge
const BUILTIN_RECIPES: Recipe[] = [
  {
    name: "web_search_and_read",
    description: "Search for information, navigate to the best result, extract content",
    steps: [
      "1. Use web.search with a clear, specific query",
      "2. Read the search results — pick the most relevant URL",
      "3. Use browser.navigate to go to that URL",
      "4. Use browser.extract with selector='body' to get the page content",
      "5. If the content is too long, use browser.extract with a more specific CSS selector",
      "6. Summarize the key findings",
    ],
    skills_used: ["web.search", "browser.navigate", "browser.extract"],
    success_patterns: ["search → navigate → extract → summarize"],
  },
  {
    name: "find_api_documentation",
    description: "Find API docs for any service, extract endpoints and auth methods",
    steps: [
      '1. Use web.search: "{service} API documentation developer"',
      "2. Look for official docs URL (usually docs.{service}.com or developer.{service}.com)",
      "3. browser.navigate to the docs page",
      "4. browser.snapshot to see the page structure (accessibility tree)",
      '5. Look for links with text like "Getting Started", "Authentication", "API Reference"',
      "6. browser.act to click the most relevant link",
      "7. browser.extract to read the content",
      '8. Look for: base URL, auth method (API key, OAuth, Bearer), rate limits',
      "9. Try to find a quick start / curl example",
      "10. Store findings with notes.add or kg.add",
    ],
    skills_used: ["web.search", "browser.navigate", "browser.snapshot", "browser.act", "browser.extract"],
    success_patterns: [
      "search → find docs URL → navigate → snapshot → act (click links) → extract",
      "Look for: /api/v1, Authorization: Bearer, x-api-key headers",
      "Check for: free tier, pricing page, rate limits",
    ],
  },
  {
    name: "fill_web_form",
    description: "Navigate to a page with a form and fill it out",
    steps: [
      "1. browser.navigate to the page with the form",
      "2. browser.snapshot interactive_only=true to see all form fields with ref numbers",
      "3. For each field: browser.act ref=N action=fill text='value'",
      "4. For dropdowns: browser.act ref=N action=select value='option_value'",
      "5. For checkboxes: browser.act ref=N action=check",
      "6. Find the submit button ref and browser.act ref=N action=click",
      "7. Wait for response: browser.snapshot to check result page",
    ],
    skills_used: ["browser.navigate", "browser.snapshot", "browser.act"],
    success_patterns: [
      "snapshot (interactive) → identify fields → fill each → submit → verify",
      "Always snapshot BEFORE acting to get fresh ref numbers",
      "If page changes, snapshot again (refs expire on navigation)",
    ],
  },
  {
    name: "multi_page_navigation",
    description: "Navigate through multiple pages to find specific information",
    steps: [
      "1. browser.navigate to the starting page",
      "2. browser.snapshot to see available links",
      "3. Identify the link that leads to the target information",
      "4. browser.act ref=N action=click to follow the link",
      "5. browser.snapshot again on the new page",
      "6. Repeat steps 3-5 until you reach the target",
      "7. browser.extract to get the final content",
      "8. If you get lost, browser.back or browser.navigate to restart",
    ],
    skills_used: ["browser.navigate", "browser.snapshot", "browser.act", "browser.back", "browser.extract"],
    success_patterns: [
      "snapshot → click → snapshot → click → extract",
      "Keep track of where you are (check browser.status)",
      "If lost, navigate back to a known good URL",
    ],
  },
  {
    name: "create_account_and_get_api_key",
    description: "Create a developer account on a service and obtain an API key",
    steps: [
      '1. web.search "{service} developer signup" or "{service} API free tier"',
      "2. browser.navigate to the signup/developer page",
      "3. browser.snapshot interactive_only=true",
      "4. Fill in the form fields (use Nicolas's info or Kingston's bot email)",
      "5. Submit the form",
      "6. Check for email verification (may need gmail.search)",
      '7. Navigate to API key / credentials page (often "Settings" → "API Keys")',
      "8. browser.extract to copy the API key",
      "9. Save the key securely (tell Nicolas, don't store in plain text)",
    ],
    skills_used: [
      "web.search", "browser.navigate", "browser.snapshot", "browser.act",
      "browser.extract", "gmail.search",
    ],
    success_patterns: [
      "Find signup page → fill form → verify email → get API key",
      "NEVER store API keys in notes — tell Nicolas directly",
      "Some services need phone verification — escalate to Nicolas",
    ],
  },
  {
    name: "price_comparison",
    description: "Find and compare prices for a product or service across multiple sites",
    steps: [
      '1. web.search "{product} price" or "{product} buy"',
      "2. For each of the top 3 results:",
      "   a. browser.navigate to the URL",
      '   b. browser.extract selector=".price, [class*=price], [data-price]" to find price',
      "   c. If no price found, browser.extract selector='body' and search for $ amounts",
      "   d. Note the price, URL, and any conditions",
      "3. Compare and report findings",
    ],
    skills_used: ["web.search", "browser.navigate", "browser.extract"],
    success_patterns: [
      "search → visit multiple sites → extract prices → compare",
      "Try CSS selectors with 'price' first, then fall back to full text",
    ],
  },
];

// Initialize built-in recipes
for (const r of BUILTIN_RECIPES) {
  recipes.set(r.name, r);
}

// ── Training Exercises ──────────────────────────────────────────

interface Exercise {
  level: number;
  name: string;
  description: string;
  task: string;
  recipe_hint: string;
  success_check: (result: string) => boolean;
}

const EXERCISES: Exercise[] = [
  // Level 1 — Basic Navigation
  {
    level: 1,
    name: "google_homepage",
    description: "Navigate to Google and confirm you see the search page",
    task: "Navigue vers google.com et dis-moi le titre de la page.",
    recipe_hint: "web_search_and_read",
    success_check: (r) => /google/i.test(r),
  },
  {
    level: 1,
    name: "wikipedia_extract",
    description: "Go to a Wikipedia page and extract the first paragraph",
    task: "Va sur la page Wikipedia de 'Intelligence artificielle' en français et extrais le premier paragraphe.",
    recipe_hint: "web_search_and_read",
    success_check: (r) => /intelligence artificielle/i.test(r) && r.length > 100,
  },
  {
    level: 1,
    name: "snapshot_practice",
    description: "Take a snapshot of a page and list the interactive elements",
    task: "Va sur github.com et fais un snapshot. Liste les 5 premiers éléments interactifs avec leurs numéros de référence.",
    recipe_hint: "multi_page_navigation",
    success_check: (r) => /\[\d+\]/.test(r) && /github/i.test(r),
  },

  // Level 2 — Search + Navigate
  {
    level: 2,
    name: "search_and_navigate",
    description: "Search for something and navigate to a result",
    task: "Cherche 'Printful API documentation' avec web.search, puis navigue vers le premier résultat officiel et extrais le titre.",
    recipe_hint: "find_api_documentation",
    success_check: (r) => /printful/i.test(r) && /api|doc/i.test(r),
  },
  {
    level: 2,
    name: "find_pricing",
    description: "Find pricing information for a SaaS product",
    task: "Trouve le prix du plan gratuit de Brave Search API. Cherche sur leur site et extrais les limites (requêtes/mois).",
    recipe_hint: "price_comparison",
    success_check: (r) => /free|gratuit|\$0/i.test(r) && /\d+/.test(r),
  },

  // Level 3 — Multi-Step with Interaction
  {
    level: 3,
    name: "github_repo_info",
    description: "Navigate a GitHub repo and extract specific information",
    task: 'Va sur github.com/anthropics/claude-code, fais un snapshot, clique sur "README" ou le fichier README.md, et extrais les 3 premières lignes.',
    recipe_hint: "multi_page_navigation",
    success_check: (r) => /claude/i.test(r) && r.length > 50,
  },
  {
    level: 3,
    name: "api_docs_exploration",
    description: "Navigate API docs and find authentication method",
    task: "Trouve la documentation API de Alpaca (alpaca.markets). Navigue jusqu'à la section Authentication et dis-moi comment s'authentifier (header, clé, etc.).",
    recipe_hint: "find_api_documentation",
    success_check: (r) => /api.key|bearer|header|apca-api/i.test(r),
  },

  // Level 4 — Complex Real-World Tasks
  {
    level: 4,
    name: "shopify_docs",
    description: "Find Shopify Admin API docs and extract product creation endpoint",
    task: "Trouve la doc Shopify Admin REST API pour créer un produit. Extrais: l'URL de l'endpoint, la méthode HTTP, et les champs requis minimum.",
    recipe_hint: "find_api_documentation",
    success_check: (r) => /POST|products\.json|title/i.test(r),
  },
  {
    level: 4,
    name: "moltbook_research",
    description: "Research a platform and find useful integration points",
    task: "Va sur moltbook.com, explore le site, et dis-moi: 1) Combien de submolts existent, 2) Comment fonctionne le karma, 3) Y a-t-il une API publique documentée?",
    recipe_hint: "multi_page_navigation",
    success_check: (r) => /submolt|karma|api/i.test(r) && r.length > 100,
  },

  // Level 5 — Full Autonomy
  {
    level: 5,
    name: "api_from_scratch",
    description: "Find, evaluate, and document an API from scratch",
    task: "Trouve une API gratuite pour obtenir des nouvelles financières en temps réel. Cherche, compare 3 options, et pour la meilleure: donne le base URL, la méthode d'auth, un exemple d'endpoint, et les limites du plan gratuit.",
    recipe_hint: "find_api_documentation",
    success_check: (r) =>
      /https?:\/\//i.test(r) && /api.key|bearer|free/i.test(r) && r.length > 200,
  },
];

// ── Training Progress ───────────────────────────────────────────

interface TrainingProgress {
  exercisesCompleted: number;
  exercisesPassed: number;
  exercisesFailed: number;
  currentLevel: number;
  history: Array<{
    exercise: string;
    level: number;
    passed: boolean;
    timestamp: number;
    notes?: string;
  }>;
  recipesUsed: Map<string, number>;
}

const progress: TrainingProgress = {
  exercisesCompleted: 0,
  exercisesPassed: 0,
  exercisesFailed: 0,
  currentLevel: 1,
  history: [],
  recipesUsed: new Map(),
};

// ── Skills ──────────────────────────────────────────────────────

registerSkill({
  name: "train.exercise",
  description:
    "Run a training exercise for Kingston. Progressive difficulty (levels 1-5). Each exercise teaches Kingston to use browser/web skills in the real world.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      level: { type: "string", description: "Difficulty level 1-5 (default: current level)" },
      name: { type: "string", description: "Specific exercise name (optional)" },
      auto: { type: "string", description: "Set to 'true' to let Kingston attempt the exercise autonomously" },
    },
  },
  async execute(args): Promise<string> {
    const level = Number(args.level) || progress.currentLevel;
    let exercise: Exercise | undefined;

    if (args.name) {
      exercise = EXERCISES.find(e => e.name === String(args.name));
    } else {
      // Find an exercise at the requested level that hasn't been completed
      const completed = new Set(progress.history.filter(h => h.passed).map(h => h.exercise));
      exercise = EXERCISES.find(e => e.level === level && !completed.has(e.name));
      if (!exercise) {
        // All at this level done, pick any
        exercise = EXERCISES.find(e => e.level === level);
      }
    }

    if (!exercise) {
      return `No exercise found at level ${level}. Available levels: 1-5.`;
    }

    // Get the associated recipe
    const recipe = recipes.get(exercise.recipe_hint);

    const lines = [
      `📚 Exercice d'entraînement — Niveau ${exercise.level}`,
      `━━━━━━━━━━━━━━━━━━━━━━━`,
      `Nom: ${exercise.name}`,
      `Description: ${exercise.description}`,
      "",
      `🎯 TÂCHE:`,
      exercise.task,
      "",
    ];

    if (recipe) {
      lines.push(`📖 RECETTE SUGGÉRÉE: ${recipe.name}`);
      lines.push(`Description: ${recipe.description}`);
      lines.push("");
      lines.push("Étapes:");
      for (const step of recipe.steps) {
        lines.push(`  ${step}`);
      }
      lines.push("");
      lines.push(`Skills à utiliser: ${recipe.skills_used.join(", ")}`);
      lines.push("");
      lines.push("Patterns de succès:");
      for (const p of recipe.success_patterns) {
        lines.push(`  → ${p}`);
      }
    }

    lines.push("");
    lines.push("━━━━━━━━━━━━━━━━━━━━━━━");
    lines.push("Kingston, exécute cette tâche en utilisant les skills browser.* et web.*.");
    lines.push("Quand tu as terminé, utilise train.evaluate pour valider ton résultat.");

    // If auto mode, try to execute through the LLM
    if (String(args.auto) === "true") {
      lines.push("");
      lines.push("⚡ Mode AUTO — Kingston va tenter l'exercice maintenant...");

      // Execute the task steps using the recipe
      if (recipe) {
        const results: string[] = [];

        // Step 1: Search
        if (recipe.skills_used.includes("web.search")) {
          const searchQuery = exercise.task.match(/"([^"]+)"/)?.[1] || exercise.name.replace(/_/g, " ");
          const searchResult = await runSkill("web.search", { query: searchQuery });
          results.push(`🔍 Search: ${searchResult.slice(0, 500)}`);
        }

        // Step 2: Navigate (extract URL from search results or exercise)
        const urlMatch = exercise.task.match(/(?:va sur|navigue vers|go to)\s+(\S+)/i);
        if (urlMatch) {
          let url = urlMatch[1].replace(/[,.]$/, "");
          if (!url.startsWith("http")) url = `https://${url}`;
          const navResult = await runSkill("browser.navigate", { url });
          results.push(`🌐 Navigate: ${navResult.slice(0, 500)}`);
        }

        // Step 3: Snapshot
        if (recipe.skills_used.includes("browser.snapshot")) {
          const snapResult = await runSkill("browser.snapshot", { interactive_only: "true", compact: "true" });
          results.push(`📸 Snapshot: ${snapResult.slice(0, 800)}`);
        }

        // Step 4: Extract
        if (recipe.skills_used.includes("browser.extract")) {
          const extractResult = await runSkill("browser.extract", { selector: "body", format: "text" });
          results.push(`📄 Extract: ${extractResult.slice(0, 800)}`);
        }

        lines.push("");
        lines.push("Résultats:");
        for (const r of results) {
          lines.push(r);
          lines.push("");
        }

        // Evaluate
        const fullResult = results.join("\n");
        const passed = exercise.success_check(fullResult);

        progress.exercisesCompleted++;
        if (passed) {
          progress.exercisesPassed++;
          if (level >= progress.currentLevel) {
            const allAtLevel = EXERCISES.filter(e => e.level === level);
            const passedAtLevel = progress.history.filter(
              h => h.level === level && h.passed
            ).length + 1;
            if (passedAtLevel >= Math.ceil(allAtLevel.length * 0.6)) {
              progress.currentLevel = Math.min(5, level + 1);
            }
          }
        } else {
          progress.exercisesFailed++;
        }

        progress.history.push({
          exercise: exercise.name,
          level: exercise.level,
          passed,
          timestamp: Date.now(),
        });

        lines.push(passed ? "✅ RÉUSSI!" : "❌ ÉCHOUÉ — Réessaie avec les étapes de la recette.");
      }
    }

    return lines.join("\n");
  },
});

// ── Evaluate ────────────────────────────────────────────────────

registerSkill({
  name: "train.evaluate",
  description: "Evaluate the result of a training exercise. Pass the exercise name and the result text.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      exercise: { type: "string", description: "Exercise name to evaluate" },
      result: { type: "string", description: "The result text from Kingston's attempt" },
    },
    required: ["exercise", "result"],
  },
  async execute(args): Promise<string> {
    const exercise = EXERCISES.find(e => e.name === String(args.exercise));
    if (!exercise) return `Exercise "${args.exercise}" not found.`;

    const result = String(args.result);
    const passed = exercise.success_check(result);

    progress.exercisesCompleted++;
    if (passed) {
      progress.exercisesPassed++;
    } else {
      progress.exercisesFailed++;
    }

    progress.history.push({
      exercise: exercise.name,
      level: exercise.level,
      passed,
      timestamp: Date.now(),
    });

    // Level up logic
    if (passed && exercise.level >= progress.currentLevel) {
      const allAtLevel = EXERCISES.filter(e => e.level === exercise.level);
      const passedAtLevel = progress.history.filter(
        h => h.level === exercise.level && h.passed
      ).length;
      if (passedAtLevel >= Math.ceil(allAtLevel.length * 0.6)) {
        progress.currentLevel = Math.min(5, exercise.level + 1);
        return `✅ RÉUSSI! Kingston monte au niveau ${progress.currentLevel}!\n\nScore: ${progress.exercisesPassed}/${progress.exercisesCompleted}`;
      }
    }

    return passed
      ? `✅ RÉUSSI! Bien joué Kingston.\n\nScore: ${progress.exercisesPassed}/${progress.exercisesCompleted} | Niveau: ${progress.currentLevel}`
      : `❌ ÉCHOUÉ. Réessaie.\n\nConseil: Utilise train.recipe name="${exercise.recipe_hint}" pour voir les étapes.\n\nScore: ${progress.exercisesPassed}/${progress.exercisesCompleted} | Niveau: ${progress.currentLevel}`;
  },
});

// ── API Hunt (Specialized) ──────────────────────────────────────

registerSkill({
  name: "train.api_hunt",
  description:
    "Guided API discovery — Kingston searches for API docs for any service, navigates the docs site, and extracts key information (base URL, auth, endpoints, limits). Returns a structured API profile.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      service: { type: "string", description: "Service name to find API docs for (e.g. 'Stripe', 'Reddit', 'Shopify')" },
      focus: { type: "string", description: "Specific area to focus on (e.g. 'products', 'authentication', 'webhooks')" },
    },
    required: ["service"],
  },
  async execute(args): Promise<string> {
    const service = String(args.service);
    const focus = args.focus ? String(args.focus) : "";
    const results: string[] = [];

    log.info(`[training] API Hunt: ${service}${focus ? ` (focus: ${focus})` : ""}`);

    // Step 1: Search for API docs
    results.push(`🔍 Searching for ${service} API docs...`);
    const searchQuery = focus
      ? `${service} API ${focus} documentation developer`
      : `${service} API documentation developer getting started`;
    const searchResult = await runSkill("web.search", { query: searchQuery, count: "5" });
    results.push(searchResult);

    // Extract the best URL from search results
    const urlPattern = /https?:\/\/[^\s)]+/g;
    const urls = searchResult.match(urlPattern) || [];
    const docsUrl = urls.find(u =>
      /doc|developer|api|reference/i.test(u) &&
      new RegExp(service.replace(/[^a-z0-9]/gi, ""), "i").test(u)
    ) || urls[0];

    if (!docsUrl) {
      return `❌ No API documentation found for "${service}". Try a different search term.\n\n${searchResult}`;
    }

    // Step 2: Navigate to docs
    results.push(`\n🌐 Navigating to: ${docsUrl}`);
    const navResult = await runSkill("browser.navigate", { url: docsUrl });
    results.push(navResult.slice(0, 1000));

    // Step 3: Snapshot to see structure
    results.push(`\n📸 Page structure:`);
    const snapResult = await runSkill("browser.snapshot", { interactive_only: "false", compact: "true" });
    results.push(snapResult.slice(0, 1500));

    // Step 4: Extract text content
    results.push(`\n📄 Content extraction:`);
    const extractResult = await runSkill("browser.extract", { selector: "body", format: "text" });

    // Parse for API-relevant information
    const content = extractResult;
    const apiProfile: string[] = [
      "",
      `━━━━━━━━━━━━━━━━━━━━━━━`,
      `📋 API Profile: ${service}`,
      `━━━━━━━━━━━━━━━━━━━━━━━`,
    ];

    // Try to find base URL
    const baseUrlMatch = content.match(/(?:base\s*url|endpoint|api\s*url)[:\s]*(https?:\/\/[^\s,]+)/i);
    apiProfile.push(`Base URL: ${baseUrlMatch?.[1] || "Not found — check docs"}`);

    // Try to find auth method
    const authPatterns = [
      { pattern: /bearer\s+token/i, method: "Bearer Token" },
      { pattern: /api[_\-\s]?key/i, method: "API Key" },
      { pattern: /oauth\s*2/i, method: "OAuth 2.0" },
      { pattern: /basic\s+auth/i, method: "Basic Auth" },
      { pattern: /x-api-key/i, method: "X-API-Key Header" },
      { pattern: /authorization\s*:\s*bearer/i, method: "Authorization: Bearer" },
    ];
    const foundAuth = authPatterns.filter(p => p.pattern.test(content)).map(p => p.method);
    apiProfile.push(`Auth: ${foundAuth.length ? foundAuth.join(", ") : "Not found — check docs"}`);

    // Try to find rate limits
    const rateLimitMatch = content.match(/(\d+)\s*(?:requests?|calls?)\s*(?:per|\/)\s*(second|minute|hour|day|month)/i);
    apiProfile.push(`Rate Limit: ${rateLimitMatch ? `${rateLimitMatch[1]} per ${rateLimitMatch[2]}` : "Not found"}`);

    // Try to find free tier
    const freeMatch = content.match(/free\s*(?:tier|plan|trial)[^.]{0,100}/i);
    apiProfile.push(`Free Tier: ${freeMatch ? freeMatch[0].trim() : "Check pricing page"}`);

    // Try to find endpoints
    const endpointMatches = content.match(/(?:GET|POST|PUT|DELETE|PATCH)\s+\/[^\s]{3,50}/g);
    if (endpointMatches) {
      apiProfile.push(`\nEndpoints found:`);
      for (const ep of [...new Set(endpointMatches)].slice(0, 10)) {
        apiProfile.push(`  ${ep}`);
      }
    }

    apiProfile.push(`\nDocs URL: ${docsUrl}`);
    apiProfile.push(`━━━━━━━━━━━━━━━━━━━━━━━`);

    results.push(apiProfile.join("\n"));

    // Store in KG if we found useful info
    if (foundAuth.length || baseUrlMatch || endpointMatches) {
      try {
        await runSkill("kg.add", {
          name: `API:${service}`,
          type: "api_service",
          properties: JSON.stringify({
            docs_url: docsUrl,
            auth_methods: foundAuth,
            base_url: baseUrlMatch?.[1] || "",
            endpoints_count: endpointMatches?.length || 0,
            discovered_at: new Date().toISOString(),
          }),
        });
        results.push(`\n💾 Saved to Knowledge Graph as "API:${service}"`);
      } catch {
        // KG save is optional
      }
    }

    return results.join("\n");
  },
});

// ── Browse Practice ─────────────────────────────────────────────

registerSkill({
  name: "train.browse",
  description:
    "Guided web browsing practice. Kingston navigates to a URL and performs a series of actions step by step with guidance.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL to navigate to" },
      goal: { type: "string", description: "What to accomplish on this page" },
      max_steps: { type: "string", description: "Max browsing steps (default 8)" },
    },
    required: ["url", "goal"],
  },
  async execute(args): Promise<string> {
    const url = String(args.url);
    const goal = String(args.goal);
    const maxSteps = Number(args.max_steps) || 8;
    const log_entries: string[] = [];

    log_entries.push(`🌐 Train.browse — Goal: ${goal}`);
    log_entries.push(`Starting URL: ${url}`);
    log_entries.push("");

    // Step 1: Navigate
    log_entries.push("Step 1: Navigating...");
    const navResult = await runSkill("browser.navigate", { url });
    log_entries.push(navResult.slice(0, 500));
    log_entries.push("");

    // Step 2: Snapshot
    log_entries.push("Step 2: Taking snapshot...");
    const snapResult = await runSkill("browser.snapshot", { interactive_only: "true", compact: "true" });
    log_entries.push(snapResult.slice(0, 1500));
    log_entries.push("");

    // Step 3: Extract content
    log_entries.push("Step 3: Extracting page content...");
    const extractResult = await runSkill("browser.extract", { selector: "body", format: "text" });
    log_entries.push(extractResult.slice(0, 1000));
    log_entries.push("");

    // Step 4: Provide analysis
    log_entries.push("━━━━━━━━━━━━━━━━━━━━━━━");
    log_entries.push("📋 ANALYSE:");
    log_entries.push(`Page visitée: ${url}`);
    log_entries.push(`Éléments interactifs trouvés: ${(snapResult.match(/\[\d+\]/g) || []).length}`);
    log_entries.push(`Contenu extrait: ${extractResult.length} caractères`);
    log_entries.push("");
    log_entries.push(`🎯 Goal: ${goal}`);
    log_entries.push("");
    log_entries.push("Pour continuer, Kingston devrait:");
    log_entries.push("  1. Analyser le snapshot pour trouver les éléments pertinents");
    log_entries.push("  2. Utiliser browser.act ref=N action=click pour naviguer");
    log_entries.push("  3. Refaire un browser.snapshot après chaque action");
    log_entries.push("  4. Utiliser browser.extract avec des selectors spécifiques");
    log_entries.push("");
    log_entries.push(`Remaining budget: ${maxSteps - 3} steps`);

    return log_entries.join("\n");
  },
});

// ── Recipe Library ──────────────────────────────────────────────

registerSkill({
  name: "train.recipe",
  description:
    "View or add a recipe (learned pattern) for a real-world task. Recipes teach Kingston step-by-step approaches.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Recipe name to view (or 'list' to see all)" },
      add_name: { type: "string", description: "Name for a new recipe" },
      add_description: { type: "string", description: "Description of the new recipe" },
      add_steps: { type: "string", description: "JSON array of step strings" },
      add_skills: { type: "string", description: "Comma-separated list of skills used" },
    },
  },
  async execute(args): Promise<string> {
    // List all recipes
    if (!args.name && !args.add_name) {
      const lines = [`📚 Recettes disponibles (${recipes.size}):\n`];
      for (const [key, r] of recipes) {
        lines.push(`  📖 ${key} — ${r.description}`);
        lines.push(`     Skills: ${r.skills_used.join(", ")}`);
      }
      return lines.join("\n");
    }

    // Add new recipe
    if (args.add_name) {
      const name = String(args.add_name);
      let steps: string[];
      try {
        steps = JSON.parse(String(args.add_steps || "[]"));
      } catch {
        return "Error: add_steps must be a valid JSON array of strings";
      }

      const recipe: Recipe = {
        name,
        description: String(args.add_description || "Custom recipe"),
        steps,
        skills_used: String(args.add_skills || "").split(",").map(s => s.trim()).filter(Boolean),
        success_patterns: [],
        learned_at: Date.now(),
      };

      recipes.set(name, recipe);
      return `✅ Recipe "${name}" added with ${steps.length} steps.`;
    }

    // View specific recipe
    const name = String(args.name);
    if (name === "list") {
      const lines = [`📚 Recettes (${recipes.size}):\n`];
      for (const [key, r] of recipes) {
        lines.push(`  📖 ${key} — ${r.description}`);
      }
      return lines.join("\n");
    }

    const recipe = recipes.get(name);
    if (!recipe) {
      // Fuzzy match
      const close = [...recipes.keys()].find(k => k.includes(name) || name.includes(k));
      if (close) return `Recipe "${name}" not found. Did you mean "${close}"?`;
      return `Recipe "${name}" not found. Use train.recipe without args to list all.`;
    }

    const lines = [
      `📖 Recette: ${recipe.name}`,
      `━━━━━━━━━━━━━━━━━━━━━━━`,
      `Description: ${recipe.description}`,
      "",
      "Étapes:",
      ...recipe.steps.map(s => `  ${s}`),
      "",
      `Skills utilisés: ${recipe.skills_used.join(", ")}`,
    ];

    if (recipe.success_patterns.length) {
      lines.push("");
      lines.push("Patterns de succès:");
      for (const p of recipe.success_patterns) {
        lines.push(`  → ${p}`);
      }
    }

    return lines.join("\n");
  },
});

// ── Progress Tracking ───────────────────────────────────────────

registerSkill({
  name: "train.progress",
  description: "View Kingston's training progress — exercises completed, current level, history",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      detailed: { type: "string", description: "Set to 'true' for full history" },
    },
  },
  async execute(args): Promise<string> {
    const lines = [
      `📊 Kingston Training Progress`,
      `━━━━━━━━━━━━━━━━━━━━━━━`,
      `Niveau actuel: ${progress.currentLevel}/5`,
      `Exercices complétés: ${progress.exercisesCompleted}`,
      `Réussis: ${progress.exercisesPassed} ✅`,
      `Échoués: ${progress.exercisesFailed} ❌`,
      `Taux de réussite: ${progress.exercisesCompleted ? Math.round(progress.exercisesPassed / progress.exercisesCompleted * 100) : 0}%`,
      "",
      `Exercices disponibles par niveau:`,
    ];

    for (let level = 1; level <= 5; level++) {
      const atLevel = EXERCISES.filter(e => e.level === level);
      const passed = progress.history.filter(h => h.level === level && h.passed).length;
      const icon = level <= progress.currentLevel ? "🟢" : "⚪";
      lines.push(`  ${icon} Niveau ${level}: ${passed}/${atLevel.length} réussis — ${atLevel.map(e => e.name).join(", ")}`);
    }

    lines.push("");
    lines.push(`Recettes maîtrisées: ${recipes.size}`);

    if (String(args.detailed) === "true" && progress.history.length > 0) {
      lines.push("");
      lines.push("Historique récent:");
      for (const h of progress.history.slice(-10)) {
        const icon = h.passed ? "✅" : "❌";
        const date = new Date(h.timestamp).toLocaleString("fr-CA");
        lines.push(`  ${icon} ${h.exercise} (L${h.level}) — ${date}`);
      }
    }

    return lines.join("\n");
  },
});

log.debug("Registered 6 train.* skills");
