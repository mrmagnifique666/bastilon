/**
 * PDF skills — merge, split, extract text, page count, metadata.
 * Uses Python (pikepdf, pymupdf/fitz) for PDF manipulation.
 */
import { execSync } from "node:child_process";
import { registerSkill } from "../loader.js";

function py(script: string, timeout = 30_000): string {
  const escaped = script.replace(/"/g, '\\"');
  return execSync(`python -c "${escaped}"`, {
    encoding: "utf-8",
    timeout,
    maxBuffer: 2 * 1024 * 1024,
  }).toString().trim();
}

// ── PDF Info ─────────────────────────────────────────────────

registerSkill({
  name: "pdf.info",
  description: "Get PDF info: page count, metadata, file size.",
  argsSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to PDF file" },
    },
    required: ["path"],
  },
  async execute(args) {
    const p = (args.path as string).replace(/\\/g, "/");
    try {
      return py(`
import fitz, os
doc = fitz.open('${p}')
size = os.path.getsize('${p}')
meta = doc.metadata
print(f'Pages: {doc.page_count}')
print(f'Size: {size/1024:.1f} KB')
for k,v in meta.items():
    if v: print(f'{k}: {v}')
doc.close()
      `);
    } catch (err) {
      return `Error: ${(err as Error).message.split("\n")[0]}`;
    }
  },
});

// ── PDF Extract Text ─────────────────────────────────────────

registerSkill({
  name: "pdf.extract_text",
  description: "Extract text from a PDF. Can extract specific pages.",
  argsSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to PDF file" },
      pages: { type: "string", description: "Page range (e.g. '1-5', '1,3,5'). Default: all" },
      maxChars: { type: "number", description: "Max characters to return (default 10000)" },
    },
    required: ["path"],
  },
  async execute(args) {
    const p = (args.path as string).replace(/\\/g, "/");
    const maxChars = (args.maxChars as number) || 10000;
    const pages = args.pages as string;
    try {
      const pageFilter = pages
        ? `pages = []; [pages.extend(range(int(r.split('-')[0])-1, int(r.split('-')[-1]))) if '-' in r else pages.append(int(r)-1) for r in '${pages}'.split(',')]`
        : `pages = list(range(doc.page_count))`;
      return py(`
import fitz
doc = fitz.open('${p}')
${pageFilter}
text = ''
for i in pages:
    if 0 <= i < doc.page_count:
        text += f'\\n--- Page {i+1} ---\\n' + doc[i].get_text()
doc.close()
print(text[:${maxChars}])
      `);
    } catch (err) {
      return `Error: ${(err as Error).message.split("\n")[0]}`;
    }
  },
});

// ── PDF Merge ────────────────────────────────────────────────

registerSkill({
  name: "pdf.merge",
  description: "Merge multiple PDF files into one.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      files: { type: "string", description: "Comma-separated paths of PDFs to merge" },
      output: { type: "string", description: "Output file path" },
    },
    required: ["files", "output"],
  },
  async execute(args) {
    const files = (args.files as string).split(",").map(f => f.trim().replace(/\\/g, "/"));
    const output = (args.output as string).replace(/\\/g, "/");
    const fileList = files.map(f => `'${f}'`).join(",");
    try {
      py(`
import pikepdf
merger = pikepdf.Pdf.new()
for f in [${fileList}]:
    src = pikepdf.open(f)
    merger.pages.extend(src.pages)
merger.save('${output}')
print(f'Merged {len([${fileList}])} PDFs -> ${output}')
      `);
      return `Merged ${files.length} PDFs → ${output}`;
    } catch (err) {
      return `Error: ${(err as Error).message.split("\n")[0]}`;
    }
  },
});

// ── PDF Split ────────────────────────────────────────────────

registerSkill({
  name: "pdf.split",
  description: "Split a PDF into separate files by page range.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Source PDF path" },
      pages: { type: "string", description: "Page range to extract (e.g. '1-5')" },
      output: { type: "string", description: "Output file path" },
    },
    required: ["path", "pages", "output"],
  },
  async execute(args) {
    const p = (args.path as string).replace(/\\/g, "/");
    const output = (args.output as string).replace(/\\/g, "/");
    const pages = args.pages as string;
    try {
      py(`
import pikepdf
src = pikepdf.open('${p}')
dst = pikepdf.Pdf.new()
parts = '${pages}'.split('-')
start, end = int(parts[0])-1, int(parts[-1])
for i in range(start, min(end, len(src.pages))):
    dst.pages.append(src.pages[i])
dst.save('${output}')
print(f'Extracted pages ${pages} -> ${output}')
      `);
      return `Split pages ${pages} → ${output}`;
    } catch (err) {
      return `Error: ${(err as Error).message.split("\n")[0]}`;
    }
  },
});

// ── PDF to Images ────────────────────────────────────────────

registerSkill({
  name: "pdf.to_images",
  description: "Convert PDF pages to images (PNG).",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Source PDF path" },
      outputDir: { type: "string", description: "Output directory for images" },
      dpi: { type: "number", description: "Resolution in DPI (default 150)" },
      pages: { type: "string", description: "Page range (e.g. '1-3'). Default: all" },
    },
    required: ["path", "outputDir"],
  },
  async execute(args) {
    const p = (args.path as string).replace(/\\/g, "/");
    const outDir = (args.outputDir as string).replace(/\\/g, "/");
    const dpi = (args.dpi as number) || 150;
    const pages = args.pages as string;
    try {
      const pageFilter = pages
        ? `parts = '${pages}'.split('-'); page_range = range(int(parts[0])-1, int(parts[-1]))`
        : `page_range = range(doc.page_count)`;
      return py(`
import fitz, os
os.makedirs('${outDir}', exist_ok=True)
doc = fitz.open('${p}')
${pageFilter}
count = 0
for i in page_range:
    if 0 <= i < doc.page_count:
        page = doc[i]
        pix = page.get_pixmap(dpi=${dpi})
        out = os.path.join('${outDir}', f'page_{i+1:03d}.png')
        pix.save(out)
        count += 1
doc.close()
print(f'Converted {count} pages to PNG in ${outDir}')
      `, 120_000);
    } catch (err) {
      return `Error: ${(err as Error).message.split("\n")[0]}`;
    }
  },
});
