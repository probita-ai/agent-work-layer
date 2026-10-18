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
    has_invalid,
    is_work_order,
    is_work_report,
    pattern_covered,
    tool_allowed,
    validate_child_order,
    validate_order,
    validate_report,
    work_order_schema,
    work_report_schema,
)

__version__ = "0.2.0"

__all__ = [
    "Amounts", "Artifact", "Attempt", "ContextRef", "Criterion", "Decision", "Evidence", "Handoff",
    "WorkOrder", "WorkReport", "WorkResult",
    "ORDER_SPEC", "ORDER_SPECS", "REPORT_SPEC", "REPORT_SPECS", "UNITS", "Finding",
    "has_invalid", "is_work_order", "is_work_report", "pattern_covered", "tool_allowed",
    "validate_child_order", "validate_order", "validate_report", "work_order_schema", "work_report_schema",
    "__version__",
]
