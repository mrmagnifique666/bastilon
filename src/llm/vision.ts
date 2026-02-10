/**
 * Image analysis via Gemini Flash API.
 * Uses gemini-2.0-flash for cheapest vision — covered by Nicolas's Gemini credits.
 * No extra dependencies — native fetch only.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "../config/env.js";
import { log } from "../utils/log.js";

const VISION_MODEL = "gemini-2.5-flash";
const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

const SYSTEM_PROMPT = `Décris précisément ce que tu vois dans cette image. Règles strictes:
- Distingue clairement: photo réelle, dessin, caricature, illustration, mème, screenshot, document.
- Si c'est un dessin/caricature d'une personne, dis "caricature/dessin d'une personne" — ne confonds PAS avec un animal.
- Ne fabrique pas de détails. Si tu n'es pas sûr, dis-le.
- Identifie: personnes, objets, texte visible, couleurs dominantes, contexte/lieu.
- Réponds en français, concis (3-5 phrases max).`;

/** Map file extension to MIME media type. */
function detectMediaType(
  filePath: string
): "image/jpeg" | "image/png" | "image/gif" | "image/webp" {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    default:
      return "image/jpeg";
  }
}

/**
 * Analyze an image using Gemini Flash vision.
 * @param imagePath - Absolute path to the image file on disk.
 * @param userPrompt - Optional text prompt to guide the analysis.
 * @returns The text description, or an error string.
 */
export async function describeImage(
  imagePath: string,
  userPrompt: string
): Promise<string> {
  if (!config.geminiApiKey) {
    return "Error: GEMINI_API_KEY not configured for image analysis.";
  }

  // Read image as base64
  let imageData: string;
  try {
    const buffer = fs.readFileSync(imagePath);
    imageData = buffer.toString("base64");
  } catch (err) {
    log.error("[vision] Failed to read image file:", err);
    return `Error: impossible de lire le fichier image — ${(err as Error).message}`;
  }

  const mediaType = detectMediaType(imagePath);
  const promptText = userPrompt
    ? `${SYSTEM_PROMPT}\n\n${userPrompt}`
    : SYSTEM_PROMPT;

  const body = {
    contents: [
      {
        parts: [
          {
            inline_data: {
              mime_type: mediaType,
              data: imageData,
            },
          },
          {
            text: promptText,
          },
        ],
      },
    ],
    generationConfig: {
      maxOutputTokens: 1024,
    },
  };

  const url = `${API_BASE}/${VISION_MODEL}:generateContent?key=${config.geminiApiKey}`;

  try {
    log.info(`[vision] Calling ${VISION_MODEL} for ${path.basename(imagePath)} (${mediaType})`);

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      log.error(`[vision] Gemini API error ${res.status}:`, errText);
      return `Error: Gemini API returned ${res.status} — ${errText.slice(0, 300)}`;
    }

    const data = (await res.json()) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
      }>;
      error?: { message: string };
    };

    if (data.error) {
      return `Error: Gemini — ${data.error.message}`;
    }

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    return text ?? "Error: aucune réponse textuelle reçue de Gemini.";
  } catch (err) {
    log.error("[vision] Request failed:", err);
    return `Error: échec de la requête vision — ${(err as Error).message}`;
  }
}
