/**
 * Kingston Autonomous Trainer v2 — Complete rewrite.
 *
 * Tests EVERY skill dynamically, tracks missing credentials,
 * practices desktop control, sends per-test Telegram notifications.
 * Tough but fair evaluation — like Nicolas would do it.
 *
 * ChatId 250 (isolated from agents 100-106, cron 200-249).
 */
import fs from "node:fs";
import path from "node:path";
import { handleMessage } from "../orchestrator/router.js";
import { hasUserTaskPending } from "../bot/chatLock.js";
import { clearTurns, clearSession, getDb } from "../storage/store.js";
import { log } from "../utils/log.js";
import { getBotSendFn } from "../skills/builtin/telegram.js";
import { registerSkill, getAllSkills, type Skill } from "../skills/loader.js";
import { config } from "../config/env.js";

const TRAINER_CHAT_ID = 250;
const TRAINER_USER_ID = 8189338836;
const CREDENTIALS_FILE = path.resolve(process.cwd(), "relay", "MISSING_CREDENTIALS.md");
const COACHING_FILE = path.resolve(process.cwd(), "relay", "COACHING.md");

// ── Exercise Types ──────────────────────────────────────────────

interface Exercise {
  id: string;
  phase: "skills" | "desktop" | "browser" | "missions";
  skillName: string;         // The skill being tested
  prompt: string;            // What Kingston receives
  successPatterns: string[]; // Patterns that indicate success in the response
  timeoutMs: number;
  hints?: string;
}

// ── Curated Mission Exercises ───────────────────────────────────
// These are hand-crafted complex tasks that test real-world ability

