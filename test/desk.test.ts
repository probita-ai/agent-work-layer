import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lastSeq, MemoryStore, ORDER_SPEC, WorkDesk } from "../src/index.ts";
import type { WorkEvent } from "../src/index.ts";
import {
  DEADLINE, HELPER, LEAD, MANAGER, STRANGER, T0, WORKER,
  newDesk, orderInput, rejectsWith, reportInput, workingOrder,
} from "./helpers.ts";

describe("create", () => {
  test("fills spec, id, created_at and from", async () => {
    const { desk } = newDesk();
    const { order, state, events } = await desk.create(orderInput(), MANAGER);
    assert.equal(order.spec, ORDER_SPEC);
    assert.equal(order.id, "wo_1");
    assert.equal(order.created_at, T0);
    assert.equal(order.from, MANAGER);
    assert.equal(state, "offered");
    assert.deepEqual(events, [{ seq: 1, at: T0, actor: MANAGER, action: "create", from: null, to: "offered" }]);
  });

  test("keeps an explicit id", async () => {
    const { desk } = newDesk();
    assert.equal((await desk.create(orderInput({ id: "credit-review-7" }), MANAGER)).order.id, "credit-review-7");
  });

  test("the actor is always the manager, whatever the input says", async () => {
    const { desk } = newDesk();
    const input = { ...orderInput(), from: STRANGER } as never;
    assert.equal((await desk.create(input, MANAGER)).order.from, MANAGER);
  });

  test("uses a random id by default", async () => {
    const desk = new WorkDesk();
    const a = await desk.create(orderInput({ deadline: "2999-01-01T00:00:00Z" }), MANAGER);
    const b = await desk.create(orderInput({ deadline: "2999-01-01T00:00:00Z" }), MANAGER);
    assert.match(a.order.id, /^wo_[0-9a-f]{16}$/);
    assert.notEqual(a.order.id, b.order.id);
  });

  test("rejects a duplicate id", async () => {
    const { desk } = newDesk();
    await desk.create(orderInput({ id: "dup" }), MANAGER);
    await rejectsWith(desk.create(orderInput({ id: "dup" }), MANAGER), "ALREADY_EXISTS");
  });

  test("rejects an invalid order with findings", async () => {
    const { desk } = newDesk();
    const err = await rejectsWith(desk.create(orderInput({ criteria: [] }), MANAGER), "VALIDATION_FAILED");
    assert.equal(err.findings[0].rule, "O1");
  });

  test("rejects a deadline already in the past", async () => {
    const { desk } = newDesk();
    const err = await rejectsWith(desk.create(orderInput({ deadline: "2025-01-01T00:00:00Z" }), MANAGER), "VALIDATION_FAILED");
    assert.equal(err.findings[0].rule, "O3");
  });

  test("requires an actor", async () => {
    const { desk } = newDesk();
    for (const actor of ["", "   ", undefined as unknown as string]) {
      await rejectsWith(desk.create(orderInput(), actor), "BAD_REQUEST");
    }
  });
});

describe("reads", () => {
  test("get throws NOT_FOUND for an unknown id", async () => {
    await rejectsWith(newDesk().desk.get("nope"), "NOT_FOUND");
  });

  test("returned records are copies", async () => {
    const { desk } = newDesk();
    const rec = await desk.create(orderInput(), MANAGER);
    rec.order.goal = "changed";
    rec.state = "approved";
    const fresh = await desk.get(rec.order.id);
    assert.equal(fresh.state, "offered");
    assert.notEqual(fresh.order.goal, "changed");
  });

  test("list filters by to, from, state and parent", async () => {
    const { desk } = newDesk();
    await desk.create(orderInput(), MANAGER);
    await desk.create(orderInput({ to: HELPER }), MANAGER);
    await desk.create(orderInput(), LEAD);
    await desk.accept("wo_1", WORKER);

    assert.deepEqual((await desk.list()).map((s) => s.id), ["wo_1", "wo_2", "wo_3"]);
    assert.deepEqual((await desk.list({ to: WORKER })).map((s) => s.id), ["wo_1", "wo_3"]);
    assert.deepEqual((await desk.list({ from: LEAD })).map((s) => s.id), ["wo_3"]);
    assert.deepEqual((await desk.list({ to: WORKER, state: "offered" })).map((s) => s.id), ["wo_3"]);
    assert.deepEqual(await desk.list({ parent_id: "wo_1" }), []);
  });

  test("list returns summaries", async () => {
    const { desk } = newDesk();
    await desk.create(orderInput(), MANAGER);
    assert.deepEqual(await desk.list(), [
      { id: "wo_1", state: "offered", from: MANAGER, to: WORKER, goal: orderInput().goal, deadline: DEADLINE, last_seq: 1 },
    ]);
  });
});

