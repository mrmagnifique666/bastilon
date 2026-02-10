/**
 * Built-in skill: api.request
 * Full HTTP client — supports GET/POST/PUT/PATCH/DELETE with headers and body.
 */
import { registerSkill } from "../loader.js";
import { checkSSRF } from "../../security/ssrf.js";

const ALLOWED_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const MAX_RESPONSE = 20000;
const TIMEOUT_MS = 15000;

registerSkill({
  name: "api.request",
  description:
    "Make an HTTP request (GET/POST/PUT/PATCH/DELETE) with optional headers and body.",
  argsSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "Request URL" },
      method: {
        type: "string",
        description: 'HTTP method (GET, POST, PUT, PATCH, DELETE). Default: "GET"',
      },
      headers: {
        type: "string",
        description: 'JSON object string of headers, e.g. \'{"Content-Type":"application/json"}\'',
      },
      body: {
        type: "string",
        description: "Request body (typically JSON string for POST/PUT/PATCH)",
      },
    },
    required: ["url"],
  },
  async execute(args): Promise<string> {
    const url = args.url as string;
    const method = ((args.method as string) || "GET").toUpperCase();
    const headersRaw = args.headers as string | undefined;
    const body = args.body as string | undefined;

    // Validate URL
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return "Error: invalid URL.";
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return "Error: only HTTP/HTTPS URLs are allowed.";
    }

    // Validate method
    if (!ALLOWED_METHODS.includes(method)) {
      return `Error: unsupported method "${method}". Allowed: ${ALLOWED_METHODS.join(", ")}`;
    }

    // Parse headers
    let headers: Record<string, string> = {
      "User-Agent": "Bastilon/2.0 (Kingston)",
    };
    if (headersRaw) {
      try {
        const parsed = JSON.parse(headersRaw);
        if (typeof parsed !== "object" || Array.isArray(parsed)) {
          return "Error: headers must be a JSON object string.";
        }
        headers = { ...headers, ...parsed };
      } catch {
        return "Error: failed to parse headers JSON.";
      }
    }

    // SSRF protection
    const ssrfError = await checkSSRF(url);
    if (ssrfError) return ssrfError;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const init: RequestInit = {
        method,
        headers,
        signal: controller.signal,
      };

      if (body && method !== "GET") {
        init.body = body;
      }

      const res = await fetch(url, init);
      clearTimeout(timeout);

      const contentType = res.headers.get("content-type") || "";
      const responseBody = await res.text();

      let text = responseBody;
      if (text.length > MAX_RESPONSE) {
        text = text.slice(0, MAX_RESPONSE) + "\n...(truncated)";
      }

      return [
        `${res.status} ${res.statusText}`,
        `Content-Type: ${contentType}`,
        "",
        text || "(empty body)",
      ].join("\n");
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});
