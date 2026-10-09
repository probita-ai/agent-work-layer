// Shared fixtures. Every test builds documents from these so each case changes one thing.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AwlError, ORDER_SPEC, REPORT_SPEC, WorkDesk } from "../src/index.ts";
import type { AwlErrorCode, DeskOptions, Finding, WorkOrder, WorkOrderInput, WorkReport, WorkReportInput } from "../src/index.ts";

export const T0 = "2026-01-01T09:00:00.000Z";
export const DEADLINE = "2026-01-01T12:00:00.000Z";
export const MANAGER = "agent:manager";
export const WORKER = "agent:worker";
export const HELPER = "agent:helper";
export const LEAD = "human:lead";
export const STRANGER = "agent:stranger";

export function orderInput(overrides: Partial<WorkOrderInput> = {}): WorkOrderInput {
  return {
    to: WORKER,
    goal: "Summarize the risk factors in the annual report",
    criteria: [
      { id: "c1", text: "Lists three risk factors with quotes" },
      { id: "c2", text: "States total debt and fiscal year" },
    ],
    budget: { usd: 2, tool_calls: 20 },
    deadline: DEADLINE,
    tools: ["filings/*", "calc/ratio"],
    ...overrides,
  };
}

export function order(overrides: Partial<WorkOrder> = {}): WorkOrder {
  const { id = "wo_1", ...rest } = orderInput();
  return { spec: ORDER_SPEC, id, created_at: T0, from: MANAGER, ...rest, ...overrides } as WorkOrder;
}

export function reportInput(overrides: Partial<WorkReportInput> = {}): WorkReportInput {
  return {
    status: "done",
    result: { summary: "Three risks found; debt 1.2B USD FY2025" },
    evidence: [
      { criterion: "c1", type: "tool_call", ref: "filings/get_section#3" },
      { criterion: "c2", type: "citation", ref: "filings/get_section#5" },
    ],
    cost: { usd: 0.8, tool_calls: 7 },
    tools_used: ["filings/search", "filings/get_section"],
    ...overrides,
  };
}

export function report(overrides: Partial<WorkReport> = {}): WorkReport {
  return {
    spec: REPORT_SPEC,
    order_id: "wo_1",
    from: WORKER,
    finished_at: "2026-01-01T10:00:00.000Z",
    ...reportInput(),
    ...overrides,
  } as WorkReport;
}

/** Sorted rule ids, for comparing findings without caring about order. */
export const rules = (findings: readonly Finding[]) => findings.map((f) => f.rule).sort();

/** Removes one top-level key, for "required field" tests. */
export function without<T extends object>(value: T, key: string): Record<string, unknown> {
  const copy = { ...value } as Record<string, unknown>;
  delete copy[key];
  return copy;
}

export function fakeClock(start = T0) {
  let now = new Date(start).getTime();
  return {
    now: () => new Date(now),
    set: (iso: string) => void (now = new Date(iso).getTime()),
    advance: (ms: number) => void (now += ms),
  };
}

export function newDesk(options: DeskOptions = {}) {
  const clock = fakeClock();
  let n = 0;
  const desk = new WorkDesk({ clock: clock.now, newId: () => `wo_${++n}`, ...options });
  return { desk, clock };
}

/** Creates an order and moves it to `working`. Returns its id. */
export async function workingOrder(desk: WorkDesk, overrides: Partial<WorkOrderInput> = {}) {
  const { order } = await desk.create(orderInput(overrides), MANAGER);
  await desk.accept(order.id, WORKER);
  await desk.start(order.id, WORKER);
  return order.id;
}

export const tempDir = (prefix = "awl-test-") => mkdtempSync(join(tmpdir(), prefix));

/** Asserts a promise rejects with an AwlError of the given code; returns the error. */
export async function rejectsWith(promise: Promise<unknown>, code: AwlErrorCode): Promise<AwlError> {
  try {
    await promise;
  } catch (e) {
    assert.ok(e instanceof AwlError, `expected AwlError, got ${e}`);
    assert.equal(e.code, code, e.message);
    return e;
  }
  assert.fail(`expected rejection with ${code}`);
}