describe("lifecycle through the desk", () => {
  test("happy path: offer, accept, start, report, approve", async () => {
    const { desk } = newDesk();
    const id = await workingOrder(desk);
    const { record, findings } = await desk.submitReport(id, reportInput(), WORKER);
    assert.equal(record.state, "submitted");
    assert.deepEqual(findings, []);
    const done = await desk.review(id, MANAGER, "approve");
    assert.equal(done.state, "approved");
    assert.deepEqual(done.events.map((e) => [e.seq, e.action, e.to]), [
      [1, "create", "offered"], [2, "accept", "accepted"], [3, "start", "working"],
      [4, "report_done", "submitted"], [5, "approve", "approved"],
    ]);
  });

  test("the report gets spec, order_id, from, attempt and finished_at", async () => {
    const { desk, clock } = newDesk();
    const id = await workingOrder(desk);
    clock.set("2026-01-01T10:30:00Z");
    const { record } = await desk.submitReport(id, reportInput(), WORKER);
    const [r] = record.reports;
    assert.equal(r.spec, "awl/work-report@0.1");
    assert.equal(r.order_id, id);
    assert.equal(r.from, WORKER);
    assert.equal(r.attempt, 1);
    assert.equal(r.finished_at, "2026-01-01T10:30:00.000Z");
  });

  test("a worker-supplied finished_at is kept", async () => {
    const { desk } = newDesk();
    const id = await workingOrder(desk);
    const { record } = await desk.submitReport(id, reportInput({ finished_at: "2026-01-01T09:45:00Z" }), WORKER);
    assert.equal(record.reports[0].finished_at, "2026-01-01T09:45:00Z");
  });

  test("decline ends the order", async () => {
    const { desk } = newDesk();
    await desk.create(orderInput(), MANAGER);
    const rec = await desk.decline("wo_1", WORKER, "outside my skills");
    assert.equal(rec.state, "declined");
    assert.equal(rec.events.at(-1)!.note, "outside my skills");
  });

  test("rework returns to working and numbers attempts", async () => {
    const { desk } = newDesk();
    const id = await workingOrder(desk);
    await desk.submitReport(id, reportInput(), WORKER);
    const back = await desk.review(id, MANAGER, "rework", "Quote the debt note");
    assert.equal(back.state, "working");
    assert.equal(back.events.at(-1)!.note, "Quote the debt note");
    const { record } = await desk.submitReport(id, reportInput(), WORKER);
    assert.deepEqual(record.reports.map((r) => r.attempt), [1, 2]);
  });

  test("rework needs a reason", async () => {
    const { desk } = newDesk();
    const id = await workingOrder(desk);
    await desk.submitReport(id, reportInput(), WORKER);
    await rejectsWith(desk.review(id, MANAGER, "rework"), "BAD_REQUEST");
    await rejectsWith(desk.review(id, MANAGER, "rework", "  "), "BAD_REQUEST");
  });

  test("review rejects an unknown decision", async () => {
    const { desk } = newDesk();
    const id = await workingOrder(desk);
    await desk.submitReport(id, reportInput(), WORKER);
    await rejectsWith(desk.review(id, MANAGER, "maybe" as never), "BAD_REQUEST");
  });

  test("blocked, answered, then done", async () => {
    const { desk } = newDesk();
    const id = await workingOrder(desk);
    const blocked = reportInput({ status: "blocked", evidence: [], questions: ["Which fiscal year?"], cost: { usd: 0.1, tool_calls: 1 } });
    assert.equal((await desk.submitReport(id, blocked, WORKER)).record.state, "blocked");
    const answered = await desk.answer(id, MANAGER, "FY2025");
    assert.equal(answered.state, "working");
    assert.equal(answered.events.at(-1)!.note, "FY2025");
    assert.equal((await desk.submitReport(id, reportInput(), WORKER)).record.state, "submitted");
  });

  test("an empty answer is refused", async () => {
    const { desk } = newDesk();
    const id = await workingOrder(desk);
    await desk.submitReport(id, reportInput({ status: "blocked", evidence: [], questions: ["?"] }), WORKER);
    await rejectsWith(desk.answer(id, MANAGER, ""), "BAD_REQUEST");
  });

  test("a failed report is submitted for the manager to decide", async () => {
    const { desk } = newDesk();
    const id = await workingOrder(desk);
    const { record } = await desk.submitReport(id, reportInput({ status: "failed", evidence: [], error: "source offline" }), WORKER);
    assert.equal(record.state, "submitted");
    assert.equal((await desk.cancel(id, MANAGER, "retry tomorrow")).state, "cancelled");
  });

  test("reporting on an accepted order starts it automatically", async () => {
    const { desk } = newDesk();
    await desk.create(orderInput(), MANAGER);
    await desk.accept("wo_1", WORKER);
    const { record } = await desk.submitReport("wo_1", reportInput(), WORKER);
    assert.deepEqual(record.events.slice(-2).map((e) => e.action), ["start", "report_done"]);
  });

  test("reporting on an offered order is refused", async () => {
    const { desk } = newDesk();
    await desk.create(orderInput(), MANAGER);
    await rejectsWith(desk.submitReport("wo_1", reportInput(), WORKER), "INVALID_TRANSITION");
  });

  test("actions out of order are refused", async () => {
    const { desk } = newDesk();
    await desk.create(orderInput(), MANAGER);
    await rejectsWith(desk.start("wo_1", WORKER), "INVALID_TRANSITION");
    await rejectsWith(desk.review("wo_1", MANAGER, "approve"), "INVALID_TRANSITION");
    await rejectsWith(desk.answer("wo_1", MANAGER, "x"), "INVALID_TRANSITION");
  });

  for (const stage of ["offered", "accepted", "working", "blocked", "submitted"] as const) {
    test(`the manager can cancel from ${stage}`, async () => {
      const { desk } = newDesk();
      await desk.create(orderInput(), MANAGER);
      if (stage !== "offered") await desk.accept("wo_1", WORKER);
      if (["working", "blocked", "submitted"].includes(stage)) await desk.start("wo_1", WORKER);
      if (stage === "blocked") await desk.submitReport("wo_1", reportInput({ status: "blocked", evidence: [], questions: ["?"] }), WORKER);
      if (stage === "submitted") await desk.submitReport("wo_1", reportInput(), WORKER);
      assert.equal((await desk.get("wo_1")).state, stage);
      assert.equal((await desk.cancel("wo_1", MANAGER)).state, "cancelled");
    });
  }

  test("nothing happens to a finished order", async () => {
    const { desk } = newDesk();
    const id = await workingOrder(desk);
    await desk.submitReport(id, reportInput(), WORKER);
    await desk.review(id, MANAGER, "approve");
    await rejectsWith(desk.cancel(id, MANAGER), "INVALID_TRANSITION");
    await rejectsWith(desk.submitReport(id, reportInput(), WORKER), "INVALID_TRANSITION");
    await rejectsWith(desk.review(id, MANAGER, "rework", "again"), "INVALID_TRANSITION");
  });
});

