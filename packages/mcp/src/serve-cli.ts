// `awl-desk serve`: one shared desk over Streamable HTTP. The actor comes from each request's API key.
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { parseArgs } from "node:util";
import { FileStore, WorkDesk } from "agent-work-layer";
import { apiKeyAuth, createDeskHttpHandler } from "./http.ts";
import { VERSION } from "./version.ts";

export const SERVE_HELP = `awl-desk serve ${VERSION} — one Agent Work Layer desk for every agent, over MCP Streamable HTTP

Usage:
  awl-desk serve --keys <file> [--port <n>] [--host <addr>] [--store <dir>]

Every request must send "Authorization: Bearer <key>". The key decides who the request acts
as; an "actor" argument naming anyone else is refused with FORBIDDEN. The keys file maps
each key to an agent ref:
  { "keys": { "<long random key>": "agent:manager", "<another key>": "agent:worker" } }

The endpoint is http://<host>:<port>/mcp. For OAuth 2.1 bearer tokens, or anything else,
embed createDeskHttpHandler with your own authenticate function (see the README).

--port   Default 8787. 0 picks a free port.
--host   Default 127.0.0.1. Put a TLS proxy in front before exposing the desk.

Environment: AWL_STORE (default ./.awl).`;

export async function runServe(args: string[]): Promise<void> {
  let values: { keys?: string; port?: string; host?: string; store?: string; help?: boolean };
  let port = 8787;
  try {
    ({ values } = parseArgs({
      args,
      options: { keys: { type: "string" }, port: { type: "string" }, host: { type: "string" }, store: { type: "string" }, help: { type: "boolean", short: "h" } },
    }));
    if (!values.help && !values.keys) throw new Error("--keys is required: the HTTP desk does not run without authentication");
    if (values.port !== undefined) {
      port = Number(values.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`bad --port "${values.port}"`);
    }
  } catch (e) {
    console.error(`awl-desk serve: ${(e as Error).message}\n\n${SERVE_HELP}`);
    process.exit(2);
  }
  if (values.help) {
    console.log(SERVE_HELP);
    return;
  }

  let authenticate;
  try {
    const { keys } = JSON.parse(await readFile(values.keys!, "utf8")) as { keys?: unknown };
    if (!keys || typeof keys !== "object" || Array.isArray(keys) || !Object.keys(keys).length) throw new Error('needs a non-empty "keys" object');
    if (!Object.values(keys).every((agent) => typeof agent === "string")) throw new Error('every value in "keys" must be an agent ref string');
    authenticate = apiKeyAuth(keys as Record<string, string>);
  } catch (e) {
    console.error(`awl-desk serve: ${values.keys}: ${(e as Error).message}`);
    process.exit(2);
  }

  const desk = new WorkDesk({ store: new FileStore(values.store ?? process.env.AWL_STORE ?? ".awl") });
  const handle = createDeskHttpHandler({ desk, authenticate });
  const http = createServer(handle);
  const host = values.host ?? "127.0.0.1";
  http.listen(port, host, () => {
    const address = http.address();
    const bound = typeof address === "object" && address ? address.port : port;
    console.error(`awl-desk serve: listening on http://${host.includes(":") ? `[${host}]` : host}:${bound}/mcp`);
  });
}
