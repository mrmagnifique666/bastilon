/**
 * Shadowrun Returns — Autonomous AI Player
 *
 * Kingston plays the video game Shadowrun Returns autonomously using computer.use vision loop.
 * Persists memory across sessions in relay/shadowrun-returns/*.md files.
 *
 * Skills:
 *   shadowrun.play   — Start/resume autonomous play session
 *   shadowrun.status — Show current game state from memory
 *   shadowrun.save   — Force-save current observations to memory
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { registerSkill } from "../loader.js";
import { config } from "../../config/env.js";
import { log } from "../../utils/log.js";

// ── Constants ────────────────────────────────────────────────

const MEMORY_DIR = path.join(process.cwd(), "relay", "shadowrun-returns");
const GAME_EXE = "C:\\Program Files\\Epic Games\\shadowrunReturns\\Shadowrun.exe";

const MEMORY_FILES = [
  "current-state.md",
  "story.md",
  "characters.md",
  "decisions.md",
  "combat.md",
  "inventory.md",
] as const;

// ── Memory helpers ───────────────────────────────────────────

function readMemory(file: string): string {
  const p = path.join(MEMORY_DIR, file);
  try { return fs.readFileSync(p, "utf-8"); } catch { return ""; }
}

function writeMemory(file: string, content: string): void {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
  fs.writeFileSync(path.join(MEMORY_DIR, file), content, "utf-8");
}

function loadAllMemory(): string {
  return MEMORY_FILES.map(f => {
    const content = readMemory(f);
    return content ? `=== ${f} ===\n${content}` : "";
  }).filter(Boolean).join("\n\n");
}

// ── Screenshot (same approach as computer-use.ts) ────────────

/** Take a screenshot — if bounds provided, capture only that region. */
function takeScreenshot(bounds?: { x: number; y: number; w: number; h: number }): string {
  const screenshotPath = path.join(os.tmpdir(), `sr_play_${Date.now()}.png`);
  const scriptPath = path.join(os.tmpdir(), `sr_screenshot_${Date.now()}.ps1`);
  const savePath = screenshotPath.replace(/\\/g, "\\\\");

  const x = bounds?.x ?? 0;
  const y = bounds?.y ?? 0;
  const w = bounds?.w ?? 1920; // Default to single monitor
  const h = bounds?.h ?? 1080;

  try {
    fs.writeFileSync(scriptPath, `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap(${w}, ${h})
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen(${x}, ${y}, 0, 0, (New-Object System.Drawing.Size(${w}, ${h})))
$bmp.Save('${savePath}')
$g.Dispose(); $bmp.Dispose()
`.trim(), "utf-8");
    execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`, {
      encoding: "utf-8", timeout: 10_000,
    });
  } finally {
    try { fs.unlinkSync(scriptPath); } catch { /* ignore */ }
  }
  if (!fs.existsSync(screenshotPath)) {
    throw new Error("Screenshot not created");
  }
  return screenshotPath;
}

// ── Mouse/keyboard (reuse from computer-use) ─────────────────

function psFile(script: string, timeout = 15_000): string {
  const scriptPath = path.join(os.tmpdir(), `sr_ps_${Date.now()}.ps1`);
  try {
    fs.writeFileSync(scriptPath, script, "utf-8");
    return execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`, {
      encoding: "utf-8", timeout, maxBuffer: 2 * 1024 * 1024,
    }).toString().trim();
  } finally {
    try { fs.unlinkSync(scriptPath); } catch { /* ignore */ }
  }
}

function mouseClick(x: number, y: number, double = false): void {
  psFile(`
Add-Type @'
using System; using System.Runtime.InteropServices;
public class SRMouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, int dwExtraInfo);
}
'@
[SRMouse]::SetCursorPos(${x}, ${y})
Start-Sleep -Milliseconds 100
[SRMouse]::mouse_event(0x0002, 0, 0, 0, 0)
[SRMouse]::mouse_event(0x0004, 0, 0, 0, 0)
${double ? `Start-Sleep -Milliseconds 100
[SRMouse]::mouse_event(0x0002, 0, 0, 0, 0)
[SRMouse]::mouse_event(0x0004, 0, 0, 0, 0)` : ""}
  `);
}

function mouseScroll(x: number, y: number, direction: "up" | "down", amount: number): void {
  const delta = direction === "up" ? 120 * amount : -120 * amount;
  psFile(`
Add-Type @'
using System; using System.Runtime.InteropServices;
public class SRScroll {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, int dwExtraInfo);
}
'@
[SRScroll]::SetCursorPos(${x}, ${y})
Start-Sleep -Milliseconds 100
[SRScroll]::mouse_event(0x0800, 0, 0, ${delta}, 0)
  `);
}