describe("permissions", () => {
  test("only the worker can accept, decline, start and report", async () => {
    const { desk } = newDesk();
    await desk.create(orderInput(), MANAGER);
    for (const actor of [MANAGER, STRANGER]) {
      await rejectsWith(desk.accept("wo_1", actor), "FORBIDDEN");
      await rejectsWith(desk.decline("wo_1", actor), "FORBIDDEN");
    }
    await desk.accept("wo_1", WORKER);
    await rejectsWith(desk.start("wo_1", MANAGER), "FORBIDDEN");
    await desk.start("wo_1", WORKER);
    await rejectsWith(desk.submitReport("wo_1", reportInput(), MANAGER), "FORBIDDEN");
  });

  test("a worker cannot approve its own work", async () => {
    const { desk } = newDesk();
    const id = await workingOrder(desk);
    await desk.submitReport(id, reportInput(), WORKER);
    await rejectsWith(desk.review(id, WORKER, "approve"), "FORBIDDEN");
    await rejectsWith(desk.cancel(id, WORKER), "FORBIDDEN");
  });

  test("the escalation contact can answer but not approve or cancel", async () => {
    const { desk } = newDesk();
    const id = await workingOrder(desk, { escalate_to: LEAD });
    await desk.submitReport(id, reportInput({ status: "blocked", evidence: [], questions: ["?"] }), WORKER);
    await rejectsWith(desk.answer(id, STRANGER, "x"), "FORBIDDEN");
    assert.equal((await desk.answer(id, LEAD, "use FY2025")).state, "working");
    await desk.submitReport(id, reportInput(), WORKER);
    await rejectsWith(desk.review(id, LEAD, "approve"), "FORBIDDEN");
    await rejectsWith(desk.cancel(id, LEAD), "FORBIDDEN");
  });

  test("the manager can still answer when an escalation contact is set", async () => {
    const { desk } = newDesk();
    const id = await workingOrder(desk, { escalate_to: LEAD });
    await desk.submitReport(id, reportInput({ status: "blocked", evidence: [], questions: ["?"] }), WORKER);
    assert.equal((await desk.answer(id, MANAGER, "ok")).state, "working");
  });

  test("a refused report changes nothing", async () => {
    const { desk } = newDesk();
    const id = await workingOrder(desk);
    const before = await desk.get(id);
    await rejectsWith(desk.submitReport(id, reportInput(), STRANGER), "FORBIDDEN");
    assert.deepEqual(await desk.get(id), before);
  });
});

