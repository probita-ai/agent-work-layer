"""Checks from SPEC.md §7 (orders and reports) and §8 (sub-orders).

Findings carry the same rule ids, kinds and paths as the TypeScript SDK. Paths are JSON
Pointers into the document; schema findings use the path of the offending value, or of
its parent object for missing and unknown fields.
"""
from __future__ import annotations

import json
import math
import re
from dataclasses import asdict, dataclass
from functools import lru_cache
from importlib import resources
from typing import Any, Callable, Dict, Iterable, Iterator, List, Literal, Mapping, Optional, Sequence

from jsonschema import Draft202012Validator, FormatChecker, ValidationError
from jsonschema.exceptions import SchemaError
from jsonschema.validators import extend

ORDER_SPEC = "awl/work-order@0.4"
REPORT_SPEC = "awl/work-report@0.3"
#: Every spec version this package reads (SPEC.md §11).
ORDER_SPECS = ("awl/work-order@0.1", "awl/work-order@0.2", "awl/work-order@0.3", ORDER_SPEC)
REPORT_SPECS = ("awl/work-report@0.1", "awl/work-report@0.2", REPORT_SPEC)
#: Budget and cost units (SPEC.md §4.2).
UNITS = ("usd", "tokens", "tool_calls", "seconds")

FindingKind = Literal["invalid", "limit"]


@dataclass(frozen=True)
class Finding:
    """A finding from a check in SPEC.md §7–§8. ``limit`` findings are recorded; ``invalid`` ones reject."""

    rule: str
    kind: FindingKind
    path: str
    message: str

    def to_dict(self) -> Dict[str, str]:
        return asdict(self)


def _load(name: str) -> Dict[str, Any]:
    return json.loads(resources.files(__package__).joinpath("schemas", name).read_text("utf-8"))


#: The JSON Schemas shipped with this package (the same files as the repository's ``schemas/``).
work_order_schema: Dict[str, Any] = _load("work-order.schema.json")
work_report_schema: Dict[str, Any] = _load("work-report.schema.json")

# ---- JSON Schema, behaving like the TypeScript SDK's Ajv setup -------------------------------------

_DATE = re.compile(r"^(\d\d\d\d)-(\d\d)-(\d\d)$", re.ASCII)
_TIME = re.compile(r"^(\d\d):(\d\d):(\d\d(?:\.\d+)?)(z|([+-])(\d\d)(?::?(\d\d))?)?$", re.ASCII | re.IGNORECASE)
_SEPARATOR = re.compile(r"t|\s", re.IGNORECASE)
_DAYS = (0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)


def _leap(year: int) -> bool:
    return year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)


def _is_date(s: str) -> bool:
    m = _DATE.match(s)
    if not m:
        return False
    year, month, day = int(m[1]), int(m[2]), int(m[3])
    return 1 <= month <= 12 and 1 <= day <= (29 if month == 2 and _leap(year) else _DAYS[month])


def _is_time(s: str) -> bool:
    m = _TIME.match(s)
    if not m:
        return False
    hr, mins, sec = int(m[1]), int(m[2]), float(m[3])
    tz, sign = m[4], (-1 if m[5] == "-" else 1)
    tz_h, tz_m = int(m[6] or 0), int(m[7] or 0)
    if tz_h > 23 or tz_m > 59 or not tz:
        return False
    if hr <= 23 and mins <= 59 and sec < 60:
        return True
    # A leap second, which must fall at 23:59 UTC.
    utc_min = mins - tz_m * sign
    utc_hr = hr - tz_h * sign - (1 if utc_min < 0 else 0)
    return utc_hr in (23, -1) and utc_min in (59, -1) and sec < 61


def _is_date_time(s: object) -> bool:
    """RFC 3339 date-time with a required time zone, as ajv-formats checks it."""
    if not isinstance(s, str):
        return True
    parts = _SEPARATOR.split(s)
    return len(parts) == 2 and _is_date(parts[0]) and _is_time(parts[1])


_formats = FormatChecker()
_formats.checks("date-time")(_is_date_time)
_formats.checks("date")(lambda s: not isinstance(s, str) or _is_date(s))


