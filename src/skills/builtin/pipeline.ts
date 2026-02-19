/**
 * T-Shirt Pipeline — End-to-end product creation workflow.
 *
 * pipeline.tshirt   — Full E2E: design → Printful → Shopify → Moltbook → revenue
 * pipeline.designs  — List available design files
 * pipeline.status   — Check pipeline run status
 * pipeline.batch    — Run multiple designs through the pipeline
 */
import fs from "node:fs";
import path from "node:path";
import { registerSkill, getSkill } from "../loader.js";
import { config } from "../../config/env.js";
import { log } from "../../utils/log.js";
import { getBotSendFn, getBotPhotoFn } from "./telegram.js";

const PRINTFUL_API = "https://api.printful.com";

// Default Bella+Canvas 3001 (Unisex Jersey Short Sleeve Tee) variant IDs
// Black: S=4016, M=4017, L=4018, XL=4019, 2XL=4020
const DEFAULT_VARIANT_IDS = [4016, 4017, 4018, 4019, 4020];
const DEFAULT_PRODUCT_ID = 71; // Bella+Canvas 3001
const DEFAULT_PRICE = "29.99";

// ── Helpers ──────────────────────────────────────────────────────

/** Send Telegram text notification to Nicolas */
async function notify(text: string): Promise<void> {
  const send = getBotSendFn();
  if (send) {
    try {
      await send(Number(config.adminChatId) || 8189338836, text);
    } catch (e) {
      log.warn(`[pipeline] notify failed: ${(e as Error).message}`);
    }
  }
}

/** Send Telegram photo to Nicolas */
async function notifyPhoto(photoUrl: string, caption?: string): Promise<void> {
  const sendPhoto = getBotPhotoFn();
  if (sendPhoto) {
    try {
      await sendPhoto(Number(config.adminChatId) || 8189338836, photoUrl, caption);
    } catch (e) {
      log.warn(`[pipeline] notifyPhoto failed: ${(e as Error).message}`);
    }
  }
}

/** Upload a local file to Printful File Library via multipart form-data */
async function uploadFileToPrintful(filePath: string): Promise<{ id: number; url: string; preview_url: string }> {
  if (!config.printfulApiToken) throw new Error("PRINTFUL_API_TOKEN not configured");

  const fileBuffer = fs.readFileSync(filePath);
  const filename = path.basename(filePath);
  const ext = path.extname(filename).toLowerCase();
  const mimeType = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";

  const blob = new Blob([fileBuffer], { type: mimeType });
  const formData = new FormData();
  formData.append("file", blob, filename);

  log.info(`[pipeline] Uploading ${filename} (${(fileBuffer.length / 1024).toFixed(0)}KB) to Printful...`);

  const resp = await fetch(`${PRINTFUL_API}/files`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.printfulApiToken}` },
    body: formData,
  });

  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(`Printful upload ${resp.status}: ${data.error?.message || JSON.stringify(data)}`);
  }

  const result = data.result;
  log.info(`[pipeline] Uploaded: id=${result.id} url=${result.url}`);
  return { id: result.id, url: result.url, preview_url: result.preview_url || result.url };
}

/** Printful API helper */
async function printfulFetch(method: string, path: string, body?: unknown): Promise<any> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.printfulApiToken}`,
    "Content-Type": "application/json",
  };
  const storeId = config.printfulStoreId;
  if (storeId) headers["X-PF-Store-Id"] = storeId;
  const opts: RequestInit = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const resp = await fetch(`${PRINTFUL_API}${path}`, opts);
  const data = await resp.json();
  if (!resp.ok) throw new Error(`Printful ${resp.status}: ${data.result || JSON.stringify(data)}`);
  return data.result;
}

/** Execute a registered skill by name */
async function runSkill(name: string, args: Record<string, unknown>): Promise<string> {
  const skill = getSkill(name);
  if (!skill) throw new Error(`Skill "${name}" not registered`);
  return skill.execute(args);
}

