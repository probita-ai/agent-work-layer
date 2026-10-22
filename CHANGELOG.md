# Changelog

## Unreleased

### Added

- Conformance vectors (#4) in `conformance/`: JSON documents with the findings a validator must report, at least one passing and one failing vector for every rule (O1–O4, R1–R12, C1–C3). `conformance/README.md` describes the format and how findings are matched. The TypeScript and Python test suites run every vector.
- Rule C4 (#25), SPEC.md §8: a parent's sub-orders together must stay within its budget. C1 checked each sub-order on its own, so two children could each take the parent's whole budget.
  - Counts `usd`, `tokens` and `tool_calls`, not `seconds`. Declined sub-orders don't count; cancelled, expired and approved ones count in full. Sums allow 10⁻⁹ of floating-point error.
  - `validateChildBudgets(child, parent, siblings)` in `agent-work-layer` and `agent-work-layer/validate`; `validate_child_budgets` in the Python package.
  - `WorkDesk.create` (and `create_work_order` over MCP) rejects a sub-order that breaks C4 with `VALIDATION_FAILED`.
  - `conformance/vectors/C4.json`, with a new `siblings` check.

### Changed

- A desk may now refuse a sub-order it used to accept, when the parent's earlier sub-orders already hold its budget. Existing sub-orders are not re-checked, and no document becomes invalid.

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
