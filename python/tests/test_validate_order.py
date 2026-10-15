import pytest

from agent_work_layer import is_work_order, validate_order

from helpers import order, rules, without


def test_accepts_a_complete_order():
    assert validate_order(order()) == []


def test_accepts_every_optional_field():
    full = order(
        escalate_to="human:lead",
        inputs={"issuer": "Example Corp"},
        context=[{"uri": "https://example.com/10k.pdf", "note": "latest filing"}],
        output_schema={"type": "object"},
        parent_id="wo_0",
        metadata={"team": "credit"},
    )
    assert validate_order(full) == []


@pytest.mark.parametrize("field", ["spec", "id", "created_at", "from", "to", "goal", "criteria", "budget", "deadline", "tools"])
def test_o1_rejects_a_missing_field(field):
    findings = validate_order(without(order(), field))
    assert rules(findings) == ["O1"]
    assert findings[0].path == "/"


@pytest.mark.parametrize(
    "change",
    [
        pytest.param({"spec": "awl/work-order@9.0"}, id="wrong spec version"),
        pytest.param({"criteria": []}, id="empty criteria"),
        pytest.param({"criteria": [{"id": "c1"}]}, id="criterion without text"),
        pytest.param({"budget": {}}, id="empty budget"),
        pytest.param({"budget": {"euros": 5}}, id="unknown budget unit"),
        pytest.param({"budget": {"usd": -1}}, id="negative budget"),
        pytest.param({"budget": {"tokens": 1.5}}, id="fractional tokens"),
        pytest.param({"goal": ""}, id="empty goal"),
        pytest.param({"deadline": "tomorrow"}, id="non-date deadline"),
        pytest.param({"priority": "high"}, id="unknown top-level field"),
        pytest.param({"inputs": "x"}, id="non-object inputs"),
        pytest.param({"context": [{"note": "x"}]}, id="context without uri"),
    ],
)
def test_o1_rejects(change):
    assert rules(validate_order(order(**change))) == ["O1"]


def test_o1_reports_the_offending_path():
    [f] = validate_order(order(budget={"usd": -1}))
    assert (f.path, f.kind) == ("/budget/usd", "invalid")


def test_o1_names_unknown_fields_in_the_message():
    [f] = validate_order(order(priority="high"))
    assert f.message == 'unknown field "priority"'
    assert f.path == "/"


def test_o1_allows_x_extensions():
    assert validate_order(order(**{"x-cost-center": "CR-12"})) == []


@pytest.mark.parametrize("value", [None, 42, "order", [], True])
def test_o1_rejects_non_objects(value):
    assert rules(validate_order(value)) == ["O1"]


@pytest.mark.parametrize("pattern", ["*", "filings/*", "filings/get_section", "my-server.v2/tool_1"])
def test_accepts_tool_pattern(pattern):
    assert validate_order(order(tools=[pattern])) == []


@pytest.mark.parametrize("pattern", ["", "filings", "*/search", "a/b/c", "filings/ search", "**", "filings/search\n"])
def test_rejects_tool_pattern(pattern):
    assert rules(validate_order(order(tools=[pattern]))) == ["O1"]


def test_accepts_an_empty_tool_list():
    assert validate_order(order(tools=[])) == []


@pytest.mark.parametrize("stamp", ["2026-01-01T12:00:00", "2026-02-30T12:00:00Z", "2026-01-01T24:00:00Z", "2026-01-01"])
def test_o1_rejects_timestamps_ajv_rejects(stamp):
    assert rules(validate_order(order(deadline=stamp))) == ["O1"]


@pytest.mark.parametrize("stamp", ["2026-01-01T12:00:00+02:00", "2026-01-01t12:00:00.5z", "2026-01-01 12:00:00Z"])
def test_accepts_rfc3339_variants(stamp):
    assert validate_order(order(created_at="2026-01-01T00:00:00Z", deadline=stamp)) == []


def test_o2_rejects_duplicate_criterion_ids():
    findings = validate_order(order(criteria=[{"id": "c1", "text": "a"}, {"id": "c1", "text": "b"}]))
    assert rules(findings) == ["O2"]
    assert findings[0].path == "/criteria/1/id"


def test_o3_rejects_a_deadline_equal_to_created_at():
    assert rules(validate_order(order(deadline=order()["created_at"]))) == ["O3"]


def test_o3_compares_instants_not_strings():
    # 12:00+02:00 is 10:00Z, before created_at.
    assert rules(validate_order(order(created_at="2026-01-01T11:00:00Z", deadline="2026-01-01T12:00:00+02:00"))) == ["O3"]


def test_o3_rejects_a_deadline_before_created_at():
    assert rules(validate_order(order(deadline="2025-12-31T00:00:00Z"))) == ["O3"]


def test_o4_rejects_an_invalid_output_schema():
    assert rules(validate_order(order(output_schema={"type": "not-a-type"}))) == ["O4"]


def test_o4_rejects_an_unresolvable_ref():
    assert rules(validate_order(order(output_schema={"$ref": "#/$defs/missing"}))) == ["O4"]


def test_o4_tolerates_two_orders_using_the_same_id():
    schema = {"$id": "https://example.com/out", "type": "object"}
    assert validate_order(order(output_schema=schema)) == []
    assert validate_order(order(output_schema=dict(schema))) == []


def test_reports_several_semantic_problems_at_once():
    findings = validate_order(
        order(criteria=[{"id": "a", "text": "x"}, {"id": "a", "text": "y"}], deadline=order()["created_at"])
    )
    assert rules(findings) == ["O2", "O3"]


def test_is_work_order():
    assert is_work_order(order()) is True
    assert is_work_order(without(order(), "goal")) is False
