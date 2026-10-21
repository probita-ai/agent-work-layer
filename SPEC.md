# Agent Work Layer (AWL) — Specification v0.3 (draft)

Status: draft · Date: 2026-10-09 · Changes from v0.1: the optional `handoff` field (§4.4); MCP gateway (§9.1); readers accept both versions (§11); related work (§13).

## 1. Purpose

AWL defines how one agent hands a job to another and how the result comes back.
It specifies two documents, a state machine, and a set of checks:

| Document     | Direction         | Answers                                  |
|--------------|-------------------|------------------------------------------|
| Work Order   | manager → worker  | What is the job, and what are the limits? |
| Work Report  | worker → manager  | What was done, and what is the proof?     |

AWL is a payload format. It does not replace the layers around it:

- **Agent Card / A2A**: who an agent is and how messages travel. AWL documents ride inside those messages.
- **MCP**: how an agent calls tools. AWL records which tools a job may use and which it did use.

The key words MUST, SHOULD and MAY are used as in RFC 2119.

## 2. Terms

- **Manager**: the party that issues a Work Order (an agent or a human).
- **Worker**: the agent that performs it.
- **Escalation contact**: who the worker asks when blocked (`escalate_to`, default the manager).
- **Desk**: any system that stores orders, applies the state machine and runs the checks. A desk can be a folder of files, an MCP server, or a hosted service.
- **Agent reference**: a string naming an agent or human. It SHOULD be the URL of the agent's Agent Card when one exists. Humans use the form `human:<id>`.

## 3. Encoding

- Documents are JSON objects (UTF-8). YAML MAY be used for authoring; it MUST convert to the same JSON.
- Timestamps are RFC 3339 (`2026-10-09T17:00:00Z`).
- Media types: `application/vnd.awl.work-order+json`, `application/vnd.awl.work-report+json`.
- Unknown top-level fields are not allowed, except fields starting with `x-` (extensions) and the free-form `metadata` object.
- JSON Schemas (2020-12) are in [`schemas/`](schemas/). The schemas are normative for structure; section 7 is normative for meaning.

## 4. Work Order

| Field          | Req | Type                | Meaning |
|----------------|-----|---------------------|---------|
| `spec`         | yes | `"awl/work-order@0.3"` | Format and version. Readers also accept `@0.1` and `@0.2` (§11). |
| `id`           | yes | string              | Unique job id, set by the desk or manager. |
| `created_at`   | yes | timestamp           | When the order was issued. |
| `from`         | yes | agent ref           | The manager. |
| `to`           | yes | agent ref           | The worker. |
| `goal`         | yes | string              | What to achieve, in plain language. |
| `criteria`     | yes | array of Criterion (≥1) | How "done" will be judged. |
| `budget`       | yes | Budget              | Upper limits for this job. |
| `deadline`     | yes | timestamp           | Latest allowed finish. |
| `tools`        | yes | array of tool pattern | Tools the worker may use (§4.3). May be empty. |
| `escalate_to`  | no  | agent ref           | Who to ask when blocked. Default: `from`. |
| `inputs`       | no  | object              | Structured inputs for the job. |
| `context`      | no  | array of `{uri, note?}` | Pointers to material the worker should read. |
| `handoff`      | no  | Handoff (§4.4)      | What earlier work on this job established. |
| `output_schema`| no  | JSON Schema         | Shape that `result.output` MUST match when done. |
| `parent_id`    | no  | string              | Set when this order was split from a larger one (§8). |
| `continues`    | no  | string              | The id of the finished order this one picks up from (§4.5). |
| `metadata`     | no  | object              | Free-form; ignored by checks. |

### 4.1 Criterion

`{ "id": "c1", "text": "Lists the three largest risk factors" }`. Ids MUST be unique within the order.
A criterion SHOULD be checkable by a reader who sees only the report and its evidence.

### 4.2 Budget and cost units

A Budget is an object with at least one of these units. Cost (in the report) uses the same units.

| Unit         | Meaning |
|--------------|---------|
| `usd`        | Money spent (model calls, paid tools). |
| `tokens`     | Model tokens, input plus output. |
| `tool_calls` | Number of tool invocations. |
| `seconds`    | Wall-clock working time. |

### 4.3 Tool patterns

A tool is named `<server>/<tool>`, where `<server>` is the MCP server name as the worker knows it.
Patterns: `server/tool` (exactly one tool), `server/*` (every tool on that server), `*` (any tool).

