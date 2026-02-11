/**
 * Built-in skill: image.generate — AI image generation via Gemini API.
 * Generates an image, saves it locally, and sends it to the Telegram chat.
 */
import fs from "node:fs";
import path from "node:path";
import { registerSkill } from "../loader.js";
import { config } from "../../config/env.js";
import { getBotPhotoFn } from "./telegram.js";
import { log } from "../../utils/log.js";

const DASHBOARD_PORT = Number(process.env.DASHBOARD_PORT) || 3200;

/** For dashboard/voice chatIds (< 1000), return a local URL instead of sending to Telegram. */
function imageResultForDashboard(filePath: string, caption: string, extra: string, saved: string): string {
  const filename = path.basename(filePath);
  const url = `http://localhost:${DASHBOARD_PORT}/uploads/${filename}`;
  return `![${caption.slice(0, 80)}](${url})${extra}${saved}`;
}

const GEMINI_TIMEOUT_MS = 60_000;

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        inlineData?: { mimeType: string; data: string };
      }>;
    };
  }>;
  error?: { message: string };
}

async function generateImage(prompt: string): Promise<{ filePath: string; textResponse?: string }> {
  if (!config.geminiApiKey) {
    throw new Error("GEMINI_API_KEY not configured");
  }

  const model = "gemini-2.5-flash-image";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.geminiApiKey}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseModalities: ["IMAGE", "TEXT"],
        temperature: 1.0,
        topP: 0.95,
        topK: 64,
      },
    }),
    signal: controller.signal,
  });

  clearTimeout(timer);

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Gemini API error ${resp.status}: ${body.slice(0, 300)}`);
  }

  const data = (await resp.json()) as GeminiResponse;

  if (data.error) {
    throw new Error(`Gemini error: ${data.error.message}`);
  }

  const parts = data.candidates?.[0]?.content?.parts;
  if (!parts || parts.length === 0) {
    throw new Error("Gemini returned no content");
  }

  // Find image part (inlineData with base64)
  const imagePart = parts.find((p) => p.inlineData?.data);
  const textPart = parts.find((p) => p.text);

  if (!imagePart?.inlineData) {
    throw new Error("Gemini returned no image data. Response: " + (textPart?.text || "empty").slice(0, 200));
  }

  // Save image to uploads
  const uploadsDir = path.resolve(config.uploadsDir);
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }

  const ext = imagePart.inlineData.mimeType.includes("png") ? "png" : "jpg";
  const filename = `generated_${Date.now()}.${ext}`;
  const filePath = path.join(uploadsDir, filename);
  const buffer = Buffer.from(imagePart.inlineData.data, "base64");
  fs.writeFileSync(filePath, buffer);

  log.info(`[image] Generated ${filename} (${buffer.length} bytes)`);
  return { filePath, textResponse: textPart?.text };
}

// --- Image-to-image editing via Gemini ---

async function editImage(
  imagePath: string,
  prompt: string
): Promise<{ filePath: string; textResponse?: string }> {
  if (!config.geminiApiKey) {
    throw new Error("GEMINI_API_KEY not configured");
  }

  // Read source image
  if (!fs.existsSync(imagePath)) {
    throw new Error(`Source image not found: ${imagePath}`);
  }
  const imageBuffer = fs.readFileSync(imagePath);
  const imageBase64 = imageBuffer.toString("base64");

  const ext = path.extname(imagePath).toLowerCase();
  const mimeType =
    ext === ".png" ? "image/png" :
    ext === ".webp" ? "image/webp" :
    ext === ".gif" ? "image/gif" : "image/jpeg";

  const model = "gemini-2.5-flash-preview-05-20";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.geminiApiKey}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { inline_data: { mime_type: mimeType, data: imageBase64 } },
            { text: prompt },
          ],
        },
      ],
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],
        temperature: 1.0,
        topP: 0.95,
        topK: 64,
      },
    }),
    signal: controller.signal,
  });

  clearTimeout(timer);

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Gemini API error ${resp.status}: ${body.slice(0, 300)}`);
  }

  const data = (await resp.json()) as GeminiResponse;

  if (data.error) {
    throw new Error(`Gemini error: ${data.error.message}`);
  }

  const parts = data.candidates?.[0]?.content?.parts;
  if (!parts || parts.length === 0) {
    throw new Error("Gemini returned no content");
  }

  const imagePart = parts.find((p) => p.inlineData?.data);
  const textPart = parts.find((p) => p.text);

  if (!imagePart?.inlineData) {
    throw new Error(
      "Gemini returned no image. " + (textPart?.text || "No text response either.").slice(0, 200)
    );
  }

  const uploadsDir = path.resolve(config.uploadsDir);
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }

  const outExt = imagePart.inlineData.mimeType.includes("png") ? "png" : "jpg";
  const filename = `edited_${Date.now()}.${outExt}`;
  const filePath = path.join(uploadsDir, filename);
  const buffer = Buffer.from(imagePart.inlineData.data, "base64");
  fs.writeFileSync(filePath, buffer);

  log.info(`[image.edit] Generated ${filename} (${buffer.length} bytes)`);
  return { filePath, textResponse: textPart?.text };
}

