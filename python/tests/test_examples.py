"""The repository's examples/ give the same results as in the TypeScript SDK."""
import json

import pytest

from agent_work_layer import validate_child_order, validate_order, validate_report

from helpers import REPO


def load(name):
    return json.loads((REPO / "examples" / name).read_text("utf-8"))


@pytest.mark.parametrize("name", ["risk-summary.order.json", "csv-export.order.json", "calc.child-order.json"])
def test_example_orders_are_valid(name):
    assert validate_order(load(name)) == []


def test_child_order_example_narrows_its_parent():
    assert validate_child_order(load("calc.child-order.json"), load("risk-summary.order.json")) == []


def test_good_report_is_valid():
    assert validate_report(load("risk-summary.report.json"), load("risk-summary.order.json")) == []


def test_bad_report_findings_match_the_typescript_sdk():
    findings = validate_report(load("bad.report.json"), load("risk-summary.order.json"))
    # From `awl check examples/bad.report.json --order examples/risk-summary.order.json`.
    assert [(f.rule, f.kind, f.path) for f in findings] == [
        ("R4", "invalid", "/evidence"),
        ("R5", "invalid", "/tools_used/1"),
        ("R7", "limit", "/cost/usd"),
        ("R6", "invalid", "/cost"),
        ("R8", "limit", "/finished_at"),
        ("R11", "invalid", "/result/output"),
        ("R11", "invalid", "/result/output/risk_factors"),
    ]