### 4.4 Handoff

When a job moves from one worker to another (after a failure, a cancellation or a block), the next worker should not start from nothing. `context` says what to read; `handoff` says what was decided, what was already tried, and where things stand.

```json
"handoff": {
  "summary": "Parser done; export fails on files over 2 GB",
  "decisions": [{ "text": "Stream rows instead of buffering", "why": "Memory limit" }],
  "tried": [{ "text": "xlsx library", "result": "Too slow on large files" }],
  "open_questions": ["Quote style for commas?"],
  "next_step": "Add tests for null cells"
}
```

| Field            | Type                          | Meaning |
|------------------|-------------------------------|---------|
| `summary`        | string                        | Where the work stands. |
| `decisions`      | array of `{text, why?}`       | Choices already made, and why. The next worker SHOULD keep them unless it has a reason not to. |
| `tried`          | array of `{text, result?}`    | Approaches already attempted and what happened, so they are not repeated. |
| `open_questions` | array of string               | Questions still unanswered. |
| `next_step`      | string                        | The most useful thing to do next. |

Every field is optional, but a handoff MUST NOT be empty. A Work Report MAY carry a handoff (§5); a worker SHOULD include one when it reports `failed` or `blocked`. A manager reissuing the job MAY copy it, edited or not, into the new order, and SHOULD link the two with `continues` (§4.5). Handoff content is the previous worker's account, not verified fact; it is not checked against evidence.

### 4.5 Continuation

When a job moves to another worker after it stopped, the new order names the order it picks up from in `continues`. A chain of orders linked this way is the full history of one job: who worked on it, and under which order, and so which authority, each earlier action ran.

`continues` is not `parent_id`. A sub-order (§8) is part of a live order and may only narrow it; a continuation replaces a finished one. No narrowing rules apply: the new order may have a different worker, budget, tools and deadline. An order MAY have both, e.g. a sub-order reissued under the same parent.

A desk MUST reject an order whose `continues`:

- names no order it knows;
- names an order that is not in a terminal state (`approved`, `declined`, `expired` or `cancelled`), so two orders are never live for the same job. A `failed` or `blocked` report leaves the order `submitted` or `blocked`; the manager cancels it first;
- names an order that another order already continues, so the chain stays a single line.

A desk SHOULD also accept continuations only from the earlier order's manager (`from`). Each order in a chain keeps its own budget and cost; nothing is carried over unless the manager puts it in the new order, usually as `handoff`.

## 5. Work Report

| Field         | Req | Type                    | Meaning |
|---------------|-----|-------------------------|---------|
| `spec`        | yes | `"awl/work-report@0.2"` | Format and version. Readers also accept `@0.1` (§11). |
| `order_id`    | yes | string                  | The order this answers. |
| `from`        | yes | agent ref               | The worker. |
| `status`      | yes | `done` \| `blocked` \| `failed` | Outcome of this attempt. |
| `result`      | yes | `{summary, output?, artifacts?}` | What was produced. `artifacts` is an array of `{uri, media_type?, note?}`. |
| `evidence`    | yes | array of Evidence       | Proof, linked to criteria. |
| `cost`        | yes | Cost                    | What was actually spent. |
| `finished_at` | yes | timestamp               | When this attempt ended. |
| `tools_used`  | yes | array of tool names     | Every tool actually called (exact names, no wildcards). |
| `started_at`  | no  | timestamp               | When work began. |
| `attempt`     | no  | integer ≥ 1             | 1 for the first report, +1 after each rework. |
| `questions`   | no  | array of string         | Open questions. Required when `blocked`. |
| `error`       | no  | string                  | What went wrong. Required when `failed`. |
| `handoff`     | no  | Handoff (§4.4)          | What whoever continues this job should know. |
| `metadata`    | no  | object                  | Free-form. |

### 5.1 Evidence

```json
{ "criterion": "c1", "type": "tool_call", "ref": "filings/get_10k#call-7", "note": "Risk section, p.14" }
```

`type` is one of `tool_call`, `artifact`, `citation`, `note`. `ref` points at something a reviewer can open or replay.
A `note` alone is the weakest evidence; desks MAY treat criteria backed only by notes as needing human review.

## 6. Lifecycle

States: `offered`, `accepted`, `working`, `blocked`, `submitted` (active) and `approved`, `declined`, `expired`, `cancelled` (terminal).

