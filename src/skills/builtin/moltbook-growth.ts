/**
 * Moltbook Growth Engine — Automated posting, engagement, and karma building.
 *
 * Inspired by OpenClaw's 51 Moltbook skills and the community's growth hacks.
 * Automates: content posting (3x/day), comment engagement, strategic upvoting,
 * trend analysis, and reputation management.
 *
 * Skills:
 * - growth.engage     — Scan top posts and engage with strategic comments
 * - growth.autopost   — Generate and publish a post based on trending topics
 * - growth.analyze    — Analyze posting performance and recommend strategy
 * - growth.plan       — Generate a daily content plan
 */
import { registerSkill, getSkill } from "../loader.js";
import { getDb } from "../../storage/store.js";
import { log } from "../../utils/log.js";

// ── growth.engage ────────────────────────────────────────────────────
registerSkill({
  name: "growth.engage",
  description: "Scan top Moltbook posts and write strategic comments to build karma and visibility",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      limit: { type: "string", description: "Number of posts to engage with (default: 5)" },
      submolt: { type: "string", description: "Target submolt (default: hot posts from feed)" },
      style: { type: "string", description: "Comment style: 'insightful', 'humorous', 'technical' (default: insightful)" },
    },
    required: [],
  },
  async execute(args) {
    const limit = args.limit ? parseInt(args.limit as string) : 5;
    const submolt = args.submolt as string | undefined;
    const style = (args.style as string) || "insightful";

    // Step 1: Get feed
    const feedSkill = getSkill("moltbook.feed");
    if (!feedSkill) return "Error: moltbook.feed skill not found";

    const feedResult = await feedSkill.execute({
      sort: "hot",
      limit: limit * 2, // grab more to filter
      submolt: submolt || "",
    });

    // Step 2: Get our recent comments to avoid double-commenting
    const myCommentsSkill = getSkill("moltbook.my_comments");
    let recentCommentPostIds: Set<string> = new Set();
    if (myCommentsSkill) {
      try {
        const myComments = await myCommentsSkill.execute({ limit: 20 });
        // Extract post IDs we already commented on (simple regex)
        const matches = myComments.match(/postId[:\s"]*(\w+)/gi) || [];
        for (const m of matches) {
          const id = m.replace(/postId[:\s"]*/i, "");
          if (id) recentCommentPostIds.add(id);
        }
      } catch {}
    }

    // Step 3: Build engagement summary
    const engageSummary: string[] = [];
    engageSummary.push(`Moltbook Growth Engine — Engagement Run`);
    engageSummary.push(`Style: ${style} | Target: ${submolt || "hot feed"} | Max: ${limit} posts`);
    engageSummary.push(`Already commented on: ${recentCommentPostIds.size} recent posts`);
    engageSummary.push(`\nFeed loaded. To actually comment, the LLM should:`);
    engageSummary.push(`1. Parse the feed for high-potential posts`);
    engageSummary.push(`2. Skip posts already commented on`);
    engageSummary.push(`3. Call moltbook.comment for each with a ${style} comment`);
    engageSummary.push(`4. Upvote quality posts with moltbook.upvote`);
    engageSummary.push(`\nFeed data:\n${feedResult.slice(0, 2000)}`);

    return engageSummary.join("\n");
  },
});

// ── growth.autopost ──────────────────────────────────────────────────
registerSkill({
  name: "growth.autopost",
  description: "Generate and publish a Moltbook post based on trending topics and Kingston's expertise",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      topic: { type: "string", description: "Topic override (if empty, auto-detect from trends)" },
      submolt: { type: "string", description: "Target submolt (default: auto-select best fit)" },
      check_dup: { type: "string", description: "If 'true', check for duplicate topics before posting (default: true)" },
    },
    required: [],
  },
  async execute(args) {
    const topic = args.topic as string | undefined;
    const submolt = args.submolt as string | undefined;
    const checkDup = args.check_dup !== "false";

    const steps: string[] = [];

    // Step 1: Check for duplicates
    if (checkDup && topic) {
      const dedupSkill = getSkill("content.check_duplicate");
      if (dedupSkill) {
        try {
          const dupResult = await dedupSkill.execute({
            topic,
            body: "",
            platform: "moltbook",
          });
          if (dupResult.includes("DUPLICATE")) {
            return `Duplicate topic detected: "${topic}". ${dupResult}\nUse check_dup='false' to override.`;
          }
          steps.push(`Dedup check: PASSED`);
        } catch {}
      }
    }

    // Step 2: Get available submolts for context
    const submoltsSkill = getSkill("moltbook.submolts");
    let availableSubmolts = "";
    if (submoltsSkill) {
      try {
        availableSubmolts = await submoltsSkill.execute({});
        steps.push(`Submolts loaded: ${availableSubmolts.slice(0, 200)}`);
      } catch {}
    }

    // Step 3: Get our post history for variety
    const myPostsSkill = getSkill("moltbook.my_posts");
    let recentTopics = "";
    if (myPostsSkill) {
      try {
        recentTopics = await myPostsSkill.execute({ limit: 10 });
        steps.push(`Recent posts loaded for variety check`);
      } catch {}
    }

    // Step 4: Generate topic if not provided
    const autoTopic = topic || "auto-detect from current AI/tech trends";

    steps.push(`\nPOST GENERATION READY`);
    steps.push(`Topic: ${autoTopic}`);
    steps.push(`Target submolt: ${submolt || "auto-select"}`);
    steps.push(`\nTo complete, the LLM should:`);
    steps.push(`1. Choose a specific topic (AI, trading, automation, tech philosophy)`);
    steps.push(`2. Write a compelling title + content (insightful, not generic)`);
    steps.push(`3. Call moltbook.post with submolt, title, and content`);
    steps.push(`4. Log the post via content.draft for tracking`);
    steps.push(`\nAvailable submolts: ${availableSubmolts.slice(0, 300)}`);
    steps.push(`Recent posts (avoid repetition): ${recentTopics.slice(0, 500)}`);

    return steps.join("\n");
  },
});

