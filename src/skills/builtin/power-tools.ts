/**
 * Power tools — registry, scheduled tasks, power management, Windows features.
 */
import { execSync } from "node:child_process";
import { registerSkill } from "../loader.js";
import { escPS, isSafeArg } from "../../utils/shell.js";

function ps(cmd: string, timeout = 30_000): string {
  return execSync(`powershell -NoProfile -Command "${cmd.replace(/"/g, '\\"')}"`, {
    encoding: "utf-8",
    timeout,
    maxBuffer: 1024 * 1024,
  }).toString().trim();
}

// ── Registry ─────────────────────────────────────────────────

registerSkill({
  name: "registry.read",
  description: "Read a Windows registry key/value.",
  argsSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Registry path (e.g. 'HKCU:\\Software\\Microsoft')" },
      name: { type: "string", description: "Value name (omit to list all values)" },
    },
    required: ["path"],
  },
  async execute(args) {
    const p = args.path as string;
    const name = args.name as string;
    try {
      if (name) {
        return ps(`Get-ItemPropertyValue '${escPS(p)}' -Name '${escPS(name)}'`);
      }
      return ps(`Get-ItemProperty '${escPS(p)}' | Format-List`);
    } catch (err) {
      return `Error: ${(err as Error).message.split("\n")[0]}`;
    }
  },
});

registerSkill({
  name: "registry.write",
  description: "Write a Windows registry value. Use with caution.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Registry path" },
      name: { type: "string", description: "Value name" },
      value: { type: "string", description: "Value to set" },
      type: { type: "string", description: "String | DWord | QWord | Binary | ExpandString | MultiString (default String)" },
    },
    required: ["path", "name", "value"],
  },
  async execute(args) {
    const p = args.path as string;
    const name = args.name as string;
    const value = args.value as string;
    const type = (args.type as string) || "String";
    try {
      if (!isSafeArg(type)) return "Error: invalid registry type.";
      ps(`Set-ItemProperty '${escPS(p)}' -Name '${escPS(name)}' -Value '${escPS(value)}' -Type ${type}`);
      return `Set: ${p}\\${name} = ${value} (${type})`;
    } catch (err) {
      return `Error: ${(err as Error).message.split("\n")[0]}`;
    }
  },
});

// ── Scheduled Tasks ──────────────────────────────────────────

registerSkill({
  name: "task_scheduler.list",
  description: "List Windows scheduled tasks.",
  argsSchema: {
    type: "object",
    properties: {
      filter: { type: "string", description: "Filter by task name" },
      folder: { type: "string", description: "Task folder path (default \\)" },
    },
  },
  async execute(args) {
    const filter = args.filter as string;
    const folder = (args.folder as string) || "\\";
    const where = filter ? `| Where-Object { $_.TaskName -like '*${escPS(filter)}*' }` : "";
    return ps(`Get-ScheduledTask -TaskPath '${escPS(folder)}*' ${where} | Select-Object TaskName, State, @{N='NextRun';E={(Get-ScheduledTaskInfo -TaskName $_.TaskName -ErrorAction SilentlyContinue).NextRunTime}} | Format-Table -AutoSize`);
  },
});

registerSkill({
  name: "task_scheduler.create",
  description: "Create a scheduled task to run a command at a specific time or interval.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Task name" },
      command: { type: "string", description: "Command or script to run" },
      trigger: { type: "string", description: "daily | weekly | once | logon | startup" },
      time: { type: "string", description: "Time (HH:MM for daily/weekly, or full datetime for once)" },
      dayOfWeek: { type: "string", description: "Day for weekly (Monday, Tuesday, etc.)" },
    },
    required: ["name", "command", "trigger"],
  },
  async execute(args) {
    const name = args.name as string;
    const command = args.command as string;
    const trigger = args.trigger as string;
    const time = (args.time as string) || "09:00";

    if (!isSafeArg(name)) return "Error: task name contains invalid characters.";
    const dayOfWeek = String(args.dayOfWeek || "Monday");
    if (!isSafeArg(dayOfWeek)) return "Error: invalid day of week.";

    let triggerCmd: string;
    switch (trigger) {
      case "daily":
        triggerCmd = `New-ScheduledTaskTrigger -Daily -At '${escPS(time)}'`;
        break;
      case "weekly":
        triggerCmd = `New-ScheduledTaskTrigger -Weekly -DaysOfWeek ${dayOfWeek} -At '${escPS(time)}'`;
        break;
      case "once":
        triggerCmd = `New-ScheduledTaskTrigger -Once -At '${escPS(time)}'`;
        break;
      case "logon":
        triggerCmd = `New-ScheduledTaskTrigger -AtLogOn`;
        break;
      case "startup":
        triggerCmd = `New-ScheduledTaskTrigger -AtStartup`;
        break;
      default:
        return "Unknown trigger. Use: daily, weekly, once, logon, startup";
    }

    try {
      ps(`$trigger = ${triggerCmd}; $action = New-ScheduledTaskAction -Execute '${escPS(command)}'; Register-ScheduledTask -TaskName '${escPS(name)}' -Trigger $trigger -Action $action -Force`);
      return `Created scheduled task: ${name} (${trigger}${time ? ` at ${time}` : ""})`;
    } catch (err) {
      return `Error: ${(err as Error).message.split("\n")[0]}`;
    }
  },
});

