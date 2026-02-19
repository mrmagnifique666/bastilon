/**
 * Voice HTTP + WebSocket server for Twilio integration.
 */
import http from "node:http";
import { WebSocketServer } from "ws";
import { config } from "../config/env.js";
import { log } from "../utils/log.js";
import { buildTwiml, buildOutboundTwiml } from "./twiml.js";
import { handleTwilioStreamLive } from "./pipelineLive.js";

export function startVoiceServer(): void {
  if (!config.voiceEnabled) {
    log.info("[voice] Voice server disabled (VOICE_ENABLED=false)");
    return;
  }

  if (!config.geminiApiKey) {
    log.warn("[voice] GEMINI_API_KEY not set — voice calls require Gemini Live");
  }

  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/voice/incoming") {
      const twiml = buildTwiml();
      res.writeHead(200, { "Content-Type": "text/xml" });
      res.end(twiml);
      log.info("[voice] Served TwiML for incoming call");
      return;
    }

    if (req.method === "POST" && req.url?.startsWith("/voice/outbound-twiml")) {
      const parsed = new URL(req.url, `http://localhost:${config.voicePort}`);
      const reason = parsed.searchParams.get("reason") || "Kingston vous appelle.";
      const twiml = buildOutboundTwiml(reason);
      res.writeHead(200, { "Content-Type": "text/xml" });
      res.end(twiml);
      log.info(`[voice] Served outbound TwiML — reason: ${reason.slice(0, 60)}`);
      return;
    }

    // ── SMS Webhook — Twilio sends incoming SMS here ──
    if (req.method === "POST" && req.url === "/sms/incoming") {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        try {
          const params = new URLSearchParams(body);
          const from = params.get("From") || "inconnu";
          const smsBody = params.get("Body") || "";
          const to = params.get("To") || "";
          log.info(`[sms] Incoming SMS from ${from}: ${smsBody.slice(0, 100)}`);

          // Forward to Telegram asynchronously
          (async () => {
            try {
              const { bot } = await import("../bot/bot.js");
              const adminChatId = config.telegramAdminChatId;
              if (adminChatId && bot) {
                const msg = `📱 **SMS reçu**\nDe: \`${from}\`\nÀ: \`${to}\`\n\n${smsBody}`;
                await bot.api.sendMessage(Number(adminChatId), msg, { parse_mode: "Markdown" });
                log.info(`[sms] Forwarded SMS to Telegram admin`);
              }
            } catch (err) {
              log.warn(`[sms] Failed to forward to Telegram: ${err instanceof Error ? err.message : String(err)}`);
            }
          })();

          // Reply with empty TwiML (acknowledge receipt, no auto-reply)
          res.writeHead(200, { "Content-Type": "text/xml" });
          res.end("<Response></Response>");
        } catch (err) {
          log.error(`[sms] Webhook error: ${err instanceof Error ? err.message : String(err)}`);
          res.writeHead(500);
          res.end("Error");
        }
      });
      return;
    }

    if (req.method === "GET" && req.url === "/voice/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    res.writeHead(404);
    res.end("Not Found");
  });

  // Use noServer mode so WSS doesn't re-emit HTTP server errors
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws) => {
    log.info("[voice] New Twilio WebSocket connection (Gemini Live pipeline)");
    handleTwilioStreamLive(ws);
  });

  server.on("upgrade", (req, socket, head) => {
    if (req.url === "/voice/stream") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      log.error(`[voice] Port ${config.voicePort} already in use — voice server not started`);
    } else {
      log.error(`[voice] Server error: ${err.message}`);
    }
  });

  server.listen(config.voicePort, () => {
    log.info(`[voice] Server listening on port ${config.voicePort}`);
    log.info(`[voice] TwiML endpoint: POST /voice/incoming`);
    log.info(`[voice] Stream endpoint: WSS /voice/stream`);
    if (config.voicePublicUrl) {
      log.info(`[voice] Public URL: ${config.voicePublicUrl}`);
    }

    // Auto-update Twilio webhooks when tunnel URL is configured
    updateTwilioWebhooks().catch((err) => {
      log.warn(`[voice] Twilio webhook update failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  });
}

/**
 * Automatically update Twilio phone number webhooks (Voice + SMS)
 * so the Cloudflare tunnel URL stays in sync after restarts.
 */
async function updateTwilioWebhooks(): Promise<void> {
  const { voicePublicUrl, twilioAccountSid, twilioAuthToken, twilioPhoneNumber } = config;

  // Guard: all four config values must be present
  if (!voicePublicUrl || !twilioAccountSid || !twilioAuthToken || !twilioPhoneNumber) {
    log.debug("[voice] Skipping Twilio webhook update — missing config (VOICE_PUBLIC_URL, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, or TWILIO_PHONE_NUMBER)");
    return;
  }

  const authHeader = "Basic " + Buffer.from(`${twilioAccountSid}:${twilioAuthToken}`).toString("base64");
  const baseUrl = `https://api.twilio.com/2010-04-01/Accounts/${twilioAccountSid}`;

  // Step 1: Look up the phone number SID
  const lookupUrl = `${baseUrl}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(twilioPhoneNumber)}`;
  log.info(`[voice] Looking up Twilio phone number SID for ${twilioPhoneNumber}...`);

  const lookupRes = await fetch(lookupUrl, {
    method: "GET",
    headers: { Authorization: authHeader },
  });

  if (!lookupRes.ok) {
    const errBody = await lookupRes.text();
    throw new Error(`Twilio lookup failed (${lookupRes.status}): ${errBody.slice(0, 200)}`);
  }

  const lookupData = (await lookupRes.json()) as {
    incoming_phone_numbers: Array<{ sid: string; phone_number: string }>;
  };

  if (!lookupData.incoming_phone_numbers || lookupData.incoming_phone_numbers.length === 0) {
    throw new Error(`No Twilio phone number found matching ${twilioPhoneNumber}`);
  }

  const phoneNumberSid = lookupData.incoming_phone_numbers[0].sid;
  log.info(`[voice] Found phone number SID: ${phoneNumberSid}`);

  // Step 2: Update webhooks on the phone number
  const voiceUrl = `${voicePublicUrl}/voice/incoming`;
  const smsUrl = `${voicePublicUrl}/sms/incoming`;
  const updateUrl = `${baseUrl}/IncomingPhoneNumbers/${phoneNumberSid}.json`;

  const body = new URLSearchParams({
    VoiceUrl: voiceUrl,
    VoiceMethod: "POST",
    SmsUrl: smsUrl,
    SmsMethod: "POST",
  });

  const updateRes = await fetch(updateUrl, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  if (!updateRes.ok) {
    const errBody = await updateRes.text();
    throw new Error(`Twilio update failed (${updateRes.status}): ${errBody.slice(0, 200)}`);
  }

  log.info(`[voice] Twilio webhooks updated successfully:`);
  log.info(`[voice]   Voice URL → ${voiceUrl}`);
  log.info(`[voice]   SMS URL   → ${smsUrl}`);
}