describe("checks applied by the desk", () => {
  test("an invalid report is rejected and nothing is stored", async () => {
    const { desk } = newDesk();
    const id = await workingOrder(desk);
    const err = await rejectsWith(desk.submitReport(id, reportInput({ tools_used: ["web/browse"] }), WORKER), "VALIDATION_FAILED");
    assert.equal(err.findings[0].rule, "R5");
    const rec = await desk.get(id);
    assert.equal(rec.state, "working");
    assert.equal(rec.reports.length, 0);
    assert.equal(lastSeq(rec), 3);
  });

  test("the worker can fix a rejected report and resubmit", async () => {
    const { desk } = newDesk();
    const id = await workingOrder(desk);
    await rejectsWith(desk.submitReport(id, reportInput({ evidence: [] }), WORKER), "VALIDATION_FAILED");
    const { record } = await desk.submitReport(id, reportInput(), WORKER);
    assert.equal(record.reports[0].attempt, 1);
  });

  test("an over-budget report is kept and the order expires", async () => {
    const { desk } = newDesk();
    const id = await workingOrder(desk);
    const { record, findings } = await desk.submitReport(id, reportInput({ cost: { usd: 5, tool_calls: 7 } }), WORKER);
    assert.equal(record.state, "expired");
    assert.equal(record.reports.length, 1);
    assert.deepEqual(findings.map((f) => f.rule), ["R7"]);
    assert.deepEqual(record.findings, findings);
    const last = record.events.at(-1)!;
    assert.equal(last.actor, "desk");
    assert.match(last.note!, /spent 5 usd/);
  });

  test("a report finishing after the deadline expires the order", async () => {
    const { desk } = newDesk();
    const id = await workingOrder(desk);
    const { record } = await desk.submitReport(id, reportInput({ finished_at: "2026-01-01T12:30:00Z" }), WORKER);
    assert.equal(record.state, "expired");
  });

  test("an order expires on read once the deadline passes", async () => {
    const { desk, clock } = newDesk();
    await desk.create(orderInput(), MANAGER);
    clock.set(DEADLINE);
    assert.equal((await desk.get("wo_1")).state, "offered");
    clock.advance(1);
    const rec = await desk.get("wo_1");
    assert.equal(rec.state, "expired");
    assert.deepEqual(rec.events.at(-1), { seq: 2, at: "2026-01-01T12:00:00.001Z", actor: "desk", action: "expire", from: "offered", to: "expired", note: "deadline passed" });
  });

  test("expiry is recorded once", async () => {
    const { desk, clock } = newDesk();
    await desk.create(orderInput(), MANAGER);
    clock.set("2026-01-02T00:00:00Z");
    await desk.get("wo_1");
    await desk.get("wo_1");
    await desk.list();
    assert.equal(lastSeq(await desk.get("wo_1")), 2);
  });

  test("list expires overdue orders too", async () => {
    const { desk, clock } = newDesk();
    await desk.create(orderInput(), MANAGER);
    clock.set("2026-01-02T00:00:00Z");
    assert.equal((await desk.list())[0].state, "expired");
  });

  test("acting on an overdue order fails with the expiry recorded", async () => {
    const { desk, clock } = newDesk();
    const id = await workingOrder(desk);
    clock.set("2026-01-02T00:00:00Z");
    await rejectsWith(desk.submitReport(id, reportInput(), WORKER), "INVALID_TRANSITION");
    assert.equal((await desk.get(id)).state, "expired");
  });
});