| From        | Action          | Actor                 | To          |
|-------------|-----------------|-----------------------|-------------|
| offered     | accept          | worker                | accepted    |
| offered     | decline         | worker                | declined    |
| accepted    | start           | worker                | working     |
| working     | report `done` or `failed` | worker      | submitted   |
| working     | report `blocked`| worker                | blocked     |
| blocked     | answer          | manager or escalation contact | working |
| submitted   | approve         | manager               | approved    |
| submitted   | rework (with reason) | manager          | working     |
| any active  | cancel          | manager               | cancelled   |
| any active  | expire          | desk                  | expired     |

Rules:

1. A desk MUST expire an order when `deadline` passes or when reported cost exceeds any budget unit.
2. A `failed` report goes to `submitted`; the manager decides whether to rework or cancel.
3. Every transition MUST be recorded as an event (§6.1). The event log is the audit trail.

### 6.1 Event

```json
{ "seq": 4, "at": "2026-10-09T16:12:00Z", "actor": "agent:researcher",
  "action": "report", "from": "working", "to": "submitted", "note": "attempt 1" }
```

`seq` starts at 1 and increases by 1 per order. Consumers MAY use `seq` to wait for changes.

## 7. Checks

A desk MUST run these checks. **Invalid** findings reject the document. **Limit** findings are accepted and recorded, and move the order to `expired`.

### 7.1 Order checks

| Id | Kind    | Rule |
|----|---------|------|
| O1 | invalid | Matches the Work Order schema. |
| O2 | invalid | Criterion ids are unique. |
| O3 | invalid | `deadline` is later than `created_at`. |
| O4 | invalid | `output_schema`, if present, is a valid JSON Schema. |

### 7.2 Report checks (against its order)

| Id  | Kind    | Rule |
|-----|---------|------|
| R1  | invalid | Matches the Work Report schema. |
| R2  | invalid | `order_id` equals the order's `id`. |
| R3  | invalid | Every evidence item names a criterion that exists. |
| R4  | invalid | When `done`, every criterion has at least one evidence item. |
| R5  | invalid | Every entry in `tools_used` matches a pattern in the order's `tools`. |
| R6  | invalid | `cost` reports every unit that `budget` sets. |
| R7  | limit   | For every unit, `cost` ≤ `budget`. |
| R8  | limit   | `finished_at` ≤ `deadline`. |
| R9  | invalid | When `blocked`, `questions` is non-empty. |
| R10 | invalid | When `failed`, `error` is present. |
| R11 | invalid | When `done` and `output_schema` is set, `result.output` matches it. |
| R12 | invalid | `started_at`, if present, ≤ `finished_at`. |

## 8. Sub-orders (delegation)

A worker MAY split its job by issuing new orders with `parent_id` set. Authority only shrinks:

| Id | Rule |
|----|------|
| C1 | The child's budget sets every unit the parent sets, each ≤ the parent's value. |
| C2 | Every child tool pattern is covered by the parent's patterns. |
| C3 | The child's deadline ≤ the parent's deadline. |
| C4 | For `usd`, `tokens` and `tool_calls`, the budgets of the parent's sub-orders, this one included, add up to at most the parent's value. |

A desk MUST reject a child order that breaks C1–C4. The parent's reported cost SHOULD include its children's costs.

C1–C3 compare a child with its parent; C4 compares it with its siblings too, so that the sub-orders together hold no more budget than the parent. C4 counts every sub-order with the same `parent_id` except `declined` ones, which did no work. A cancelled, expired or approved sub-order counts in full: it may have spent its whole budget. `seconds` is not added up, because sub-orders run side by side; C3 limits their time. Sums are compared with a tolerance of 10⁻⁹, so that, for example, sub-orders of `0.1` and `0.2` fit a budget of `0.3`.

C4 needs the desk's list of sub-orders, so it is checked when the desk creates a child, not by a verifier holding only passes (§10.2).

## 9. Bindings

How AWL documents travel. A desk MAY support several.

- **Files**: `<id>.order.json` and `<id>.report.json` side by side. Good for tests and audit archives.
- **MCP**: a desk exposed as an MCP server with tools such as `create_work_order`, `submit_work_report` and `review_work_report`. The reference implementation is the `agent-work-layer-mcp` package in this repo.
- **A2A**: the document travels as a data part of an A2A message with the AWL media type. The A2A task id SHOULD be stored in `metadata.a2a_task_id`.

