/**
 * Skill creation/management skills — Kingston can create new skills at runtime.
 * Uses the SKILL.md standard for dynamic skill loading.
 *
 * Skills: skills.create, skills.reload, skills.md_list, skills.list, skills.search, skills.info, skill.forge
 *
 * SANDBOX CONTEXT (available in skill code):
 *   args, fetch, secrets.get("KEY"), telegram.send("msg"),
 *   log, db, JSON, Date, Math, URL, URLSearchParams,
 *   Buffer, TextEncoder, TextDecoder, FormData, Blob,
 *   Headers, Request, Response, setTimeout, clearTimeout, AbortSignal
 */
import fs from "node:fs";
import path from "node:path";
import { registerSkill, getAllSkills, getSkill } from "../loader.js";
import { loadMarkdownSkills, createSkillFile } from "../markdown/loader.js";
import { log } from "../../utils/log.js";

const SKILLS_DIR = path.resolve(process.cwd(), "relay", "skills");

registerSkill({
  name: "skills.create",
  description:
    "Create a new skill dynamically using SKILL.md format, then auto-test it. " +
    "Code runs as async JS with: args, fetch, secrets.get('KEY'), telegram.send('msg'), " +
    "log, db, JSON, Date, Math, URL, Buffer, FormData, setTimeout. " +
    "Set test_args to auto-run a test after creation. Returns test result for feedback loop.",
  argsSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Skill name in namespace.method format (e.g. 'brave.search')" },
      description: { type: "string", description: "What the skill does" },
      args_yaml: {
        type: "string",
        description:
          'YAML args, one per line. Example: \'  query: {type: string, description: "Search query", required: true}\'',
      },
      code: {
        type: "string",
        description:
          "JavaScript code (async context). Must return a string. " +
          "Use secrets.get('API_KEY_NAME') for API keys. Use telegram.send('msg') to notify user.",
      },
      test_args: {
        type: "string",
        description: 'JSON string of test args to auto-run after creation. Example: \'{"query":"test"}\'',
      },
    },
    required: ["name", "description", "code"],
  },
  adminOnly: true,
  async execute(args): Promise<string> {
    const name = String(args.name);
    const description = String(args.description);
    const argsYaml = args.args_yaml ? String(args.args_yaml) : "";
    const code = String(args.code);

    // Validate name format
    if (!name.includes(".") || name.length < 3) {
      return "Error: name must be in namespace.method format (e.g. 'brave.search')";
    }

    // Basic security: block dangerous patterns
    const blocked = ["process.exit", "require(", "import(", "child_process", "eval(", "fs.unlink", "fs.rmdir"];
    for (const pattern of blocked) {
      if (code.includes(pattern)) {
        return `Error: code contains blocked pattern: ${pattern}`;
      }
    }

    try {
      const filePath = createSkillFile(name, description, argsYaml, code);

      // Reload markdown skills to register the new one
      const count = loadMarkdownSkills();
      const lines = [`✅ Skill "${name}" created at ${filePath}`, `${count} markdown skill(s) loaded.`];

      // Auto-test if test_args provided
      if (args.test_args) {
        try {
          const testArgs = JSON.parse(String(args.test_args));
          const skill = getSkill(name);
          if (skill) {
            log.info(`[skills.create] Auto-testing ${name} with: ${JSON.stringify(testArgs)}`);
            const result = await skill.execute(testArgs);
            const preview = result.length > 500 ? result.slice(0, 497) + "..." : result;
            if (result.startsWith("Skill error")) {
              lines.push(`\n❌ TEST FAILED:\n${preview}`);
              lines.push(`\nFix the code and call skills.create again to overwrite.`);
            } else {
              lines.push(`\n✅ TEST PASSED:\n${preview}`);
            }
          }
        } catch (parseErr) {
          lines.push(`\n⚠️ Invalid test_args JSON: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`);
        }
      }

      return lines.join("\n");
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

// ─── skill.forge — AI-powered skill creation from API docs ────────────────

registerSkill({
  name: "skill.forge",
  description:
    "Power tool: Create a complete skill from an API specification. " +
    "Provide the API name, base URL, auth method, and endpoint details. " +
    "Kingston generates the SKILL.md code, writes it, reloads, and tests it. " +
    "For complex APIs, call multiple times (one skill per endpoint). " +
    "Use secrets.get('KEY_NAME') in code for API keys.\n\n" +
    "Example: skill.forge(api_name='brave', base_url='https://api.search.brave.com/res/v1', " +
    "auth_type='header', auth_header='X-Subscription-Token', auth_secret='BRAVE_SEARCH_API_KEY', " +
    "endpoints='[{\"path\":\"/web/search\",\"method\":\"GET\",\"params\":{\"q\":\"query\"},\"skill_name\":\"brave.search\",\"description\":\"Search the web via Brave\"}]')",
  argsSchema: {
    type: "object",
    properties: {
      api_name: { type: "string", description: "API name (e.g. 'brave', 'removebg', 'printful')" },
      base_url: { type: "string", description: "API base URL (e.g. 'https://api.search.brave.com/res/v1')" },
      auth_type: { type: "string", description: "'header' | 'bearer' | 'query' | 'basic' | 'none'" },
      auth_header: { type: "string", description: "Header name for auth (e.g. 'X-Subscription-Token', 'Authorization')" },
      auth_secret: { type: "string", description: "Env var name for the API key (e.g. 'BRAVE_SEARCH_API_KEY')" },
      endpoints: {
        type: "string",
        description:
          "JSON array of endpoint specs. Each: {path, method, params:{argName:queryParam}, skill_name, description, body_template?, response_format?}",
      },
      test_query: { type: "string", description: "Optional test query to validate after creation" },
    },
    required: ["api_name", "base_url", "auth_type", "endpoints"],
  },
  adminOnly: true,
  async execute(args): Promise<string> {
    const apiName = String(args.api_name);
    const baseUrl = String(args.base_url).replace(/\/$/, "");
    const authType = String(args.auth_type || "none");
    const authHeader = String(args.auth_header || "Authorization");
    const authSecret = args.auth_secret ? String(args.auth_secret) : "";

    let endpoints: Array<{
      path: string;
      method: string;
      params: Record<string, string>;
      skill_name: string;
      description: string;
      body_template?: string;
      response_format?: string;
    }>;
    try {
      endpoints = JSON.parse(String(args.endpoints));
    } catch (e) {
      return `Error: Invalid endpoints JSON — ${e instanceof Error ? e.message : String(e)}`;
    }

    if (!Array.isArray(endpoints) || endpoints.length === 0) {
      return "Error: endpoints must be a non-empty JSON array";
    }

    const results: string[] = [];

    for (const ep of endpoints) {
      const skillName = ep.skill_name || `${apiName}.${ep.path.replace(/\//g, "_").replace(/^_/, "")}`;
      const method = (ep.method || "GET").toUpperCase();
      const params = ep.params || {};
      const desc = ep.description || `${apiName} ${ep.path}`;

      // Build args YAML
      const argsYaml = Object.entries(params)
        .map(([argName, queryParam]) =>
          `  ${argName}: {type: string, description: "${queryParam} parameter", required: true}`
        )
        .join("\n");

      // Build auth code
      let authCode = "";
      if (authType === "header" && authSecret) {
        authCode = `headers["${authHeader}"] = secrets.get("${authSecret}");\n`;
      } else if (authType === "bearer" && authSecret) {
        authCode = `headers["Authorization"] = "Bearer " + secrets.get("${authSecret}");\n`;
      } else if (authType === "query" && authSecret) {
        authCode = `url.searchParams.set("key", secrets.get("${authSecret}"));\n`;
      }

      // Build fetch code
      let code: string;
      if (method === "GET") {
        const paramLines = Object.entries(params)
          .map(([argName, queryParam]) =>
            `if (args.${argName}) url.searchParams.set("${queryParam}", String(args.${argName}));`
          )
          .join("\n");

        code = [
          `const url = new URL("${baseUrl}${ep.path}");`,
          paramLines,
          `const headers = {};`,
          authCode,
          `const resp = await fetch(url.toString(), { headers, signal: AbortSignal.timeout(15000) });`,
          `if (!resp.ok) return "API error: " + resp.status + " " + (await resp.text()).slice(0, 500);`,
          `const data = await resp.json();`,
          ep.response_format
            ? `return ${ep.response_format};`
            : `return JSON.stringify(data, null, 2).slice(0, 4000);`,
        ].join("\n");
      } else {
        // POST/PUT/DELETE
        const bodyCode = ep.body_template
          ? `const body = ${ep.body_template};`
          : `const body = args;`;

        code = [
          `const url = new URL("${baseUrl}${ep.path}");`,
          `const headers = { "Content-Type": "application/json" };`,
          authCode,
          bodyCode,
          `const resp = await fetch(url.toString(), { method: "${method}", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });`,
          `if (!resp.ok) return "API error: " + resp.status + " " + (await resp.text()).slice(0, 500);`,
          `const data = await resp.json();`,
          ep.response_format
            ? `return ${ep.response_format};`
            : `return JSON.stringify(data, null, 2).slice(0, 4000);`,
        ].join("\n");
      }

      try {
        const filePath = createSkillFile(skillName, desc, argsYaml, code);
        results.push(`✅ ${skillName} → ${filePath}`);
      } catch (err) {
        results.push(`❌ ${skillName}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Reload all
    const count = loadMarkdownSkills();
    results.push(`\n${count} markdown skill(s) loaded.`);

    // Auto-test first skill if test_query provided
    if (args.test_query && endpoints.length > 0) {
      const firstSkill = getSkill(endpoints[0].skill_name);
      if (firstSkill) {
        try {
          const firstParam = Object.keys(endpoints[0].params || {})[0];
          const testArgs = firstParam ? { [firstParam]: String(args.test_query) } : {};
          const result = await firstSkill.execute(testArgs);
          const preview = result.length > 500 ? result.slice(0, 497) + "..." : result;
          if (result.startsWith("Skill error") || result.startsWith("API error")) {
            results.push(`\n❌ TEST: ${preview}`);
          } else {
            results.push(`\n✅ TEST: ${preview}`);
          }
        } catch (e) {
          results.push(`\n❌ TEST CRASH: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }

    return results.join("\n");
  },
});

// ─── skill.test — test any skill with args ────────────────────────────────

registerSkill({
  name: "skill.test",
  description:
    "Test an existing skill with given arguments and return the result. " +
    "Useful for debugging and verifying skills work correctly.",
  argsSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Skill name to test (e.g. 'brave.search')" },
      test_args: { type: "string", description: 'JSON string of arguments. Example: \'{"query":"hello"}\'' },
    },
    required: ["name"],
  },
  adminOnly: true,
  async execute(args): Promise<string> {
    const name = String(args.name);
    const skill = getSkill(name);
    if (!skill) return `Skill "${name}" not found.`;

    let testArgs: Record<string, unknown> = {};
    if (args.test_args) {
      try {
        testArgs = JSON.parse(String(args.test_args));
      } catch (e) {
        return `Invalid JSON for test_args: ${e instanceof Error ? e.message : String(e)}`;
      }
    }

    try {
      const start = Date.now();
      const result = await skill.execute(testArgs);
      const elapsed = Date.now() - start;
      const preview = result.length > 2000 ? result.slice(0, 1997) + "..." : result;
      const status = result.startsWith("Skill error") || result.startsWith("API error") ? "❌ FAIL" : "✅ PASS";
      return `${status} — ${name} (${elapsed}ms)\n\n${preview}`;
    } catch (e) {
      return `❌ CRASH — ${name}: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

registerSkill({
  name: "skills.reload",
  description: "Reload all SKILL.md files from relay/skills/. Use after editing skill files.",
  argsSchema: { type: "object", properties: {} },
  adminOnly: true,
  async execute(): Promise<string> {
    try {
      const count = loadMarkdownSkills();
      return `Reloaded: ${count} markdown skill(s) loaded from ${SKILLS_DIR}`;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

registerSkill({
  name: "skills.md_list",
  description: "List all SKILL.md files in relay/skills/.",
  argsSchema: { type: "object", properties: {} },
  async execute(): Promise<string> {
    if (!fs.existsSync(SKILLS_DIR)) {
      return "No skills directory found. Create skills with skills.create.";
    }

    const files = fs.readdirSync(SKILLS_DIR).filter((f) => f.endsWith(".skill.md"));
    if (files.length === 0) return "No SKILL.md files found. Create skills with skills.create.";

    return files
      .map((f) => {
        const stat = fs.statSync(path.join(SKILLS_DIR, f));
        const size = `${(stat.size / 1024).toFixed(1)}KB`;
        const date = stat.mtime.toISOString().split("T")[0];
        return `  ${f} (${size}, ${date})`;
      })
      .join("\n");
  },
});

// --- Skill Store lite: list, search, info ---

registerSkill({
  name: "skills.list",
  description:
    "List all registered skills, optionally filtered by namespace. " +
    "Returns skill name, description preview, and admin flag.",
  argsSchema: {
    type: "object",
    properties: {
      namespace: {
        type: "string",
        description: "Filter by namespace prefix (e.g. 'trading', 'moltbook'). Omit for all.",
      },
      admin_only: {
        type: "boolean",
        description: "If true, show only admin skills. If false, show only non-admin. Omit for all.",
      },
    },
  },
  async execute(args): Promise<string> {
    let skills = getAllSkills();

    // Filter by namespace
    if (args.namespace) {
      const ns = String(args.namespace).toLowerCase();
      skills = skills.filter((s) => s.name.toLowerCase().startsWith(ns + ".") || s.name.toLowerCase().startsWith(ns));
    }

    // Filter by admin flag
    if (args.admin_only !== undefined) {
      const wantAdmin = Boolean(args.admin_only);
      skills = skills.filter((s) => Boolean(s.adminOnly) === wantAdmin);
    }

    if (skills.length === 0) {
      return args.namespace
        ? `No skills found in namespace "${args.namespace}".`
        : "No skills registered.";
    }

    // Group by namespace
    const grouped: Record<string, string[]> = {};
    for (const s of skills) {
      const ns = s.name.split(".")[0];
      if (!grouped[ns]) grouped[ns] = [];
      const desc = s.description.length > 60 ? s.description.slice(0, 57) + "..." : s.description;
      const tag = s.adminOnly ? " [admin]" : "";
      grouped[ns].push(`  ${s.name}${tag} — ${desc}`);
    }

    const lines: string[] = [`**${skills.length} skills** (${Object.keys(grouped).length} namespaces)\n`];
    for (const [ns, entries] of Object.entries(grouped).sort((a, b) => a[0].localeCompare(b[0]))) {
      lines.push(`**${ns}.*** (${entries.length})`);
      lines.push(...entries);
    }

    return lines.join("\n");
  },
});

registerSkill({
  name: "skills.search",
  description:
    "Search skills by keyword in name or description. " +
    "Returns matching skills ranked by relevance.",
  argsSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query (keyword or phrase)" },
      limit: { type: "number", description: "Max results (default: 20)" },
    },
    required: ["query"],
  },
  async execute(args): Promise<string> {
    const query = String(args.query).toLowerCase();
    const limit = Math.min(Number(args.limit) || 20, 50);
    const terms = query.split(/\s+/).filter((t) => t.length > 1);

    if (terms.length === 0) return "Please provide a search query.";

    const skills = getAllSkills();
    const scored: Array<{ skill: typeof skills[0]; score: number }> = [];

    for (const s of skills) {
      const nameLower = s.name.toLowerCase();
      const descLower = s.description.toLowerCase();
      let score = 0;

      for (const term of terms) {
        // Exact name match (highest weight)
        if (nameLower === term) score += 10;
        // Name contains term
        else if (nameLower.includes(term)) score += 5;
        // Description contains term
        if (descLower.includes(term)) score += 2;
      }

      // Full query match in description
      if (descLower.includes(query)) score += 3;

      if (score > 0) scored.push({ skill: s, score });
    }

    scored.sort((a, b) => b.score - a.score);
    const results = scored.slice(0, limit);

    if (results.length === 0) {
      return `No skills matching "${args.query}". Try broader terms or use skills.list to browse by namespace.`;
    }

    const lines = results.map((r) => {
      const desc = r.skill.description.length > 80 ? r.skill.description.slice(0, 77) + "..." : r.skill.description;
      const tag = r.skill.adminOnly ? " [admin]" : "";
      return `  ${r.skill.name}${tag} — ${desc}`;
    });

    return `**${results.length} result(s) for "${args.query}":**\n\n${lines.join("\n")}`;
  },
});

registerSkill({
  name: "skills.info",
  description:
    "Get detailed info about a specific skill: full description, args schema, admin flag, and namespace.",
  argsSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Skill name (e.g. 'trading.buy', 'moltbook.post')" },
    },
    required: ["name"],
  },
  async execute(args): Promise<string> {
    const name = String(args.name);
    const skill = getSkill(name);

    if (!skill) {
      // Try fuzzy match
      const all = getAllSkills();
      const nameLower = name.toLowerCase();
      const close = all
        .filter((s) => s.name.toLowerCase().includes(nameLower) || nameLower.includes(s.name.split(".")[1] || ""))
        .slice(0, 5);

      if (close.length > 0) {
        return `Skill "${name}" not found. Did you mean:\n${close.map((s) => `  - ${s.name}`).join("\n")}`;
      }
      return `Skill "${name}" not found. Use skills.search to find skills.`;
    }

    const ns = skill.name.split(".")[0];
    const schema = skill.argsSchema;

    // Extract args info
    let argsInfo = "  (no arguments)";
    const props = schema?.properties || (schema as any)?.properties;
    if (props && typeof props === "object") {
      const required = new Set<string>(
        (schema as any)?.required || (skill as any).required || []
      );
      const entries = Object.entries(props as Record<string, any>);
      if (entries.length > 0) {
        argsInfo = entries
          .map(([k, v]) => {
            const req = required.has(k) ? " *required*" : "";
            const type = v.type || "any";
            const desc = v.description || "";
            return `  - **${k}** (${type}${req}): ${desc}`;
          })
          .join("\n");
      }
    }

    return (
      `**${skill.name}**\n` +
      `Namespace: ${ns}\n` +
      `Admin only: ${skill.adminOnly ? "yes" : "no"}\n\n` +
      `${skill.description}\n\n` +
      `**Arguments:**\n${argsInfo}`
    );
  },
});

// ─── skill.health — health dashboard ──────────────────────────────────────

import { getSkillHealthReport } from "../tool-pipeline.js";

registerSkill({
  name: "skill.health",
  description:
    "Show health status of all skills: success rate, avg duration, broken/degraded skills. " +
    "Helps identify which skills need fixing.",
  argsSchema: {
    type: "object",
    properties: {
      filter: { type: "string", description: "'broken' | 'degraded' | 'all' (default: all)" },
    },
  },
  adminOnly: true,
  async execute(args): Promise<string> {
    const report = getSkillHealthReport();
    if (report.length === 0) return "Pas assez de données (< 2 appels par skill). Utilise Kingston un peu plus et réessaie.";

    const filter = args.filter ? String(args.filter).toLowerCase() : "all";
    const filtered = filter === "all" ? report : report.filter(r => r.health === filter);

    if (filtered.length === 0) return `Aucun skill "${filter}".`;

    const broken = report.filter(r => r.health === "broken").length;
    const degraded = report.filter(r => r.health === "degraded").length;
    const healthy = report.filter(r => r.health === "healthy").length;

    const lines = [
      `**Santé des Skills** (${report.length} skills trackés)`,
      `🔴 ${broken} broken | 🟡 ${degraded} degraded | 🟢 ${healthy} healthy\n`,
    ];

    for (const r of filtered.slice(0, 30)) {
      const emoji = r.health === "broken" ? "🔴" : r.health === "degraded" ? "🟡" : "🟢";
      lines.push(`${emoji} **${r.name}** — ${r.successRate}% success (${r.total} calls, ${r.avgMs}ms avg)${r.lastError ? ` — last error: ${r.lastError}` : ""}`);
    }

    return lines.join("\n");
  },
});