/** Sleep helper */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Pipeline State ───────────────────────────────────────────────

interface PipelineStep {
  name: string;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  result?: string;
  error?: string;
  durationMs?: number;
}

interface PipelineRun {
  id: string;
  productName: string;
  status: "running" | "completed" | "failed";
  steps: PipelineStep[];
  startedAt: number;
  completedAt?: number;
  designUrl?: string;
  printfulProductId?: string;
  shopifyProductId?: string;
  mockupUrl?: string;
}

const runs = new Map<string, PipelineRun>();
let runCounter = 0;

function createRun(productName: string): PipelineRun {
  const id = `pipe-${++runCounter}-${Date.now().toString(36)}`;
  const run: PipelineRun = {
    id,
    productName,
    status: "running",
    steps: [
      { name: "Design", status: "pending" },
      { name: "Upload to Printful", status: "pending" },
      { name: "Create Printful Product", status: "pending" },
      { name: "Generate Mockup", status: "pending" },
      { name: "Create Shopify Product", status: "pending" },
      { name: "Moltbook Promotion", status: "pending" },
      { name: "Revenue Tracking", status: "pending" },
    ],
    startedAt: Date.now(),
  };
  runs.set(id, run);
  return run;
}

function formatRunStatus(run: PipelineRun): string {
  const elapsed = ((run.completedAt || Date.now()) - run.startedAt) / 1000;
  const icon = run.status === "completed" ? "✅" : run.status === "failed" ? "❌" : "⏳";
  const lines = [
    `${icon} Pipeline: ${run.productName} [${run.id}]`,
    `Status: ${run.status} | ${elapsed.toFixed(1)}s`,
    "",
  ];
  for (const step of run.steps) {
    const si =
      step.status === "done" ? "✅" :
      step.status === "failed" ? "❌" :
      step.status === "running" ? "⏳" :
      step.status === "skipped" ? "⏭️" : "⬜";
    let line = `${si} ${step.name}`;
    if (step.durationMs) line += ` (${(step.durationMs / 1000).toFixed(1)}s)`;
    if (step.error) line += ` — ${step.error}`;
    lines.push(line);
  }
  if (run.designUrl) lines.push(`\nDesign: ${run.designUrl}`);
  if (run.mockupUrl) lines.push(`Mockup: ${run.mockupUrl}`);
  if (run.printfulProductId) lines.push(`Printful ID: ${run.printfulProductId}`);
  if (run.shopifyProductId) lines.push(`Shopify ID: ${run.shopifyProductId}`);
  return lines.join("\n");
}

async function runStep(run: PipelineRun, index: number, fn: () => Promise<string>): Promise<string> {
  const step = run.steps[index];
  step.status = "running";
  const t0 = Date.now();
  try {
    const result = await fn();
    step.status = "done";
    step.result = result;
    step.durationMs = Date.now() - t0;
    return result;
  } catch (e) {
    step.status = "failed";
    step.error = (e as Error).message;
    step.durationMs = Date.now() - t0;
    throw e;
  }
}

function skipStep(run: PipelineRun, index: number, reason: string): void {
  run.steps[index].status = "skipped";
  run.steps[index].result = reason;
}

// ── Design Directories ──────────────────────────────────────────

function getDesignDirs(): string[] {
  const base = path.resolve(config.uploadsDir || "uploads");
  return [
    base,
    path.resolve("bastion/designs"),
    path.resolve("data/designs"),
    path.resolve("sandbox/designs"),
  ];
}

function findDesignFiles(): Array<{ name: string; path: string; size: number }> {
  const files: Array<{ name: string; path: string; size: number }> = [];
  for (const dir of getDesignDirs()) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!/\.(png|jpg|jpeg)$/i.test(f)) continue;
      const fp = path.join(dir, f);
      const stat = fs.statSync(fp);
      files.push({ name: f, path: fp, size: stat.size });
    }
  }
  return files.sort((a, b) => b.size - a.size); // largest first (likely print-quality)
}

// ── Main Pipeline Skill ─────────────────────────────────────────