describe("sub-orders", () => {
  const childInput = (overrides = {}) =>
    orderInput({ to: HELPER, parent_id: "wo_1", budget: { usd: 0.5, tool_calls: 5 }, tools: ["calc/ratio"], ...overrides });

  test("the parent's worker can split the job", async () => {
    const { desk } = newDesk();
    await workingOrder(desk);
    const child = await desk.create(childInput(), WORKER);
    assert.equal(child.order.from, WORKER);
    assert.deepEqual((await desk.list({ parent_id: "wo_1" })).map((s) => s.id), [child.order.id]);
  });

  test("the parent's manager cannot split it", async () => {
    const { desk } = newDesk();
    await workingOrder(desk);
    await rejectsWith(desk.create(childInput(), MANAGER), "FORBIDDEN");
  });

  test("a sub-order cannot exceed its parent", async () => {
    const { desk } = newDesk();
    await workingOrder(desk);
    const err = await rejectsWith(desk.create(childInput({ tools: ["calc/*"], budget: { usd: 9, tool_calls: 5 } }), WORKER), "VALIDATION_FAILED");
    assert.deepEqual(err.findings.map((f) => f.rule).sort(), ["C1", "C2"]);
  });

  test("the parent must exist", async () => {
    const { desk } = newDesk();
    await rejectsWith(desk.create(childInput({ parent_id: "missing" }), WORKER), "NOT_FOUND");
  });

  test("a finished parent cannot be split", async () => {
    const { desk } = newDesk();
    await desk.create(orderInput(), MANAGER);
    await desk.cancel("wo_1", MANAGER);
    await rejectsWith(desk.create(childInput(), WORKER), "INVALID_TRANSITION");
  });
});