@lru_cache(maxsize=256)
def _js_regex(pattern: str) -> "re.Pattern[str]":
    """Compiles a JSON Schema pattern so it behaves as in JavaScript: ``$`` matches only at the very end, ``\\d`` only ASCII."""
    out, in_class, i = [], False, 0
    while i < len(pattern):
        c = pattern[i]
        if c == "\\":
            out.append(pattern[i : i + 2])
            i += 2
            continue
        if c == "[":
            in_class = True
        elif c == "]":
            in_class = False
        out.append(r"\Z" if c == "$" and not in_class else c)
        i += 1
    return re.compile("".join(out), re.ASCII)


def _pattern(validator: Any, pattern: str, instance: Any, schema: Any) -> Iterator[ValidationError]:
    if validator.is_type(instance, "string") and not _js_regex(pattern).search(instance):
        yield ValidationError(f"{instance!r} does not match {pattern!r}")


_Validator = extend(Draft202012Validator, {"pattern": _pattern})
_order_shape = _Validator(work_order_schema, format_checker=_formats)
_report_shape = _Validator(work_report_schema, format_checker=_formats)

_META_2020 = {"https://json-schema.org/draft/2020-12/schema", "https://json-schema.org/draft/2020-12/schema#"}


def _compile_user_schema(schema: Mapping[str, Any]) -> Any:
    """Compiles a caller-supplied JSON Schema (2020-12). Raises SchemaError when it is not valid."""
    declared = schema.get("$schema")
    if declared is not None and declared not in _META_2020:
        raise SchemaError(f"unsupported $schema {declared!r}; use JSON Schema 2020-12")
    _Validator.check_schema(schema)
    check = _Validator(schema, format_checker=_formats)
    # Ajv resolves every $ref when it compiles; jsonschema waits until one is used.
    resolver = check._resolver
    for ref in _refs(schema):
        try:
            resolver.lookup(ref)
        except Exception as e:
            raise SchemaError(f"can't resolve reference {ref!r}") from e
    return check


def _refs(value: Any) -> Iterator[str]:
    if isinstance(value, dict):
        for k, v in value.items():
            if k in ("$ref", "$dynamicRef") and isinstance(v, str):
                yield v
            elif k not in ("const", "enum", "default", "examples"):
                yield from _refs(v)
    elif isinstance(value, list):
        for v in value:
            yield from _refs(v)


def _pointer(parts: Iterable[Any]) -> str:
    return "".join("/" + str(p).replace("~", "~0").replace("/", "~1") for p in parts)


def _flatten(errors: Iterable[ValidationError]) -> Iterator[ValidationError]:
    """Like Ajv with allErrors: a failed anyOf/oneOf reports each failing branch, then itself."""
    for e in errors:
        if e.validator in ("anyOf", "oneOf"):
            yield from _flatten(e.context)
        yield e


def _schema_findings(rule: str, errors: Iterable[ValidationError], prefix: str = "") -> List[Finding]:
    out: List[Finding] = []
    for e in _flatten(errors):
        path = prefix + _pointer(e.absolute_path) or "/"
        if e.validator == "additionalProperties":
            # One finding per unknown field, like Ajv with allErrors.
            known = e.schema.get("properties", {})
            patterns = [_js_regex(p) for p in e.schema.get("patternProperties", {})]
            for key in e.instance:
                if key not in known and not any(p.search(key) for p in patterns):
                    out.append(Finding(rule, "invalid", path, f'unknown field "{key}"'))
        else:
            out.append(Finding(rule, "invalid", path, e.message))
    return out


# ---- helpers ---------------------------------------------------------------------------------------


def _days_from_civil(y: int, m: int, d: int) -> int:
    y -= m <= 2
    era = (y if y >= 0 else y - 399) // 400
    yoe = y - era * 400
    doy = (153 * (m + (-3 if m > 2 else 9)) + 2) // 5 + d - 1
    doe = yoe * 365 + yoe // 4 - yoe // 100 + doy
    return era * 146097 + doe - 719468


_STAMP = re.compile(
    r"^(\d{4})-(\d\d)-(\d\d)[tT ](\d\d):(\d\d):(\d\d)(?:\.(\d+))?(?:([zZ])|([+-])(\d\d)(?::?(\d\d))?)$", re.ASCII
)


