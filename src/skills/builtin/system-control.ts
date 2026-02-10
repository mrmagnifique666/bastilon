/**
 * OS-level system control skills — services, env vars, disk, startup, installed software.
 * All commands run via PowerShell for maximum Windows compatibility.
 */
import { execSync } from "node:child_process";
import { registerSkill } from "../loader.js";
import { log } from "../../utils/log.js";

const PS_OPTS = { encoding: "utf-8" as const, timeout: 30_000, maxBuffer: 1024 * 1024 };

function ps(cmd: string, timeout = 30_000): string {
  return execSync(`powershell -NoProfile -Command "${cmd.replace(/"/g, '\\"')}"`, {
    ...PS_OPTS,
    timeout,
  }).toString().trim();
}

// ── Services ──────────────────────────────────────────────────

registerSkill({
  name: "system.services",
  description: "List, start, stop, or restart Windows services. Without action, lists running services.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      action: { type: "string", description: "Action: list | start | stop | restart | status" },
      name: { type: "string", description: "Service name (for start/stop/restart/status)" },
      filter: { type: "string", description: "Filter service names (for list)" },
    },
  },
  async execute(args) {
    const action = (args.action as string) || "list";
    const name = args.name as string;
    const filter = args.filter as string;

    switch (action) {
      case "list": {
        const where = filter
          ? `| Where-Object { $_.DisplayName -like '*${filter}*' -or $_.Name -like '*${filter}*' }`
          : "";
        return ps(`Get-Service ${where} | Sort-Object Status,DisplayName | Format-Table -AutoSize Name,Status,DisplayName`);
      }
      case "status":
        if (!name) return "Error: name is required for status";
        return ps(`Get-Service '${name}' | Format-List Name,Status,DisplayName,StartType`);
      case "start":
      case "stop":
      case "restart":
        if (!name) return `Error: name is required for ${action}`;
        try {
          ps(`${action.charAt(0).toUpperCase() + action.slice(1)}-Service '${name}' -Force`, 15_000);
          return `Service '${name}' ${action}ed successfully.`;
        } catch (err) {
          return `Error: ${(err as Error).message.split("\n")[0]}`;
        }
      default:
        return "Unknown action. Use: list, start, stop, restart, status";
    }
  },
});

// ── Environment Variables ─────────────────────────────────────

registerSkill({
  name: "system.env",
  description: "Get or set environment variables. Can target User, Machine, or Process scope.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      action: { type: "string", description: "get | set | list | delete" },
      name: { type: "string", description: "Variable name" },
      value: { type: "string", description: "Value to set (for set action)" },
      scope: { type: "string", description: "User | Machine | Process (default: User)" },
    },
  },
  async execute(args) {
    const action = (args.action as string) || "list";
    const name = args.name as string;
    const value = args.value as string;
    const scope = (args.scope as string) || "User";

    switch (action) {
      case "list":
        return ps(`[Environment]::GetEnvironmentVariables('${scope}') | Format-Table -AutoSize`);
      case "get":
        if (!name) return "Error: name is required";
        return ps(`[Environment]::GetEnvironmentVariable('${name}', '${scope}')`) || "(not set)";
      case "set":
        if (!name || value === undefined) return "Error: name and value are required";
        ps(`[Environment]::SetEnvironmentVariable('${name}', '${value}', '${scope}')`);
        return `Set ${scope}::${name} = ${value}`;
      case "delete":
        if (!name) return "Error: name is required";
        ps(`[Environment]::SetEnvironmentVariable('${name}', $null, '${scope}')`);
        return `Deleted ${scope}::${name}`;
      default:
        return "Unknown action. Use: get, set, list, delete";
    }
  },
});

// ── Disk & Storage ────────────────────────────────────────────