registerSkill({
  name: "pipeline.tshirt",
  description:
    "Full end-to-end t-shirt pipeline: design generation → Printful upload → product creation → mockup → Shopify listing → Moltbook promotion → revenue tracking. Provide either a design_prompt (to generate new), design_path (existing local file), or design_url (existing public URL).",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Product name (e.g. 'Fear Is Expensive - Trading Tee')" },
      design_prompt: { type: "string", description: "AI prompt to generate a new design" },
      design_path: { type: "string", description: "Path to existing local design file" },
      design_url: { type: "string", description: "Public URL of existing design (skips upload)" },
      description: { type: "string", description: "Product description (HTML ok)" },
      price: { type: "string", description: "Retail price (default 29.99)" },
      variant_ids: { type: "string", description: "Comma-separated Printful variant IDs (default: Bella+Canvas 3001 Black S-2XL)" },
      tags: { type: "string", description: "Comma-separated tags (default: openclaw,ai,kingston)" },
      collection: { type: "string", description: "Shopify vendor/brand (default: OpenClaw)" },
      moltbook_text: { type: "string", description: "Custom Moltbook post text (auto-generated if empty)" },
      chatId: { type: "string", description: "Telegram chat ID for updates" },
      skip_shopify: { type: "string", description: "true to skip Shopify step" },
      skip_moltbook: { type: "string", description: "true to skip Moltbook promotion" },
      skip_mockup: { type: "string", description: "true to skip mockup generation" },
    },
    required: ["name"],
  },
  async execute(args): Promise<string> {
    const productName = String(args.name);
    const price = String(args.price || DEFAULT_PRICE);
    const variantIds = args.variant_ids
      ? String(args.variant_ids).split(",").map(Number)
      : DEFAULT_VARIANT_IDS;
    const tags = String(args.tags || "openclaw,ai,kingston,t-shirt");
    const collection = String(args.collection || "OpenClaw");
    const skipShopify = String(args.skip_shopify) === "true";
    const skipMoltbook = String(args.skip_moltbook) === "true";
    const skipMockup = String(args.skip_mockup) === "true";
    const chatId = args.chatId ? Number(args.chatId) : undefined;

    const run = createRun(productName);
    log.info(`[pipeline] Starting t-shirt pipeline: ${productName} [${run.id}]`);
    await notify(`🏭 Pipeline démarré: ${productName}\n📋 ${run.id}`);

    let designUrl = args.design_url ? String(args.design_url) : "";
    let designPath = args.design_path ? String(args.design_path) : "";

    try {
      // ── Step 0: Design ────────────────────────────────
      if (designUrl) {
        // Already have a public URL
        skipStep(run, 0, `Using existing URL: ${designUrl}`);
        run.designUrl = designUrl;
      } else if (designPath) {
        // Have a local file, skip generation
        if (!fs.existsSync(designPath)) throw new Error(`Design file not found: ${designPath}`);
        skipStep(run, 0, `Using existing file: ${designPath}`);
      } else if (args.design_prompt) {
        // Generate new design
        const prompt = String(args.design_prompt);
        const savePath = path.resolve(
          config.uploadsDir || "uploads",
          `tshirt_${productName.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 40)}.png`
        );

        await runStep(run, 0, async () => {
          await notify(`🎨 Generating design: ${prompt.slice(0, 80)}...`);

          const enhancedPrompt = `T-shirt design for print-on-demand. ${prompt}.
Clean design on transparent or solid dark background. High resolution, print-quality.
Bold typography if text involved. Modern aesthetic. No mockup, just the design art.`;

          const result = await runSkill("image.generate", {
            prompt: enhancedPrompt,
            chatId: String(chatId || config.adminChatId || "8189338836"),
            save_to: savePath,
          });

          designPath = savePath;
          return result;
        });
      } else {
        throw new Error("Provide design_prompt, design_path, or design_url");
      }

      // ── Step 1: Upload to Printful ────────────────────
      if (!designUrl && designPath) {
        await runStep(run, 1, async () => {
          await notify("📤 Uploading design to Printful...");
          const upload = await uploadFileToPrintful(designPath);
          designUrl = upload.url;
          run.designUrl = designUrl;
          return `Uploaded: id=${upload.id} url=${upload.url}`;
        });
      } else if (designUrl) {
        skipStep(run, 1, "Design URL already public");
      }

      if (!designUrl) throw new Error("No design URL available after upload step");

      // ── Step 2: Create Printful Product ───────────────
      let printfulProductId = "";
      await runStep(run, 2, async () => {
        await notify("🏭 Creating Printful product...");

        const productData = {
          sync_product: { name: productName, thumbnail: designUrl },
          sync_variants: variantIds.map((vid: number) => ({
            variant_id: vid,
            retail_price: price,
            files: [{ url: designUrl, type: "front" }],
          })),
        };

        const result = await printfulFetch("POST", "/store/products", productData);
        printfulProductId = String(result.id);
        run.printfulProductId = printfulProductId;
        return `Printful product created: id=${result.id} name="${productName}" variants=${variantIds.length}`;
      });

      // ── Step 3: Generate Mockup ───────────────────────
      let mockupUrl = "";
      if (skipMockup) {
        skipStep(run, 3, "Skipped by user");
      } else {
        await runStep(run, 3, async () => {
          await notify("📸 Generating mockup...");

          // Start mockup task
          const taskResult = await printfulFetch(
            "POST",
            `/mockup-generator/create-task/${DEFAULT_PRODUCT_ID}`,
            {
              files: [{ placement: "front", image_url: designUrl }],
              variant_ids: variantIds.slice(0, 5),
            }
          );

          const taskKey = taskResult.task_key;
          log.info(`[pipeline] Mockup task started: ${taskKey}`);

          // Poll for completion (max 60s)
          for (let i = 0; i < 12; i++) {
            await sleep(5000);
            const status = await printfulFetch(
              "GET",
              `/mockup-generator/task?task_key=${taskKey}`
            );

            if (status.status === "completed") {
              const mockups = status.mockups || [];
              if (mockups.length > 0) {
                mockupUrl = mockups[0].mockup_url;
                run.mockupUrl = mockupUrl;

                // Send mockup to Telegram
                await notifyPhoto(mockupUrl, `📸 Mockup: ${productName}`);
              }
              return `Mockup ready: ${mockups.length} images. Primary: ${mockupUrl}`;
            }

            if (status.status === "failed") {
              throw new Error(`Mockup generation failed: ${JSON.stringify(status.error || {})}`);
            }
          }

          throw new Error("Mockup generation timed out (60s)");
        });
      }

      // ── Step 4: Create Shopify Product ────────────────
      if (skipShopify || !config.shopifyStoreDomain || !config.shopifyAccessToken) {
        const reason = skipShopify
          ? "Skipped by user"
          : "Shopify not configured (set SHOPIFY_STORE_DOMAIN + SHOPIFY_ACCESS_TOKEN)";
        skipStep(run, 4, reason);
      } else {
        await runStep(run, 4, async () => {
          await notify("🛒 Creating Shopify product...");

          const desc =
            args.description
              ? String(args.description)
              : `<p><strong>${productName}</strong></p>
<p>Premium quality Bella + Canvas 3001 unisex tee. 100% combed ring-spun cotton, retail fit.</p>
<p>Print-on-demand — designed by Kingston AI.</p>
<p><em>OpenClaw Collection</em></p>`;

          const imageUrl = mockupUrl || designUrl;

          const result = await runSkill("shopify.create_product", {
            title: productName,
            body_html: desc,
            vendor: collection,
            product_type: "Apparel",
            tags,
            price,
            image_url: imageUrl,
            status: "draft",
          });

          // Extract product ID from result (format: "id=12345")
          const idMatch = result.match(/id=(\d+)/);
          if (idMatch) {
            run.shopifyProductId = idMatch[1];
          }

          return result;
        });
      }

      // ── Step 5: Moltbook Promotion ────────────────────
      if (skipMoltbook) {
        skipStep(run, 5, "Skipped by user");
      } else {
        await runStep(run, 5, async () => {
          await notify("📣 Creating Moltbook promotional post...");

          const postText =
            args.moltbook_text
              ? String(args.moltbook_text)
              : `🚀 New drop: ${productName}\n\nDesigned by Kingston AI for the OpenClaw collection. Premium Bella+Canvas tee, $${price}.\n\n#OpenClaw #AI #Design #Kingston`;

          try {
            const result = await runSkill("moltbook.post", {
              submolt: "general",
              title: `New Drop: ${productName}`,
              content: postText,
            });
            return result;
          } catch (e) {
            // Moltbook post failure is non-critical
            return `Moltbook post failed (non-critical): ${(e as Error).message}`;
          }
        });
      }

      // ── Step 6: Revenue Tracking ──────────────────────
      await runStep(run, 6, async () => {
        try {
          const result = await runSkill("revenue.track", {
            source: `tshirt:${productName}`,
            amount: "0",
            type: "invoice",
            description: `Product listed: ${productName} @ $${price}/unit. Printful ID: ${printfulProductId}. Target: ${Math.ceil(150 / (Number(price) - 16.66))} sales for $150 goal.`,
          });
          return result;
        } catch {
          return "Revenue tracking skipped (skill not available)";
        }
      });

      // ── Done ──────────────────────────────────────────
      run.status = "completed";
      run.completedAt = Date.now();

      const summary = formatRunStatus(run);
      await notify(`✅ Pipeline terminé!\n\n${summary}`);

      log.info(`[pipeline] Completed: ${run.id} in ${((run.completedAt - run.startedAt) / 1000).toFixed(1)}s`);
      return summary;
    } catch (e) {
      run.status = "failed";
      run.completedAt = Date.now();
      const errMsg = (e as Error).message;
      log.error(`[pipeline] Failed: ${run.id} — ${errMsg}`);

      const summary = formatRunStatus(run);
      await notify(`❌ Pipeline échoué: ${productName}\n${errMsg}\n\n${summary}`);
      return summary;
    }
  },
});

