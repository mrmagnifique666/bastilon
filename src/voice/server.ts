/**
 * Voice HTTP + WebSocket server for Twilio integration.
 */
import http from "node:http";
import { WebSocketServer } from "ws";
import { config } from "../config/env.js";
import { log } from "../utils/log.js";
import { buildTwiml, buildOutboundTwiml, buildGatherTwiml, buildTurnReplyTwiml } from "./twiml.js";
import { handleTwilioStreamLive } from "./pipelineLive.js";
import { isBridgeEnabled, getConversationHistory, askNoah } from "./noahBridge.js";
import fs from "node:fs";
import path from "node:path";

async function generateFallbackVoiceReply(userText: string): Promise<string> {
  const input = (userText || "").trim();
  if (!input) return "Je n'ai pas bien entendu. Peux-tu répéter en une phrase?";
  if (!config.geminiApiKey) return "Je t'entends, mais je suis en mode limité. Réessaie dans un instant.";

  try {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${config.geminiApiKey}`;
    const prompt = `Tu es Kingston, l'assistant IA personnel de Nicolas, et tu agis comme réceptionniste au téléphone. Tu es professionnel mais chaleureux, tu tutoies Nicolas. Tu peux aider avec: son agenda, ses rappels, prendre des messages, donner des infos sur ses projets (trading, Bastilon OS, t-shirts). Réponse concise, naturelle, en français (2-3 phrases max). Si tu ne sais pas, dis-le honnêtement. Message de Nicolas: ${input}`;
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.6, maxOutputTokens: 180 },
      }),
    });
    const data = await resp.json().catch(() => ({}));
    const out = data?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text || "").join(" ").trim();
    if (!resp.ok || !out) return "J'ai eu un petit bug technique, mais je suis là. Réessaie ta question.";
    return out;
  } catch {
    return "Petit bug technique de mon côté. Réessaie dans quelques secondes.";
  }
}

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
      // Stable mode: turn-based Gather -> Noah bridge (no realtime stream dependency)
      const mode = (process.env.VOICE_MODE || "").toLowerCase();
      if (mode === "stable_turn" && isBridgeEnabled()) {
        const twiml = buildGatherTwiml("Je t'écoute. Parle après le bip.");
        res.writeHead(200, { "Content-Type": "text/xml" });
        res.end(twiml);
        log.info("[voice] Served Gather TwiML (stable_turn mode)");
        return;
      }

      const twiml = buildTwiml();
      res.writeHead(200, { "Content-Type": "text/xml" });
      res.end(twiml);
      log.info("[voice] Served TwiML for incoming call");
      return;
    }

    // Turn-based voice loop (stable mode)
    if (req.method === "POST" && req.url === "/voice/turn") {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", async () => {
        try {
          const params = new URLSearchParams(body);
          const speech = (params.get("SpeechResult") || "").trim();
          const callSid = params.get("CallSid") || undefined;

          let reply = "Je n'ai pas bien entendu. Peux-tu répéter en une phrase?";
          if (speech) {
            // Try Noah bridge only if enabled; otherwise go straight to Gemini
            if (isBridgeEnabled()) {
              reply = await askNoah(speech, {
                type: "voice_turn",
                callSid,
                lang: config.voiceLanguage || "fr",
                timeoutMs: Number(config.noahBridgeTimeoutMs || 12000),
              });
            }

            // Fallback to local Gemini text reply if bridge disabled or Noah didn't respond
            if (!isBridgeEnabled() || !reply || /Noah n'a pas répondu|Réessaie dans un instant/i.test(reply)) {
              reply = await generateFallbackVoiceReply(speech);
            }
          }

          const twiml = buildTurnReplyTwiml(reply);
          res.writeHead(200, { "Content-Type": "text/xml" });
          res.end(twiml);
          log.info(`[voice] /voice/turn handled. speech=${speech.length} chars`);
        } catch (err) {
          log.error(`[voice] /voice/turn error: ${err instanceof Error ? err.message : String(err)}`);
          const twiml = buildTurnReplyTwiml("Petit bug technique. Réessaie dans quelques secondes.");
          res.writeHead(200, { "Content-Type": "text/xml" });
          res.end(twiml);
        }
      });
      return;
    }

    if (req.method === "POST" && req.url?.startsWith("/voice/outbound-twiml")) {
      const parsed = new URL(req.url, `http://localhost:${config.voicePort}`);
      const reason = parsed.searchParams.get("reason") || "Kingston vous appelle.";
      const mode = (process.env.VOICE_MODE || "").toLowerCase();
      let twiml: string;
      if (mode === "stable_turn") {
        twiml = buildGatherTwiml(reason);
        log.info(`[voice] Served outbound Gather TwiML (stable_turn) — reason: ${reason.slice(0, 60)}`);
      } else {
        twiml = buildOutboundTwiml(reason);
        log.info(`[voice] Served outbound Stream TwiML — reason: ${reason.slice(0, 60)}`);
      }
      res.writeHead(200, { "Content-Type": "text/xml" });
      res.end(twiml);
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

    // ── Noah Bridge endpoints ──
    // Noah reads Kingston's messages (inbox)
    if (req.method === "GET" && req.url === "/bridge/noah/inbox") {
      if (!isBridgeEnabled()) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Bridge disabled" }));
        return;
      }
      const inbox = config.noahBridgeInbox || "data/kingston-to-noah.jsonl";
      if (fs.existsSync(inbox)) {
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        res.end(fs.readFileSync(inbox, "utf8"));
      } else {
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        res.end("");
      }
      return;
    }

    // Noah writes replies (outbox)
    if (req.method === "POST" && req.url === "/bridge/noah/reply") {
      if (!isBridgeEnabled()) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Bridge disabled" }));
        return;
      }
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        try {
          const reply = JSON.parse(body);
          const outbox = config.noahBridgeOutbox || "data/noah-to-kingston.jsonl";
          const dir = path.dirname(outbox);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.appendFileSync(outbox, JSON.stringify(reply) + "\n", "utf8");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          log.info(`[noah-bridge] Noah replied: ${(reply.msg || "").slice(0, 60)}`);
        } catch (err) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON" }));
        }
      });
      return;
    }

    // Full conversation history (both directions)
    if (req.method === "GET" && req.url === "/bridge/noah/history") {
      if (!isBridgeEnabled()) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Bridge disabled" }));
        return;
      }
      const history = getConversationHistory(50);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(history));
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
