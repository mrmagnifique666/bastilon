/**
 * MCP server introspection skills — status, clients, capabilities.
 */
import { registerSkill } from "../loader.js";
import { getMcpClientCount, getMcpClientIds } from "../../gateway/mcp.js";
import { getRegistry } from "../loader.js";

registerSkill({
  name: "mcp.status",
  description: "Show MCP server status — connected clients, tool count, capabilities",
  argsSchema: {
    type: "object",
    properties: {},
  },
  async execute(): Promise<string> {
    const registry = getRegistry();
    const totalTools = registry.size;
    const adminTools = [...registry.values()].filter(s => s.adminOnly).length;
    const publicTools = totalTools - adminTools;
    const clientCount = getMcpClientCount();

    return [
      "**Kingston MCP Server**",
      `Status: Active`,
      `Connected SSE clients: ${clientCount}`,
      `Tools exposed: ${publicTools} public, ${adminTools} admin-only (${totalTools} total)`,
      `Capabilities: tools, resources (4), prompts (3)`,
      `Transports: stdio (npx tsx src/gateway/mcp.ts), SSE (/mcp/sse)`,
      `Protocol: MCP 2024-11-05`,
    ].join("\n");
  },
});

registerSkill({
  name: "mcp.clients",
  description: "List connected MCP SSE clients",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {},
  },
  async execute(): Promise<string> {
    const ids = getMcpClientIds();
    if (ids.length === 0) return "No MCP clients connected.";
    return `Connected MCP clients (${ids.length}):\n${ids.map(id => `  - ${id}`).join("\n")}`;
  },
});