### 9.1 MCP gateway

A gateway is an MCP server that sits between one worker and its real MCP servers, for one order. It enforces the order while the worker works, instead of only checking the report afterwards (§10).

1. It MUST refuse a call to a tool that no pattern in `tools` allows (§4.3), and SHOULD NOT list such tools.
2. It MUST refuse calls once `budget.tool_calls` calls have reached a tool, and once `budget.seconds` have passed since the order was first started. It SHOULD stop a running call when the seconds run out.
3. It MUST refuse calls while the order is not `working`. It MAY start an `accepted` order on its first call.
4. Refused calls do not reach the tool and do not count against the budget. A call that reached the tool counts even if the tool returned an error.
5. It numbers the calls that reach a tool 1, 2, 3… per order, across reworks, and names each `<server>/<tool>#<n>`. That name is the `ref` of `tool_call` evidence (§5.1), and the gateway SHOULD return it with the call's result.
6. It SHOULD keep a log of every call, refused ones included, that survives a restart, so restarting the gateway does not reset the budget.
7. The report's `tools_used` and its `cost.tool_calls` and `cost.seconds` SHOULD be taken from the gateway's log.
8. Each logged call SHOULD record the authority it ran under: the order id, the report attempt in progress (`reports` + 1) and, when there is one, the `jti` of the Delegation Pass (§10.2). A resumed or reissued job can then tell which grant applied to every earlier call.

A gateway MAY work from **Delegation Passes** instead of the desk's order state (§10.2). It then requires a valid pass for its order and worker on every call, and enforces the pass's `awl_tools` and `awl_budget.tool_calls` in place of rules 1–3. A pass does not say when the order was started, so `budget.seconds` is left to the report checks.

A gateway MAY instead run in **observe** mode, for deployments whose own gateway or policy engine already controls access. It then applies rules 4–7 but not 1–3: it refuses nothing, and it SHOULD mark each logged call that rules 1–3 would have refused. Calls over budget or to tools the order does not allow still show up in the report, where checks R5 and R7 catch them.

The gateway cannot measure `usd` or `tokens`; those are still checked when the report arrives (R7). The reference implementation is `awl-desk gateway` in `agent-work-layer-mcp`.

## 10. Security

- A desk MUST bind `actor` to an authenticated identity in production (§10.1). The reference stdio desk trusts the identity it is started with and is for development only.
- A worker's MCP gateway SHOULD enforce `tools` and `budget` at call time, not only after the report arrives (§9.1).
- Evidence `ref` values can point at sensitive data. Desks SHOULD apply the same access rules to evidence as to the data it points at.

### 10.1 Authenticated actor

`actor` is bound to an authenticated identity when the desk, not the caller, decides it:

- The desk derives the actor from a credential it has verified on the same request (an OAuth 2.1 access token, an API key, a client certificate), through a hook `authenticate(request) → AgentRef`. The desk does not define how credentials are issued or stored.
- A request whose credential is missing or invalid MUST be refused before any operation runs (HTTP 401). A valid credential that maps to no agent MUST be refused too (HTTP 403).
- The authenticated actor is the only actor for that request. An `actor` argument naming anyone else MUST be refused with `FORBIDDEN`; naming the same agent is allowed. The role checks of §6 then run against that actor.
- A desk SHOULD authenticate every request, not only the first one of a session, so a session never outlives its credential.

For an MCP desk over Streamable HTTP, the desk is an OAuth resource server as the MCP authorization spec describes. When it accepts bearer tokens it MUST check that a token is unexpired and was issued for the desk (`aud`), SHOULD answer 401 with a `WWW-Authenticate` header naming its Protected Resource Metadata (RFC 9728), and maps the token's subject to an agent reference, either as is or through a configured map. A desk over stdio is not bound: whoever starts the process chooses its identity.

### 10.2 Delegation Pass

A Delegation Pass is an order's authority as a signed token: which tools, how much budget, until when, for which job and which worker. A gateway, a tool server or a sub-worker in another system can check a worker's authority with it, without calling the desk.

A pass is a JWS in compact form (a JWT) with header `typ` `awl-pass+jwt` and `alg` `ES256` (P-256) or `EdDSA` (Ed25519). Its claims:

