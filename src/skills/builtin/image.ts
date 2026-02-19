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
import { uploadPath, uploadRelativePath, type UploadCategory } from "../../utils/uploads.js";

const DASHBOARD_PORT = Number(process.env.DASHBOARD_PORT) || 3200;

/** For dashboard/voice chatIds (< 1000), return a local URL instead of sending to Telegram. */
function imageResultForDashboard(filePath: string, caption: string, extra: string, saved: string): string {
  const relPath = uploadRelativePath(filePath);
  const url = `http://localhost:${DASHBOARD_PORT}/uploads/${relPath}`;
  return `![${caption.slice(0, 80)}](${url})${extra}${saved}`;
}

const GEMINI_TIMEOUT_MS = 60_000;
const IMAGE_MODEL = "gemini-2.5-flash-image";
const VERIFY_MODEL = "gemini-2.5-pro"; // Better at text analysis than Flash
const MAX_TEXT_RETRIES = 2; // Auto-retry when text QC fails

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

/** Add quality hints to the prompt for better image output. */
function enhancePrompt(prompt: string, retryAttempt = 0): string {
  // On retry, add extra emphasis on text accuracy
  if (retryAttempt > 0) {
    return `${prompt}\n\nCRITICAL: All text in the image must be spelled EXACTLY correctly, letter by letter. Double-check every word before rendering. No typos, no missing letters, no swapped characters.`;
  }
  return prompt;
}

