# Changelog

## 0.8.1 — 2026-10-26

`agent-work-layer-mcp` alone (`agent-work-layer` stays at 0.8.0).

### Fixed

- Staged effects whose outcome can't be known are no longer recorded as failed. When `--commit` (`gateway.commit()`) sends an effect and gets no answer, because the connection dropped or timed out, or because an earlier commit died during the call, the effect's outcome is now `unknown`, with the reason. It may have happened, so it is still never run again. An effect is `error` only when the tool answered with an error. A later effect that refers to an unknown one is skipped, as before.
- Each effect call now carries the effect's ref and the order id in `_meta["awl/ref"]` and `_meta["awl/order"]`, so the receiving service can drop a call it has already acted on, and an unknown outcome can be checked against its records. SPEC.md §9.1 rule 10 says both.
- TypeScript: `Committed.outcome` and `CallRecord.outcome` add `"unknown"`, so an exhaustive `switch` over them may need a new case.
- Tests for each place a commit can stop: before the call is sent, after the receiver acts but before the answer arrives (with the gateway killed, and with the answer lost), and after the result is logged. A test receiver counts deliveries independently of the gateway's log.

## 0.8.0 — 2026-10-26

Both packages: `agent-work-layer` 0.8.0 and `agent-work-layer-mcp` 0.8.0. Spec v0.4; document formats are unchanged, but new documents are marked with the lowest version they need.

### Changed

