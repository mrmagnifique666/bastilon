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

export function buildGatherTwiml(prompt?: string): string {
  const voice = config.voiceLanguage === "fr" ? "Polly.Mathieu" : "Polly.Matthew";
  const lang = config.voiceLanguage === "fr" ? "fr-FR" : "en-US";
  const greeting = escapeXml(config.voiceGreeting || "Bonjour, ici Kingston.");
  const sayPrompt = escapeXml(prompt || "Je t'écoute.");

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<Response>",
    `  <Say voice="${voice}" language="${lang}">${greeting}</Say>`,
    `  <Gather input="speech" language="${lang}" speechTimeout="auto" action="/voice/turn" method="POST">`,
    `    <Say voice="${voice}" language="${lang}">${sayPrompt}</Say>`,
    "  </Gather>",
    '  <Redirect method="POST">/voice/incoming</Redirect>',
    "</Response>",
  ].join("\n");
}

export function buildTurnReplyTwiml(reply: string): string {
  const voice = config.voiceLanguage === "fr" ? "Polly.Mathieu" : "Polly.Matthew";
  const lang = config.voiceLanguage === "fr" ? "fr-FR" : "en-US";
  const safeReply = escapeXml(reply || "Je n'ai pas bien entendu. Peux-tu répéter?");

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<Response>",
    `  <Say voice="${voice}" language="${lang}">${safeReply}</Say>`,
    '  <Redirect method="POST">/voice/incoming</Redirect>',
    "</Response>",
  ].join("\n");
}

export function buildTwiml(): string {
  const voice = config.voiceLanguage === "fr" ? "Polly.Mathieu" : "Polly.Matthew";
  const lang = config.voiceLanguage === "fr" ? "fr-FR" : "en-US";
  const greeting = escapeXml(config.voiceGreeting || "Bonjour, ici Kingston.");

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<Response>",
    `  <Say voice="${voice}" language="${lang}">${greeting}</Say>`,
    '  <Pause length="1"/>',
    `  <Connect><Stream url="${getStreamUrl()}" /></Connect>`,
    "</Response>",
  ].join("\n");
}

export function buildOutboundTwiml(reason: string): string {
  const voice = config.voiceLanguage === "fr" ? "Polly.Mathieu" : "Polly.Matthew";
  const lang = config.voiceLanguage === "fr" ? "fr-FR" : "en-US";
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<Response>",
    `  <Say voice="${voice}" language="${lang}">${escapeXml(reason)}</Say>`,
    '  <Pause length="1"/>',
    `  <Connect><Stream url="${getStreamUrl()}" /></Connect>`,
    "</Response>",
  ].join("\n");
}
