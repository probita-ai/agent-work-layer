# Agent Work Layer (AWL) — Specification v0.4 (draft)

Status: draft · Date: 2026-10-24 · Changes from v0.3: staged tools, whose calls run only once the report is approved: `staged` in the Work Order, `effects` in the Work Report (§4.6), and how the gateway holds and runs them (§9.1); effects that use earlier effects' results, and approving only some effects (§4.6); progress events (§6.2); track records (§6.3); checks O5, R14, R15, R16 and C5.

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
| `spec`         | yes | `"awl/work-order@0.4"` | Format and version: `@0.1` to `@0.4`, the lowest that defines every field used (§11). |
| `id`           | yes | string              | Unique job id, set by the desk or manager. |
| `created_at`   | yes | timestamp           | When the order was issued. |
| `from`         | yes | agent ref           | The manager. |
| `to`           | yes | agent ref           | The worker. |
| `goal`         | yes | string              | What to achieve, in plain language. |
| `criteria`     | yes | array of Criterion (≥1) | How "done" will be judged. |
| `budget`       | yes | Budget              | Upper limits for this job. |
| `deadline`     | yes | timestamp           | Latest allowed finish. |
| `tools`        | yes | array of tool pattern | Tools the worker may use (§4.3). May be empty. |
| `staged`       | no  | array of tool pattern | Tools whose calls run only once the report is approved (§4.6). |
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

### 4.6 Staged tools

A manager reviews a report after the work is done, and by then the worker's tool calls have had their effects: rejecting the report does not unsend an email or undo a refund. `staged` lists the tools whose calls wait for the review instead. It uses the patterns of `tools` (§4.3), and every staged pattern MUST be covered by `tools` (O5). The manager names staged tools explicitly; MCP's `readOnlyHint` and `destructiveHint` are only hints from the server, so they do not decide what is staged.

In a staged order the gateway (§9.1) does not forward a call to a staged tool. It counts the call as usual, logs it with its arguments, and returns the placeholder `pending:<server>/<tool>#<n>` instead of a result. Calls to other tools run normally, so the worker can still read and research; only its staged calls wait.

The worker lists the staged calls it wants run in the report's `effects`, in the order they should run:

```json
"effects": [
  { "ref": "gmail/send#4", "tool": "gmail/send", "arguments": { "to": "cfo@example.com", "subject": "Risk summary" }, "reversible": false }
]
```

| Field        | Type    | Meaning |
|--------------|---------|---------|
| `ref`        | string  | The call's name, `<server>/<tool>#<n>` (§9.1 rule 5), without the `pending:` prefix. It can also be the `ref` of `tool_call` evidence. |
| `tool`       | string  | The tool, `<server>/<tool>`. It MUST be staged by the order (R14). |
| `arguments`  | object  | The call's arguments, exactly as the worker made it. They may refer to earlier effects' results (below). |
| `reversible` | boolean | Optional. The worker's claim that the effect can be undone. Not checked. |

On review:

- **approve** lets the effects run. The gateway runs them in the order listed and records each result (§9.1). The manager MAY approve only some: the approval then names the refs of the effects to run, and the desk records them in the `approve` event's `effects` (§6.1). The others are dropped. A desk MUST refuse an approval that names an effect the report does not list, or that keeps an effect but drops one whose result it uses. An approval that names no effects approves the work and runs none of them.
- **rework** drops them. Nothing ran, so nothing has to be undone. If the worker still wants them, it stages them again in the next attempt.

A staged call that the report does not list never runs. A `blocked` report does not drop anything: the worker can list calls staged before it was blocked.

Effects run once the order is `approved`; there is no separate state for it. Each runs once, with the arguments it was staged with, and nothing checks that the world is still as it was when the report was written: a failed effect is recorded, not retried, and the effects after it still run.

**Using an earlier effect's result.** A worker gets only a placeholder, so it cannot read, for example, the number of an issue that has not been created yet. Instead, a staged call can put a **reference** anywhere in its arguments: an object whose only members are `$ref`, the ref of an earlier staged call, and optionally `pointer`, a JSON Pointer (RFC 6901) into that call's tool result. Without `pointer`, the reference stands for the whole result.

