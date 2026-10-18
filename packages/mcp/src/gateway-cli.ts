// `awl-desk gateway`: runs an order's MCP gateway on stdio in front of the worker's real MCP servers.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FileStore, WorkDesk } from "agent-work-layer";
import type { PassKeys } from "agent-work-layer";
import { createGateway } from "./gateway.ts";
import { VERSION } from "./version.ts";

export const GATEWAY_HELP = `awl-desk gateway ${VERSION} — enforce a Work Order's tools and budget at every MCP tool call

Usage:
  awl-desk gateway --order <id> --config <file> [--store <dir>] [--actor <agent-ref>] [--observe]
  awl-desk gateway --order <id> --config <file> --actor <agent-ref> --pass-keys <file> [--pass-file <file>] [--issuer <iss>]

The config file lists the real MCP servers, in the same shape as .mcp.json:
  { "mcpServers": {
      "filings": { "command": "npx", "args": ["-y", "filings-mcp"], "env": {} },
      "calc":    { "url": "https://calc.example.com/mcp", "headers": {} } } }

Tools appear as <server>__<tool>, and only those the order allows. Calls are logged to
<store>/calls/<id>.jsonl; each result carries an evidence ref "<server>/<tool>#<n>".
The awl_usage tool returns tools_used and cost for the work report.

--observe   Log only; refuse nothing. Calls the order would refuse are logged as violations.
            Use it when your own gateway or policy engine already enforces access.

--pass-keys Enforce a Delegation Pass instead of reading the order from the store. The file is
            the desk's public key: a JWK, a JWK Set or an array of JWKs. Each call needs a valid
            pass for this order and --actor; its tools and tool_calls budget are enforced.
--pass-file File holding the current pass, read on every call so the worker can renew it.
            Default: AWL_PASS. A call's _meta["awl/pass"] wins over both.
--issuer    Required iss of passes.

Environment: AWL_STORE (default ./.awl), AWL_ACTOR (default: the order's worker), AWL_PASS.`;

type ServerConfig =
  | { command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
  | { url: string; headers?: Record<string, string> };

function transportFor(name: string, config: ServerConfig) {
  if ("command" in config && config.command) {
    return new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: { ...getDefaultEnvironment(), ...config.env },
      cwd: config.cwd,
      stderr: "inherit",
    });
  }
  if ("url" in config && config.url) {
    return new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } });
  }
  throw new Error(`server "${name}" needs a "command" or a "url"`);
}

export async function runGateway(args: string[]): Promise<void> {
  let values: {
    order?: string; config?: string; store?: string; actor?: string; observe?: boolean; help?: boolean;
    "pass-keys"?: string; "pass-file"?: string; issuer?: string;
  };
  try {
    ({ values } = parseArgs({
      args,
      options: {
        order: { type: "string" }, config: { type: "string" }, store: { type: "string" }, actor: { type: "string" }, observe: { type: "boolean" },
        "pass-keys": { type: "string" }, "pass-file": { type: "string" }, issuer: { type: "string" }, help: { type: "boolean", short: "h" },
      },
    }));
    if (!values.help && (!values.order || !values.config)) throw new Error("--order and --config are required");
    if (!values.help && values["pass-keys"] && !(values.actor ?? process.env.AWL_ACTOR)) throw new Error("--pass-keys needs --actor (or AWL_ACTOR)");
  } catch (e) {
    console.error(`awl-desk gateway: ${(e as Error).message}\n\n${GATEWAY_HELP}`);
    process.exit(2);
  }
  if (values.help) {
    console.log(GATEWAY_HELP);
    return;
  }

  const storeDir = values.store ?? process.env.AWL_STORE ?? ".awl";
  const { mcpServers = {} } = JSON.parse(await readFile(values.config!, "utf8")) as { mcpServers?: Record<string, ServerConfig> };
  const upstreams: Record<string, Client> = {};
  for (const [name, config] of Object.entries(mcpServers)) {
    const client = new Client({ name: "awl-gateway", version: VERSION });
    await client.connect(transportFor(name, config));
    upstreams[name] = client;
  }

  const passKeys = values["pass-keys"] ? (JSON.parse(await readFile(values["pass-keys"], "utf8")) as PassKeys) : undefined;
  const passFile = values["pass-file"];
  // A missing or unreadable file means no pass, so the call is refused as PASS_INVALID.
  const pass = passFile ? async () => (await readFile(passFile, "utf8").catch(() => "")).trim() || undefined : process.env.AWL_PASS;

  const { server } = await createGateway({
    ...(passKeys ? { passKeys, pass, issuer: values.issuer } : { desk: new WorkDesk({ store: new FileStore(storeDir) }) }),
    orderId: values.order!,
    upstreams,
    actor: values.actor ?? process.env.AWL_ACTOR,
    logFile: join(storeDir, "calls", `${values.order}.jsonl`),
    enforce: !values.observe,
  });
  server.onclose = () => void Promise.all(Object.values(upstreams).map((c) => c.close()));
  await server.connect(new StdioServerTransport());
}
