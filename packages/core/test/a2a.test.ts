// The A2A binding (SPEC.md §9.2, #54).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { STATES, reportSpecFor } from "../src/index.ts";
import type { WorkReport } from "../src/index.ts";
import {
  AWL_A2A_EXTENSION, AWL_MEDIA_TYPES, agentCardExtension, orderPart, readParts, recordTask, reportPart, reviewPart, taskState, taskStatus,
} from "../src/a2a.ts";
import type { A2ADataPart, A2ATask } from "../src/a2a.ts";
import { MANAGER, STRANGER, WORKER, newDesk, order, orderInput, rejectsWith, reportInput } from "./helpers.ts";

/** The report a worker would send over A2A for `orderId`, attempt `attempt`. */
function sent(orderId: string, attempt: number, overrides: Partial<WorkReport> = {}): WorkReport {
  const r = { order_id: orderId, from: WORKER, finished_at: "2026-01-01T10:00:00.000Z", attempt, ...reportInput(), ...overrides };
  return { spec: reportSpecFor(r), ...r } as WorkReport;
}

const task = (state: A2ATask["status"]["state"], reports: WorkReport[] = [], text?: string): A2ATask => ({
  id: "t1",
  status: { state, ...(text ? { message: { parts: [{ kind: "text", text }] } } : {}) },
  artifacts: reports.map((r, i) => ({ artifactId: `r${i + 1}`, parts: [reportPart(r)] })),
});

describe("A2A parts", () => {
  test("orders, reports and reviews round-trip as data parts with their media type", () => {
    const o = order();
    const r = sent(o.id, 1);
    const parts = [orderPart(o), reportPart(r), reviewPart({ order_id: o.id, decision: "rework", reason: "Cite the debt note" }), { kind: "text", text: "hi" }];
    assert.deepEqual(parts.slice(0, 3).map((p) => (p as A2ADataPart).metadata?.mediaType), Object.values(AWL_MEDIA_TYPES));
    assert.deepEqual(readParts(parts), { orders: [o], reports: [r], reviews: [{ order_id: o.id, decision: "rework", reason: "Cite the debt note" }] });
  });

  test("ignores parts without an AWL media type", () => {
    assert.deepEqual(readParts([{ kind: "data", data: order() }, { kind: "file", file: {} }, null]), { orders: [], reports: [], reviews: [] });
  });

  test("rejects an invalid order or report, and a bad review", async () => {
    const bad = { ...orderPart(order()), data: { ...order(), deadline: "2025-01-01T00:00:00Z" } };
    const e = await rejectsWith(Promise.resolve().then(() => readParts([bad])), "VALIDATION_FAILED");
    assert.deepEqual(e.findings.map((f) => f.rule), ["O3"]);
    const r = await rejectsWith(Promise.resolve().then(() => readParts([{ ...reportPart(sent("wo_1", 1)), data: { order_id: "wo_1" } }])), "VALIDATION_FAILED");
    assert.ok(r.findings.length && r.findings.every((f) => f.rule === "R1"));
    assert.throws(() => reviewPart({ order_id: "wo_1", decision: "rework" }), /reason/);
    assert.throws(() => reviewPart({ order_id: "wo_1", decision: "rework", reason: "x", effects: ["gmail/send#1"] }), /only an approval/);
    assert.throws(() => readParts([{ kind: "data", data: { order_id: "wo_1", decision: "maybe" }, metadata: { mediaType: AWL_MEDIA_TYPES.review } }]), /decision/);
  });
});

describe("A2A task states", () => {
  test("every AWL state maps to an A2A task state; the metadata tells blocked from submitted", () => {
    assert.deepEqual(Object.fromEntries(STATES.map((s) => [s, taskState(s)])), {
      offered: "submitted", accepted: "working", working: "working", blocked: "input-required", submitted: "input-required",
      approved: "completed", declined: "rejected", expired: "failed", cancelled: "canceled",
    });
    const record = { order: order(), state: "blocked" as const, reports: [], events: [], findings: [] };
    assert.deepEqual(taskStatus(record), { state: "input-required", metadata: { "awl/state": "blocked", "awl/order": "wo_1" } });
  });

  test("the Agent Card extension names the URI and every version read", () => {
    const x = agentCardExtension();
    assert.equal(x.uri, AWL_A2A_EXTENSION);
    assert.equal(x.required, false);
    assert.ok(x.params.order_specs.includes("awl/work-order@0.1") && x.params.report_specs.includes("awl/work-report@0.3"));
  });
});

describe("recordTask", () => {
  test("accepts, submits each new report once, in order, and follows a rework", async () => {
    const { desk } = newDesk();
    const { order: o } = await desk.create(orderInput(), MANAGER);
    assert.equal((await recordTask(desk, o.id, task("submitted"), WORKER)).record.state, "offered");
    assert.equal((await recordTask(desk, o.id, task("working"), WORKER)).record.state, "accepted");

    const first = sent(o.id, 1);
    assert.equal((await recordTask(desk, o.id, task("input-required", [first]), WORKER)).record.state, "submitted");
    // The same task again changes nothing.
    assert.equal((await recordTask(desk, o.id, task("input-required", [first]), WORKER)).record.reports.length, 1);

    await desk.review(o.id, MANAGER, "rework", "Cite the debt note");
    const { record } = await recordTask(desk, o.id, task("input-required", [sent(o.id, 2), first]), WORKER);
    assert.deepEqual([record.state, record.reports.map((r) => r.attempt)], ["submitted", [1, 2]]);
  });

  test("a rejected task declines the order, with the status text as the reason", async () => {
    const { desk } = newDesk();
    const { order: o } = await desk.create(orderInput(), MANAGER);
    const { record } = await recordTask(desk, o.id, task("rejected", [], "Out of scope"), WORKER);
    assert.deepEqual([record.state, record.events.at(-1)!.note], ["declined", "Out of scope"]);
  });

  test("an over-budget report expires the order, with its limit findings", async () => {
    const { desk } = newDesk();
    const { order: o } = await desk.create(orderInput(), MANAGER);
    const { record, findings } = await recordTask(desk, o.id, task("input-required", [sent(o.id, 1, { cost: { usd: 5, tool_calls: 1 } })]), WORKER);
    assert.deepEqual([record.state, findings.map((f) => f.rule)], ["expired", ["R7"]]);
  });

  test("refuses another agent, a report for another order or from someone else, and a missing or skipped attempt", async () => {
    const { desk } = newDesk();
    const { order: o } = await desk.create(orderInput(), MANAGER);
    await rejectsWith(recordTask(desk, o.id, task("working"), STRANGER), "FORBIDDEN");
    await rejectsWith(recordTask(desk, o.id, task("input-required", [sent("wo_other", 1)]), WORKER), "BAD_REQUEST");
    await rejectsWith(recordTask(desk, o.id, task("input-required", [sent(o.id, 1, { from: STRANGER })]), WORKER), "FORBIDDEN");
    await rejectsWith(recordTask(desk, o.id, task("input-required", [sent(o.id, 1, { attempt: undefined })]), WORKER), "BAD_REQUEST");
    await rejectsWith(recordTask(desk, o.id, task("input-required", [sent(o.id, 2)]), WORKER), "BAD_REQUEST");
  });
});