- New documents are marked with the lowest version that defines every field they use (#39), so readers from 0.6 and earlier (`agent-work-layer` 0.6.x, Python 0.3.0, older `awl validate`) keep accepting documents that don't use the newer fields. An order with `staged` is still `awl/work-order@0.4`, one with `continues` `@0.3`, one with `handoff` `@0.2`, any other `@0.1`; a report with `effects` is `awl/work-report@0.3`, one with `handoff` `@0.2`, any other `@0.1`. `WorkDesk.create`, `WorkDesk.submitReport`, `awl new` and the Python models' default `spec` all do this; a `spec` set explicitly on a Python model is kept. Readers are unchanged. SPEC.md §11 now says a writer SHOULD use the lowest such version and MUST NOT go lower. Orders with `staged` still need a 0.7 gateway.
  - New `orderSpecFor` / `reportSpecFor` in `agent-work-layer` (and `agent-work-layer/validate`), `order_spec_for` / `report_spec_for` in Python. `ORDER_SPEC` and `REPORT_SPEC` remain the newest versions.
- `agent-work-layer-mcp` now depends on `agent-work-layer` ^0.8.0, so its desk writes the lowest version too, and on zod 4 (#37).

### Fixed

- `agent-work-layer-mcp` gateway (#34): a call to a tool that is not staged, whose arguments contain a reference to a staged call (`{"$ref": "<server>/<tool>#<n>"}` with that tool staged), is refused with the new `PENDING_REFERENCE` code instead of reaching the tool with the literal object. That result exists only after approval. Refused calls don't count against `tool_calls`; with `--observe` (`enforce: false`) the call goes through and is logged with that `violation`. A `$ref` that names no staged call, such as a JSON Schema's, is passed through as before. SPEC.md §4.6 and §9.1 rule 9 now say a gateway MUST refuse such a call. TypeScript: `RefusalCode` adds `"PENDING_REFERENCE"`, so an exhaustive `switch` over it may need a new case.

## python 0.5.0 — 2026-10-26

### Changed

- `WorkOrder` and `WorkReport` get the lowest version that has every field they use when `spec` isn't set (#39): an order is `@0.1`, `@0.2` with `handoff`, `@0.3` with `continues`, `@0.4` with `staged`; a report is `@0.1`, `@0.2` with `handoff`, `@0.3` with `effects`. A `spec` you set is kept. New `order_spec_for(order)` and `report_spec_for(report)`, the same as `agent-work-layer` 0.8.0's `orderSpecFor` and `reportSpecFor`.

## 0.7.1 — 2026-10-25

Both packages: `agent-work-layer` 0.7.1 and `agent-work-layer-mcp` 0.7.1. Documentation only; no code changes.

### Changed

- READMEs (#32): a staged-tools diagram (`docs/staged.svg`), the `report_progress` and `get_track_record` tools in the tool list, how to run a worker's tools through the gateway so staged writes are held, and progress notes under Lifecycle. The npm pages now show them.

## 0.7.0 — 2026-10-24

Both packages: `agent-work-layer` 0.7.0 and `agent-work-layer-mcp` 0.7.0. Spec v0.4: Work Orders are written as `awl/work-order@0.4` and Work Reports as `awl/work-report@0.3`. Every earlier version is still read.

### Added

- Staged tools (#30), SPEC.md §4.6: tools whose calls run only once the report is approved, so a manager reviews writes before they reach the world instead of after.
  - Work Order: optional `staged`, tool patterns covered by `tools`. Work Report: optional `effects`, each `{ref, tool, arguments, reversible?}`, in the order they should run.
  - Rules O5 (staged patterns are covered by `tools`), R14 (every effect's tool is staged), R15 (effect refs are `<tool>#<n>` and unique) and C5 (a sub-order may not allow a tool its parent stages, since its effects would run on its own approval). The TypeScript and Python validators both apply them, with conformance vectors in `conformance/vectors/O5.json`, `R14.json`, `R15.json` and `C5.json`.
  - Delegation Pass: a new `awl_staged` claim when the order stages tools; `verifyPass` checks C5 between a pass and its parent's.
  - `agent-work-layer-mcp` gateway: a call to a staged tool is counted and logged with its arguments but not forwarded, and the worker gets `pending:<server>/<tool>#<n>`. `awl_usage` (and `usage()`) list the waiting calls as `effects`. `gateway.commit()` and `awl-desk gateway --commit` run the approved report's effects in order. They run nothing unless the order is `approved` and every effect matches a staged call in the log (same ref, tool and arguments, made since the last rework), and they never run an effect twice. A rework drops earlier staged calls; a blocked report does not.
  - `create_work_order` takes `staged` and `submit_work_report` takes `effects`. Python: `Effect` model, `WorkOrder.staged`, `WorkReport.effects`.
- Effects that use an earlier effect's result, SPEC.md §4.6: a staged call's arguments may contain `{"$ref": "<earlier ref>", "pointer": "<JSON Pointer>"}`, which the gateway fills in from that effect's real result when it runs them. An effect whose reference can't be filled in (the earlier effect failed or was skipped, or has nothing at the pointer) is skipped and logged with the reason. Commit log lines now keep each result, so a restarted gateway can still fill in references.
  - Rule R16: a reference names an effect listed earlier in the report, with a valid JSON Pointer. Both validators, with `conformance/vectors/R16.json`.
  - `effectReferences(arguments)` in `agent-work-layer`; `effect_references` in the Python package.
- Approving only some effects, SPEC.md §4.6: `desk.review(id, manager, "approve", reason, { effects: [...] })` and `review_work_report`'s `effects` record the chosen refs on the `approve` event, and the gateway runs only those. The desk refuses refs the report doesn't list, and a choice that keeps an effect but drops one it uses. `effects: []` approves the work and runs nothing.
- Progress events, SPEC.md §6.2: `desk.progress(id, worker, note, percent?)` and the `report_progress` MCP tool record a `progress` event while an order is `working`. They change no state but advance `seq`, so `wait_for_update` wakes. `WorkEvent` gains optional `percent` and `effects`.
- Commits run each effect at most once, even across crashes and processes: the gateway logs a `running` line before each call and settles an effect left `running` as an error instead of retrying it, and a `<log>.commit-lock` file stops two commits for one order from running at once.
- Track records, SPEC.md §6.3: `desk.trackRecord(agent, { since? })` and the `get_track_record` MCP tool count what happened to the orders addressed to a worker: by final state, first-time approvals, reworks, reports by status, and spending against budget. New `TrackRecord` type.

### Changed

- `agent-work-layer-mcp` now depends on `agent-work-layer` ^0.7.0: the gateway uses `effectReferences`, and the desk tools use `desk.progress()`, `desk.trackRecord()` and `review()`'s `effects`, all new in 0.7.0.
- Upgrade `agent-work-layer-mcp` gateways along with the desk before issuing orders with `staged`. A gateway from 0.6.x or earlier doesn't know `staged` (or a pass's `awl_staged`) and forwards those calls straight away. Desks and validators from 0.6.x reject `@0.4` orders, so they fail closed.
- TypeScript: some types got wider. `WorkEvent.action` adds `"progress"`, `CallRecord.outcome` adds `"staged"`, `"skipped"` and `"running"`, `Usage` adds `effects`, and `Gateway` adds `commit()`. Exhaustive `switch` statements over these may need a new case.
- Staged calls count against `budget.tool_calls` when they are made, even if a rework drops them later.

## python 0.4.0 — 2026-10-24

### Added

- Spec v0.4: `WorkOrder.staged`, `WorkReport.effects` and the `Effect` model; orders `@0.4` and reports `@0.3` are written, and every earlier version is read.
- Rules O5, R14, R15, R16 and C5 in `validate_order`, `validate_report` and `validate_child_order`, and `effect_references(arguments)`. Same findings, paths and messages as `agent-work-layer` 0.7.0; the tests run the new conformance vectors.

## 0.6.0 — 2026-10-21

Both packages: `agent-work-layer` 0.6.0 and `agent-work-layer-mcp` 0.6.0. Spec v0.3, with two new checks (C4, R13); document formats are unchanged.

### Added

- Conformance vectors (#4) in `conformance/`: JSON documents with the findings a validator must report, at least one passing and one failing vector for every rule (O1–O4, R1–R12, C1–C3). `conformance/README.md` describes the format and how findings are matched. The TypeScript and Python test suites run every vector.
- Rule C4 (#25), SPEC.md §8: a parent's sub-orders together must stay within its budget. C1 checked each sub-order on its own, so two children could each take the parent's whole budget.
  - Counts `usd`, `tokens` and `tool_calls`, not `seconds`. Declined sub-orders don't count; cancelled, expired and approved ones count in full. Sums allow 10⁻⁹ of floating-point error.
  - `validateChildBudgets(child, parent, siblings)` in `agent-work-layer` and `agent-work-layer/validate`; `validate_child_budgets` in the Python package.
  - `WorkDesk.create` (and `create_work_order` over MCP) rejects a sub-order that breaks C4 with `VALIDATION_FAILED`.
  - `conformance/vectors/C4.json`, with a new `siblings` check.
- Rule R13 (#25), SPEC.md §7.2 and §8: a sub-order's budget comes out of what its parent may spend itself. An order's own cost, plus the budgets its sub-orders hold, must stay within its budget, so a tree of sub-orders never spends more than its root's budget, however deep it goes. Before, each level could spend its whole budget and hand the same amount down.
  - It's a `limit` finding, like R7: the report is kept and the order expires. Counts `usd`, `tokens` and `tool_calls`, as C4 does.
  - `validateOwnCost(report, order, subOrders)` and `heldBySubOrders(subOrders)`; `validate_own_cost` and `held_by_sub_orders` in the Python package. `WorkDesk.submitReport` applies it, and `desk.subOrders(id)` and `desk.held(id)` read what an order's sub-orders hold.
  - `agent-work-layer-mcp` gateway: in desk mode, an order's own tool calls stop at its `tool_calls` budget less what its sub-orders hold, and `awl_usage` shows that in `remaining`. Pass mode still enforces the pass's whole `tool_calls`, since a pass doesn't list sub-orders.
  - `conformance/vectors/R13.json`, with a new `own-cost` check.

### Changed

- A worker can split an order only after accepting it: `WorkDesk.create` refuses a sub-order whose parent is still `offered` with `INVALID_TRANSITION` (SPEC.md §8).
- `agent-work-layer-mcp` now depends on `agent-work-layer` ^0.6.0: the gateway uses `desk.held()`, which is new in 0.6.0.
- SPEC.md: a report's `cost` is the order's own spending; sub-orders report their own. §8 used to say a parent's cost SHOULD include its children's, which conflicted with §9.1 (the gateway logs only the order's own calls). A parent that already added its children's costs into its own will now get R13 findings.
- A desk may now refuse a sub-order it used to accept, when the parent's earlier sub-orders already hold its budget. Existing sub-orders are not re-checked, and no document becomes invalid.

## python 0.3.0 — 2026-10-21

### Added

- `validate_child_budgets(child, parent, siblings)` (C4) and `validate_own_cost(report, order, sub_orders)` (R13), with `held_by_sub_orders(sub_orders)`: a parent's sub-orders together stay within its budget, and a sub-order's budget comes out of what its parent may spend itself. Same findings, paths and messages as `agent-work-layer` 0.6.0.
- The tests run the shared conformance vectors in `conformance/`.

## 0.5.0 — 2026-10-17

Both packages: `agent-work-layer` 0.5.0 and `agent-work-layer-mcp` 0.5.0. Spec v0.3: Work Orders are now written as `awl/work-order@0.3`; Work Reports stay `@0.2`.

### Added

- `continues` on the Work Order (#19), SPEC.md §4.5: the id of the finished order a new one picks up from, so a chain of reissued orders is the full history of one job.
  - It is not `parent_id`: no narrowing applies, and the new order may have a different worker, budget and tools.
  - The desk rejects a `continues` that names an unknown order (`NOT_FOUND`), one that is not `approved`, `declined`, `expired` or `cancelled` (`INVALID_TRANSITION`; cancel a failed or blocked order first), another manager's order (`FORBIDDEN`), or one that is already continued (`ALREADY_EXISTS`).
  - `desk.list({ continues })` and `list_work_orders` follow the chain; summaries include `continues`. `create_work_order` takes it.
- Delegation Pass (#17), SPEC.md §10.2: an order's authority as a signed JWT (`typ` `awl-pass+jwt`, ES256 or EdDSA) with `iss`, `sub`, `awl_order`, `awl_parent`, `awl_tools`, `awl_budget`, `awl_deadline`, `awl_attempt`, `iat`, `exp` and `jti`.
  - `agent-work-layer`: `signPass(order, key, options)` and `verifyPass(token, keys, options)`, with WebCrypto only, so they are also in `agent-work-layer/validate`. `verifyPass` checks signature, type, lifetime (allowing 60 seconds of clock skew on `iat`) and, when asked, issuer, worker and order; with `parent` it rejects a pass that is wider than its parent's (C1–C3) or names another parent. Keys are JWKs or WebCrypto keys from the caller. `decodePass` reads claims without checking them.
  - `WorkDesk({ passes: { key, issuer } })` signs a pass (15 minutes, never past the deadline) each time an order enters `working`, keeps it on `record.pass`, and drops it when the order leaves `working`. `desk.issuePass(id, worker)` renews it.
  - `agent-work-layer-mcp`: `awl-desk serve --pass-key <file> --issuer <iss>`. `start_work_order` and `get_work_order` return the pass to the order's worker only, and `renew_work_pass` renews it.
  - Gateway: `--pass-keys <file>` (`passKeys` in code) enforces a pass instead of reading the desk's store. Each call needs a valid pass for the order and worker, from `--pass-file`, `AWL_PASS` or the call's `_meta["awl/pass"]`, and is refused with `PASS_INVALID` otherwise. Tools and `tool_calls` come from the pass.
  - Gateway call records and result `_meta` carry the authority each call ran under: `order_id`, `attempt` and the pass's `jti`.
- Authenticated actor (#16): `awl-desk serve --keys <file>` runs one shared desk over MCP Streamable HTTP. Every request needs `Authorization: Bearer <key>`; the key decides the actor, and an `actor` argument naming anyone else gets `FORBIDDEN`. Requests without a valid key get 401. In code: `createDeskHttpHandler({ desk, authenticate })`, where `authenticate(request)` returns the agent ref or throws an `AuthError` (401, or 403). Two example authenticators: `apiKeyAuth` (a static key → agent map) and `bearerAuth` (OAuth 2.1 access tokens: checks `exp` and `aud`, maps `sub` to an agent ref, advertises `resource_metadata` in 401 challenges). The handler can serve Protected Resource Metadata (RFC 9728). Stdio mode is unchanged.
- SPEC.md §10.1: what binding `actor` to an authenticated identity means, and how an MCP desk does it.

### Changed

- `agent-work-layer` writes Work Orders as `awl/work-order@0.3` and reads `@0.1`–`@0.3`. Readers on 0.4 or earlier reject `@0.3` orders; upgrade readers first. Reports are unchanged.
- `agent-work-layer-mcp` now depends on `agent-work-layer` ^0.5.0.

### Fixed

- `agent-work-layer`: `FileStore` runs writes to one order one at a time within a process, so concurrent transitions get `CONFLICT` instead of overwriting each other's state and events, and temporary files get unique names. Across processes the check stays best-effort; use `SqliteStore` for an atomic one.

## python 0.2.0 — 2026-10-17

### Added

- Spec v0.3: `WorkOrder.continues`, and the validator reads Work Orders marked `@0.1`–`@0.3`. New orders are written as `@0.3`.

## 0.4.1 — 2026-10-14

`agent-work-layer-mcp` alone (`agent-work-layer` stays at 0.4.0).

### Added

- Every desk tool and the gateway's `awl_usage` tool declare `readOnlyHint`, `destructiveHint`, `idempotentHint` and `openWorldHint`, so hosts can warn before a tool runs and directories that require the hints accept the server.

## python 0.1.0 — 2026-10-14

First release of the Python package `agent-work-layer` on PyPI (`pip install agent-work-layer`).

### Added

- Pydantic models for Work Orders and Work Reports, and `validate_order`, `validate_report` and `validate_child_order` with the same rule ids, kinds and paths as the TypeScript SDK (#5).

## 0.4.0 — 2026-10-11

Both packages: `agent-work-layer` 0.4.0 and `agent-work-layer-mcp` 0.4.0.

### Added

- MCP gateway (#6): `awl-desk gateway --order <id> --config <file>` sits between a worker and its real MCP servers and enforces the order at every tool call. It lists only the tools the order allows, refuses the rest, refuses calls once `tool_calls` or `seconds` is spent or while the order is not `working`, and logs each call to `<store>/calls/<id>.jsonl` with an evidence ref `<server>/<tool>#<n>`. Its `awl_usage` tool returns `tools_used` and `cost` for the report. In code: `createGateway` from `agent-work-layer-mcp`. Enforcement is optional: `--observe` (`enforce: false`) refuses nothing and logs what the order would have refused, for setups whose own gateway already controls access.
- SPEC.md §9.1: what an MCP gateway must enforce.

### Changed

- `agent-work-layer-mcp` now depends on `agent-work-layer` ^0.4.0.

## 0.3.0 — 2026-10-10

Both packages: `agent-work-layer` 0.3.0 and `agent-work-layer-mcp` 0.3.0.

### Added

- `SqliteStore`: a `DeskStore` backed by SQLite through Node's built-in `node:sqlite` (Node 22.13+), with an atomic CONFLICT check (#1).

### Changed

- `agent-work-layer-mcp` now depends on `agent-work-layer` ^0.3.0.

## 0.2.1 — 2026-10-09

Documentation only; `agent-work-layer` alone (`agent-work-layer-mcp` stays at 0.2.0).

- README: diagram of a handoff moving a job from one worker to the next.

## 0.2.0 — 2026-10-09

### Breaking

- The MCP server moved to a new package, `agent-work-layer-mcp`, so installing `agent-work-layer` no longer downloads the MCP SDK and zod (7 packages instead of 97).
  - `npx -y agent-work-layer desk` → `npx -y agent-work-layer-mcp` (same flags and environment variables).
  - `import { createDeskServer } from "agent-work-layer/mcp"` → `from "agent-work-layer-mcp"`.
  - `awl desk` now exits with code 2 and prints the new command.

### Added

- Spec v0.2: optional `handoff` on Work Orders and Work Reports: decisions made, approaches tried, open questions and next step, so a job can move to another worker without starting over (SPEC.md §4.4). The MCP tools accept it too.
- `agent-work-layer/validate`: types, schemas and every check, with no Node built-ins. Runs in browsers, Deno and Bun.
- `ORDER_SPECS` and `REPORT_SPECS`: every spec version this package reads.
- `awl new order` and `awl new report` print starter documents that validate together as printed (#7, thanks @brunnojob).
- SPEC.md §13, Related work: Agent Contracts, A2A tasks, the IETF WIMSE cross-org delegation draft and KYA-OS / MCP-I.

### Changed

- The repository is now an npm workspace: the core is in `packages/core`, the MCP server in `packages/mcp`. Published package contents are unchanged by this.

- The desk writes `awl/work-order@0.2` and `awl/work-report@0.2`. Documents marked `@0.1` are still accepted, so stored orders keep working.
- Schemas and the version number are built into the code (`packages/core/src/generated.ts`) instead of read from disk at startup.

## 0.1.1 — 2026-10-09

- Package metadata now links to the GitHub repository, homepage and issue tracker.
- README: diagrams, "How it works" section and contributing links.

## 0.1.0 — 2026-10-09

First release.

- Work Order and Work Report formats (spec v0.1) with JSON Schemas.
- Validation of every rule in the spec: O1–O4, R1–R12, C1–C3.
- `WorkDesk` lifecycle engine with permissions, deadline and budget expiry, sub-orders, events and live waiting.
- `MemoryStore` and `FileStore`, plus the `DeskStore` interface for custom storage.
- MCP server (`agent-work-layer/mcp`) with 11 tools and identity-locked sessions.
- `awl` CLI: `validate`, `schema`, `desk`.
