/**
 * MCP Server — expose Kingston's skills as MCP tools, memories as resources, and prompt templates.
 * Allows Claude Desktop, VSCode, and other MCP clients to use Kingston's capabilities.
 *
 * Uses stdio transport (JSON-RPC over stdin/stdout) or SSE via dashboard.
 * Start with: npx tsx src/gateway/mcp.ts
 *
 * Protocol: https://modelcontextprotocol.io/specification
 */
import { getSkill, getRegistry } from "../skills/loader.js";
import { log } from "../utils/log.js";
import * as readline from "node:readline";
import http from "node:http";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ── MCP Protocol Implementation ──────────────────────────────────────

const SERVER_INFO = {
  name: "kingston-mcp",
  version: "2.0.0",
};

const CAPABILITIES = {
  tools: {},
  resources: {},
  prompts: {},
};

/** Convert Kingston skill schema to MCP tool definition */
function skillToMcpTool(name: string, skill: { description: string; argsSchema: unknown }) {
  return {
    name,
    description: skill.description,
    inputSchema: skill.argsSchema || { type: "object", properties: {} },
  };
}

/** List all available tools (skills) */
function handleToolsList(): { tools: unknown[] } {
  const registry = getRegistry();
  const tools: unknown[] = [];

  for (const [name, skill] of registry) {
    // Skip admin-only skills in MCP (safety) unless authenticated
    if (skill.adminOnly) continue;
    tools.push(skillToMcpTool(name, skill));
  }

  return { tools };
}

/** List tools including admin skills (for authenticated sessions) */
function handleToolsListAuth(): { tools: unknown[] } {
  const registry = getRegistry();
  const tools: unknown[] = [];
  for (const [name, skill] of registry) {
    tools.push(skillToMcpTool(name, skill));
  }
  return { tools };
}

/** Execute a tool (skill) */
async function handleToolCall(params: {
  name: string;
  arguments?: Record<string, unknown>;
}): Promise<{ content: Array<{ type: string; text: string }> }> {
  const skill = getSkill(params.name);
  if (!skill) {
    throw { code: -32602, message: `Unknown tool: ${params.name}` };
  }

  try {
    const result = await skill.execute(params.arguments || {});
    return {
      content: [{ type: "text", text: result }],
    };
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }
}

// ── Resources ────────────────────────────────────────────────────────

function handleResourcesList(): { resources: unknown[] } {
  return {
    resources: [
      {
        uri: "kingston://memory/stats",
        name: "Memory Statistics",
        description: "Semantic memory statistics — totals, categories, salience",
        mimeType: "text/plain",
      },
      {
        uri: "kingston://agents/status",
        name: "Agent Status",
        description: "Status of all autonomous agents",
        mimeType: "text/plain",
      },
      {
        uri: "kingston://hooks/list",
        name: "Lifecycle Hooks",
        description: "Registered lifecycle hooks and their handlers",
        mimeType: "text/plain",
      },
      {
        uri: "kingston://skills/catalog",
        name: "Skills Catalog",
        description: "Full list of registered skills with descriptions",
        mimeType: "text/plain",
      },
    ],
  };
}

async function handleResourceRead(params: { uri: string }): Promise<{
  contents: Array<{ uri: string; mimeType: string; text: string }>;
}> {
  const uri = params.uri;

  if (uri === "kingston://memory/stats") {
    const skill = getSkill("memory.stats");
    const text = skill ? await skill.execute({}) : "memory.stats skill not loaded";
    return { contents: [{ uri, mimeType: "text/plain", text }] };
  }

  if (uri === "kingston://agents/status") {
    const skill = getSkill("agents.list");
    const text = skill ? await skill.execute({}) : "agents.list skill not loaded";
    return { contents: [{ uri, mimeType: "text/plain", text }] };
  }

  if (uri === "kingston://hooks/list") {
    const skill = getSkill("hooks.list");
    const text = skill ? await skill.execute({}) : "hooks.list skill not loaded";
    return { contents: [{ uri, mimeType: "text/plain", text }] };
  }

  if (uri === "kingston://skills/catalog") {
    const registry = getRegistry();
    const lines: string[] = [];
    for (const [name, skill] of registry) {
      lines.push(`${name}${skill.adminOnly ? " (admin)" : ""}: ${skill.description}`);
    }
    return { contents: [{ uri, mimeType: "text/plain", text: lines.join("\n") }] };
  }

  throw { code: -32602, message: `Unknown resource: ${uri}` };
}

