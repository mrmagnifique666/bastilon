/**
 * Google OAuth2 authentication — shared client for Gmail + Calendar.
 * Loads credentials/token, provides lazy singletons for both APIs.
 */
import fs from "node:fs";
import path from "node:path";
import { google, gmail_v1, calendar_v3 } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import { config } from "../config/env.js";
import { log } from "../utils/log.js";

export const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar",
];

let oauth2ClientCache: OAuth2Client | null = null;
let cachedGmail: gmail_v1.Gmail | null = null;
let cachedCalendar: calendar_v3.Calendar | null = null;

interface Credentials {
  installed?: {
    client_id: string;
    client_secret: string;
    redirect_uris: string[];
  };
  web?: {
    client_id: string;
    client_secret: string;
    redirect_uris: string[];
  };
}

function resolveConfigPath(p: string): string {
  return path.resolve(p);
}

export function loadCredentials(): Credentials {
  const p = resolveConfigPath(config.gmailCredentialsPath);
  if (!fs.existsSync(p)) {
    throw new Error(`Google credentials not found at ${p}. Download from Google Cloud Console.`);
  }
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

export function loadToken(): Record<string, unknown> | null {
  const p = resolveConfigPath(config.gmailTokenPath);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

export function saveToken(token: Record<string, unknown>): void {
  const p = resolveConfigPath(config.gmailTokenPath);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(token, null, 2));
  log.info("[google] Token saved");
}

export function createOAuth2Client(credentials: Credentials, redirectUri?: string): OAuth2Client {
  const cred = credentials.installed || credentials.web;
  if (!cred) throw new Error("Invalid credentials.json — missing installed or web key");
  return new google.auth.OAuth2(cred.client_id, cred.client_secret, redirectUri || cred.redirect_uris[0]);
}

export function getAuthUrl(oauth2Client: OAuth2Client): string {
  return oauth2Client.generateAuthUrl({ access_type: "offline", scope: SCOPES, prompt: "consent" });
}

/** Get (or create) the shared authenticated OAuth2 client. */
function getOAuth2Client(): OAuth2Client {
  if (oauth2ClientCache) return oauth2ClientCache;

  const credentials = loadCredentials();
  const token = loadToken();
  if (!token) {
    throw new Error("Google token not found. Run `npm run gmail:auth` first.");
  }

  const client = createOAuth2Client(credentials);
  client.setCredentials(token as any);

  // Auto-save refreshed tokens
  client.on("tokens", (newTokens) => {
    const current = loadToken() || {};
    const merged = { ...current, ...newTokens };
    saveToken(merged);
    log.info("[google] Token auto-refreshed");
  });

  oauth2ClientCache = client;
  return client;
}

/** Returns a ready-to-use Gmail API client (lazy singleton). */
export function getGmailClient(): gmail_v1.Gmail {
  if (cachedGmail) return cachedGmail;
  const auth = getOAuth2Client();
  cachedGmail = google.gmail({ version: "v1", auth });
  log.info("[google] Gmail client initialized");
  return cachedGmail;
}

/** Returns a ready-to-use Calendar API client (lazy singleton). */
export function getCalendarClient(): calendar_v3.Calendar {
  if (cachedCalendar) return cachedCalendar;
  const auth = getOAuth2Client();
  cachedCalendar = google.calendar({ version: "v3", auth });
  log.info("[google] Calendar client initialized");
  return cachedCalendar;
}
