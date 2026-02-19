/**
 * Tunnel skills — expose local services via Cloudflare Tunnel or ngrok.
 * Also includes SSH remote execution.
 */
import { execSync, spawn, ChildProcess } from "node:child_process";
import { registerSkill } from "../loader.js";
import { log } from "../../utils/log.js";
import { escDQ, isSafeArg } from "../../utils/shell.js";

function run(cmd: string, timeout = 30_000): string {
  return execSync(cmd, { encoding: "utf-8", timeout, maxBuffer: 512 * 1024 }).toString().trim();
}

const activeTunnels = new Map<string, ChildProcess>();

// ── Cloudflare Quick Tunnel ──────────────────────────────────

registerSkill({
  name: "tunnel.cloudflare",
  description: "Create a quick Cloudflare Tunnel to expose a local port. Returns public URL.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      port: { type: "number", description: "Local port to expose" },
      protocol: { type: "string", description: "http | tcp (default http)" },
    },
    required: ["port"],
  },
  async execute(args) {
    const port = args.port as number;
    const protocol = (args.protocol as string) || "http";
    const key = `cf-${port}`;

    if (activeTunnels.has(key)) return `Tunnel already active on port ${port}. Use tunnel.stop to close it.`;

    try {
      const proc = spawn("cloudflared", ["tunnel", "--url", `${protocol}://localhost:${port}`], {
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
        windowsHide: true,
      });

      return new Promise((resolve) => {
        let url = "";
        const timeout = setTimeout(() => {
          if (!url) {
            proc.kill();
            resolve("Timeout waiting for tunnel URL. Is cloudflared installed?");
          }
        }, 15_000);

        const handler = (data: Buffer) => {
          const line = data.toString();
          const match = line.match(/https?:\/\/[^\s]+\.trycloudflare\.com/);
          if (match) {
            url = match[0];
            clearTimeout(timeout);
            activeTunnels.set(key, proc);
            log.info(`[tunnel] Cloudflare tunnel: ${url} -> localhost:${port}`);
            resolve(`Tunnel active: ${url} → localhost:${port}\nUse tunnel.stop with port=${port} to close.`);
          }
        };

        proc.stdout?.on("data", handler);
        proc.stderr?.on("data", handler);
      });
    } catch (err) {
      return `Error: ${(err as Error).message}. Install cloudflared: winget install Cloudflare.cloudflared`;
    }
  },
});

// ── Stop Tunnel ──────────────────────────────────────────────

registerSkill({
  name: "tunnel.stop",
  description: "Stop an active tunnel.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      port: { type: "number", description: "Port of the tunnel to stop" },
    },
    required: ["port"],
  },
  async execute(args) {
    const port = args.port as number;
    const key = `cf-${port}`;
    const proc = activeTunnels.get(key);
    if (!proc) return `No active tunnel on port ${port}.`;
    proc.kill();
    activeTunnels.delete(key);
    return `Tunnel on port ${port} stopped.`;
  },
});

// ── List Tunnels ─────────────────────────────────────────────

registerSkill({
  name: "tunnel.list",
  description: "List active tunnels.",
  argsSchema: { type: "object", properties: {} },
  async execute() {
    if (activeTunnels.size === 0) return "No active tunnels.";
    return Array.from(activeTunnels.keys())
      .map(k => `Active: ${k}`)
      .join("\n");
  },
});

// ── SSH Execute ──────────────────────────────────────────────

registerSkill({
  name: "ssh.exec",
  description: "Execute a command on a remote server via SSH.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      host: { type: "string", description: "SSH host (user@hostname or hostname)" },
      command: { type: "string", description: "Command to execute" },
      port: { type: "number", description: "SSH port (default 22)" },
      keyFile: { type: "string", description: "Path to SSH private key file" },
    },
    required: ["host", "command"],
  },
  async execute(args) {
    const host = args.host as string;
    const command = args.command as string;
    const port = (args.port as number) || 22;
    // Validate host — must be user@host or hostname, no shell metacharacters
    if (/[;&|`$(){}]/.test(host)) return "Error: SSH host contains invalid characters.";
    if (!Number.isInteger(port) || port < 1 || port > 65535) return "Error: invalid port number.";
    const keyOpt = args.keyFile ? ` -i "${escDQ(String(args.keyFile))}"` : "";
    try {
      return run(`ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -p ${port}${keyOpt} "${escDQ(host)}" "${escDQ(command)}"`, 30_000);
    } catch (err) {
      return `SSH Error: ${(err as Error).message.split("\n")[0]}`;
    }
  },
});

// ── WSL Execute ──────────────────────────────────────────────

registerSkill({
  name: "wsl.exec",
  description: "Execute a command in Windows Subsystem for Linux (WSL).",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "Linux command to execute" },
      distro: { type: "string", description: "WSL distribution name (optional)" },
    },
    required: ["command"],
  },
  async execute(args) {
    const command = args.command as string;
    // Validate distro name
    if (args.distro && /[;&|`$(){}]/.test(String(args.distro))) return "Error: distro name contains invalid characters.";
    const distro = args.distro ? ` -d "${escDQ(String(args.distro))}"` : "";
    try {
      return run(`wsl${distro} -- ${command}`, 30_000);
    } catch (err) {
      return `WSL Error: ${(err as Error).message.split("\n")[0]}`;
    }
  },
});

// ── WSL List Distros ─────────────────────────────────────────

registerSkill({
  name: "wsl.list",
  description: "List installed WSL distributions.",
  argsSchema: { type: "object", properties: {} },
  async execute() {
    try {
      return run("wsl --list --verbose", 10_000);
    } catch {
      return "WSL is not installed or no distributions available.";
    }
  },
});
