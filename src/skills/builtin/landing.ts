/**
 * Built-in skill: landing.generate — AI-powered landing page generator.
 * Generates a responsive HTML landing page and deploys to qplus.plus via FTP.
 * Kingston's tool for autonomous sales page creation.
 */
import fs from "node:fs";
import path from "node:path";
import { registerSkill, getSkill } from "../loader.js";
import { config } from "../../config/env.js";
import { log } from "../../utils/log.js";

const UPLOADS_DIR = () => {
  const dir = path.resolve(config.uploadsDir);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
};

/**
 * Generate landing page HTML using Gemini.
 */
async function generateLandingHTML(
  title: string,
  description: string,
  cta: string,
  style?: string,
): Promise<string> {
  if (!config.geminiApiKey) throw new Error("GEMINI_API_KEY not configured");

  const { runGemini } = await import("../../llm/gemini.js");

  const prompt = `Tu es un expert en landing pages de conversion. Génère une page HTML COMPLÈTE (single-file, inline CSS+JS) pour:

TITRE: ${title}
DESCRIPTION: ${description}
CTA (Call to Action): ${cta}
STYLE: ${style || "moderne, professionnel, sombre avec accents bleu"}

EXIGENCES:
- HTML5 complet avec DOCTYPE, meta viewport, charset UTF-8
- CSS inline (pas de fichiers externes sauf Google Fonts)
- Responsive (mobile-first)
- Sections: Hero avec titre + sous-titre, Features (3-4 points forts), Social proof, CTA final
- Formulaire email de capture (action="https://formspree.io/f/placeholder" method="POST")
- Design premium: gradients, animations subtiles, ombres
- Footer avec "Propulsé par Kingston AI" et lien vers bastilon.org
- Couleurs: fond sombre (#0a0a0f), accents (#3b82f6 bleu), texte blanc
- Police: Inter de Google Fonts
- AUCUN placeholder "Lorem ipsum" — tout le texte doit être réel et pertinent
- Le formulaire doit avoir un champ email et un bouton d'envoi stylisé
- Meta tags Open Graph pour le partage social

Réponds UNIQUEMENT avec le code HTML complet. Pas de markdown, pas d'explication.`;

  const html = await runGemini({
    chatId: 2, // dashboard chatId (internal)
    userMessage: prompt,
    isAdmin: true,
    userId: config.voiceUserId,
  });

  // Clean up: remove markdown fences if present
  let cleaned = html.trim();
  if (cleaned.startsWith("```html")) cleaned = cleaned.slice(7);
  if (cleaned.startsWith("```")) cleaned = cleaned.slice(3);
  if (cleaned.endsWith("```")) cleaned = cleaned.slice(0, -3);
  cleaned = cleaned.trim();

  // Validate it's actual HTML
  if (!cleaned.includes("<!DOCTYPE") && !cleaned.includes("<html")) {
    throw new Error("Generated content is not valid HTML");
  }

  return cleaned;
}

registerSkill({
  name: "landing.generate",
  description:
    "Generate a professional landing page with AI. Creates a responsive HTML page with email capture form and deploys it to qplus.plus. Use this to create sales pages, product pages, or lead capture pages autonomously.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Page title / headline (e.g. 'AI Assistant for Real Estate Brokers')",
      },
      description: {
        type: "string",
        description: "What the product/service does — 2-3 sentences for the landing page content",
      },
      cta: {
        type: "string",
        description: "Call-to-action text (e.g. 'Book a Free Demo', 'Get Started Free')",
      },
      filename: {
        type: "string",
        description: "Output filename without extension (e.g. 'broker-ai'). Will be saved as broker-ai.html",
      },
      style: {
        type: "string",
        description: "Optional style preference (e.g. 'minimal white', 'dark futuristic', 'warm orange')",
      },
      deploy: {
        type: "string",
        description: "Set to 'true' to auto-deploy to qplus.plus via FTP (default: true)",
      },
    },
    required: ["title", "description", "cta"],
  },
  async execute(args): Promise<string> {
    const title = args.title as string;
    const description = args.description as string;
    const cta = args.cta as string;
    const filename = (args.filename as string) || title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30);
    const style = args.style as string | undefined;
    const deploy = (args.deploy as string) !== "false";

    try {
      log.info(`[landing] Generating page: "${title}"`);

      // Generate the HTML
      const html = await generateLandingHTML(title, description, cta, style);

      // Save locally
      const localFile = `${filename}.html`;
      const localPath = path.join(UPLOADS_DIR(), localFile);
      fs.writeFileSync(localPath, html, "utf-8");
      log.info(`[landing] Saved ${localFile} (${html.length} chars)`);

      let deployResult = "";

      // Deploy to FTP if requested
      if (deploy) {
        const ftpSkill = getSkill("ftp.upload");
        if (ftpSkill) {
          try {
            const ftpResult = await ftpSkill.execute({
              local_path: localPath,
              remote_path: `public_html/${localFile}`,
            });
            deployResult = `\nDéployé: https://qplus.plus/${localFile}`;
            log.info(`[landing] Deployed to qplus.plus/${localFile}`);
          } catch (ftpErr) {
            deployResult = `\n⚠️ FTP deploy failed: ${ftpErr instanceof Error ? ftpErr.message : String(ftpErr)}`;
            log.warn(`[landing] FTP deploy failed: ${ftpErr}`);
          }
        } else {
          deployResult = "\n⚠️ ftp.upload skill not available";
        }
      }

      return (
        `Landing page générée: "${title}"\n` +
        `Fichier local: ${localPath}\n` +
        `Taille: ${(html.length / 1024).toFixed(1)} KB${deployResult}`
      );
    } catch (err) {
      return `Error generating landing page: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

registerSkill({
  name: "landing.list",
  description: "List all generated landing pages in the uploads directory.",
  adminOnly: true,
  argsSchema: { type: "object", properties: {} },
  async execute(): Promise<string> {
    const dir = UPLOADS_DIR();
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".html"));
    if (files.length === 0) return "Aucune landing page générée.";
    const lines = files.map((f) => {
      const stat = fs.statSync(path.join(dir, f));
      return `- ${f} (${(stat.size / 1024).toFixed(1)} KB, ${new Date(stat.mtimeMs).toLocaleDateString("fr-CA")})`;
    });
    return `Landing pages (${files.length}):\n${lines.join("\n")}`;
  },
});
