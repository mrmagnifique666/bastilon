/**
 * Wake Word Listener — Browser-based via Web Speech API.
 *
 * Instead of native libraries (Picovoice, Vosk), the wake word listener
 * runs in the browser at http://localhost:3200/listen.html.
 *
 * Flow:
 *   1. User opens /listen.html in Chrome/Edge
 *   2. Web Speech API continuously transcribes microphone input (free, no API key)
 *   3. On "Kingston" detection → captures command
 *   4. Sends to /api/chat/kingston → gets response
 *   5. Plays TTS via /api/tts (ElevenLabs)
 *
 * This module tracks state and provides the skills interface.
 * The actual listening happens client-side in the browser.
 */
import { config } from "../config/env.js";
import { log } from "../utils/log.js";

// State (tracks browser-side listener)
let browserActive = false;
let wakeWord = (process.env["WAKEWORD_KEYWORD"] || "kingston").toLowerCase();
let lastPing = 0;

/**
 * Mark the listener as started (browser tab opened).
 * Returns the URL for the listener page.
 */
export async function startWakeWord(): Promise<boolean> {
  const port = Number(process.env.DASHBOARD_PORT) || 3200;
  const url = `http://localhost:${port}/listen.html`;

  browserActive = true;
  log.info(`[wakeword] Browser-based listener ready at ${url}`);

  // Try to open browser automatically on Windows
  try {
    const { exec } = await import("node:child_process");
    exec(`start "" "${url}"`, (err) => {
      if (err) log.debug(`[wakeword] Could not auto-open browser: ${err.message}`);
    });
  } catch {
    // Manual open is fine
  }

  return true;
}

/**
 * Mark listener as stopped.
 */
export function stopWakeWord(): void {
  browserActive = false;
  log.info("[wakeword] Listener marked as inactive");
}

/**
 * Get current listener status.
 */
export function getWakeWordStatus(): {
  listening: boolean;
  keyword: string;
  processing: boolean;
  mode: string;
  url: string;
} {
  const port = Number(process.env.DASHBOARD_PORT) || 3200;
  return {
    listening: browserActive,
    keyword: wakeWord,
    processing: false,
    mode: "browser",
    url: `http://localhost:${port}/listen.html`,
  };
}

/**
 * Called from dashboard API to update browser-side state.
 */
export function updateBrowserState(active: boolean, keyword?: string): void {
  browserActive = active;
  if (keyword) wakeWord = keyword.toLowerCase();
  lastPing = Date.now();
  log.debug(`[wakeword] Browser state updated: active=${active}, keyword=${wakeWord}`);
}
