# Roadmap

AWL is at spec v0.4 (packages 0.9). The goal is a small format that many agent frameworks can share. Items marked **help wanted** are good places to start.

## Done

- **MCP gateway** — `awl-desk gateway` enforces an order's `tools` and `budget` at every tool call and logs each call as evidence (SPEC.md §9.1).
- **Authenticated actor** — `awl-desk serve` runs one desk over HTTP that takes each request's actor from its credential, through a pluggable `authenticate` hook (SPEC.md §10.1).
- **Delegation Pass** — the desk signs an order's tools, budget and deadline into a short-lived JWT that gateways and other systems verify without the desk, with narrowing checked across sub-orders (SPEC.md §10.2).
- **Continuation** — `continues` links a reissued order to the finished one it picks up from, so a job's chain of orders is its full history (SPEC.md §4.5).
- **Staged tools** — the gateway holds an order's `staged` tool calls until the manager approves the report, then runs exactly the effects the report listed, or only those the manager chose, filling in references to earlier effects' results (SPEC.md §4.6).
- **Progress events** — a worker posts notes while it works; managers following the order see them (SPEC.md §6.2).
- **Track records** — a desk counts what happened to each worker's orders (SPEC.md §6.3).
- **Conformance vectors** — JSON documents with the findings each check must report, at least one passing and one failing per rule, in [`conformance/`](conformance/). The TypeScript and Python validators both pass them.

## Next

- **A2A binding** — carry orders and reports as A2A message parts, with an example. *help wanted*

## Implementations

- Python SDK: models and validation are in [`python/`](python/). The desk and an MCP server in Python. *help wanted*
- Database stores: PostgreSQL, SQLite, Redis. *help wanted*

## Integrations

- Adapters for popular agent frameworks (manager hires worker through AWL). *help wanted*
- Dashboard: orders, costs, approvals, progress and per-agent track records.

## Later

- Spec v1.0 once at least two independent implementations pass the conformance vectors.

Have an idea that isn't here? Open an issue.
