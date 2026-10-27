// A desk stores orders, applies the lifecycle (SPEC.md §6) and runs the checks (§7, §8).
import { randomUUID } from "node:crypto";
import { AwlError } from "./errors.ts";
import { isTerminal, nextState, ROLE_FOR } from "./lifecycle.ts";
import { signPass } from "./pass.ts";
import type { PassKey } from "./pass.ts";
import { MemoryStore } from "./store.ts";
import type { DeskStore } from "./store.ts";
import { effectReferences, hasInvalid, heldBySubOrders, validateChildBudgets, validateChildOrder, validateOrder, validateOwnCost, validateReport } from "./validate.ts";
import { UNITS, orderSpecFor, reportSpecFor } from "./types.ts";
import type {
  Action, AgentRef, Amounts, EffectOutcome, Finding, OrderRecord, OrderSummary, State, TrackRecord,
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
  /**
   * Issue Delegation Passes (SPEC.md §10.2): the desk signs a pass for the worker each time an
   * order enters `working`, and `issuePass` renews it. Without this, the desk issues none.
   */
  passes?: PassOptions;
}

export interface PassOptions {
  /** Private signing key (P-256 or Ed25519). */
  key: PassKey;
  /** Goes in each pass's `iss`. */
  issuer: string;
  /** Lifetime in seconds, capped at the order's deadline. Default 900. */
  ttlSeconds?: number;
  kid?: string;
}

export interface ListFilter {
  to?: AgentRef;
  from?: AgentRef;
  state?: State;
  parent_id?: string;
  /** Orders that continue this order id. */
  continues?: string;
}

export interface ReviewOptions {
  /** On approve: the refs of the report's effects to run. Default: all of them (§4.6). */
  effects?: string[];
}

export interface TrackRecordOptions {
  /** Count only orders created at or after this time (RFC 3339). */
  since?: string;
}

export interface WaitOptions {
  timeoutMs?: number;
  pollMs?: number;
  signal?: AbortSignal;
}

export interface SubmitResult {
  record: OrderRecord;
  /** Limit findings (R7, R8, R13) recorded with the report. Empty when within limits. */
  findings: Finding[];
}

export const lastSeq = (record: OrderRecord): number => record.events.at(-1)?.seq ?? 0;

/** The refs of the effects the approval lets run (all of the last report's, unless it chose), in the report's order (§4.6). */
export function approvedEffects(record: OrderRecord): string[] {
  const approve = record.events.findLast((e) => e.action === "approve");
  const listed = (record.reports.at(-1)?.effects ?? []).map((e) => e.ref);
  return approve?.effects ? listed.filter((ref) => approve.effects!.includes(ref)) : listed;
}

/** What is known of each effect from the order's `commit` and `settle` events; the latest wins (§6.4). */
export function effectOutcomes(record: OrderRecord): Map<string, EffectOutcome> {
  const out = new Map<string, EffectOutcome>();
  for (const e of record.events) for (const o of e.outcomes ?? []) out.set(o.ref, o);
  return out;
}

const RAN = new Set<EffectOutcome["outcome"]>(["ok", "error", "skipped", "unknown"]);

export function summarize(record: OrderRecord): OrderSummary {
  const { id, from, to, goal, deadline, parent_id, continues } = record.order;
  return {
    id, state: record.state, from, to, goal, deadline,
    ...(parent_id ? { parent_id } : {}), ...(continues ? { continues } : {}), last_seq: lastSeq(record),
  };
}

export class WorkDesk {
  readonly store: DeskStore;
  readonly #clock: () => Date;
  readonly #newId: () => string;
  readonly #onEvent?: DeskOptions["onEvent"];
  readonly #passes?: PassOptions;

  constructor(options: DeskOptions = {}) {
    this.store = options.store ?? new MemoryStore();
    this.#clock = options.clock ?? (() => new Date());
    this.#newId = options.newId ?? (() => `wo_${randomUUID().replace(/-/g, "").slice(0, 16)}`);
    this.#onEvent = options.onEvent;
    this.#passes = options.passes;
  }

