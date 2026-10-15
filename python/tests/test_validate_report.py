import pytest

from agent_work_layer import has_invalid, is_work_report, validate_report

from helpers import DEADLINE, order, report, rules, without

WITH_OUTPUT = order(
    output_schema={
        "type": "object",
        "required": ["risks"],
        "properties": {"risks": {"type": "array", "minItems": 3, "items": {"type": "string"}}},
    }
)


def test_accepts_a_complete_done_report():
    assert validate_report(report(), order()) == []


def test_accepts_every_optional_field():
    full = report(
        started_at="2026-01-01T09:30:00Z",
        attempt=2,
        questions=[],
        metadata={"model": "x"},
        result={"summary": "ok", "output": {"a": 1}, "artifacts": [{"uri": "s3://bucket/memo.pdf", "media_type": "application/pdf"}]},
    )
    assert validate_report(full, order()) == []


@pytest.mark.parametrize("field", ["spec", "order_id", "from", "status", "result", "evidence", "cost", "finished_at", "tools_used"])
def test_r1_rejects_a_missing_field(field):
    assert rules(validate_report(without(report(), field), order())) == ["R1"]


@pytest.mark.parametrize(
    "change",
    [
        pytest.param({"status": "partial"}, id="unknown status"),
        pytest.param({"result": {}}, id="result without summary"),
        pytest.param({"evidence": [{"criterion": "c1", "type": "vibes"}]}, id="unknown evidence type"),
        pytest.param({"evidence": [{"type": "note"}]}, id="evidence without criterion"),
        pytest.param({"tools_used": ["filings/*"]}, id="wildcard in tools_used"),
        pytest.param({"tools_used": ["search"]}, id="bare tool name"),
        pytest.param({"cost": {"usd": 1, "euros": 1}}, id="unknown cost unit"),
        pytest.param({"attempt": 0}, id="zero attempt"),
        pytest.param({"questions": [""]}, id="empty question"),
        pytest.param({"confidence": 0.9}, id="unknown top-level field"),
    ],
)
def test_r1_rejects(change):
    assert rules(validate_report(report(**change), order())) == ["R1"]


def test_r1_reports_one_finding_per_unknown_field():
    findings = validate_report(report(confidence=0.9, mood="ok"), order())
    assert sorted(f.message for f in findings) == ['unknown field "confidence"', 'unknown field "mood"']


def test_r1_allows_x_extensions():
    assert validate_report(report(**{"x-trace-id": "abc"}), order()) == []


def test_r2_rejects_a_report_for_another_order():
    assert rules(validate_report(report(order_id="wo_other"), order())) == ["R2"]


def test_r3_rejects_evidence_for_an_unknown_criterion():
    evidence = report()["evidence"] + [{"criterion": "c9", "type": "note"}]
    findings = validate_report(report(evidence=evidence), order())
    assert rules(findings) == ["R3"]
    assert findings[0].path == "/evidence/2/criterion"


def test_r4_rejects_done_without_evidence_for_every_criterion():
    findings = validate_report(report(evidence=[report()["evidence"][0]]), order())
    assert rules(findings) == ["R4"]
    assert '"c2"' in findings[0].message


def test_r4_reports_one_finding_per_unproven_criterion():
    assert rules(validate_report(report(evidence=[]), order())) == ["R4", "R4"]


def test_r4_accepts_several_evidence_items_for_one_criterion():
    evidence = report()["evidence"] + [{"criterion": "c1", "type": "artifact", "ref": "memo.pdf"}]
    assert validate_report(report(evidence=evidence), order()) == []


def test_r4_does_not_apply_to_blocked_or_failed_reports():
    assert validate_report(report(status="blocked", evidence=[], questions=["Which year?"]), order()) == []
    assert validate_report(report(status="failed", evidence=[], error="source down"), order()) == []


def test_r5_rejects_a_tool_outside_the_allowed_patterns():
    findings = validate_report(report(tools_used=["filings/search", "web/browse"]), order())
    assert rules(findings) == ["R5"]
    assert findings[0].path == "/tools_used/1"