registerSkill({
  name: "image.edit",
  description:
    "Edit/transform an existing image using AI (Gemini). Takes a source image path and a text prompt describing the desired changes. Use this for image-to-image transformations (style transfer, modifications, enhancements). The result is sent to the Telegram chat.",
  argsSchema: {
    type: "object",
    properties: {
      imagePath: {
        type: "string",
        description: "Absolute path to the source image file",
      },
      prompt: {
        type: "string",
        description:
          "Text prompt describing what to do with the image (e.g. 'Make this into a watercolor painting', 'Add sunglasses', 'Convert to anime style')",
      },
      chatId: { type: "string", description: "Telegram chat ID to send the result to" },
      save_to: { type: "string", description: "Optional: save a copy to this absolute path" },
    },
    required: ["imagePath", "prompt", "chatId"],
  },
  async execute(args): Promise<string> {
    const imagePath = args.imagePath as string;
    const prompt = args.prompt as string;
    const chatId = Number((args.chatId ?? args.chat_id) as string) || 0;
    const saveTo = args.save_to as string | undefined;

    try {
      const { filePath, textResponse } = await editImage(imagePath, prompt);

      // Save a copy if requested
      if (saveTo) {
        try {
          const destDir = path.dirname(saveTo);
          if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
          fs.copyFileSync(filePath, saveTo);
          log.info(`[image.edit] Saved copy to ${saveTo}`);
        } catch (copyErr) {
          log.warn(`[image.edit] Failed to save copy: ${copyErr instanceof Error ? copyErr.message : String(copyErr)}`);
        }
      }

      const extra = textResponse ? `\n${textResponse.slice(0, 200)}` : "";
      const saved = saveTo ? `\nSaved to: ${saveTo}` : "";

      // Dashboard/voice chatIds (< 1000) — return URL for inline display
      if (chatId < 1000) {
        return imageResultForDashboard(filePath, prompt, extra, saved);
      }

      // Real Telegram chat — send via bot
      const sendPhoto = getBotPhotoFn();
      if (sendPhoto) {
        const caption = prompt.length > 200 ? prompt.slice(0, 197) + "..." : prompt;
        await sendPhoto(chatId, filePath, caption);
        fs.unlinkSync(filePath);
        return `Image edited and sent to chat ${chatId}.${extra}${saved}`;
      }

      return `Image edited and saved to ${filePath} (bot not available to send).`;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return "Error: Gemini API request timed out (60s).";
      }
      return `Error editing image: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

registerSkill({
  name: "image.generate",
  description:
    "Generate an image using AI (Gemini) from a text prompt. The image is automatically sent to the Telegram chat.",
  argsSchema: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "Image description / prompt" },
      chatId: { type: "string", description: "Telegram chat ID to send the image to" },
      save_to: { type: "string", description: "Optional: save a copy to this absolute path (e.g. C:\\Users\\Nicolas\\Pictures\\meme.png)" },
    },
    required: ["prompt", "chatId"],
  },
  async execute(args): Promise<string> {
    const prompt = args.prompt as string;
    const chatId = Number((args.chatId ?? args.chat_id) as string) || 0;
    const saveTo = args.save_to as string | undefined;

    try {
      const { filePath, textResponse } = await generateImage(prompt);

      // Save a copy if requested
      if (saveTo) {
        try {
          const destDir = path.dirname(saveTo);
          if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
          fs.copyFileSync(filePath, saveTo);
          log.info(`[image] Saved copy to ${saveTo}`);
        } catch (copyErr) {
          log.warn(`[image] Failed to save copy: ${copyErr instanceof Error ? copyErr.message : String(copyErr)}`);
        }
      }

      const extra = textResponse ? `\n${textResponse.slice(0, 200)}` : "";
      const saved = saveTo ? `\nSaved to: ${saveTo}` : "";

      // Dashboard/voice chatIds (< 1000) — return URL for inline display
      if (chatId < 1000) {
        return imageResultForDashboard(filePath, prompt, extra, saved);
      }

      // Real Telegram chat — send via bot
      const sendPhoto = getBotPhotoFn();
      if (sendPhoto) {
        const caption = prompt.length > 200 ? prompt.slice(0, 197) + "..." : prompt;
        await sendPhoto(chatId, filePath, caption);
        fs.unlinkSync(filePath);
        return `Image generated and sent to chat ${chatId}.${extra}${saved}`;
      }

      return `Image generated and saved to ${filePath} (bot not available to send).`;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return "Error: Gemini API request timed out (60s).";
      }
      return `Error generating image: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

registerSkill({
  name: "image.meme",
  description:
    "Generate a meme image with AI. Automatically adds meme-style formatting to the prompt. Saves to disk and sends to Telegram.",
  argsSchema: {
    type: "object",
    properties: {
      top_text: { type: "string", description: "Text at the top of the meme" },
      bottom_text: { type: "string", description: "Text at the bottom of the meme" },
      concept: { type: "string", description: "Meme concept/scene description (e.g. 'distracted boyfriend', 'drake hotline bling')" },
      chatId: { type: "string", description: "Telegram chat ID" },
      save_to: { type: "string", description: "Optional: save to this path (e.g. C:\\Users\\Nicolas\\Pictures\\meme.png)" },
    },
    required: ["concept", "chatId"],
  },
  async execute(args): Promise<string> {
    const topText = (args.top_text as string) || "";
    const bottomText = (args.bottom_text as string) || "";
    const concept = args.concept as string;
    const chatId = Number((args.chatId ?? args.chat_id) as string) || 0;
    const saveTo = args.save_to as string | undefined;

    // Build a meme-optimized prompt
    const memePrompt =
      `Create a funny meme image. Style: classic internet meme with bold white Impact font text with black outline. ` +
      `Scene: ${concept}. ` +
      (topText ? `TOP TEXT in large white Impact font with black outline at the top: "${topText}". ` : "") +
      (bottomText ? `BOTTOM TEXT in large white Impact font with black outline at the bottom: "${bottomText}". ` : "") +
      `The text must be clearly readable, large, and in classic meme style. Make it funny and shareable.`;

    try {
      const { filePath, textResponse } = await generateImage(memePrompt);

      // Save a copy if requested
      if (saveTo) {
        try {
          const destDir = path.dirname(saveTo);
          if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
          fs.copyFileSync(filePath, saveTo);
          log.info(`[image.meme] Saved copy to ${saveTo}`);
        } catch (copyErr) {
          log.warn(`[image.meme] Failed to save copy: ${copyErr instanceof Error ? copyErr.message : String(copyErr)}`);
        }
      }

      const memeCaption = topText && bottomText ? `${topText} / ${bottomText}` : topText || bottomText || concept;
      const saved = saveTo ? `\nSaved to: ${saveTo}` : "";

      // Dashboard/voice chatIds (< 1000) — return URL for inline display
      if (chatId < 1000) {
        return imageResultForDashboard(filePath, memeCaption, "", saved);
      }

      // Real Telegram chat — send via bot
      const sendPhoto = getBotPhotoFn();
      if (sendPhoto) {
        await sendPhoto(chatId, filePath, memeCaption.slice(0, 200));
        fs.unlinkSync(filePath);
        return `Meme generated and sent!${saved}`;
      }

      return `Meme saved to ${filePath} (bot not available to send).`;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return "Error: Gemini API request timed out (60s).";
      }
      return `Error generating meme: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});
