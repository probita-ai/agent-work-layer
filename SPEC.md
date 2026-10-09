# Agent Work Layer (AWL) — Specification v0.1 (draft)

Status: draft · Date: 2026-10-09

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
| `spec`         | yes | `"awl/work-order@0.1"` | Format and version. |
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
| `output_schema`| no  | JSON Schema         | Shape that `result.output` MUST match when done. |
| `parent_id`    | no  | string              | Set when this order was split from a larger one (§8). |
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

## 5. Work Report

| Field         | Req | Type                    | Meaning |
|---------------|-----|-------------------------|---------|
| `spec`        | yes | `"awl/work-report@0.1"` | Format and version. |
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

A desk MUST reject a child order that breaks C1–C3. The parent's reported cost SHOULD include its children's costs.

## 9. Bindings

How AWL documents travel. A desk MAY support several.

- **Files**: `<id>.order.json` and `<id>.report.json` side by side. Good for tests and audit archives.
- **MCP**: a desk exposed as an MCP server with tools such as `create_work_order`, `submit_work_report` and `review_work_report`. The reference implementation in this repo works this way.
- **A2A**: the document travels as a data part of an A2A message with the AWL media type. The A2A task id SHOULD be stored in `metadata.a2a_task_id`.

## 10. Security

- A desk MUST bind `actor` to an authenticated identity in production. The reference desk trusts the `actor` argument and is for development only.
- A worker's MCP gateway SHOULD enforce `tools` and `budget` at call time, not only after the report arrives.
- Evidence `ref` values can point at sensitive data. Desks SHOULD apply the same access rules to evidence as to the data it points at.

## 11. Versioning

`spec` carries the version. Minor versions (0.x) may add optional fields only. Readers MUST reject a major version they do not know.

## 12. Planned for later versions

- Delegation Pass: a signed, standalone grant of budget, tools and time.
- Track record: an aggregate of approved reports per worker.
- Streaming progress events while `working`.
