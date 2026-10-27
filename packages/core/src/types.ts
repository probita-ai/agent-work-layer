/** Document types for AWL v0.4. Field meanings are defined in SPEC.md §4 and §5. */

/** The newest spec version this package reads. New documents get the lowest that fits: see `orderSpecFor`. */
export const ORDER_SPEC = "awl/work-order@0.4";
export const REPORT_SPEC = "awl/work-report@0.3";

/** Every spec version this package reads (SPEC.md §11). */
export const ORDER_SPECS = ["awl/work-order@0.1", "awl/work-order@0.2", "awl/work-order@0.3", ORDER_SPEC] as const;
export const REPORT_SPECS = ["awl/work-report@0.1", "awl/work-report@0.2", REPORT_SPEC] as const;

/**
 * The lowest Work Order version that defines every field `order` uses (SPEC.md §11), so readers
 * that predate a field still accept orders that don't use it.
 */
export function orderSpecFor(order: Partial<WorkOrder>): WorkOrder["spec"] {
  return order.staged !== undefined ? ORDER_SPECS[3]
    : order.continues !== undefined ? ORDER_SPECS[2]
    : order.handoff !== undefined ? ORDER_SPECS[1]
    : ORDER_SPECS[0];
}

/** The lowest Work Report version that defines every field `report` uses (SPEC.md §11). */
export function reportSpecFor(report: Partial<WorkReport>): WorkReport["spec"] {
  return report.effects !== undefined ? REPORT_SPECS[2] : report.handoff !== undefined ? REPORT_SPECS[1] : REPORT_SPECS[0];
}

/** An Agent Card URL, an agent name, or `human:<id>`. */
export type AgentRef = string;

/** Budget and cost units (SPEC.md §4.2). */
export const UNITS = ["usd", "tokens", "tool_calls", "seconds"] as const;
export type Unit = (typeof UNITS)[number];
export type Amounts = Partial<Record<Unit, number>>;

export interface Criterion {
  id: string;
  text: string;
}

export interface ContextRef {
  uri: string;
  note?: string;
}

/** What the next worker should know: decisions, dead ends and where work stands (SPEC.md §4.4). */
export interface Handoff {
  summary?: string;
  decisions?: { text: string; why?: string }[];
  tried?: { text: string; result?: string }[];
  open_questions?: string[];
  next_step?: string;
}

export interface WorkOrder {
  spec: (typeof ORDER_SPECS)[number];
  id: string;
  created_at: string;
  from: AgentRef;
  to: AgentRef;
  goal: string;
  criteria: Criterion[];
  budget: Amounts;
  deadline: string;
  /** Tool patterns: `server/tool`, `server/*` or `*`. */
  tools: string[];
  /** Tools whose calls are held back until the report is approved (§4.6). Covered by `tools`. */
  staged?: string[];
  escalate_to?: AgentRef;
  inputs?: Record<string, unknown>;
  context?: ContextRef[];
  handoff?: Handoff;
  output_schema?: Record<string, unknown>;
  parent_id?: string;
  /** The order this one picks up from, after it stopped (§4.5). Not a sub-order: no narrowing applies. */
  continues?: string;
  metadata?: Record<string, unknown>;
  [extension: `x-${string}`]: unknown;
}

export type ReportStatus = "done" | "blocked" | "failed";
export type EvidenceType = "tool_call" | "artifact" | "citation" | "note";

export interface Evidence {
  criterion: string;
  type: EvidenceType;
  ref?: string;
  note?: string;
}

export interface Artifact {
  uri: string;
  media_type?: string;
  note?: string;
}

/** A staged call that runs only if the report is approved (§4.6). */
export interface Effect {
  /** The call's name, `server/tool#n`, as the gateway gave it. */
  ref: string;
  tool: string;
  /** May contain references to earlier effects' results, `{ "$ref": "server/tool#n", "pointer": "/..." }` (§4.6). */
  arguments: Record<string, unknown>;
  /** The worker's claim that the effect can be undone. Not checked. */
  reversible?: boolean;
}

export interface WorkResult {
  summary: string;
  output?: unknown;
  artifacts?: Artifact[];
}

export interface WorkReport {
  spec: (typeof REPORT_SPECS)[number];
  order_id: string;
  from: AgentRef;
  status: ReportStatus;
  result: WorkResult;
  evidence: Evidence[];
  cost: Amounts;
  finished_at: string;
  /** Exact tool names, `server/tool`. */
  tools_used: string[];
  /** Staged calls to run on approval, in order (§4.6). */
  effects?: Effect[];
  started_at?: string;
  attempt?: number;
  questions?: string[];
  error?: string;
  handoff?: Handoff;
  metadata?: Record<string, unknown>;
  [extension: `x-${string}`]: unknown;
}

/** Fields a manager supplies; the desk fills in `spec`, `created_at`, `from` and (optionally) `id`. */
export type WorkOrderInput = Omit<WorkOrder, "spec" | "id" | "created_at" | "from"> & { id?: string };

/** Fields a worker supplies; the desk fills in `spec`, `order_id`, `from`, `attempt` and (optionally) `finished_at`. */
export type WorkReportInput = Omit<WorkReport, "spec" | "order_id" | "from" | "finished_at" | "attempt"> & { finished_at?: string };

export type State =
  | "offered"
  | "accepted"
  | "working"
  | "blocked"
  | "submitted"
  | "approved"
  | "declined"
  | "expired"
  | "cancelled";

export type Action =
  | "accept"
  | "decline"
  | "start"
  | "report_done"
  | "report_failed"
  | "report_blocked"
  | "answer"
  | "approve"
  | "rework"
  | "cancel"
  | "expire";

export interface WorkEvent {
  seq: number;
  at: string;
  actor: AgentRef;
  /** A lifecycle action, `create`, or `progress`, which changes no state (§6.2). */
  action: Action | "create" | "progress";
  from: State | null;
  to: State;
  note?: string;
  /** `progress` only: how far along the work is, 0–100. */
  percent?: number;
  /** `approve` only: the refs of the effects approved to run, when not all of them (§4.6). */
  effects?: string[];
}

/** A finding from a check in SPEC.md §7–§8. `limit` findings are recorded; `invalid` ones reject. */
export interface Finding {
  rule: string;
  kind: "invalid" | "limit";
  path: string;
  message: string;
}

/** Everything a desk knows about one order. */
export interface OrderRecord {
  order: WorkOrder;
  state: State;
  reports: WorkReport[];
  events: WorkEvent[];
  findings: Finding[];
  /** The worker's current Delegation Pass (SPEC.md §10.2), while the order is `working` on a desk that issues passes. */
  pass?: string;
}

/** A worker's record on one desk (§6.3). */
export interface TrackRecord {
  agent: AgentRef;
  /** Orders addressed to the agent, created at or after `since` when given. */
  orders: number;
  /** Orders not yet in a terminal state. */
  active: number;
  approved: number;
  declined: number;
  expired: number;
  cancelled: number;
  /** Approved orders that were never sent back for rework. */
  approved_first_time: number;
  /** Rework requests across the orders. */
  reworks: number;
  /** Reports submitted, by status. */
  reports: Record<ReportStatus, number>;
  /** Per unit, the latest report's cost added up over the orders that have a report. */
  spent: Amounts;
  /** Per unit, the budgets of those same orders added up. */
  budget: Amounts;
  since?: string;
}

export interface OrderSummary {
  id: string;
  state: State;
  from: AgentRef;
  to: AgentRef;
  goal: string;
  deadline: string;
  parent_id?: string;
  continues?: string;
  last_seq: number;
}
