/**
 * Voice HTTP + WebSocket server for Twilio integration.
 */
import http from "node:http";
import { WebSocketServer } from "ws";
import { config } from "../config/env.js";
import { log } from "../utils/log.js";
import { buildTwiml, buildOutboundTwiml } from "./twiml.js";
import { handleTwilioStream } from "./pipeline.js";

export function startVoiceServer(): void {
  if (!config.voiceEnabled) {
    log.info("[voice] Voice server disabled (VOICE_ENABLED=false)");
    return;
  }

  if (!config.deepgramApiKey) {
    log.warn("[voice] DEEPGRAM_API_KEY not set — calls will fail until configured");
  }
  if (!config.elevenlabsApiKey) {
    log.warn("[voice] ELEVENLABS_API_KEY not set — calls will fail until configured");
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
    log.info("[voice] New Twilio WebSocket connection");
    handleTwilioStream(ws);
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
  });
}