describe("events", () => {
  test("onEvent sees every stored event in order", async () => {
    const seen: WorkEvent[] = [];
    const { desk } = newDesk({ onEvent: (e) => seen.push(e) });
    const id = await workingOrder(desk);
    await desk.submitReport(id, reportInput({ cost: { usd: 9, tool_calls: 1 } }), WORKER);
    assert.deepEqual(seen.map((e) => e.seq), [1, 2, 3, 4, 5]);
    assert.deepEqual(seen.map((e) => e.action), ["create", "accept", "start", "report_done", "expire"]);
  });

  test("onEvent is not called for refused actions", async () => {
    const seen: WorkEvent[] = [];
    const { desk } = newDesk({ onEvent: (e) => seen.push(e) });
    await desk.create(orderInput(), MANAGER);
    await rejectsWith(desk.accept("wo_1", STRANGER), "FORBIDDEN");
    assert.equal(seen.length, 1);
  });

  test("onEvent receives a copy of the record", async () => {
    const { desk } = newDesk({ onEvent: (_e, rec) => void (rec.state = "approved") });
    await desk.create(orderInput(), MANAGER);
    assert.equal((await desk.get("wo_1")).state, "offered");
  });
});

describe("waitForChange", () => {
  test("resolves when another party acts", async () => {
    const desk = new WorkDesk();
    const { order } = await desk.create(orderInput({ deadline: "2999-01-01T00:00:00Z" }), MANAGER);
    const waiting = desk.waitForChange(order.id, 1, { pollMs: 5, timeoutMs: 2000 });
    setTimeout(() => void desk.accept(order.id, WORKER), 20);
    assert.equal((await waiting).state, "accepted");
  });

  test("returns immediately when already newer", async () => {
    const { desk } = newDesk();
    await desk.create(orderInput(), MANAGER);
    const started = Date.now();
    await desk.waitForChange("wo_1", 0, { timeoutMs: 5000 });
    assert.ok(Date.now() - started < 1000);
  });

  test("returns the unchanged record on timeout", async () => {
    const desk = new WorkDesk();
    const { order } = await desk.create(orderInput({ deadline: "2999-01-01T00:00:00Z" }), MANAGER);
    const rec = await desk.waitForChange(order.id, 1, { timeoutMs: 30, pollMs: 5 });
    assert.equal(lastSeq(rec), 1);
  });

  test("stops when the signal aborts", async () => {
    const desk = new WorkDesk();
    const { order } = await desk.create(orderInput({ deadline: "2999-01-01T00:00:00Z" }), MANAGER);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const started = Date.now();
    await desk.waitForChange(order.id, 1, { timeoutMs: 10_000, pollMs: 5, signal: controller.signal });
    assert.ok(Date.now() - started < 2000);
  });
});

describe("concurrency", () => {
  test("a stale write is refused with CONFLICT", async () => {
    const store = new MemoryStore();
    const { desk } = newDesk({ store });
    await desk.create(orderInput(), MANAGER);
    const stale = (await store.read("wo_1"))!;
    await desk.accept("wo_1", WORKER);
    await rejectsWith(store.update(stale, 1), "CONFLICT");
  });

  test("when two desks expire the same order, the first write wins", async () => {
    const store = new MemoryStore();
    const a = newDesk({ store });
    const b = newDesk({ store });
    await a.desk.create(orderInput(), MANAGER);
    const original = store.read.bind(store);
    let staleReads = 1;
    // Desk b reads the order, then desk a expires it before b writes.
    store.read = async (id) => {
      const rec = await original(id);
      if (staleReads-- === 1) await a.desk.get(id);
      return rec;
    };
    a.clock.set("2026-01-02T00:00:00Z");
    b.clock.set("2026-01-02T00:00:00Z");
    const rec = await b.desk.get("wo_1");
    assert.equal(rec.state, "expired");
    assert.equal(lastSeq(rec), 2);
    assert.equal(rec.events.at(-1)!.at, "2026-01-02T00:00:00.000Z");
  });
});