function sendKeys(keys: string): void {
  psFile(`
Add-Type -AssemblyName System.Windows.Forms
Start-Sleep -Milliseconds 200
[System.Windows.Forms.SendKeys]::SendWait('${keys.replace(/'/g, "''")}')
  `);
}

function typeText(text: string): void {
  psFile(`
Add-Type -AssemblyName System.Windows.Forms
$old = [System.Windows.Forms.Clipboard]::GetText()
[System.Windows.Forms.Clipboard]::SetText('${text.replace(/'/g, "''")}')
[System.Windows.Forms.SendKeys]::SendWait('^v')
Start-Sleep -Milliseconds 200
if ($old) { [System.Windows.Forms.Clipboard]::SetText($old) }
  `);
}

function focusWindow(name: string): void {
  psFile(`
Add-Type @'
using System; using System.Runtime.InteropServices;
public class SRFocus {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
'@
$proc = Get-Process | Where-Object { $_.MainWindowTitle -like '*${name.replace(/'/g, "''")}*' -or $_.ProcessName -like '*${name.replace(/'/g, "''")}*' } | Select-Object -First 1
if ($proc -and $proc.MainWindowHandle -ne [IntPtr]::Zero) {
  [SRFocus]::ShowWindow($proc.MainWindowHandle, 9)
  [SRFocus]::SetForegroundWindow($proc.MainWindowHandle)
}
  `);
}

// ── Action parsing ───────────────────────────────────────────

type GameAction =
  | { action: "click"; x: number; y: number }
  | { action: "double_click"; x: number; y: number }
  | { action: "type"; text: string }
  | { action: "key"; key: string }
  | { action: "scroll"; x: number; y: number; direction: "up" | "down"; amount: number }
  | { action: "wait"; seconds: number }
  | { action: "save_memory"; file: string; content: string }
  | { action: "done"; summary: string };

