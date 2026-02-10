/**
 * Package manager skills — winget and chocolatey for Windows software management.
 */
import { execSync } from "node:child_process";
import { registerSkill } from "../loader.js";
import { isValidPkgName, escDQ } from "../../utils/shell.js";

function run(cmd: string, timeout = 60_000): string {
  return execSync(cmd, {
    encoding: "utf-8",
    timeout,
    maxBuffer: 1024 * 1024,
  }).toString().trim();
}

// ── Winget Search ────────────────────────────────────────────

registerSkill({
  name: "winget.search",
  description: "Search for software packages using winget.",
  argsSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Package name or keyword to search" },
    },
    required: ["query"],
  },
  async execute(args) {
    const query = String(args.query);
    if (!isValidPkgName(query)) return "Error: invalid package query — only alphanumeric, @, ., _, /, - allowed.";
    try {
      return run(`winget search "${escDQ(query)}" --accept-source-agreements`, 30_000);
    } catch (err) {
      return `Error: ${(err as Error).message.split("\n")[0]}`;
    }
  },
});

// ── Winget Install ───────────────────────────────────────────

registerSkill({
  name: "winget.install",
  description: "Install a software package using winget.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Package ID (e.g. 'Mozilla.Firefox', 'Google.Chrome')" },
      version: { type: "string", description: "Specific version (optional)" },
    },
    required: ["id"],
  },
  async execute(args) {
    const id = args.id as string;
    if (!isValidPkgName(id)) return "Error: invalid package ID — only alphanumeric, @, ., _, /, - allowed.";
    const ver = args.version ? ` --version "${escDQ(String(args.version))}"` : "";
    try {
      return run(`winget install "${escDQ(id)}"${ver} --accept-package-agreements --accept-source-agreements`, 120_000);
    } catch (err) {
      return `Error: ${(err as Error).message.split("\n")[0]}`;
    }
  },
});

// ── Winget Uninstall ─────────────────────────────────────────

registerSkill({
  name: "winget.uninstall",
  description: "Uninstall a software package using winget.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Package ID to uninstall" },
    },
    required: ["id"],
  },
  async execute(args) {
    try {
      const uid = String(args.id);
      if (!isValidPkgName(uid)) return "Error: invalid package ID.";
      return run(`winget uninstall "${escDQ(uid)}"`, 60_000);
    } catch (err) {
      return `Error: ${(err as Error).message.split("\n")[0]}`;
    }
  },
});

// ── Winget Upgrade ───────────────────────────────────────────

registerSkill({
  name: "winget.upgrade",
  description: "Upgrade installed packages. Without id, lists available upgrades.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Package ID to upgrade (omit for list)" },
      all: { type: "boolean", description: "Upgrade all packages" },
    },
  },
  async execute(args) {
    try {
      if (args.all) {
        return run("winget upgrade --all --accept-package-agreements --accept-source-agreements", 300_000);
      }
      if (args.id) {
        const upgId = String(args.id);
        if (!isValidPkgName(upgId)) return "Error: invalid package ID.";
        return run(`winget upgrade "${escDQ(upgId)}" --accept-package-agreements --accept-source-agreements`, 120_000);
      }
      return run("winget upgrade --accept-source-agreements", 30_000);
    } catch (err) {
      return `Error: ${(err as Error).message.split("\n")[0]}`;
    }
  },
});

// ── Winget List ──────────────────────────────────────────────

registerSkill({
  name: "winget.list",
  description: "List installed packages managed by winget.",
  argsSchema: {
    type: "object",
    properties: {
      filter: { type: "string", description: "Filter by name (optional)" },
    },
  },
  async execute(args) {
    const filter = args.filter ? ` "${args.filter}"` : "";
    try {
      return run(`winget list${filter} --accept-source-agreements`, 30_000);
    } catch (err) {
      return `Error: ${(err as Error).message.split("\n")[0]}`;
    }
  },
});

// ── Pip Install ──────────────────────────────────────────────

registerSkill({
  name: "pip.install",
  description: "Install Python packages using pip.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      packages: { type: "string", description: "Package(s) to install (space-separated)" },
    },
    required: ["packages"],
  },
  async execute(args) {
    const pkgs = String(args.packages).split(/\s+/);
    for (const pkg of pkgs) {
      if (!isValidPkgName(pkg)) return `Error: invalid package name "${pkg}" — only alphanumeric, @, ., _, /, - allowed.`;
    }
    try {
      return run(`pip install ${pkgs.join(" ")}`, 120_000);
    } catch (err) {
      return `Error: ${(err as Error).message.split("\n")[0]}`;
    }
  },
});

// ── Npm Global Install ───────────────────────────────────────

registerSkill({
  name: "npm.global_install",
  description: "Install npm packages globally.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      packages: { type: "string", description: "Package(s) to install (space-separated)" },
    },
    required: ["packages"],
  },
  async execute(args) {
    const pkgs = String(args.packages).split(/\s+/);
    for (const pkg of pkgs) {
      if (!isValidPkgName(pkg)) return `Error: invalid package name "${pkg}" — only alphanumeric, @, ., _, /, - allowed.`;
    }
    try {
      return run(`npm install -g ${pkgs.join(" ")}`, 120_000);
    } catch (err) {
      return `Error: ${(err as Error).message.split("\n")[0]}`;
    }
  },
});
