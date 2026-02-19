/**
 * Game controller — Kingston plays video games via computer.use.
 *
 * game.play    — Launch/focus a game and play autonomously (screenshot → vision → action loop)
 * game.look    — Take a screenshot and describe the current game state
 * game.command — Execute a single action in the game
 *
 * Wraps computer.use internals with gaming-optimized prompts and higher iteration limits.
 */
import { registerSkill, getSkill } from "../loader.js";
import { log } from "../../utils/log.js";
import { logEpisodicEvent } from "../../storage/store.js";

// ── Gaming Vision Prompt ──

const GAME_VISION_PROMPT = `Tu es un joueur expert de jeux video RPG. Tu vois l'ecran du jeu.

ANALYSE L'ECRAN:
- Personnages visibles et leur etat (sante, position)
- Interface du jeu (menus, barres de vie, inventaire, mini-carte)
- Options de dialogue si presentes
- Ennemis, objets, portes, interactibles
- Etat actuel de la quete/mission

Puis choisis l'action optimale pour progresser dans le jeu.

Reponds avec EXACTEMENT UN JSON action:
{"action":"click","x":<int>,"y":<int>}
{"action":"double_click","x":<int>,"y":<int>}
{"action":"right_click","x":<int>,"y":<int>}
{"action":"type","text":"<string>"}
{"action":"key","key":"<Enter|Tab|Escape|Space|W|A|S|D|1|2|3|4|5|F5|F9>"}
{"action":"scroll","x":<int>,"y":<int>,"direction":"up|down","amount":<1-5>}
{"action":"wait","seconds":<1-3>}
{"action":"done","summary":"<ce qui a ete accompli>"}

REGLES GAMING:
- En combat: cible les ennemis les plus dangereux en premier
- En dialogue: choisis les options les plus interessantes narrativement
- En exploration: cherche coffres, secrets, PNJs a qui parler
- Sauvegarde regulierement (F5 quick save si disponible)
- Lis attentivement les dialogues avant de choisir

`;

const GAME_DESCRIBE_PROMPT = `Tu es un expert en jeux video RPG. Decris ce que tu vois a l'ecran EN FRANCAIS.

Inclus:
1. **Scene**: Ou sommes-nous? Quel environnement?
2. **Personnages**: Qui est visible? Etat de sante?
3. **Interface**: Quels elements UI sont visibles (inventaire, quete, carte)?
4. **Situation**: Que se passe-t-il? Combat? Dialogue? Exploration?
5. **Options**: Quelles actions sont possibles maintenant?

Sois concis mais complet (3-4 paragraphes).`;

registerSkill({
  name: "game.play",
  description: "Kingston plays a video game autonomously — screenshot + AI vision + actions loop. Send game name and optional goal.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      game: { type: "string", description: "Game window title or process name (e.g. 'Shadowrun', 'Baldur')" },
      goal: { type: "string", description: "Optional specific goal (e.g. 'complete the current mission', 'talk to the NPC')" },
      turns: { type: "number", description: "Max iterations (default 25)" },
      chatId: { type: "string", description: "Telegram chat ID for screenshot updates" },
    },
    required: ["game"],
  },
  async execute(args) {
    const game = String(args.game);
    const goal = args.goal ? String(args.goal) : `Joue au jeu "${game}" de maniere optimale. Explore, combat, fais les quetes.`;
    const maxSteps = Number(args.turns) || 25;
    const chatId = args.chatId ? String(args.chatId) : undefined;

    // Use computer.use skill with gaming-optimized parameters
    const cuSkill = getSkill("computer.use");
    if (!cuSkill) return "Erreur: skill computer.use non chargee. Le controle desktop est requis.";

    log.info(`[game.play] Lancement: "${game}" — goal: "${goal.slice(0, 80)}" (max ${maxSteps} steps)`);

    // Log the gaming session start
    logEpisodicEvent("game_session_start", `Kingston joue a "${game}": ${goal.slice(0, 100)}`, {
      importance: 0.5,
      source: "game",
    });

    const result = await cuSkill.execute({
      goal: `${GAME_VISION_PROMPT}Jeu: ${game}\nObjectif: ${goal}`,
      app: game,
      maxSteps: String(maxSteps),
      chatId: chatId || "",
      quiet: chatId ? "false" : "true",
    });

    // Log the session end
    logEpisodicEvent("game_session_end", `Fin de session "${game}": ${String(result).slice(0, 150)}`, {
      importance: 0.4,
      source: "game",
    });

    return String(result);
  },
});

