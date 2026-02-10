/**
 * Built-in skills: network.ping, network.dns, network.whois
 * Network utility tools.
 */
import { spawn } from "node:child_process";
import dns from "node:dns/promises";
import { registerSkill } from "../loader.js";

function runCommand(cmd: string, args: string[], timeout = 10000): Promise<string> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
    });
    let out = "";
    proc.stdout.on("data", (d: Buffer) => (out += d.toString()));
    proc.stderr.on("data", (d: Buffer) => (out += d.toString()));
    proc.on("error", (err) => resolve(`Error: ${err.message}`));
    proc.on("close", () => resolve(out.trim() || "(no output)"));
  });
}

registerSkill({
  name: "network.ping",
  description: "Ping a host to check connectivity and latency.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      host: { type: "string", description: "Hostname or IP to ping" },
      count: { type: "number", description: "Number of pings (default 4)" },
    },
    required: ["host"],
  },
  async execute(args): Promise<string> {
    const host = args.host as string;
    const count = Math.min(Number(args.count) || 4, 10);
    const isWindows = process.platform === "win32";
    const flag = isWindows ? "-n" : "-c";
    return runCommand("ping", [flag, String(count), host]);
  },
});

registerSkill({
  name: "network.dns",
  description: "DNS lookup for a domain. Returns A, AAAA, MX, TXT, NS records.",
  argsSchema: {
    type: "object",
    properties: {
      domain: { type: "string", description: "Domain to look up" },
      type: {
        type: "string",
        description: "Record type: A, AAAA, MX, TXT, NS, CNAME, ALL (default: ALL)",
      },
    },
    required: ["domain"],
  },
  async execute(args): Promise<string> {
    const domain = args.domain as string;
    const type = ((args.type as string) || "ALL").toUpperCase();
    const results: string[] = [`DNS lookup: ${domain}`];

    const queries: Array<{ label: string; fn: () => Promise<string[]> }> = [];

    if (type === "ALL" || type === "A") {
      queries.push({
        label: "A",
        fn: async () => {
          const addrs = await dns.resolve4(domain);
          return addrs.map((a) => `  ${a}`);
        },
      });
    }
    if (type === "ALL" || type === "AAAA") {
      queries.push({
        label: "AAAA",
        fn: async () => {
          const addrs = await dns.resolve6(domain);
          return addrs.map((a) => `  ${a}`);
        },
      });
    }
    if (type === "ALL" || type === "MX") {
      queries.push({
        label: "MX",
        fn: async () => {
          const recs = await dns.resolveMx(domain);
          return recs
            .sort((a, b) => a.priority - b.priority)
            .map((r) => `  ${r.priority} ${r.exchange}`);
        },
      });
    }
    if (type === "ALL" || type === "NS") {
      queries.push({
        label: "NS",
        fn: async () => {
          const recs = await dns.resolveNs(domain);
          return recs.map((r) => `  ${r}`);
        },
      });
    }
    if (type === "ALL" || type === "TXT") {
      queries.push({
        label: "TXT",
        fn: async () => {
          const recs = await dns.resolveTxt(domain);
          return recs.map((r) => `  ${r.join(" ")}`);
        },
      });
    }
    if (type === "CNAME" || type === "ALL") {
      queries.push({
        label: "CNAME",
        fn: async () => {
          const recs = await dns.resolveCname(domain);
          return recs.map((r) => `  ${r}`);
        },
      });
    }

    for (const q of queries) {
      try {
        const lines = await q.fn();
        if (lines.length > 0) {
          results.push(`${q.label}:`);
          results.push(...lines);
        }
      } catch {
        // Record type not found — skip silently
      }
    }

    return results.length > 1 ? results.join("\n") : `No DNS records found for ${domain}.`;
  },
});

registerSkill({
  name: "network.whois",
  description: "WHOIS lookup for a domain. Returns registration info.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      domain: { type: "string", description: "Domain to look up" },
    },
    required: ["domain"],
  },
  async execute(args): Promise<string> {
    const domain = args.domain as string;
    // Use web API since whois CLI isn't always available
    try {
      const resp = await fetch(
        `https://whois.freeaitools.org/api?domain=${encodeURIComponent(domain)}`
      );
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      if (data.raw) {
        // Truncate long output
        return data.raw.slice(0, 3000);
      }
      return JSON.stringify(data, null, 2).slice(0, 3000);
    } catch {
      // Fallback: try system whois command
      return runCommand("whois", [domain], 15000);
    }
  },
});
