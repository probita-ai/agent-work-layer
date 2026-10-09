# Changelog

## Unreleased

- `awl new order` and `awl new report` print valid starter documents for editing.

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
