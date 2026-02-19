/**
 * Organized upload directory management.
 * All Kingston-created media goes to categorized subdirectories under relay/uploads/.
 *
 * Structure:
 *   relay/uploads/
 *     images/      — AI-generated images (image.generate)
 *     memes/       — Memes (image.meme)
 *     edits/       — Edited/transformed images (image.edit)
 *     videos/      — Generated videos (video.generate)
 *     merch/       — T-shirt designs, mockups (printful.*)
 *     scenes/      — Dungeon/game scene images (dungeon.scene)
 *     screenshots/ — Desktop screenshots (computer.*, screenshot.*)
 *     voice/       — Voice clips, audio files
 *     content/     — Social media assets, content drafts
 *     other/       — Uncategorized uploads
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "../config/env.js";

export type UploadCategory =
  | "images"
  | "memes"
  | "edits"
  | "videos"
  | "merch"
  | "scenes"
  | "screenshots"
  | "voice"
  | "content"
  | "other";

const BASE_DIR = () => path.resolve(config.uploadsDir);

/** Ensure a category subdirectory exists and return its path. */
export function getUploadDir(category: UploadCategory): string {
  const dir = path.join(BASE_DIR(), category);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Build a file path for a new upload in the given category. */
export function uploadPath(category: UploadCategory, prefix: string, ext: string): string {
  const dir = getUploadDir(category);
  const filename = `${prefix}_${Date.now()}.${ext}`;
  return path.join(dir, filename);
}

/**
 * Get the relative path from the uploads root (for URL building).
 * e.g. "relay/uploads/memes/meme_123.png" → "memes/meme_123.png"
 */
export function uploadRelativePath(filePath: string): string {
  const base = BASE_DIR();
  const resolved = path.resolve(filePath);
  if (resolved.startsWith(base)) {
    return resolved.slice(base.length + 1).replace(/\\/g, "/");
  }
  return path.basename(filePath);
}

/** List all files in a category, sorted by newest first. */
export function listUploads(category?: UploadCategory): Array<{ name: string; category: string; url: string; size: number; mtime: number }> {
  const base = BASE_DIR();
  const results: Array<{ name: string; category: string; url: string; size: number; mtime: number }> = [];

  const categories = category ? [category] : getAllCategories();

  for (const cat of categories) {
    const dir = path.join(base, cat);
    if (!fs.existsSync(dir)) continue;
    try {
      const files = fs.readdirSync(dir).filter(f => /\.(png|jpg|jpeg|gif|webp|svg|bmp|mp4|webm|mp3|wav|ogg)$/i.test(f));
      for (const f of files) {
        try {
          const stat = fs.statSync(path.join(dir, f));
          results.push({
            name: f,
            category: cat,
            url: `/uploads/${cat}/${f}`,
            size: stat.size,
            mtime: stat.mtimeMs,
          });
        } catch { /* skip unreadable files */ }
      }
    } catch { /* dir not readable */ }
  }

  // Also scan root for legacy files
  try {
    const rootFiles = fs.readdirSync(base)
      .filter(f => /\.(png|jpg|jpeg|gif|webp|svg|bmp|mp4|webm|mp3|wav|ogg)$/i.test(f))
      .filter(f => !fs.statSync(path.join(base, f)).isDirectory());
    for (const f of rootFiles) {
      try {
        const stat = fs.statSync(path.join(base, f));
        results.push({
          name: f,
          category: "other",
          url: `/uploads/${f}`,
          size: stat.size,
          mtime: stat.mtimeMs,
        });
      } catch { /* skip */ }
    }
  } catch { /* root not readable */ }

  return results.sort((a, b) => b.mtime - a.mtime);
}

function getAllCategories(): UploadCategory[] {
  return ["images", "memes", "edits", "videos", "merch", "scenes", "screenshots", "voice", "content", "other"];
}

/** Create all subdirectories on startup. */
export function ensureUploadDirs(): void {
  for (const cat of getAllCategories()) {
    getUploadDir(cat);
  }
}