registerSkill({
  name: "game.look",
  description: "Take a screenshot of the game and describe what's happening on screen",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      game: { type: "string", description: "Game window title to focus (optional)" },
    },
  },
  async execute(args) {
    const { config } = await import("../../config/env.js");
    if (!config.geminiApiKey) return "Erreur: GEMINI_API_KEY requis pour la vision.";

    const game = args.game ? String(args.game) : undefined;

    // Focus game window if specified
    if (game) {
      try {
        const { execSync } = await import("node:child_process");
        execSync(`powershell -NoProfile -Command "
          Add-Type @'
          using System; using System.Runtime.InteropServices;
          public class GameFocus {
            [DllImport(\\"user32.dll\\")] public static extern bool SetForegroundWindow(IntPtr hWnd);
            [DllImport(\\"user32.dll\\")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
          }
'@
          $proc = Get-Process | Where-Object { $_.MainWindowTitle -like '*${game.replace(/'/g, "''")}*' } | Select-Object -First 1
          if ($proc -and $proc.MainWindowHandle -ne [IntPtr]::Zero) {
            [GameFocus]::ShowWindow($proc.MainWindowHandle, 9)
            [GameFocus]::SetForegroundWindow($proc.MainWindowHandle)
          }
        "`, { encoding: "utf-8", timeout: 5000 });
        await new Promise(r => setTimeout(r, 500));
      } catch { /* window may not exist */ }
    }

    // Take screenshot
    const os = await import("node:os");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const { execSync } = await import("node:child_process");

    const screenshotPath = path.join(os.tmpdir(), `kingston_game_${Date.now()}.png`);
    try {
      execSync(`powershell -NoProfile -Command "
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
        $bmp = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height)
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size)
        $bmp.Save('${screenshotPath.replace(/\\/g, "\\\\")}')
        $g.Dispose(); $bmp.Dispose()
      "`, { encoding: "utf-8", timeout: 10000 });
    } catch (err) {
      return `Erreur screenshot: ${err instanceof Error ? err.message : String(err)}`;
    }

    const screenshotBuffer = fs.readFileSync(screenshotPath);
    const base64 = screenshotBuffer.toString("base64");

    // Ask Gemini vision to describe
    try {
      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${config.geminiApiKey}`;
      const res = await fetch(geminiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [
            { inline_data: { mime_type: "image/png", data: base64 } },
            { text: GAME_DESCRIBE_PROMPT },
          ]}],
          generationConfig: { maxOutputTokens: 800, temperature: 0.3 },
        }),
      });

      if (!res.ok) throw new Error(`Gemini ${res.status}`);
      const data = await res.json() as any;
      const description = data.candidates?.[0]?.content?.parts?.[0]?.text || "Impossible de decrire l'ecran.";

      // Cleanup
      try { fs.unlinkSync(screenshotPath); } catch { /* */ }

      return `**Etat du jeu${game ? ` (${game})` : ""}:**\n\n${description}`;
    } catch (err) {
      return `Erreur vision: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

registerSkill({
  name: "game.command",
  description: "Execute a single action in the game (click, key press, etc.) via computer.use",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      action: { type: "string", description: "What to do (e.g. 'click on Attack button', 'press Space', 'move character north')" },
      game: { type: "string", description: "Game window to focus first (optional)" },
    },
    required: ["action"],
  },
  async execute(args) {
    const action = String(args.action);
    const game = args.game ? String(args.game) : undefined;

    const cuSkill = getSkill("computer.use");
    if (!cuSkill) return "Erreur: skill computer.use non chargee.";

    const result = await cuSkill.execute({
      goal: `Dans le jeu video: ${action}. Execute cette action unique puis reporte "done".`,
      app: game || "",
      maxSteps: "3", // Single action = few steps max
      quiet: "true",
    });

    return String(result);
  },
});

log.info("[game] 3 gaming skills registered (play, look, command)");