async function generateImage(prompt: string, temperature = 0.7, category: UploadCategory = "images"): Promise<{ filePath: string; textResponse?: string }> {
  if (!config.geminiApiKey) {
    throw new Error("GEMINI_API_KEY not configured");
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${IMAGE_MODEL}:generateContent?key=${config.geminiApiKey}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseModalities: ["IMAGE", "TEXT"],
        temperature,
        topP: 0.90,
        topK: 40,
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

  // Save image to organized uploads
  const ext = imagePart.inlineData.mimeType.includes("png") ? "png" : "jpg";
  const filePath = uploadPath(category, "generated", ext);
  const buffer = Buffer.from(imagePart.inlineData.data, "base64");
  fs.writeFileSync(filePath, buffer);

  log.info(`[image] Generated ${path.basename(filePath)} → ${category}/ (${buffer.length} bytes, temp=${temperature})`);
  return { filePath, textResponse: textPart?.text };
}

/**
 * Generate an image with automatic text quality retries.
 * If text QC fails, retries with enhanced prompt (up to MAX_TEXT_RETRIES).
 */
async function generateImageWithRetry(
  prompt: string,
  intendedTexts: string[],
  category: UploadCategory = "images"
): Promise<{ filePath: string; textResponse?: string; verifyWarning: string; attempts: number }> {
  let lastFilePath = "";
  let lastTextResponse: string | undefined;
  let lastWarning = "";

  for (let attempt = 0; attempt <= MAX_TEXT_RETRIES; attempt++) {
    const enhanced = enhancePrompt(prompt, attempt);
    // Lower temperature progressively on retries for more deterministic output
    const temp = attempt === 0 ? 0.7 : 0.5;
    const result = await generateImage(enhanced, temp, category);
    lastFilePath = result.filePath;
    lastTextResponse = result.textResponse;

    // No text to verify — accept immediately
    if (intendedTexts.length === 0) {
      return { filePath: result.filePath, textResponse: result.textResponse, verifyWarning: "", attempts: attempt + 1 };
    }

    // Verify text
    const verification = await verifyImageText(result.filePath, intendedTexts);
    if (verification.passed) {
      if (attempt > 0) log.info(`[image] Text QC passed on attempt ${attempt + 1}`);
      return { filePath: result.filePath, textResponse: result.textResponse, verifyWarning: "", attempts: attempt + 1 };
    }

    lastWarning = `⚠️ TEXT QC FAILED: ${verification.errors.join("; ")}. Found: [${verification.foundText.join(", ")}]. Intended: [${intendedTexts.join(", ")}]`;

    if (attempt < MAX_TEXT_RETRIES) {
      log.info(`[image] Text QC failed (attempt ${attempt + 1}/${MAX_TEXT_RETRIES + 1}), retrying with enhanced prompt...`);
      // Clean up failed image
      try { fs.unlinkSync(result.filePath); } catch {}
    }
  }

  // All retries exhausted — return last result with warning
  return { filePath: lastFilePath, textResponse: lastTextResponse, verifyWarning: `\n${lastWarning} (after ${MAX_TEXT_RETRIES + 1} attempts)`, attempts: MAX_TEXT_RETRIES + 1 };
}

// --- Post-generation text verification via Gemini Vision ---

interface TextVerification {
  /** All text found in the image */
  foundText: string[];
  /** Spelling/grammar errors detected */
  errors: string[];
  /** true if all text is correct */
  passed: boolean;
}

/**
 * Verify text accuracy in a generated image using Gemini vision.
 * Reads the image, extracts all visible text, and checks for spelling/grammar errors.
 * This is a QUALITY GATE — catches Gemini's frequent text rendering mistakes.
 */
async function verifyImageText(
  imagePath: string,
  intendedTexts: string[]
): Promise<TextVerification> {
  if (!config.geminiApiKey) {
    return { foundText: [], errors: ["No Gemini API key — cannot verify"], passed: false };
  }

  const imageBuffer = fs.readFileSync(imagePath);
  const imageBase64 = imageBuffer.toString("base64");
  const ext = path.extname(imagePath).toLowerCase();
  const mimeType =
    ext === ".png" ? "image/png" :
    ext === ".webp" ? "image/webp" :
    ext === ".gif" ? "image/gif" : "image/jpeg";

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${VERIFY_MODEL}:generateContent?key=${config.geminiApiKey}`;

  const verifyPrompt = `You are a strict quality control inspector for printed products (t-shirts, posters, merchandise).

Analyze this image and perform these checks:
1. Extract ALL visible text in the image exactly as rendered (letter by letter)
2. Compare against these INTENDED texts: ${JSON.stringify(intendedTexts)}
3. Check for ANY spelling errors, typos, missing letters, extra letters, or grammar mistakes in the rendered text
4. Check if any intended text is missing entirely

Respond in this EXACT JSON format only (no markdown, no explanation):
{"foundText":["text1","text2"],"errors":["error description 1"],"passed":true/false}

Rules:
- "passed" is true ONLY if ALL text is spelled correctly and matches intended texts
- Be extremely strict — even one wrong letter means passed=false
- Common AI image errors: swapped letters, missing letters, made-up words like "Soveregenity" instead of "Sovereignty"`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);

    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [
            { inline_data: { mime_type: mimeType, data: imageBase64 } },
            { text: verifyPrompt },
          ],
        }],
        generationConfig: { temperature: 0.1 },
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      log.warn(`[image.verify] Gemini API error ${resp.status}: ${body.slice(0, 200)}`);
      return { foundText: [], errors: [`API error ${resp.status}`], passed: false };
    }

    const data = (await resp.json()) as GeminiResponse;
    const text = data.candidates?.[0]?.content?.parts?.find((p) => p.text)?.text || "";

    // Parse JSON from response (strip markdown fences if present)
    const jsonStr = text.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    const result = JSON.parse(jsonStr) as TextVerification;

    log.info(`[image.verify] Text check: ${result.passed ? "PASSED" : "FAILED"} — found: ${result.foundText.join(", ")} — errors: ${result.errors.join(", ") || "none"}`);
    return result;
  } catch (err) {
    log.warn(`[image.verify] Verification failed: ${err instanceof Error ? err.message : String(err)}`);
    return { foundText: [], errors: [`Verification error: ${err instanceof Error ? err.message : String(err)}`], passed: false };
  }
}

/**
 * Extract intended text strings from a prompt.
 * Looks for quoted strings and common patterns like "TOP TEXT: ...", brand names, etc.
 */
function extractIntendedTexts(prompt: string): string[] {
  const texts: string[] = [];

  // Extract double-quoted strings
  const quoted = prompt.match(/"([^"]+)"/g);
  if (quoted) {
    texts.push(...quoted.map((q) => q.replace(/"/g, "")));
  }

  // Common brand names that must be exact
  const brands = ["BASTILON", "Bastilon", "Kingston"];
  for (const brand of brands) {
    if (prompt.includes(brand) && !texts.some((t) => t.includes(brand))) {
      texts.push(brand);
    }
  }

  return texts;
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

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${IMAGE_MODEL}:generateContent?key=${config.geminiApiKey}`;

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
        temperature: 0.7,
        topP: 0.90,
        topK: 40,
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

  const outExt = imagePart.inlineData.mimeType.includes("png") ? "png" : "jpg";
  const filePath = uploadPath("edits", "edited", outExt);
  const buffer = Buffer.from(imagePart.inlineData.data, "base64");
  fs.writeFileSync(filePath, buffer);

  log.info(`[image.edit] Generated ${path.basename(filePath)} → edits/ (${buffer.length} bytes)`);
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

      // Real Telegram chat — send via bot, keep file in organized dir
      const sendPhoto = getBotPhotoFn();
      if (sendPhoto) {
        const caption = prompt.length > 200 ? prompt.slice(0, 197) + "..." : prompt;
        await sendPhoto(chatId, filePath, caption);
        return `Image edited and sent to chat ${chatId}.\nSaved: ${filePath}${extra}${saved}`;
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
      const intendedTexts = extractIntendedTexts(prompt);
      const { filePath, textResponse, verifyWarning, attempts } = await generateImageWithRetry(prompt, intendedTexts, "images");

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

      const attemptsNote = attempts > 1 ? `\n(${attempts} attempts)` : "";
      const extra = (textResponse ? `\n${textResponse.slice(0, 200)}` : "") + verifyWarning + attemptsNote;
      const saved = saveTo ? `\nSaved to: ${saveTo}` : "";

      // Dashboard/voice chatIds (< 1000) — return URL for inline display
      if (chatId < 1000) {
        return imageResultForDashboard(filePath, prompt, extra, saved);
      }

      // Real Telegram chat — send via bot, keep file in organized dir
      const sendPhoto = getBotPhotoFn();
      if (sendPhoto) {
        const caption = prompt.length > 200 ? prompt.slice(0, 197) + "..." : prompt;
        await sendPhoto(chatId, filePath, caption);
        return `Image generated and sent to chat ${chatId}.\nSaved: ${filePath}${extra}${saved}`;
      }

      return `Image generated and saved to ${filePath} (bot not available to send).${verifyWarning}`;
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
      const intendedTexts = [topText, bottomText].filter(Boolean);
      const { filePath, textResponse, verifyWarning, attempts } = await generateImageWithRetry(memePrompt, intendedTexts, "memes");

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
      const attemptsNote = attempts > 1 ? ` (${attempts} attempts)` : "";
      const saved = saveTo ? `\nSaved to: ${saveTo}` : "";

      // Dashboard/voice chatIds (< 1000) — return URL for inline display
      if (chatId < 1000) {
        return imageResultForDashboard(filePath, memeCaption, verifyWarning + attemptsNote, saved);
      }

      // Real Telegram chat — send via bot, keep file in organized dir
      const sendPhoto = getBotPhotoFn();
      if (sendPhoto) {
        await sendPhoto(chatId, filePath, memeCaption.slice(0, 200));
        return `Meme generated and sent!\nSaved: ${filePath}${verifyWarning}${attemptsNote}${saved}`;
      }

      return `Meme saved to ${filePath} (bot not available to send).${verifyWarning}`;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return "Error: Gemini API request timed out (60s).";
      }
      return `Error generating meme: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

// --- Standalone text verification skill ---

registerSkill({
  name: "image.verify_text",
  description:
    "Verify text accuracy in an image using AI vision. Checks for spelling errors, typos, and missing text. Use this before sending any image with text to production/printing.",
  argsSchema: {
    type: "object",
    properties: {
      imagePath: { type: "string", description: "Absolute path to the image to verify" },
      intended_texts: { type: "string", description: "Comma-separated list of texts that should appear correctly in the image" },
    },
    required: ["imagePath", "intended_texts"],
  },
  async execute(args): Promise<string> {
    const imagePath = args.imagePath as string;
    const intendedTexts = (args.intended_texts as string).split(",").map((t) => t.trim());

    if (!fs.existsSync(imagePath)) {
      return `Error: File not found: ${imagePath}`;
    }

    const result = await verifyImageText(imagePath, intendedTexts);

    if (result.passed) {
      return `✅ TEXT QC PASSED\nFound: ${result.foundText.join(", ")}\nAll text matches intended content.`;
    }

    return `❌ TEXT QC FAILED\nFound: ${result.foundText.join(", ")}\nErrors: ${result.errors.join("; ")}\nIntended: ${intendedTexts.join(", ")}`;
  },
});
