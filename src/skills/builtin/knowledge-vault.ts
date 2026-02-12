/**
 * Built-in skills: memory.import_chat, memory.import_file, memory.vault_stats
 * Knowledge Vault — bulk import WhatsApp/Telegram exports, text files into RAG.
 * Extends the RAG system (knowledge-ingest.ts) with bulk import capabilities.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import { registerSkill } from "../loader.js";
import { getDb } from "../../storage/store.js";
import { embedText } from "../../memory/semantic.js";
import { log } from "../../utils/log.js";

function chunkText(text: string, chunkSize = 800, overlap = 200): string[] {
  if (text.length <= chunkSize) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = start + chunkSize;
    if (end < text.length) {
      const bp = Math.max(text.lastIndexOf("\n", end), text.lastIndexOf(". ", end));
      if (bp > start + chunkSize / 2) end = bp + 1;
    }
    chunks.push(text.slice(start, end).trim());
    start = end - overlap;
    if (start >= text.length) break;
  }
  return chunks.filter(c => c.length > 0);
}

registerSkill({
  name: "memory.import_chat",
  description:
    "Import a WhatsApp or Telegram chat export into the knowledge vault. " +
    "Reads the .txt file, chunks conversations, embeds for semantic search.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Path to the exported chat .txt file" },
      source_name: { type: "string", description: "Name for this chat source (e.g. 'WhatsApp - Sarah')" },
      tags: { type: "string", description: "Comma-separated tags (optional)" },
    },
    required: ["file_path", "source_name"],
  },
  async execute(args): Promise<string> {
    const filePath = String(args.file_path);
    const sourceName = String(args.source_name);
    const tags = args.tags ? String(args.tags).split(",").map(t => t.trim()) : [];

    if (!fs.existsSync(filePath)) return `Fichier non trouvé: ${filePath}`;

    const content = fs.readFileSync(filePath, "utf-8");
    if (content.length < 50) return "Fichier trop court pour être utile.";

    const contentHash = crypto.createHash("sha256").update(content).digest("hex");
    const d = getDb();

    // Check dupe
    const existing = d.prepare("SELECT id FROM knowledge_sources WHERE content_hash = ?").get(contentHash);
    if (existing) return "Ce fichier a déjà été importé.";

    // Store source
    const info = d.prepare(
      `INSERT INTO knowledge_sources (url, url_normalized, title, source_type, summary, raw_content, content_hash, tags)
       VALUES (?, ?, ?, 'chat_export', ?, ?, ?, ?)`
    ).run(
      `file://${filePath}`, filePath, sourceName,
      content.slice(0, 300), content.slice(0, 50000), // cap raw storage
      contentHash, JSON.stringify(tags),
    );
    const sourceId = info.lastInsertRowid as number;

    // Chunk and embed
    const chunks = chunkText(content);
    let embedded = 0;

    for (let i = 0; i < chunks.length; i++) {
      try {
        const emb = await embedText(chunks[i]);
        d.prepare(
          "INSERT INTO knowledge_chunks (source_id, chunk_index, content, embedding) VALUES (?, ?, ?, ?)"
        ).run(sourceId, i, chunks[i], JSON.stringify(emb));
        embedded++;
      } catch {
        d.prepare(
          "INSERT INTO knowledge_chunks (source_id, chunk_index, content) VALUES (?, ?, ?)"
        ).run(sourceId, i, chunks[i]);
      }
    }

    // Count messages (rough estimate)
    const messageCount = (content.match(/\d{1,2}[/:]\d{2}/g) || []).length;

    return (
      `**Chat importé: ${sourceName}**\n` +
      `Source #${sourceId} — ${chunks.length} chunks (${embedded} embedded)\n` +
      `~${messageCount} messages, ${content.length} chars\n` +
      `Utilise memory.recall pour rechercher dans ce chat.`
    );
  },
});

registerSkill({
  name: "memory.import_file",
  description:
    "Import any text file (.txt, .md, .csv) into the knowledge vault for later recall.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Path to the file" },
      title: { type: "string", description: "Title/name for this source" },
      tags: { type: "string", description: "Comma-separated tags" },
    },
    required: ["file_path"],
  },
  async execute(args): Promise<string> {
    const filePath = String(args.file_path);
    if (!fs.existsSync(filePath)) return `Fichier non trouvé: ${filePath}`;

    const content = fs.readFileSync(filePath, "utf-8");
    const title = args.title ? String(args.title) : filePath.split(/[/\\]/).pop() || "file";
    const tags = args.tags ? String(args.tags).split(",").map(t => t.trim()) : [];
    const contentHash = crypto.createHash("sha256").update(content).digest("hex");
    const d = getDb();

    const existing = d.prepare("SELECT id FROM knowledge_sources WHERE content_hash = ?").get(contentHash);
    if (existing) return "Ce fichier a déjà été importé.";

    const info = d.prepare(
      `INSERT INTO knowledge_sources (url, url_normalized, title, source_type, summary, raw_content, content_hash, tags)
       VALUES (?, ?, ?, 'file', ?, ?, ?, ?)`
    ).run(`file://${filePath}`, filePath, title, content.slice(0, 300), content.slice(0, 50000), contentHash, JSON.stringify(tags));
    const sourceId = info.lastInsertRowid as number;

    const chunks = chunkText(content);
    let embedded = 0;

    for (let i = 0; i < chunks.length; i++) {
      try {
        const emb = await embedText(chunks[i]);
        d.prepare("INSERT INTO knowledge_chunks (source_id, chunk_index, content, embedding) VALUES (?, ?, ?, ?)").run(sourceId, i, chunks[i], JSON.stringify(emb));
        embedded++;
      } catch {
        d.prepare("INSERT INTO knowledge_chunks (source_id, chunk_index, content) VALUES (?, ?, ?)").run(sourceId, i, chunks[i]);
      }
    }

    return `Importé: "${title}" — ${chunks.length} chunks (${embedded} embedded), ${content.length} chars`;
  },
});

registerSkill({
  name: "memory.vault_stats",
  description: "Show knowledge vault statistics: sources, chunks, types, storage size.",
  adminOnly: true,
  argsSchema: { type: "object", properties: {} },
  async execute(): Promise<string> {
    const d = getDb();

    const sources = (d.prepare("SELECT COUNT(*) as c FROM knowledge_sources").get() as any).c;
    const chunks = (d.prepare("SELECT COUNT(*) as c FROM knowledge_chunks").get() as any).c;
    const embedded = (d.prepare("SELECT COUNT(*) as c FROM knowledge_chunks WHERE embedding IS NOT NULL").get() as any).c;
    const byType = d.prepare("SELECT source_type, COUNT(*) as c FROM knowledge_sources GROUP BY source_type").all() as any[];

    const lines = [
      `**Knowledge Vault Stats:**\n`,
      `Sources: ${sources}`,
      `Chunks: ${chunks} (${embedded} avec embeddings)`,
      `\n**Par type:**`,
    ];

    for (const t of byType) {
      lines.push(`  ${t.source_type}: ${t.c}`);
    }

    return lines.join("\n");
  },
});

log.debug("Registered 3 memory.vault skills");