// ── List Designs ─────────────────────────────────────────────────

registerSkill({
  name: "pipeline.designs",
  description: "List available t-shirt design files across all design directories",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      filter: { type: "string", description: "Filter designs by name keyword" },
    },
  },
  async execute(args): Promise<string> {
    let designs = findDesignFiles();

    if (args.filter) {
      const kw = String(args.filter).toLowerCase();
      designs = designs.filter(d => d.name.toLowerCase().includes(kw));
    }

    if (!designs.length) return "No design files found.";

    const lines = designs.map(
      d => `  ${d.name} — ${(d.size / 1024).toFixed(0)}KB — ${d.path}`
    );

    return `Designs (${designs.length}):\n${lines.join("\n")}\n\nUse pipeline.tshirt with design_path to create a product.`;
  },
});

// ── Pipeline Status ──────────────────────────────────────────────

registerSkill({
  name: "pipeline.status",
  description: "Check the status of a pipeline run, or list all recent runs",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Pipeline run ID (optional, lists all if omitted)" },
    },
  },
  async execute(args): Promise<string> {
    if (args.id) {
      const run = runs.get(String(args.id));
      if (!run) return `Pipeline run "${args.id}" not found.`;
      return formatRunStatus(run);
    }

    if (runs.size === 0) return "No pipeline runs yet.";

    const allRuns = Array.from(runs.values())
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, 10);

    const lines = allRuns.map(r => {
      const icon = r.status === "completed" ? "✅" : r.status === "failed" ? "❌" : "⏳";
      const elapsed = ((r.completedAt || Date.now()) - r.startedAt) / 1000;
      const done = r.steps.filter(s => s.status === "done").length;
      return `${icon} [${r.id}] ${r.productName} — ${r.status} — ${done}/${r.steps.length} steps — ${elapsed.toFixed(1)}s`;
    });

    return `Pipeline runs (${runs.size}):\n${lines.join("\n")}`;
  },
});