// ── Prompts ──────────────────────────────────────────────────────────

function handlePromptsList(): { prompts: unknown[] } {
  return {
    prompts: [
      {
        name: "kingston-memory-search",
        description: "Search Kingston's semantic memory for relevant information",
        arguments: [
          { name: "query", description: "Search query", required: true },
        ],
      },
      {
        name: "kingston-agent-brief",
        description: "Get a briefing from a Kingston agent's perspective",
        arguments: [
          { name: "agent", description: "Agent ID (scout, analyst, mind, etc.)", required: true },
        ],
      },
      {
        name: "kingston-business-context",
        description: "Get Kingston's full business context for Bastilon",
        arguments: [],
      },
    ],
  };
}

async function handlePromptGet(params: {
  name: string;
  arguments?: Record<string, string>;
}): Promise<{ messages: Array<{ role: string; content: { type: string; text: string } }> }> {
  const args = params.arguments || {};

  if (params.name === "kingston-memory-search") {
    const query = args.query || "recent events";
    const skill = getSkill("memory.deep");
    const result = skill ? await skill.execute({ query, limit: 10 }) : "memory.deep not available";
    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Search Kingston's memory for: ${query}\n\nResults:\n${result}`,
          },
        },
      ],
    };
  }

  if (params.name === "kingston-agent-brief") {
    const agentId = args.agent || "mind";
    const skill = getSkill("agents.status");
    const result = skill ? await skill.execute({ id: agentId }) : "agents.status not available";
    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Agent briefing for ${agentId}:\n${result}`,
          },
        },
      ],
    };
  }

  if (params.name === "kingston-business-context") {
    const memSkill = getSkill("memory.deep");
    const context = memSkill
      ? await memSkill.execute({ query: "business strategy priorities", limit: 5 })
      : "No memory available";
    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Kingston Business Context:\n${context}`,
          },
        },
      ],
    };
  }

  throw { code: -32602, message: `Unknown prompt: ${params.name}` };
}

// ── JSON-RPC Router ──────────────────────────────────────────────────

async function handleRequest(req: JsonRpcRequest, authenticated = false): Promise<JsonRpcResponse> {
  try {
    switch (req.method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id: req.id,
          result: {
            protocolVersion: "2024-11-05",
            serverInfo: SERVER_INFO,
            capabilities: CAPABILITIES,
          },
        };

      case "notifications/initialized":
        // Client acknowledged — no response needed for notifications
        return { jsonrpc: "2.0", id: req.id, result: {} };

      case "tools/list":
        return {
          jsonrpc: "2.0",
          id: req.id,
          result: authenticated ? handleToolsListAuth() : handleToolsList(),
        };

      case "tools/call": {
        const callResult = await handleToolCall(
          req.params as { name: string; arguments?: Record<string, unknown> },
        );
        return {
          jsonrpc: "2.0",
          id: req.id,
          result: callResult,
        };
      }

      case "resources/list":
        return {
          jsonrpc: "2.0",
          id: req.id,
          result: handleResourcesList(),
        };

      case "resources/read": {
        const readResult = await handleResourceRead(
          req.params as { uri: string },
        );
        return {
          jsonrpc: "2.0",
          id: req.id,
          result: readResult,
        };
      }

      case "prompts/list":
        return {
          jsonrpc: "2.0",
          id: req.id,
          result: handlePromptsList(),
        };

      case "prompts/get": {
        const promptResult = await handlePromptGet(
          req.params as { name: string; arguments?: Record<string, string> },
        );
        return {
          jsonrpc: "2.0",
          id: req.id,
          result: promptResult,
        };
      }

      default:
        return {
          jsonrpc: "2.0",
          id: req.id,
          error: { code: -32601, message: `Method not found: ${req.method}` },
        };
    }
  } catch (err) {
    const error = err as { code?: number; message?: string };
    return {
      jsonrpc: "2.0",
      id: req.id,
      error: {
        code: error.code || -32603,
        message: error.message || "Internal error",
      },
    };
  }
}