def _time(s: Any) -> float:
    """Milliseconds since the epoch, as JavaScript's Date.parse gives them; NaN when it would fail."""
    m = _STAMP.match(s) if isinstance(s, str) else None
    if not m or int(m[6]) >= 60 or (m[9] and m[11] is None):
        return math.nan
    ms = int((m[7] or "")[:3].ljust(3, "0"))
    seconds = _days_from_civil(int(m[1]), int(m[2]), int(m[3])) * 86400 + int(m[4]) * 3600 + int(m[5]) * 60 + int(m[6])
    if m[9]:
        seconds -= (1 if m[9] == "+" else -1) * (int(m[10]) * 3600 + int(m[11]) * 60)
    return seconds * 1000 + ms


def _num(x: Any) -> str:
    """Formats a number the way JavaScript prints it in messages."""
    return str(int(x)) if isinstance(x, float) and x.is_integer() and abs(x) < 1e21 else str(x)


def _plain(doc: Any) -> Any:
    """Accepts pydantic models as well as plain JSON values."""
    dump: Optional[Callable[..., Any]] = getattr(doc, "model_dump", None)
    return dump(mode="json", by_alias=True, exclude_none=True) if dump else doc


# ---- public API ------------------------------------------------------------------------------------


def tool_allowed(tool: str, patterns: Sequence[str]) -> bool:
    """Does a concrete tool name (``server/tool``) match one of the allowed patterns?"""
    server = tool.split("/")[0]
    return any(p == "*" or p == tool or p == f"{server}/*" for p in patterns)


def pattern_covered(child: str, parent: Sequence[str]) -> bool:
    """Is everything a child pattern allows also allowed by the parent's patterns?"""
    if "*" in parent:
        return True
    if child == "*":
        return False
    parts = child.split("/")
    if len(parts) > 1 and parts[1] == "*":
        return f"{parts[0]}/*" in parent
    return tool_allowed(child, parent)


def _patterns_overlap(a: str, b: str) -> bool:
    """Can some tool match both patterns?"""
    if a == "*" or b == "*" or a == b:
        return True
    server_a, _, tool_a = a.partition("/")
    server_b, _, tool_b = b.partition("/")
    return server_a == server_b and "*" in (tool_a, tool_b)


def _is_reference(value: Any) -> bool:
    """An object whose members are ``$ref`` (a string) and, optionally, ``pointer`` (a string)."""
    return (
        isinstance(value, dict)
        and isinstance(value.get("$ref"), str)
        and isinstance(value.get("pointer", ""), str)
        and all(k in ("$ref", "pointer") for k in value)
    )


def effect_references(arguments: Any) -> List[Dict[str, str]]:
    """Every reference to an earlier effect's result in an effect's arguments (SPEC.md §4.6), in document order.

    Each is ``{"ref", "pointer", "path"}``: the earlier effect, a JSON Pointer into its result, and a
    JSON Pointer to the reference within the arguments.
    """
    out: List[Dict[str, str]] = []

    def walk(value: Any, path: str) -> None:
        if _is_reference(value):
            out.append({"ref": value["$ref"], "pointer": value.get("pointer", ""), "path": path})
        elif isinstance(value, list):
            for i, v in enumerate(value):
                walk(v, f"{path}/{i}")
        elif isinstance(value, dict):
            for k, v in value.items():
                walk(v, path + _pointer([k]))

    walk(arguments, "")
    return out


def is_work_order(value: Any) -> bool:
    """Structurally a Work Order (rule O1 only)."""
    return _order_shape.is_valid(_plain(value))


def is_work_report(value: Any) -> bool:
    """Structurally a Work Report (rule R1 only)."""
    return _report_shape.is_valid(_plain(value))


def validate_order(order: Any) -> List[Finding]:
    """Runs order checks O1–O5. Returns an empty list when the order is valid."""
    order = _plain(order)
    shape = _schema_findings("O1", _order_shape.iter_errors(order))
    if shape:
        return shape
    out: List[Finding] = []

    seen = set()
    for i, c in enumerate(order["criteria"]):
        if c["id"] in seen:
            out.append(Finding("O2", "invalid", f"/criteria/{i}/id", f'duplicate criterion id "{c["id"]}"'))
        seen.add(c["id"])

    if _time(order["deadline"]) <= _time(order["created_at"]):
        out.append(Finding("O3", "invalid", "/deadline", "deadline must be later than created_at"))

    if "output_schema" in order:
        try:
            _compile_user_schema(order["output_schema"])
        except SchemaError as e:
            out.append(Finding("O4", "invalid", "/output_schema", f"not a valid JSON Schema: {e.message}"))

    for i, p in enumerate(order.get("staged", [])):
        if not pattern_covered(p, order["tools"]):
            out.append(Finding("O5", "invalid", f"/staged/{i}", f'staged "{p}" is not covered by the order\'s tools'))
    return out