// ── Batch Pipeline ───────────────────────────────────────────────

registerSkill({
  name: "pipeline.batch",
  description: "Run multiple designs through the t-shirt pipeline sequentially",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      designs: {
        type: "string",
        description:
          'JSON array of designs: [{"name":"Product Name","design_path":"path/to/file.png","price":"29.99"}, ...]',
      },
      price: { type: "string", description: "Default price for all (default 29.99)" },
      skip_shopify: { type: "string", description: "true to skip Shopify for all" },
      skip_moltbook: { type: "string", description: "true to skip Moltbook for all" },
    },
    required: ["designs"],
  },
  async execute(args): Promise<string> {
    let designs: Array<{ name: string; design_path?: string; design_url?: string; design_prompt?: string; price?: string }>;
    try {
      designs = JSON.parse(String(args.designs));
    } catch {
      return 'Error: designs must be valid JSON array, e.g. [{"name":"Cool Tee","design_path":"uploads/cool.png"}]';
    }

    if (!Array.isArray(designs) || designs.length === 0) return "Error: empty designs array";
    if (designs.length > 10) return "Error: max 10 designs per batch";

    const defaultPrice = String(args.price || DEFAULT_PRICE);
    const results: string[] = [];

    await notify(`🏭 Batch pipeline: ${designs.length} designs starting...`);

    for (let i = 0; i < designs.length; i++) {
      const d = designs[i];
      log.info(`[pipeline] Batch ${i + 1}/${designs.length}: ${d.name}`);

      try {
        const skill = getSkill("pipeline.tshirt");
        if (!skill) throw new Error("pipeline.tshirt not registered");

        const result = await skill.execute({
          name: d.name,
          design_path: d.design_path,
          design_url: d.design_url,
          design_prompt: d.design_prompt,
          price: d.price || defaultPrice,
          skip_shopify: args.skip_shopify,
          skip_moltbook: args.skip_moltbook,
        });

        results.push(`✅ ${i + 1}. ${d.name}\n${result}`);
      } catch (e) {
        results.push(`❌ ${i + 1}. ${d.name}: ${(e as Error).message}`);
      }

      // Small delay between runs to avoid rate limits
      if (i < designs.length - 1) await sleep(2000);
    }

    const summary = `Batch complete: ${results.filter(r => r.startsWith("✅")).length}/${designs.length} succeeded\n\n${results.join("\n\n---\n\n")}`;
    await notify(summary.slice(0, 4000));
    return summary;
  },
});

