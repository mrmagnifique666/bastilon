/**
 * Built-in skill: computer.use — Full desktop Computer Use Agent.
 *
 * Autonomous vision-based desktop control loop:
 *   Screenshot (full desktop) → Gemini vision analysis → Action (mouse/keyboard) → Repeat
 *
 * Unlike browser.computer_use which only controls a Playwright browser,
 * this controls the ENTIRE desktop — any app, any window, any dialog.
 * Uses Win32 API via PowerShell for mouse/keyboard at the OS level.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { registerSkill } from "../loader.js";
import { config } from "../../config/env.js";
import { log } from "../../utils/log.js";
import { escPS } from "../../utils/shell.js";

// ── Helpers ──────────────────────────────────────────────────

/** Run a PowerShell script via temp .ps1 file (robust — avoids cmd.exe quoting issues). */
function psFile(script: string, timeout = 15_000): string {
  const scriptPath = path.join(os.tmpdir(), `kingston_ps_${Date.now()}.ps1`);
  try {
    fs.writeFileSync(scriptPath, script, "utf-8");
    return execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`, {
      encoding: "utf-8",
      timeout,
      maxBuffer: 2 * 1024 * 1024,
    }).toString().trim();
  } finally {
    try { fs.unlinkSync(scriptPath); } catch { /* ignore */ }
  }
}

/** Run a short inline PowerShell command (for single-liners). */
function ps(cmd: string, timeout = 15_000): string {
  return psFile(cmd, timeout);
}

/** Take a full desktop screenshot spanning ALL monitors and return the file path.
 *  Captures each monitor separately then composites — avoids GDI+ large bitmap bug. */
function takeDesktopScreenshot(): string {
  const screenshotPath = path.join(os.tmpdir(), `kingston_cu_${Date.now()}.png`);
  const savePath = screenshotPath.replace(/\\/g, "\\\\");
  psFile(`
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$screens = [System.Windows.Forms.Screen]::AllScreens
$minX = ($screens | ForEach-Object { $_.Bounds.X } | Measure-Object -Minimum).Minimum
$minY = ($screens | ForEach-Object { $_.Bounds.Y } | Measure-Object -Minimum).Minimum
$maxX = ($screens | ForEach-Object { $_.Bounds.X + $_.Bounds.Width } | Measure-Object -Maximum).Maximum
$maxY = ($screens | ForEach-Object { $_.Bounds.Y + $_.Bounds.Height } | Measure-Object -Maximum).Maximum
$totalW = $maxX - $minX
$totalH = $maxY - $minY

# Capture each monitor separately then composite (avoids GDI+ large bitmap crash)
$bmp = New-Object System.Drawing.Bitmap([int]$totalW, [int]$totalH, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::Black)
foreach ($scr in $screens) {
  $b = $scr.Bounds
  $monBmp = New-Object System.Drawing.Bitmap([int]$b.Width, [int]$b.Height)
  $monG = [System.Drawing.Graphics]::FromImage($monBmp)
  $monG.CopyFromScreen($b.X, $b.Y, 0, 0, (New-Object System.Drawing.Size($b.Width, $b.Height)))
  $monG.Dispose()
  $g.DrawImage($monBmp, [int]($b.X - $minX), [int]($b.Y - $minY))
  $monBmp.Dispose()
}
$bmp.Save('${savePath}')
$g.Dispose(); $bmp.Dispose()
Write-Host "$totalW x $totalH"
  `.trim(), 15_000);

  if (!fs.existsSync(screenshotPath)) {
    throw new Error(`Screenshot file not created at ${screenshotPath}`);
  }
  return screenshotPath;
}

/** Take a screenshot of a specific screen region. */
function takeRegionScreenshot(x: number, y: number, w: number, h: number): string {
  const screenshotPath = path.join(os.tmpdir(), `kingston_cu_region_${Date.now()}.png`);
  const savePath = screenshotPath.replace(/\\/g, "\\\\");
  psFile(`
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap(${w}, ${h})
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen(${x}, ${y}, 0, 0, (New-Object System.Drawing.Size(${w}, ${h})))
$bmp.Save('${savePath}')
$g.Dispose(); $bmp.Dispose()
  `.trim(), 10_000);
  if (!fs.existsSync(screenshotPath)) {
    throw new Error(`Region screenshot failed`);
  }
  return screenshotPath;
}

/** Get info about all monitors. */
function getScreenInfo(): { screens: Array<{ x: number; y: number; w: number; h: number; primary: boolean }>; totalW: number; totalH: number } {
  const raw = psFile(`
Add-Type -AssemblyName System.Windows.Forms
$screens = [System.Windows.Forms.Screen]::AllScreens
foreach ($s in $screens) {
  $b = $s.Bounds
  Write-Host "$($b.X),$($b.Y),$($b.Width),$($b.Height),$($s.Primary)"
}
  `.trim(), 5_000);
  const screens = raw.split("\n").filter(Boolean).map(line => {
    const [x, y, w, h, primary] = line.trim().split(",");
    return { x: +x, y: +y, w: +w, h: +h, primary: primary === "True" };
  });
  const totalW = Math.max(...screens.map(s => s.x + s.w)) - Math.min(...screens.map(s => s.x));
  const totalH = Math.max(...screens.map(s => s.y + s.h)) - Math.min(...screens.map(s => s.y));
  return { screens, totalW, totalH };
}

/** Move mouse and click at coordinates. */
function mouseClick(x: number, y: number, button: "left" | "right" | "middle" = "left", doubleClick = false): void {
  const downFlag = button === "right" ? "0x0008" : button === "middle" ? "0x0020" : "0x0002";
  const upFlag = button === "right" ? "0x0010" : button === "middle" ? "0x0040" : "0x0004";
  const repeatBlock = doubleClick
    ? `Start-Sleep -Milliseconds 100\n[CUMouse]::mouse_event(${downFlag}, 0, 0, 0, 0)\n[CUMouse]::mouse_event(${upFlag}, 0, 0, 0, 0)`
    : "";
  ps(`
Add-Type @'
using System; using System.Runtime.InteropServices;
public class CUMouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, int dwExtraInfo);
}
'@
[CUMouse]::SetCursorPos(${x}, ${y})
Start-Sleep -Milliseconds 100
[CUMouse]::mouse_event(${downFlag}, 0, 0, 0, 0)
[CUMouse]::mouse_event(${upFlag}, 0, 0, 0, 0)
${repeatBlock}
  `);
}

/** Scroll at coordinates. */
function mouseScroll(x: number, y: number, direction: "up" | "down", amount: number): void {
  const delta = direction === "up" ? 120 * amount : -120 * amount;
  ps(`
    Add-Type @'
    using System; using System.Runtime.InteropServices;
    public class CUScroll {
      [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
      [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, int dwExtraInfo);
    }
'@
    [CUScroll]::SetCursorPos(${x}, ${y})
    Start-Sleep -Milliseconds 100
    [CUScroll]::mouse_event(0x0800, 0, 0, ${delta}, 0)
  `);
}

/** Send keystrokes. */
function sendKeys(keys: string): void {
  ps(`
    Add-Type -AssemblyName System.Windows.Forms
    Start-Sleep -Milliseconds 200
    [System.Windows.Forms.SendKeys]::SendWait('${escPS(keys)}')
  `);
}

/** Type text via clipboard (reliable for special characters). */
function typeText(text: string): void {
  ps(`
    Add-Type -AssemblyName System.Windows.Forms
    $old = [System.Windows.Forms.Clipboard]::GetText()
    [System.Windows.Forms.Clipboard]::SetText('${escPS(text)}')
    [System.Windows.Forms.SendKeys]::SendWait('^v')
    Start-Sleep -Milliseconds 200
    if ($old) { [System.Windows.Forms.Clipboard]::SetText($old) }
  `);
}

/** Focus a window by name. */
function focusWindow(name: string): void {
  ps(`
    Add-Type @'
    using System; using System.Runtime.InteropServices;
    public class CUFocus {
      [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
      [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    }
'@
    $proc = Get-Process | Where-Object { $_.MainWindowTitle -like '*${escPS(name)}*' -or $_.ProcessName -like '*${escPS(name)}*' } | Select-Object -First 1
    if ($proc -and $proc.MainWindowHandle -ne [IntPtr]::Zero) {
      [CUFocus]::ShowWindow($proc.MainWindowHandle, 9)
      [CUFocus]::SetForegroundWindow($proc.MainWindowHandle)
    }
  `);
}

/** Open a file/URL/application (sanitized). */
function openItem(target: string): void {
  // Sanitize: strip dangerous shell chars to prevent command injection
  const safe = target.replace(/[&|;<>`$]/g, "");
  execSync(`start "" "${safe}"`, { shell: "cmd.exe", timeout: 10_000 });
}