// ── Stdio Transport ──────────────────────────────────────────────────

function sendResponse(response: JsonRpcResponse): void {
  const json = JSON.stringify(response);
  process.stdout.write(json + "\n");
}

/** Start the MCP server on stdio */
export async function startMcpServer(): Promise<void> {
  // Load skills first
  const { loadBuiltinSkills } = await import("../skills/loader.js");
  await loadBuiltinSkills();

  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false,
  });

  rl.on("line", async (line) => {
    try {
      const req = JSON.parse(line) as JsonRpcRequest;
      const response = await handleRequest(req, true); // stdio = trusted
      // Don't respond to notifications (no id)
      if (req.id !== undefined) {
        sendResponse(response);
      }
    } catch (err) {
      sendResponse({
        jsonrpc: "2.0",
        id: 0,
        error: {
          code: -32700,
          message: `Parse error: ${err instanceof Error ? err.message : String(err)}`,
        },
      });
    }
  });

  rl.on("close", () => {
    process.exit(0);
  });

  // Signal ready
  log.info("[mcp] Kingston MCP server ready on stdio");
}

// ── SSE Transport (for Claude Desktop / HTTP clients) ─────────────────

/**
 * Handle MCP SSE/message routes. Call from dashboard server's request handler.
 * Returns true if the request was handled, false otherwise.
 */
const mcpSseClients = new Map<string, { res: http.ServerResponse; authenticated: boolean }>();

/** Get connected MCP client count */
export function getMcpClientCount(): number {
  return mcpSseClients.size;
}

/** Get connected MCP client IDs */
export function getMcpClientIds(): string[] {
  return [...mcpSseClients.keys()];
}

export function handleMcpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): boolean {
  const url = req.url || "";

  // SSE endpoint — client connects and receives responses
  if (url.startsWith("/mcp/sse") && req.method === "GET") {
    const clientId = `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    // Check auth token from query param
    const urlObj = new URL(url, "http://localhost");
    const token = urlObj.searchParams.get("token") || "";
    const dashToken = process.env.DASHBOARD_TOKEN || "";
    const authenticated = dashToken.length > 0 && token === dashToken;

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    // Send endpoint info as first event
    const messageUrl = `/mcp/message?sessionId=${clientId}`;
    res.write(`event: endpoint\ndata: ${messageUrl}\n\n`);
    mcpSseClients.set(clientId, { res, authenticated });

    req.on("close", () => {
      mcpSseClients.delete(clientId);
      log.debug(`[mcp] SSE client ${clientId} disconnected`);
    });

    log.info(`[mcp] SSE client connected: ${clientId} (auth=${authenticated})`);
    return true;
  }

  // Message endpoint — client sends JSON-RPC requests
  if (url.startsWith("/mcp/message") && req.method === "POST") {
    const urlObj = new URL(url, "http://localhost");
    const sessionId = urlObj.searchParams.get("sessionId") || "";
    const client = mcpSseClients.get(sessionId);

    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", async () => {
      try {
        const jsonReq = JSON.parse(body) as JsonRpcRequest;
        const response = await handleRequest(jsonReq, client?.authenticated ?? false);

        // Send response via SSE if client connected, otherwise via HTTP
        if (client?.res && !client.res.writableEnded) {
          client.res.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
          res.writeHead(202);
          res.end("Accepted");
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(response));
        }
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 0,
            error: {
              code: -32700,
              message: `Parse error: ${err instanceof Error ? err.message : String(err)}`,
            },
          }),
        );
      }
    });
    return true;
  }

  return false;
}

// If run directly: npx tsx src/gateway/mcp.ts
const isMain = process.argv[1]?.includes("mcp");
if (isMain) {
  startMcpServer().catch((err) => {
    console.error("MCP server failed:", err);
    process.exit(1);
  });
}
