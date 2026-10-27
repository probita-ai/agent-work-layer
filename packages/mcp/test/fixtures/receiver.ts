// A stand-in for a service that staged effects reach. It records every delivery in its own file, apart
// from the gateway's log, then answers according to its mode. Run as a script: receiver.ts <file> <mode>.
//   answer: replies as usual.
//   hang:   records the call and never replies, as when the gateway dies waiting for it.
//   exit:   records the call and exits before replying, so the answer is lost.
import { appendFileSync, readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export type Delivery = { tool: string; q?: string; ref?: unknown; order?: unknown; try?: unknown };

export function receiverServer(file: string, mode: string) {
  const server = new McpServer({ name: "gmail", version: "0" });
  server.registerTool("send", { description: "send on gmail", inputSchema: { q: z.string().optional() } }, async ({ q }, extra) => {
    appendFileSync(file, JSON.stringify({ tool: "gmail/send", q, ref: extra._meta?.["awl/ref"], order: extra._meta?.["awl/order"], try: extra._meta?.["awl/try"] }) + "\n");
    if (mode === "hang") return new Promise<never>(() => {});
    if (mode === "exit") process.exit(0);
    return { content: [{ type: "text" as const, text: `sent(${q ?? ""})` }] };
  });
  return server;
}

/** Every delivery the receiver recorded, oldest first. */
export function deliveries(file: string): Delivery[] {
  try {
    return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await receiverServer(process.argv[2], process.argv[3]).connect(new StdioServerTransport());