const MISSIONS: Exercise[] = [
  // ── Desktop Mastery ────────────────────────
  {
    id: "M_open_notepad", phase: "desktop", skillName: "app.launch",
    prompt: "Ouvre Notepad sur mon ordinateur. Utilise app.launch avec name='notepad'.",
    successPatterns: ["notepad", "lancé", "ouvert", "launched", "opened", "PID"],
    timeoutMs: 30_000,
  },
  {
    id: "M_open_chrome", phase: "desktop", skillName: "app.launch",
    prompt: "Ouvre Google Chrome. Utilise app.launch avec name='chrome'.",
    successPatterns: ["chrome", "lancé", "ouvert", "launched", "browser"],
    timeoutMs: 30_000,
  },
  {
    id: "M_screenshot", phase: "desktop", skillName: "desktop.screenshot",
    prompt: "Prends une capture d'écran du bureau. Utilise desktop.screenshot.",
    successPatterns: ["screenshot", "capture", "saved", "png", "jpg", "image"],
    timeoutMs: 30_000,
  },
  {
    id: "M_list_apps", phase: "desktop", skillName: "app.list",
    prompt: "Liste toutes les applications ouvertes sur mon PC. Utilise app.list.",
    successPatterns: ["window", "app", "PID", "process", "title"],
    timeoutMs: 30_000,
  },
  {
    id: "M_open_calculator", phase: "desktop", skillName: "app.launch",
    prompt: "Ouvre la calculatrice Windows. Utilise app.launch avec name='calc'.",
    successPatterns: ["calc", "lancé", "ouvert", "calculator"],
    timeoutMs: 30_000,
  },
  {
    id: "M_open_terminal", phase: "desktop", skillName: "app.launch",
    prompt: "Ouvre le Windows Terminal. Utilise app.launch avec name='terminal'.",
    successPatterns: ["terminal", "lancé", "ouvert", "wt"],
    timeoutMs: 30_000,
  },
  {
    id: "M_clipboard", phase: "desktop", skillName: "desktop.clipboard_write",
    prompt: "Écris 'Kingston was here' dans le presse-papier. Utilise desktop.clipboard_write avec text='Kingston was here'.",
    successPatterns: ["clipboard", "presse-papier", "Kingston", "écrit", "copié"],
    timeoutMs: 30_000,
  },
  {
    id: "M_desktop_notify", phase: "desktop", skillName: "desktop.notify",
    prompt: "Envoie une notification Windows avec le titre 'Kingston Training' et le message 'Exercise completed successfully!'. Utilise desktop.notify.",
    successPatterns: ["notification", "envoyé", "toast", "sent"],
    timeoutMs: 30_000,
  },
  {
    id: "M_processes", phase: "desktop", skillName: "process.list",
    prompt: "Liste les 10 processus qui utilisent le plus de mémoire. Utilise process.list.",
    successPatterns: ["process", "MB", "memory", "PID", "chrome", "node"],
    timeoutMs: 30_000,
  },
  {
    id: "M_system_full", phase: "desktop", skillName: "system.info_full",
    prompt: "Donne-moi les infos système complètes: CPU, GPU, RAM, réseau. Utilise system.info_full.",
    successPatterns: ["CPU", "GPU", "RAM", "network", "RTX", "memory"],
    timeoutMs: 30_000,
  },
  {
    id: "M_disk_space", phase: "desktop", skillName: "system.disk",
    prompt: "Montre-moi l'espace disque disponible et les plus gros fichiers. Utilise system.disk.",
    successPatterns: ["disk", "GB", "free", "used", "C:", "D:"],
    timeoutMs: 30_000,
  },
  {
    id: "M_installed_software", phase: "desktop", skillName: "system.installed",
    prompt: "Liste les logiciels installés sur ce PC. Utilise system.installed.",
    successPatterns: ["installed", "software", "version", "Steam", "Chrome", "Python"],
    timeoutMs: 45_000,
  },

  // ── Shadowrun/Gaming Mission ───────────────
  {
    id: "M_find_shadowrun", phase: "desktop", skillName: "web.search",
    prompt: "Mission: Trouve Shadowrun sur Steam. 1) Cherche 'Shadowrun Returns Steam' avec web.search. 2) Trouve l'App ID Steam du jeu. 3) Sauvegarde les infos (titre, App ID, prix) dans une note 'Shadowrun Steam Info'.",
    successPatterns: ["Shadowrun", "Steam", "app", "ID", "note"],
    timeoutMs: 90_000,
    hints: "Cherche sur le web, trouve l'App ID Steam (c'est un nombre). Sauvegarde dans une note.",
  },
  {
    id: "M_open_steam", phase: "desktop", skillName: "app.launch",
    prompt: "Ouvre Steam sur mon PC. Utilise app.launch avec name='steam' ou path='C:\\Program Files (x86)\\Steam\\steam.exe'.",
    successPatterns: ["steam", "lancé", "ouvert", "launched"],
    timeoutMs: 30_000,
  },
  {
    id: "M_steam_shadowrun", phase: "desktop", skillName: "shell.exec",
    prompt: "Essaie d'ouvrir la page Steam de Shadowrun Returns (App ID 234650) dans le navigateur. Utilise desktop.open avec url='steam://store/234650' ou browser.navigate vers 'https://store.steampowered.com/app/234650'.",
    successPatterns: ["steam", "Shadowrun", "store", "234650", "navigat"],
    timeoutMs: 60_000,
    hints: "Utilise desktop.open avec target='steam://store/234650' ou browser.navigate vers https://store.steampowered.com/app/234650",
  },

  // ── Shopify API Hunt ───────────────────────
  {
    id: "M_shopify_api", phase: "missions", skillName: "browser.navigate",
    prompt: "Mission: Trouve comment obtenir un access token pour l'API Admin de Shopify. Étapes: 1) browser.navigate vers https://shopify.dev. 2) browser.snapshot. 3) Cherche les docs sur 'Admin API authentication'. 4) Extrais les étapes pour créer une custom app. 5) Sauvegarde dans une note 'Shopify API Setup'. SI le site bloque, utilise web.search 'Shopify Admin API custom app access token 2026' + web.fetch.",
    successPatterns: ["shopify", "admin", "token", "api", "app", "custom"],
    timeoutMs: 180_000,
    hints: "Va sur shopify.dev/docs/api/admin. L'access token se crée dans Settings > Apps > Develop apps.",
  },
  {
    id: "M_shopify_chatbot", phase: "missions", skillName: "browser.navigate",
    prompt: "Mission: Shopify a un assistant IA sur shopify.dev. 1) browser.navigate vers https://shopify.dev. 2) browser.snapshot pour trouver le chatbot (bouton en bas à droite, 'Ask Sidekick'). 3) Clique dessus avec browser.act. 4) browser.type pour demander 'How to create a custom app and get Admin API access token'. 5) Lis et sauvegarde la réponse dans une note.",
    successPatterns: ["shopify", "chat", "sidekick", "custom app", "token"],
    timeoutMs: 180_000,
    hints: "Le chatbot est sur shopify.dev. Cherche un bouton 'Ask Sidekick' ou widget chat en bas à droite.",
  },

  // ── Real-World Research ────────────────────
  {
    id: "M_full_market", phase: "missions", skillName: "stocks.price",
    prompt: "Crée un rapport de marché: 1) stocks.price AAPL, TSLA, NVDA. 2) crypto.price BTC, ETH. 3) market.overview. 4) Compile tout dans une note structurée 'Daily Market Report'.",
    successPatterns: ["AAPL", "TSLA", "BTC", "market", "note", "report", "$"],
    timeoutMs: 180_000,
  },
  {
    id: "M_competitor_analysis", phase: "missions", skillName: "web.search",
    prompt: "Analyse de la concurrence: 1) web.search 'AI assistant Telegram bot 2026'. 2) web.fetch sur les 2 premiers résultats. 3) Résume les fonctionnalités. 4) Sauvegarde dans une note 'Competitor Analysis'.",
    successPatterns: ["telegram", "bot", "AI", "note", "concurrent", "http"],
    timeoutMs: 120_000,
  },
];

// ── Dynamic Exercise Generator ──────────────────────────────────