_MISSING = object()
_CALL_NUMBER = re.compile(r"^[1-9][0-9]*\Z", re.ASCII)


def validate_report(report: Any, order: Any) -> List[Finding]:
    """Runs report checks R1–R12 and R14–R16 against the order it answers. The order is assumed valid."""
    report, order = _plain(report), _plain(order)
    shape = _schema_findings("R1", _report_shape.iter_errors(report))
    if shape:
        return shape
    out: List[Finding] = []

    def add(rule: str, kind: FindingKind, path: str, message: str) -> None:
        out.append(Finding(rule, kind, path, message))

    if report["order_id"] != order["id"]:
        add("R2", "invalid", "/order_id", f'does not match order id "{order["id"]}"')

    criterion_ids = {c["id"] for c in order["criteria"]}
    for i, e in enumerate(report["evidence"]):
        if e["criterion"] not in criterion_ids:
            add("R3", "invalid", f"/evidence/{i}/criterion", f'unknown criterion "{e["criterion"]}"')

    if report["status"] == "done":
        proven = {e["criterion"] for e in report["evidence"]}
        for c in order["criteria"]:
            if c["id"] not in proven:
                add("R4", "invalid", "/evidence", f'no evidence for criterion "{c["id"]}"')

    for i, t in enumerate(report["tools_used"]):
        if not tool_allowed(t, order["tools"]):
            add("R5", "invalid", f"/tools_used/{i}", f'tool "{t}" is not allowed by this order')

    for unit in UNITS:
        limit = order["budget"].get(unit)
        if limit is None:
            continue
        spent = report["cost"].get(unit)
        if spent is None:
            add("R6", "invalid", "/cost", f'cost must report "{unit}" because the budget sets it')
        elif spent > limit:
            add("R7", "limit", f"/cost/{unit}", f"spent {_num(spent)} {unit}, budget is {_num(limit)}")

    if _time(report["finished_at"]) > _time(order["deadline"]):
        add("R8", "limit", "/finished_at", "finished after the deadline")
    if report["status"] == "blocked" and not report.get("questions"):
        add("R9", "invalid", "/questions", "a blocked report must ask at least one question")
    if report["status"] == "failed" and not report.get("error"):
        add("R10", "invalid", "/error", "a failed report must say what went wrong")

    if report["status"] == "done" and "output_schema" in order:
        check = _compile_user_schema(order["output_schema"])
        # A missing output fails any schema that constrains its type, as `undefined` does in JavaScript.
        output = report["result"].get("output", _MISSING)
        out.extend(_schema_findings("R11", check.iter_errors(output), "/result/output"))

    if "started_at" in report and _time(report["started_at"]) > _time(report["finished_at"]):
        add("R12", "invalid", "/started_at", "started_at is after finished_at")

    refs = set()
    for i, e in enumerate(report.get("effects", [])):
        if not tool_allowed(e["tool"], order.get("staged", [])):
            add("R14", "invalid", f"/effects/{i}/tool", f'tool "{e["tool"]}" is not staged by this order')
        n = e["ref"][len(e["tool"]) + 1 :]
        if not e["ref"].startswith(e["tool"] + "#") or not _CALL_NUMBER.match(n):
            add("R15", "invalid", f"/effects/{i}/ref", f'ref "{e["ref"]}" is not "{e["tool"]}#<n>"')
        elif e["ref"] in refs:
            add("R15", "invalid", f"/effects/{i}/ref", f'ref "{e["ref"]}" appears twice')
        for r in effect_references(e["arguments"]):
            path = f"/effects/{i}/arguments{r['path']}"
            if r["ref"] not in refs:
                add("R16", "invalid", path, f'"{r["ref"]}" is not an effect listed before this one')
            elif r["pointer"] != "" and not r["pointer"].startswith("/"):
                add("R16", "invalid", path, f'"{r["pointer"]}" is not a JSON Pointer')
        refs.add(e["ref"])
    return out


