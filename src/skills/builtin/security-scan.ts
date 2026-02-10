/**
 * Built-in skill: security.scan
 * Scans the project for credential leaks, .gitignore coverage, and common security issues.
 */
import fs from "node:fs";
import path from "node:path";
import { registerSkill } from "../loader.js";

const PROJECT_ROOT = process.cwd();

const CREDENTIAL_PATTERNS = [
  { name: "AWS Key", pattern: /AKIA[0-9A-Z]{16}/ },
  { name: "Generic Secret", pattern: /(?:secret|password|passwd|token|api_key|apikey|auth)\s*[=:]\s*['"][^'"]{8,}['"]/i },
  { name: "Private Key", pattern: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/ },
  { name: "GitHub Token", pattern: /gh[ps]_[A-Za-z0-9_]{36,}/ },
  { name: "Slack Token", pattern: /xox[bpors]-[0-9a-zA-Z-]+/ },
  { name: "JWT", pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: "Base64 Credential", pattern: /(?:Basic|Bearer)\s+[A-Za-z0-9+/=]{20,}/ },
];

const SENSITIVE_FILES = [
  ".env",
  ".env.local",
  ".env.production",
  "credentials.json",
  "token.json",
  "service-account.json",
  "id_rsa",
  "id_ed25519",
  ".htpasswd",
];

function scanFile(filePath: string): string[] {
  const issues: string[] = [];
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      for (const { name, pattern } of CREDENTIAL_PATTERNS) {
        if (pattern.test(lines[i])) {
          issues.push(`  ${path.relative(PROJECT_ROOT, filePath)}:${i + 1} — ${name} detected`);
        }
      }
    }
  } catch {
    // Skip unreadable files
  }
  return issues;
}

function walkDir(dir: string, ext: string[], maxDepth = 4, depth = 0): string[] {
  if (depth > maxDepth) return [];
  const files: string[] = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...walkDir(full, ext, maxDepth, depth + 1));
      } else if (ext.some((e) => entry.name.endsWith(e))) {
        files.push(full);
      }
    }
  } catch {
    // Skip unreadable dirs
  }
  return files;
}

registerSkill({
  name: "security.scan",
  description:
    "Scan the project for credential leaks, missing .gitignore entries, and common security issues. Returns a report.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {},
  },
  async execute(): Promise<string> {
    const sections: string[] = [];

    // 1. Check .gitignore covers sensitive files
    const gitignorePath = path.join(PROJECT_ROOT, ".gitignore");
    const gitignoreContent = fs.existsSync(gitignorePath)
      ? fs.readFileSync(gitignorePath, "utf-8")
      : "";
    const missingGitignore: string[] = [];
    for (const sf of SENSITIVE_FILES) {
      if (!gitignoreContent.includes(sf)) {
        if (fs.existsSync(path.join(PROJECT_ROOT, sf)) ||
            fs.existsSync(path.join(PROJECT_ROOT, "relay", sf)) ||
            fs.existsSync(path.join(PROJECT_ROOT, "relay", "gmail", sf))) {
          missingGitignore.push(sf);
        }
      }
    }
    if (missingGitignore.length > 0) {
      sections.push(`**GITIGNORE GAPS** (${missingGitignore.length}):\n${missingGitignore.map((f) => `  - ${f} exists but not in .gitignore`).join("\n")}`);
    } else {
      sections.push("**GITIGNORE:** OK — sensitive files are covered.");
    }

    // 2. Scan source files for credential patterns
    const srcFiles = walkDir(path.join(PROJECT_ROOT, "src"), [".ts", ".js", ".json"]);
    const credIssues: string[] = [];
    for (const f of srcFiles) {
      credIssues.push(...scanFile(f));
    }
    // Also scan root config files
    for (const f of ["package.json", "tsconfig.json"]) {
      const fp = path.join(PROJECT_ROOT, f);
      if (fs.existsSync(fp)) credIssues.push(...scanFile(fp));
    }
    if (credIssues.length > 0) {
      sections.push(`**CREDENTIAL LEAKS** (${credIssues.length}):\n${credIssues.slice(0, 20).join("\n")}`);
    } else {
      sections.push("**CREDENTIALS:** OK — no leaked secrets in source code.");
    }

    // 3. Check .env exists and has restrictive patterns
    const envPath = path.join(PROJECT_ROOT, ".env");
    if (fs.existsSync(envPath)) {
      const envContent = fs.readFileSync(envPath, "utf-8");
      const keyCount = envContent.split("\n").filter((l) => l.includes("=") && !l.startsWith("#")).length;
      sections.push(`**ENV FILE:** ${keyCount} keys configured.`);
    } else {
      sections.push("**ENV FILE:** Not found (running without .env).");
    }

    // 4. Check for exposed ports
    const portFiles = srcFiles.filter((f) => {
      try {
        const content = fs.readFileSync(f, "utf-8");
        return /\.listen\(\d+/.test(content) || /port\s*[:=]\s*\d+/i.test(content);
      } catch { return false; }
    });
    if (portFiles.length > 0) {
      sections.push(
        `**EXPOSED PORTS** (${portFiles.length} files):\n${portFiles.map((f) => `  - ${path.relative(PROJECT_ROOT, f)}`).join("\n")}`
      );
    }

    // 5. Check node_modules size
    const nmPath = path.join(PROJECT_ROOT, "node_modules");
    if (fs.existsSync(nmPath)) {
      try {
        const entries = fs.readdirSync(nmPath);
        sections.push(`**DEPENDENCIES:** ${entries.length} packages in node_modules.`);
      } catch {
        sections.push("**DEPENDENCIES:** Unable to read node_modules.");
      }
    }

    return `Security Scan Report\n${"=".repeat(40)}\n\n${sections.join("\n\n")}`;
  },
});
