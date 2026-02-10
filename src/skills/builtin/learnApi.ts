/**
 * Self-learning API integration skills.
 * Kingston can autonomously:
 *   1. Search for API documentation (learn.explore)
 *   2. Read docs, analyze endpoints, generate skill files (learn.api)
 *   3. Store credentials securely in .env (learn.credential)
 *
 * This is the foundation for autonomous capability expansion —
 * Kingston learns new APIs without human intervention.
 *
 * Uses Gemini Flash for analysis (free via Nicolas's credits).
 */
import fs from "node:fs";
import path from "node:path";
import { registerSkill } from "../loader.js";
import { config } from "../../config/env.js";
import { log } from "../../utils/log.js";

const GEMINI_MODEL = "gemini-2.0-flash";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// ─── Helpers ────────────────────────────────────────────────────────

async function askGemini(prompt: string, maxTokens = 4096): Promise<string> {
  if (!config.geminiApiKey) return "Error: GEMINI_API_KEY not configured.";

  const url = `${GEMINI_BASE}/${GEMINI_MODEL}:generateContent?key=${config.geminiApiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: maxTokens },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    return `Error: Gemini ${res.status} — ${err.slice(0, 300)}`;
  }

  const data = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  return data.candidates?.[0]?.content?.parts?.[0]?.text || "Error: no response from Gemini.";
}

/** Fetch a web page and extract readable text (strip HTML tags). */
async function fetchPageText(pageUrl: string): Promise<string> {
  const res = await fetch(pageUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; Kingston/1.0; +https://qplus.plus)",
      Accept: "text/html,application/json,text/plain,*/*",
    },
    signal: AbortSignal.timeout(20000),
  });

  if (!res.ok) return `Error: HTTP ${res.status} ${res.statusText}`;

  const contentType = res.headers.get("content-type") || "";
  const raw = await res.text();

  if (contentType.includes("html")) {
    return raw
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
      .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 30000);
  }

  return raw.slice(0, 30000);
}

/** Clean markdown fences and extract JSON from Gemini output. */
function extractJson(text: string): string {
  return text
    .replace(/^```(?:json|typescript|ts)?\s*/i, "")
    .replace(/```\s*$/g, "")
    .trim();
}

/** Save API analysis for future reference. */
function saveAnalysis(name: string, data: object): void {
  const dir = path.resolve(process.cwd(), "relay", "api-docs");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${name}.json`);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  log.info(`[learn.api] Analysis saved to ${filePath}`);
}

// ─── learn.explore ──────────────────────────────────────────────────

registerSkill({
  name: "learn.explore",
  description:
    "Search the web for API documentation on a given topic. Returns the best documentation URLs found. Use this before learn.api if you don't have a doc URL.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: 'What API to find (e.g. "Reddit API", "Twilio SMS API", "OpenWeather")',
      },
    },
    required: ["query"],
  },
  async execute(args): Promise<string> {
    const query = String(args.query);
    log.info(`[learn.explore] Searching for: ${query}`);

    // Use Brave Search if available, otherwise fall back to Gemini knowledge
    if (config.braveSearchApiKey) {
      try {
        const searchUrl = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query + " API documentation")}&count=8`;
        const res = await fetch(searchUrl, {
          headers: {
            Accept: "application/json",
            "X-Subscription-Token": config.braveSearchApiKey,
          },
          signal: AbortSignal.timeout(10000),
        });

        if (res.ok) {
          const data = (await res.json()) as {
            web?: { results?: Array<{ title: string; url: string; description: string }> };
          };
          const results = data.web?.results || [];
          if (results.length > 0) {
            const formatted = results
              .map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.description.slice(0, 150)}`)
              .join("\n\n");
            return `Found ${results.length} results for "${query}":\n\n${formatted}\n\nUse learn.api with the most relevant URL to generate skills.`;
          }
        }
      } catch (err) {
        log.debug(`[learn.explore] Brave search failed: ${err}`);
      }
    }

    // Fallback: ask Gemini for known API documentation URLs
    const geminiResult = await askGemini(
      `List the best official API documentation URLs for: "${query}"\n\n` +
        `For each, provide:\n` +
        `1. The official documentation URL (must be a real, working URL)\n` +
        `2. What the API does\n` +
        `3. If there's a free tier\n` +
        `4. The signup/API key page URL\n\n` +
        `Format as a numbered list. Be precise with URLs — only list URLs you are confident exist.`,
      2048,
    );

    return `API documentation search for "${query}":\n\n${geminiResult}\n\nUse learn.api with the documentation URL to generate skills.`;
  },
});

