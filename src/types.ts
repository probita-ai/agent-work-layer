/** Document types for AWL v0.1. Field meanings are defined in SPEC.md §4 and §5. */

export const ORDER_SPEC = "awl/work-order@0.1";
export const REPORT_SPEC = "awl/work-report@0.1";

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

export interface WorkOrder {
  spec: typeof ORDER_SPEC;
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
  escalate_to?: AgentRef;
  inputs?: Record<string, unknown>;
  context?: ContextRef[];
  output_schema?: Record<string, unknown>;
  parent_id?: string;
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

export interface WorkResult {
  summary: string;
  output?: unknown;
  artifacts?: Artifact[];
}

export interface WorkReport {
  spec: typeof REPORT_SPEC;
  order_id: string;
  from: AgentRef;
  status: ReportStatus;
  result: WorkResult;
  evidence: Evidence[];
  cost: Amounts;
  finished_at: string;
  /** Exact tool names, `server/tool`. */
  tools_used: string[];
  started_at?: string;
  attempt?: number;
  questions?: string[];
  error?: string;
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
  action: Action | "create";
  from: State | null;
  to: State;
  note?: string;
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
}

export interface OrderSummary {
  id: string;
  state: State;
  from: AgentRef;
  to: AgentRef;
  goal: string;
  deadline: string;
  parent_id?: string;
  last_seq: number;
}
