/**
 * Built-in skill: video.generate — AI video generation via Gemini Veo API.
 * Generates a short video from a text prompt, saves it locally, and sends it to Telegram.
 *
 * Primary: Google Veo 3.1 via Gemini API (same key as image generation).
 * Fallback: Hugging Face Inference API (LTX-Video, free tier).
 */
import fs from "node:fs";
import path from "node:path";
import { registerSkill } from "../loader.js";
import { config } from "../../config/env.js";
import { log } from "../../utils/log.js";
import { getUploadDir, uploadRelativePath } from "../../utils/uploads.js";

const DASHBOARD_PORT = Number(process.env.DASHBOARD_PORT) || 3200;
const VIDEO_TIMEOUT_MS = 300_000; // 5 minutes — video gen is slow (async polling)
const POLL_INTERVAL_MS = 10_000; // Poll every 10 seconds
const VIDEOS_DIR = () => getUploadDir("videos");

// ── Bot video send function ──────────────────────────────────────────

type VideoFn = (chatId: number, videoPath: string, caption?: string) => Promise<void>;
let botVideo: VideoFn | null = null;

export function setBotVideoFn(fn: VideoFn): void {
  botVideo = fn;
}

export function getBotVideoFn(): VideoFn | null {
  return botVideo;
}

// ── Gemini Veo video generation ──────────────────────────────────────

const VEO_MODEL = "veo-3.1-generate-preview";

interface VeoOperation {
  name: string;
  done?: boolean;
  response?: {
    generatedVideos?: Array<{
      video?: { uri: string };
    }>;
  };
  error?: { message: string; code: number };
}

/**
 * Generate a video via Google Veo (Gemini API).
 * Uses predictLongRunning → poll pattern.
 */
async function generateViaVeo(prompt: string, duration = "6"): Promise<string> {
  if (!config.geminiApiKey) {
    throw new Error("GEMINI_API_KEY not configured");
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${VEO_MODEL}:predictLongRunning?key=${config.geminiApiKey}`;

  log.info(`[video] Generating via Veo 3.1 (${duration}s)...`);

  // Step 1: Start generation
  const startResp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      instances: [{ prompt }],
      parameters: {
        aspectRatio: "16:9",
        resolution: "720p",
        durationSeconds: duration,
      },
    }),
  });

  if (!startResp.ok) {
    const body = await startResp.text().catch(() => "");
    throw new Error(`Veo API error ${startResp.status}: ${body.slice(0, 300)}`);
  }

  const operation = (await startResp.json()) as VeoOperation;
  if (!operation.name) {
    throw new Error("Veo returned no operation name");
  }

  log.info(`[video] Veo operation started: ${operation.name}`);

  // Step 2: Poll until done
  const deadline = Date.now() + VIDEO_TIMEOUT_MS;
  let result: VeoOperation = operation;

  while (!result.done && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    const pollUrl = `https://generativelanguage.googleapis.com/v1beta/${result.name}?key=${config.geminiApiKey}`;
    const pollResp = await fetch(pollUrl);

    if (!pollResp.ok) {
      const body = await pollResp.text().catch(() => "");
      log.warn(`[video] Veo poll error ${pollResp.status}: ${body.slice(0, 200)}`);
      continue;
    }

    result = (await pollResp.json()) as VeoOperation;
  }

  if (!result.done) {
    throw new Error("Veo generation timed out (5 minutes)");
  }

  if (result.error) {
    throw new Error(`Veo error: ${result.error.message}`);
  }

  // Step 3: Download the video
  const videoUri = result.response?.generatedVideos?.[0]?.video?.uri;
  if (!videoUri) {
    throw new Error("Veo returned no video URI");
  }

  log.info(`[video] Downloading video from Veo...`);

  // The URI might be a files API reference — download it
  const downloadUrl = videoUri.startsWith("http")
    ? videoUri
    : `https://generativelanguage.googleapis.com/v1beta/${videoUri}?key=${config.geminiApiKey}&alt=media`;

  const dlResp = await fetch(downloadUrl);
  if (!dlResp.ok) {
    throw new Error(`Veo download error ${dlResp.status}`);
  }

  const buffer = Buffer.from(await dlResp.arrayBuffer());
  const filename = `video_veo_${Date.now()}.mp4`;
  const filePath = path.join(VIDEOS_DIR(), filename);
  fs.writeFileSync(filePath, buffer);

  log.info(`[video] Generated ${filename} (${(buffer.length / 1024 / 1024).toFixed(1)}MB) via Veo`);
  return filePath;
}

