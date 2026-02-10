/**
 * Image operations — resize, crop, watermark, convert, metadata.
 * Uses Python Pillow and optionally ImageMagick for advanced ops.
 */
import { execSync } from "node:child_process";
import { registerSkill } from "../loader.js";

function py(script: string, timeout = 30_000): string {
  const escaped = script.replace(/"/g, '\\"');
  return execSync(`python -c "${escaped}"`, {
    encoding: "utf-8",
    timeout,
    maxBuffer: 1024 * 1024,
  }).toString().trim();
}

function run(cmd: string, timeout = 30_000): string {
  return execSync(cmd, { encoding: "utf-8", timeout, maxBuffer: 1024 * 1024 }).toString().trim();
}

// ── Image Info ───────────────────────────────────────────────

registerSkill({
  name: "image.info",
  description: "Get image info: dimensions, format, file size, color mode.",
  argsSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Image file path" },
    },
    required: ["path"],
  },
  async execute(args) {
    const p = (args.path as string).replace(/\\/g, "/");
    try {
      return py(`
from PIL import Image
import os
img = Image.open('${p}')
size = os.path.getsize('${p}')
print(f'Format: {img.format}')
print(f'Size: {img.width}x{img.height}')
print(f'Mode: {img.mode}')
print(f'File size: {size/1024:.1f} KB')
if img.info.get('dpi'): print(f'DPI: {img.info["dpi"]}')
      `);
    } catch (err) {
      return `Error: ${(err as Error).message.split("\n")[0]}`;
    }
  },
});

// ── Image Resize ─────────────────────────────────────────────

registerSkill({
  name: "image.resize",
  description: "Resize an image to specified dimensions or percentage.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Source image path" },
      output: { type: "string", description: "Output path (default: overwrites source)" },
      width: { type: "number", description: "Target width in pixels" },
      height: { type: "number", description: "Target height in pixels" },
      percent: { type: "number", description: "Scale percentage (e.g. 50 for half size)" },
      keepAspect: { type: "boolean", description: "Keep aspect ratio (default true)" },
    },
    required: ["path"],
  },
  async execute(args) {
    const p = (args.path as string).replace(/\\/g, "/");
    const out = ((args.output as string) || (args.path as string)).replace(/\\/g, "/");
    try {
      if (args.percent) {
        return py(`
from PIL import Image
img = Image.open('${p}')
pct = ${args.percent} / 100
img = img.resize((int(img.width*pct), int(img.height*pct)), Image.LANCZOS)
img.save('${out}')
print(f'Resized to {img.width}x{img.height} ({args.percent}%) -> ${out}')
        `);
      }
      const w = args.width as number;
      const h = args.height as number;
      const keep = args.keepAspect !== false;
      return py(`
from PIL import Image
img = Image.open('${p}')
w, h = ${w || 0}, ${h || 0}
if ${keep} and w and h:
    img.thumbnail((w, h), Image.LANCZOS)
elif w and not h:
    ratio = w / img.width
    img = img.resize((w, int(img.height * ratio)), Image.LANCZOS)
elif h and not w:
    ratio = h / img.height
    img = img.resize((int(img.width * ratio), h), Image.LANCZOS)
else:
    img = img.resize((w, h), Image.LANCZOS)
img.save('${out}')
print(f'Resized to {img.width}x{img.height} -> ${out}')
      `);
    } catch (err) {
      return `Error: ${(err as Error).message.split("\n")[0]}`;
    }
  },
});

// ── Image Crop ───────────────────────────────────────────────

registerSkill({
  name: "image.crop",
  description: "Crop an image to specified coordinates (left, top, right, bottom).",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Source image path" },
      output: { type: "string", description: "Output path" },
      left: { type: "number", description: "Left coordinate" },
      top: { type: "number", description: "Top coordinate" },
      right: { type: "number", description: "Right coordinate" },
      bottom: { type: "number", description: "Bottom coordinate" },
    },
    required: ["path", "left", "top", "right", "bottom"],
  },
  async execute(args) {
    const p = (args.path as string).replace(/\\/g, "/");
    const out = ((args.output as string) || (args.path as string)).replace(/\\/g, "/");
    try {
      return py(`
from PIL import Image
img = Image.open('${p}')
img = img.crop((${args.left}, ${args.top}, ${args.right}, ${args.bottom}))
img.save('${out}')
print(f'Cropped to {img.width}x{img.height} -> ${out}')
      `);
    } catch (err) {
      return `Error: ${(err as Error).message.split("\n")[0]}`;
    }
  },
});