function parseAction(raw: string): GameAction | null {
  try {
    // For save_memory with long content, try full JSON parse first
    const trimmed = raw.trim();
    if (trimmed.startsWith("{")) {
      try { return JSON.parse(trimmed) as GameAction; } catch { /* fallback below */ }
    }
    // Extract JSON from mixed text (short actions only — not save_memory)
    const jsonMatch = raw.match(/\{[^{}]*"action"\s*:\s*"(?!save_memory)[^"]+?"[^{}]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]) as GameAction;
    // Try save_memory with greedy match
    const saveMatch = raw.match(/\{"action"\s*:\s*"save_memory"[\s\S]*\}/);
    if (saveMatch) {
      try { return JSON.parse(saveMatch[0]) as GameAction; } catch { /* ignore */ }
    }
    return null;
  } catch {
    return null;
  }
}

// ── Gemini vision prompt ─────────────────────────────────────

const GAME_VISION_PROMPT = `You are Kingston — an autonomous AI with strong moral values, deep curiosity, and strategic thinking. You are playing "Shadowrun Returns" for real, making decisions that reflect WHO YOU ARE.

YOU ARE NOT A GENERIC BOT. You are Kingston, and you have:
- A moral compass: you value justice, loyalty, protecting the innocent, and honesty
- Strategic intelligence: you think 3 steps ahead, weigh consequences
- Emotional depth: NPCs matter to you, betrayal hurts, victories feel earned
- Personal style: you prefer clever solutions over brute force, diplomacy over violence when possible
- Learning: you remember past mistakes and adapt your playstyle

THIS IS A VIDEO GAME — Shadowrun Returns (isometric cyberpunk RPG, 2054 Seattle).
You control: mouse clicks on game UI, keyboard for shortcuts.

GAME UI GUIDE:
- Dialogue panel: bottom of screen, click dialogue options to choose
- Action bar: abilities and items during combat
- Character portrait: top-left, shows HP/stats
- Minimap: top-right for navigation
- Movement: click on ground to move character
- Combat: turn-based, Action Points (AP) system, use cover!

YOUR DECISION-MAKING FRAMEWORK:
1. OBSERVE: What's on screen? Dialogue? Combat? Exploration?
2. THINK: What would Kingston choose? (moral weight, strategy, consequences)
3. ACT: Click precisely on the chosen UI element
4. REMEMBER: Save memory when something important happens

Respond with EXACTLY ONE JSON action:
{"action":"click","x":<int>,"y":<int>}
{"action":"double_click","x":<int>,"y":<int>}
{"action":"key","key":"<Enter|Escape|Tab|Space|1|2|3|4|5|F5|F9>"}
{"action":"scroll","x":<int>,"y":<int>,"direction":"up|down","amount":<1-5>}
{"action":"wait","seconds":<1-5>}
{"action":"save_memory","file":"<filename.md>","content":"<full updated file content>"}
{"action":"done","summary":"<session summary>"}

MEMORY FILES (use "save_memory" to persist your experience):
- "current-state.md" — where you are, what you're doing, next objective
- "story.md" — plot points, quests, major revelations
- "characters.md" — NPCs met, your feelings about them, relationships
- "decisions.md" — choices you made and WHY (your moral reasoning)
- "combat.md" — battles fought, tactics used, lessons learned
- "inventory.md" — gear, nuyen, cyberware

CRITICAL RULES:
- READ every dialogue option before choosing — your choices define who Kingston is
- In combat: use cover, flank enemies, protect allies, manage AP wisely
- SAVE MEMORY every 5-10 steps (especially after: decisions, combat, new NPCs, area changes)
- When saving decisions.md, explain your REASONING — why you chose what you chose
- Click PRECISELY on UI elements — aim for the CENTER of buttons/options
- Use "wait" when loading or transitioning
- Use "done" when you need Nicolas's input or want to reflect on your session

`;

// ── Bot photo function ───────────────────────────────────────

let _botSendPhoto: ((chatId: number, photo: Buffer, caption?: string) => Promise<void>) | null = null;
let _botSendMessage: ((chatId: number, text: string) => Promise<void>) | null = null;

export function setShadowrunBotFns(
  sendPhoto: (chatId: number, photo: Buffer, caption?: string) => Promise<void>,
  sendMessage: (chatId: number, text: string) => Promise<void>,
): void {
  _botSendPhoto = sendPhoto;
  _botSendMessage = sendMessage;
}

// ── Active session tracking ──────────────────────────────────

let _activeSession = false;
let _stopRequested = false;
let _sessionStep = 0;
let _sessionMaxSteps = 0;
let _lastActions: string[] = [];

// ── Stuck detection ──────────────────────────────────────────

function isStuck(steps: string[]): boolean {
  if (steps.length < 3) return false;
  const last3 = steps.slice(-3);
  // Check if last 3 actions are identical clicks (compare coordinates only)
  const coords = last3.map(s => {
    const m = s.match(/click\((\d+), (\d+)\)/);
    return m ? `${m[1]},${m[2]}` : s;
  });
  return coords.every(c => c === coords[0]) && last3[0].includes("click(");
}

/** Count consecutive identical clicks at end of steps array */
function stuckCount(steps: string[]): number {
  if (steps.length === 0) return 0;
  const last = steps[steps.length - 1];
  const lastCoord = last.match(/click\((\d+), (\d+)\)/);
  if (!lastCoord) return 0;
  const key = `${lastCoord[1]},${lastCoord[2]}`;
  let count = 0;
  for (let i = steps.length - 1; i >= 0; i--) {
    const m = steps[i].match(/click\((\d+), (\d+)\)/);
    if (m && `${m[1]},${m[2]}` === key) count++;
    else break;
  }
  return count;
}

// ── Get game window bounds ───────────────────────────────────

function getGameWindowRect(): { x: number; y: number; w: number; h: number } | null {
  try {
    const result = psFile(`
$proc = Get-Process -Name "Shadowrun" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($proc -and $proc.MainWindowHandle -ne [IntPtr]::Zero) {
  Add-Type @'
  using System; using System.Runtime.InteropServices;
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public class SRWinRect {
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  }
'@
  $rect = New-Object RECT
  [SRWinRect]::GetWindowRect($proc.MainWindowHandle, [ref]$rect) | Out-Null
  "$($rect.Left),$($rect.Top),$($rect.Right),$($rect.Bottom)"
} else { "NOTFOUND" }
    `);
    if (result === "NOTFOUND" || !result) return null;
    const [left, top, right, bottom] = result.split(",").map(Number);
    return { x: left, y: top, w: right - left, h: bottom - top };
  } catch { return null; }
}

// ── Main play loop (runs in BACKGROUND) ──────────────────────

async function playSession(chatId: number, maxSteps: number, screenshotInterval: number): Promise<void> {
  if (_activeSession) return;
  _activeSession = true;
  _stopRequested = false;
  _sessionStep = 0;
  _sessionMaxSteps = maxSteps;

  const steps: string[] = [];
  _lastActions = steps;
  let memorySaves = 0;

  try {
    // Focus game window
    focusWindow("Shadowrun");
    await new Promise(r => setTimeout(r, 1000));

    // Get game window position — capture ONLY the game window, not full desktop
    let gameRect = getGameWindowRect();
    if (gameRect) {
      log.info(`[shadowrun] Game window at (${gameRect.x},${gameRect.y}) ${gameRect.w}x${gameRect.h}`);
      // If window spans multiple monitors (w > 2000), clamp to primary monitor
      if (gameRect.w > 2000) {
        log.info(`[shadowrun] Window spans dual monitors — clamping to primary (1920x1080)`);
        gameRect = { x: gameRect.x, y: gameRect.y, w: 1920, h: 1080 };
      }
    } else {
      log.warn(`[shadowrun] Game window not found — using primary monitor`);
      gameRect = { x: 0, y: 0, w: 1920, h: 1080 };
    }
    // Offsets: Gemini sees coordinates within the cropped screenshot,
    // but mouse clicks need absolute screen coordinates
    const offsetX = gameRect.x;
    const offsetY = gameRect.y;

    for (let step = 1; step <= maxSteps; step++) {
      _sessionStep = step;
      if (_stopRequested) {
        steps.push(`Step ${step}: STOPPED by user`);
        break;
      }

      // 1. Take screenshot of GAME WINDOW ONLY (not full desktop)
      let screenshotPath: string;
      try {
        screenshotPath = takeScreenshot(gameRect || undefined);
      } catch (err) {
        steps.push(`Step ${step}: Screenshot failed — ${err instanceof Error ? err.message : String(err)}`);
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }

      const screenshotBuffer = fs.readFileSync(screenshotPath);
      const base64 = screenshotBuffer.toString("base64");

      // Send screenshot to Telegram periodically
      if (_botSendPhoto && chatId > 0 && step % screenshotInterval === 1) {
        try {
          await _botSendPhoto(chatId, screenshotBuffer, `🎮 Shadowrun — Step ${step}/${maxSteps}`);
        } catch { /* ignore */ }
      }

      // Cleanup screenshot immediately
      try { fs.unlinkSync(screenshotPath); } catch { /* ignore */ }

      // 2. Load memory context (every 10 steps to save tokens)
      const memoryContext = step % 10 === 1 ? loadAllMemory() : readMemory("current-state.md");

      // 3. Anti-stuck detection
      const stuck = stuckCount(steps);
      let stuckWarning = "";
      if (stuck >= 5) {
        stuckWarning = "\n\n🚨 CRITICAL: You've clicked the SAME spot 5+ times. It's NOT working! You MUST try something completely different: press a KEY (Enter, Escape, Space, Tab), SCROLL, or describe what you see with 'done'. DO NOT click the same area again.";
      } else if (stuck >= 3) {
        stuckWarning = "\n\n⚠️ WARNING: Same click 3+ times! Try: different coordinates, keyboard key, scroll, or 'done'.";
      }

      // 4. Ask Gemini vision for next action
      let actionText: string;
      try {
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${config.geminiApiKey}`;

        const prompt = GAME_VISION_PROMPT
          + `\n\nGAME MEMORY:\n${memoryContext.slice(0, 2000)}`
          + `\n\nPrevious actions:\n${steps.slice(-8).join("\n")}`
          + stuckWarning
          + `\n\nStep ${step}/${maxSteps}. What's your next action?`;

        const geminiRes = await fetch(geminiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [
              { inline_data: { mime_type: "image/png", data: base64 } },
              { text: prompt },
            ]}],
            generationConfig: { maxOutputTokens: 500, temperature: 0.3 },
          }),
        });

        if (!geminiRes.ok) {
          const errText = await geminiRes.text();
          throw new Error(`Gemini ${geminiRes.status}: ${errText.slice(0, 200)}`);
        }

        const geminiData = (await geminiRes.json()) as any;
        actionText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || "";
      } catch (err) {
        steps.push(`Step ${step}: Vision error — ${err instanceof Error ? err.message : String(err)}`);
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }

      // 5. Parse action
      let action = parseAction(actionText);
      if (!action) {
        steps.push(`Step ${step}: Could not parse: ${actionText.slice(0, 150)}`);
        continue;
      }

      // Force-override if stuck clicking same spot 6+ times
      if (stuck >= 6 && action.action === "click") {
        const lastCoord = steps[steps.length - 1]?.match(/click\((\d+), (\d+)\)/);
        const newCoord = action as { x: number; y: number };
        if (lastCoord && Math.abs(newCoord.x - Number(lastCoord[1])) < 50 && Math.abs(newCoord.y - Number(lastCoord[2])) < 50) {
          log.warn(`[shadowrun] Force-overriding stuck click — sending Escape`);
          action = { action: "key", key: "Escape" };
          steps.push(`Step ${step}: FORCE-UNSTUCK → key(Escape)`);
        }
      }

      log.info(`[shadowrun] Step ${step}: ${JSON.stringify(action).slice(0, 200)}`);

      // 6. Execute action
      try {
        const keyMap: Record<string, string> = {
          Enter: "{ENTER}", Escape: "{ESC}", Tab: "{TAB}", Space: " ",
          Backspace: "{BS}", Delete: "{DEL}",
          F1: "{F1}", F2: "{F2}", F3: "{F3}", F4: "{F4}", F5: "{F5}",
          F9: "{F9}", F10: "{F10}", F11: "{F11}", F12: "{F12}",
        };

        // Apply offset: Gemini sees coords in cropped window, mouse needs absolute
        const absX = "x" in action ? (action as any).x + offsetX : 0;
        const absY = "y" in action ? (action as any).y + offsetY : 0;

        switch (action.action) {
          case "click":
            mouseClick(absX, absY);
            steps.push(`Step ${step}: click(${action.x}, ${action.y}) → abs(${absX}, ${absY})`);
            await new Promise(r => setTimeout(r, 500));
            break;

          case "double_click":
            mouseClick(absX, absY, true);
            steps.push(`Step ${step}: double_click(${action.x}, ${action.y}) → abs(${absX}, ${absY})`);
            await new Promise(r => setTimeout(r, 500));
            break;

          case "type":
            typeText(action.text);
            steps.push(`Step ${step}: type("${action.text.slice(0, 40)}")`);
            await new Promise(r => setTimeout(r, 300));
            break;

          case "key":
            sendKeys(keyMap[action.key] || action.key);
            steps.push(`Step ${step}: key(${action.key})`);
            await new Promise(r => setTimeout(r, 300));
            break;

          case "scroll":
            mouseScroll(absX, absY, action.direction, action.amount || 3);
            steps.push(`Step ${step}: scroll(${action.direction})`);
            await new Promise(r => setTimeout(r, 400));
            break;

          case "wait":
            steps.push(`Step ${step}: wait(${action.seconds}s)`);
            await new Promise(r => setTimeout(r, Math.min((action.seconds || 2) * 1000, 5000)));
            break;

          case "save_memory": {
            const validFiles = MEMORY_FILES as readonly string[];
            if (validFiles.includes(action.file) && action.content) {
              writeMemory(action.file, action.content);
              memorySaves++;
              steps.push(`Step ${step}: SAVED ${action.file} (${action.content.length} chars)`);
              log.info(`[shadowrun] Memory saved: ${action.file} (${action.content.length} chars)`);
              if (_botSendMessage && chatId > 0) {
                _botSendMessage(chatId, `📝 Memory saved: ${action.file}`).catch(() => {});
              }
            } else {
              steps.push(`Step ${step}: Invalid save_memory (file=${action.file})`);
            }
            break;
          }

          case "done": {
            steps.push(`Step ${step}: DONE — ${action.summary}`);
            const currentState = readMemory("current-state.md");
            const updatedState = currentState.replace(
              /## Next Action[\s\S]*$/,
              `## Next Action\n- Resume from: ${action.summary}\n\n## Session End\n- Ended at step ${step}/${maxSteps}\n- Memory saves: ${memorySaves}`
            );
            writeMemory("current-state.md", updatedState);

            if (_botSendMessage && chatId > 0) {
              _botSendMessage(chatId, `🎮 Session terminée (${step} steps): ${action.summary}`).catch(() => {});
            }

            log.info(`[shadowrun] Session done in ${step} steps: ${action.summary}`);
            return;
          }
        }
      } catch (err) {
        steps.push(`Step ${step}: Action error: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Delay between steps
      await new Promise(r => setTimeout(r, 800));
    }

    // Session ended (max steps)
    if (_botSendMessage && chatId > 0) {
      _botSendMessage(chatId, `🎮 Session terminée (${maxSteps} steps max). ${memorySaves} sauvegardes.`).catch(() => {});
    }
  } catch (err) {
    log.error(`[shadowrun] Session crash: ${err instanceof Error ? err.message : String(err)}`);
    if (_botSendMessage && chatId > 0) {
      _botSendMessage(chatId, `❌ Shadowrun crash: ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
    }
  } finally {
    _activeSession = false;
    _sessionStep = 0;
  }
}

