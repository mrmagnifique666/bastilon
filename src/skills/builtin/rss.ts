/**
 * Built-in skill: rss.fetch
 * RSS/Atom feed reader — parses XML, returns latest entries.
 * Useful for news monitoring and morning briefings.
 */
import { registerSkill } from "../loader.js";
import { checkSSRF } from "../../security/ssrf.js";

interface FeedItem {
  title: string;
  link: string;
  date: string;
  summary: string;
}

function extractTag(xml: string, tag: string): string {
  // Handle both <tag>content</tag> and <tag><![CDATA[content]]></tag>
  const regex = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`, "i");
  const match = xml.match(regex);
  return match ? match[1].trim() : "";
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function parseRss(xml: string): FeedItem[] {
  const items: FeedItem[] = [];
  // Try RSS 2.0 (<item>)
  const rssItems = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
  for (const raw of rssItems) {
    items.push({
      title: stripHtml(extractTag(raw, "title")),
      link: extractTag(raw, "link") || extractTag(raw, "guid"),
      date: extractTag(raw, "pubDate") || extractTag(raw, "dc:date"),
      summary: stripHtml(extractTag(raw, "description")).slice(0, 200),
    });
  }
  // Try Atom (<entry>)
  if (items.length === 0) {
    const atomEntries = xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
    for (const raw of atomEntries) {
      const linkMatch = raw.match(/<link[^>]*href=["']([^"']+)["']/i);
      items.push({
        title: stripHtml(extractTag(raw, "title")),
        link: linkMatch ? linkMatch[1] : "",
        date: extractTag(raw, "published") || extractTag(raw, "updated"),
        summary: stripHtml(extractTag(raw, "summary") || extractTag(raw, "content")).slice(0, 200),
      });
    }
  }
  return items;
}

registerSkill({
  name: "rss.fetch",
  description:
    "Fetch and parse an RSS/Atom feed. Returns the latest entries with title, date, and summary.",
  argsSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "RSS/Atom feed URL" },
      limit: { type: "number", description: "Max entries to return (default 10)" },
    },
    required: ["url"],
  },
  async execute(args): Promise<string> {
    const url = args.url as string;
    const limit = Math.min(Number(args.limit) || 10, 30);

    // SSRF protection
    const ssrfError = await checkSSRF(url);
    if (ssrfError) return ssrfError;

    const resp = await fetch(url, {
      headers: { "User-Agent": "Bastilon/2.0 (Kingston)", Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" },
    });
    if (!resp.ok) return `Error fetching feed: HTTP ${resp.status}`;

    const xml = await resp.text();
    const items = parseRss(xml).slice(0, limit);

    if (items.length === 0) return "No items found in feed. Check that the URL is a valid RSS/Atom feed.";

    // Extract feed title
    const feedTitle = stripHtml(extractTag(xml, "title"));
    const header = feedTitle ? `**${feedTitle}** (${items.length} items)\n` : "";

    return (
      header +
      items
        .map((item, i) => {
          const date = item.date ? ` — ${item.date}` : "";
          const summary = item.summary ? `\n   ${item.summary}` : "";
          const link = item.link ? `\n   ${item.link}` : "";
          return `${i + 1}. ${item.title}${date}${summary}${link}`;
        })
        .join("\n\n")
    );
  },
});
