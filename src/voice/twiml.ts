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

/** Get Polly voice + BCP-47 lang for TwiML (fr-CA for Quebec, en-US otherwise) */
function getVoiceAndLang(): { voice: string; lang: string } {
  if (config.voiceLanguage === "fr") {
    return { voice: "Polly.Liam", lang: "fr-CA" };
  }
  return { voice: "Polly.Matthew", lang: "en-US" };
}

export function buildGatherTwiml(prompt?: string): string {
  const { voice, lang } = getVoiceAndLang();
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
  const { voice, lang } = getVoiceAndLang();
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
  const { voice, lang } = getVoiceAndLang();
  const greeting = escapeXml(config.voiceGreeting || "Bonjour, ici Kingston.");

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<Response>",
    `  <Say voice="Polly.Mathieu" language="fr-FR">${greeting}</Say>`,
    `  <Connect><Stream url="${getStreamUrl()}" /></Connect>`,
    "</Response>",
  ].join("\n");
}

export function buildOutboundTwiml(reason: string): string {
  const { voice, lang } = getVoiceAndLang();
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<Response>",
    `  <Say voice="${voice}" language="${lang}">${escapeXml(reason)}</Say>`,
    '  <Pause length="1"/>',
    `  <Connect><Stream url="${getStreamUrl()}" /></Connect>`,
    "</Response>",
  ].join("\n");
}
