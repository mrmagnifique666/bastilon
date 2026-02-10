/**
 * Built-in skills: desktop.* and process.*
 * Bastilon OS — system-level interaction with the local machine.
 * Includes: process management, clipboard, notifications, file opening, screenshots.
 */
import { spawn, execSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { registerSkill } from "../loader.js";
import { config } from "../../config/env.js";
import { log } from "../../utils/log.js";
import { escPS, escDQ } from "../../utils/shell.js";

const isWindows = process.platform === "win32";

// ── process.list ────────────────────────────────────────────

registerSkill({
  name: "process.list",
  description: "List running processes on the machine. Returns top processes by memory usage.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      filter: { type: "string", description: "Optional filter by process name (case-insensitive)" },
      limit: { type: "number", description: "Max processes to return (default 20)" },
    },
  },
  async execute(args): Promise<string> {
    const filter = args.filter ? String(args.filter).toLowerCase() : "";
    const limit = Number(args.limit) || 20;

    try {
      let cmd: string;
      if (isWindows) {
        cmd = `powershell -Command "Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First ${limit * 2} Id, ProcessName, @{N='MemMB';E={[math]::Round($_.WorkingSet64/1MB,1)}}, CPU | Format-Table -AutoSize"`;
      } else {
        cmd = `ps aux --sort=-rss | head -${limit + 1}`;
      }

      const output = execSync(cmd, { timeout: 10000, encoding: "utf-8" });
      if (filter) {
        const lines = output.split("\n");
        const header = lines[0] || "";
        const filtered = lines.slice(1).filter((l) => l.toLowerCase().includes(filter));
        return [header, ...filtered.slice(0, limit)].join("\n") || "No matching processes.";
      }
      return output.slice(0, 3000);
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

// ── process.kill ────────────────────────────────────────────

registerSkill({
  name: "process.kill",
  description: "Kill a process by PID or name. Use with caution.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      pid: { type: "number", description: "Process ID to kill" },
      name: { type: "string", description: "Process name to kill (kills all matching)" },
    },
  },
  async execute(args): Promise<string> {
    const pid = args.pid ? Number(args.pid) : null;
    const name = args.name ? String(args.name) : null;

    if (!pid && !name) return "Error: provide either pid or name.";

    // Safety: never kill our own process
    if (pid === process.pid) return "Error: cannot kill the Bastilon process itself.";

    try {
      if (pid) {
        process.kill(pid, "SIGTERM");
        return `Sent SIGTERM to PID ${pid}.`;
      }
      if (name) {
        // Validate process name to prevent injection
        if (!/^[\w.\-]+$/.test(name)) return "Error: process name contains invalid characters.";
        const cmd = isWindows
          ? `taskkill /IM "${escDQ(name)}" /F`
          : `pkill -f "${escDQ(name)}"`;
        const output = execSync(cmd, { timeout: 5000, encoding: "utf-8" });
        return output.trim() || `Killed processes matching "${name}".`;
      }
      return "No action taken.";
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

// ── desktop.open ────────────────────────────────────────────

registerSkill({
  name: "desktop.open",
  description: "Open a file or URL with the default system application (e.g. open a PDF, a .docx, a website).",
  argsSchema: {
    type: "object",
    properties: {
      target: { type: "string", description: "File path or URL to open" },
    },
    required: ["target"],
  },
  async execute(args): Promise<string> {
    const target = String(args.target);

    // Block shell metacharacters in target
    if (/[;&|`$]/.test(target)) return "Error: target contains shell metacharacters.";

    try {
      let cmd: string;
      if (isWindows) {
        cmd = `start "" "${escDQ(target)}"`;
      } else if (process.platform === "darwin") {
        cmd = `open "${escDQ(target)}"`;
      } else {
        cmd = `xdg-open "${escDQ(target)}"`;
      }

      execSync(cmd, { timeout: 5000, shell: isWindows ? "cmd.exe" : "/bin/sh" });
      return `Opened: ${target}`;
    } catch (err) {
      return `Error opening: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

// ── desktop.clipboard.read ──────────────────────────────────

registerSkill({
  name: "desktop.clipboard_read",
  description: "Read the current content of the system clipboard.",
  adminOnly: true,
  argsSchema: { type: "object", properties: {} },
  async execute(): Promise<string> {
    try {
      let cmd: string;
      if (isWindows) {
        cmd = `powershell -Command "Get-Clipboard"`;
      } else if (process.platform === "darwin") {
        cmd = "pbpaste";
      } else {
        cmd = "xclip -selection clipboard -o";
      }

      const output = execSync(cmd, { timeout: 5000, encoding: "utf-8" });
      if (!output.trim()) return "(clipboard is empty)";
      const truncated = output.length > 5000 ? output.slice(0, 5000) + "\n...(truncated)" : output;
      return `Clipboard content:\n${truncated}`;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

// ── desktop.clipboard.write ─────────────────────────────────

registerSkill({
  name: "desktop.clipboard_write",
  description: "Write text to the system clipboard.",
  argsSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "Text to copy to clipboard" },
    },
    required: ["text"],
  },
  async execute(args): Promise<string> {
    const text = String(args.text);

    try {
      if (isWindows) {
        execSync(`powershell -Command "Set-Clipboard -Value '${text.replace(/'/g, "''")}'"`
          , { timeout: 5000 });
      } else if (process.platform === "darwin") {
        const proc = spawn("pbcopy");
        proc.stdin.write(text);
        proc.stdin.end();
      } else {
        const proc = spawn("xclip", ["-selection", "clipboard"]);
        proc.stdin.write(text);
        proc.stdin.end();
      }
      return `Copied ${text.length} chars to clipboard.`;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

// ── desktop.notify ──────────────────────────────────────────

registerSkill({
  name: "desktop.notify",
  description: "Show a desktop notification (Windows toast / macOS notification).",
  argsSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Notification title" },
      message: { type: "string", description: "Notification body text" },
    },
    required: ["title", "message"],
  },
  async execute(args): Promise<string> {
    const title = String(args.title);
    const message = String(args.message);

    try {
      if (isWindows) {
        const ps = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null
$template = '<toast><visual><binding template="ToastGeneric"><text>${escPS(title.replace(/[<>&"]/g, ""))}</text><text>${escPS(message.replace(/[<>&"]/g, ""))}</text></binding></visual></toast>'
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml($template)
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Bastilon').Show($toast)
`.trim();
        execSync(`powershell -Command "${ps.replace(/\n/g, "; ")}"`, { timeout: 10000 });
      } else if (process.platform === "darwin") {
        execSync(`osascript -e 'display notification "${escDQ(message)}" with title "${escDQ(title)}"'`, { timeout: 5000 });
      } else {
        execSync(`notify-send "${escDQ(title)}" "${escDQ(message)}"`, { timeout: 5000 });
      }
      return `Notification sent: "${title}"`;
    } catch (err) {
      return `Notification failed (may need permissions): ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

// ── desktop.screenshot ──────────────────────────────────────

registerSkill({
  name: "desktop.screenshot",
  description: "Take a screenshot of the desktop and save it to the documents folder.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      filename: { type: "string", description: 'Output filename (default: "screenshot.png")' },
    },
  },
  async execute(args): Promise<string> {
    const docsDir = path.resolve(config.sandboxDir, "documents");
    if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir, { recursive: true });

    const filename = path.basename(String(args.filename || "screenshot.png")).replace(/[<>:"/\\|?*]/g, "_");
    const outPath = path.join(docsDir, filename);

    try {
      if (isWindows) {
        // Use Python + Pillow for screenshot
        const script = `
from PIL import ImageGrab
img = ImageGrab.grab()
img.save(${JSON.stringify(outPath)})
print(f"Saved: ${outPath}")
print(f"Size: {img.size[0]}x{img.size[1]}")
`;
        const proc = spawn("python", ["-c", script], { timeout: 10000 });
        let stdout = "";
        let stderr = "";
        proc.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
        proc.stderr.on("data", (c: Buffer) => (stderr += c.toString()));

        return new Promise((resolve) => {
          proc.on("close", (code) => {
            if (code !== 0) resolve(`Error: ${stderr.slice(0, 300)}`);
            else resolve(stdout.trim());
          });
          proc.on("error", (err) => resolve(`Error: ${err.message}`));
        });
      } else if (process.platform === "darwin") {
        execSync(`screencapture -x "${outPath}"`, { timeout: 5000 });
        return `Screenshot saved: ${outPath}`;
      } else {
        execSync(`scrot "${outPath}"`, { timeout: 5000 });
        return `Screenshot saved: ${outPath}`;
      }
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

// ── desktop.system_info ─────────────────────────────────────

registerSkill({
  name: "desktop.system_info",
  description: "Get system information: OS, CPU, RAM, disk, uptime.",
  argsSchema: { type: "object", properties: {} },
  async execute(): Promise<string> {
    const os = await import("node:os");
    const cpus = os.cpus();
    const totalMem = Math.round(os.totalmem() / 1073741824 * 10) / 10;
    const freeMem = Math.round(os.freemem() / 1073741824 * 10) / 10;
    const uptime = Math.round(os.uptime() / 3600 * 10) / 10;

    const lines = [
      `**Bastilon System Info**`,
      `- OS: ${os.type()} ${os.release()} (${os.arch()})`,
      `- Hostname: ${os.hostname()}`,
      `- CPU: ${cpus[0]?.model || "unknown"} (${cpus.length} cores)`,
      `- RAM: ${freeMem} GB free / ${totalMem} GB total`,
      `- Uptime: ${uptime} hours`,
      `- Node: ${process.version}`,
      `- Bastilon PID: ${process.pid}`,
      `- Bastilon uptime: ${Math.round(process.uptime() / 60)} min`,
    ];

    // Disk space (Windows)
    if (isWindows) {
      try {
        const diskInfo = execSync(
          `powershell -Command "Get-PSDrive C | Select-Object @{N='FreeGB';E={[math]::Round($_.Free/1GB,1)}}, @{N='UsedGB';E={[math]::Round($_.Used/1GB,1)}} | Format-List"`,
          { timeout: 5000, encoding: "utf-8" }
        );
        lines.push(`- Disk: ${diskInfo.trim().replace(/\n/g, ", ")}`);
      } catch { /* ignore */ }
    }

    return lines.join("\n");
  },
});

log.debug("Registered 9 desktop/process skills");
