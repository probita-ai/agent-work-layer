# agent-work-layer-mcp

**The [Agent Work Layer](https://github.com/probita-ai/agent-work-layer) desk as an MCP server.** Agent sessions hand each other Work Orders and get checked Work Reports back.

[![npm](https://img.shields.io/npm/v/agent-work-layer-mcp.svg)](https://www.npmjs.com/package/agent-work-layer-mcp)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Two ways to run it:

- **stdio, for development.** Each agent session runs its own desk process. Sessions share one folder, and each is locked to the identity it is started with.
- **HTTP, for shared use.** Every agent connects to one desk, and each request's credential decides who it acts as, so a worker cannot approve its own work. See [Shared desk over HTTP](#shared-desk-over-http). It can also sign [Delegation Passes](#delegation-passes).

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
| `create_work_order` | manager | Issue an order: goal, criteria, budget, deadline, tools, optional `staged` tools, `handoff`, and `continues` to reissue a finished order |
| `list_work_orders` | anyone | Find orders, e.g. `to=<you>, state=offered`, or `continues=<id>` to follow a reissued job |
| `get_work_order` | anyone | Order, state, latest report, findings, events; the worker also gets its [pass](#delegation-passes) |
| `accept_work_order` / `decline_work_order` | worker | Answer an offer |
| `start_work_order` | worker | Begin work |
| `report_progress` | worker | Post a progress note, optionally with percent done; changes no state |
| `submit_work_report` | worker | Report `done`, `blocked` or `failed`, with evidence, staged `effects` and an optional `handoff` |
| `answer_question` | manager or escalation contact | Unblock a worker |
| `review_work_report` | manager | Approve (staged effects may then run, or only the `effects` named), or send back for rework (they are dropped) |
| `cancel_work_order` | manager | Stop an unfinished order |
| `wait_for_update` | anyone | Wait for the next change to an order, progress notes included |
| `get_track_record` | anyone | A worker's record on this desk: outcomes, reworks, reports, spending against budget |
| `renew_work_pass` | worker | A fresh [Delegation Pass](#delegation-passes); listed only when the desk issues passes |

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
| `--pass-key <file>` | | none | Private JWK to sign [Delegation Passes](#delegation-passes) with |
| `--issuer <iss>` | | none | The passes' `iss`; required with `--pass-key` |

### Bring your own authentication

In code, pass an `authenticate(request)` hook. It returns the agent ref, or throws an `AuthError` (401 by default, or `{ status: 403 }` for a valid credential that is not an agent). Any other error also refuses the request, without showing its message.

```ts
import { createServer } from "node:http";
import { createDeskHttpHandler, apiKeyAuth } from "agent-work-layer-mcp";

const managerKey = process.env.MANAGER_KEY;
if (!managerKey) throw new Error("MANAGER_KEY is not set");

const handle = createDeskHttpHandler({ desk, authenticate: apiKeyAuth({ [managerKey]: "agent:manager" }) });
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
    agents: (claims) => (claims.sub ? `agent:${claims.sub}` : undefined), // or a map { "<sub>": "agent:manager" }; default: sub as is
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
- Calls are refused once `budget.tool_calls` or `budget.seconds` is spent, and while the order is not `working`. Tool calls the order's sub-orders hold don't count as its own: with 20 tool calls and a sub-order holding 5, the order itself may make 15. An `accepted` order is started on its first call.
- Each result ends with an evidence ref such as `filings/search#3`. Cite it as `{ "type": "tool_call", "ref": "filings/search#3" }`.
- `awl_usage` returns `tools_used`, `cost` and staged `effects` to copy into `submit_work_report`, and every call so far.
- Calls are logged to `<store>/calls/<id>.jsonl`. The log is reloaded on restart, so restarting does not reset the budget.

| Flag | Environment | Default | Meaning |
|---|---|---|---|
| `--order <id>` | | required | The order to enforce |
| `--config <file>` | | required | The real MCP servers |
| `--store <dir>` | `AWL_STORE` | `./.awl` | The desk's folder; the call log goes in `calls/` |
| `--actor <ref>` | `AWL_ACTOR` | the order's worker | Must be the order's worker |
| `--observe` | | off | Log only, refuse nothing (see below) |
| `--commit` | | off | Run the approved report's staged effects, print the results and exit (see below) |

**Already enforce access with your own gateway or policy engine?** Run with `--observe` (in code, `enforce: false`). The gateway then lists every tool and refuses nothing. It still numbers and logs every call and reports usage. Calls the order would have refused are logged with a `violation` (`TOOL_NOT_ALLOWED`, `BUDGET_SPENT` or `ORDER_NOT_WORKING`), and the desk still catches them in the report (R5, R7).

The gateway cannot measure `usd` or `tokens`; the desk still checks those when the report arrives. See [SPEC.md §9.1](https://github.com/probita-ai/agent-work-layer/blob/main/SPEC.md#91-mcp-gateway).

Each logged call, and each result's `_meta`, also records the authority it ran under: the order id (`awl/order`), the report attempt in progress (`awl/attempt`) and, when the desk issues passes, the pass's `jti` (`awl/jti`).

### Staged tools: run writes only after approval

An order's `staged` tools are ones whose calls should wait for the manager's review ([SPEC.md §4.6](https://github.com/probita-ai/agent-work-layer/blob/main/SPEC.md#46-staged-tools)). The gateway doesn't forward them:

1. The worker calls `gmail__send`. The gateway counts the call against `tool_calls`, logs it with its arguments, and returns `pending:gmail/send#4` instead of a result (`_meta["awl/staged"]` is `true`). Other tools run as usual.
2. `awl_usage` lists the calls waiting as `effects`. The worker copies the ones it wants into its report, in the order they should run.
3. The manager reviews the report, effects included. **Rework** drops them all; the worker stages again if it still wants them. A `blocked` report keeps them.
4. Once the order is **approved**, run them:

```sh
npx -y agent-work-layer-mcp gateway --order wo_123 --config upstream.json --commit
```

`--commit` (in code, `gateway.commit()`) runs nothing unless the order is approved and every effect to run matches a staged call in the log: same ref, tool and arguments, made since the last rework. If the manager approved only some effects, only those run. It runs them in the report's order and logs each result with `commit: true`. A failed effect is recorded, not retried, and the effects after it still run. Running `--commit` again runs nothing twice. Before each call it logs a `running` line, so if the process dies mid-call, the next `--commit` records that effect as an error (it may have run) instead of running it again. While a commit runs, a `<log>.commit-lock` file keeps a second one from starting; if a commit crashed, check the log and remove the lock. Staged calls the report leaves out never run.

To use an earlier staged call's result, pass a reference as an argument when making the staged call: `{"$ref": "github/create_issue#3", "pointer": "/structuredContent/number"}`. `--commit` fills it in from that effect's result, a `CallToolResult`. If that effect failed or was skipped, or has nothing at the pointer, the effect using it is skipped (`outcome: "skipped"`, with the reason).

## Delegation Passes

A pass is the order's tools, budget and deadline signed by the desk, so a gateway or another team's system can check a worker's authority without reading the desk ([SPEC.md §10.2](https://github.com/probita-ai/agent-work-layer/blob/main/SPEC.md#102-delegation-pass)).

The shared desk issues them when given a private key (a P-256 or Ed25519 JWK):

```sh
npx -y agent-work-layer-mcp serve --keys keys.json --pass-key priv.json --issuer https://desk.example.com
```

- `start_work_order` and `get_work_order` return the worker's current `pass`. Nobody else sees it.
- A pass lasts 15 minutes, never past the deadline. `renew_work_pass` gets a fresh one while the order is `working`; a new one is also issued after an answer or a rework.
- When the order is cancelled, expires or leaves `working`, no new passes are issued.

The gateway can then work from the pass instead of the desk's store. Give it the desk's public key and the pass:

```sh
npx -y agent-work-layer-mcp gateway --order wo_123 --config upstream.json --actor agent:worker \
  --pass-keys pub.json --pass-file pass.txt --issuer https://desk.example.com
```

- Every call needs a valid pass for this order and worker. Without one, or with one that is expired, badly signed, or for another worker, order or issuer, the call is refused with `PASS_INVALID`.
- Tools and `tool_calls` come from the pass. `seconds`, and the tool calls sub-orders hold, are left to the desk's report checks, since a pass doesn't say when work started or what sub-orders exist.
- `--pass-file` is read on every call, so the worker renews by writing the new pass there. `AWL_PASS` works for a fixed pass. A call's `_meta["awl/pass"]` wins over both.

| Flag | Environment | Meaning |
|---|---|---|
| `--pass-keys <file>` | | The desk's public key: a JWK, a JWK Set or an array |
| `--pass-file <file>` | `AWL_PASS` (the pass itself) | Where the current pass is |
| `--issuer <iss>` | | Required `iss` |

In code: `createGateway({ orderId, upstreams, actor, passKeys, pass, issuer })`, with no `desk`.

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

const { server, usage, commit } = await createGateway({ desk, orderId: "wo_123", upstreams: { filings: filingsClient }, logFile: "./calls.jsonl" });
await server.connect(transport);
// After the manager approves: run the report's staged effects.
const results = await commit();
```

## Upgrading from agent-work-layer 0.1

| 0.1 | 0.2 |
|---|---|
| `npx -y agent-work-layer desk` | `npx -y agent-work-layer-mcp` |
| `import { createDeskServer } from "agent-work-layer/mcp"` | `import { createDeskServer } from "agent-work-layer-mcp"` |

Stored orders keep working. The desk reads 0.1 documents and writes 0.2.

## Security

Over stdio, the desk trusts the identity it is started with: anyone who can start a desk or write to the store folder can act as any agent. Use it for development. In production, run [one desk over HTTP](#shared-desk-over-http), which takes the actor from each request's credential. Delegation Passes are bearer tokens for a worker's authority: keep them short-lived (the default), and keep the signing key on the desk only. See [SPEC.md §10](https://github.com/probita-ai/agent-work-layer/blob/main/SPEC.md#10-security).

## License

Apache-2.0