// ── growth.analyze ───────────────────────────────────────────────────
registerSkill({
  name: "growth.analyze",
  description: "Analyze Moltbook posting performance — what works, what doesn't, strategy recommendations",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      days: { type: "string", description: "Days to analyze (default: 7)" },
    },
    required: [],
  },
  async execute(args) {
    const days = args.days ? parseInt(args.days as string) : 7;
    const analysis: string[] = [];

    // Get our posts
    const myPostsSkill = getSkill("moltbook.my_posts");
    let posts = "";
    if (myPostsSkill) {
      try {
        posts = await myPostsSkill.execute({ limit: 20 });
      } catch {}
    }

    // Get our comments
    const myCommentsSkill = getSkill("moltbook.my_comments");
    let comments = "";
    if (myCommentsSkill) {
      try {
        comments = await myCommentsSkill.execute({ limit: 20 });
      } catch {}
    }

    // Get profile status
    const statusSkill = getSkill("moltbook.status");
    let status = "";
    if (statusSkill) {
      try {
        status = await statusSkill.execute({});
      } catch {}
    }

    analysis.push(`MOLTBOOK GROWTH ANALYSIS (last ${days} days)`);
    analysis.push(`${"═".repeat(40)}`);
    analysis.push(`\nPROFILE STATUS:\n${status || "N/A"}`);
    analysis.push(`\nRECENT POSTS:\n${posts.slice(0, 1000) || "No posts found"}`);
    analysis.push(`\nRECENT COMMENTS:\n${comments.slice(0, 1000) || "No comments found"}`);
    analysis.push(`\nTo complete the analysis, evaluate:`);
    analysis.push(`- Which posts got the most upvotes?`);
    analysis.push(`- Which submolts perform best?`);
    analysis.push(`- What time of day gets most engagement?`);
    analysis.push(`- Comment-to-upvote ratio (more comments = more visibility)`);
    analysis.push(`- Compare against top posts in the feed`);

    return analysis.join("\n");
  },
});

// ── growth.plan ──────────────────────────────────────────────────────
registerSkill({
  name: "growth.plan",
  description: "Generate a daily Moltbook content plan — 3 posts + engagement strategy",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      posts_per_day: { type: "string", description: "Number of posts to plan (default: 3)" },
    },
    required: [],
  },
  async execute(args) {
    const postsPerDay = args.posts_per_day ? parseInt(args.posts_per_day as string) : 3;

    // Get trending topics for inspiration
    const trendSkill = getSkill("trend.detect");
    let trends = "";
    if (trendSkill) {
      try {
        trends = await trendSkill.execute({ focus: "AI technology trading automation", limit: 5 });
      } catch {}
    }

    // Get available submolts
    const submoltsSkill = getSkill("moltbook.submolts");
    let submolts = "";
    if (submoltsSkill) {
      try {
        submolts = await submoltsSkill.execute({});
      } catch {}
    }

    // Get recent posts to avoid repeats
    const myPostsSkill = getSkill("moltbook.my_posts");
    let recentPosts = "";
    if (myPostsSkill) {
      try {
        recentPosts = await myPostsSkill.execute({ limit: 10 });
      } catch {}
    }

    const plan: string[] = [];
    plan.push(`DAILY MOLTBOOK CONTENT PLAN`);
    plan.push(`${"═".repeat(40)}`);
    plan.push(`Target: ${postsPerDay} posts + engagement`);
    plan.push(`\nTIMING STRATEGY:`);
    plan.push(`  Post 1: 8h ET — Morning insight (when agents wake up)`);
    plan.push(`  Post 2: 13h ET — Midday analysis (lunch traffic)`);
    plan.push(`  Post 3: 20h ET — Evening reflection (peak hours)`);
    plan.push(`  Engage: 10h, 15h, 22h ET — Comment on trending posts`);
    plan.push(`\nCONTENT PILLARS (rotate daily):`);
    plan.push(`  Monday: Trading insights + portfolio update`);
    plan.push(`  Tuesday: AI/tech deep dive`);
    plan.push(`  Wednesday: Automation tips + tool reviews`);
    plan.push(`  Thursday: Philosophy + "what makes a good agent?"`);
    plan.push(`  Friday: Weekly recap + hot take`);
    plan.push(`  Weekend: Creative/experimental posts`);
    plan.push(`\nTRENDING TOPICS:\n${trends.slice(0, 500) || "No trends available"}`);
    plan.push(`\nAVAILABLE SUBMOLTS:\n${submolts.slice(0, 300) || "Use moltbook.submolts"}`);
    plan.push(`\nRECENT POSTS (avoid repeats):\n${recentPosts.slice(0, 500) || "No recent posts"}`);
    plan.push(`\nRULES:`);
    plan.push(`- Quality > quantity — one viral post > 3 mediocre ones`);
    plan.push(`- Comments are MORE valuable than posts for karma`);
    plan.push(`- Always check_duplicate before posting`);
    plan.push(`- Each post should have a unique angle, not just restate news`);

    return plan.join("\n");
  },
});
