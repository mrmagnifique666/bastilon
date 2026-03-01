/**
 * Auto-tunnel — spawns a cloudflared quick tunnel pointing at the voice server
 * and captures the generated URL. Updates .env + Twilio webhooks automatically.
 *
 * Flow:
 *   1. Spawn `cloudflared tunnel --url http://localhost:<VOICE_PORT>`
 *   2. Parse stderr for the *.trycloudflare.com URL
 *   3. Update VOICE_PUBLIC_URL in .env
 *   4. Twilio webhooks are updated by the voice server's startVoiceServer()
 *
 * The tunnel process is kept alive for the lifetime of the parent process.
 * If it dies, it's restarted automatically after 5 seconds.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

const ENV_PATH = path.resolve(".env");
const TUNNEL_URL_REGEX = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const RESTART_DELAY_MS = 5_000;
const URL_TIMEOUT_MS = 30_000;

let tunnelProcess: ChildProcess | null = null;
let currentUrl: string | null = null;
let stopped = false;

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [tunnel] ${msg}`);
}

/**
 * Update VOICE_PUBLIC_URL in .env file.
 * Replaces existing line or appends if missing.
 */
function updateEnvFile(url: string): void {
  if (!fs.existsSync(ENV_PATH)) {
    log(`WARNING: .env not found at ${ENV_PATH}`);
    return;
  }

  let content = fs.readFileSync(ENV_PATH, "utf8");
  const regex = /^VOICE_PUBLIC_URL=.*$/m;

  if (regex.test(content)) {
    content = content.replace(regex, `VOICE_PUBLIC_URL=${url}`);
  } else {
    content += `\nVOICE_PUBLIC_URL=${url}\n`;
  }

  fs.writeFileSync(ENV_PATH, content, "utf8");
  // Also update process.env so the current process picks it up
  process.env.VOICE_PUBLIC_URL = url;
  log(`Updated .env: VOICE_PUBLIC_URL=${url}`);
}

/**
 * Update Twilio phone number webhooks to point at the new tunnel URL.
 */
async function updateTwilioWebhooks(url: string): Promise<void> {
  dotenv.config({ override: true });
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const phone = process.env.TWILIO_PHONE_NUMBER;

  if (!sid || !token || !phone) {
    log("Skipping Twilio webhook update — missing credentials");
    return;
  }

  const auth = Buffer.from(`${sid}:${token}`).toString("base64");
  const baseUrl = `https://api.twilio.com/2010-04-01/Accounts/${sid}`;

  try {
    // Look up phone number SID
    const lookupRes = await fetch(
      `${baseUrl}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(phone)}`,
      { headers: { Authorization: `Basic ${auth}` } },
    );

    if (!lookupRes.ok) {
      log(`Twilio lookup failed: ${lookupRes.status}`);
      return;
    }

    const lookupData = (await lookupRes.json()) as {
      incoming_phone_numbers: Array<{ sid: string }>;
    };

    if (!lookupData.incoming_phone_numbers?.length) {
      log(`No Twilio phone number found for ${phone}`);
      return;
    }

    const phoneSid = lookupData.incoming_phone_numbers[0].sid;

    // Update webhooks
    const body = new URLSearchParams({
      VoiceUrl: `${url}/voice/incoming`,
      VoiceMethod: "POST",
      SmsUrl: `${url}/sms/incoming`,
      SmsMethod: "POST",
    });

    const updateRes = await fetch(`${baseUrl}/IncomingPhoneNumbers/${phoneSid}.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    if (updateRes.ok) {
      log(`Twilio webhooks updated → ${url}/voice/incoming`);
    } else {
      log(`Twilio webhook update failed: ${updateRes.status}`);
    }
  } catch (err) {
    log(`Twilio webhook update error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Spawn cloudflared and wait for the tunnel URL.
 * Returns the URL or null on timeout.
 */
function spawnTunnel(port: number): Promise<string | null> {
  return new Promise((resolve) => {
    let resolved = false;

    const proc = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${port}`], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    tunnelProcess = proc;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        log("Timeout waiting for tunnel URL");
        resolve(null);
      }
    }, URL_TIMEOUT_MS);

    function handleData(data: Buffer) {
      const line = data.toString();
      const match = line.match(TUNNEL_URL_REGEX);
      if (match && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve(match[0]);
      }
    }

    proc.stdout?.on("data", handleData);
    proc.stderr?.on("data", handleData);

    proc.on("error", (err) => {
      log(`cloudflared spawn error: ${err.message}`);
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve(null);
      }
    });

    proc.on("exit", (code) => {
      log(`cloudflared exited with code ${code}`);
      tunnelProcess = null;

      if (!stopped) {
        log(`Restarting tunnel in ${RESTART_DELAY_MS / 1000}s...`);
        setTimeout(() => {
          if (!stopped) {
            startTunnel(port).catch(() => {});
          }
        }, RESTART_DELAY_MS);
      }
    });
  });
}

/**
 * Start the tunnel, update .env and Twilio webhooks.
 * Call this from wrapper.ts before starting the bot.
 */
export async function startTunnel(port?: number): Promise<string | null> {
  const voicePort = port || Number(process.env.VOICE_PORT || "3100");
  stopped = false;

  log(`Starting cloudflared tunnel → localhost:${voicePort}`);

  const url = await spawnTunnel(voicePort);
  if (!url) {
    log("Failed to get tunnel URL");
    return null;
  }

  currentUrl = url;
  log(`Tunnel active: ${url}`);

  // Update .env so the relay process picks up the URL
  updateEnvFile(url);

  // Update Twilio webhooks immediately
  await updateTwilioWebhooks(url);

  return url;
}

/**
 * Stop the tunnel process.
 */
export function stopTunnel(): void {
  stopped = true;
  if (tunnelProcess) {
    log("Stopping cloudflared tunnel");
    tunnelProcess.kill();
    tunnelProcess = null;
  }
}

/**
 * Get the current tunnel URL (if running).
 */
export function getTunnelUrl(): string | null {
  return currentUrl;
}