  /** True when this desk signs Delegation Passes. */
  get issuesPasses(): boolean {
    return this.#passes !== undefined;
  }

  // ---- reads ----------------------------------------------------------------

  /** The full record for an order. Throws NOT_FOUND. */
  async get(id: string): Promise<OrderRecord> {
    const record = await this.store.read(id);
    if (!record) throw new AwlError("NOT_FOUND", `no order "${id}"`);
    return this.#expireIfDue(record);
  }

  /** An order's sub-orders with their states. */
  async subOrders(id: string): Promise<OrderRecord[]> {
    return (await this.store.list()).filter((r) => r.order.parent_id === id);
  }

  /** The budget an order's sub-orders hold (§8), which the order itself may not spend. */
  async held(id: string): Promise<Amounts> {
    return heldBySubOrders(await this.subOrders(id));
  }

  /** Summaries of orders matching every given filter field. */
  async list(filter: ListFilter = {}): Promise<OrderSummary[]> {
    const records = await Promise.all((await this.store.list()).map((r) => this.#expireIfDue(r)));
    return records
      .filter((r) =>
        (!filter.to || r.order.to === filter.to) &&
        (!filter.from || r.order.from === filter.from) &&
        (!filter.state || r.state === filter.state) &&
        (!filter.parent_id || r.order.parent_id === filter.parent_id) &&
        (!filter.continues || r.order.continues === filter.continues))
      .sort((a, b) => a.order.created_at.localeCompare(b.order.created_at))
      .map(summarize);
  }

  /** A worker's record on this desk (§6.3): what happened to the orders addressed to it. */
  async trackRecord(agent: AgentRef, options: TrackRecordOptions = {}): Promise<TrackRecord> {
    requireActor(agent);
    const since = options.since === undefined ? undefined : Date.parse(options.since);
    if (since !== undefined && Number.isNaN(since)) throw new AwlError("BAD_REQUEST", `since "${options.since}" is not a timestamp`);
    const records = await Promise.all((await this.store.list()).map((r) => this.#expireIfDue(r)));
    const out: TrackRecord = {
      agent, orders: 0, active: 0, approved: 0, declined: 0, expired: 0, cancelled: 0, approved_first_time: 0, reworks: 0,
      reports: { done: 0, blocked: 0, failed: 0 }, spent: {}, budget: {},
      ...(options.since !== undefined ? { since: options.since } : {}),
    };
    for (const r of records) {
      if (r.order.to !== agent || (since !== undefined && Date.parse(r.order.created_at) < since)) continue;
      out.orders++;
      if (!isTerminal(r.state)) out.active++;
      else out[r.state as "approved" | "declined" | "expired" | "cancelled"]++;
      const reworks = r.events.filter((e) => e.action === "rework").length;
      out.reworks += reworks;
      if (r.state === "approved" && !reworks) out.approved_first_time++;
      for (const report of r.reports) out.reports[report.status]++;
      const latest = r.reports.at(-1);
      if (!latest) continue;
      for (const unit of UNITS) {
        if (latest.cost[unit] !== undefined) out.spent[unit] = round((out.spent[unit] ?? 0) + latest.cost[unit]);
        if (r.order.budget[unit] !== undefined) out.budget[unit] = round((out.budget[unit] ?? 0) + r.order.budget[unit]);
      }
    }
    return out;
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

  /**
   * Issues a new order. With `parent_id`, only the parent's worker may create it, only narrower, and only
   * while the parent's sub-orders together stay within its budget (§8).
   * With `continues`, the earlier order must be finished, be the same manager's, and not be continued yet (§4.5).
   */
  async create(input: WorkOrderInput, actor: AgentRef): Promise<OrderRecord> {
    requireActor(actor);
    const order = {
      spec: orderSpecFor(input),
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
      if (parent.state === "offered") throw new AwlError("INVALID_TRANSITION", `parent order "${order.parent_id}" must be accepted before it can be split`);
      const childFindings = validateChildOrder(order, parent.order);
      if (childFindings.length) throw new AwlError("VALIDATION_FAILED", "sub-order exceeds its parent's authority", childFindings);
      const budgetFindings = validateChildBudgets(order, parent.order, await this.subOrders(order.parent_id));
      if (budgetFindings.length) throw new AwlError("VALIDATION_FAILED", "sub-orders would exceed their parent's budget", budgetFindings);
    }

    if (order.continues) {
      const earlier = await this.get(order.continues);
      if (!isTerminal(earlier.state)) {
        throw new AwlError("INVALID_TRANSITION", `order "${order.continues}" is ${earlier.state}; only a finished order can be continued`);
      }
      if (actor !== earlier.order.from) throw new AwlError("FORBIDDEN", `only the manager of "${order.continues}" can continue it`);
      const next = (await this.store.list()).find((r) => r.order.continues === order.continues);
      if (next) throw new AwlError("ALREADY_EXISTS", `order "${order.continues}" is already continued by "${next.order.id}"`);
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

  /**
   * Approves a submitted report or sends it back for rework. An approval may name the effects to run
   * (§4.6); it must keep every effect that an approved one uses.
   */
  async review(id: string, actor: AgentRef, decision: "approve" | "rework", reason?: string, options: ReviewOptions = {}): Promise<OrderRecord> {
    if (decision !== "approve" && decision !== "rework") throw new AwlError("BAD_REQUEST", `unknown decision "${decision}"`);
    if (decision === "rework" && !reason?.trim()) throw new AwlError("BAD_REQUEST", "rework needs a reason the worker can act on");
    const chosen = options.effects;
    if (chosen === undefined) return this.#act(id, decision, actor, reason);
    if (decision !== "approve") throw new AwlError("BAD_REQUEST", "only an approval can choose effects");
    requireActor(actor);

    let event!: WorkEvent;
    const record = await this.#mutate(id, (rec) => {
      event = this.#move(rec, "approve", actor, reason);
      const listed = rec.reports.at(-1)?.effects ?? [];
      const keep = new Set(chosen);
      for (const ref of keep) {
        if (!listed.some((e) => e.ref === ref)) throw new AwlError("BAD_REQUEST", `the report lists no effect "${ref}"`);
      }
      for (const e of listed) {
        if (!keep.has(e.ref)) continue;
        const missing = effectReferences(e.arguments).find((r) => !keep.has(r.ref));
        if (missing) throw new AwlError("BAD_REQUEST", `effect "${e.ref}" uses the result of "${missing.ref}", which is not approved`);
      }
      // In the report's order, so the record reads the way the effects will run.
      event.effects = listed.filter((e) => keep.has(e.ref)).map((e) => e.ref);
    });
    this.#emit(event, record);
    return record;
  }

  /**
   * Lets the worker's gateway run approved effects once more that never happened: those settled
   * `not_run`, and those `skipped` (§6.4). Each call allows one more try of each effect it names.
   */
  async allowRetry(id: string, actor: AgentRef, effects: string[], reason?: string): Promise<OrderRecord> {
    requireActor(actor);
    let event!: WorkEvent;
    const record = await this.#mutate(id, (rec) => {
      if (actor !== rec.order.from) throw new AwlError("FORBIDDEN", `"${actor}" may not allow retries on order "${id}"`);
      const known = this.#approved(rec, effects, "allow a retry");
      for (const ref of effects) {
        const outcome = known.get(ref)?.outcome;
        if (outcome !== "not_run" && outcome !== "skipped") {
          throw new AwlError("INVALID_TRANSITION", `effect "${ref}" is ${outcome ?? "not run yet"}; only one settled as not_run, or skipped, can be retried`);
        }
      }
      event = this.#record(rec, actor, "allow_retry", "approved", reason);
      event.effects = approvedEffects(rec).filter((ref) => effects.includes(ref));
    });
    this.#emit(event, record);
    return record;
  }

  async cancel(id: string, actor: AgentRef, reason?: string): Promise<OrderRecord> {
    return this.#act(id, "cancel", actor, reason);
  }

  // ---- worker actions -------------------------------------------------------

  /** Records a progress note while the order is `working` (§6.2). Changes no state. */
  async progress(id: string, actor: AgentRef, note: string, percent?: number): Promise<OrderRecord> {
    requireActor(actor);
    if (!note?.trim()) throw new AwlError("BAD_REQUEST", "a progress note cannot be empty");
    if (percent !== undefined && !(Number.isFinite(percent) && percent >= 0 && percent <= 100)) {
      throw new AwlError("BAD_REQUEST", "percent must be between 0 and 100");
    }
    let event!: WorkEvent;
    const record = await this.#mutate(id, (rec) => {
      if (actor !== rec.order.to) throw new AwlError("FORBIDDEN", `"${actor}" may not report progress on order "${id}"`);
      if (rec.state !== "working") throw new AwlError("INVALID_TRANSITION", `cannot report progress on an order that is ${rec.state}`);
      event = this.#record(rec, actor, "progress", "working", note);
      if (percent !== undefined) event.percent = percent;
    });
    this.#emit(event, record);
    return record;
  }

  /** Records what became of approved effects when the worker's gateway ran them (§6.4). Changes no state. */
  async recordCommit(id: string, actor: AgentRef, outcomes: EffectOutcome[]): Promise<OrderRecord> {
    requireActor(actor);
    for (const o of outcomes ?? []) {
      if (!RAN.has(o.outcome)) throw new AwlError("BAD_REQUEST", `a commit records ok, error, skipped or unknown, not "${o.outcome}"`);
    }
    return this.#onEffects(id, actor, "commit", outcomes);
  }

  /**
   * Records what the worker found out about an effect whose outcome was `unknown`: that it happened
   * (`ok`) or did not (`not_run`), with the evidence in `note` (§6.4). Settling never runs it again;
   * only the manager can allow a retry.
   */
  async settle(id: string, actor: AgentRef, ref: string, outcome: "ok" | "not_run", note: string): Promise<OrderRecord> {
    requireActor(actor);
    if (outcome !== "ok" && outcome !== "not_run") throw new AwlError("BAD_REQUEST", `an effect is settled as ok or not_run, not "${outcome}"`);
    if (!note?.trim()) throw new AwlError("BAD_REQUEST", "settling needs a note with the evidence");
    return this.#onEffects(id, actor, "settle", [{ ref, outcome, note }], (known) => {
      const now = known.get(ref)?.outcome;
      if (now !== "unknown") throw new AwlError("INVALID_TRANSITION", `effect "${ref}" is ${now ?? "not run yet"}; only an unknown outcome can be settled`);
    });
  }

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
   * Signs a fresh Delegation Pass for the order's worker while the order is `working`, replacing
   * the current one. Workers call it before the current pass expires. Records no event.
   */
  async issuePass(id: string, actor: AgentRef): Promise<string> {
    requireActor(actor);
    if (!this.#passes) throw new AwlError("BAD_REQUEST", "this desk does not issue passes");
    const record = await this.#mutate(id, async (rec) => {
      if (actor !== rec.order.to) throw new AwlError("FORBIDDEN", `only the order's worker can get its pass`);
      if (rec.state !== "working") throw new AwlError("INVALID_TRANSITION", `no pass for an order that is ${rec.state}`);
      rec.pass = await this.#sign(rec);
    });
    return record.pass!;
  }

  /**
   * Records a report. Invalid reports throw VALIDATION_FAILED and change nothing.
   * Reports over budget or past the deadline are kept and move the order to `expired`. The budget
   * the order's sub-orders hold counts against its own cost (R13).
   * An `accepted` order is started automatically.
   */
  async submitReport(id: string, input: WorkReportInput, actor: AgentRef): Promise<SubmitResult> {
    requireActor(actor);
    const events: WorkEvent[] = [];
    let findings: Finding[] = [];
    const subOrders = await this.subOrders(id);

    const record = await this.#mutate(id, (rec) => {
      if (rec.state === "accepted") events.push(this.#move(rec, "start", actor));
      if (rec.state !== "working") throw new AwlError("INVALID_TRANSITION", `cannot report on an order that is ${rec.state}`);

      const report = {
        spec: reportSpecFor(input),
        finished_at: this.#now(),
        ...input,
        attempt: rec.reports.length + 1,
        order_id: id,
        from: actor,
      } as WorkReport;

      findings = validateReport(report, rec.order);
      if (hasInvalid(findings)) throw new AwlError("VALIDATION_FAILED", "work report rejected", findings);
      findings.push(...validateOwnCost(report, rec.order, subOrders));

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

  #sign(record: OrderRecord): Promise<string> {
    const { key, issuer, ttlSeconds, kid } = this.#passes!;
    return signPass(record.order, key, { issuer, ttlSeconds, kid, attempt: record.reports.length + 1, now: this.#clock() });
  }

  /** A pass is issued on entering `working` and dropped on leaving it; cancel or expiry just stops new ones. */
  async #syncPass(record: OrderRecord, before: State) {
    if (record.state !== "working") delete record.pass;
    else if (this.#passes && before !== "working") record.pass = await this.#sign(record);
  }

  /** The outcomes known so far, once checked that the order is approved and every ref is an approved effect. */
  #approved(record: OrderRecord, refs: string[], what: string): Map<string, EffectOutcome> {
    if (record.state !== "approved") throw new AwlError("INVALID_TRANSITION", `cannot ${what} on an order that is ${record.state}`);
    if (!refs?.length) throw new AwlError("BAD_REQUEST", "name at least one effect");
    if (new Set(refs).size !== refs.length) throw new AwlError("BAD_REQUEST", "each effect may be named once");
    const approved = approvedEffects(record);
    const stray = refs.find((ref) => !approved.includes(ref));
    if (stray) throw new AwlError("BAD_REQUEST", `"${stray}" is not an approved effect of order "${record.order.id}"`);
    return effectOutcomes(record);
  }

  /** Records a worker's `commit` or `settle` event on an approved order. */
  async #onEffects(id: string, actor: AgentRef, action: "commit" | "settle", outcomes: EffectOutcome[], check?: (known: Map<string, EffectOutcome>) => void) {
    let event!: WorkEvent;
    const record = await this.#mutate(id, (rec) => {
      if (actor !== rec.order.to) throw new AwlError("FORBIDDEN", `"${actor}" may not ${action} effects on order "${id}"`);
      const known = this.#approved(rec, (outcomes ?? []).map((o) => o.ref), action === "commit" ? "record effects" : "settle an effect");
      check?.(known);
      event = this.#record(rec, actor, action, "approved");
      event.outcomes = outcomes.map(({ ref, outcome, note }) => ({ ref, outcome, ...(note ? { note } : {}) }));
    });
    this.#emit(event, record);
    return record;
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
  async #mutate(id: string, change: (record: OrderRecord) => void | Promise<void>): Promise<OrderRecord> {
    const record = await this.get(id);
    const expected = lastSeq(record);
    const before = record.state;
    await change(record);
    await this.#syncPass(record, before);
    await this.store.update(record, expected);
    return record;
  }

  /** Expires an active order whose deadline has passed (§6 rule 1). */
  async #expireIfDue(record: OrderRecord): Promise<OrderRecord> {
    if (isTerminal(record.state) || this.#clock().getTime() <= Date.parse(record.order.deadline)) return record;
    const expected = lastSeq(record);
    const event = this.#record(record, "desk", "expire", "expired", "deadline passed");
    delete record.pass;
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

const round = (n: number) => Number(n.toFixed(9));

function requireActor(actor: unknown): asserts actor is string {
  if (typeof actor !== "string" || !actor.trim()) throw new AwlError("BAD_REQUEST", "actor is required");
}
