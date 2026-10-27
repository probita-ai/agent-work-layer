"""Agent Work Layer for Python: Work Order and Work Report models and validation.

See SPEC.md in https://github.com/probita-ai/agent-work-layer for the format.
"""
from .models import (
    Amounts,
    Artifact,
    Attempt,
    ContextRef,
    Criterion,
    Decision,
    Effect,
    Evidence,
    Handoff,
    WorkOrder,
    WorkReport,
    WorkResult,
)
from .validate import (
    ORDER_SPEC,
    ORDER_SPECS,
    REPORT_SPEC,
    REPORT_SPECS,
    UNITS,
    Finding,
    effect_references,
    order_spec_for,
    report_spec_for,
    has_invalid,
    held_by_sub_orders,
    is_work_order,
    is_work_report,
    pattern_covered,
    tool_allowed,
    validate_child_budgets,
    validate_child_order,
    validate_order,
    validate_own_cost,
    validate_report,
    work_order_schema,
    work_report_schema,
)

__version__ = "0.4.0"

__all__ = [
    "Amounts", "Artifact", "Attempt", "ContextRef", "Criterion", "Decision", "Effect", "Evidence", "Handoff",
    "WorkOrder", "WorkReport", "WorkResult",
    "ORDER_SPEC", "ORDER_SPECS", "REPORT_SPEC", "REPORT_SPECS", "UNITS", "Finding",
    "effect_references", "order_spec_for", "report_spec_for", "has_invalid", "held_by_sub_orders", "is_work_order", "is_work_report", "pattern_covered", "tool_allowed",
    "validate_child_budgets", "validate_child_order", "validate_order", "validate_own_cost", "validate_report",
    "work_order_schema", "work_report_schema",
    "__version__",
]
