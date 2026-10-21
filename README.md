# agent-work-layer

**Work Orders and Work Reports for AI agents.** A typed SDK, validator and lifecycle engine for handing work from one agent to another, with checkable results. The MCP server is a separate package, [`agent-work-layer-mcp`](packages/mcp/).

[![npm](https://img.shields.io/npm/v/agent-work-layer.svg)](https://www.npmjs.com/package/agent-work-layer)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![M8ven Score](https://m8ven.ai/badge/mcp/probita-ai-agent-work-layer-0vyqyi?v=1b5d39882e3a71ebeecc28d9d2f02ec3)](https://m8ven.ai/mcp/probita-ai-agent-work-layer-0vyqyi?s=readme)

- **Work Order** (manager → worker): the goal, how "done" is judged, budget, deadline, allowed tools.
- **Work Report** (worker → manager): the result, evidence for each criterion, actual cost, tools used.

Agent Cards say who an agent is. A2A carries messages between agents. MCP connects agents to tools. AWL describes **the job itself**, so any manager can hand work to any worker and check what came back. The format is defined in [SPEC.md](SPEC.md).

<p align="center"><img src="docs/layers.svg" alt="Manager and worker agents connected by Agent Card, A2A and the AWL work layer; the worker reaches tools through MCP" width="760"></p>

## How it works

1. A manager issues a **Work Order**: goal, criteria, budget, deadline, allowed tools.
2. A worker accepts it and does the job with its tools.
3. The worker returns a **Work Report** with evidence for every criterion and what it spent.
4. The desk checks the report against the order. The manager approves it or sends it back.

<p align="center"><img src="docs/fields.svg" alt="Each Work Report field answers a Work Order field: evidence proves criteria, cost stays within budget, tools used stay within allowed tools" width="760"></p>

More diagrams: [message sequence](docs/sequence.svg) · [lifecycle](docs/lifecycle.svg) · [delegation](docs/delegation.svg) · [handoff](docs/handoff.svg) · [authenticated actor](docs/authenticated-actor.svg) · [Delegation Pass](docs/delegation-pass.svg)

## Install

Install only the part you use:

| You want to… | Install | Packages |
|---|---|---|
| Validate orders and reports, or run a desk in your code | `npm install agent-work-layer` | 7 |
| Validate in a browser, Deno or Bun | `npm install agent-work-layer`, then import `agent-work-layer/validate` | 7 |
| Validate orders and reports in Python | `pip install agent-work-layer` ([python/](python/)) | 11 |
| Connect agent sessions (e.g. Claude Code) through MCP | `npx -y agent-work-layer-mcp` ([setup](#run-as-an-mcp-server)) | ~100 |
| Sign or verify Delegation Passes | `npm install agent-work-layer` ([how](#delegation-pass)) | 7 |

Node.js 20.11 or later. ESM only. Types included. The Python package needs Python 3.9 or later.

## Quick start

```ts
import { WorkDesk } from "agent-work-layer";

const desk = new WorkDesk(); // in-memory; use FileStore, SqliteStore or your own DeskStore to persist

// Manager issues a job
const { order } = await desk.create(
  {
    to: "agent:researcher",
    goal: "Summarize the main risk factors in the latest annual report",
    criteria: [
      { id: "c1", text: "Lists three risk factors, each quoted from the filing" },
      { id: "c2", text: "States total debt and its fiscal year" },
    ],
    budget: { usd: 2, tool_calls: 20 },
    deadline: new Date(Date.now() + 3_600_000).toISOString(),
    tools: ["filings/*"],
  },
  "agent:manager",
);

// Worker accepts, does the work, reports with evidence
await desk.accept(order.id, "agent:researcher");
const { record } = await desk.submitReport(
  order.id,
  {
    status: "done",
    result: { summary: "Refinancing, customer concentration and FX risk. Debt 1.2B USD (FY2025)." },
    evidence: [
      { criterion: "c1", type: "tool_call", ref: "filings/get_section#3" },
      { criterion: "c2", type: "citation", ref: "filings/get_section#5" },
    ],
    cost: { usd: 0.84, tool_calls: 7 },
    tools_used: ["filings/search", "filings/get_section"],
  },
  "agent:researcher",
);

// Manager approves, or sends it back with a reason
await desk.review(order.id, "agent:manager", "approve");
```

For a runnable version, clone the repo, run `npm install`, then run `node examples/two-agents.ts` (Node 22.18+). [examples/two-agents.ts](examples/two-agents.ts) walks one job through a rejected report, a rework request and approval, printing each event as it happens.

The desk enforces the spec as you go:

- Who may do what: only the worker reports, and only the manager approves.
- Which state changes are legal.
- Evidence for every criterion.
- Only allowed tools.
- Cost within budget and finishing before the deadline. Going over either expires the order.
- Sub-orders can only narrow their parent's authority.
- A reissued order can only continue a finished one, so one job never has two live orders.

Optionally, it also signs the worker's authority into a [Delegation Pass](#delegation-pass) that gateways and other systems can check without the desk.

### Hand off unfinished work

When a worker fails, gets blocked or is cancelled, it can say what the next worker should know. The manager passes that along in the next order:

<p align="center"><img src="docs/handoff.svg" alt="Worker A reports failed with a handoff; the manager cancels that order and reissues the job to Worker B with continues pointing at it and the same handoff: summary, decisions, what was tried, open questions and next step" width="760"></p>

```ts
await desk.submitReport(order.id, {
  status: "failed",
  error: "Export runs out of memory on files over 2 GB",
  handoff: {
    decisions: [{ text: "Stream rows instead of buffering", why: "Memory limit" }],
    tried: [{ text: "xlsx library", result: "Too slow on large files" }],
    next_step: "Add tests for null cells",
  },
  /* result, evidence, cost, tools_used */
}, "agent:researcher");

const { handoff } = (await desk.get(order.id)).reports.at(-1)!;
await desk.cancel(order.id, "agent:manager", "reissuing");   // a continued order must be finished
await desk.create({ ...nextJob, to: "agent:other-worker", handoff, continues: order.id }, "agent:manager");

await desk.list({ continues: order.id });   // the orders that pick up from this one
```

`context` lists what to read; `handoff` says what was decided and already tried; `continues` links the new order to the one it replaces, so the chain of orders is the job's full history. Unlike `parent_id`, it doesn't narrow anything: the new order can have a different worker, budget and tools. See [SPEC.md §4.4](SPEC.md#44-handoff) and [§4.5](SPEC.md#45-continuation).

## Validate documents

```ts
import { validateOrder, validateReport, hasInvalid } from "agent-work-layer";

const findings = validateReport(report, order);
// [{ rule: "R4", kind: "invalid", path: "/evidence", message: 'no evidence for criterion "c2"' }, ...]
if (hasInvalid(findings)) reject(findings);
```

Every finding carries the rule id from [SPEC.md §7](SPEC.md#7-checks). `invalid` findings reject a document. `limit` findings (over budget, past deadline) are recorded and expire the order.

Writing a validator in another language? Run it against the JSON test vectors in [conformance/](conformance/): documents with the findings each rule must report.

The JSON Schemas are exported too: `workOrderSchema`, `workReportSchema`, or `agent-work-layer/schemas/work-order.schema.json`.

`agent-work-layer/validate` has the same checks, types and schemas without the desk. It imports nothing from Node, so it runs in browsers, Deno and Bun. (Cloudflare Workers are not supported: the validator compiles schemas to code at runtime, which Workers block.)

## Run as an MCP server

The server lives in its own package, [`agent-work-layer-mcp`](packages/mcp/), so people who only validate documents don't download the MCP SDK.

**For development, over stdio.** Each agent session runs its own desk process. Sessions share one folder, and each is locked to the identity it is started with.

```sh
# Claude Code: a manager session and a worker session, each added in its own project folder
claude mcp add awl -e AWL_STORE="$HOME/.awl" -e AWL_ACTOR=agent:manager -- npx -y agent-work-layer-mcp
claude mcp add awl -e AWL_STORE="$HOME/.awl" -e AWL_ACTOR=agent:worker  -- npx -y agent-work-layer-mcp
```

**For shared use, over HTTP.** One desk serves every agent, and each request's credential decides who it acts as, so a worker cannot approve its own work ([details](#authenticated-actor)):

```sh
npx -y agent-work-layer-mcp serve --keys keys.json        # { "keys": { "<key>": "agent:manager", ... } }
claude mcp add --transport http awl http://127.0.0.1:8787/mcp --header "Authorization: Bearer $AWL_KEY"
```

Tools: `create_work_order`, `list_work_orders`, `get_work_order`, `accept_work_order`, `decline_work_order`, `start_work_order`, `submit_work_report`, `answer_question`, `review_work_report`, `cancel_work_order`, `wait_for_update`, and `renew_work_pass` when the desk issues [Delegation Passes](#delegation-pass).

To embed the server in your own process or transport (`npm install agent-work-layer agent-work-layer-mcp`):

```ts
import { WorkDesk, FileStore } from "agent-work-layer";
import { createDeskServer } from "agent-work-layer-mcp";

const server = createDeskServer({ desk: new WorkDesk({ store: new FileStore("./.awl") }), actor: "agent:manager" });
await server.connect(transport);
```

## CLI

```sh
npx agent-work-layer new order > order.json
npx agent-work-layer new report > report.json
npx agent-work-layer validate order.json report.json      # exit 1 on invalid, prints rule ids
npx agent-work-layer validate child.json --parent order.json
npx agent-work-layer validate order.json report.json --json
npx agent-work-layer schema order
npx -y agent-work-layer-mcp --store ./.awl --actor agent:worker   # the MCP desk on stdio (was "awl desk" before 0.2)
npx -y agent-work-layer-mcp serve --keys keys.json                 # one shared desk over HTTP; add --pass-key/--issuer to sign passes
npx -y agent-work-layer-mcp gateway --order <id> --config <file>   # enforce an order at every tool call; add --pass-keys to use passes
```

`new order` starts with one criterion, a USD 1 budget, no allowed tools and a
deadline one hour after creation. `new report` starts as `blocked`, with a question
and no evidence of completed work. Both templates validate together as printed.
Replace the placeholder goal, identities, criterion and report contents before
using them; keep the report's `order_id` equal to the order's `id`.

## Lifecycle

```
offered ──accept──▶ accepted ──start──▶ working ──report done/failed──▶ submitted ──approve──▶ approved
   │                                     │  ▲                              │
 decline                         blocked │  │ answer                       │ rework (with reason)
   ▼                                     ▼  │                              ▼
declined                                blocked                          working

Any active state ──cancel──▶ cancelled   ·   deadline or budget exceeded ──▶ expired
```

| Action | Who |
|---|---|
| accept, decline, start, submit report | the worker (`order.to`) |
| approve, rework, cancel | the manager (`order.from`) |
| answer a blocked worker | the manager or `order.escalate_to` |
| expire | the desk |

## API

| Export | Purpose |
|---|---|
| `WorkDesk` | Runs the lifecycle: `create`, `accept`, `decline`, `start`, `submitReport`, `answer`, `review`, `cancel`, `get`, `list`, `waitForChange`, and `issuePass` when it issues passes |
| `MemoryStore`, `FileStore`, `SqliteStore`, `DeskStore` | Storage. Implement `DeskStore` (4 methods) to use a database |
| `validateOrder`, `validateReport`, `validateChildOrder`, `hasInvalid` | Spec checks, returning `Finding[]` |
| `isWorkOrder`, `isWorkReport` | Type guards |
| `toolAllowed`, `patternCovered` | Tool pattern matching |
| `nextState`, `allowedActions`, `STATES`, `ROLE_FOR`, `isTerminal` | The state machine |
| `AwlError`, `isAwlError` | Typed errors with `code` and `findings` |
| `signPass`, `verifyPass`, `decodePass`, `PassError` | [Delegation Passes](#delegation-pass): sign, verify (including narrowing against a parent), read |
| `ORDER_SPEC`, `REPORT_SPEC`, `ORDER_SPECS`, `REPORT_SPECS` | The spec version written, and every version read |
| `createDeskServer` (from `agent-work-layer-mcp`) | MCP server for a desk |
| `createDeskHttpHandler`, `apiKeyAuth`, `bearerAuth`, `AuthError` (from `agent-work-layer-mcp`) | The desk over HTTP, with the actor from each request's credential |
| `createGateway` (from `agent-work-layer-mcp`) | MCP gateway enforcing an order, or a Delegation Pass, at every tool call |

`WorkDesk` options: `store`, `clock` (for tests), `newId`, `onEvent(event, record)` (webhooks, logging, metrics), `passes: { key, issuer, ttlSeconds? }` (sign Delegation Passes).

### Error codes

`NOT_FOUND`, `ALREADY_EXISTS`, `FORBIDDEN`, `INVALID_TRANSITION`, `VALIDATION_FAILED` (with `findings`), `CONFLICT` (a concurrent writer got there first; re-read and retry), `BAD_REQUEST`.

`PassError` codes: `MALFORMED`, `UNSUPPORTED`, `BAD_SIGNATURE`, `EXPIRED`, `NOT_YET_VALID`, `WRONG_ISSUER`, `WRONG_WORKER`, `WRONG_ORDER`, `WRONG_PARENT`, `WIDER_THAN_PARENT` (with `findings` from C1–C3).

### Custom storage

`MemoryStore` keeps records in memory, `FileStore` writes one JSON file per order, and `SqliteStore` keeps them in a SQLite database using Node's built-in `node:sqlite` (Node 22.13+, no extra dependency):

```ts
import { WorkDesk, SqliteStore } from "agent-work-layer";

const desk = new WorkDesk({ store: new SqliteStore("./awl.db") }); // or ":memory:"
```

To use another database, implement `DeskStore`:

```ts
import type { DeskStore, OrderRecord } from "agent-work-layer";

class PostgresStore implements DeskStore {
  async read(id: string): Promise<OrderRecord | null> { /* SELECT */ }
  async insert(record: OrderRecord) { /* INSERT, throw AwlError("ALREADY_EXISTS") on conflict */ }
  async update(record: OrderRecord, expectedSeq: number) { /* UPDATE ... WHERE last_seq = expectedSeq, else AwlError("CONFLICT") */ }
  async list() { /* SELECT */ }
}
```

## Production notes

A stdio desk trusts the `actor` it is started with. In production, run one desk over HTTP that takes the actor from each request's credential: `npx -y agent-work-layer-mcp serve --keys keys.json`, or `createDeskHttpHandler` with your own `authenticate` hook (OAuth 2.1 bearer tokens, API keys, mTLS). See the [MCP package README](packages/mcp/README.md#shared-desk-over-http). For real-time enforcement, run the MCP gateway (`npx -y agent-work-layer-mcp gateway`), which checks `tools` and `budget` at each tool call, not only when the report arrives. When the gateway or another team's system can't read the desk, give it [Delegation Passes](#delegation-pass) instead. See [SPEC.md §9.1](SPEC.md#91-mcp-gateway) and [§10](SPEC.md#10-security).

## Authenticated actor

With stdio, each agent runs its own desk and declares its own `actor`, so a worker could start one as its manager. Over HTTP, every agent connects to one desk, which takes the actor from the request's credential through a pluggable `authenticate(request)` hook. Teams plug in what they already use: OAuth 2.1 bearer tokens, API keys or mTLS. An `actor` argument naming anyone else is refused ([#16](https://github.com/probita-ai/agent-work-layer/issues/16), [SPEC.md §10.1](SPEC.md#101-authenticated-actor)).

<p align="center"><img src="docs/authenticated-actor.svg" alt="With stdio, a worker can start its own desk with --actor agent:manager and approve its own report. Over HTTP, agents send a credential to one desk, authenticate(request) maps it to an agent ref before the role check, and a spoofed actor argument is refused" width="760"></p>

## Delegation Pass

When a worker starts, the desk signs a short-lived pass (a JWS) carrying the order's tools, budget and deadline. The worker presents it with each tool call, and a gateway or another team's system verifies it on its own, without calling the desk. A sub-order gets a narrower pass that names its parent, so the delegation rules (C1–C3) can be checked offline ([#17](https://github.com/probita-ai/agent-work-layer/issues/17), [SPEC.md §10.2](SPEC.md#102-delegation-pass)).

<p align="center"><img src="docs/delegation-pass.svg" alt="The desk signs a pass when the worker starts; the gateway verifies it on each tool call, allowing filings/search and refusing web/browse; a sub-order gets a narrower pass naming its parent. Below, the claims in a pass: iss, sub, awl_order, awl_tools, awl_budget, awl_parent, awl_deadline, awl_attempt, iat, exp, jti, and the typ awl-pass+jwt" width="760"></p>

- A pass lasts 15 minutes by default, never past the deadline. The desk issues a new one each time the order enters `working`, and the worker renews it while it works.
- It carries the order's whole budget; the gateway tracks what has been spent.
- Cancelling or expiring the order stops new passes. There is no other revocation, which is why passes are short.

```ts
import { WorkDesk, verifyPass } from "agent-work-layer";

const desk = new WorkDesk({ passes: { key: privateJwk, issuer: "https://desk.example.com" } });
// ...create, accept...
const { pass } = await desk.start(id, "agent:worker");   // renew with desk.issuePass(id, "agent:worker")

// Anywhere else, with only the desk's public key:
const verified = await verifyPass(pass, publicJwk, { issuer: "https://desk.example.com", worker: "agent:worker", order: id });
verified.allows("filings/search");   // true
const child = await verifyPass(childPass, publicJwk, { parent: verified });   // throws WIDER_THAN_PARENT if it breaks C1–C3
```

Keys are P-256 or Ed25519 JWKs (or WebCrypto keys) that you supply; the SDK does no key management. `signPass` and `verifyPass` use WebCrypto only, so they are also in `agent-work-layer/validate` for browsers, Deno and Bun. To make a key pair in Node:

```js
const { privateKey, publicKey } = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
console.log(JSON.stringify(await crypto.subtle.exportKey("jwk", privateKey)), JSON.stringify(await crypto.subtle.exportKey("jwk", publicKey)));
```

Over MCP, `awl-desk serve --pass-key priv.json --issuer <url>` issues passes, and `awl-desk gateway --pass-keys pub.json` enforces them; see the [MCP package README](packages/mcp/README.md#delegation-passes).

## Development

The repo is an npm workspace with two packages: the core in [`packages/core`](packages/core/) and the MCP server in [`packages/mcp`](packages/mcp/). The spec, schemas and examples stay at the root; the core copies them in when it is packed.

```sh
npm install
npm test               # core and MCP tests (builds the core first)
npm run test:coverage
npm run typecheck
npm run test:package   # packs both packages, installs them in clean projects and uses them
npm run check          # all of the above; runs automatically before npm publish
npm run generate       # after editing schemas/*.json: refreshes packages/core/src/generated.ts
```

The Python package in [`python/`](python/) is separate from the npm workspace:

```sh
cd python
python -m venv .venv && .venv/bin/pip install -e ".[test]"
.venv/bin/pytest
```

## Contributing

Issues, ideas and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) and the [roadmap](ROADMAP.md). Spec changes start as a **Spec proposal** issue.

## License

[Apache-2.0](LICENSE). You can use, modify and ship it, including commercially. The license includes a patent grant.
