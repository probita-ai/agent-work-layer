# Changelog

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