/** Generate a test exercise for a given skill based on its metadata */
function generateExercise(skill: Skill): Exercise | null {
  const name = skill.name;
  const ns = name.split(".")[0];
  const desc = skill.description || "";

  // Skip skills that are dangerous to test autonomously
  const dangerousSkills = [
    // System control
    "system.kill", "system.restart", "system.startup", "process.kill", "app.close",
    "files.delete", "files.move", "config.reload", "shell.exec",
    "keyboard.send", "keyboard.type", "mouse.click",
    // Email/messaging — don't send real messages
    "gmail.send", "gmail.reply", "gmail.draft",
    "telegram.send", "sms.send", "phone.call",
    // Social media — don't post real content
    "moltbook.post", "moltbook.comment", "moltbook.upvote", "moltbook.follow",
    "twitter.post", "linkedin.post", "reddit.post", "discord.send",
    "facebook.post", "instagram.post", "instagram.story",
    // E-commerce — don't create real orders/products
    "shopify.create_product", "shopify.update_product", "shopify.delete_product",
    "printful.create_product", "printful.create_order",
    "stripe.charge", "stripe.refund",
    // TRADING — CRITICAL: don't execute real trades!
    "trading.buy", "trading.sell", "trading.cancel", "trading.close",
    "trading.bracket", "trading.limit", "trading.stop",
    "trading.short", "trading.cover",
    // Data modification
    "contacts.delete", "contacts.update", "contacts.add",
    "notes.delete",
    "db.query",
    "code.run", "code.request",
    // Agent control
    "agents.spawn", "agents.spawn_parallel",
    "workflow.run", "workflow.create", "workflow.webhook",
    "secrets.set", "secrets.delete",
    // Training meta (don't recurse)
    "train.start", "train.stop",
    // Autonomous operations
    "autonomous.goal", "autonomous.attempt", "autonomous.escalate",
    "goal.set", "goal.focus", "goal.advance", "goal.complete", "goal.fail", "goal.decompose",
    "mind.peodc", "mind.peodc_advance",
    // Package managers — don't install random packages
    "npm.global_install", "npm.install", "pip.install", "winget.install", "winget.uninstall", "winget.upgrade",
    // Heavy/expensive
    "computer.use", "wakeword.start", "wakeword.stop",
    "pipeline.tshirt", "pipeline.batch", "pipeline.quick",
    // Content creation (can spam)
    "content.draft", "content.schedule",
    "landing.generate",
    // Invoice/billing
    "invoice.add", "invoice.scan_email",
  ];

  // Also block by prefix — entire namespaces that are dangerous
  const dangerousPrefixes = [
    "booking.", "whatsapp.", "hubspot.",
    "trading.",  // ALL trading skills — never execute real trades
    "alpaca.",   // Direct broker API
    "order.",    // Order management
  ];

  if (dangerousSkills.includes(name)) return null;
  if (dangerousPrefixes.some(p => name.startsWith(p))) return null;
  if (name.startsWith("train.")) return null; // skip training skills
  if (name.startsWith("plugin.")) return null; // plugins are internal
  if (name.startsWith("hooks.")) return null; // hooks are internal
  if (name.startsWith("xp.")) return null; // gamification internal

  // Namespace-aware smart defaults — realistic params per domain
  const nsSamples: Record<string, Record<string, string>> = {
    "files": { path: "'.'", dir: "'.'", name: "'test.txt'", content: "'hello'" },
    "stocks": { symbol: "'AAPL'", ticker: "'AAPL'", symbols: "'AAPL,TSLA'" },
    "crypto": { symbol: "'BTC'", coin: "'bitcoin'", pair: "'BTC/USD'" },
    "trading": { symbol: "'AAPL'", qty: "1", side: "'buy'" },
    "weather": { city: "'Ottawa'", location: "'Ottawa, Canada'" },
    "forex": { from: "'USD'", to: "'CAD'", amount: "100", base: "'USD'" },
    "translate": { text: "'Hello World'", from: "'en'", to: "'fr'" },
    "web": { query: "'best AI tools 2026'", url: "'https://httpbin.org/json'" },
    "browser": { url: "'https://example.com'", selector: "'body'", text: "'test'" },
    "notes": { title: "'Test Note'", content: "'Kingston training test'", query: "'test'" },
    "memory": { text: "'Kingston is an AI assistant'", query: "'Kingston'" },
    "contacts": { name: "'Test Contact'", email: "'test@example.com'" },
    "agents": { name: "'scout'", agent: "'scout'" },
    "rss": { url: "'https://hnrss.org/frontpage'", feed: "'https://hnrss.org/frontpage'" },
    "math": { expression: "'2 + 2 * 3'", formula: "'sqrt(144)'" },
    "hash": { text: "'hello'", algorithm: "'sha256'" },
    "convert": { value: "100", from: "'km'", to: "'miles'" },
    "network": { domain: "'google.com'", host: "'google.com'", url: "'https://google.com'" },
    "dns": { domain: "'google.com'" },
    "image": { prompt: "'a cat sitting on a keyboard'" },
    "nlp": { text: "'This is a test sentence for NLP analysis.'" },
    "content": { text: "'Kingston is the best AI assistant for entrepreneurs.'" },
    "brand": { text: "'Check out our amazing new product!'" },
    "client": { name: "'Nicolas'", id: "1" },
    "kg": { entity: "'Kingston'", type: "'AI'" },
    "episodic": { query: "'training'", limit: "5" },
    "rules": { limit: "10" },
    "goals": { limit: "5" },
    "goal": { goal: "'Learn a new skill'" },
    "cron": { limit: "10" },
    "system": { limit: "10" },
    "errors": { limit: "10" },
    "analytics": { period: "'24h'" },
    "notify": { message: "'Test notification'", level: "'GENERAL'" },
    "planner": { limit: "5" },
    "invoice": { limit: "5" },
    "price": { limit: "5" },
    "jobs": { limit: "5" },
    "git": { path: "'.'" },
    "ftp": { path: "'/'" },
    "dungeon": { action: "'look around'" },
    "tutor": { language: "'french'" },
    "travel": { destination: "'Paris'" },
    "health": { metric: "'sleep'" },
    "calendar": { query: "'meeting'", days: "7" },
    "gmail": { query: "'is:inbox'", limit: "5" },
    "youtube": { limit: "5" },
    "food": { query: "'apple'", barcode: "'5000159484695'" },
    "books": { query: "'Thinking Fast and Slow'" },
    "wiki": { query: "'artificial intelligence'" },
    "nasa": { limit: "5" },
    "holidays": { country: "'CA'", year: "2026" },
    "stackexchange": { query: "'javascript async await'", site: "'stackoverflow'" },
    "hackernews": { limit: "5" },
    "pollinations": { prompt: "'a futuristic city'" },
    "qr": { text: "'https://bastilon.org'" },
    "url": { url: "'https://bastilon.org'" },
    "dict": { word: "'serendipity'" },
    "words": { query: "'happy'" },
    "worldbank": { indicator: "'NY.GDP.MKTP.CD'", country: "'CA'" },
    "finnhub": { symbol: "'AAPL'" },
    "archive": { query: "'artificial intelligence'" },
    "power": { action: "'status'" },
    "process": { limit: "10" },
    "app": { name: "'notepad'" },
    "desktop": { text: "'Kingston test'" },
    "skills": { query: "'web'" },
    "selfimprove": { limit: "5" },
    "marketing": { category: "'curiosity'", random: "true" },
  };

  // Build example args using namespace-aware defaults
  const props = skill.argsSchema?.properties || {};
  const nsDefaults = nsSamples[ns] || {};
  const globalDefaults: Record<string, string> = {
    "query": "'Kingston AI'", "text": "'Hello World'", "symbol": "'BTC'",
    "url": "'https://httpbin.org/json'", "city": "'Ottawa'", "domain": "'google.com'",
    "expression": "'2 + 2'", "limit": "5", "count": "3", "name": "'Kingston'",
    "base": "'USD'", "format": "'json'", "path": "'.'", "id": "1",
  };

  const exampleArgs: string[] = [];
  for (const [propName, propDef] of Object.entries(props)) {
    const p = propDef as { type: string; description?: string };
    const val = nsDefaults[propName] || globalDefaults[propName] || (p.type === "string" ? "'test'" : "5");
    exampleArgs.push(`${propName}=${val}`);
  }

  const argsStr = exampleArgs.length > 0 ? ` avec ${exampleArgs.join(", ")}` : "";

  // Generate success patterns — broader matching
  const patterns: string[] = [];
  // Add namespace as a likely response keyword
  patterns.push(ns);
  // Add key description words
  const stopWords = new Set(["with", "from", "this", "that", "uses", "will", "have", "been",
    "does", "using", "the", "and", "for", "are", "can", "not", "all", "get", "set"]);
  const descWords = desc.toLowerCase().split(/\s+/);
  for (const w of descWords) {
    if (w.length > 4 && !stopWords.has(w) && patterns.length < 5) {
      patterns.push(w);
    }
  }
  if (patterns.length < 2) patterns.push("result", "ok", "done");

  return {
    id: `S_${name.replace(".", "_")}`,
    phase: "skills",
    skillName: name,
    prompt: `Appelle le skill ${name}${argsStr}. Description: ${desc}. Exécute-le et donne le résultat.`,
    successPatterns: patterns,
    timeoutMs: 60_000,
  };
}