registerSkill({
  name: "task_scheduler.delete",
  description: "Delete a scheduled task.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Task name to delete" },
    },
    required: ["name"],
  },
  async execute(args) {
    try {
      ps(`Unregister-ScheduledTask -TaskName '${escPS(String(args.name))}' -Confirm:$false`);
      return `Deleted task: ${args.name}`;
    } catch (err) {
      return `Error: ${(err as Error).message.split("\n")[0]}`;
    }
  },
});

// ── Power Management ─────────────────────────────────────────

registerSkill({
  name: "power.action",
  description: "Power management: lock, sleep, hibernate, shutdown, restart. Requires confirmation.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      action: { type: "string", description: "lock | sleep | hibernate | shutdown | restart" },
      delay: { type: "number", description: "Delay in seconds before action (default 0)" },
      confirm: { type: "string", description: "Must be 'yes' to confirm" },
    },
    required: ["action", "confirm"],
  },
  async execute(args) {
    if (args.confirm !== "yes") return "Set confirm='yes' to execute power action.";
    const action = args.action as string;
    const delay = (args.delay as number) || 0;

    const delayCmd = delay > 0 ? `Start-Sleep -Seconds ${delay}; ` : "";
    const commands: Record<string, string> = {
      lock: "rundll32.exe user32.dll,LockWorkStation",
      sleep: `${delayCmd}Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Application]::SetSuspendState('Suspend', $false, $false)`,
      hibernate: `${delayCmd}shutdown /h`,
      shutdown: `${delayCmd}shutdown /s /t 0`,
      restart: `${delayCmd}shutdown /r /t 0`,
    };

    if (!commands[action]) return "Unknown action. Use: lock, sleep, hibernate, shutdown, restart";

    try {
      if (action === "lock") {
        ps(commands[action]);
        return "Workstation locked.";
      }
      // For sleep/hibernate/shutdown/restart, warn first
      ps(commands[action]);
      return `${action} initiated${delay ? ` (in ${delay}s)` : ""}.`;
    } catch (err) {
      return `Error: ${(err as Error).message.split("\n")[0]}`;
    }
  },
});

// ── Battery Info ─────────────────────────────────────────────

registerSkill({
  name: "power.battery",
  description: "Get battery status (charge level, charging state, estimated time).",
  argsSchema: { type: "object", properties: {} },
  async execute() {
    try {
      return ps(`Get-CimInstance Win32_Battery | Select-Object @{N='Charge';E={$_.EstimatedChargeRemaining.ToString()+'%'}}, Status, @{N='RunTime';E={if($_.EstimatedRunTime -lt 71582788){$_.EstimatedRunTime.ToString()+' min'}else{'Charging'}}}, DeviceID | Format-List`);
    } catch {
      return "No battery detected (desktop PC).";
    }
  },
});

// ── Windows Features ─────────────────────────────────────────

registerSkill({
  name: "windows.features",
  description: "List or enable/disable Windows optional features (e.g. WSL, Hyper-V, .NET).",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      action: { type: "string", description: "list | enable | disable" },
      name: { type: "string", description: "Feature name (for enable/disable)" },
      filter: { type: "string", description: "Filter feature names (for list)" },
    },
  },
  async execute(args) {
    const action = (args.action as string) || "list";
    if (action === "list") {
      const filter = args.filter as string;
      const where = filter ? `| Where-Object { $_.FeatureName -like '*${escPS(filter)}*' }` : "";
      return ps(`Get-WindowsOptionalFeature -Online ${where} | Select-Object FeatureName, State | Sort-Object State, FeatureName | Format-Table -AutoSize`, 30_000);
    }
    const name = args.name as string;
    if (!name) return "Error: name is required for enable/disable";
    if (!isSafeArg(name)) return "Error: feature name contains invalid characters.";
    if (action === "enable") {
      ps(`Enable-WindowsOptionalFeature -Online -FeatureName '${escPS(name)}' -NoRestart`, 60_000);
      return `Enabled: ${name}`;
    } else if (action === "disable") {
      ps(`Disable-WindowsOptionalFeature -Online -FeatureName '${escPS(name)}' -NoRestart`, 60_000);
      return `Disabled: ${name}`;
    }
    return "Unknown action. Use: list, enable, disable";
  },
});
