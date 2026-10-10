#!/usr/bin/env node
// Runs a desk as an MCP server on stdio. Each agent session starts its own process;
// sessions share one store folder, and each is locked to one identity.
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FileStore, WorkDesk } from "agent-work-layer";
import { createDeskServer } from "./index.ts";
import { VERSION } from "./version.ts";

const HELP = `awl-desk ${VERSION} — Agent Work Layer desk as an MCP server on stdio

Usage:
  awl-desk [--store <dir>] [--actor <agent-ref>]
  awl-desk --version | --help

Environment: AWL_STORE (default ./.awl), AWL_ACTOR. Flags win over the environment.
Example (Claude Code):
  claude mcp add awl -e AWL_STORE="$HOME/.awl" -e AWL_ACTOR=agent:manager -- npx -y agent-work-layer-mcp`;

let values: { store?: string; actor?: string; version?: boolean; help?: boolean };
try {
  ({ values } = parseArgs({
    options: { store: { type: "string" }, actor: { type: "string" }, version: { type: "boolean", short: "v" }, help: { type: "boolean", short: "h" } },
  }));
} catch (e) {
  console.error(`awl-desk: ${(e as Error).message}\n\n${HELP}`);
  process.exit(2);
}

if (values.help) {
  console.log(HELP);
} else if (values.version) {
  console.log(VERSION);
} else {
  const store = new FileStore(values.store ?? process.env.AWL_STORE ?? ".awl");
  const server = createDeskServer({ desk: new WorkDesk({ store }), actor: values.actor ?? process.env.AWL_ACTOR });
  await server.connect(new StdioServerTransport());
}
