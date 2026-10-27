"""Pydantic models for Work Orders and Work Reports (SPEC.md §4 and §5).

The models give you types and catch obvious mistakes while you build a document. The checks
in :mod:`agent_work_layer.validate` are the normative ones; every ``validate_*`` function also
accepts these models.

``from`` is a Python keyword, so the field is ``from_`` in Python and ``"from"`` in JSON.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Annotated, Any, Dict, List, Literal, Optional

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, model_validator

from .validate import ORDER_SPEC, REPORT_SPEC, order_spec_for, report_spec_for

AgentRef = Annotated[str, Field(min_length=1, max_length=512)]


def _stamp(value: Any) -> Any:
    if isinstance(value, datetime):
        if value.tzinfo is None:
            raise ValueError("timestamps need a time zone")
        return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    return value


#: An RFC 3339 timestamp. Time-zone-aware datetimes are converted to strings.
Timestamp = Annotated[str, BeforeValidator(_stamp)]
Text = Annotated[str, Field(min_length=1)]


class _Part(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class _Document(_Part):
    """A top-level document: unknown fields are allowed only as ``x-`` extensions."""

    model_config = ConfigDict(extra="allow", populate_by_name=True)

    @model_validator(mode="after")
    def _extensions_only(self) -> "_Document":
        unknown = [k for k in (self.model_extra or {}) if not k.startswith("x-")]
        if unknown:
            raise ValueError(f"unknown fields {unknown}; extensions must start with 'x-'")
        # Left unset, `spec` is the lowest version that has every field used, and always appears in to_dict().
        if "spec" not in self.model_fields_set:
            self.spec = self._lowest_spec()
        self.model_fields_set.add("spec")
        return self

    def _lowest_spec(self) -> str:
        raise NotImplementedError

    def to_dict(self) -> Dict[str, Any]:
        """The document as JSON-ready data, with ``from`` spelled as in the spec."""
        return self.model_dump(mode="json", by_alias=True, exclude_unset=True, exclude_none=True)


class Criterion(_Part):
    id: Annotated[str, Field(min_length=1, max_length=64)]
    text: Text


class Amounts(_Part):
    """A budget (upper limits) or a cost (what was spent). See SPEC.md §4.2."""

    usd: Optional[Annotated[float, Field(ge=0)]] = None
    tokens: Optional[Annotated[int, Field(ge=0)]] = None
    tool_calls: Optional[Annotated[int, Field(ge=0)]] = None
    seconds: Optional[Annotated[float, Field(ge=0)]] = None


class ContextRef(_Part):
    uri: Text
    note: Optional[str] = None


class Decision(_Part):
    text: Text
    why: Optional[str] = None


class Attempt(_Part):
    text: Text
    result: Optional[str] = None


class Handoff(_Part):
    """What the next worker should know (SPEC.md §4.4). At least one field must be set."""

    summary: Optional[Text] = None
    decisions: Optional[List[Decision]] = None
    tried: Optional[List[Attempt]] = None
    open_questions: Optional[List[Text]] = None
    next_step: Optional[Text] = None

    @model_validator(mode="after")
    def _not_empty(self) -> "Handoff":
        if not self.model_fields_set:
            raise ValueError("a handoff must not be empty")
        return self


class WorkOrder(_Document):
    spec: Literal["awl/work-order@0.1", "awl/work-order@0.2", "awl/work-order@0.3", "awl/work-order@0.4"] = ORDER_SPEC
    id: Annotated[str, Field(min_length=1, max_length=128)]
    created_at: Timestamp
    from_: AgentRef = Field(alias="from")
    to: AgentRef
    goal: Text
    criteria: Annotated[List[Criterion], Field(min_length=1)]
    budget: Amounts
    deadline: Timestamp
    #: Tool patterns: ``server/tool``, ``server/*`` or ``*``.
    tools: List[Annotated[str, Field(pattern=r"^(\*|[A-Za-z0-9_.-]+/(\*|[A-Za-z0-9_.-]+))$")]]
    #: Tools whose calls are held back until the report is approved (SPEC.md §4.6). Covered by ``tools``.
    staged: Optional[List[Annotated[str, Field(pattern=r"^(\*|[A-Za-z0-9_.-]+/(\*|[A-Za-z0-9_.-]+))$")]]] = None
    escalate_to: Optional[AgentRef] = None
    inputs: Optional[Dict[str, Any]] = None
    context: Optional[List[ContextRef]] = None
    handoff: Optional[Handoff] = None
    output_schema: Optional[Dict[str, Any]] = None
    parent_id: Optional[Text] = None
    #: The order this one picks up from, after it stopped (SPEC.md §4.5). Not a sub-order.
    continues: Optional[Text] = None
    metadata: Optional[Dict[str, Any]] = None

    def _lowest_spec(self) -> str:
        return order_spec_for(vars(self))

    @model_validator(mode="after")
    def _budget_not_empty(self) -> "WorkOrder":
        if not self.budget.model_fields_set:
            raise ValueError("a budget must set at least one unit")
        return self


class Evidence(_Part):
    criterion: Text
    type: Literal["tool_call", "artifact", "citation", "note"]
    ref: Optional[str] = None
    note: Optional[str] = None


class Artifact(_Part):
    uri: Text
    media_type: Optional[str] = None
    note: Optional[str] = None


class Effect(_Part):
    """A staged call that runs only if the report is approved (SPEC.md §4.6)."""

    #: The call's name, ``server/tool#n``, as the gateway gave it.
    ref: Text
    tool: Annotated[str, Field(pattern=r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")]
    arguments: Dict[str, Any]
    #: The worker's claim that the effect can be undone. Not checked.
    reversible: Optional[bool] = None


class WorkResult(_Part):
    summary: str
    output: Any = None
    artifacts: Optional[List[Artifact]] = None


class WorkReport(_Document):
    spec: Literal["awl/work-report@0.1", "awl/work-report@0.2", "awl/work-report@0.3"] = REPORT_SPEC
    order_id: Text
    from_: AgentRef = Field(alias="from")
    status: Literal["done", "blocked", "failed"]
    result: WorkResult
    evidence: List[Evidence]
    cost: Amounts
    finished_at: Timestamp
    #: Exact tool names, ``server/tool``.
    tools_used: List[Annotated[str, Field(pattern=r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")]]
    #: Staged calls to run on approval, in order (SPEC.md §4.6).
    effects: Optional[List[Effect]] = None
    started_at: Optional[Timestamp] = None
    attempt: Optional[Annotated[int, Field(ge=1)]] = None
    questions: Optional[List[Text]] = None
    error: Optional[Text] = None
    handoff: Optional[Handoff] = None
    metadata: Optional[Dict[str, Any]] = None

    def _lowest_spec(self) -> str:
        return report_spec_for(vars(self))
