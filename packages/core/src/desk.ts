// A desk stores orders, applies the lifecycle (SPEC.md §6) and runs the checks (§7, §8).
import { randomUUID } from "node:crypto";
import { AwlError } from "./errors.ts";
import { isTerminal, nextState, ROLE_FOR } from "./lifecycle.ts";
import { MemoryStore } from "./store.ts";
import type { DeskStore } from "./store.ts";
import { hasInvalid, validateChildOrder, validateOrder, validateReport } from "./validate.ts";
import { ORDER_SPEC, REPORT_SPEC } from "./types.ts";
import type {
  Action, AgentRef, Finding, OrderRecord, OrderSummary, State,
  WorkEvent, WorkOrder, WorkOrderInput, WorkReport, WorkReportInput,
} from "./types.ts";

export interface DeskOptions {
  /** Where records live. Default: a new MemoryStore. */
  store?: DeskStore;
  /** Current time. Override in tests. */
  clock?: () => Date;
  /** Generates ids for orders created without one. */
  newId?: () => string;
  /** Called after every recorded event, once it is stored. */
  onEvent?: (event: WorkEvent, record: OrderRecord) => void;
}

export interface ListFilter {
  to?: AgentRef;
  from?: AgentRef;
  state?: State;
  parent_id?: string;
}

export interface WaitOptions {
  timeoutMs?: number;
  pollMs?: number;
  signal?: AbortSignal;
}

export interface SubmitResult {
  record: OrderRecord;
  /** Limit findings (R7, R8) recorded with the report. Empty when within limits. */
  findings: Finding[];
}

export const lastSeq = (record: OrderRecord): number => record.events.at(-1)?.seq ?? 0;

export function summarize(record: OrderRecord): OrderSummary {
  const { id, from, to, goal, deadline, parent_id } = record.order;
  return { id, state: record.state, from, to, goal, deadline, ...(parent_id ? { parent_id } : {}), last_seq: lastSeq(record) };
}

export class WorkDesk {
  readonly store: DeskStore;
  readonly #clock: () => Date;
  readonly #newId: () => string;
  readonly #onEvent?: DeskOptions["onEvent"];

  constructor(options: DeskOptions = {}) {
    this.store = options.store ?? new MemoryStore();
    this.#clock = options.clock ?? (() => new Date());
    this.#newId = options.newId ?? (() => `wo_${randomUUID().replace(/-/g, "").slice(0, 16)}`);
    this.#onEvent = options.onEvent;
  }

  // ---- reads ----------------------------------------------------------------

  /** The full record for an order. Throws NOT_FOUND. */
  async get(id: string): Promise<OrderRecord> {
    const record = await this.store.read(id);
    if (!record) throw new AwlError("NOT_FOUND", `no order "${id}"`);
    return this.#expireIfDue(record);
  }

