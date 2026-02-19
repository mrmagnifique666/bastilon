/**
 * Chrome CDP connection manager.
 * Connects to Nicolas's real Chrome browser via Chrome DevTools Protocol (port 9222).
 * This gives access to all logged-in sessions (Facebook, Google, etc.) without needing
 * to store credentials or re-authenticate.
 *
 * Strategy:
 *   1. Test if port 9222 already responds → use directly
 *   2. If Chrome runs without CDP → relaunch with --remote-debugging-port=9222
 *   3. If Chrome not open → launch with CDP enabled
 */
import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { log } from "../utils/log.js";

const CDP_PORT = 9222;
const CDP_URL = `http://localhost:${CDP_PORT}`;

/** Detect Chrome user data dir (Windows default profile). */
function getChromeUserDataDir(): string {
  return path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
    "Google", "Chrome", "User Data"
  );
}

/** Detect Chrome executable path (Windows). */
function getChromePath(): string {
  const candidates = [
    path.join(process.env["PROGRAMFILES"] || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return "chrome.exe"; // fallback — let PATH resolve it
}

/** Check if Chrome CDP is already responding on port 9222. */
export async function isCdpAvailable(): Promise<boolean> {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 2000);
    const res = await fetch(`${CDP_URL}/json/version`, { signal: ac.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

/** Get the CDP WebSocket debugger URL. */
export async function getCdpWsUrl(): Promise<string | null> {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 2000);
    const res = await fetch(`${CDP_URL}/json/version`, { signal: ac.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const data = await res.json() as { webSocketDebuggerUrl?: string };
    return data.webSocketDebuggerUrl || null;
  } catch {
    return null;
  }
}

/** Check if Chrome.exe is running (any instance). */
export function isChromeRunning(): boolean {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq chrome.exe" /NH', {
      encoding: "utf-8",
      timeout: 5000,
    });
    return out.toLowerCase().includes("chrome.exe");
  } catch {
    return false;
  }
}

/** Kill all Chrome processes gracefully. */
function killChrome(): void {
  try {
    execSync('taskkill /IM chrome.exe /F', { timeout: 10000, stdio: "ignore" });
    // Give it a moment to fully exit
  } catch {
    // May fail if no chrome is running
  }
}

/** Wait for CDP to become available after launching Chrome. */
async function waitForCdp(maxWaitMs = 10000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (await isCdpAvailable()) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

/**
 * Launch Chrome with CDP enabled, using Nicolas's real profile.
 * Uses `--remote-debugging-port=9222` and `--user-data-dir` pointing to the real Chrome profile.
 */
export async function launchChromeWithCdp(): Promise<void> {
  const chromePath = getChromePath();
  const userDataDir = getChromeUserDataDir();

  log.info(`[chrome-cdp] Launching Chrome with CDP on port ${CDP_PORT}`);
  log.info(`[chrome-cdp] Chrome: ${chromePath}`);
  log.info(`[chrome-cdp] Profile: ${userDataDir}`);

  const child = spawn(chromePath, [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${userDataDir}`,
    "--restore-last-session",
    "--no-first-run",
    "--no-default-browser-check",
  ], {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref();

  // Wait for CDP to be ready
  const ready = await waitForCdp(12000);
  if (!ready) {
    throw new Error("Chrome launched but CDP did not respond within 12s");
  }
  log.info("[chrome-cdp] Chrome ready with CDP");
}

/**
 * Ensure Chrome is running with CDP enabled. Returns the WebSocket URL.
 *
 * 1. If CDP already responds → return ws URL
 * 2. If Chrome running without CDP → kill & relaunch with CDP
 * 3. If Chrome not running → launch with CDP
 */
export async function ensureChromeWithCdp(): Promise<string> {
  // Step 1: Already available?
  const wsUrl = await getCdpWsUrl();
  if (wsUrl) {
    log.debug("[chrome-cdp] CDP already available");
    return wsUrl;
  }

  // Step 2: Chrome running without CDP?
  if (isChromeRunning()) {
    log.info("[chrome-cdp] Chrome running without CDP — relaunching...");
    killChrome();
    await new Promise(r => setTimeout(r, 2000)); // wait for full exit
  }

  // Step 3: Launch Chrome with CDP
  await launchChromeWithCdp();

  const newWsUrl = await getCdpWsUrl();
  if (!newWsUrl) {
    throw new Error("Failed to get CDP WebSocket URL after launching Chrome");
  }
  return newWsUrl;
}

/**
 * List all open tabs in Chrome via CDP.
 * Returns array of { id, url, title, type, webSocketDebuggerUrl }.
 */
export async function listTabs(): Promise<Array<{
  id: string;
  url: string;
  title: string;
  type: string;
  webSocketDebuggerUrl?: string;
}>> {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 3000);
    const res = await fetch(`${CDP_URL}/json/list`, { signal: ac.signal });
    clearTimeout(t);
    if (!res.ok) return [];
    return await res.json() as any[];
  } catch {
    return [];
  }
}

/**
 * One-time setup: Create a Windows shortcut that always launches Chrome with CDP.
 * Places it on the desktop for easy access.
 */
export async function setupChromeShortcut(): Promise<string> {
  const chromePath = getChromePath();
  const userDataDir = getChromeUserDataDir();
  const desktopPath = path.join(os.homedir(), "Desktop");
  const shortcutName = "Chrome (Kingston CDP).lnk";
  const shortcutPath = path.join(desktopPath, shortcutName);

  // Create .vbs script to make shortcut (Windows native way)
  const vbsContent = `
Set oWS = WScript.CreateObject("WScript.Shell")
Set oLink = oWS.CreateShortcut("${shortcutPath.replace(/\\/g, "\\\\")}")
oLink.TargetPath = "${chromePath.replace(/\\/g, "\\\\")}"
oLink.Arguments = "--remote-debugging-port=${CDP_PORT} --user-data-dir=""${userDataDir.replace(/\\/g, "\\\\")}"" --restore-last-session --no-first-run"
oLink.Description = "Chrome with Kingston CDP enabled"
oLink.Save
`.trim();

  const vbsPath = path.join(os.tmpdir(), "kingston_chrome_shortcut.vbs");
  fs.writeFileSync(vbsPath, vbsContent, "utf-8");

  try {
    execSync(`cscript //nologo "${vbsPath}"`, { timeout: 10000, stdio: "ignore" });
    log.info(`[chrome-cdp] Shortcut created: ${shortcutPath}`);
    return shortcutPath;
  } finally {
    try { fs.unlinkSync(vbsPath); } catch { /* ignore */ }
  }
}