/** Drag from one coordinate to another. */
function mouseDrag(fromX: number, fromY: number, toX: number, toY: number): void {
  ps(`
Add-Type @'
using System; using System.Runtime.InteropServices;
public class CUDrag {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, int dwExtraInfo);
}
'@
[CUDrag]::SetCursorPos(${fromX}, ${fromY})
Start-Sleep -Milliseconds 200
[CUDrag]::mouse_event(0x0002, 0, 0, 0, 0)
Start-Sleep -Milliseconds 100
[CUDrag]::SetCursorPos(${toX}, ${toY})
Start-Sleep -Milliseconds 200
[CUDrag]::mouse_event(0x0004, 0, 0, 0, 0)
  `);
}

/** Send complex hotkey combinations (e.g., "ctrl+shift+t", "alt+tab", "win+d"). */
function sendHotkey(keys: string): void {
  // Parse combo like "ctrl+shift+t" → hold ctrl, hold shift, press t, release
  const parts = keys.toLowerCase().split("+").map(k => k.trim());
  const modifiers: string[] = [];
  let mainKey = "";

  for (const p of parts) {
    if (["ctrl", "control"].includes(p)) modifiers.push("^");
    else if (["alt"].includes(p)) modifiers.push("%");
    else if (["shift"].includes(p)) modifiers.push("+");
    else if (["win", "windows", "super"].includes(p)) {
      // Win key needs special handling via keybd_event
      ps(`
Add-Type @'
using System; using System.Runtime.InteropServices;
public class CUWinKey {
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, int dwExtraInfo);
}
'@
[CUWinKey]::keybd_event(0x5B, 0, 0, 0)
Start-Sleep -Milliseconds 50
      `);
      // After pressing win, we'll send the key and release
      const remaining = parts.filter(x => !["win", "windows", "super"].includes(x));
      if (remaining.length > 0) {
        sendKeys(remaining.join(""));
      }
      ps(`
Add-Type @'
using System; using System.Runtime.InteropServices;
public class CUWinKeyUp {
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, int dwExtraInfo);
}
'@
[CUWinKeyUp]::keybd_event(0x5B, 0, 2, 0)
      `);
      return;
    }
    else mainKey = p;
  }

  // Map special key names
  const specialKeys: Record<string, string> = {
    tab: "{TAB}", enter: "{ENTER}", escape: "{ESC}", esc: "{ESC}",
    backspace: "{BS}", delete: "{DEL}", home: "{HOME}", end: "{END}",
    pageup: "{PGUP}", pagedown: "{PGDN}",
    up: "{UP}", down: "{DOWN}", left: "{LEFT}", right: "{RIGHT}",
    space: " ", f1: "{F1}", f2: "{F2}", f3: "{F3}", f4: "{F4}",
    f5: "{F5}", f6: "{F6}", f7: "{F7}", f8: "{F8}", f9: "{F9}",
    f10: "{F10}", f11: "{F11}", f12: "{F12}",
    a: "a", b: "b", c: "c", d: "d", e: "e", f: "f", g: "g", h: "h",
    i: "i", j: "j", k: "k", l: "l", m: "m", n: "n", o: "o", p: "p",
    q: "q", r: "r", s: "s", t: "t", u: "u", v: "v", w: "w", x: "x",
    y: "y", z: "z",
  };

  const mappedKey = specialKeys[mainKey] || mainKey;
  const combo = modifiers.join("") + "(" + mappedKey + ")";
  sendKeys(combo);
}