  /** Summaries of orders matching every given filter field. */
  async list(filter: ListFilter = {}): Promise<OrderSummary[]> {
    const records = await Promise.all((await this.store.list()).map((r) => this.#expireIfDue(r)));
    return records
      .filter((r) =>
        (!filter.to || r.order.to === filter.to) &&
        (!filter.from || r.order.from === filter.from) &&
        (!filter.state || r.state === filter.state) &&
        (!filter.parent_id || r.order.parent_id === filter.parent_id))
      .sort((a, b) => a.order.created_at.localeCompare(b.order.created_at))
      .map(summarize);
  }

  /** Resolves once the order has an event newer than `sinceSeq`, or when the timeout passes. */
  async waitForChange(id: string, sinceSeq: number, options: WaitOptions = {}): Promise<OrderRecord> {
    const { timeoutMs = 25_000, pollMs = 250, signal } = options;
    const until = Date.now() + timeoutMs;
    for (;;) {
      const record = await this.get(id);
      if (lastSeq(record) > sinceSeq || Date.now() >= until || signal?.aborted) return record;
      await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(0, until - Date.now()))));
    }
  }

  // ---- manager actions ------------------------------------------------------

  /** Issues a new order. With `parent_id`, only the parent's worker may create it, and only narrower (§8). */
  async create(input: WorkOrderInput, actor: AgentRef): Promise<OrderRecord> {
    requireActor(actor);
    const order = {
      spec: ORDER_SPEC,
      created_at: this.#now(),
      ...input,
      id: input.id ?? this.#newId(),
      from: actor,
    } as WorkOrder;

    const findings = validateOrder(order);
    if (hasInvalid(findings)) throw new AwlError("VALIDATION_FAILED", "work order rejected", findings);

    if (order.parent_id) {
      const parent = await this.get(order.parent_id);
      if (isTerminal(parent.state)) throw new AwlError("INVALID_TRANSITION", `parent order "${order.parent_id}" is ${parent.state}`);
      if (actor !== parent.order.to) throw new AwlError("FORBIDDEN", `only the parent's worker can split order "${order.parent_id}"`);
      const childFindings = validateChildOrder(order, parent.order);
      if (childFindings.length) throw new AwlError("VALIDATION_FAILED", "sub-order exceeds its parent's authority", childFindings);
    }

    const record: OrderRecord = { order, state: "offered", reports: [], events: [], findings: [] };
    const event = this.#record(record, actor, "create", "offered");
    await this.store.insert(record);
    this.#emit(event, record);
    return record;
  }

  async answer(id: string, actor: AgentRef, answer: string): Promise<OrderRecord> {
    if (!answer?.trim()) throw new AwlError("BAD_REQUEST", "an answer cannot be empty");
    return this.#act(id, "answer", actor, answer);
  }

  async review(id: string, actor: AgentRef, decision: "approve" | "rework", reason?: string): Promise<OrderRecord> {
    if (decision !== "approve" && decision !== "rework") throw new AwlError("BAD_REQUEST", `unknown decision "${decision}"`);
    if (decision === "rework" && !reason?.trim()) throw new AwlError("BAD_REQUEST", "rework needs a reason the worker can act on");
    return this.#act(id, decision, actor, reason);
  }

  async cancel(id: string, actor: AgentRef, reason?: string): Promise<OrderRecord> {
    return this.#act(id, "cancel", actor, reason);
  }

  // ---- worker actions -------------------------------------------------------

  async accept(id: string, actor: AgentRef): Promise<OrderRecord> {
    return this.#act(id, "accept", actor);
  }

  async decline(id: string, actor: AgentRef, reason?: string): Promise<OrderRecord> {
    return this.#act(id, "decline", actor, reason);
  }

  async start(id: string, actor: AgentRef): Promise<OrderRecord> {
    return this.#act(id, "start", actor);
  }

  /**
   * Records a report. Invalid reports throw VALIDATION_FAILED and change nothing.
   * Reports over budget or past the deadline are kept and move the order to `expired`.
   * An `accepted` order is started automatically.
   */
  async submitReport(id: string, input: WorkReportInput, actor: AgentRef): Promise<SubmitResult> {
    requireActor(actor);
    const events: WorkEvent[] = [];
    let findings: Finding[] = [];

    const record = await this.#mutate(id, (rec) => {
      if (rec.state === "accepted") events.push(this.#move(rec, "start", actor));
      if (rec.state !== "working") throw new AwlError("INVALID_TRANSITION", `cannot report on an order that is ${rec.state}`);

      const report = {
        spec: REPORT_SPEC,
        finished_at: this.#now(),
        ...input,
        attempt: rec.reports.length + 1,
        order_id: id,
        from: actor,
      } as WorkReport;

      findings = validateReport(report, rec.order);
      if (hasInvalid(findings)) throw new AwlError("VALIDATION_FAILED", "work report rejected", findings);

      // Permission is checked before anything is recorded.
      events.push(this.#move(rec, `report_${report.status}` as Action, actor, `attempt ${report.attempt}`));
      rec.reports.push(report);
      rec.findings = findings;
      if (findings.length) {
        events.push(this.#record(rec, "desk", "expire", "expired", findings.map((f) => f.message).join("; ")));
      }
    });

    for (const event of events) this.#emit(event, record);
    return { record, findings };
  }

  // ---- internals ------------------------------------------------------------

  #now() {
    return this.#clock().toISOString();
  }

  #emit(event: WorkEvent, record: OrderRecord) {
    this.#onEvent?.(event, structuredClone(record));
  }

  #record(record: OrderRecord, actor: AgentRef, action: WorkEvent["action"], to: State, note?: string): WorkEvent {
    const event: WorkEvent = {
      seq: lastSeq(record) + 1,
      at: this.#now(),
      actor,
      action,
      from: record.events.length ? record.state : null,
      to,
      ...(note ? { note } : {}),
    };
    record.events.push(event);
    record.state = to;
    return event;
  }

  #move(record: OrderRecord, action: Action, actor: AgentRef, note?: string): WorkEvent {
    const { order } = record;
    const role = ROLE_FOR[action];
    const permitted =
      role === "desk" ||
      (role === "worker" && actor === order.to) ||
      (role === "manager" && (actor === order.from || (action === "answer" && actor === order.escalate_to)));
    if (!permitted) throw new AwlError("FORBIDDEN", `"${actor}" may not ${action} order "${order.id}"`);

    const to = nextState(record.state, action);
    if (!to) throw new AwlError("INVALID_TRANSITION", `cannot ${action} an order that is ${record.state}`);
    return this.#record(record, actor, action, to, note);
  }

  async #act(id: string, action: Action, actor: AgentRef, note?: string): Promise<OrderRecord> {
    requireActor(actor);
    let event!: WorkEvent;
    const record = await this.#mutate(id, (rec) => {
      event = this.#move(rec, action, actor, note);
    });
    this.#emit(event, record);
    return record;
  }

  /** Reads, applies `change`, and stores with an optimistic-concurrency check. */
  async #mutate(id: string, change: (record: OrderRecord) => void): Promise<OrderRecord> {
    const record = await this.get(id);
    const expected = lastSeq(record);
    change(record);
    await this.store.update(record, expected);
    return record;
  }

  /** Expires an active order whose deadline has passed (§6 rule 1). */
  async #expireIfDue(record: OrderRecord): Promise<OrderRecord> {
    if (isTerminal(record.state) || this.#clock().getTime() <= Date.parse(record.order.deadline)) return record;
    const expected = lastSeq(record);
    const event = this.#record(record, "desk", "expire", "expired", "deadline passed");
    try {
      await this.store.update(record, expected);
    } catch (e) {
      // Another writer got there first; their version wins.
      if (e instanceof AwlError && e.code === "CONFLICT") return this.get(record.order.id);
      throw e;
    }
    this.#emit(event, record);
    return record;
  }
}

function requireActor(actor: unknown): asserts actor is string {
  if (typeof actor !== "string" || !actor.trim()) throw new AwlError("BAD_REQUEST", "actor is required");
}
