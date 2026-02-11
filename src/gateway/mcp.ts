/**
 * MCP Server — expose Kingston's skills as MCP tools.
 * Allows Claude Desktop, VSCode, and other MCP clients to use Kingston's capabilities.
 *
 * Uses stdio transport (JSON-RPC over stdin/stdout).
 * Start with: npx tsx src/gateway/mcp.ts
 *
 * Protocol: https://modelcontextprotocol.io/specification
 */
import { getSkill, getRegistry } from "../skills/loader.js";
import { log } from "../utils/log.js";
import * as readline from "node:readline";

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
    // Skip admin-only skills in MCP (safety)
    if (skill.adminOnly) continue;
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

// ── JSON-RPC Router ──────────────────────────────────────────────────

async function handleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse> {
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
          result: handleToolsList(),
        };

      case "tools/call":
        const callResult = await handleToolCall(
          req.params as { name: string; arguments?: Record<string, unknown> },
        );
        return {
          jsonrpc: "2.0",
          id: req.id,
          result: callResult,
        };

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
      const response = await handleRequest(req);
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

// If run directly: npx tsx src/gateway/mcp.ts
const isMain = process.argv[1]?.includes("mcp");
if (isMain) {
  startMcpServer().catch((err) => {
    console.error("MCP server failed:", err);
    process.exit(1);
  });
}
