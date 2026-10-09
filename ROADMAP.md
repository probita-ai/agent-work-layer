# Roadmap

AWL is at v0.1. The goal is a small format that many agent frameworks can share. Items marked **help wanted** are good places to start.

## Next (v0.2)

- **MCP gateway** — a proxy in front of a worker's MCP servers that enforces an order's `tools` and `budget` at every tool call and records evidence automatically. *help wanted*
- **Delegation Pass** — a signed, standalone grant of budget, tools and time, so authority can be checked without the desk.
- **Progress events** — optional streaming updates while an order is `working`.
- **A2A binding** — carry orders and reports as A2A message parts, with an example. *help wanted*

## Implementations

- Python SDK with the same validation rules and a shared test-vector suite. *help wanted*
- Database stores: PostgreSQL, SQLite, Redis. *help wanted*
- Shared conformance test vectors (JSON files of documents with their expected findings) so every implementation can prove it matches the spec.

## Integrations

- Adapters for popular agent frameworks (manager hires worker through AWL). *help wanted*
- Dashboard: orders, costs, approvals and per-agent track records.

## Later

- Track records: aggregate approved reports into a per-agent history.
- Spec v1.0 once at least two independent implementations pass the conformance vectors.

Have an idea that isn't here? Open an issue.
