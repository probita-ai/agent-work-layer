import json
from datetime import datetime, timedelta, timezone

import pytest
from pydantic import ValidationError

from agent_work_layer import (
    Criterion,
    Effect,
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
    assert doc["spec"] == "awl/work-order@0.4"
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


def test_an_order_can_continue_an_earlier_one():
    o = build_order(continues="wo_41")
    doc = o.to_dict()
    assert doc["continues"] == "wo_41"
    assert validate_order(doc) == []
    assert WorkOrder.model_validate(doc).continues == "wo_41"
    assert [f.rule for f in validate_order({**doc, "continues": ""})] == ["O1"]


def test_reads_every_order_version():
    doc = build_order().to_dict()
    for spec in ("awl/work-order@0.1", "awl/work-order@0.2", "awl/work-order@0.3", "awl/work-order@0.4"):
        assert validate_order({**doc, "spec": spec}) == []
    assert [f.rule for f in validate_order({**doc, "spec": "awl/work-order@0.5"})] == ["O1"]


def test_staged_tools_and_effects():
    order = build_order(tools=["filings/*", "gmail/*"], staged=["gmail/send"])
    assert order.to_dict()["staged"] == ["gmail/send"]
    assert validate_order(order) == []
    assert [f.rule for f in validate_order(build_order(staged=["gmail/send"]))] == ["O5"]

    effect = Effect(ref="gmail/send#4", tool="gmail/send", arguments={"to": "cfo@example.com"})
    report = WorkReport(
        order_id="wo_42",
        from_="agent:researcher",
        status="done",
        result=WorkResult(summary="sent"),
        evidence=[Evidence(criterion="c1", type="tool_call", ref="gmail/send#4")],
        cost={"usd": 1, "tool_calls": 1},
        finished_at=NOW + timedelta(hours=1),
        tools_used=["gmail/send"],
        effects=[effect],
    )
    assert report.to_dict()["spec"] == "awl/work-report@0.3"
    assert report.to_dict()["effects"] == [{"ref": "gmail/send#4", "tool": "gmail/send", "arguments": {"to": "cfo@example.com"}}]
    assert validate_report(report, order) == []
    assert [f.rule for f in validate_report(report, build_order(tools=["filings/*", "gmail/*"]))] == ["R14"]
    with pytest.raises(ValidationError):
        Effect(ref="gmail/send#4", tool="gmail/send")
