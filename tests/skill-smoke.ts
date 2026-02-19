/**
 * Skill Smoke Tests — Direct .execute() testing of key skills.
 * Run: npx tsx tests/skill-smoke.ts
 *
 * Tests binance.*, crypto_paper.*, dungeon.start, dungeon.roll
 * without going through the Telegram bot or LLM layer.
 */

// Setup env before anything else
import "./setup.js";

import { loadBuiltinSkills, getSkill, getAllSkills } from "../src/skills/loader.js";
import {
  getDb, savedCharCreate, savedCharGet, savedCharList, savedCharUpdate,
  savedCharDelete, savedCharSyncFromSession, dungeonAddCharacter, dungeonCreateSession,
} from "../src/storage/store.js";

// ── Test Framework ──

interface TestResult {
  name: string;
  passed: boolean;
  detail: string;
  durationMs: number;
}

const results: TestResult[] = [];

async function runTest(
  name: string,
  fn: () => Promise<void>,
): Promise<void> {
  const start = Date.now();
  try {
    await fn();
    results.push({ name, passed: true, detail: "OK", durationMs: Date.now() - start });
    console.log(`  ✅ ${name} (${Date.now() - start}ms)`);
  } catch (err: any) {
    const msg = err.message || String(err);
    results.push({ name, passed: false, detail: msg, durationMs: Date.now() - start });
    console.log(`  ❌ ${name}: ${msg}`);
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertContains(text: string, substring: string, label?: string): void {
  if (!text.includes(substring)) {
    throw new Error(`${label || "Result"} should contain "${substring}" but got: "${text.slice(0, 200)}"`);
  }
}

function assertNotContains(text: string, substring: string, label?: string): void {
  if (text.includes(substring)) {
    throw new Error(`${label || "Result"} should NOT contain "${substring}"`);
  }
}

// ── Main ──

async function main() {
  console.log("\n🔧 Skill Smoke Tests\n");
  console.log("Loading skills...");

  // Initialize DB + skills
  getDb(); // triggers table creation
  await loadBuiltinSkills();

  const totalSkills = getAllSkills().length;
  console.log(`Loaded ${totalSkills} skills.\n`);

  // ═══════════════════════════════════════════════
  // BINANCE TESTS (public API — no keys needed)
  // ═══════════════════════════════════════════════
  console.log("── Binance Skills ──");

  await runTest("binance.price — bitcoin", async () => {
    const skill = getSkill("binance.price");
    assert(!!skill, "binance.price skill not found");
    const result = await skill!.execute({ symbol: "bitcoin" });
    assertContains(result, "BTCUSDT", "Price result");
    assertContains(result, "$", "Should have dollar sign");
    // Should contain a percentage change
    assert(/[+-]?\d+\.\d+%/.test(result), `Should contain percentage change, got: ${result.slice(0, 100)}`);
  });

  await runTest("binance.price — multi symbols", async () => {
    const skill = getSkill("binance.price")!;
    const result = await skill.execute({ symbol: "ethereum,solana" });
    assertContains(result, "ETHUSDT");
    assertContains(result, "SOLUSDT");
  });

  await runTest("binance.top — gainers", async () => {
    const skill = getSkill("binance.top");
    assert(!!skill, "binance.top skill not found");
    const result = await skill!.execute({});
    assertContains(result, "Top Gainers", "Should show gainers");
    // Should have numbered results
    assertContains(result, "1.", "Should have at least one result");
    assertContains(result, "USDT", "Should show USDT pairs");
  });

  await runTest("binance.top — losers", async () => {
    const skill = getSkill("binance.top")!;
    const result = await skill.execute({ direction: "losers" });
    assertContains(result, "Top Losers");
  });

  await runTest("binance.klines — BTC 1h", async () => {
    const skill = getSkill("binance.klines");
    assert(!!skill, "binance.klines skill not found");
    const result = await skill!.execute({ symbol: "bitcoin", interval: "1h", limit: 5 });
    assertContains(result, "BTCUSDT");
    assertContains(result, "Trend:");
    assertContains(result, "Current:");
  });

  // ═══════════════════════════════════════════════
  // CRYPTO PAPER TRADING TESTS (local DB)
  // Uses CoinGecko for prices — rate-limit tolerant
  // ═══════════════════════════════════════════════
  console.log("\n── Crypto Paper Trading ──");

  const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
  let paperBuyOk = false; // tracks if buy succeeded for dependent tests

  await runTest("crypto_paper.init — create account", async () => {
    const skill = getSkill("crypto_paper.init");
    assert(!!skill, "crypto_paper.init skill not found");
    const result = await skill!.execute({ reset: true });
    assertContains(result, "$10,000", "Should show starting balance");
    assertContains(result, "Ready", "Should show ready status");
  });

  await runTest("crypto_paper.account — show balance", async () => {
    const skill = getSkill("crypto_paper.account");
    assert(!!skill, "crypto_paper.account skill not found");
    const result = await skill!.execute({});
    assertContains(result, "Paper Trading Account");
    assertContains(result, "$10,000", "Should show full balance");
  });

  // Delay to avoid CoinGecko 429 after Binance tests hit crypto.price
  await delay(2000);

  await runTest("crypto_paper.buy — buy bitcoin", async () => {
    const skill = getSkill("crypto_paper.buy");
    assert(!!skill, "crypto_paper.buy skill not found");
    try {
      const result = await skill!.execute({
        symbol: "bitcoin",
        amount: 1000,
        reasoning: "smoke test — testing buy flow",
      });
      assertContains(result, "ACHAT", "Should confirm buy");
      assertContains(result, "BITCOIN", "Should show coin name");
      assertContains(result, "smoke test", "Should echo reasoning");
      paperBuyOk = true;
    } catch (err: any) {
      if (err.message?.includes("429")) {
        console.log("    (CoinGecko 429 rate limit — skill logic OK, API throttled)");
        return;
      }
      throw err;
    }
  });

  await runTest("crypto_paper.positions — show open positions", async () => {
    if (!paperBuyOk) {
      console.log("    (skipped — buy was rate-limited)");
      return;
    }
    const skill = getSkill("crypto_paper.positions");
    assert(!!skill, "crypto_paper.positions skill not found");
    try {
      const result = await skill!.execute({});
      assertContains(result, "BITCOIN", "Should show BTC position");
      assertContains(result, "Positions ouvertes", "Should have header");
    } catch (err: any) {
      if (err.message?.includes("429")) {
        console.log("    (CoinGecko 429 rate limit — skill logic OK)");
        return;
      }
      throw err;
    }
  });

  await delay(1000);

  await runTest("crypto_paper.sell — sell all bitcoin", async () => {
    if (!paperBuyOk) {
      console.log("    (skipped — buy was rate-limited)");
      return;
    }
    const skill = getSkill("crypto_paper.sell");
    assert(!!skill, "crypto_paper.sell skill not found");
    try {
      const result = await skill!.execute({
        symbol: "bitcoin",
        quantity: "all",
        reasoning: "smoke test — testing sell flow",
      });
      assertContains(result, "VENTE", "Should confirm sell");
      assertContains(result, "BITCOIN");
      assertContains(result, "P&L:", "Should show P&L");
    } catch (err: any) {
      if (err.message?.includes("429")) {
        console.log("    (CoinGecko 429 rate limit — skill logic OK)");
        return;
      }
      throw err;
    }
  });

  await runTest("crypto_paper.pnl — P&L report", async () => {
    const skill = getSkill("crypto_paper.pnl");
    assert(!!skill, "crypto_paper.pnl skill not found");
    const result = await skill!.execute({ period: "all" });
    assertContains(result, "P&L Summary");
    assertContains(result, "Total trades:");
  });

  await runTest("crypto_paper.scan — market scan", async () => {
    const skill = getSkill("crypto_paper.scan");
    assert(!!skill, "crypto_paper.scan skill not found");
    try {
      const result = await skill!.execute({});
      assertContains(result, "Scan Crypto", "Should have header");
      assertContains(result, "Slots dispo", "Should show available slots");
    } catch (err: any) {
      if (err.message?.includes("429")) {
        console.log("    (CoinGecko 429 rate limit — skill OK, API throttled)");
        return;
      }
      throw err;
    }
  });

  // ═══════════════════════════════════════════════
  // DUNGEON / TTRPG TESTS
  // ═══════════════════════════════════════════════
  console.log("\n── Dungeon Skills ──");

  await runTest("dungeon.start — create Shadowrun campaign", async () => {
    const skill = getSkill("dungeon.start");
    assert(!!skill, "dungeon.start skill not found");
    const result = await skill!.execute({
      name: "Smoke Test Run",
      ruleset: "shadowrun",
      characters: "Ace/Humain/Decker",
    });
    // Should confirm campaign creation
    assert(result.length > 50, `Response too short: ${result.slice(0, 100)}`);
    // Should mention shadowrun or the campaign name
    const lower = result.toLowerCase();
    assert(
      lower.includes("smoke test run") || lower.includes("shadowrun") || lower.includes("campagne") || lower.includes("session"),
      `Should confirm campaign, got: ${result.slice(0, 200)}`
    );
  });

  await runTest("dungeon.roll — Shadowrun d6 pool", async () => {
    const skill = getSkill("dungeon.roll");
    assert(!!skill, "dungeon.roll skill not found");
    const result = await skill!.execute({
      dice: "8",
      shadowrun: true,
      purpose: "hacking test",
    });
    assertContains(result, "Pool 8d6", "Should show pool size");
    assertContains(result, "Succes", "Should count hits");
    assertContains(result, "hacking test", "Should show purpose");
  });

  await runTest("dungeon.roll — D&D standard", async () => {
    const skill = getSkill("dungeon.roll")!;
    const result = await skill.execute({
      dice: "2d6+3",
      purpose: "attack roll",
    });
    assertContains(result, "2d6+3", "Should echo dice notation");
    assertContains(result, "attack roll", "Should show purpose");
    // Should have a total number
    assert(/= \*\*\d+\*\*/.test(result), `Should have total, got: ${result}`);
  });

  // ═══════════════════════════════════════════════
  // VALIDATION TESTS (edge cases)
  // ═══════════════════════════════════════════════
  console.log("\n── Validation / Edge Cases ──");

  await runTest("crypto_paper.buy — reject no reasoning", async () => {
    const skill = getSkill("crypto_paper.buy")!;
    const result = await skill.execute({ symbol: "ethereum", amount: 500, reasoning: "" });
    assertContains(result, "❌", "Should reject with error");
  });

  await runTest("crypto_paper.buy — reject over limit", async () => {
    const skill = getSkill("crypto_paper.buy")!;
    const result = await skill.execute({ symbol: "ethereum", amount: 5000, reasoning: "too much" });
    assertContains(result, "❌", "Should reject with error");
    assertContains(result, "3,000", "Should mention limit");
  });

  await runTest("crypto_paper.sell — reject no position", async () => {
    const skill = getSkill("crypto_paper.sell")!;
    const result = await skill.execute({ symbol: "nonexistent_coin", quantity: "all", reasoning: "test" });
    assertContains(result, "❌", "Should reject");
  });

  await runTest("binance.price — invalid symbol", async () => {
    const skill = getSkill("binance.price")!;
    const result = await skill.execute({ symbol: "ZZZINVALID999" });
    assertContains(result, "Error", "Should report error for invalid symbol");
  });

  // ═══════════════════════════════════════════════
  // SAVED CHARACTER ROSTER TESTS (DB-level)
  // ═══════════════════════════════════════════════
  console.log("\n── Saved Character Roster ──");

  let testSavedId = 0;

  await runTest("savedCharCreate — create D&D character", async () => {
    testSavedId = savedCharCreate({
      owner: "TestPlayer",
      game_system: "dnd5e",
      name: "Thorin Oakenshield",
      race: "Nain",
      class: "Guerrier",
      level: 5,
      hp: 45,
      hp_max: 50,
      ac: 18,
      stats: { str: 16, dex: 10, con: 14, int: 8, wis: 12, cha: 10 },
      inventory: ["Hache de guerre", "Bouclier", "Cotte de mailles"],
      backstory: "Un nain exile en quete de vengeance.",
      traits: "Têtu mais loyal",
    });
    assert(testSavedId > 0, `Should return valid ID, got: ${testSavedId}`);
  });

  await runTest("savedCharGet — retrieve by ID", async () => {
    const char = savedCharGet(testSavedId);
    assert(char !== null, "Should find character");
    assert(char!.name === "Thorin Oakenshield", `Name mismatch: ${char!.name}`);
    assert(char!.owner === "TestPlayer", `Owner mismatch: ${char!.owner}`);
    assert(char!.game_system === "dnd5e", `System mismatch: ${char!.game_system}`);
    assert(char!.level === 5, `Level mismatch: ${char!.level}`);
    assert(char!.stats.str === 16, `STR mismatch: ${char!.stats.str}`);
    assert(Array.isArray(char!.inventory), "Inventory should be array");
    assert(char!.inventory.length === 3, `Inventory count: ${char!.inventory.length}`);
  });

  await runTest("savedCharList — list by owner", async () => {
    const chars = savedCharList("TestPlayer");
    assert(chars.length >= 1, `Should find at least 1, got: ${chars.length}`);
    assert(chars.some(c => c.name === "Thorin Oakenshield"), "Should find Thorin");
  });

  await runTest("savedCharList — filter by game system", async () => {
    // Create a Shadowrun character
    savedCharCreate({
      owner: "TestPlayer",
      game_system: "shadowrun",
      name: "Ghost",
      race: "Elf",
      class: "Decker",
      hp: 10,
      hp_max: 10,
      stats: { body: 3, agility: 4, logic: 6 },
      inventory: ["Cyberdeck"],
    });
    const srChars = savedCharList("TestPlayer", "shadowrun");
    assert(srChars.length >= 1, "Should find SR character");
    assert(srChars.every(c => c.game_system === "shadowrun"), "All should be SR");
    const dndChars = savedCharList("TestPlayer", "dnd5e");
    assert(dndChars.length >= 1, "Should find D&D character");
    assert(dndChars.every(c => c.game_system === "dnd5e"), "All should be D&D");
  });

  await runTest("savedCharUpdate — level up", async () => {
    savedCharUpdate(testSavedId, { level: 6, hp: 50, hp_max: 55 });
    const char = savedCharGet(testSavedId);
    assert(char!.level === 6, `Level should be 6, got: ${char!.level}`);
    assert(char!.hp === 50, `HP should be 50, got: ${char!.hp}`);
    assert(char!.hp_max === 55, `HP max should be 55, got: ${char!.hp_max}`);
  });

  await runTest("savedCharSyncFromSession — sync from session character", async () => {
    // Create a session + character
    const sessId = dungeonCreateSession("Sync Test", "Test setting");
    const charId = dungeonAddCharacter(sessId, {
      name: "Thorin Oakenshield",
      race: "Nain",
      class: "Guerrier",
      level: 7,
      hp: 60,
      hp_max: 65,
      stats: { str: 18, dex: 10, con: 16, int: 8, wis: 12, cha: 10 },
      inventory: ["Hache de guerre +1", "Bouclier magique", "Armure de plates"],
    });
    savedCharSyncFromSession(testSavedId, charId);
    const synced = savedCharGet(testSavedId);
    assert(synced!.level === 7, `Synced level should be 7, got: ${synced!.level}`);
    assert(synced!.hp === 60, `Synced HP should be 60, got: ${synced!.hp}`);
    assert(synced!.inventory.includes("Hache de guerre +1"), "Should have new weapon");
  });

  await runTest("savedCharDelete — remove character", async () => {
    savedCharDelete(testSavedId);
    const char = savedCharGet(testSavedId);
    assert(char === null, "Should be deleted");
  });

  // ═══════════════════════════════════════════════
  // DUNGEON SKILLS — ROSTER INTEGRATION
  // ═══════════════════════════════════════════════
  console.log("\n── Dungeon Roster Skills ──");

  await runTest("dungeon.my_characters — empty roster", async () => {
    // Clean up all test characters first
    const allTest = savedCharList("SmokeTestOwner");
    for (const c of allTest) savedCharDelete(c.id);
    const skill = getSkill("dungeon.my_characters");
    assert(!!skill, "dungeon.my_characters skill not found");
    const result = await skill!.execute({ owner: "SmokeTestOwner" });
    assertContains(result, "Aucun personnage", "Should say no characters");
  });

  await runTest("dungeon.save_character — save from session", async () => {
    const skill = getSkill("dungeon.save_character");
    assert(!!skill, "dungeon.save_character skill not found");
    // Create a session with a character first
    const startSkill = getSkill("dungeon.start")!;
    const startResult = await startSkill.execute({
      name: "Roster Test",
      characters: "Ragnar/Humain/Guerrier",
    });
    // Extract session ID from result
    const sessMatch = startResult.match(/Session ID:\s*(\d+)/);
    assert(!!sessMatch, `Should contain Session ID, got: ${startResult.slice(0, 200)}`);
    const sessId = Number(sessMatch![1]);
    const result = await skill!.execute({
      session_id: sessId,
      character_name: "Ragnar",
      owner: "SmokeTestOwner",
    });
    assertContains(result, "Ragnar", "Should confirm character name");
    assertContains(result, "sauvegarde", "Should confirm save");
  });

  await runTest("dungeon.my_characters — show saved", async () => {
    const skill = getSkill("dungeon.my_characters")!;
    const result = await skill.execute({ owner: "SmokeTestOwner" });
    assertContains(result, "Ragnar", "Should show saved character");
    assertContains(result, "Roster", "Should have roster title");
  });

  // ═══════════════════════════════════════════════
  // CORE SKILL SMOKE TESTS
  // ═══════════════════════════════════════════════
  console.log("\n── Core Skills ──");

  await runTest("notes.add + notes.list", async () => {
    const addSkill = getSkill("notes.add");
    assert(!!addSkill, "notes.add skill not found");
    const addResult = await addSkill!.execute({ text: "smoke test note @test-tag" });
    assert(addResult.length > 0, "Should return confirmation");
    const listSkill = getSkill("notes.list")!;
    const listResult = await listSkill.execute({ limit: 5 });
    assertContains(listResult, "smoke test note", "Should find the note");
  });

  await runTest("time.now — returns current time", async () => {
    const skill = getSkill("time.now");
    assert(!!skill, "time.now skill not found");
    const result = await skill!.execute({});
    assert(result.length > 5, "Should return time string");
    // Should contain year
    assert(/202\d/.test(result), `Should contain year, got: ${result}`);
  });

  await runTest("help — returns skill list", async () => {
    const skill = getSkill("help");
    assert(!!skill, "help skill not found");
    const result = await skill!.execute({});
    assertContains(result, "notes", "Should list notes skills");
    assertContains(result, "dungeon", "Should list dungeon skills");
  });

  await runTest("system.info — returns system info", async () => {
    const skill = getSkill("system.info");
    assert(!!skill, "system.info skill not found");
    const result = await skill!.execute({});
    assert(result.length > 50, "Should return system info");
  });

  await runTest("errors.recent — returns error list", async () => {
    const skill = getSkill("errors.recent");
    assert(!!skill, "errors.recent skill not found");
    const result = await skill!.execute({});
    assert(result.length > 0, "Should return something");
  });

  // ═══════════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════════
  console.log("\n═══════════════════════════════════════");
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const totalTime = results.reduce((s, r) => s + r.durationMs, 0);
  console.log(`\n📊 Results: ${passed} passed, ${failed} failed (${totalTime}ms total)`);

  if (failed > 0) {
    console.log("\n❌ Failed tests:");
    for (const r of results.filter((r) => !r.passed)) {
      console.log(`  • ${r.name}: ${r.detail}`);
    }
  }

  console.log("");
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(2);
});
