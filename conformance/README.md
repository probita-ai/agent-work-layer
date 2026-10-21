# Conformance vectors

Test vectors for the checks in [SPEC.md §7](../SPEC.md#7-checks) and [§8](../SPEC.md#8-sub-orders-delegation): documents, and the findings a validator must report for them. They are plain JSON, so an implementation in any language can run them to show it applies the rules as the spec says.

Both implementations in this repo run every vector: [packages/core/test/conformance.test.ts](../packages/core/test/conformance.test.ts) (TypeScript) and [python/tests/test_conformance.py](../python/tests/test_conformance.py) (Python).

## Files

`vectors/<rule>.json` holds the vectors for one rule, from `O1.json` to `C3.json`. Each rule has at least one vector that passes and one that fails.

```json
{
  "rule": "R7",
  "check": "report",
  "description": "For every unit, `cost` ≤ `budget`.",
  "vectors": [
    {
      "name": "flags spending over budget",
      "order": { "spec": "awl/work-order@0.3", "id": "wo_1", "...": "..." },
      "report": { "spec": "awl/work-report@0.2", "order_id": "wo_1", "...": "..." },
      "expect": [{ "rule": "R7", "kind": "limit", "path": "/cost/usd" }]
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `rule` | The rule these vectors are about. |
| `check` | Which checks to run, and on what (below). |
| `description` | The rule's text from the spec. |
| `vectors[].name` | What the vector shows. |
| `vectors[].order` | A Work Order. For `child`, the sub-order. |
| `vectors[].report` | `report` only: the Work Report to check against `order`. |
| `vectors[].parent` | `child` only: the parent order. |
| `vectors[].expect` | The findings, each `{rule, kind, path?}`. Empty when the document is valid. |

| `check` | Run | Rules |
|---|---|---|
| `order` | the order checks on `order` | O1–O4 |
| `report` | the report checks on `report` against `order` | R1–R12 |
| `child` | the sub-order checks on `order` against `parent` | C1–C3 |

Every check runs, not only the file's rule. A vector changes one thing from a valid document, so the only findings expected are for the file's rule. The orders in `report` and `child` vectors are valid; report checks assume a valid order.

## Matching

A validator passes a vector when:

1. every entry in `expect` matches at least one finding it reports, and
2. every finding it reports matches at least one entry in `expect`.

A finding matches an entry when `rule` and `kind` are equal and, if the entry has a `path`, the paths are equal. Paths are JSON Pointers into the checked document (`/` for the document itself); for `child` vectors they point into the sub-order.

Messages are not compared. Neither is the number of findings per entry: when O1, R1 or R11 fail, how many schema errors a JSON Schema library reports for one mistake varies, so matching only asks that each expected finding is there and nothing else is. Every vector here gives a `path`; an entry may leave it out where JSON Schema libraries turn out to place the same error differently.

## Adding vectors

Add a vector to the rule's file when you find a case the spec decides but the vectors don't cover, especially one where implementations could differ. Keep the base documents unchanged apart from the one thing the vector is about, and run both test suites. A new rule gets a new file in the same PR that adds it to the spec.
