/**
 * Proof Standard — Inspired by OpenClaw/Noah's "Artifact or it didn't happen"
 *
 * Every significant action Kingston takes should produce a proof record.
 * This prevents hallucination by design: you can't claim "Done!" without
 * an actual artifact (ID, URL, screenshot path, API response).
 *
 * Usage:
 *   const proof = createProof("Published T-shirt to Shopify", "briefing");
 *   proof.addArtifact("product_id", "12345");
 *   proof.addArtifact("url", "https://shop.example/product/xxx");
 *   proof.setStatus("OK");
 *   proof.save();
 *
 * Or use the quick format for briefings:
 *   proofLine("Published T-shirt", { product_id: "12345", url: "..." }, "OK")
 *   → "ACTION: Published T-shirt | PROOF: product_id=12345, url=... | STATUS: OK"
 */
import fs from "node:fs";
import path from "node:path";
import { log } from "../utils/log.js";

const DATA_DIR = path.resolve("data");
const PROOF_LOG = path.join(DATA_DIR, "proof-log.jsonl");

type ProofStatus = "OK" | "FAIL" | "DEGRADED" | "PENDING";

interface ProofRecord {
  id: string;
  action: string;
  source: string;
  artifacts: Record<string, string>;
  status: ProofStatus;
  timestamp: number;
  error?: string;
}

/**
 * Create a proof builder for a multi-step action.
 */
export function createProof(action: string, source: string) {
  const record: ProofRecord = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    action,
    source,
    artifacts: {},
    status: "PENDING",
    timestamp: Date.now(),
  };

  return {
    addArtifact(key: string, value: string) {
      record.artifacts[key] = value;
      return this;
    },

    setStatus(status: ProofStatus, error?: string) {
      record.status = status;
      if (error) record.error = error;
      return this;
    },

    save(): ProofRecord {
      try {
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.appendFileSync(PROOF_LOG, JSON.stringify(record) + "\n");
        log.info(`[proof] ${record.status}: ${record.action} [${Object.keys(record.artifacts).join(",")}]`);
      } catch (e) {
        log.warn(`[proof] Failed to save: ${e}`);
      }
      return record;
    },

    /** Format as a single-line summary for Telegram/logs */
    format(): string {
      const artifactStr = Object.entries(record.artifacts)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
      return `ACTION: ${record.action} | PROOF: ${artifactStr || "none"} | STATUS: ${record.status}`;
    },

    record,
  };
}

/**
 * Quick one-liner proof for briefing sections.
 */
export function proofLine(
  action: string,
  artifacts: Record<string, string>,
  status: ProofStatus,
): string {
  const artifactStr = Object.entries(artifacts)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  return `ACTION: ${action} | PROOF: ${artifactStr || "none"} | STATUS: ${status}`;
}

/**
 * Get recent proof records for audit.
 */
export function recentProofs(limit = 20): ProofRecord[] {
  if (!fs.existsSync(PROOF_LOG)) return [];
  try {
    const lines = fs.readFileSync(PROOF_LOG, "utf-8").split("\n").filter(Boolean);
    return lines
      .slice(-limit)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean) as ProofRecord[];
  } catch {
    return [];
  }
}

/**
 * Count proofs by status for health dashboard.
 */
export function proofStats(hours = 24): { ok: number; fail: number; degraded: number; pending: number } {
  const cutoff = Date.now() - hours * 3600_000;
  const records = recentProofs(500).filter(r => r.timestamp >= cutoff);
  return {
    ok: records.filter(r => r.status === "OK").length,
    fail: records.filter(r => r.status === "FAIL").length,
    degraded: records.filter(r => r.status === "DEGRADED").length,
    pending: records.filter(r => r.status === "PENDING").length,
  };
}
