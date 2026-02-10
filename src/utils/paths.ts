/**
 * Shared path utilities for sandboxed file operations.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "../config/env.js";
import { log } from "./log.js";

/**
 * Resolve a user-provided path and ensure it stays within the sandbox.
 * Uses path.relative + ".." check as defense-in-depth against traversal.
 * Returns null if the path escapes.
 */
export function safeSandboxPath(userPath: string): string | null {
  const sandbox = path.resolve(config.sandboxDir);
  // Ensure sandbox exists
  if (!fs.existsSync(sandbox)) {
    fs.mkdirSync(sandbox, { recursive: true });
  }

  // Reject obvious traversal patterns before resolving
  if (userPath.includes("..") || userPath.includes("\0")) {
    log.warn(`Path escape attempt blocked (pattern): ${userPath}`);
    return null;
  }

  const resolved = path.resolve(sandbox, userPath);

  // Primary check: resolved path must be under sandbox
  if (!resolved.startsWith(sandbox + path.sep) && resolved !== sandbox) {
    log.warn(`Path escape attempt blocked (prefix): ${userPath} → ${resolved}`);
    return null;
  }

  // Secondary check: relative path from sandbox must not contain ".."
  const relative = path.relative(sandbox, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    log.warn(`Path escape attempt blocked (relative): ${userPath} → ${relative}`);
    return null;
  }

  return resolved;
}