registerSkill({
  name: "system.disk",
  description: "Show disk space, drives, and optionally top-N largest files/folders in a path.",
  argsSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to analyze (optional — shows all drives if omitted)" },
      topN: { type: "number", description: "Show top N largest items (default 10)" },
    },
  },
  async execute(args) {
    const p = args.path as string;
    if (!p) {
      return ps("Get-PSDrive -PSProvider FileSystem | Select-Object Name, @{N='UsedGB';E={[math]::Round($_.Used/1GB,1)}}, @{N='FreeGB';E={[math]::Round($_.Free/1GB,1)}}, Root | Format-Table -AutoSize");
    }
    const n = (args.topN as number) || 10;
    return ps(`Get-ChildItem '${p}' -ErrorAction SilentlyContinue | Sort-Object Length -Descending | Select-Object -First ${n} Name, @{N='SizeMB';E={[math]::Round($_.Length/1MB,2)}}, LastWriteTime | Format-Table -AutoSize`);
  },
});

// ── Installed Software ────────────────────────────────────────

registerSkill({
  name: "system.installed",
  description: "List installed software on this machine. Optionally filter by name.",
  argsSchema: {
    type: "object",
    properties: {
      filter: { type: "string", description: "Filter by name (optional)" },
    },
  },
  async execute(args) {
    const filter = args.filter as string;
    const where = filter
      ? `| Where-Object { $_.DisplayName -like '*${filter}*' }`
      : "";
    return ps(
      `Get-ItemProperty HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*, HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\* -ErrorAction SilentlyContinue ${where} | Where-Object { $_.DisplayName } | Sort-Object DisplayName | Select-Object DisplayName, DisplayVersion | Format-Table -AutoSize`,
      15_000
    );
  },
});

// ── Startup Programs ──────────────────────────────────────────

registerSkill({
  name: "system.startup",
  description: "List or manage Windows startup programs.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      action: { type: "string", description: "list | disable | enable" },
      name: { type: "string", description: "Startup item name (for disable/enable)" },
    },
  },
  async execute(args) {
    const action = (args.action as string) || "list";
    if (action === "list") {
      const reg = ps("Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' | Format-List");
      const tasks = ps("Get-ScheduledTask | Where-Object { $_.Settings.StartWhenAvailable -eq $true -or $_.Triggers.LogonTrigger } | Select-Object TaskName, State | Format-Table -AutoSize");
      return `[Registry Run]\n${reg}\n\n[Scheduled Tasks with Logon Trigger]\n${tasks}`;
    }
    return "Startup enable/disable: use shell.exec with reg.exe or schtasks.exe for specific items.";
  },
});

// ── System Info Extended ──────────────────────────────────────

registerSkill({
  name: "system.info_full",
  description: "Comprehensive system info: CPU, RAM, GPU, OS version, network adapters, uptime.",
  argsSchema: { type: "object", properties: {} },
  async execute() {
    const parts = [
      "=== OS ===",
      ps("(Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, OSArchitecture, LastBootUpTime | Format-List | Out-String).Trim()"),
      "\n=== CPU ===",
      ps("(Get-CimInstance Win32_Processor | Select-Object Name, NumberOfCores, NumberOfLogicalProcessors, MaxClockSpeed | Format-List | Out-String).Trim()"),
      "\n=== RAM ===",
      ps("[math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory/1GB, 1).ToString() + ' GB total'; $os = Get-CimInstance Win32_OperatingSystem; [math]::Round(($os.TotalVisibleMemorySize - $os.FreePhysicalMemory)/1MB, 1).ToString() + ' GB used'"),
      "\n=== GPU ===",
      ps("(Get-CimInstance Win32_VideoController | Select-Object Name, @{N='VRAM_GB';E={[math]::Round($_.AdapterRAM/1GB,1)}}, DriverVersion | Format-List | Out-String).Trim()"),
      "\n=== Network ===",
      ps("Get-NetAdapter | Where-Object Status -eq Up | Select-Object Name, InterfaceDescription, LinkSpeed | Format-Table -AutoSize | Out-String"),
      "\n=== Uptime ===",
      ps("(Get-Date) - (Get-CimInstance Win32_OperatingSystem).LastBootUpTime | Select-Object Days, Hours, Minutes | Format-List | Out-String"),
    ];
    return parts.join("\n");
  },
});