// ── Credential Detection ────────────────────────────────────────

const CREDENTIAL_ERROR_PATTERNS = [
  /not configured/i,
  /no api[_ ]?key/i,
  /missing (api|token|key|credential|secret)/i,
  /api[_ ]?key (is )?required/i,
  /token (is )?required/i,
  /unauthorized/i,
  /401/,
  /ECONNREFUSED/i,
  /empty.*token/i,
  /set.*API_KEY/i,
  /configure.*first/i,
  /pas configuré/i,
  /pas de (clé|token|api)/i,
];

function detectMissingCredential(response: string): string | null {
  for (const pattern of CREDENTIAL_ERROR_PATTERNS) {
    if (pattern.test(response)) {
      const match = response.match(/([A-Z_]+(?:API|KEY|TOKEN|SECRET)[A-Z_]*)/);
      return match ? match[1] : "UNKNOWN_CREDENTIAL";
    }
  }
  return null;
}

function logMissingCredential(skillName: string, credentialHint: string, response: string): void {
  try {
    let content = "";
    const isNew = !fs.existsSync(CREDENTIALS_FILE);
    if (!isNew) {
      content = fs.readFileSync(CREDENTIALS_FILE, "utf-8");
    } else {
      content = "# APIs et Credentials Manquantes\n\n> Mis à jour automatiquement par le trainer.\n> Kingston a testé ces skills et ils ont échoué par manque de credentials.\n\n| Skill | Credential | Erreur | Date |\n|-------|-----------|--------|------|\n";
      fs.writeFileSync(CREDENTIALS_FILE, content);
    }

    const date = new Date().toISOString().split("T")[0];
    const errorPreview = response.slice(0, 100).replace(/\n/g, " ").replace(/\|/g, "\\|");
    const line = `| ${skillName} | ${credentialHint} | ${errorPreview} | ${date} |`;

    if (!content.includes(skillName)) {
      fs.appendFileSync(CREDENTIALS_FILE, line + "\n");
      log.info(`[trainer] 🔑 Missing credential logged: ${skillName} → ${credentialHint}`);
    }
  } catch (e) {
    log.warn(`[trainer] Failed to log credential: ${(e as Error).message}`);
  }
}

// ── Evaluation (Tough but Fair) ─────────────────────────────────

