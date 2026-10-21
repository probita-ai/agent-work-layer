import pytest

from agent_work_layer import pattern_covered, tool_allowed, validate_child_budgets, validate_child_order

from helpers import order, rules


@pytest.mark.parametrize(
    "tool,patterns,expected",
    [
        ("filings/search", ["filings/search"], True),
        ("filings/search", ["filings/*"], True),
        ("filings/search", ["*"], True),
        ("filings/search", ["filings/get"], False),
        ("filings/search", ["filingsx/*"], False),
        ("filings/search", ["files/*", "calc/*"], False),
        ("filings/search", [], False),
    ],
)
def test_tool_allowed(tool, patterns, expected):
    assert tool_allowed(tool, patterns) is expected


@pytest.mark.parametrize(
    "child,parent,expected",
    [
        ("filings/search", ["filings/search"], True),
        ("filings/search", ["filings/*"], True),
        ("filings/*", ["filings/*"], True),
        ("filings/*", ["*"], True),
        ("*", ["*"], True),
        ("filings/*", ["filings/search"], False),
        ("*", ["filings/*"], False),
        ("calc/sum", ["filings/*"], False),
        ("calc/sum", [], False),
    ],
)
def test_pattern_covered(child, parent, expected):
    assert pattern_covered(child, parent) is expected


PARENT = order(budget={"usd": 2, "tool_calls": 20}, tools=["filings/*", "calc/ratio"])


def child(**overrides):
    base = dict(id="wo_child", parent_id="wo_1", budget={"usd": 1, "tool_calls": 5}, tools=["filings/search"], deadline="2026-01-01T11:00:00Z")
    return order(**{**base, **overrides})


def test_accepts_a_strictly_narrower_child():
    assert validate_child_order(child(), PARENT) == []


def test_accepts_a_child_equal_to_its_parent():
    assert validate_child_order(child(budget=PARENT["budget"], tools=PARENT["tools"], deadline=PARENT["deadline"]), PARENT) == []


def test_accepts_extra_budget_units_the_parent_does_not_limit():
    assert validate_child_order(child(budget={"usd": 1, "tool_calls": 5, "tokens": 1000}), PARENT) == []


def test_c1_rejects_a_child_that_drops_a_parent_budget_unit():
    findings = validate_child_order(child(budget={"usd": 1}), PARENT)
    assert rules(findings) == ["C1"]
    assert "tool_calls" in findings[0].message


def test_c1_rejects_a_larger_budget():
    findings = validate_child_order(child(budget={"usd": 3, "tool_calls": 5}), PARENT)
    assert rules(findings) == ["C1"]
    assert findings[0].path == "/budget/usd"


def test_c2_rejects_a_wider_tool_pattern():
    assert rules(validate_child_order(child(tools=["calc/*"]), PARENT)) == ["C2"]


def test_c2_rejects_a_tool_the_parent_does_not_have():
    assert rules(validate_child_order(child(tools=["web/browse"]), PARENT)) == ["C2"]


def test_c3_rejects_a_later_deadline():
    assert rules(validate_child_order(child(deadline="2026-01-01T12:00:01Z"), PARENT)) == ["C3"]


def test_reports_every_violation_at_once():
    findings = validate_child_order(child(budget={"usd": 9}, tools=["*"], deadline="2027-01-01T00:00:00Z"), PARENT)
    assert rules(findings) == ["C1", "C1", "C2", "C3"]


BUDGET_PARENT = order(budget={"usd": 2, "tokens": 1000, "tool_calls": 20, "seconds": 60})


def sibling(budget, state="working"):
    return {"order": order(budget=budget), "state": state}


def test_c4_accepts_sub_orders_that_fill_the_budget_exactly():
    assert validate_child_budgets(order(budget={"usd": 1}), BUDGET_PARENT, [sibling({"usd": 1})]) == []


def test_c4_rejects_each_unit_the_sub_orders_overrun_together():
    findings = validate_child_budgets(order(budget={"usd": 1, "tool_calls": 15}), BUDGET_PARENT, [sibling({"usd": 1.5, "tool_calls": 10})])
    assert [f.path for f in findings] == ["/budget/usd", "/budget/tool_calls"]
    assert findings[0].message == "sub-orders would total 2.5 usd, parent's budget is 2"


def test_c4_does_not_add_up_seconds():
    assert validate_child_budgets(order(budget={"seconds": 60}), BUDGET_PARENT, [sibling({"seconds": 60})]) == []


def test_c4_does_not_count_declined_siblings():
    assert validate_child_budgets(order(budget={"usd": 2}), BUDGET_PARENT, [sibling({"usd": 2}, "declined")]) == []


def test_c4_absorbs_floating_point_error():
    assert validate_child_budgets(order(budget={"usd": 0.2}), order(budget={"usd": 0.3}), [sibling({"usd": 0.1})]) == []
