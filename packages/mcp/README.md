# agent-work-layer-mcp

**The [Agent Work Layer](https://github.com/probita-ai/agent-work-layer) desk as an MCP server.** Agent sessions hand each other Work Orders and get checked Work Reports back.

[![npm](https://img.shields.io/npm/v/agent-work-layer-mcp.svg)](https://www.npmjs.com/package/agent-work-layer-mcp)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Two ways to run it:

- **stdio, for development.** Each agent session runs its own desk process. Sessions share one folder, and each is locked to the identity it is started with.
- **HTTP, for shared use.** Every agent connects to one desk, and each request's credential decides who it acts as, so a worker cannot approve its own work. See [Shared desk over HTTP](#shared-desk-over-http).

Only need to validate documents or run a desk in your own code? Use [`agent-work-layer`](https://www.npmjs.com/package/agent-work-layer) on its own. It installs 7 packages instead of about 100.

## Use with Claude Code

Add it once in the manager's project folder and once in the worker's:

```sh
claude mcp add awl -e AWL_STORE="$HOME/.awl" -e AWL_ACTOR=agent:manager -- npx -y agent-work-layer-mcp
claude mcp add awl -e AWL_STORE="$HOME/.awl" -e AWL_ACTOR=agent:worker  -- npx -y agent-work-layer-mcp
```

Any MCP client that starts stdio servers works the same way.

## Command

```sh
npx -y agent-work-layer-mcp --store ./.awl --actor agent:worker
```

| Flag | Environment | Default | Meaning |
|---|---|---|---|
| `--store <dir>` | `AWL_STORE` | `./.awl` | Folder shared by every session |
| `--actor <ref>` | `AWL_ACTOR` | none | Identity this session is locked to |

Flags win over the environment. Installed locally, the command is `awl-desk`.

## Tools

| Tool | Who | What it does |
|---|---|---|
| `create_work_order` | manager | Issue an order: goal, criteria, budget, deadline, tools, optional `handoff` |
| `list_work_orders` | anyone | Find orders, e.g. `to=<you>, state=offered` |
| `get_work_order` | anyone | Order, state, latest report, findings, events |
| `accept_work_order` / `decline_work_order` | worker | Answer an offer |
| `start_work_order` | worker | Begin work |
| `submit_work_report` | worker | Report `done`, `blocked` or `failed`, with evidence and an optional `handoff` |
| `answer_question` | manager or escalation contact | Unblock a worker |
| `review_work_report` | manager | Approve, or send back for rework |
| `cancel_work_order` | manager | Stop an unfinished order |
| `wait_for_update` | anyone | Wait for the next change to an order |

When a worker fails or gets stuck, it can fill in `handoff` (decisions, what it tried, open questions, next step). The manager passes that to the next worker in a new order, so the next worker doesn't start from nothing. See [SPEC.md §4.4](https://github.com/probita-ai/agent-work-layer/blob/main/SPEC.md#44-handoff).

## Shared desk over HTTP

```sh
npx -y agent-work-layer-mcp serve --keys keys.json --port 8787
```

`keys.json` maps API keys to agent refs. Generate long random keys (e.g. `openssl rand -hex 32`) and keep the file out of version control:

```json
{ "keys": { "4f9c…": "agent:manager", "a71e…": "agent:worker" } }
```

Each agent connects to `http://127.0.0.1:8787/mcp` with its own key:

```sh
claude mcp add --transport http awl http://127.0.0.1:8787/mcp --header "Authorization: Bearer $AWL_KEY"
```

- A request without a valid key gets 401 and runs nothing.
- The key decides the actor. An `actor` argument naming anyone else gets `FORBIDDEN`, so a worker can't approve its own report or cancel its manager's order.
- Every request is authenticated, not only the first; the desk keeps no sessions.
- The desk listens on `127.0.0.1`. Put a TLS proxy in front before exposing it.

| Flag | Environment | Default | Meaning |
|---|---|---|---|
| `--keys <file>` | | required | API key → agent ref map |
| `--port <n>` | | `8787` | `0` picks a free port |
| `--host <addr>` | | `127.0.0.1` | Address to listen on |
| `--store <dir>` | `AWL_STORE` | `./.awl` | The desk's folder |

### Bring your own authentication

In code, pass an `authenticate(request)` hook. It returns the agent ref, or throws an `AuthError` (401 by default, or `{ status: 403 }` for a valid credential that is not an agent). Any other error also refuses the request, without showing its message.

```ts
import { createServer } from "node:http";
import { createDeskHttpHandler, apiKeyAuth } from "agent-work-layer-mcp";

const handle = createDeskHttpHandler({ desk, authenticate: apiKeyAuth({ [process.env.MANAGER_KEY!]: "agent:manager" }) });
createServer(handle).listen(8787);
```

For OAuth 2.1 access tokens, as the [MCP authorization spec](https://modelcontextprotocol.io/specification/latest/basic/authorization) describes, use `bearerAuth`. You verify the token's signature and issuer (here with [jose](https://github.com/panva/jose)); the desk then checks that it has an `exp` in the future and an `aud` that includes the desk, and maps `sub` to an agent ref:

```ts
import { createRemoteJWKSet, jwtVerify } from "jose";
import { bearerAuth, createDeskHttpHandler, resourceMetadataUrl } from "agent-work-layer-mcp";

const resource = "https://desk.example.com/mcp";
const jwks = createRemoteJWKSet(new URL("https://auth.example.com/.well-known/jwks.json"));

const handle = createDeskHttpHandler({
  desk,
  authenticate: bearerAuth({
    verify: async (token) => (await jwtVerify(token, jwks, { issuer: "https://auth.example.com" })).payload,
    audience: resource,
    agents: (claims) => `agent:${claims.sub}`, // or a map { "<sub>": "agent:manager" }; default: sub as is
    resourceMetadataUrl: resourceMetadataUrl(resource),
  }),
  resourceMetadata: { resource, authorization_servers: ["https://auth.example.com"] },
});
```

With `resourceMetadata`, the desk serves it at `/.well-known/oauth-protected-resource/mcp`, and 401 answers point clients there so they can find the authorization server. A token whose subject maps to no agent gets 403. The desk does not issue tokens or store keys; see [SPEC.md §10.1](https://github.com/probita-ai/agent-work-layer/blob/main/SPEC.md#101-authenticated-actor).

## Gateway: enforce an order while the worker works

The desk checks `tools` and `budget` when the report arrives. The gateway enforces them at every tool call. It sits between the worker and its real MCP servers, for one order:

```sh
claude mcp add work -e AWL_STORE="$HOME/.awl" -- npx -y agent-work-layer-mcp gateway --order wo_123 --config upstream.json
```

`upstream.json` lists the real servers, in the same shape as `.mcp.json`:

```json
{ "mcpServers": {
    "filings": { "command": "npx", "args": ["-y", "filings-mcp"] },
    "calc": { "url": "https://calc.example.com/mcp" } } }
```

- Tools appear as `<server>__<tool>`, and only those the order's `tools` allow. Calls to others are refused.
- Calls are refused once `budget.tool_calls` or `budget.seconds` is spent, and while the order is not `working`. An `accepted` order is started on its first call.
- Each result ends with an evidence ref such as `filings/search#3`. Cite it as `{ "type": "tool_call", "ref": "filings/search#3" }`.
- `awl_usage` returns `tools_used` and `cost` to copy into `submit_work_report`, and every call so far.
- Calls are logged to `<store>/calls/<id>.jsonl`. The log is reloaded on restart, so restarting does not reset the budget.

| Flag | Environment | Default | Meaning |
|---|---|---|---|
| `--order <id>` | | required | The order to enforce |
| `--config <file>` | | required | The real MCP servers |
| `--store <dir>` | `AWL_STORE` | `./.awl` | The desk's folder; the call log goes in `calls/` |
| `--actor <ref>` | `AWL_ACTOR` | the order's worker | Must be the order's worker |
| `--observe` | | off | Log only, refuse nothing (see below) |

**Already enforce access with your own gateway or policy engine?** Run with `--observe` (in code, `enforce: false`). The gateway then lists every tool and refuses nothing. It still numbers and logs every call and reports usage. Calls the order would have refused are logged with a `violation` (`TOOL_NOT_ALLOWED`, `BUDGET_SPENT` or `ORDER_NOT_WORKING`), and the desk still catches them in the report (R5, R7).

The gateway cannot measure `usd` or `tokens`; the desk still checks those when the report arrives. See [SPEC.md §9.1](https://github.com/probita-ai/agent-work-layer/blob/main/SPEC.md#91-mcp-gateway).

## Embed the server

```ts
import { WorkDesk, FileStore } from "agent-work-layer";
import { createDeskServer } from "agent-work-layer-mcp";

const server = createDeskServer({ desk: new WorkDesk({ store: new FileStore("./.awl") }), actor: "agent:manager" });
await server.connect(transport); // any MCP transport
```

The gateway takes connected MCP clients for the real servers:

```ts
import { createGateway } from "agent-work-layer-mcp";

const { server, usage } = await createGateway({ desk, orderId: "wo_123", upstreams: { filings: filingsClient }, logFile: "./calls.jsonl" });
await server.connect(transport);
```

## Upgrading from agent-work-layer 0.1

| 0.1 | 0.2 |
|---|---|
| `npx -y agent-work-layer desk` | `npx -y agent-work-layer-mcp` |
| `import { createDeskServer } from "agent-work-layer/mcp"` | `import { createDeskServer } from "agent-work-layer-mcp"` |

Stored orders keep working. The desk reads 0.1 documents and writes 0.2.

## Security

Over stdio, the desk trusts the identity it is started with: anyone who can start a desk or write to the store folder can act as any agent. Use it for development. In production, run [one desk over HTTP](#shared-desk-over-http), which takes the actor from each request's credential. See [SPEC.md §10](https://github.com/probita-ai/agent-work-layer/blob/main/SPEC.md#10-security).

## License

Apache-2.0