// ── Hugging Face fallback ────────────────────────────────────────────

/**
 * Fallback: Generate video via Hugging Face free Inference API.
 * Uses the LTX-Video model.
 */
async function generateViaHuggingFace(prompt: string): Promise<string> {
  const model = "Lightricks/LTX-Video";
  const url = `https://api-inference.huggingface.co/models/${model}`;

  log.info(`[video] Fallback: generating via HuggingFace (${model})...`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VIDEO_TIMEOUT_MS);

  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const hfToken = process.env.HF_TOKEN || process.env.HUGGINGFACE_TOKEN;
    if (hfToken) headers["Authorization"] = `Bearer ${hfToken}`;

    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ inputs: prompt }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`HuggingFace API error ${resp.status}: ${body.slice(0, 300)}`);
    }

    const buffer = Buffer.from(await resp.arrayBuffer());
    const filename = `video_hf_${Date.now()}.mp4`;
    const filePath = path.join(VIDEOS_DIR(), filename);
    fs.writeFileSync(filePath, buffer);

    log.info(`[video] HF generated ${filename} (${(buffer.length / 1024 / 1024).toFixed(1)}MB)`);
    return filePath;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// ── Main generation with fallback chain ──────────────────────────────

async function generateVideo(prompt: string, duration?: string): Promise<string> {
  // Try Gemini Veo first (same API key as images)
  if (config.geminiApiKey) {
    try {
      return await generateViaVeo(prompt, duration || "6");
    } catch (err) {
      log.warn(`[video] Veo failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Fallback to HuggingFace
  try {
    return await generateViaHuggingFace(prompt);
  } catch (err) {
    log.warn(`[video] HuggingFace fallback failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  throw new Error("All video generation providers failed. Try again later.");
}

// ── Skills ───────────────────────────────────────────────────────────

registerSkill({
  name: "video.generate",
  description:
    "Generate a short AI video (4-8 seconds) from a text prompt using Google Veo 3.1. The video is automatically sent to the Telegram chat. Uses the same Gemini API key as image generation.",
  argsSchema: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "Video description / prompt (be detailed: subject, action, style, camera angle)",
      },
      duration: {
        type: "string",
        description: "Video duration in seconds: '4', '6' (default), or '8'",
      },
      chatId: {
        type: "string",
        description: "Telegram chat ID to send the video to",
      },
      save_to: {
        type: "string",
        description: "Optional: save a copy to this absolute path",
      },
    },
    required: ["prompt", "chatId"],
  },
  async execute(args): Promise<string> {
    const prompt = args.prompt as string;
    const duration = (args.duration as string) || undefined;
    const chatId = Number((args.chatId ?? args.chat_id) as string) || 0;
    const saveTo = args.save_to as string | undefined;

    try {
      const filePath = await generateVideo(prompt, duration);

      // Save a copy if requested
      if (saveTo) {
        try {
          const destDir = path.dirname(saveTo);
          if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
          fs.copyFileSync(filePath, saveTo);
          log.info(`[video] Saved copy to ${saveTo}`);
        } catch (copyErr) {
          log.warn(`[video] Failed to save copy: ${copyErr instanceof Error ? copyErr.message : String(copyErr)}`);
        }
      }

      const saved = saveTo ? `\nSaved to: ${saveTo}` : "";
      const sizeMB = (fs.statSync(filePath).size / 1024 / 1024).toFixed(1);

      // Dashboard/voice chatIds (< 1000) — return URL for inline display
      if (chatId < 1000) {
        const relPath = uploadRelativePath(filePath);
        const url = `http://localhost:${DASHBOARD_PORT}/uploads/${relPath}`;
        return `Video generated (${sizeMB}MB): ${url}${saved}`;
      }

      // Real Telegram chat — send via bot
      if (botVideo) {
        const caption = prompt.length > 200 ? prompt.slice(0, 197) + "..." : prompt;
        await botVideo(chatId, filePath, caption);
        return `Video generated (${sizeMB}MB) and sent to chat ${chatId}.${saved}`;
      }

      return `Video generated and saved to ${filePath} (bot not available to send).${saved}`;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return "Error: Video generation timed out (5 minutes). Try a simpler prompt.";
      }
      return `Error generating video: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});