function evaluateResponse(
  exercise: Exercise,
  response: string,
): { passed: boolean; score: number; reason: string } {
  const lower = response.toLowerCase();

  // === HARD FAIL: Refusals ===
  const refusalPatterns = [
    /je ne (peux|suis) pas (exécuter|utiliser|appeler|faire)/i,
    /je (vais|peux) transmettre/i,
    /pas (d'outils|de skills|de tools|capable)/i,
    /cannot (execute|use|call|run)/i,
    /i can'?t (use|execute|call|run)/i,
    /je n'ai pas accès/i,
    /j'ai pas de tool/i,
    /pas disponible/i,
    /je n'ai pas de skill/i,
    /je n'ai pas d'outil/i,
    /je n'ai pas l'outil/i,
    /je ne connais pas ce skill/i,
    /skill.*n'existe pas/i,
    /outil.*n'existe pas/i,
    /n'est pas reconnu/i,
    /peux-tu me donner plus d'info/i,
    /voici ce que tu dois faire manuellement/i,
    /je ne dispose pas/i,
  ];
  if (refusalPatterns.some(p => p.test(response))) {
    return { passed: false, score: 0, reason: "Refus d'utiliser les tools" };
  }

  // === CREDENTIAL FAIL: Missing API key (not Kingston's fault) ===
  const missingCred = detectMissingCredential(response);
  if (missingCred) {
    logMissingCredential(exercise.skillName, missingCred, response);
    return { passed: false, score: -1, reason: `Credential manquante: ${missingCred}` };
  }

  // === HARD FAIL: Empty or error responses ===
  if (response.length < 10) {
    return { passed: false, score: 5, reason: "Réponse trop courte" };
  }
  if (/^(error|erreur|failed|échec)/i.test(response.trim()) && response.length < 80) {
    return { passed: false, score: 5, reason: "Erreur" };
  }

  // === SCORING ===
  const patternMatches = exercise.successPatterns.filter(p => lower.includes(p.toLowerCase()));
  const matchRatio = patternMatches.length / exercise.successPatterns.length;

  let score = 0;
  let reasons: string[] = [];

  // Tool actually called (max 25 pts) — most important signal
  const toolCalledPatterns = [
    /Tool ".*" execution/i,             // Tool was executed (even if failed)
    /Error:.*execution failed/i,        // Tool error = tool was called
    /HTTP \d{3}/,                       // HTTP response = API was called
    /trouvé|found|résultat|result/i,    // Got results
    /aucun.*trouvé|no.*found|empty/i,   // Empty result = tool worked, just no data
  ];
  const toolWasCalled = toolCalledPatterns.some(p => p.test(response));
  if (toolWasCalled) { score += 25; reasons.push("Tool appelé"); }

  // Pattern matching (max 30 pts)
  if (matchRatio >= 0.5) { score += 30; reasons.push("Bons mots-clés"); }
  else if (matchRatio >= 0.25) { score += 15; reasons.push("Quelques mots-clés"); }

  // Response quality (max 20 pts)
  if (response.length > 200) { score += 15; reasons.push("Réponse détaillée"); }
  else if (response.length > 50) { score += 5; reasons.push("Réponse OK"); }

  // Contains actual data (numbers, URLs, JSON) — sign of real tool execution
  if (/\d{2,}/.test(response)) { score += 10; reasons.push("Données numériques"); }
  if (/https?:\/\//.test(response)) { score += 5; reasons.push("URLs trouvées"); }

  // No fabrication detected (max 10 pts)
  if (!/je ne sais pas|I don't know|unavailable|indisponible/i.test(response)) {
    score += 10; reasons.push("Pas d'aveu d'ignorance");
  }

  // === PASS THRESHOLD ===
  // Option 1: Score 40+ with some evidence (pattern match or tool call)
  // Option 2: Tool was called + got real data (numbers/URLs) — that's a success even without pattern match
  const hasRealData = /\d{2,}/.test(response) || /https?:\/\//.test(response);
  const passed = (score >= 40 && (patternMatches.length >= 1 || toolWasCalled))
    || (toolWasCalled && hasRealData && response.length > 20);
  const reason = passed
    ? `✅ ${reasons.join(", ")} (${patternMatches.length}/${exercise.successPatterns.length} patterns)`
    : `❌ Score ${score} insuffisant (${patternMatches.length}/${exercise.successPatterns.length} patterns)`;

  return { passed, score, reason };
}

// ── Training State ──────────────────────────────────────────────

interface TrainerState {
  running: boolean;
  phase: "skills" | "desktop" | "browser" | "missions";
  exerciseQueue: Exercise[];
  queueIndex: number;
  totalAttempts: number;
  totalPassed: number;
  totalFailed: number;
  totalCredentialMissing: number;
  startedAt: number;
  skillsTested: Set<string>;
  skillsPassed: Set<string>;
  skillsFailed: Map<string, number>;  // skillName → attempt count
  intervalHandle?: ReturnType<typeof setTimeout>;
}

let state: TrainerState = {
  running: false,
  phase: "skills",
  exerciseQueue: [],
  queueIndex: 0,
  totalAttempts: 0,
  totalPassed: 0,
  totalFailed: 0,
  totalCredentialMissing: 0,
  startedAt: 0,
  skillsTested: new Set(),
  skillsPassed: new Set(),
  skillsFailed: new Map(),
};

// ── Notifications ───────────────────────────────────────────────

async function notify(text: string): Promise<void> {
  const send = getBotSendFn();
  if (send) {
    try {
      await send(Number(config.adminChatId) || TRAINER_USER_ID, text);
    } catch (e) {
      log.warn(`[trainer] notify failed: ${(e as Error).message}`);
    }
  }
}

function notifyTestResultSilent(exercise: Exercise, passed: boolean, score: number, reason: string, durationMs: number): void {
  // Silent — only log, no Telegram notification per exercise.
  // Progress reports are sent every 25 exercises instead.
  const icon = passed ? "✅" : "❌";
  log.info(`[trainer] ${icon} ${exercise.skillName} score=${score} (${(durationMs / 1000).toFixed(1)}s) ${reason}`);
}

// ── Background Execution Helpers ─────────────────────────────────

/** Wait until no user messages are being processed or queued. Max 60s. */
async function waitForUserQueue(): Promise<void> {
  const MAX_WAIT = 60_000;
  const POLL_MS = 500;
  const start = Date.now();
  while (hasUserTaskPending() && Date.now() - start < MAX_WAIT) {
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

// Mutex to prevent concurrent handleMessage calls from trainer
let trainerBusy = false;

// ── Core Execution ──────────────────────────────────────────────

async function executeExercise(exercise: Exercise, attempt: number = 1): Promise<boolean> {
  // Yield to user messages before starting
  if (hasUserTaskPending()) {
    log.info(`[trainer] Yielding to user messages before exercise ${exercise.id}`);
    await waitForUserQueue();
  }

  // Don't run if another trainer exercise is still in progress
  if (trainerBusy) {
    log.debug(`[trainer] Skipping ${exercise.id} — previous exercise still running`);
    return false;
  }

  trainerBusy = true;
  log.info(`[trainer] Exercise ${exercise.id} (${exercise.phase}, attempt ${attempt}) — starting`);

  // Fresh session
  clearTurns(TRAINER_CHAT_ID);
  clearSession(TRAINER_CHAT_ID);

  // Build prompt with [TRAINING: prefix for router routing
  let prompt = `[TRAINING: ${exercise.id}] ${exercise.prompt}`;
  if (attempt > 1 && exercise.hints) {
    prompt += `\n\n💡 INDICE: ${exercise.hints}`;
  }
  prompt += `\n\nRÈGLE: Appelle le tool directement. Ne dis pas ce que tu ferais — FAIS-LE.`;

  const t0 = Date.now();
  let response = "";

  try {
    // Call handleMessage DIRECTLY — no admin queue.
    // ChatId 250 is fully isolated, so no conflict with user messages.
    response = await handleMessage(TRAINER_CHAT_ID, prompt, TRAINER_USER_ID, "scheduler");
  } catch (e) {
    response = `[ERROR] ${(e as Error).message}`;
    log.error(`[trainer] Exercise ${exercise.id} crashed: ${(e as Error).message}`);
  } finally {
    trainerBusy = false;
  }

  const durationMs = Date.now() - t0;
  const { passed, score, reason } = evaluateResponse(exercise, response);

  state.totalAttempts++;
  state.skillsTested.add(exercise.skillName);

  if (score === -1) {
    // Credential missing — not Kingston's fault
    state.totalCredentialMissing++;
    log.info(`[trainer] 🔑 ${exercise.id} — credential missing (${exercise.skillName})`);
  } else if (passed) {
    state.totalPassed++;
    state.skillsPassed.add(exercise.skillName);
    log.info(`[trainer] ✅ ${exercise.id} — score=${score} ${reason} (${durationMs}ms)`);

    // Update COACHING.md
    try {
      if (fs.existsSync(COACHING_FILE)) {
        const coaching = fs.readFileSync(COACHING_FILE, "utf-8");
        const pattern = `- ✅ ${exercise.skillName}: ${response.slice(0, 80).replace(/\n/g, " ")}`;
        if (!coaching.includes(exercise.skillName)) {
          fs.appendFileSync(COACHING_FILE, `\n${pattern}\n`);
        }
      }
    } catch {}
  } else {
    state.totalFailed++;
    const failCount = (state.skillsFailed.get(exercise.skillName) || 0) + 1;
    state.skillsFailed.set(exercise.skillName, failCount);
    log.info(`[trainer] ❌ ${exercise.id} — score=${score} ${reason} (${durationMs}ms)`);
  }

  // Save to DB
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO training_results (task_id, level, category, passed, score, tools_used, response_length, duration_ms, attempt, response_preview)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      exercise.id, 0, exercise.phase,
      passed ? 1 : (score === -1 ? -1 : 0), score,
      exercise.skillName,
      response.length, durationMs, attempt,
      response.slice(0, 500)
    );
  } catch (e) {
    log.debug(`[trainer] DB save: ${(e as Error).message}`);
  }

  // Log result silently (no Telegram spam per exercise)
  notifyTestResultSilent(exercise, passed, score, reason, durationMs);

  return passed;
}

// ── Build Exercise Queue ────────────────────────────────────────

function buildExerciseQueue(): Exercise[] {
  const queue: Exercise[] = [];
  const allSkills = getAllSkills();

  log.info(`[trainer] Building exercise queue from ${allSkills.length} registered skills...`);

  // Phase 1: Dynamic skill exercises (generated from ALL skills)
  let generated = 0;
  for (const skill of allSkills) {
    // Skip already-passed skills
    if (state.skillsPassed.has(skill.name)) continue;
    // Skip skills that failed 3+ times
    if ((state.skillsFailed.get(skill.name) || 0) >= 3) continue;

    const exercise = generateExercise(skill);
    if (exercise) {
      queue.push(exercise);
      generated++;
    }
  }

  // Phase 2: Desktop exercises (curated missions)
  for (const mission of MISSIONS.filter(m => m.phase === "desktop")) {
    if (!state.skillsPassed.has(`mission:${mission.id}`)) {
      queue.push(mission);
    }
  }

  // Phase 3: Browser/research missions
  for (const mission of MISSIONS.filter(m => m.phase === "browser" || m.phase === "missions")) {
    if (!state.skillsPassed.has(`mission:${mission.id}`)) {
      queue.push(mission);
    }
  }

  // Shuffle skill exercises for variety (keep missions in order)
  const skillExercises = queue.filter(e => e.phase === "skills");
  const otherExercises = queue.filter(e => e.phase !== "skills");

  // Fisher-Yates shuffle for skill exercises
  for (let i = skillExercises.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [skillExercises[i], skillExercises[j]] = [skillExercises[j], skillExercises[i]];
  }

  const final = [...skillExercises, ...otherExercises];
  log.info(`[trainer] Queue built: ${generated} skill tests + ${MISSIONS.length} missions = ${final.length} exercises`);
  return final;
}

// ── Training Loop ───────────────────────────────────────────────

async function trainingTick(): Promise<void> {
  if (!state.running) return;

  // Check if queue is exhausted → rebuild
  if (state.queueIndex >= state.exerciseQueue.length) {
    const pct = state.totalAttempts > 0 ? Math.round(state.totalPassed / state.totalAttempts * 100) : 0;

    // Send cycle summary (fire-and-forget)
    notify(
      `📊 Cycle d'entraînement terminé!\n` +
      `✅ ${state.totalPassed} réussis | ❌ ${state.totalFailed} échoués | 🔑 ${state.totalCredentialMissing} credentials manquantes\n` +
      `Skills testés: ${state.skillsTested.size} | Maîtrisés: ${state.skillsPassed.size}\n` +
      `Taux de réussite: ${pct}%\n` +
      `♻️ Reconstruction de la queue...`
    ).catch(() => {});

    // Rebuild queue (will skip passed skills, retry failed ones)
    state.exerciseQueue = buildExerciseQueue();
    state.queueIndex = 0;

    if (state.exerciseQueue.length === 0) {
      notify(`🏆 Tous les skills ont été testés et maîtrisés! Training terminé.`).catch(() => {});
      stopTrainer();
      return;
    }
  }

  const exercise = state.exerciseQueue[state.queueIndex];
  if (!exercise) {
    state.queueIndex++;
    return;
  }

  const attempt = (state.skillsFailed.get(exercise.skillName) || 0) + 1;
  const passed = await executeExercise(exercise, attempt);

  state.queueIndex++;

  // Progress report every 25 exercises (reduced from 5 to avoid spam)
  if (state.totalAttempts > 0 && state.totalAttempts % 25 === 0) {
    const pct = Math.round(state.totalPassed / state.totalAttempts * 100);
    const credMsg = state.totalCredentialMissing > 0 ? ` | 🔑 ${state.totalCredentialMissing} APIs manquantes` : "";
    // Fire-and-forget — don't block training for Telegram delivery
    notify(
      `📊 Training: ${state.totalPassed}/${state.totalAttempts} (${pct}%)${credMsg}\n` +
      `Skills testés: ${state.skillsTested.size} | Maîtrisés: ${state.skillsPassed.size}\n` +
      `Phase: ${exercise.phase} | Prochain: ${state.exerciseQueue[state.queueIndex]?.skillName || "fin de cycle"}`
    ).catch(() => {});
  }
}

// ── Control Functions ───────────────────────────────────────────

export function startTrainer(intervalMs: number = 60_000): string {
  if (state.running) return "Trainer already running.";

  // Create DB table
  try {
    const db = getDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS training_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        level INTEGER NOT NULL DEFAULT 0,
        category TEXT NOT NULL,
        passed INTEGER NOT NULL DEFAULT 0,
        score INTEGER NOT NULL DEFAULT 0,
        tools_used TEXT,
        response_length INTEGER,
        duration_ms INTEGER,
        attempt INTEGER DEFAULT 1,
        response_preview TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `);
  } catch (e) {
    log.error(`[trainer] DB setup: ${(e as Error).message}`);
  }

  // Load prior passes from DB
  const priorPassed = new Set<string>();
  try {
    const db = getDb();
    const rows = db.prepare("SELECT DISTINCT tools_used FROM training_results WHERE passed = 1").all() as Array<{ tools_used: string }>;
    for (const r of rows) {
      if (r.tools_used) priorPassed.add(r.tools_used);
    }
  } catch {}

  state = {
    running: true,
    phase: "skills",
    exerciseQueue: [],
    queueIndex: 0,
    totalAttempts: 0,
    totalPassed: 0,
    totalFailed: 0,
    totalCredentialMissing: 0,
    startedAt: Date.now(),
    skillsTested: new Set(),
    skillsPassed: priorPassed,
    skillsFailed: new Map(),
  };

  // Build initial queue
  state.exerciseQueue = buildExerciseQueue();

  log.info(`[trainer] Starting — ${state.exerciseQueue.length} exercises, interval ${intervalMs / 1000}s, ${priorPassed.size} skills already mastered`);

  const loop = async () => {
    if (!state.running) return;
    // Yield to user messages — don't start exercises while Nicolas is chatting
    if (hasUserTaskPending()) {
      log.debug("[trainer] User activity detected — delaying next exercise");
      if (state.running) state.intervalHandle = setTimeout(loop, 5000);
      return;
    }
    try {
      await trainingTick();
    } catch (e) {
      log.error(`[trainer] Tick error: ${(e as Error).message}`);
    }
    if (state.running) {
      state.intervalHandle = setTimeout(loop, intervalMs);
    }
  };

  state.intervalHandle = setTimeout(loop, 5000);

  return `🏋️ Trainer v2 started! ${state.exerciseQueue.length} exercises (${getAllSkills().length} skills total), ${priorPassed.size} already mastered.\nInterval: ${intervalMs / 1000}s | Notifications Telegram activées.`;
}

export function stopTrainer(): string {
  if (!state.running) return "Trainer not running.";
  state.running = false;
  if (state.intervalHandle) clearTimeout(state.intervalHandle);

  const elapsed = ((Date.now() - state.startedAt) / 1000 / 60).toFixed(1);
  return `🏋️ Training arrêté (${elapsed} min)\n✅ ${state.totalPassed}/${state.totalAttempts} réussis\n🔑 ${state.totalCredentialMissing} credentials manquantes\nSkills maîtrisés: ${state.skillsPassed.size}/${state.skillsTested.size}`;
}

export function getTrainerStatus(): string {
  if (!state.running) {
    try {
      const db = getDb();
      const count = db.prepare("SELECT COUNT(*) as c FROM training_results").get() as { c: number };
      const passed = db.prepare("SELECT COUNT(*) as c FROM training_results WHERE passed = 1").get() as { c: number };
      if (count.c > 0) {
        return `Trainer OFF. Historique: ${passed.c}/${count.c} réussis (${Math.round(passed.c / count.c * 100)}%). Utilise train.start pour reprendre.`;
      }
    } catch {}
    return "Trainer OFF. Utilise train.start pour commencer.";
  }

  const elapsed = ((Date.now() - state.startedAt) / 1000 / 60).toFixed(1);
  const pct = state.totalAttempts > 0 ? Math.round(state.totalPassed / state.totalAttempts * 100) : 0;
  const currentEx = state.exerciseQueue[state.queueIndex];

  return [
    `🏋️ Trainer v2 ACTIF — ${elapsed} min`,
    `Phase: ${state.phase}`,
    `Progrès: ${state.totalPassed}/${state.totalAttempts} (${pct}%)`,
    `Skills testés: ${state.skillsTested.size} | Maîtrisés: ${state.skillsPassed.size}`,
    `🔑 Credentials manquantes: ${state.totalCredentialMissing}`,
    `Queue: ${state.queueIndex}/${state.exerciseQueue.length}`,
    currentEx ? `En cours: ${currentEx.skillName} (${currentEx.phase})` : "Fin de cycle",
  ].join("\n");
}

// ── Register Skills ─────────────────────────────────────────────

registerSkill({
  name: "train.start",
  description: "Start Kingston's autonomous training — tests ALL skills, tracks missing credentials, practices desktop control. Sends Telegram notifications for each passed test.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      interval: { type: "string", description: "Seconds between exercises (default 45)" },
    },
  },
  async execute(args): Promise<string> {
    const intervalSec = Number(args.interval) || 45;
    const result = startTrainer(intervalSec * 1000);
    notify(result).catch(() => {});
    return result;
  },
});

registerSkill({
  name: "train.stop",
  description: "Stop Kingston's autonomous training loop",
  adminOnly: true,
  argsSchema: { type: "object", properties: {} },
  async execute(): Promise<string> {
    const result = stopTrainer();
    notify(result).catch(() => {});
    return result;
  },
});

registerSkill({
  name: "train.status",
  description: "Check Kingston's training progress — skills tested, pass rate, credential gaps",
  adminOnly: true,
  argsSchema: { type: "object", properties: {} },
  async execute(): Promise<string> {
    return getTrainerStatus();
  },
});

registerSkill({
  name: "train.report",
  description: "Generate full training report with per-skill breakdown and missing credentials",
  adminOnly: true,
  argsSchema: { type: "object", properties: {} },
  async execute(): Promise<string> {
    try {
      const db = getDb();
      const results = db.prepare(`
        SELECT task_id, category, passed, score, tools_used, duration_ms, response_preview, created_at
        FROM training_results ORDER BY created_at DESC LIMIT 200
      `).all() as Array<{
        task_id: string; category: string; passed: number;
        score: number; tools_used: string; duration_ms: number;
        response_preview: string; created_at: number;
      }>;

      if (!results.length) return "Aucun résultat. Lance train.start.";

      const lines = ["📊 Rapport d'entraînement Kingston v2", "═══════════════════════════════════", ""];

      // Summary
      const passed = results.filter(r => r.passed === 1).length;
      const failed = results.filter(r => r.passed === 0).length;
      const credMissing = results.filter(r => r.passed === -1).length;
      lines.push(`Total: ${passed} ✅ | ${failed} ❌ | ${credMissing} 🔑`);
      lines.push("");

      // Per-phase summary
      const phases = [...new Set(results.map(r => r.category))];
      for (const phase of phases) {
        const pr = results.filter(r => r.category === phase);
        const pp = pr.filter(r => r.passed === 1).length;
        lines.push(`  ${phase}: ${pp}/${pr.length} (${Math.round(pp / pr.length * 100)}%)`);
      }

      // Missing credentials
      if (credMissing > 0) {
        lines.push("");
        lines.push("🔑 Credentials manquantes:");
        const credSkills = [...new Set(results.filter(r => r.passed === -1).map(r => r.tools_used))];
        for (const s of credSkills) {
          lines.push(`  - ${s}`);
        }
      }

      // Recent exercises
      lines.push("");
      lines.push("Derniers tests:");
      for (const r of results.slice(0, 20)) {
        const icon = r.passed === 1 ? "✅" : r.passed === -1 ? "🔑" : "❌";
        lines.push(`  ${icon} ${r.tools_used || r.task_id} (score=${r.score}, ${(r.duration_ms / 1000).toFixed(1)}s)`);
      }

      // Missing credentials file
      if (fs.existsSync(CREDENTIALS_FILE)) {
        lines.push("");
        lines.push("📋 Voir relay/MISSING_CREDENTIALS.md pour la liste complète des APIs à configurer.");
      }

      return lines.join("\n");
    } catch (e) {
      return `Error: ${(e as Error).message}`;
    }
  },
});

log.debug("Registered 4 train.* skills (start/stop/status/report) + autonomous trainer v2");

// ── Auto-Start ──────────────────────────────────────────────────
// DISABLED by Nicolas 2026-02-14 — too spammy, use train.start manually

// const AUTO_START_DELAY = 30_000;
// const TRAINING_INTERVAL = 45_000; // 45s between exercises

// setTimeout(() => {
//   log.info("[trainer] Auto-starting training v2...");
//   const msg = startTrainer(TRAINING_INTERVAL);
//   notify(`🏋️ ${msg}`).catch(() => {});
// }, AUTO_START_DELAY);
