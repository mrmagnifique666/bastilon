/**
 * Built-in skill: system.audit — static code analysis.
 * Scans all .ts files under src/ for common issues.
 */
import fs from "node:fs";
import path from "node:path";
import { registerSkill } from "../loader.js";

interface Finding {
  file: string;
  line: number;
  text: string;
}

const rules: { name: string; pattern: RegExp }[] = [
  { name: "console.log", pattern: /console\.log\(/ },
  { name: "TODO/FIXME", pattern: /\b(TODO|FIXME|HACK|XXX)\b/ },
  { name: "empty catch", pattern: /catch\s*\{?\s*\}/ },
  { name: "line >200 chars", pattern: /^.{201,}$/ },
  { name: "explicit any", pattern: /:\s*any\b/ },
];

function scanDir(dir: string): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      results.push(...scanDir(full));
    } else if (entry.name.endsWith(".ts")) {
      results.push(full);
    }
  }
  return results;
}

registerSkill({
  name: "system.audit",
  description: "Scan src/**/*.ts for code quality issues (console.log, TODO, empty catch, long lines, explicit any).",
  argsSchema: {
    type: "object",
    properties: {},
  },
  async execute(): Promise<string> {
    const srcDir = path.resolve("src");
    if (!fs.existsSync(srcDir)) return "Error: src/ directory not found.";

    const files = scanDir(srcDir);
    const findings = new Map<string, Finding[]>();
    for (const rule of rules) findings.set(rule.name, []);

    for (const filePath of files) {
      const content = fs.readFileSync(filePath, "utf-8");
      const lines = content.split("\n");
      const rel = path.relative(process.cwd(), filePath).replace(/\\/g, "/");

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const rule of rules) {
          if (rule.pattern.test(line)) {
            findings.get(rule.name)!.push({
              file: rel,
              line: i + 1,
              text: line.trim().slice(0, 80),
            });
          }
        }
      }
    }

    const sections: string[] = [`Scanned ${files.length} files.\n`];
    let totalIssues = 0;

    for (const [name, items] of findings) {
      if (items.length === 0) continue;
      totalIssues += items.length;
      sections.push(`── ${name} (${items.length}) ──`);
      const top = items.slice(0, 10);
      for (const f of top) {
        sections.push(`  ${f.file}:${f.line}  ${f.text}`);
      }
      if (items.length > 10) sections.push(`  ... and ${items.length - 10} more`);
      sections.push("");
    }

    if (totalIssues === 0) sections.push("No issues found.");
    else sections.unshift(`Total: ${totalIssues} issues.\n`);

    return sections.join("\n");
  },
});
