/**
 * Clipboard & automation skills — clipboard read/write, keyboard/mouse simulation, screenshots.
 * Uses PowerShell for Windows API access.
 */
import { execSync } from "node:child_process";
import { registerSkill } from "../loader.js";
import { escPS } from "../../utils/shell.js";

function ps(cmd: string, timeout = 15_000): string {
  return execSync(`powershell -NoProfile -Command "${cmd.replace(/"/g, '\\"')}"`, {
    encoding: "utf-8",
    timeout,
    maxBuffer: 1024 * 1024,
  }).toString().trim();
}

// ── Send Keys ────────────────────────────────────────────────

registerSkill({
  name: "keyboard.send",
  description: "Send keystrokes to the active window. Supports special keys like {ENTER}, {TAB}, {ESC}, ^c (Ctrl+C), %f (Alt+F).",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      keys: { type: "string", description: "Keys to send (SendKeys format: {ENTER}, ^c, %{F4}, etc.)" },
      app: { type: "string", description: "App name to focus first (optional)" },
      delay: { type: "number", description: "Delay in ms before sending (default 500)" },
    },
    required: ["keys"],
  },
  async execute(args) {
    const keys = args.keys as string;
    const app = args.app as string;
    const delay = (args.delay as number) || 500;
    try {
      const safeApp = app ? escPS(app) : "";
      const focusCmd = app ? `
        $proc = Get-Process | Where-Object { $_.MainWindowTitle -like '*${safeApp}*' -or $_.ProcessName -like '*${safeApp}*' } | Select-Object -First 1
        if ($proc) {
          Add-Type @'
          using System; using System.Runtime.InteropServices;
          public class FocusHelper { [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr hWnd); }
'@
          [FocusHelper]::SetForegroundWindow($proc.MainWindowHandle)
        }
      ` : "";
      ps(`
        Add-Type -AssemblyName System.Windows.Forms
        ${focusCmd}
        Start-Sleep -Milliseconds ${Number(delay)}
        [System.Windows.Forms.SendKeys]::SendWait('${escPS(keys)}')
      `);
      return `Sent keys: ${keys}${app ? ` to ${app}` : ""}`;
    } catch (err) {
      return `Error: ${(err as Error).message.split("\n")[0]}`;
    }
  },
});

// ── Mouse Click ──────────────────────────────────────────────

registerSkill({
  name: "mouse.click",
  description: "Move mouse and click at specified coordinates.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      x: { type: "number", description: "X coordinate" },
      y: { type: "number", description: "Y coordinate" },
      button: { type: "string", description: "left | right | middle (default left)" },
      doubleClick: { type: "boolean", description: "Double click (default false)" },
    },
    required: ["x", "y"],
  },
  async execute(args) {
    const x = args.x as number;
    const y = args.y as number;
    const button = (args.button as string) || "left";
    const dbl = args.doubleClick as boolean;
    try {
      const clickFlag = button === "right" ? "0x0008; 0x0010" : button === "middle" ? "0x0020; 0x0040" : "0x0002; 0x0004";
      ps(`
        Add-Type @'
        using System; using System.Runtime.InteropServices;
        public class MouseSim {
          [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
          [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, int dwExtraInfo);
        }
'@
        [MouseSim]::SetCursorPos(${x}, ${y})
        Start-Sleep -Milliseconds 100
        [MouseSim]::mouse_event(${clickFlag}, 0, 0, 0, 0)
        ${dbl ? `Start-Sleep -Milliseconds 100; [MouseSim]::mouse_event(${clickFlag}, 0, 0, 0, 0)` : ""}
      `);
      return `Clicked at (${x}, ${y})${dbl ? " (double)" : ""} [${button}]`;
    } catch (err) {
      return `Error: ${(err as Error).message.split("\n")[0]}`;
    }
  },
});

// ── Screenshot Region ────────────────────────────────────────

registerSkill({
  name: "screenshot.region",
  description: "Take a screenshot of a specific region of the screen.",
  argsSchema: {
    type: "object",
    properties: {
      output: { type: "string", description: "Output file path" },
      x: { type: "number", description: "Left X (default 0)" },
      y: { type: "number", description: "Top Y (default 0)" },
      width: { type: "number", description: "Width (default full screen)" },
      height: { type: "number", description: "Height (default full screen)" },
    },
    required: ["output"],
  },
  async execute(args) {
    const out = (args.output as string).replace(/\\/g, "/");
    const x = (args.x as number) || 0;
    const y = (args.y as number) || 0;
    try {
      const sizeCmd = args.width
        ? `$w = ${args.width}; $h = ${args.height || args.width}`
        : `$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $w = $screen.Width; $h = $screen.Height`;
      ps(`
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        ${sizeCmd}
        $bmp = New-Object System.Drawing.Bitmap($w, $h)
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.CopyFromScreen(${x}, ${y}, 0, 0, [System.Drawing.Size]::new($w, $h))
        $bmp.Save('${out}')
        $g.Dispose(); $bmp.Dispose()
      `, 10_000);
      return `Screenshot saved: ${args.output}`;
    } catch (err) {
      return `Error: ${(err as Error).message.split("\n")[0]}`;
    }
  },
});

// ── Type Text ────────────────────────────────────────────────

registerSkill({
  name: "keyboard.type",
  description: "Type text into the active window (handles special characters better than keyboard.send).",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "Text to type" },
      app: { type: "string", description: "App to focus first (optional)" },
    },
    required: ["text"],
  },
  async execute(args) {
    const text = args.text as string;
    const app = args.app as string;
    try {
      // Use clipboard method for reliable typing
      const safeApp2 = app ? escPS(app) : "";
      const focusCmd = app ? `
        $proc = Get-Process | Where-Object { $_.MainWindowTitle -like '*${safeApp2}*' -or $_.ProcessName -like '*${safeApp2}*' } | Select-Object -First 1
        if ($proc) {
          Add-Type @'
          using System; using System.Runtime.InteropServices;
          public class FH2 { [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr hWnd); }
'@
          [FH2]::SetForegroundWindow($proc.MainWindowHandle)
          Start-Sleep -Milliseconds 300
        }
      ` : "";
      ps(`
        Add-Type -AssemblyName System.Windows.Forms
        ${focusCmd}
        $old = [System.Windows.Forms.Clipboard]::GetText()
        [System.Windows.Forms.Clipboard]::SetText('${escPS(text)}')
        [System.Windows.Forms.SendKeys]::SendWait('^v')
        Start-Sleep -Milliseconds 200
        if ($old) { [System.Windows.Forms.Clipboard]::SetText($old) }
      `);
      return `Typed ${text.length} characters${app ? ` into ${app}` : ""}`;
    } catch (err) {
      return `Error: ${(err as Error).message.split("\n")[0]}`;
    }
  },
});
