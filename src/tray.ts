/**
 * Kingston Tray Icon — Windows system tray wrapper.
 * Launches Kingston as a background process with a tray icon for status/control.
 *
 * Usage: npx tsx src/tray.ts
 * Or:    npm run start:tray
 */
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import SysTrayModule from "systray2";
const SysTray = (SysTrayModule as any).default || SysTrayModule;

const ROOT = path.resolve(import.meta.dirname, "..");
const LOG_FILE = path.join(ROOT, "relay", "kingston.log");
const LOCK_FILE = path.join(ROOT, "relay", "bot.lock");

// Base64-encoded 16x16 ICO (green circle — Kingston is alive)
// Minimal 1-color icon to avoid external dependencies
const ICON_GREEN = fs.existsSync(path.join(ROOT, "relay", "icon.ico"))
  ? fs.readFileSync(path.join(ROOT, "relay", "icon.ico")).toString("base64")
  : ""; // Falls back to default if no icon file

let kingston: ChildProcess | null = null;
let isRunning = false;

function startKingston(): void {
  if (isRunning) {
    console.log("[tray] Kingston already running");
    return;
  }

  // Remove stale lock
  try { fs.unlinkSync(LOCK_FILE); } catch { /* ok */ }

  // Open log file for writing
  const logStream = fs.createWriteStream(LOG_FILE, { flags: "a" });
  const timestamp = () => new Date().toISOString();

  logStream.write(`\n[${timestamp()}] === Kingston starting via tray ===\n`);

  kingston = spawn("npx", ["tsx", "src/wrapper.ts"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
    env: { ...process.env, FORCE_COLOR: "0" },
  });

  kingston.stdout?.on("data", (data: Buffer) => {
    logStream.write(data);
    // Detect successful startup
    if (data.toString().includes("Bot online")) {
      isRunning = true;
      updateTray("Kingston Online", true);
      console.log("[tray] Kingston is online");
    }
  });

  kingston.stderr?.on("data", (data: Buffer) => {
    logStream.write(`[STDERR] ${data}`);
  });

  kingston.on("exit", (code) => {
    isRunning = false;
    logStream.write(`[${timestamp()}] === Kingston exited (code ${code}) ===\n`);
    logStream.end();
    updateTray("Kingston Offline", false);
    console.log(`[tray] Kingston exited with code ${code}`);
    kingston = null;
  });

  updateTray("Kingston Starting...", false);
}

function stopKingston(): void {
  if (!kingston) {
    console.log("[tray] Kingston not running");
    return;
  }

  console.log("[tray] Stopping Kingston...");
  kingston.kill("SIGTERM");

  // Force kill after 5s
  setTimeout(() => {
    if (kingston && !kingston.killed) {
      kingston.kill("SIGKILL");
    }
  }, 5000);
}

function restartKingston(): void {
  if (kingston) {
    kingston.on("exit", () => {
      setTimeout(startKingston, 1000);
    });
    stopKingston();
  } else {
    startKingston();
  }
}

function openLogs(): void {
  spawn("notepad", [LOG_FILE], { detached: true, stdio: "ignore" }).unref();
}

function openDashboard(): void {
  spawn("cmd", ["/c", "start", "http://localhost:3200"], {
    detached: true,
    stdio: "ignore",
  }).unref();
}

// --- Tray setup ---

let systray: SysTray | null = null;

function updateTray(tooltip: string, _online: boolean): void {
  // systray2 doesn't support dynamic icon update easily,
  // but we update the tooltip via menu rebuild if needed
  if (systray) {
    try {
      (systray as any).kill?.(false); // Don't exit process
    } catch { /* ok */ }
  }
}

function buildMenu() {
  return {
    icon: ICON_GREEN,
    title: "",
    tooltip: isRunning ? "Kingston Online" : "Kingston Offline",
    items: [
      {
        title: isRunning ? "Kingston — Online" : "Kingston — Offline",
        tooltip: "Status",
        enabled: false,
      },
      SysTray.separator,
      {
        title: isRunning ? "Restart" : "Start",
        tooltip: isRunning ? "Restart Kingston" : "Start Kingston",
        enabled: true,
      },
      {
        title: "Stop",
        tooltip: "Stop Kingston",
        enabled: isRunning,
      },
      SysTray.separator,
      {
        title: "Dashboard",
        tooltip: "Open dashboard in browser",
        enabled: true,
      },
      {
        title: "View Logs",
        tooltip: "Open log file",
        enabled: true,
      },
      SysTray.separator,
      {
        title: "Quit",
        tooltip: "Stop Kingston and exit tray",
        enabled: true,
      },
    ],
  };
}

async function main(): Promise<void> {
  console.log("[tray] Kingston Tray starting...");

  systray = new SysTray({
    menu: buildMenu(),
    copyDir: false,
  });

  await systray.ready();
  console.log("[tray] Tray icon ready");

  systray.onClick((action) => {
    const idx = action.seq_id;
    switch (idx) {
      case 2: // Start/Restart
        restartKingston();
        break;
      case 3: // Stop
        stopKingston();
        break;
      case 5: // Dashboard
        openDashboard();
        break;
      case 6: // View Logs
        openLogs();
        break;
      case 8: // Quit
        stopKingston();
        setTimeout(() => {
          systray?.kill(true);
          process.exit(0);
        }, 2000);
        break;
    }
  });

  // Auto-start Kingston
  startKingston();

  // Handle process exit
  process.on("SIGINT", () => {
    stopKingston();
    systray?.kill(true);
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    stopKingston();
    systray?.kill(true);
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("[tray] Fatal error:", err);
  process.exit(1);
});
