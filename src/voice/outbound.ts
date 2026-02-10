/**
 * Outbound Twilio call — calls Nicolas with a spoken reason,
 * then connects to the same voice pipeline for conversation.
 */
import { config } from "../config/env.js";
import { log } from "../utils/log.js";

export async function callNicolas(reason: string): Promise<string> {
  const { twilioAccountSid, twilioAuthToken, twilioPhoneNumber, nicolasPhoneNumber, voicePublicUrl } = config;

  if (!twilioAccountSid || !twilioAuthToken) {
    throw new Error("Twilio credentials not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN)");
  }
  if (!twilioPhoneNumber) {
    throw new Error("TWILIO_PHONE_NUMBER not configured");
  }
  if (!nicolasPhoneNumber) {
    throw new Error("NICOLAS_PHONE_NUMBER not configured");
  }
  if (!voicePublicUrl) {
    throw new Error("VOICE_PUBLIC_URL not configured");
  }

  const encodedReason = encodeURIComponent(reason);
  const twimlUrl = `${voicePublicUrl}/voice/outbound-twiml?reason=${encodedReason}`;

  const url = `https://api.twilio.com/2010-04-01/Accounts/${twilioAccountSid}/Calls.json`;
  const auth = Buffer.from(`${twilioAccountSid}:${twilioAuthToken}`).toString("base64");

  const body = new URLSearchParams({
    To: nicolasPhoneNumber,
    From: twilioPhoneNumber,
    Url: twimlUrl,
  });

  log.info(`[outbound] Calling ${nicolasPhoneNumber} — reason: ${reason.slice(0, 60)}`);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Twilio API error ${res.status}: ${text}`);
  }

  const data = (await res.json()) as { sid: string };
  log.info(`[outbound] Call initiated — SID: ${data.sid}`);
  return data.sid;
}