def test_r5_patterns():
    assert validate_report(report(tools_used=["calc/ratio"]), order()) == []
    assert rules(validate_report(report(tools_used=["calc/sum"]), order())) == ["R5"]
    assert validate_report(report(tools_used=["any/thing"]), order(tools=["*"])) == []
    assert rules(validate_report(report(), order(tools=[]))) == ["R5", "R5"]
    assert validate_report(report(tools_used=[]), order(tools=[])) == []


def test_r6_rejects_a_cost_that_omits_a_budgeted_unit():
    assert rules(validate_report(report(cost={"usd": 1}), order())) == ["R6"]


def test_allows_cost_units_the_budget_does_not_set():
    assert validate_report(report(cost={"usd": 1, "tool_calls": 3, "tokens": 9000}), order()) == []


def test_r7_flags_spending_over_budget_as_a_limit_finding():
    findings = validate_report(report(cost={"usd": 2.01, "tool_calls": 7}), order())
    assert rules(findings) == ["R7"]
    assert (findings[0].kind, findings[0].path) == ("limit", "/cost/usd")
    assert findings[0].message == "spent 2.01 usd, budget is 2"
    assert not has_invalid(findings)


def test_r7_allows_spending_exactly_the_budget():
    assert validate_report(report(cost={"usd": 2, "tool_calls": 20}), order()) == []


def test_r7_checks_every_unit():
    assert rules(validate_report(report(cost={"usd": 9, "tool_calls": 99}), order())) == ["R7", "R7"]


def test_r8_flags_finishing_after_the_deadline_as_a_limit_finding():
    [f] = validate_report(report(finished_at="2026-01-01T12:00:01Z"), order())
    assert (f.rule, f.kind) == ("R8", "limit")


def test_r8_allows_finishing_exactly_at_the_deadline():
    assert validate_report(report(finished_at=DEADLINE), order()) == []


def test_r8_compares_to_the_millisecond():
    # Date.parse drops digits past milliseconds, so these are the same instant.
    assert validate_report(report(finished_at="2026-01-01T12:00:00.0009Z"), order()) == []
    assert rules(validate_report(report(finished_at="2026-01-01T12:00:00.001Z"), order())) == ["R8"]


def test_r9_rejects_a_blocked_report_with_no_questions():
    assert rules(validate_report(report(status="blocked", evidence=[]), order())) == ["R9"]
    assert rules(validate_report(report(status="blocked", evidence=[], questions=[]), order())) == ["R9"]


def test_r10_rejects_a_failed_report_with_no_error():
    assert rules(validate_report(report(status="failed", evidence=[]), order())) == ["R10"]


def test_r11_accepts_matching_output():
    r = report(result={"summary": "ok", "output": {"risks": ["a", "b", "c"]}})
    assert validate_report(r, WITH_OUTPUT) == []


def test_r11_rejects_output_that_does_not_match_with_paths():
    findings = validate_report(report(result={"summary": "ok", "output": {"risks": ["a"]}}), WITH_OUTPUT)
    assert rules(findings) == ["R11"]
    assert findings[0].path == "/result/output/risks"


def test_r11_rejects_missing_output():
    assert rules(validate_report(report(), WITH_OUTPUT)) == ["R11"]


def test_r11_is_skipped_when_the_report_is_not_done():
    assert validate_report(report(status="failed", evidence=[], error="x"), WITH_OUTPUT) == []


def test_r11_matches_patterns_as_javascript_does():
    # Python's `$` would also match before a trailing newline; JavaScript's does not.
    o = order(output_schema={"type": "string", "pattern": "^\\d+$"})
    assert rules(validate_report(report(result={"summary": "ok", "output": "12\n"}), o)) == ["R11"]
    assert validate_report(report(result={"summary": "ok", "output": "12"}), o) == []


def test_r12_rejects_started_at_after_finished_at():
    assert rules(validate_report(report(started_at="2026-01-01T11:00:00Z"), order())) == ["R12"]


def test_reports_every_independent_problem_at_once():
    bad = report(
        order_id="wo_x",
        evidence=[{"criterion": "c9", "type": "note"}],
        cost={"usd": 5},
        tools_used=["web/browse"],
        finished_at="2026-01-02T00:00:00Z",
    )
    assert rules(validate_report(bad, order())) == ["R2", "R3", "R4", "R4", "R5", "R6", "R7", "R8"]


def test_is_work_report():
    assert is_work_report(report()) is True
    assert is_work_report(report(status="?")) is False
