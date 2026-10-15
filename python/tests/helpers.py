"""Shared fixtures, matching packages/core/test/helpers.ts. Each test changes one thing."""
from __future__ import annotations

import copy
from pathlib import Path
from typing import Any, Dict, List

from agent_work_layer import ORDER_SPEC, REPORT_SPEC, Finding

REPO = Path(__file__).resolve().parents[2]
T0 = "2026-01-01T09:00:00.000Z"
DEADLINE = "2026-01-01T12:00:00.000Z"

_ORDER: Dict[str, Any] = {
    "spec": ORDER_SPEC,
    "id": "wo_1",
    "created_at": T0,
    "from": "agent:manager",
    "to": "agent:worker",
    "goal": "Summarize the risk factors in the annual report",
    "criteria": [
        {"id": "c1", "text": "Lists three risk factors with quotes"},
        {"id": "c2", "text": "States total debt and fiscal year"},
    ],
    "budget": {"usd": 2, "tool_calls": 20},
    "deadline": DEADLINE,
    "tools": ["filings/*", "calc/ratio"],
}

_REPORT: Dict[str, Any] = {
    "spec": REPORT_SPEC,
    "order_id": "wo_1",
    "from": "agent:worker",
    "finished_at": "2026-01-01T10:00:00.000Z",
    "status": "done",
    "result": {"summary": "Three risks found; debt 1.2B USD FY2025"},
    "evidence": [
        {"criterion": "c1", "type": "tool_call", "ref": "filings/get_section#3"},
        {"criterion": "c2", "type": "citation", "ref": "filings/get_section#5"},
    ],
    "cost": {"usd": 0.8, "tool_calls": 7},
    "tools_used": ["filings/search", "filings/get_section"],
}


def order(**overrides: Any) -> Dict[str, Any]:
    return {**copy.deepcopy(_ORDER), **overrides}


def report(**overrides: Any) -> Dict[str, Any]:
    return {**copy.deepcopy(_REPORT), **overrides}


def rules(findings: List[Finding]) -> List[str]:
    """Sorted rule ids, for comparing findings without caring about order."""
    return sorted(f.rule for f in findings)


def without(value: Dict[str, Any], key: str) -> Dict[str, Any]:
    return {k: v for k, v in value.items() if k != key}
