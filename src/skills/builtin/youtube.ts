/**
 * Built-in skills: youtube.*
 * YouTube content extraction — transcript, info, summarize.
 * Uses youtube-transcript package (no API key needed).
 */
import { registerSkill } from "../loader.js";
import { log } from "../../utils/log.js";

const MAX_TRANSCRIPT = 12000;

// Fallback: extract transcript via browser DOM when API fails
async function extractTranscriptViaBrowser(videoId: string, showTimestamps: boolean): Promise<string> {
  try {
    const { browserManager } = await import("../../browser/manager.js");
    const page = await browserManager.getPage();

    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    await page.goto(videoUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

    // Execute JavaScript to click transcript button and extract segments
    const transcript = await page.evaluate(async () => {
      // Find and click the transcript button
      const buttons = Array.from(document.querySelectorAll('button'));
      const transcriptButton = buttons.find(btn => {
        const text = btn.textContent || '';
        const label = btn.getAttribute('aria-label') || '';
        return text.toLowerCase().includes('transcript') ||
               label.toLowerCase().includes('transcript') ||
               text.toLowerCase().includes('show transcript');
      });

      if (!transcriptButton) {
        return { error: 'Transcript button not found on page' };
      }

      (transcriptButton as HTMLElement).click();

      // Wait for panel to open
      await new Promise(r => setTimeout(r, 2500));

      // Extract transcript segments
      const segments = Array.from(document.querySelectorAll('ytd-transcript-segment-renderer'));

      if (segments.length === 0) {
        return { error: 'No transcript segments found after clicking button' };
      }

      // Map segments to {timestamp, text}
      return segments.map(seg => {
        const timestamp = seg.querySelector('.segment-timestamp')?.textContent?.trim() || '';
        const text = seg.querySelector('.segment-text')?.textContent?.trim() || '';
        return { timestamp, text };
      });
    });

    if (typeof transcript === 'object' && 'error' in transcript) {
      throw new Error(transcript.error as string);
    }

    if (!Array.isArray(transcript) || transcript.length === 0) {
      throw new Error('No transcript segments extracted from browser');
    }

    // Format transcript
    let text: string;
    if (showTimestamps) {
      text = transcript.map((s: any) => `[${s.timestamp}] ${s.text}`).join('\n');
    } else {
      text = transcript.map((s: any) => s.text).join(' ');
    }

    // Truncate if needed
    if (text.length > MAX_TRANSCRIPT) {
      text = text.slice(0, MAX_TRANSCRIPT) + `\n\n... (truncated, ${text.length} total chars)`;
    }

    const duration = transcript.length > 0 ? transcript[transcript.length - 1].timestamp : 'unknown';

    return `YouTube Transcript (${videoId}, via browser, duration ~${duration}, ${transcript.length} segments):\n\n${text}`;
  } catch (err) {
    throw new Error(`Browser extraction failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function extractVideoId(input: string): string | null {
  // Accept raw ID, full URL, or short URL
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/,
  ];
  for (const p of patterns) {
    const m = input.match(p);
    if (m) return m[1];
  }
  return null;
}

function formatTimestamp(offsetMs: number): string {
  const totalSec = Math.floor(offsetMs / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// ── youtube.transcript ──────────────────────────────────────

registerSkill({
  name: "youtube.transcript",
  description:
    "Extract the transcript (captions/subtitles) from a YouTube video. Returns timestamped text. This is how you 'watch' YouTube videos — by reading their transcript.",
  argsSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "YouTube URL or video ID" },
      lang: { type: "string", description: "Language code (default: en). Try 'fr' for French." },
      timestamps: { type: "string", description: "Include timestamps? 'true' (default) or 'false'" },
    },
    required: ["url"],
  },
  async execute(args): Promise<string> {
    const input = args.url as string;
    const lang = (args.lang as string) || "en";
    const showTimestamps = String(args.timestamps) !== "false";

    const videoId = extractVideoId(input);
    if (!videoId) return `Error: could not extract video ID from "${input}".`;

    try {
      // Dynamic import to avoid top-level ESM issues
      const { YoutubeTranscript } = await import("youtube-transcript");

      const segments = await YoutubeTranscript.fetchTranscript(videoId, { lang });

      if (!segments || segments.length === 0) {
        // FALLBACK: Try browser-based extraction
        log.info(`[youtube.transcript] No transcript via API for ${videoId}, trying browser fallback...`);
        return await extractTranscriptViaBrowser(videoId, showTimestamps);
      }

      // Format transcript
      let text: string;
      if (showTimestamps) {
        text = segments
          .map((s: any) => `[${formatTimestamp(s.offset)}] ${s.text}`)
          .join("\n");
      } else {
        text = segments.map((s: any) => s.text).join(" ");
      }

      // Truncate if needed
      if (text.length > MAX_TRANSCRIPT) {
        text = text.slice(0, MAX_TRANSCRIPT) + `\n\n... (truncated, ${text.length} total chars)`;
      }

      const duration = segments.length > 0
        ? formatTimestamp(segments[segments.length - 1].offset + (segments[segments.length - 1].duration || 0))
        : "unknown";

      return `YouTube Transcript (${videoId}, lang=${lang}, duration ~${duration}, ${segments.length} segments):\n\n${text}`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`[youtube.transcript] Error for ${videoId}: ${msg}`);

      // FALLBACK: If API fails, try browser extraction
      if (msg.includes("Could not get") || msg.includes("No transcripts")) {
        log.info(`[youtube.transcript] API failed for ${videoId}, trying browser fallback...`);
        try {
          return await extractTranscriptViaBrowser(videoId, showTimestamps);
        } catch (browserErr) {
          const browserMsg = browserErr instanceof Error ? browserErr.message : String(browserErr);
          return `No transcript available via API or browser for video ${videoId}. API error: ${msg}. Browser error: ${browserMsg}`;
        }
      }
      return `Error fetching transcript: ${msg}`;
    }
  },
});

// ── youtube.info ────────────────────────────────────────────

registerSkill({
  name: "youtube.info",
  description:
    "Get metadata about a YouTube video (title, description, channel, duration) by scraping the page. No API key needed.",
  argsSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "YouTube URL or video ID" },
    },
    required: ["url"],
  },
  async execute(args): Promise<string> {
    const input = args.url as string;
    const videoId = extractVideoId(input);
    if (!videoId) return `Error: could not extract video ID from "${input}".`;

    try {
      // Fetch the YouTube page with oembed API (no key needed)
      const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
      const res = await fetch(oembedUrl);

      if (!res.ok) {
        return `Error: YouTube returned ${res.status} for video ${videoId}. Video may be private or deleted.`;
      }

      const data = (await res.json()) as any;

      return [
        `YouTube Video Info:`,
        `Title: ${data.title || "Unknown"}`,
        `Author: ${data.author_name || "Unknown"}`,
        `Channel URL: ${data.author_url || "N/A"}`,
        `Thumbnail: ${data.thumbnail_url || "N/A"}`,
        `URL: https://www.youtube.com/watch?v=${videoId}`,
        `Provider: ${data.provider_name || "YouTube"}`,
      ].join("\n");
    } catch (err) {
      return `Error fetching video info: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});
