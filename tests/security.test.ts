/**
 * Tests for admin-only tool enforcement and combined permission checks.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  isToolAllowed,
  isToolPermitted,
  isAdmin,
  tryAdminAuth,
  revokeAdmin,
} from "../src/security/policy.js";

// Skills must be loaded so getSkill() can find them
import "../src/skills/builtin/shell.js";
import "../src/skills/builtin/system.js";
import "../src/skills/builtin/filewrite.js";
import "../src/skills/builtin/web.js";
import "../src/skills/builtin/help.js";
import "../src/skills/builtin/notes.js";
import "../src/skills/builtin/files.js";

const REGULAR_USER = 111;
const OTHER_USER = 333;

describe("isToolPermitted (combined allowlist + admin)", () => {
  beforeEach(() => {
    // Clear admin sessions to avoid leaking state between tests/runs
    revokeAdmin(REGULAR_USER);
    revokeAdmin(OTHER_USER);
  });

  it("allows non-admin tools for regular users", () => {
    expect(isToolPermitted("help", REGULAR_USER)).toBe(true);
    expect(isToolPermitted("notes.add", REGULAR_USER)).toBe(true);
    expect(isToolPermitted("notes.list", REGULAR_USER)).toBe(true);
    expect(isToolPermitted("files.list", REGULAR_USER)).toBe(true);
    expect(isToolPermitted("files.read", REGULAR_USER)).toBe(true);
    expect(isToolPermitted("web.fetch", REGULAR_USER)).toBe(true);
    expect(isToolPermitted("system.info", REGULAR_USER)).toBe(true);
    expect(isToolPermitted("system.processes", REGULAR_USER)).toBe(true);
  });

  it("blocks admin-only tools for regular users", () => {
    expect(isToolPermitted("shell.exec", REGULAR_USER)).toBe(false);
    expect(isToolPermitted("system.kill", REGULAR_USER)).toBe(false);
    expect(isToolPermitted("system.open", REGULAR_USER)).toBe(false);
    expect(isToolPermitted("files.write_anywhere", REGULAR_USER)).toBe(false);
    expect(isToolPermitted("files.read_anywhere", REGULAR_USER)).toBe(false);
  });

  it("allows admin-only tools after admin auth", () => {
    expect(tryAdminAuth(REGULAR_USER, "test-secret")).toBe(true);
    expect(isAdmin(REGULAR_USER)).toBe(true);
    expect(isToolPermitted("shell.exec", REGULAR_USER)).toBe(true);
    expect(isToolPermitted("system.kill", REGULAR_USER)).toBe(true);
    expect(isToolPermitted("system.open", REGULAR_USER)).toBe(true);
    expect(isToolPermitted("files.write_anywhere", REGULAR_USER)).toBe(true);
    expect(isToolPermitted("files.read_anywhere", REGULAR_USER)).toBe(true);
  });

  it("rejects wrong passphrase", () => {
    expect(tryAdminAuth(OTHER_USER, "wrong-passphrase")).toBe(false);
    expect(isAdmin(OTHER_USER)).toBe(false);
  });

  it("blocks tools not on the allowlist even for admins", () => {
    // "nonexistent.tool" is not in CLAUDE_ALLOWED_TOOLS
    expect(isToolPermitted("nonexistent.tool", REGULAR_USER)).toBe(false);
  });

  it("blocks tools not on the allowlist regardless", () => {
    expect(isToolAllowed("shell.delete_everything")).toBe(false);
  });
});

describe("admin tool registration", () => {
  it("shell.exec is marked adminOnly", async () => {
    const { getSkill } = await import("../src/skills/loader.js");
    const skill = getSkill("shell.exec");
    expect(skill).toBeDefined();
    expect(skill!.adminOnly).toBe(true);
  });

  it("system.kill is marked adminOnly", async () => {
    const { getSkill } = await import("../src/skills/loader.js");
    const skill = getSkill("system.kill");
    expect(skill).toBeDefined();
    expect(skill!.adminOnly).toBe(true);
  });

  it("files.write is NOT adminOnly", async () => {
    const { getSkill } = await import("../src/skills/loader.js");
    const skill = getSkill("files.write");
    expect(skill).toBeDefined();
    expect(skill!.adminOnly).toBeFalsy();
  });

  it("web.fetch is NOT adminOnly", async () => {
    const { getSkill } = await import("../src/skills/loader.js");
    const skill = getSkill("web.fetch");
    expect(skill).toBeDefined();
    expect(skill!.adminOnly).toBeFalsy();
  });
});
