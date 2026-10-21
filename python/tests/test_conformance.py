"""Runs every vector in conformance/vectors (see conformance/README.md) through this validator."""
import json

import pytest

from agent_work_layer import validate_child_order, validate_order, validate_report

from helpers import REPO

FILES = [json.loads(p.read_text("utf-8")) for p in sorted((REPO / "conformance" / "vectors").glob("*.json"))]
CASES = [pytest.param(f, v, id=f"{f['rule']}: {v['name']}") for f in FILES for v in f["vectors"]]


def run(file, v):
    if file["check"] == "order":
        return validate_order(v["order"])
    if file["check"] == "report":
        return validate_report(v["report"], v["order"])
    return validate_child_order(v["order"], v["parent"])


def matches(f, e):
    return f.rule == e["rule"] and f.kind == e["kind"] and ("path" not in e or f.path == e["path"])


@pytest.mark.parametrize("file, vector", CASES)
def test_vector(file, vector):
    actual, expected = run(file, vector), vector["expect"]
    missing = [e for e in expected if not any(matches(f, e) for f in actual)]
    extra = [(f.rule, f.kind, f.path) for f in actual if not any(matches(f, e) for e in expected)]
    assert not missing and not extra, f"missing {missing}, unexpected {extra}"
