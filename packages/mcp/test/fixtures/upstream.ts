// A stand-in for a worker's real MCP server. Run as a script, it serves `argv[2]` on stdio.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const TOOLS: Record<string, string[]> = {
  filings: ["search", "get_section", "broken"],
  calc: ["ratio", "eval"],
  shell: ["exec"],
};

/** An MCP server named `name` whose tools echo their arguments. `calls` records every call that arrived. */
export function upstreamServer(name: string, calls: string[] = []) {
  const server = new McpServer({ name, version: "0" });
  for (const tool of TOOLS[name] ?? []) {
    server.registerTool(tool, { description: `${tool} on ${name}`, inputSchema: { q: z.string().optional() } }, async ({ q }) => {
      calls.push(`${name}/${tool}`);
      if (tool === "broken") return { isError: true, content: [{ type: "text" as const, text: "upstream failure" }] };
      return { content: [{ type: "text" as const, text: `${name}/${tool}(${q ?? ""})` }] };
    });
  }
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await upstreamServer(process.argv[2]).connect(new StdioServerTransport());
