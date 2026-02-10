/**
 * Generates TwiML XML response for incoming Twilio calls.
 */
import { config } from "../config/env.js";

function getStreamUrl(): string {
  return config.voicePublicUrl
    ? `${config.voicePublicUrl.replace(/^http/, "ws")}/voice/stream`
    : `wss://localhost:${config.voicePort}/voice/stream`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function buildTwiml(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<Response>",
    `  <Say voice="alice" language="${config.voiceLanguage === "fr" ? "fr-FR" : "en-US"}">Bonjour, je suis Kingston.</Say>`,
    `  <Connect><Stream url="${getStreamUrl()}" /></Connect>`,
    "</Response>",
  ].join("\n");
}

export function buildOutboundTwiml(reason: string): string {
  const lang = config.voiceLanguage === "fr" ? "fr-FR" : "en-US";
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<Response>",
    `  <Say voice="alice" language="${lang}">${escapeXml(reason)}</Say>`,
    '  <Pause length="1"/>',
    `  <Connect><Stream url="${getStreamUrl()}" /></Connect>`,
    "</Response>",
  ].join("\n");
}
