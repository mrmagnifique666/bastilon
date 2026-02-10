/**
 * SSRF protection — shared DNS resolution + private IP blocking.
 * Used by api.request, rss.fetch, and any skill that fetches external URLs.
 */
import dns from "node:dns/promises";
import { log } from "../utils/log.js";

/** Returns true if the IP belongs to a private/internal network. */
export function isPrivateIP(ip: string): boolean {
  // IPv4
  if (/^127\./.test(ip)) return true;                       // loopback
  if (/^10\./.test(ip)) return true;                        // 10.0.0.0/8
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;  // 172.16.0.0/12
  if (/^192\.168\./.test(ip)) return true;                  // 192.168.0.0/16
  if (/^169\.254\./.test(ip)) return true;                  // link-local
  if (/^0\./.test(ip)) return true;                         // 0.0.0.0/8
  // IPv6
  if (ip === "::1" || ip === "::") return true;
  if (/^f[cd]/i.test(ip)) return true;                      // fc00::/7 (ULA)
  if (/^fe80/i.test(ip)) return true;                       // link-local
  return false;
}

/**
 * Resolve a URL's hostname and reject if it points to a private network.
 * Returns null if safe, or an error message string if blocked.
 */
export async function checkSSRF(url: string): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "Error: invalid URL.";
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    return "Error: only HTTP/HTTPS URLs are allowed.";
  }

  // Block .local / .internal hostnames
  const hostname = parsed.hostname.toLowerCase();
  if (hostname.endsWith(".local") || hostname.endsWith(".internal") || hostname === "localhost") {
    return "Error: requests to local/internal hosts are blocked (SSRF protection).";
  }

  // DNS resolution check
  try {
    const addresses = await dns.resolve4(hostname).catch(() => []);
    const addresses6 = await dns.resolve6(hostname).catch(() => []);
    const allAddrs = [...addresses, ...addresses6];
    if (allAddrs.length > 0 && allAddrs.every(isPrivateIP)) {
      log.warn(`[ssrf] Blocked request to ${hostname} — all IPs are private: ${allAddrs.join(", ")}`);
      return "Error: requests to private/internal networks are blocked (SSRF protection).";
    }
  } catch {
    // DNS resolution failed — let fetch handle it
  }

  return null; // safe
}