/** Get active window title. */
function getActiveWindow(): string {
  try {
    return ps(`
      Add-Type @'
      using System; using System.Runtime.InteropServices; using System.Text;
      public class CUActiveWin {
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
      }
'@
      $sb = New-Object System.Text.StringBuilder(256)
      $hwnd = [CUActiveWin]::GetForegroundWindow()
      [CUActiveWin]::GetWindowText($hwnd, $sb, 256) | Out-Null
      $sb.ToString()
    `);
  } catch {
    return "(unknown)";
  }
}

// ── Vision types ─────────────────────────────────────────────

type CUAction =
  | { action: "click"; x: number; y: number }
  | { action: "double_click"; x: number; y: number }
  | { action: "right_click"; x: number; y: number }
  | { action: "type"; text: string }
  | { action: "key"; key: string }
  | { action: "scroll"; x: number; y: number; direction: "up" | "down"; amount: number }
  | { action: "focus"; window: string }
  | { action: "open"; target: string }
  | { action: "drag"; fromX: number; fromY: number; toX: number; toY: number }
  | { action: "hotkey"; keys: string }
  | { action: "wait"; seconds: number }
  | { action: "done"; summary: string };

function parseCUAction(raw: string): CUAction | null {
  try {
    const jsonMatch = raw.match(/\{[^{}]*"action"\s*:\s*"[^"]+?"[^{}]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]) as CUAction;
  } catch {
    return null;
  }
}

const DESKTOP_VISION_PROMPT = `You are controlling a Windows 11 desktop with MULTIPLE MONITORS. The screenshot shows ALL screens side by side.
The coordinate system spans the full virtual desktop (e.g., 7680x1080 for two 4K monitors).
You can interact with ANY application, window, dialog, or system element visible on ANY monitor.

Respond with EXACTLY ONE JSON action, nothing else. Available actions:
{"action":"click","x":<int>,"y":<int>}
{"action":"double_click","x":<int>,"y":<int>}
{"action":"right_click","x":<int>,"y":<int>}
{"action":"type","text":"<string>"}        — types text into focused field (via clipboard paste)
{"action":"key","key":"<Enter|Tab|Escape|Backspace|Delete|F1-F12|Home|End|PageUp|PageDown|ArrowUp|ArrowDown|ArrowLeft|ArrowRight>"}
{"action":"scroll","x":<int>,"y":<int>,"direction":"up|down","amount":<1-10>}
{"action":"focus","window":"<partial window title or process name>"}
{"action":"open","target":"<file path, URL, or application name>"}
{"action":"drag","fromX":<int>,"fromY":<int>,"toX":<int>,"toY":<int>}
{"action":"hotkey","keys":"<modifier+key, e.g. ctrl+shift+t, alt+tab, win+d>"}
{"action":"wait","seconds":<1-5>}
{"action":"done","summary":"<what was accomplished>"}

IMPORTANT RULES:
- The screenshot spans ALL monitors. Left monitor pixels are 0-3839, right monitor is 3840-7679.
- Click precisely on buttons/links — aim for the center of clickable elements.
- Before typing, make sure the correct field is focused (click on it first if needed).
- Use "hotkey" for complex keyboard shortcuts (e.g., alt+tab, ctrl+shift+t, win+d).
- Use "key" for simple keys (Enter, Tab, Escape, etc.).
- Use "drag" to drag elements from one position to another.
- Use "focus" to switch between windows if you need a different app.
- Use "open" to launch applications or open files/URLs.
- Use "wait" if a page/app is still loading.
- Report "done" when the goal is achieved or you're certain you cannot proceed.
- Be FAST — prefer direct actions over unnecessary waits. Complete the goal in as few steps as possible.

Active window: `;

// ── Bot integration ──────────────────────────────────────────

let _botPhotoFn: ((chatId: number, photo: Buffer, caption?: string) => Promise<void>) | null = null;

export function setBotPhotoFnForCU(fn: (chatId: number, photo: Buffer, caption?: string) => Promise<void>): void {
  _botPhotoFn = fn;
}

// ── Main skill ───────────────────────────────────────────────

registerSkill({
  name: "computer.use",
  description:
    "Full desktop Computer Use Agent. Give a goal and Kingston autonomously takes screenshots, analyzes them with AI vision, and controls mouse/keyboard to accomplish the goal — on ANY application, not just the browser. Examples: 'Open Word and write a letter', 'Go to facebook.com and post a message', 'Open the calculator and compute 15*23'.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      goal: { type: "string", description: "What to accomplish on the desktop" },
      app: { type: "string", description: "Optional: app to focus/open before starting" },
      chatId: { type: "string", description: "Telegram chat ID for screenshot updates" },
      maxSteps: { type: "string", description: "Max iterations (default 8)" },
      quiet: { type: "string", description: "Set to 'true' to skip sending screenshots to Telegram" },
    },
    required: ["goal"],
  },
  async execute(args): Promise<string> {
    const goal = args.goal as string;
    const app = args.app as string | undefined;
    const chatId = Number(args.chatId) || config.adminChatId;
    const maxSteps = Number(args.maxSteps) || 8;
    const quiet = args.quiet === "true";

    // ── Smart redirect: web goals → site.act (50x faster via Chrome CDP) ──
    const WEB_PATTERN = /facebook|instagram|google|twitter|linkedin|moltbook|website|browser|web\s?page|poster?\s+(sur|on)|publier?\s+(sur|on)|search|chercher|comment(er)?\s+(sur|on)/i;
    if (WEB_PATTERN.test(goal) && !app) {
      try {
        const { getSkill } = await import("../loader.js");
        const siteAct = getSkill("site.act");
        if (siteAct) {
          log.info(`[computer.use] Redirecting web goal to site.act: "${goal}"`);
          return await siteAct.execute({ goal, chatId: String(chatId) });
        }
      } catch (err) {
        log.warn(`[computer.use] site.act redirect failed, falling back to vision: ${err}`);
      }
    }

    if (!config.geminiApiKey) {
      return "Error: GEMINI_API_KEY required for desktop computer use (vision analysis).";
    }

    log.info(`[computer.use] Starting: "${goal}" (max ${maxSteps} steps)`);

    // Focus/open app if specified
    if (app) {
      try {
        focusWindow(app);
        await new Promise(r => setTimeout(r, 500));
      } catch {
        try { openItem(app); await new Promise(r => setTimeout(r, 2000)); } catch { /* ignore */ }
      }
    }

    const steps: string[] = [];
    const screenshotFiles: string[] = [];

    try {
      for (let step = 1; step <= maxSteps; step++) {
        // 1. Take desktop screenshot
        let screenshotPath: string;
        try {
          screenshotPath = takeDesktopScreenshot();
          screenshotFiles.push(screenshotPath);
        } catch (err) {
          steps.push(`Step ${step}: Screenshot failed: ${err instanceof Error ? err.message : String(err)}`);
          break;
        }

        const screenshotBuffer = fs.readFileSync(screenshotPath);
        const base64 = screenshotBuffer.toString("base64");

        // Send screenshot to Telegram (unless quiet mode)
        if (!quiet && _botPhotoFn && chatId > 0) {
          try {
            await _botPhotoFn(chatId, screenshotBuffer, `🖥️ Step ${step}/${maxSteps}`);
          } catch (err) {
            log.debug(`[computer.use] Failed to send screenshot: ${err}`);
          }
        }

        // 2. Get active window context and screen info
        const activeWin = getActiveWindow();
        let screenCtx = "";
        try {
          const si = getScreenInfo();
          screenCtx = `\nScreen layout: ${si.totalW}x${si.totalH} (${si.screens.length} monitors: ${si.screens.map((s, i) => `Monitor ${i+1}: ${s.w}x${s.h} at (${s.x},${s.y})${s.primary ? " [PRIMARY]" : ""}`).join(", ")})`;
        } catch { /* ignore */ }

        // 3. Ask Gemini vision for next action (with 30s timeout to prevent hangs)
        let actionText: string;
        try {
          const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${config.geminiApiKey}`;
          const abortCtrl = new AbortController();
          const fetchTimeout = setTimeout(() => abortCtrl.abort(), 15_000);
          const geminiRes = await fetch(geminiUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: abortCtrl.signal,
            body: JSON.stringify({
              contents: [{
                parts: [
                  { inline_data: { mime_type: "image/png", data: base64 } },
                  { text: DESKTOP_VISION_PROMPT + activeWin + screenCtx + "\n\nGoal: " + goal + (steps.length > 0 ? "\n\nPrevious steps:\n" + steps.slice(-5).join("\n") : "") },
                ],
              }],
              generationConfig: { maxOutputTokens: 400, temperature: 0.1 },
            }),
          });
          clearTimeout(fetchTimeout);

          if (!geminiRes.ok) {
            const errText = await geminiRes.text();
            throw new Error(`Gemini ${geminiRes.status}: ${errText.slice(0, 200)}`);
          }

          const geminiData = (await geminiRes.json()) as any;
          actionText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || "";
        } catch (err) {
          const msg = `Gemini vision error: ${err instanceof Error ? err.message : String(err)}`;
          log.error(`[computer.use] ${msg}`);
          steps.push(`Step ${step}: ${msg}`);
          break;
        }

        // 4. Parse action
        const action = parseCUAction(actionText);
        if (!action) {
          steps.push(`Step ${step}: Could not parse action: ${actionText.slice(0, 200)}`);
          // Try one more time before giving up
          if (step < maxSteps) {
            steps.push(`Step ${step}: Retrying...`);
            continue;
          }
          break;
        }

        log.info(`[computer.use] Step ${step}: ${JSON.stringify(action)}`);

        // 5. Execute action
        try {
          switch (action.action) {
            case "click":
              mouseClick(action.x, action.y, "left");
              steps.push(`Step ${step}: click(${action.x}, ${action.y})`);
              await new Promise(r => setTimeout(r, 300));
              break;

            case "double_click":
              mouseClick(action.x, action.y, "left", true);
              steps.push(`Step ${step}: double_click(${action.x}, ${action.y})`);
              await new Promise(r => setTimeout(r, 300));
              break;

            case "right_click":
              mouseClick(action.x, action.y, "right");
              steps.push(`Step ${step}: right_click(${action.x}, ${action.y})`);
              await new Promise(r => setTimeout(r, 300));
              break;

            case "type":
              typeText(action.text);
              steps.push(`Step ${step}: type("${action.text.slice(0, 60)}")`);
              await new Promise(r => setTimeout(r, 200));
              break;

            case "key":
              // Map common key names to SendKeys format
              const keyMap: Record<string, string> = {
                Enter: "{ENTER}", Tab: "{TAB}", Escape: "{ESC}", Backspace: "{BS}",
                Delete: "{DEL}", Home: "{HOME}", End: "{END}",
                PageUp: "{PGUP}", PageDown: "{PGDN}",
                ArrowUp: "{UP}", ArrowDown: "{DOWN}", ArrowLeft: "{LEFT}", ArrowRight: "{RIGHT}",
                F1: "{F1}", F2: "{F2}", F3: "{F3}", F4: "{F4}", F5: "{F5}",
                F6: "{F6}", F7: "{F7}", F8: "{F8}", F9: "{F9}", F10: "{F10}",
                F11: "{F11}", F12: "{F12}",
              };
              const mapped = keyMap[action.key] || action.key;
              sendKeys(mapped);
              steps.push(`Step ${step}: key(${action.key})`);
              await new Promise(r => setTimeout(r, 200));
              break;

            case "scroll":
              mouseScroll(action.x || 960, action.y || 540, action.direction, action.amount || 3);
              steps.push(`Step ${step}: scroll(${action.direction}, amount=${action.amount || 3})`);
              await new Promise(r => setTimeout(r, 300));
              break;

            case "focus":
              focusWindow(action.window);
              steps.push(`Step ${step}: focus("${action.window}")`);
              await new Promise(r => setTimeout(r, 500));
              break;

            case "open":
              openItem(action.target);
              steps.push(`Step ${step}: open("${action.target}")`);
              await new Promise(r => setTimeout(r, 2000));
              break;

            case "drag":
              mouseDrag(action.fromX, action.fromY, action.toX, action.toY);
              steps.push(`Step ${step}: drag(${action.fromX},${action.fromY} → ${action.toX},${action.toY})`);
              await new Promise(r => setTimeout(r, 300));
              break;

            case "hotkey":
              sendHotkey(action.keys);
              steps.push(`Step ${step}: hotkey(${action.keys})`);
              await new Promise(r => setTimeout(r, 400));
              break;

            case "wait":
              const waitMs = Math.min((action.seconds || 1) * 1000, 5000);
              steps.push(`Step ${step}: wait(${action.seconds}s)`);
              await new Promise(r => setTimeout(r, waitMs));
              break;

            case "done": {
              steps.push(`Step ${step}: DONE — ${action.summary}`);
              // Take final screenshot
              try {
                const finalPath = takeDesktopScreenshot();
                screenshotFiles.push(finalPath);
                if (!quiet && _botPhotoFn && chatId > 0) {
                  const finalBuf = fs.readFileSync(finalPath);
                  await _botPhotoFn(chatId, finalBuf, `✅ ${action.summary}`);
                }
              } catch { /* non-critical */ }
              log.info(`[computer.use] Completed in ${step} steps: ${action.summary}`);
              return `Computer Use completed in ${step} steps.\n\n${steps.join("\n")}\n\nResult: ${action.summary}`;
            }
          }
        } catch (err) {
          steps.push(`Step ${step}: Error executing ${action.action}: ${err instanceof Error ? err.message : String(err)}`);
          // Don't break — let the vision see the error state and decide
        }

        // Small delay between iterations
        await new Promise(r => setTimeout(r, 500));
      }
    } finally {
      // Cleanup temp screenshots
      for (const f of screenshotFiles) {
        try { fs.unlinkSync(f); } catch { /* ignore */ }
      }
    }

    return `Computer Use finished after ${steps.length} steps (max reached or error).\n\n${steps.join("\n")}`;
  },
});

// ── computer.look — Just take a screenshot and describe what's on screen ──

registerSkill({
  name: "computer.look",
  description:
    "Take a desktop screenshot and get an AI description of what's visible on screen. Useful to understand current desktop state before taking actions.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      question: { type: "string", description: "Optional: specific question about what's on screen" },
      chatId: { type: "string", description: "Chat ID to send screenshot to" },
    },
  },
  async execute(args): Promise<string> {
    const question = (args.question as string) || "Describe what you see on the desktop. List all visible windows, applications, and notable elements.";
    const chatId = Number(args.chatId) || config.adminChatId;

    if (!config.geminiApiKey) return "Error: GEMINI_API_KEY required.";

    let screenshotPath: string;
    try {
      screenshotPath = takeDesktopScreenshot();
    } catch (err) {
      return `Error taking screenshot: ${err instanceof Error ? err.message : String(err)}`;
    }

    try {
      const screenshotBuffer = fs.readFileSync(screenshotPath);
      const base64 = screenshotBuffer.toString("base64");

      // Send to Telegram
      if (_botPhotoFn && chatId > 0) {
        try { await _botPhotoFn(chatId, screenshotBuffer, "🖥️ Desktop"); } catch { /* ignore */ }
      }

      // Ask Gemini to describe (with 15s timeout)
      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${config.geminiApiKey}`;
      const abortCtrl = new AbortController();
      const fetchTimeout = setTimeout(() => abortCtrl.abort(), 15_000);
      const geminiRes = await fetch(geminiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abortCtrl.signal,
        body: JSON.stringify({
          contents: [{
            parts: [
              { inline_data: { mime_type: "image/png", data: base64 } },
              { text: question },
            ],
          }],
          generationConfig: { maxOutputTokens: 1000 },
        }),
      });
      clearTimeout(fetchTimeout);

      if (!geminiRes.ok) throw new Error(`Gemini ${geminiRes.status}`);
      const data = (await geminiRes.json()) as any;
      const description = data.candidates?.[0]?.content?.parts?.[0]?.text || "(no description)";

      const activeWin = getActiveWindow();
      return `Active window: ${activeWin}\n\n${description}`;
    } finally {
      try { fs.unlinkSync(screenshotPath); } catch { /* ignore */ }
    }
  },
});