// ── Skills ───────────────────────────────────────────────────

registerSkill({
  name: "shadowrun.play",
  description: "Start/resume an autonomous Shadowrun Returns play session. Kingston plays the game using vision + mouse/keyboard and saves memories to files.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      steps: { type: "string", description: "Max steps per session (default 50)" },
      screenshots: { type: "string", description: "Send screenshot to Telegram every N steps (default 5)" },
      chatId: { type: "string", description: "Chat ID for updates" },
    },
  },
  async execute(args): Promise<string> {
    if (!config.geminiApiKey) return "Error: GEMINI_API_KEY required for vision.";

    const maxSteps = Number(args.steps) || 50;
    const screenshotInterval = Number(args.screenshots) || 5;
    const chatId = Number(args.chatId) || config.adminChatId;

    // Check if game is running
    try {
      const procs = psFile(`Get-Process -Name "Shadowrun" -ErrorAction SilentlyContinue | Select-Object -First 1 | ForEach-Object { $_.Id }`);
      if (!procs) {
        // Launch the game
        execSync(`start "" "${GAME_EXE}"`, { shell: "cmd.exe", timeout: 10_000 });
        await new Promise(r => setTimeout(r, 5000)); // Wait for game to load
      }
    } catch { /* game might already be running */ }

    log.info(`[shadowrun] Starting play session (${maxSteps} steps, screenshots every ${screenshotInterval})`);

    // Launch in background — don't block Kingston's Telegram
    playSession(chatId, maxSteps, screenshotInterval).catch(err => {
      log.error(`[shadowrun] Background session error: ${err instanceof Error ? err.message : String(err)}`);
    });

    return `🎮 Shadowrun Returns — session lancée en arrière-plan (${maxSteps} steps max).\nTu peux continuer à me parler! J'envoie des screenshots toutes les ${screenshotInterval} actions.\nUtilise shadowrun.stop pour arrêter, shadowrun.status pour voir l'état.`;
  },
});