def validate_child_order(child: Any, parent: Any) -> List[Finding]:
    """Runs sub-order checks C1–C3 and C5: a child order may only narrow its parent's authority, and may not
    call the tools its parent stages, since its effects would run when its own report is approved."""
    child, parent = _plain(child), _plain(parent)
    out: List[Finding] = []
    for unit in UNITS:
        limit = parent["budget"].get(unit)
        if limit is None:
            continue
        asked = child["budget"].get(unit)
        if asked is None:
            out.append(Finding("C1", "invalid", "/budget", f'must set "{unit}" because the parent does'))
        elif asked > limit:
            out.append(Finding("C1", "invalid", f"/budget/{unit}", f"{_num(asked)} exceeds parent's {_num(limit)}"))
    for i, p in enumerate(child["tools"]):
        if not pattern_covered(p, parent["tools"]):
            out.append(Finding("C2", "invalid", f"/tools/{i}", f'"{p}" is wider than the parent allows'))
    if _time(child["deadline"]) > _time(parent["deadline"]):
        out.append(Finding("C3", "invalid", "/deadline", "later than the parent's deadline"))
    for i, p in enumerate(child["tools"]):
        staged = next((s for s in parent.get("staged", []) if _patterns_overlap(p, s)), None)
        if staged is not None:
            out.append(Finding("C5", "invalid", f"/tools/{i}", f'"{p}" allows "{staged}", which the parent stages'))
    return out


#: Units whose sub-order budgets add up (C4, R13). ``seconds`` is wall-clock time, and sub-orders run side by side.
_SHARED_UNITS = ("usd", "tokens", "tool_calls")
#: Absorbs floating-point error in sums of money, so 0.1 + 0.2 fits a budget of 0.3.
_EPSILON = 1e-9


def held_by_sub_orders(sub_orders: Sequence[Mapping[str, Any]]) -> Dict[str, Any]:
    """The budget an order's sub-orders hold (§8): their budgets added up, leaving out declined ones.

    ``sub_orders`` are ``{"order": ..., "state": ...}``, as the desk stores them.
    """
    held: Dict[str, Any] = {}
    for s in sub_orders:
        if s["state"] == "declined":
            continue
        budget = _plain(s["order"])["budget"]
        for unit in _SHARED_UNITS:
            if unit in budget:
                held[unit] = round(held.get(unit, 0) + budget[unit], 9)
    return held


def validate_child_budgets(child: Any, parent: Any, siblings: Sequence[Mapping[str, Any]]) -> List[Finding]:
    """Runs sub-order check C4: a parent's sub-orders, this one included, stay within its budget together.

    ``siblings`` are the parent's existing sub-orders as ``{"order": ..., "state": ...}``; declined ones are not counted.
    """
    held = held_by_sub_orders([*siblings, {"order": child, "state": "offered"}])
    parent = _plain(parent)
    out: List[Finding] = []
    for unit in _SHARED_UNITS:
        limit = parent["budget"].get(unit)
        total = held.get(unit, 0)
        if limit is not None and total - limit > _EPSILON:
            out.append(Finding("C4", "invalid", f"/budget/{unit}", f"sub-orders would total {_num(total)} {unit}, parent's budget is {_num(limit)}"))
    return out


def validate_own_cost(report: Any, order: Any, sub_orders: Sequence[Mapping[str, Any]]) -> List[Finding]:
    """Runs report check R13: the order's own cost, plus what its sub-orders hold, stays within its budget.

    Units already over budget on their own are left to R7, and units missing from the cost to R6.
    """
    report, order = _plain(report), _plain(order)
    held = held_by_sub_orders(sub_orders)
    out: List[Finding] = []
    for unit in _SHARED_UNITS:
        limit = order["budget"].get(unit)
        spent = report["cost"].get(unit)
        hold = held.get(unit, 0)
        if limit is None or spent is None or spent > limit or not hold:
            continue
        if spent + hold - limit > _EPSILON:
            out.append(Finding("R13", "limit", f"/cost/{unit}", f"spent {_num(spent)} {unit} while sub-orders hold {_num(hold)}; budget is {_num(limit)}"))
    return out


def has_invalid(findings: Sequence[Finding]) -> bool:
    """True when any finding rejects the document."""
    return any(f.kind == "invalid" for f in findings)
