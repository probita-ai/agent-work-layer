import json
from datetime import datetime, timedelta, timezone

import pytest
from pydantic import ValidationError

from agent_work_layer import (
    Criterion,
    Evidence,
    WorkOrder,
    WorkReport,
    WorkResult,
    validate_order,
    validate_report,
    work_order_schema,
    work_report_schema,
)

from helpers import REPO, order, report

NOW = datetime(2026, 1, 1, 9, tzinfo=timezone.utc)


def build_order(**overrides):
    fields = dict(
        id="wo_42",
        created_at=NOW,
        from_="agent:manager",
        to="agent:researcher",
        goal="Summarize the risk factors",
        criteria=[Criterion(id="c1", text="Lists three risk factors")],
        budget={"usd": 2, "tool_calls": 20},
        deadline=NOW + timedelta(hours=2),
        tools=["filings/*"],
    )
    return WorkOrder(**{**fields, **overrides})


def test_builds_an_order_in_python():
    o = build_order()
    doc = o.to_dict()
    assert doc["from"] == "agent:manager"
    assert doc["spec"] == "awl/work-order@0.2"
    assert doc["created_at"] == "2026-01-01T09:00:00.000Z"
    assert doc["deadline"] == "2026-01-01T11:00:00.000Z"
    assert doc["budget"] == {"usd": 2, "tool_calls": 20}
    assert "escalate_to" not in doc
    assert validate_order(doc) == []
    assert validate_order(o) == []


def test_builds_a_report_in_python():
    o = build_order()
    r = WorkReport(
        order_id="wo_42",
        from_="agent:researcher",
        status="done",
        result=WorkResult(summary="ok"),
        evidence=[Evidence(criterion="c1", type="note", note="see memo")],
        cost={"usd": 1, "tool_calls": 3},
        finished_at=NOW + timedelta(hours=1),
        tools_used=["filings/search"],
    )
    assert validate_report(r, o) == []
    assert json.loads(json.dumps(r.to_dict()))["from"] == "agent:researcher"


def test_order_round_trips():
    doc = order(**{"x-cost-center": "CR-12", "output_schema": {"type": "object"}})
    assert WorkOrder.model_validate(doc).to_dict() == doc
    rep = report()
    assert WorkReport.model_validate(rep).to_dict() == rep


@pytest.mark.parametrize(
    "overrides",
    [
        pytest.param({"criteria": []}, id="no criteria"),
        pytest.param({"budget": {}}, id="empty budget"),
        pytest.param({"tools": ["*/x"]}, id="bad pattern"),
        pytest.param({"created_at": datetime(2026, 1, 1)}, id="naive datetime"),
        pytest.param({"handoff": {}}, id="empty handoff"),
        pytest.param({"priority": "high"}, id="unknown field"),
    ],
)
def test_order_model_rejects_obvious_mistakes(overrides):
    with pytest.raises(ValidationError):
        build_order(**overrides)


def test_report_model_rejects_unknown_evidence_type():
    with pytest.raises(ValidationError):
        WorkReport.model_validate(report(evidence=[{"criterion": "c1", "type": "vibes"}]))


def test_packaged_schemas_match_the_repository():
    for name, packaged in [("work-order.schema.json", work_order_schema), ("work-report.schema.json", work_report_schema)]:
        assert packaged == json.loads((REPO / "schemas" / name).read_text("utf-8")), f"copy schemas/{name} into the package"
