# agent-work-layer (Python)

**Work Orders and Work Reports for AI agents, in Python.** Pydantic models for both documents and every validation rule from the [Agent Work Layer spec](https://github.com/probita-ai/agent-work-layer/blob/main/SPEC.md), with the same rule ids, kinds and paths as the TypeScript SDK.

A Work Order says what a job is and what it may use: goal, criteria, budget, deadline and allowed tools. A Work Report says what was done and proves it: evidence for each criterion, cost and tools used. The checks tell you whether a report holds up against its order.

```sh
pip install agent-work-layer
```

Python 3.9 or newer. Depends on `jsonschema` and `pydantic` (v2).

## Validate documents

Documents are plain JSON (dicts). Each `validate_*` function returns a list of findings; an empty list means valid.

```python
import json
from agent_work_layer import validate_order, validate_report, has_invalid

# examples/ in the repository
order = json.load(open("examples/risk-summary.order.json"))
report = json.load(open("examples/bad.report.json"))

assert validate_order(order) == []

findings = validate_report(report, order)
for f in findings:
    print(f.rule, f.kind, f.path, f.message)
# R4 invalid /evidence no evidence for criterion "c2"
# R5 invalid /tools_used/1 tool "web/browse" is not allowed by this order
# R7 limit /cost/usd spent 3.1 usd, budget is 2
# R6 invalid /cost cost must report "tool_calls" because the budget sets it
# R8 limit /finished_at finished after the deadline
# R11 invalid /result/output 'total_debt' is a required property
# R11 invalid /result/output/risk_factors ['Refinancing'] is too short

if has_invalid(findings):
    ...  # reject the report and send the findings back to the worker
```

- **`invalid`** findings reject the document.
- **`limit`** findings (R7 over budget, R8 past the deadline) are accepted but recorded, and move the order to `expired`.

| Function | Rules |
|---|---|
| `validate_order(order)` | O1–O5 |
| `validate_report(report, order)` | R1–R12, R14–R16 |
| `validate_child_order(child, parent)` | C1–C3 and C5: a sub-order may only narrow its parent's budget, tools and deadline, and may not allow a tool its parent stages |
| `validate_own_cost(report, order, sub_orders)` | R13: an order's own cost, plus what its sub-orders hold, stays within its budget |
| `held_by_sub_orders(sub_orders)` | The budget an order's sub-orders hold |
| `validate_child_budgets(child, parent, siblings)` | C4: a parent's sub-orders together stay within its budget. `siblings` are `{"order": ..., "state": ...}` |
| `is_work_order(value)`, `is_work_report(value)` | Structure only (O1, R1) |
| `tool_allowed(tool, patterns)`, `pattern_covered(child, parents)` | Tool pattern matching (`server/tool`, `server/*`, `*`) |
| `order_spec_for(order)`, `report_spec_for(report)` | The lowest version that has every field a document uses; the models' default `spec` |
| `effect_references(arguments)` | References to earlier effects' results in an effect's arguments, each `{"ref", "pointer", "path"}` |

The JSON Schemas are available as `work_order_schema` and `work_report_schema`.

## Build documents with models

```python
from datetime import datetime, timedelta, timezone
from agent_work_layer import Criterion, WorkOrder, validate_order

now = datetime.now(timezone.utc)
order = WorkOrder(
    id="wo_42",
    created_at=now,
    from_="agent:manager",          # "from" in JSON
    to="agent:researcher",
    goal="Summarize the risk factors in the 2025 annual report",
    criteria=[Criterion(id="c1", text="Lists the three largest risk factors with quotes")],
    budget={"usd": 2, "tool_calls": 20},
    deadline=now + timedelta(hours=2),
    tools=["filings/*"],
)

doc = order.to_dict()               # JSON-ready, with "from" and RFC 3339 timestamps
assert validate_order(order) == []  # the validators accept models too
```

`WorkOrder.model_validate(data)` and `WorkReport.model_validate(data)` parse documents. The models catch obvious mistakes as you build. The `validate_*` functions are the checks the spec defines.

## Matches the TypeScript SDK

Findings have the same rule ids, kinds and JSON Pointer paths as [`agent-work-layer`](https://www.npmjs.com/package/agent-work-layer) on npm, including its details:

- **Timestamps** follow RFC 3339 with a time zone. Instants are compared to the millisecond, as JavaScript's `Date.parse` does.
- **Missing and unknown fields** are reported at their parent object, one finding per field.
- **Regular expressions** match as in JavaScript. For example, `$` does not match before a trailing newline.

The messages are worded differently, and schema findings (O1, R1, R11) can come in a different order. One known difference: for a caller's `output_schema` (R11) that uses `if`/`then`, `contains`, `propertyNames` or `dependentRequired`, the number of R11 findings can differ from the TypeScript SDK. Whether R11 fires is always the same.

## Not here yet

The desk (lifecycle, permissions, storage) and the MCP server are in the TypeScript packages. This package covers the documents and the checks.

## License

Apache-2.0
