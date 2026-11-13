// The A2A binding (SPEC.md §9.2): Work Orders, Work Reports and reviews as A2A data parts, AWL states as
// A2A task states, and applying a worker's A2A task to the manager's desk. No A2A SDK and no Node
// built-ins: the shapes are A2A v0.3's JSON, so this works with any A2A implementation.
import { AwlError } from "./errors.ts";
import { ORDER_SPECS, REPORT_SPECS } from "./types.ts";
import type { AgentRef, Finding, OrderRecord, State, WorkOrder, WorkReport, WorkReportInput } from "./types.ts";
import { isWorkReport, validateOrder, validateReport } from "./validate.ts";
import type { WorkDesk } from "./desk.ts";

/** The URI an agent lists in its Agent Card's `capabilities.extensions`, and a message in its `extensions`. */
export const AWL_A2A_EXTENSION = "https://github.com/probita-ai/agent-work-layer/blob/main/SPEC.md#92-a2a";

/** Media types of the AWL data parts, carried in each part's `metadata.mediaType`. */
export const AWL_MEDIA_TYPES = {
  order: "application/vnd.awl.work-order+json",
  report: "application/vnd.awl.work-report+json",
  review: "application/vnd.awl.review+json",
} as const;

/** An A2A data part. */
export interface A2ADataPart {
  kind: "data";
  data: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/** Any A2A part; only data parts with an AWL media type are read. */
export type A2APart = A2ADataPart | { kind: "text"; text: string; metadata?: Record<string, unknown> } | { kind: "file"; [key: string]: unknown };

/** A2A task states (A2A v0.3). */
export type A2ATaskState =
  | "submitted" | "working" | "input-required" | "completed" | "canceled" | "failed" | "rejected" | "auth-required" | "unknown";

/** The parts of an A2A task this binding reads. */
export interface A2ATask {
  id: string;
  contextId?: string;
  status: { state: A2ATaskState; message?: { parts: A2APart[] }; timestamp?: string };
  artifacts?: { artifactId?: string; name?: string; parts: A2APart[] }[];
  metadata?: Record<string, unknown>;
}

/** A manager's decision on a submitted report, sent to the worker on the order's task. */
export interface AwlReview {
  order_id: string;
  decision: "approve" | "rework";
  /** Required for rework: what to change. */
  reason?: string;
  /** On approve: the refs of the report's effects to run, when not all of them (§4.6). */
  effects?: string[];
}

const part = (data: object, mediaType: string): A2ADataPart => ({ kind: "data", data: structuredClone(data) as Record<string, unknown>, metadata: { mediaType } });

/** A Work Order as an A2A data part. */
export const orderPart = (order: WorkOrder): A2ADataPart => part(order, AWL_MEDIA_TYPES.order);

/** A Work Report as an A2A data part. */
export const reportPart = (report: WorkReport): A2ADataPart => part(report, AWL_MEDIA_TYPES.report);

/** A review as an A2A data part. Throws BAD_REQUEST when it is not a valid review. */
export function reviewPart(review: AwlReview): A2ADataPart {
  checkReview(review);
  return part(review, AWL_MEDIA_TYPES.review);
}

/** The AWL documents found in a message's or artifact's parts. */
export interface AwlParts {
  orders: WorkOrder[];
  reports: WorkReport[];
  reviews: AwlReview[];
}

/**
 * Reads the AWL data parts among `parts`, by `metadata.mediaType`; other parts are ignored. An order
 * must pass the order checks, and a report the Work Report schema (R1); a report's other checks need
 * its order, which the desk applies on submit. Throws VALIDATION_FAILED, or BAD_REQUEST for a bad review.
 */
export function readParts(parts: readonly unknown[]): AwlParts {
  const out: AwlParts = { orders: [], reports: [], reviews: [] };
  for (const p of parts ?? []) {
    if (!p || typeof p !== "object" || (p as A2APart).kind !== "data") continue;
    const { data, metadata } = p as A2ADataPart;
    const type = metadata?.mediaType;
    if (type === AWL_MEDIA_TYPES.order) {
      const findings = validateOrder(data);
      if (findings.length) throw new AwlError("VALIDATION_FAILED", "work order part rejected", findings);
      out.orders.push(data as unknown as WorkOrder);
    } else if (type === AWL_MEDIA_TYPES.report) {
      if (!isWorkReport(data)) throw new AwlError("VALIDATION_FAILED", "work report part rejected", schemaOnly(data));
      out.reports.push(data);
    } else if (type === AWL_MEDIA_TYPES.review) {
      checkReview(data as unknown as AwlReview);
      out.reviews.push(data as unknown as AwlReview);
    }
  }
  return out;
}

/** The R1 findings for a document that is not a Work Report: `validateReport` stops at the schema. */
const schemaOnly = (data: unknown): Finding[] => validateReport(data, {} as WorkOrder);

function checkReview(review: AwlReview) {
  const ok = review && typeof review === "object" && typeof review.order_id === "string" && review.order_id &&
    (review.decision === "approve" || review.decision === "rework") &&
    (review.reason === undefined || typeof review.reason === "string") &&
    (review.effects === undefined || (Array.isArray(review.effects) && review.effects.every((e) => typeof e === "string")));
  if (!ok) throw new AwlError("BAD_REQUEST", "a review needs order_id, decision approve or rework, and optional reason and effects");
  if (review.decision === "rework" && !review.reason?.trim()) throw new AwlError("BAD_REQUEST", "rework needs a reason the worker can act on");
  if (review.decision === "rework" && review.effects) throw new AwlError("BAD_REQUEST", "only an approval can choose effects");
}

const TASK_STATE: Record<State, A2ATaskState> = {
  offered: "submitted",
  accepted: "working",
  working: "working",
  blocked: "input-required",
  submitted: "input-required",
  approved: "completed",
  declined: "rejected",
  expired: "failed",
  cancelled: "canceled",
};

/**
 * The A2A task state for an AWL state (§9.2). `blocked` and `submitted` both need the manager, so both
 * are `input-required`; the task's `metadata["awl/state"]` tells them apart.
 */
export const taskState = (state: State): A2ATaskState => TASK_STATE[state];

/** The task status an order's record maps to, with the AWL state and order id in its metadata. */
export function taskStatus(record: OrderRecord): { state: A2ATaskState; metadata: Record<string, unknown> } {
  return { state: taskState(record.state), metadata: { "awl/state": record.state, "awl/order": record.order.id } };
}

/** The entry for an Agent Card's `capabilities.extensions`, saying which AWL versions the agent reads. */
export function agentCardExtension(required = false) {
  return {
    uri: AWL_A2A_EXTENSION,
    description: "Takes Work Orders and returns Work Reports with evidence (Agent Work Layer).",
    required,
    params: { order_specs: [...ORDER_SPECS], report_specs: [...REPORT_SPECS] },
  };
}

/** What `recordTask` did. */
export interface RecordTaskResult {
  record: OrderRecord;
  /** Limit findings recorded with a report (R7, R8, R13); the order is then `expired`. */
  findings: Finding[];
}

/**
 * Applies a worker's A2A task to the manager's desk (§9.2): a `rejected` task declines an offered order,
 * any later state accepts it, and each Work Report in the task's artifacts that the desk does not have
 * yet (by `attempt`, which each report MUST carry) is submitted as the worker, in order. The caller MUST have authenticated the A2A peer as
 * `worker`, the order's `to`: the desk takes the worker's actions on its word.
 */
export async function recordTask(desk: WorkDesk, orderId: string, task: A2ATask, worker: AgentRef): Promise<RecordTaskResult> {
  let record = await desk.get(orderId);
  if (worker !== record.order.to) throw new AwlError("FORBIDDEN", `"${worker}" is not the worker of order "${orderId}"`);
  const state = task.status?.state;
  if (record.state === "offered") {
    if (state === "rejected") {
      const reason = textOf(task.status.message?.parts);
      return { record: await desk.decline(orderId, worker, reason), findings: [] };
    }
    if (state === "submitted" || state === "unknown" || state === "auth-required") return { record, findings: [] };
    record = await desk.accept(orderId, worker);
  }
  let findings: Finding[] = [];
  const reports = (task.artifacts ?? []).flatMap((a) => readParts(a.parts).reports);
  for (const report of reports) {
    if (report.attempt === undefined) throw new AwlError("BAD_REQUEST", "a report sent over A2A must carry its attempt");
  }
  for (const report of reports.sort((a, b) => a.attempt! - b.attempt!)) {
    if (report.attempt! <= record.reports.length) continue;
    if (report.attempt !== record.reports.length + 1) {
      throw new AwlError("BAD_REQUEST", `the task's next report is attempt ${report.attempt}; the desk expects ${record.reports.length + 1}`);
    }
    if (report.order_id !== orderId) throw new AwlError("BAD_REQUEST", `the task carries a report for "${report.order_id}", not "${orderId}"`);
    if (report.from !== worker) throw new AwlError("FORBIDDEN", `the report is from "${report.from}", not "${worker}"`);
    const { spec: _spec, order_id: _id, from: _from, attempt: _attempt, ...input } = report;
    ({ record, findings } = await desk.submitReport(orderId, input as WorkReportInput, worker));
  }
  return { record, findings };
}

const textOf = (parts?: A2APart[]) =>
  parts?.filter((p): p is Extract<A2APart, { kind: "text" }> => p.kind === "text").map((p) => p.text).join("\n") || undefined;