// ── computer.windows — List all visible windows ──

registerSkill({
  name: "computer.windows",
  description: "List all visible windows with their titles, for deciding which to focus/control.",
  adminOnly: true,
  argsSchema: { type: "object", properties: {} },
  async execute(): Promise<string> {
    try {
      const result = ps(`
        Get-Process | Where-Object { $_.MainWindowTitle -ne '' } | ForEach-Object {
          [PSCustomObject]@{ PID = $_.Id; Name = $_.ProcessName; Title = $_.MainWindowTitle }
        } | Format-Table -AutoSize
      `);
      return result || "No visible windows found.";
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

// ── computer.screens — Get info about all monitors ──

registerSkill({
  name: "computer.screens",
  description: "Get information about all connected monitors — resolution, position, which is primary. Useful before taking actions on multi-monitor setups.",
  adminOnly: true,
  argsSchema: { type: "object", properties: {} },
  async execute(): Promise<string> {
    try {
      const si = getScreenInfo();
      let out = `Total desktop: ${si.totalW}x${si.totalH}\n`;
      for (let i = 0; i < si.screens.length; i++) {
        const s = si.screens[i];
        out += `Monitor ${i + 1}: ${s.w}x${s.h} at (${s.x},${s.y})${s.primary ? " [PRIMARY]" : ""}\n`;
      }
      return out.trim();
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

// ── computer.drag — Drag and drop ──

registerSkill({
  name: "computer.drag",
  description: "Drag from one coordinate to another. Useful for moving files, resizing windows, or rearranging UI elements.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      fromX: { type: "number", description: "Start X coordinate" },
      fromY: { type: "number", description: "Start Y coordinate" },
      toX: { type: "number", description: "End X coordinate" },
      toY: { type: "number", description: "End Y coordinate" },
    },
    required: ["fromX", "fromY", "toX", "toY"],
  },
  async execute(args): Promise<string> {
    try {
      mouseDrag(Number(args.fromX), Number(args.fromY), Number(args.toX), Number(args.toY));
      return `Dragged from (${args.fromX},${args.fromY}) to (${args.toX},${args.toY})`;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

// ── computer.hotkey — Complex keyboard shortcuts ──

registerSkill({
  name: "computer.hotkey",
  description: "Send complex keyboard shortcuts like Ctrl+Shift+T, Alt+Tab, Win+D, Ctrl+A. Handles modifier keys properly.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      keys: { type: "string", description: "Keyboard shortcut, e.g. 'ctrl+shift+t', 'alt+tab', 'win+d', 'ctrl+a'" },
    },
    required: ["keys"],
  },
  async execute(args): Promise<string> {
    try {
      sendHotkey(args.keys as string);
      return `Sent hotkey: ${args.keys}`;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

// ── computer.ocr — Extract text from screen region using Gemini vision ──

registerSkill({
  name: "computer.ocr",
  description: "Read/extract all text visible on screen or in a specific region using AI vision. Great for reading error messages, page content, form data, etc.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      x: { type: "number", description: "Optional: region start X" },
      y: { type: "number", description: "Optional: region start Y" },
      w: { type: "number", description: "Optional: region width" },
      h: { type: "number", description: "Optional: region height" },
      focus: { type: "string", description: "Optional: what to focus on extracting (e.g. 'error messages', 'form fields', 'prices')" },
    },
  },
  async execute(args): Promise<string> {
    if (!config.geminiApiKey) return "Error: GEMINI_API_KEY required.";

    let screenshotPath: string;
    try {
      if (args.x != null && args.y != null && args.w && args.h) {
        screenshotPath = takeRegionScreenshot(Number(args.x), Number(args.y), Number(args.w), Number(args.h));
      } else {
        screenshotPath = takeDesktopScreenshot();
      }
    } catch (err) {
      return `Screenshot error: ${err instanceof Error ? err.message : String(err)}`;
    }

    try {
      const buf = fs.readFileSync(screenshotPath);
      const base64 = buf.toString("base64");
      const focus = (args.focus as string) || "all visible text";

      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${config.geminiApiKey}`;
      const ac = new AbortController();
      const ft = setTimeout(() => ac.abort(), 15_000);
      const res = await fetch(geminiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ac.signal,
        body: JSON.stringify({
          contents: [{
            parts: [
              { inline_data: { mime_type: "image/png", data: base64 } },
              { text: `Extract and return ALL readable text from this screenshot. Focus on: ${focus}. Return the text as-is, preserving structure. If there are UI labels, include them. Format clearly.` },
            ],
          }],
          generationConfig: { maxOutputTokens: 2000, temperature: 0 },
        }),
      });
      clearTimeout(ft);

      if (!res.ok) throw new Error(`Gemini ${res.status}`);
      const data = (await res.json()) as any;
      return data.candidates?.[0]?.content?.parts?.[0]?.text || "(no text detected)";
    } finally {
      try { fs.unlinkSync(screenshotPath); } catch { /* ignore */ }
    }
  },
});

// ── computer.wait_for — Wait until a visual element appears ──

registerSkill({
  name: "computer.wait_for",
  description: "Wait until a specific visual element or text appears on screen. Polls with screenshots until found or timeout. Useful for waiting for page loads, dialogs, notifications.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      description: { type: "string", description: "What to wait for, e.g. 'a login button', 'the text Success', 'a popup dialog'" },
      timeout: { type: "number", description: "Max seconds to wait (default 15)" },
      interval: { type: "number", description: "Seconds between checks (default 2)" },
    },
    required: ["description"],
  },
  async execute(args): Promise<string> {
    if (!config.geminiApiKey) return "Error: GEMINI_API_KEY required.";

    const target = args.description as string;
    const timeout = Math.min(Number(args.timeout) || 15, 30) * 1000;
    const interval = Math.min(Number(args.interval) || 2, 5) * 1000;
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      let screenshotPath: string;
      try {
        screenshotPath = takeDesktopScreenshot();
      } catch {
        await new Promise(r => setTimeout(r, interval));
        continue;
      }

      try {
        const buf = fs.readFileSync(screenshotPath);
        const base64 = buf.toString("base64");

        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${config.geminiApiKey}`;
        const ac2 = new AbortController();
        const ft2 = setTimeout(() => ac2.abort(), 15_000);
        const res = await fetch(geminiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: ac2.signal,
          body: JSON.stringify({
            contents: [{
              parts: [
                { inline_data: { mime_type: "image/png", data: base64 } },
                { text: `Is the following element visible on this screenshot? "${target}"\nAnswer with ONLY "YES" or "NO" followed by a brief explanation.` },
              ],
            }],
            generationConfig: { maxOutputTokens: 100, temperature: 0 },
          }),
        });
        clearTimeout(ft2);

        if (res.ok) {
          const data = (await res.json()) as any;
          const answer = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
          if (answer.toUpperCase().startsWith("YES")) {
            return `Found after ${Math.round((Date.now() - startTime) / 1000)}s: ${answer}`;
          }
        }
      } finally {
        try { fs.unlinkSync(screenshotPath); } catch { /* ignore */ }
      }

      await new Promise(r => setTimeout(r, interval));
    }

    return `Timeout after ${Math.round(timeout / 1000)}s: "${target}" not found on screen.`;
  },
});

// ── computer.find — Find a UI element on screen and return its coordinates ──

registerSkill({
  name: "computer.find",
  description: "Find a specific UI element on screen and return its pixel coordinates. Useful before clicking — find first, then click precisely.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      element: { type: "string", description: "What to find, e.g. 'the Submit button', 'the search bar', 'the close icon'" },
      chatId: { type: "string", description: "Optional: send screenshot with highlighted element" },
    },
    required: ["element"],
  },
  async execute(args): Promise<string> {
    if (!config.geminiApiKey) return "Error: GEMINI_API_KEY required.";

    let screenshotPath: string;
    try {
      screenshotPath = takeDesktopScreenshot();
    } catch (err) {
      return `Screenshot error: ${err instanceof Error ? err.message : String(err)}`;
    }

    try {
      const buf = fs.readFileSync(screenshotPath);
      const base64 = buf.toString("base64");
      const si = getScreenInfo();

      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${config.geminiApiKey}`;
      const ac3 = new AbortController();
      const ft3 = setTimeout(() => ac3.abort(), 15_000);
      const res = await fetch(geminiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ac3.signal,
        body: JSON.stringify({
          contents: [{
            parts: [
              { inline_data: { mime_type: "image/png", data: base64 } },
              { text: `The screenshot shows a ${si.totalW}x${si.totalH} pixel desktop with ${si.screens.length} monitors.\nFind the element: "${args.element}"\nReturn ONLY a JSON object: {"found": true/false, "x": <center_x>, "y": <center_y>, "description": "<what you found>"}` },
            ],
          }],
          generationConfig: { maxOutputTokens: 200, temperature: 0 },
        }),
      });
      clearTimeout(ft3);

      if (!res.ok) throw new Error(`Gemini ${res.status}`);
      const data = (await res.json()) as any;
      return data.candidates?.[0]?.content?.parts?.[0]?.text || '{"found": false}';
    } finally {
      try { fs.unlinkSync(screenshotPath); } catch { /* ignore */ }
    }
  },
});

// ── computer.open — Open apps, files, URLs, or File Explorer ──

registerSkill({
  name: "computer.open",
  description:
    "Open an application, file, folder, or URL. Examples: 'explorer' (File Explorer), 'notepad', 'calc', 'C:\\Users' (folder), 'https://google.com' (URL). Uses Windows 'start' command.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      target: { type: "string", description: "What to open: app name, file path, folder path, or URL" },
    },
    required: ["target"],
  },
  async execute(args): Promise<string> {
    try {
      openItem(args.target as string);
      await new Promise(r => setTimeout(r, 1500));
      const win = getActiveWindow();
      return `Opened "${args.target}". Active window: ${win}`;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

// ── computer.clipboard — Read or write clipboard ──

registerSkill({
  name: "computer.clipboard",
  description:
    "Read the current clipboard content or write text to the clipboard. Useful for transferring data between apps.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      action: { type: "string", description: "'read' to get clipboard content, 'write' to set it" },
      text: { type: "string", description: "Text to write to clipboard (only needed for 'write' action)" },
    },
    required: ["action"],
  },
  async execute(args): Promise<string> {
    const action = args.action as string;
    try {
      if (action === "write") {
        const text = (args.text as string) || "";
        ps(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::SetText('${text.replace(/'/g, "''")}')`);
        return `Clipboard set to: "${text.slice(0, 100)}"`;
      } else {
        const result = ps(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::GetText()`);
        return result || "(clipboard is empty or contains non-text data)";
      }
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

// ── computer.window — Minimize, maximize, restore, or close a window ──

registerSkill({
  name: "computer.window",
  description:
    "Control a window: minimize, maximize, restore, or close it. Can target by window title or process name.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      action: { type: "string", description: "'minimize', 'maximize', 'restore', or 'close'" },
      name: { type: "string", description: "Partial window title or process name to target" },
    },
    required: ["action", "name"],
  },
  async execute(args): Promise<string> {
    const action = args.action as string;
    const name = escPS(args.name as string);
    try {
      const actionMap: Record<string, string> = {
        minimize: "ShowWindow($h, 6)",   // SW_MINIMIZE
        maximize: "ShowWindow($h, 3)",   // SW_MAXIMIZE
        restore: "ShowWindow($h, 9)",    // SW_RESTORE
        close: "PostMessage($h, 0x0010, 0, 0)",  // WM_CLOSE
      };
      const winCmd = actionMap[action];
      if (!winCmd) return `Unknown action: ${action}. Use minimize, maximize, restore, or close.`;

      const closeImport = action === "close"
        ? `[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, int wParam, int lParam);`
        : "";

      psFile(`
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class CUWinCtrl {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  ${closeImport}
}
"@
$procs = Get-Process | Where-Object { $_.MainWindowTitle -match '${name}' -or $_.ProcessName -match '${name}' }
if ($procs.Count -eq 0) { Write-Output "Window not found: ${name}"; exit }
$h = $procs[0].MainWindowHandle
[CUWinCtrl]::${winCmd}
Write-Output "OK: ${action} on $($procs[0].MainWindowTitle)"
      `);
      return `${action} applied to window matching "${args.name}"`;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

// ── computer.snap — Snap window to left/right/maximize using Win+Arrow ──

registerSkill({
  name: "computer.snap",
  description:
    "Snap the current window using Windows shortcuts: 'left' (Win+Left), 'right' (Win+Right), 'up' (maximize), 'down' (minimize/restore). Like pressing Win+Arrow keys.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      direction: { type: "string", description: "'left', 'right', 'up', or 'down'" },
      name: { type: "string", description: "Optional: window to focus before snapping" },
    },
    required: ["direction"],
  },
  async execute(args): Promise<string> {
    try {
      if (args.name) focusWindow(args.name as string);
      const dir = (args.direction as string).toLowerCase();
      const keyMap: Record<string, string> = {
        left: "win+left", right: "win+right", up: "win+up", down: "win+down",
      };
      const combo = keyMap[dir];
      if (!combo) return `Unknown direction: ${dir}. Use left, right, up, or down.`;
      sendHotkey(combo);
      await new Promise(r => setTimeout(r, 400));
      return `Snapped window ${dir}`;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

// ── computer.taskbar — Click on a taskbar app or open Start menu ──

registerSkill({
  name: "computer.taskbar",
  description:
    "Interact with the Windows taskbar: open Start menu, click on a pinned app, or open system tray. Actions: 'start' (Win key), 'search' (Win+S), 'settings' (Win+I), 'desktop' (Win+D), 'task_view' (Win+Tab), 'action_center' (Win+A), 'notifications' (Win+N).",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      action: { type: "string", description: "'start', 'search', 'settings', 'desktop', 'task_view', 'action_center', 'notifications', or 'run' (Win+R)" },
    },
    required: ["action"],
  },
  async execute(args): Promise<string> {
    const action = args.action as string;
    try {
      const shortcutMap: Record<string, string> = {
        start: "win",
        search: "win+s",
        settings: "win+i",
        desktop: "win+d",
        task_view: "win+tab",
        action_center: "win+a",
        notifications: "win+n",
        run: "win+r",
      };
      const combo = shortcutMap[action];
      if (!combo) return `Unknown action: ${action}. Available: ${Object.keys(shortcutMap).join(", ")}`;

      if (combo === "win") {
        // Just press and release Win key
        psFile(`
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class CUWinKey2 {
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, int dwExtraInfo);
}
"@
[CUWinKey2]::keybd_event(0x5B, 0, 0, 0)
Start-Sleep -Milliseconds 100
[CUWinKey2]::keybd_event(0x5B, 0, 2, 0)
        `);
      } else {
        sendHotkey(combo);
      }
      await new Promise(r => setTimeout(r, 500));
      return `Taskbar action: ${action}`;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

// ── computer.explorer — Open File Explorer at a specific path ──

registerSkill({
  name: "computer.explorer",
  description:
    "Open Windows File Explorer at a specific folder path. Defaults to the user's home directory if no path specified.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Folder path to open. Defaults to user home." },
    },
  },
  async execute(args): Promise<string> {
    const targetPath = (args.path as string) || os.homedir();
    try {
      openItem(`explorer.exe "${targetPath}"`);
      await new Promise(r => setTimeout(r, 2000));
      return `Opened File Explorer at: ${targetPath}`;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

// ── computer.type_raw — Type text character by character (for fields that block paste) ──

registerSkill({
  name: "computer.type_raw",
  description:
    "Type text character by character using SendKeys (not clipboard). Slower but works in fields that block paste. Also supports special keys like {ENTER}, {TAB}, {ESC}.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "Text to type, or SendKeys format like {ENTER}, ^a (Ctrl+A)" },
    },
    required: ["text"],
  },
  async execute(args): Promise<string> {
    try {
      sendKeys(args.text as string);
      return `Typed: "${(args.text as string).slice(0, 60)}"`;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

// ── computer.screenshot_region — Take a screenshot of a specific region ──

registerSkill({
  name: "computer.screenshot_region",
  description:
    "Take a screenshot of a specific rectangular region of the screen. Useful for capturing error dialogs, specific UI elements, etc.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      x: { type: "number", description: "Top-left X coordinate" },
      y: { type: "number", description: "Top-left Y coordinate" },
      w: { type: "number", description: "Width in pixels" },
      h: { type: "number", description: "Height in pixels" },
      chatId: { type: "string", description: "Send screenshot to this Telegram chat" },
      save: { type: "string", description: "Optional file path to save the screenshot" },
    },
    required: ["x", "y", "w", "h"],
  },
  async execute(args): Promise<string> {
    const x = Number(args.x), y = Number(args.y), w = Number(args.w), h = Number(args.h);
    const chatId = Number(args.chatId) || config.adminChatId;

    let screenshotPath: string;
    try {
      screenshotPath = takeRegionScreenshot(x, y, w, h);
    } catch (err) {
      return `Screenshot error: ${err instanceof Error ? err.message : String(err)}`;
    }

    try {
      if (_botPhotoFn && chatId > 0) {
        const buf = fs.readFileSync(screenshotPath);
        await _botPhotoFn(chatId, buf, `📸 Region (${x},${y}) ${w}x${h}`);
      }

      if (args.save) {
        fs.copyFileSync(screenshotPath, args.save as string);
        return `Screenshot saved to ${args.save} and sent to Telegram.`;
      }

      return `Screenshot of region (${x},${y}) ${w}x${h} sent to Telegram.`;
    } finally {
      try { fs.unlinkSync(screenshotPath); } catch { /* ignore */ }
    }
  },
});