// ── Image Watermark ──────────────────────────────────────────

registerSkill({
  name: "image.watermark",
  description: "Add a text watermark to an image.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Source image path" },
      output: { type: "string", description: "Output path" },
      text: { type: "string", description: "Watermark text" },
      position: { type: "string", description: "center | bottom-right | bottom-left | top-right | top-left (default center)" },
      opacity: { type: "number", description: "Opacity 0-255 (default 128)" },
      fontSize: { type: "number", description: "Font size (default 40)" },
    },
    required: ["path", "text"],
  },
  async execute(args) {
    const p = (args.path as string).replace(/\\/g, "/");
    const out = ((args.output as string) || (args.path as string)).replace(/\\/g, "/");
    const text = args.text as string;
    const opacity = (args.opacity as number) || 128;
    const fontSize = (args.fontSize as number) || 40;
    const position = (args.position as string) || "center";
    try {
      return py(`
from PIL import Image, ImageDraw, ImageFont
img = Image.open('${p}').convert('RGBA')
txt_layer = Image.new('RGBA', img.size, (255,255,255,0))
draw = ImageDraw.Draw(txt_layer)
try:
    font = ImageFont.truetype('arial.ttf', ${fontSize})
except:
    font = ImageFont.load_default()
bbox = draw.textbbox((0,0), '${text}', font=font)
tw, th = bbox[2]-bbox[0], bbox[3]-bbox[1]
pos_map = {
    'center': ((img.width-tw)//2, (img.height-th)//2),
    'bottom-right': (img.width-tw-20, img.height-th-20),
    'bottom-left': (20, img.height-th-20),
    'top-right': (img.width-tw-20, 20),
    'top-left': (20, 20),
}
pos = pos_map.get('${position}', pos_map['center'])
draw.text(pos, '${text}', fill=(255,255,255,${opacity}), font=font)
result = Image.alpha_composite(img, txt_layer).convert('RGB')
result.save('${out}')
print(f'Watermarked -> ${out}')
      `);
    } catch (err) {
      return `Error: ${(err as Error).message.split("\n")[0]}`;
    }
  },
});

// ── Image Convert ────────────────────────────────────────────

registerSkill({
  name: "image.convert",
  description: "Convert image between formats (PNG, JPEG, BMP, WebP, TIFF, GIF).",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Source image path" },
      output: { type: "string", description: "Output path (extension determines format)" },
      quality: { type: "number", description: "JPEG quality 1-100 (default 85)" },
    },
    required: ["path", "output"],
  },
  async execute(args) {
    const p = (args.path as string).replace(/\\/g, "/");
    const out = (args.output as string).replace(/\\/g, "/");
    const quality = (args.quality as number) || 85;
    try {
      return py(`
from PIL import Image
img = Image.open('${p}')
if img.mode == 'RGBA' and '${out}'.lower().endswith(('.jpg','.jpeg')):
    img = img.convert('RGB')
img.save('${out}', quality=${quality})
print(f'Converted -> ${out}')
      `);
    } catch (err) {
      return `Error: ${(err as Error).message.split("\n")[0]}`;
    }
  },
});

// ── FFmpeg Media Convert ─────────────────────────────────────

registerSkill({
  name: "media.convert",
  description: "Convert audio/video files using ffmpeg. Supports all common formats.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      input: { type: "string", description: "Input file path" },
      output: { type: "string", description: "Output file path (extension determines format)" },
      options: { type: "string", description: "Additional ffmpeg options (e.g. '-b:a 192k', '-vcodec libx264')" },
    },
    required: ["input", "output"],
  },
  async execute(args) {
    const input = args.input as string;
    const output = args.output as string;
    const opts = (args.options as string) || "";
    try {
      run(`ffmpeg -i "${input}" ${opts} "${output}" -y`, 300_000);
      return `Converted: ${input} → ${output}`;
    } catch (err) {
      return `Error: ${(err as Error).message.split("\n")[0]}`;
    }
  },
});

// ── Media Info ────────────────────────────────────────────────

registerSkill({
  name: "media.info",
  description: "Get media file info (audio/video) using ffprobe.",
  argsSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Media file path" },
    },
    required: ["path"],
  },
  async execute(args) {
    try {
      return run(`ffprobe -v quiet -print_format json -show_format -show_streams "${args.path}"`, 15_000);
    } catch (err) {
      return `Error: ${(err as Error).message.split("\n")[0]}`;
    }
  },
});