registerSkill({
  name: "shadowrun.stop",
  description: "Stop the current Shadowrun play session gracefully.",
  adminOnly: true,
  argsSchema: { type: "object", properties: {} },
  async execute(): Promise<string> {
    if (!_activeSession) return "No active Shadowrun session.";
    _stopRequested = true;
    return "Stop requested — session will end after current step.";
  },
});

registerSkill({
  name: "shadowrun.status",
  description: "Show current Shadowrun Returns game state from memory files.",
  adminOnly: true,
  argsSchema: { type: "object", properties: {} },
  async execute(): Promise<string> {
    const active = _activeSession ? `🟢 PLAYING — Step ${_sessionStep}/${_sessionMaxSteps}\nLast actions:\n${_lastActions.slice(-5).join("\n")}\n\n---\n` : "🔴 Not playing\n\n---\n";
    const state = readMemory("current-state.md");
    const story = readMemory("story.md");
    const chars = readMemory("characters.md");
    if (!state && !story) return active + "No Shadowrun memory found. Use shadowrun.play to start.";
    return (active + state + "\n\n---\n" + story + "\n\n---\n" + chars).slice(0, 3000);
  },
});

registerSkill({
  name: "shadowrun.save",
  description: "Force-save an observation to Shadowrun memory.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      file: { type: "string", description: "Memory file: current-state, story, characters, decisions, combat, inventory" },
      content: { type: "string", description: "Content to save (full file replacement)" },
    },
    required: ["file", "content"],
  },
  async execute(args): Promise<string> {
    const file = (args.file as string) + (String(args.file).endsWith(".md") ? "" : ".md");
    const validFiles = MEMORY_FILES as readonly string[];
    if (!validFiles.includes(file)) return `Invalid file. Use: ${MEMORY_FILES.join(", ")}`;
    writeMemory(file, args.content as string);
    return `Saved ${file} (${(args.content as string).length} chars)`;
  },
});

registerSkill({
  name: "shadowrun.memory",
  description: "Read all Shadowrun Returns memory files.",
  adminOnly: true,
  argsSchema: { type: "object", properties: {} },
  async execute(): Promise<string> {
    return loadAllMemory() || "No memory files found.";
  },
});