| Claim | Value |
|---|---|
| `iss` | The desk that issued it |
| `sub` | The worker: the order's `to` |
| `awl_order` | The order's `id` |
| `awl_parent` | The parent order's `id`, for sub-orders |
| `awl_tools` | The order's `tools` |
| `awl_budget` | The order's whole `budget`, not what is left of it |
| `awl_deadline` | The order's `deadline` |
| `awl_attempt` | The report attempt the pass was issued for: `reports` + 1 |
| `iat`, `exp` | Issue and expiry time, in seconds since the epoch |
| `jti` | A unique id for this pass |

**Issuing.** A desk that issues passes signs one for the worker each time the order enters `working`, and on request while it stays `working`. A pass's `exp` MUST NOT be later than `awl_deadline`, and SHOULD be short (the reference desk uses 15 minutes); the worker renews it while it works. Short lifetimes are the only revocation: when an order is cancelled, expires or leaves `working`, the desk stops issuing passes for it. The desk SHOULD give a pass only to the authenticated worker (§10.1); a pass is only as trustworthy as the identity it was issued to.

**Verifying.** A verifier MUST reject a pass whose signature does not verify with one of the issuer's keys, whose `typ` or `alg` is not one of the above, that has expired (at `exp` or `awl_deadline`, whichever is sooner), or whose `iat` is in the future by more than an allowance for clock skew (the reference verifier allows 60 seconds). It SHOULD check `iss`, and that `sub` and `awl_order` are the worker and order it expects. A tool call is allowed when a pattern in `awl_tools` allows it (§4.3).

**Narrowing.** A sub-order's pass names its parent in `awl_parent`. A verifier holding a pass and its parent's pass checks C1–C3 (§8) between their `awl_budget`, `awl_tools` and `awl_deadline`, and MUST reject a pass wider than its parent's or naming a different parent. A chain is verified from the top down.

Key distribution, rotation and JWKS hosting are out of scope. The reference implementation is `signPass` and `verifyPass` in `agent-work-layer`, which use WebCrypto only.

## 11. Versioning

`spec` carries the version. Minor versions (0.x) may add optional fields only. Readers MUST reject a major version they do not know.

Each document type has its own version. v0.3 adds `continues` to the Work Order and leaves the Work Report unchanged:

| Spec | Work Order | Work Report |
|---|---|---|
| v0.1 | `@0.1` | `@0.1` |
| v0.2 | `@0.2` (adds `handoff`) | `@0.2` (adds `handoff`) |
| v0.3 | `@0.3` (adds `continues`) | `@0.2` |

A v0.3 reader MUST accept Work Orders marked `@0.1`, `@0.2` and `@0.3`, and Work Reports marked `@0.1` and `@0.2`, and MUST reject any other version. A v0.3 writer marks new orders `@0.3` and new reports `@0.2`. Every earlier document is a valid v0.3 document once its version is accepted.

## 12. Planned for later versions

- Track record: an aggregate of approved reports per worker.
- Streaming progress events while `working`.

## 13. Related work

AWL overlaps with these efforts and is meant to work alongside them.

| Work | What it covers | How AWL relates |
|------|----------------|-----------------|
| Agent Contracts (Ye and Tan, 2026, [arXiv:2601.08815](https://arxiv.org/abs/2601.08815)) | A formal model of resource-bounded agents: budgets, deadlines, weighted success criteria, and sub-contracts whose budgets may not exceed the parent's. | Close in intent. AWL is a wire format (JSON documents, JSON Schemas, numbered checks) with evidence per criterion, separate manager and worker roles, and review. Its sub-order rules (§8) are the same conservation idea. |
| A2A tasks ([a2a-protocol.org](https://a2a-protocol.org)) | Task lifecycle and message transport between agents. | AWL describes the job and its proof; the A2A binding (§9) carries AWL documents inside A2A messages. |
| IETF [draft-reece-wimse-cross-org-delegation](https://datatracker.ietf.org/doc/draft-reece-wimse-cross-org-delegation/) | Requirements for authority that can only narrow at each delegation hop, verifiable across organizations. | Same principle as §8. Input for the planned Delegation Pass (§12). |
| KYA-OS / MCP-I ([@kya-os/mcp](https://www.npmjs.com/package/@kya-os/mcp)) | Agent identity, delegation credentials and verifiable audit for MCP servers. | Identifies the actor, not the job. A desk can use such credentials to meet §10's requirement to authenticate `actor`. |
