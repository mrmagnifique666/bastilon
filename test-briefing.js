#!/usr/bin/env node
/**
 * Test briefing with meme generation
 */
import { sendMorningBriefing } from "./src/scheduler/briefings.ts";
import { loadBuiltinSkills } from "./src/skills/loader.ts";

console.log("🧪 Testing morning briefing with meme generation...\n");

try {
  console.log("📦 Loading skills...");
  await loadBuiltinSkills();
  console.log("✅ Skills loaded\n");

  const result = await sendMorningBriefing();
  console.log("\n✅ Briefing result:", result ? "SUCCESS" : "FAILED");
  process.exit(result ? 0 : 1);
} catch (err) {
  console.error("\n❌ Error:", err);
  process.exit(1);
}