```json
{ "ref": "github/add_comment#4", "tool": "github/add_comment",
  "arguments": { "issue_number": { "$ref": "github/create_issue#3", "pointer": "/structuredContent/number" }, "body": "Risk summary attached" } }
```

The worker makes the staged call with the reference in it, so the gateway logs it as written and the report lists it the same way. A reference MUST name an effect listed earlier in the report (R16). When the effects run, the gateway replaces each reference with the value at `pointer` in the named effect's result, an MCP `CallToolResult` (for example `/structuredContent/number` or `/content/0/text`). If that effect did not succeed (it failed, or was itself skipped) or its result has no value at `pointer`, the effect using it is **skipped**: it does not run, and the gateway records why. References are filled in only when staged effects run. A call to a tool that is not staged gets its arguments as they are.

A sub-order may not allow a tool its parent stages (C5). Its effects would run when the parent's worker approves its report, before the parent's manager has reviewed anything.

## 5. Work Report

| Field         | Req | Type                    | Meaning |
|---------------|-----|-------------------------|---------|
| `spec`        | yes | `"awl/work-report@0.3"` | Format and version: `@0.1` to `@0.3`, the lowest that defines every field used (§11). |
| `order_id`    | yes | string                  | The order this answers. |
| `from`        | yes | agent ref               | The worker. |
| `status`      | yes | `done` \| `blocked` \| `failed` | Outcome of this attempt. |
| `result`      | yes | `{summary, output?, artifacts?}` | What was produced. `artifacts` is an array of `{uri, media_type?, note?}`. |
| `evidence`    | yes | array of Evidence       | Proof, linked to criteria. |
| `cost`        | yes | Cost                    | What this order's worker actually spent itself. Sub-orders report their own (§8). |
| `finished_at` | yes | timestamp               | When this attempt ended. |
| `tools_used`  | yes | array of tool names     | Every tool actually called (exact names, no wildcards). |
| `effects`     | no  | array of Effect (§4.6)  | Staged calls to run if the report is approved, in order. |
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
| working     | progress        | worker                | working (no change, §6.2) |

Rules:

1. A desk MUST expire an order when `deadline` passes or when reported cost exceeds any budget unit, counting what its sub-orders hold (R13).
2. A `failed` report goes to `submitted`; the manager decides whether to rework or cancel.
3. Every transition MUST be recorded as an event (§6.1). The event log is the audit trail.
4. Approving a report lets its staged effects run (§4.6), or only those the approval names; rework drops them.

### 6.1 Event

```json
{ "seq": 4, "at": "2026-10-09T16:12:00Z", "actor": "agent:researcher",
  "action": "report", "from": "working", "to": "submitted", "note": "attempt 1" }
```

`seq` starts at 1 and increases by 1 per order. Consumers MAY use `seq` to wait for changes.

Two optional fields carry extra detail: `percent` on a `progress` event (§6.2), and `effects` on an `approve` event, the refs of the effects approved to run when the manager chose some (§4.6). An `approve` event without `effects` approves all of them.

### 6.2 Progress

While an order is `working`, its worker MAY record progress: an event with `action` `progress`, `from` and `to` both `working`, a non-empty `note` saying what has been done, and optionally `percent`, a number from 0 to 100. It changes no state and is not a transition, but it takes the next `seq`, so a manager waiting for changes sees it.

```json
{ "seq": 5, "at": "2026-10-09T16:20:00Z", "actor": "agent:researcher",
  "action": "progress", "from": "working", "to": "working", "note": "Risk section read; checking the debt note", "percent": 60 }
```

A desk MUST refuse progress from anyone but the order's worker, and on an order that is not `working`. Progress is the worker's own account, like a handoff: it is not checked, and it is not evidence. A desk MAY limit how often a worker records progress.

### 6.3 Track record

A desk MAY report a worker's **track record**: what happened to the orders it holds that are addressed to that worker (`to`), optionally only those created at or after a time `since`.