// ─── learn.api ──────────────────────────────────────────────────────

registerSkill({
  name: "learn.api",
  description:
    "Autonomously learn a new API: reads documentation, analyzes endpoints, generates a complete Kingston skill file. Provide a documentation URL and API name.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL of the API documentation page" },
      name: {
        type: "string",
        description: 'API name for the skill namespace (e.g. "github", "openweather")',
      },
      goal: {
        type: "string",
        description: "What you want to achieve with this API (optional — helps focus the analysis)",
      },
      pages: {
        type: "string",
        description: "Comma-separated additional doc URLs to fetch (optional — for multi-page docs)",
      },
    },
    required: ["url", "name"],
  },
  async execute(args): Promise<string> {
    const docUrl = String(args.url);
    const name = String(args.name)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
    const goal = args.goal ? String(args.goal) : "";
    const extraPages = args.pages
      ? String(args.pages)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

    if (!name) return "Error: name must contain at least one letter.";

    log.info(`[learn.api] Starting API learning: ${name} from ${docUrl}`);

    // ── Step 1: Fetch documentation ──
    let docText: string;
    try {
      docText = await fetchPageText(docUrl);
    } catch (err) {
      return `Error fetching documentation: ${(err as Error).message}`;
    }

    if (docText.startsWith("Error:")) return `Failed to fetch docs: ${docText}`;
    log.info(`[learn.api] Fetched ${docText.length} chars from main page`);

    // Fetch additional pages if provided
    for (const pageUrl of extraPages.slice(0, 4)) {
      try {
        const extra = await fetchPageText(pageUrl);
        if (!extra.startsWith("Error:")) {
          docText += `\n\n--- Additional page: ${pageUrl} ---\n${extra}`;
          log.info(`[learn.api] Fetched extra page: ${pageUrl} (${extra.length} chars)`);
        }
      } catch {
        /* skip failed pages */
      }
    }

    // Trim combined docs to Gemini context limit
    docText = docText.slice(0, 50000);

    // ── Step 2: Analyze with Gemini ──
    const analysisPrompt =
      `You are an expert API analyst. Read this documentation and extract a structured analysis.\n\n` +
      `${goal ? `FOCUS: The user wants to ${goal}\n\n` : ""}` +
      `Extract:\n` +
      `1. **base_url**: The API base URL (e.g. "https://api.example.com/v1")\n` +
      `2. **auth**: Authentication method — type (api_key / bearer / oauth2 / none), header name, how to get a key\n` +
      `3. **endpoints**: The 5-8 most useful endpoints with method, path, description, parameters, example response\n` +
      `4. **rate_limit**: Rate limiting info\n` +
      `5. **free_tier**: Free tier availability and limits\n` +
      `6. **signup_url**: Where to get API credentials\n` +
      `7. **notes**: Any important gotchas or requirements\n\n` +
      `Respond in JSON format:\n` +
      `{\n` +
      `  "base_url": "...",\n` +
      `  "auth": { "type": "api_key", "header": "Authorization", "prefix": "Bearer ", "env_var": "${name.toUpperCase()}_API_KEY", "signup_url": "..." },\n` +
      `  "endpoints": [\n` +
      `    { "method": "GET", "path": "/search", "description": "...", "params": [{"name":"q","type":"string","required":true}], "response_example": "..." }\n` +
      `  ],\n` +
      `  "rate_limit": "...",\n` +
      `  "free_tier": "...",\n` +
      `  "notes": "..."\n` +
      `}\n\n` +
      `DOCUMENTATION:\n${docText}`;

    log.info(`[learn.api] Analyzing documentation with Gemini...`);
    const rawAnalysis = await askGemini(analysisPrompt, 4096);
    if (rawAnalysis.startsWith("Error:")) return `Analysis failed: ${rawAnalysis}`;

    // Parse analysis JSON
    let analysis: {
      base_url: string;
      auth: { type: string; header: string; prefix?: string; env_var: string; signup_url?: string };
      endpoints: Array<{
        method: string;
        path: string;
        description: string;
        params: Array<{ name: string; type: string; required?: boolean; description?: string }>;
      }>;
      rate_limit?: string;
      free_tier?: string;
      notes?: string;
    };

    try {
      analysis = JSON.parse(extractJson(rawAnalysis));
    } catch {
      // If JSON parse fails, save raw and ask user to review
      saveAnalysis(name, { raw: rawAnalysis, url: docUrl });
      return (
        `Gemini returned non-JSON analysis. Raw output saved to relay/api-docs/${name}.json\n\n` +
        `Raw analysis:\n${rawAnalysis.slice(0, 2000)}\n\n` +
        `Try again with a more specific documentation URL or add a "goal" parameter.`
      );
    }

    // Save analysis for future reference
    saveAnalysis(name, { url: docUrl, analysis, generatedAt: new Date().toISOString() });
    log.info(`[learn.api] Analysis parsed: ${analysis.endpoints?.length || 0} endpoints found`);

    // ── Step 3: Generate skill code ──
    const envVar = analysis.auth?.env_var || `${name.toUpperCase()}_API_KEY`;
    const authHeader = analysis.auth?.header || "Authorization";
    const authPrefix = analysis.auth?.prefix || "";
    const baseUrl = analysis.base_url || "https://api.example.com";

    const endpoints = (analysis.endpoints || []).slice(0, 8);
    if (endpoints.length === 0) {
      return (
        `Analysis found 0 endpoints. The documentation might not contain API reference info.\n\n` +
        `Analysis saved to relay/api-docs/${name}.json\n` +
        `Try providing a more specific API reference URL (not the landing page).`
      );
    }

    // Build skill registrations for each endpoint
    const skillBlocks = endpoints.map((ep) => {
      const skillName = `${name}.${ep.path
        .replace(/^\//, "")
        .replace(/\//g, "_")
        .replace(/[^a-z0-9_]/gi, "")
        .slice(0, 30)
        .toLowerCase()}`;

      const requiredParams = (ep.params || []).filter((p) => p.required);
      const optionalParams = (ep.params || []).filter((p) => !p.required);

      const propsLines = [...requiredParams, ...optionalParams]
        .map(
          (p) =>
            `      ${p.name}: { type: "${p.type === "number" || p.type === "integer" ? "number" : "string"}", description: "${(p.description || p.name).replace(/"/g, '\\"')}" },`,
        )
        .join("\n");

      const requiredLine =
        requiredParams.length > 0
          ? `\n    required: [${requiredParams.map((p) => `"${p.name}"`).join(", ")}],`
          : "";

      // Build query string for GET, body for POST/PUT
      const isGet = ep.method.toUpperCase() === "GET" || ep.method.toUpperCase() === "DELETE";
      let callCode: string;

      if (isGet) {
        const paramEntries = [...requiredParams, ...optionalParams]
          .map((p) => `      if (args.${p.name} !== undefined) params.set("${p.name}", String(args.${p.name}));`)
          .join("\n");
        callCode =
          `    const params = new URLSearchParams();\n` +
          `${paramEntries}\n` +
          `    const qs = params.toString() ? "?" + params.toString() : "";\n` +
          `    const result = await apiCall("${ep.method.toUpperCase()}", \`${ep.path}\${qs}\`);`;
      } else {
        const bodyEntries = [...requiredParams, ...optionalParams]
          .map((p) => `      ...(args.${p.name} !== undefined ? { ${p.name}: args.${p.name} } : {}),`)
          .join("\n");
        callCode =
          `    const body = {\n${bodyEntries}\n    };\n` +
          `    const result = await apiCall("${ep.method.toUpperCase()}", "${ep.path}", body);`;
      }

      return (
        `registerSkill({\n` +
        `  name: "${skillName}",\n` +
        `  description: "${ep.description.replace(/"/g, '\\"').slice(0, 200)}",\n` +
        `  adminOnly: true,\n` +
        `  argsSchema: {\n` +
        `    type: "object",\n` +
        `    properties: {\n${propsLines}\n    },${requiredLine}\n` +
        `  },\n` +
        `  async execute(args): Promise<string> {\n` +
        `${callCode}\n` +
        `    if (result.error) return \`Error: \${result.error}\`;\n` +
        `    return JSON.stringify(result, null, 2).slice(0, 3000);\n` +
        `  },\n` +
        `});`
      );
    });

    const fullCode =
      `/**\n` +
      ` * ${name} API integration — auto-generated by learn.api\n` +
      ` * Source: ${docUrl}\n` +
      ` * Generated: ${new Date().toISOString()}\n` +
      ` */\n` +
      `import { registerSkill } from "../loader.js";\n` +
      `import { log } from "../../utils/log.js";\n` +
      `\n` +
      `const BASE_URL = "${baseUrl}";\n` +
      `const ENV_VAR = "${envVar}";\n` +
      `\n` +
      `async function apiCall(method: string, endpoint: string, body?: unknown): Promise<any> {\n` +
      `  const apiKey = process.env[ENV_VAR] || "";\n` +
      `  if (!apiKey) return { error: \`\${ENV_VAR} not configured in .env\` };\n` +
      `\n` +
      `  const url = \`\${BASE_URL}\${endpoint}\`;\n` +
      `  const headers: Record<string, string> = {\n` +
      `    "Content-Type": "application/json",\n` +
      `    "${authHeader}": \`${authPrefix}\${apiKey}\`,\n` +
      `  };\n` +
      `\n` +
      `  try {\n` +
      `    log.debug(\`[${name}] \${method} \${endpoint}\`);\n` +
      `    const res = await fetch(url, {\n` +
      `      method,\n` +
      `      headers,\n` +
      `      ...(body ? { body: JSON.stringify(body) } : {}),\n` +
      `      signal: AbortSignal.timeout(15000),\n` +
      `    });\n` +
      `\n` +
      `    if (!res.ok) {\n` +
      `      const err = await res.text();\n` +
      `      log.warn(\`[${name}] HTTP \${res.status}: \${err.slice(0, 200)}\`);\n` +
      `      return { error: \`HTTP \${res.status}: \${err.slice(0, 200)}\` };\n` +
      `    }\n` +
      `\n` +
      `    return res.json();\n` +
      `  } catch (err) {\n` +
      `    return { error: \`Request failed: \${(err as Error).message}\` };\n` +
      `  }\n` +
      `}\n` +
      `\n` +
      skillBlocks.join("\n\n") +
      `\n`;

    // ── Step 4: Write skill file ──
    const safeName = name.replace(/[^a-z0-9]/g, "-");
    const skillPath = path.resolve(process.cwd(), `src/skills/custom/${safeName}.ts`);
    const customDir = path.dirname(skillPath);
    if (!fs.existsSync(customDir)) fs.mkdirSync(customDir, { recursive: true });

    fs.writeFileSync(skillPath, fullCode, "utf-8");
    log.info(`[learn.api] Skill file written: ${skillPath}`);

    // ── Step 5: Add import to loader.ts ──
    const loaderPath = path.resolve(process.cwd(), "src/skills/loader.ts");
    const loaderContent = fs.readFileSync(loaderPath, "utf-8");
    const importLine = `  await import("./custom/${safeName}.js");`;

    if (!loaderContent.includes(importLine.trim())) {
      const updated = loaderContent.replace(
        /(\s*log\.info\(`Loaded \$\{registry\.size\})/,
        `\n${importLine}\n$1`,
      );
      fs.writeFileSync(loaderPath, updated, "utf-8");
      log.info(`[learn.api] Added import to loader.ts`);
    }

    // ── Step 6: Summary ──
    const skillNames = endpoints.map(
      (ep) =>
        `${name}.${ep.path
          .replace(/^\//, "")
          .replace(/\//g, "_")
          .replace(/[^a-z0-9_]/gi, "")
          .slice(0, 30)
          .toLowerCase()}`,
    );

    return [
      `## API apprise : ${name}`,
      ``,
      `**Source**: ${docUrl}`,
      `**Fichier**: \`src/skills/custom/${safeName}.ts\``,
      `**Skills générés**: ${skillNames.length}`,
      skillNames.map((s) => `  - \`${s}\``).join("\n"),
      ``,
      `**Auth**: ${analysis.auth?.type || "unknown"} via ${envVar}`,
      `**Free tier**: ${analysis.free_tier || "unknown"}`,
      `**Rate limit**: ${analysis.rate_limit || "unknown"}`,
      analysis.auth?.signup_url ? `**Signup**: ${analysis.auth.signup_url}` : "",
      ``,
      `### Prochaines étapes`,
      `1. Ajoute \`${envVar}=ta_clé\` dans .env (ou utilise learn.credential)`,
      `2. Redémarre le bot (system.restart)`,
      `3. Les skills \`${name}.*\` seront disponibles`,
    ]
      .filter(Boolean)
      .join("\n");
  },
});

// ─── learn.credential ───────────────────────────────────────────────

registerSkill({
  name: "learn.credential",
  description:
    "Store an API key or credential in .env securely. Automatically reloads configuration after saving.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      key: {
        type: "string",
        description: 'Environment variable name (e.g. "REDDIT_API_KEY"). Must be UPPER_SNAKE_CASE.',
      },
      value: {
        type: "string",
        description: "The API key or secret value to store",
      },
      confirm: {
        type: "string",
        description: 'Must be "yes" to confirm writing to .env',
      },
    },
    required: ["key", "value", "confirm"],
  },
  async execute(args): Promise<string> {
    const key = String(args.key).trim();
    const value = String(args.value).trim();
    const confirm = String(args.confirm).toLowerCase();

    if (confirm !== "yes") {
      return `Confirmation required. Call again with confirm="yes" to write ${key} to .env.`;
    }

    // Validate key format
    if (!/^[A-Z][A-Z0-9_]+$/.test(key)) {
      return `Error: key must be UPPER_SNAKE_CASE (e.g. REDDIT_API_KEY). Got: "${key}"`;
    }

    // Block overwriting critical keys
    const protected_keys = ["TELEGRAM_BOT_TOKEN", "ANTHROPIC_API_KEY", "GEMINI_API_KEY"];
    if (protected_keys.includes(key)) {
      return `Error: ${key} is a protected key. Modify it manually in .env.`;
    }

    const envPath = path.resolve(process.cwd(), ".env");
    if (!fs.existsSync(envPath)) {
      return "Error: .env file not found.";
    }

    let envContent = fs.readFileSync(envPath, "utf-8");

    // Check if key already exists
    const regex = new RegExp(`^${key}=.*$`, "m");
    if (regex.test(envContent)) {
      // Update existing key
      envContent = envContent.replace(regex, `${key}=${value}`);
      log.info(`[learn.credential] Updated ${key} in .env`);
    } else {
      // Append new key
      if (!envContent.endsWith("\n")) envContent += "\n";
      envContent += `${key}=${value}\n`;
      log.info(`[learn.credential] Added ${key} to .env`);
    }

    fs.writeFileSync(envPath, envContent, "utf-8");

    // Hot-reload will pick it up via watchEnv(), but also set it immediately
    process.env[key] = value;

    return `${key} saved to .env and loaded into environment. Value: ${value.slice(0, 4)}${"*".repeat(Math.max(0, value.length - 4))}`;
  },
});