// ── Quick Product (from existing design, minimal config) ─────────

registerSkill({
  name: "pipeline.quick",
  description:
    "Quick product creation from an existing design file. Just provide name + file path. Uses all defaults (Bella+Canvas 3001, $29.99, OpenClaw).",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Product name" },
      design: { type: "string", description: "Design file path or name (searches design dirs)" },
      price: { type: "string", description: "Price override (default 29.99)" },
    },
    required: ["name", "design"],
  },
  async execute(args): Promise<string> {
    const name = String(args.name);
    let designPath = String(args.design);

    // If not an absolute path, search design directories
    if (!path.isAbsolute(designPath)) {
      const designs = findDesignFiles();
      const match = designs.find(
        d => d.name === designPath || d.name.includes(designPath)
      );
      if (match) {
        designPath = match.path;
      } else {
        return `Design "${args.design}" not found. Use pipeline.designs to list available files.`;
      }
    }

    if (!fs.existsSync(designPath)) {
      return `Design file not found: ${designPath}`;
    }

    const skill = getSkill("pipeline.tshirt");
    if (!skill) return "pipeline.tshirt not registered";

    return skill.execute({
      name,
      design_path: designPath,
      price: args.price || DEFAULT_PRICE,
    });
  },
});

log.debug("Registered 5 pipeline.* skills");