| Field                 | Meaning |
|-----------------------|---------|
| `agent`               | The worker. |
| `orders`              | Orders counted. |
| `active`              | Those not in a terminal state. |
| `approved`, `declined`, `expired`, `cancelled` | Those in each terminal state. |
| `approved_first_time` | Approved orders with no `rework` event. |
| `reworks`             | `rework` events across the orders. |
| `reports`             | Reports submitted, as `{done, blocked, failed}` counts. |
| `spent`               | For each unit, the `cost` of each order's latest report, added up over the orders that have a report. |
| `budget`              | For each unit, the `budget` of those same orders, added up. |
| `since`               | The `since` given, if any. |

Units in `spent` and `budget` appear only when at least one order sets them, so the two may not cover the same units. A track record is the desk's own count of its own records. It is not signed, and it says nothing about work done on other desks.

## 7. Checks

A desk MUST run these checks. **Invalid** findings reject the document. **Limit** findings are accepted and recorded, and move the order to `expired`.

### 7.1 Order checks

| Id | Kind    | Rule |
|----|---------|------|
| O1 | invalid | Matches the Work Order schema. |
| O2 | invalid | Criterion ids are unique. |
| O3 | invalid | `deadline` is later than `created_at`. |
| O4 | invalid | `output_schema`, if present, is a valid JSON Schema. |
| O5 | invalid | Every `staged` pattern is covered by the order's `tools`. |

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
| R13 | limit   | For `usd`, `tokens` and `tool_calls`, `cost` plus the budgets the order's sub-orders hold (§8) ≤ `budget`. |
| R14 | invalid | Every effect's `tool` matches a pattern in the order's `staged`. |
| R15 | invalid | Each effect's `ref` is `<tool>#<n>` for its own `tool`, and no two effects share a `ref`. |
| R16 | invalid | Every reference in an effect's `arguments` (§4.6) names an effect listed before it, and its `pointer`, if present, is a JSON Pointer. |

## 8. Sub-orders (delegation)

A worker MAY split its job by issuing new orders with `parent_id` set, but only after accepting the parent order. Authority only shrinks:

| Id | Rule |
|----|------|
| C1 | The child's budget sets every unit the parent sets, each ≤ the parent's value. |
| C2 | Every child tool pattern is covered by the parent's patterns. |
| C3 | The child's deadline ≤ the parent's deadline. |
| C4 | For `usd`, `tokens` and `tool_calls`, the budgets of the parent's sub-orders, this one included, add up to at most the parent's value. |
| C5 | No child tool pattern allows a tool the parent stages (§4.6). |

A desk MUST reject a child order that breaks C1–C5.

C1–C3 compare a child with its parent; C4 compares it with its siblings too, so that the sub-orders together hold no more budget than the parent. C4 counts every sub-order with the same `parent_id` except `declined` ones, which did no work. A cancelled, expired or approved sub-order counts in full: it may have spent its whole budget. `seconds` is not added up, because sub-orders run side by side; C3 limits their time. Sums are compared with a tolerance of 10⁻⁹, so that, for example, sub-orders of `0.1` and `0.2` fit a budget of `0.3`.

C4 needs the desk's list of sub-orders, so it is checked when the desk creates a child, not by a verifier holding only passes (§10.2).

C5 keeps staged calls under the review of the order that staged them. A child's effects would run when its own report is approved, by the parent's worker, so the parent's manager would never see them first. Two patterns overlap when some tool matches both: `*` overlaps everything, `s/*` overlaps every pattern on server `s`, and `s/t` overlaps itself, `s/*` and `*`.

A sub-order's budget also comes out of what its parent may spend itself: an order's own `cost`, plus the budgets its sub-orders hold (counted as for C4), stays within its budget (R13, and gateway rule 2 in §9.1). Each order reports only its own spending, and the desk adds up the sub-orders from its own records. So every level spends only what it kept, and a whole tree of sub-orders never spends more than the budget at its root, however deep it goes.

## 9. Bindings

How AWL documents travel. A desk MAY support several.

- **Files**: `<id>.order.json` and `<id>.report.json` side by side. Good for tests and audit archives.
- **MCP**: a desk exposed as an MCP server with tools such as `create_work_order`, `submit_work_report` and `review_work_report`. The reference implementation is the `agent-work-layer-mcp` package in this repo.
- **A2A**: the document travels as a data part of an A2A message with the AWL media type. The A2A task id SHOULD be stored in `metadata.a2a_task_id`.

