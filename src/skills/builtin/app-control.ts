/**
 * Application control skills — launch, list, close, focus Windows applications.
 * Uses PowerShell + COM for window management.
 */
import { execSync } from "node:child_process";
import { registerSkill } from "../loader.js";
import { log } from "../../utils/log.js";

function ps(cmd: string, timeout = 15_000): string {
  return execSync(`powershell -NoProfile -Command "${cmd.replace(/"/g, '\\"')}"`, {
    encoding: "utf-8",
    timeout,
    maxBuffer: 512 * 1024,
  }).toString().trim();
}

// ── Launch Application ────────────────────────────────────────

registerSkill({
  name: "app.launch",
  description: "Launch an application by name or path. Can open files with their default application.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      target: { type: "string", description: "App name (e.g. 'chrome', 'notepad', 'code'), full path, or file to open" },
      args: { type: "string", description: "Arguments to pass to the application" },
      wait: { type: "boolean", description: "Wait for the app to exit (default false)" },
    },
    required: ["target"],
  },
  async execute(args) {
    const target = args.target as string;
    const appArgs = args.args as string || "";
    const wait = args.wait as boolean || false;

    // Common app aliases
    const aliases: Record<string, string> = {
      chrome: "chrome",
      brave: "brave",
      edge: "msedge",
      firefox: "firefox",
      notepad: "notepad",
      "notepad++": "notepad++",
      code: "code",
      vscode: "code",
      word: "winword",
      excel: "excel",
      powerpoint: "powerpnt",
      outlook: "outlook",
      explorer: "explorer",
      terminal: "wt",
      cmd: "cmd",
      paint: "mspaint",
      calc: "calc",
      snip: "SnippingTool",
      visio: "visio",
      acrobat: "Acrobat",
      teams: "ms-teams",
    };

    const resolved = aliases[target.toLowerCase()] || target;
    const waitFlag = wait ? "-Wait" : "";

    try {
      ps(`Start-Process '${resolved}' ${appArgs ? `'${appArgs}'` : ""} ${waitFlag}`, 10_000);
      return `Launched: ${resolved}${appArgs ? ` with args: ${appArgs}` : ""}`;
    } catch (err) {
      // Try as file path (opens with default app)
      try {
        ps(`Start-Process '${target}'`, 10_000);
        return `Opened: ${target} (with default application)`;
      } catch (err2) {
        return `Error launching '${target}': ${(err2 as Error).message.split("\n")[0]}`;
      }
    }
  },
});

// ── List Running Applications ─────────────────────────────────

registerSkill({
  name: "app.list",
  description: "List running applications with their windows. Shows process name, PID, window title, and memory usage.",
  argsSchema: {
    type: "object",
    properties: {
      filter: { type: "string", description: "Filter by process name or window title" },
      all: { type: "boolean", description: "Show all processes, not just windowed ones (default false)" },
    },
  },
  async execute(args) {
    const filter = args.filter as string;
    const all = args.all as boolean || false;

    if (all) {
      const where = filter ? `| Where-Object { $_.ProcessName -like '*${filter}*' }` : "";
      return ps(`Get-Process ${where} | Sort-Object WorkingSet64 -Descending | Select-Object -First 30 Id, ProcessName, @{N='MemMB';E={[math]::Round($_.WorkingSet64/1MB)}}, @{N='CPU_s';E={[math]::Round($_.CPU,1)}} | Format-Table -AutoSize`);
    }

    const where = filter
      ? `| Where-Object { $_.MainWindowTitle -like '*${filter}*' -or $_.ProcessName -like '*${filter}*' }`
      : "";
    return ps(`Get-Process | Where-Object { $_.MainWindowTitle -ne '' } ${where} | Sort-Object ProcessName | Select-Object Id, ProcessName, @{N='MemMB';E={[math]::Round($_.WorkingSet64/1MB)}}, MainWindowTitle | Format-Table -AutoSize`);
  },
});

// ── Close Application ─────────────────────────────────────────

registerSkill({
  name: "app.close",
  description: "Close an application gracefully by name or PID. Use force=true to kill unresponsive apps.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Process name (e.g. 'chrome', 'WINWORD')" },
      pid: { type: "number", description: "Process ID (alternative to name)" },
      force: { type: "boolean", description: "Force kill (default false — tries graceful close first)" },
    },
  },
  async execute(args) {
    const name = args.name as string;
    const pid = args.pid as number;
    const force = args.force as boolean || false;

    if (!name && !pid) return "Error: provide either name or pid";

    const target = pid ? `-Id ${pid}` : `-Name '${name}'`;
    const forceFlag = force ? "-Force" : "";

    try {
      ps(`Stop-Process ${target} ${forceFlag}`, 10_000);
      return `Closed: ${name || `PID ${pid}`}${force ? " (forced)" : ""}`;
    } catch (err) {
      return `Error: ${(err as Error).message.split("\n")[0]}`;
    }
  },
});

// ── Focus / Bring to Front ────────────────────────────────────

registerSkill({
  name: "app.focus",
  description: "Bring an application window to the foreground by name or partial window title.",
  argsSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Process name or partial window title" },
    },
    required: ["name"],
  },
  async execute(args) {
    const name = args.name as string;
    try {
      const result = ps(`
        Add-Type @'
        using System;
        using System.Runtime.InteropServices;
        public class Win32 {
          [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
          [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
        }
'@
        $proc = Get-Process | Where-Object { $_.MainWindowTitle -like '*${name}*' -or $_.ProcessName -like '*${name}*' } | Select-Object -First 1
        if ($proc -and $proc.MainWindowHandle -ne 0) {
          [Win32]::ShowWindow($proc.MainWindowHandle, 9)
          [Win32]::SetForegroundWindow($proc.MainWindowHandle)
          'Focused: ' + $proc.ProcessName + ' - ' + $proc.MainWindowTitle
        } else { 'No matching window found for: ${name}' }
      `, 10_000);
      return result;
    } catch (err) {
      return `Error: ${(err as Error).message.split("\n")[0]}`;
    }
  },
});

// ── Minimize / Maximize / Restore ─────────────────────────────

registerSkill({
  name: "app.window",
  description: "Minimize, maximize, or restore an application window.",
  argsSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Process name or partial window title" },
      action: { type: "string", description: "minimize | maximize | restore" },
    },
    required: ["name", "action"],
  },
  async execute(args) {
    const name = args.name as string;
    const action = args.action as string;
    const showCmd = action === "minimize" ? 6 : action === "maximize" ? 3 : 9;

    try {
      return ps(`
        Add-Type @'
        using System;
        using System.Runtime.InteropServices;
        public class Win32W {
          [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
        }
'@
        $proc = Get-Process | Where-Object { $_.MainWindowTitle -like '*${name}*' -or $_.ProcessName -like '*${name}*' } | Select-Object -First 1
        if ($proc -and $proc.MainWindowHandle -ne 0) {
          [Win32W]::ShowWindow($proc.MainWindowHandle, ${showCmd})
          '${action}d: ' + $proc.ProcessName + ' - ' + $proc.MainWindowTitle
        } else { 'No matching window found for: ${name}' }
      `, 10_000);
    } catch (err) {
      return `Error: ${(err as Error).message.split("\n")[0]}`;
    }
  },
});