### 9.1 MCP gateway

A gateway is an MCP server that sits between one worker and its real MCP servers, for one order. It enforces the order while the worker works, instead of only checking the report afterwards (§10).

1. It MUST refuse a call to a tool that no pattern in `tools` allows (§4.3), and SHOULD NOT list such tools.
2. It MUST refuse calls once `budget.tool_calls` calls, less the tool calls the order's sub-orders hold (§8), have reached a tool, and once `budget.seconds` have passed since the order was first started. It SHOULD stop a running call when the seconds run out.
3. It MUST refuse calls while the order is not `working`. It MAY start an `accepted` order on its first call.
4. Refused calls do not reach the tool and do not count against the budget. A call that reached the tool counts even if the tool returned an error.
5. It numbers the calls that reach a tool 1, 2, 3… per order, across reworks, and names each `<server>/<tool>#<n>`. That name is the `ref` of `tool_call` evidence (§5.1), and the gateway SHOULD return it with the call's result.
6. It SHOULD keep a log of every call, refused ones included, that survives a restart, so restarting the gateway does not reset the budget.
7. The report's `tools_used`, its `cost.tool_calls` and `cost.seconds`, and its `effects` SHOULD be taken from the gateway's log.
8. Each logged call SHOULD record the authority it ran under: the order id, the report attempt in progress (`reports` + 1) and, when there is one, the `jti` of the Delegation Pass (§10.2). A resumed or reissued job can then tell which grant applied to every earlier call.
9. It MUST NOT forward a call to a tool the order stages (§4.6). It counts and names the call as rules 4 and 5 say, logs it with its arguments, and returns `pending:<server>/<tool>#<n>` as the result. This applies in observe mode too.
10. It runs staged effects only once the order is `approved`, and only those in the approved report's `effects` that the approval chose (all of them when the `approve` event has no `effects`). Before it runs any, it MUST check that each effect to run matches a staged call in its log with the same `ref`, `tool` and arguments (compared as JSON with object keys in a fixed order), made after the order's last rework (by rule 8's attempt). If any does not match, it runs none. It runs each effect at most once, in the order listed, filling in references to earlier effects' results (§4.6), and logs each outcome under the effect's `ref`: the result when it ran, or why it was skipped. It SHOULD log each result, so that references can still be filled in after a restart. To keep "at most once" across crashes, it SHOULD log that it is about to run an effect before calling the tool, and treat an effect started but never finished as failed rather than run it again. It SHOULD also keep two commits for the same order from running at once. Running an effect does not count against `budget.tool_calls` again: it was counted when it was staged.

A gateway MAY work from **Delegation Passes** instead of the desk's order state (§10.2). It then requires a valid pass for its order and worker on every call, and enforces the pass's `awl_tools` and `awl_budget.tool_calls` in place of rules 1–3, and stages the pass's `awl_staged` tools. A pass does not say when the order was started, so `budget.seconds` is left to the report checks. A pass is not issued once the order has left `working`, so rule 10 needs the desk's order state.

A gateway MAY instead run in **observe** mode, for deployments whose own gateway or policy engine already controls access. It then applies rules 4–7 but not 1–3: it refuses nothing, and it SHOULD mark each logged call that rules 1–3 would have refused. Calls over budget or to tools the order does not allow still show up in the report, where checks R5 and R7 catch them.

A pass does not say what sub-orders the order has, so a pass-mode gateway enforces the whole `awl_budget.tool_calls`; the desk applies R13 when the report arrives.

The gateway cannot measure `usd` or `tokens`; those are checked only when the report arrives (R7, R13), after they are spent. The reference implementation is `awl-desk gateway` in `agent-work-layer-mcp`.

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
| `awl_staged` | The order's `staged`, when it stages any |
| `awl_budget` | The order's whole `budget`, not what is left of it |
| `awl_deadline` | The order's `deadline` |
| `awl_attempt` | The report attempt the pass was issued for: `reports` + 1 |
| `iat`, `exp` | Issue and expiry time, in seconds since the epoch |
| `jti` | A unique id for this pass |

**Issuing.** A desk that issues passes signs one for the worker each time the order enters `working`, and on request while it stays `working`. A pass's `exp` MUST NOT be later than `awl_deadline`, and SHOULD be short (the reference desk uses 15 minutes); the worker renews it while it works. Short lifetimes are the only revocation: when an order is cancelled, expires or leaves `working`, the desk stops issuing passes for it. The desk SHOULD give a pass only to the authenticated worker (§10.1); a pass is only as trustworthy as the identity it was issued to.

**Verifying.** A verifier MUST reject a pass whose signature does not verify with one of the issuer's keys, whose `typ` or `alg` is not one of the above, that has expired (at `exp` or `awl_deadline`, whichever is sooner), or whose `iat` is in the future by more than an allowance for clock skew (the reference verifier allows 60 seconds). It SHOULD check `iss`, and that `sub` and `awl_order` are the worker and order it expects. A tool call is allowed when a pattern in `awl_tools` allows it (§4.3).

**Narrowing.** A sub-order's pass names its parent in `awl_parent`. A verifier holding a pass and its parent's pass checks C1–C3 and C5 (§8) between their `awl_budget`, `awl_tools`, `awl_deadline` and the parent's `awl_staged`, and MUST reject a pass wider than its parent's or naming a different parent. A chain is verified from the top down.

Key distribution, rotation and JWKS hosting are out of scope. The reference implementation is `signPass` and `verifyPass` in `agent-work-layer`, which use WebCrypto only.

## 11. Versioning

`spec` carries the version. Minor versions (0.x) may add optional fields only. Readers MUST reject a major version they do not know.

Each document type has its own version. v0.4 adds `staged` to the Work Order and `effects` to the Work Report:

| Spec | Work Order | Work Report |
|---|---|---|
| v0.1 | `@0.1` | `@0.1` |
| v0.2 | `@0.2` (adds `handoff`) | `@0.2` (adds `handoff`) |
| v0.3 | `@0.3` (adds `continues`) | `@0.2` |
| v0.4 | `@0.4` (adds `staged`) | `@0.3` (adds `effects`) |

A v0.4 reader MUST accept Work Orders marked `@0.1` to `@0.4`, and Work Reports marked `@0.1` to `@0.3`, and MUST reject any other version. A writer SHOULD mark each new document with the lowest version that defines every field it uses, and MUST NOT mark it lower than that: an order with `staged` is `@0.4`, one with `continues` (and no `staged`) `@0.3`, one with `handoff` only `@0.2`, and any other `@0.1`; a report with `effects` is `@0.3`, one with `handoff` only `@0.2`, and any other `@0.1`. Readers that predate a field then keep accepting documents that don't use it. Every earlier document is a valid v0.4 document once its version is accepted.

## 12. Planned for later versions

Nothing is planned yet. Propose changes with a spec proposal issue.

## 13. Related work

AWL overlaps with these efforts and is meant to work alongside them.

| Work | What it covers | How AWL relates |
|------|----------------|-----------------|
| Agent Contracts (Ye and Tan, 2026, [arXiv:2601.08815](https://arxiv.org/abs/2601.08815)) | A formal model of resource-bounded agents: budgets, deadlines, weighted success criteria, and sub-contracts whose budgets may not exceed the parent's. | Close in intent. AWL is a wire format (JSON documents, JSON Schemas, numbered checks) with evidence per criterion, separate manager and worker roles, and review. Its sub-order rules (§8) are the same conservation idea. |
| A2A tasks ([a2a-protocol.org](https://a2a-protocol.org)) | Task lifecycle and message transport between agents. | AWL describes the job and its proof; the A2A binding (§9) carries AWL documents inside A2A messages. |
| IETF [draft-reece-wimse-cross-org-delegation](https://datatracker.ietf.org/doc/draft-reece-wimse-cross-org-delegation/) | Requirements for authority that can only narrow at each delegation hop, verifiable across organizations. | Same principle as §8 and the Delegation Pass (§10.2). |
| KYA-OS / MCP-I ([@kya-os/mcp](https://www.npmjs.com/package/@kya-os/mcp)) | Agent identity, delegation credentials and verifiable audit for MCP servers. | Identifies the actor, not the job. A desk can use such credentials to meet §10's requirement to authenticate `actor`. |
