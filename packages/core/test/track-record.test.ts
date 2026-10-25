import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { HELPER, MANAGER, WORKER, newDesk, orderInput, rejectsWith, reportInput, workingOrder } from "./helpers.ts";

describe("track record", () => {
  test("counts what happened to the orders addressed to a worker", async () => {
    const { desk, clock } = newDesk();

    const first = await workingOrder(desk);
    await desk.submitReport(first, reportInput({ cost: { usd: 0.5, tool_calls: 4 } }), WORKER);
    await desk.review(first, MANAGER, "approve");

    clock.advance(60_000);
    const second = await workingOrder(desk, { budget: { usd: 1, tool_calls: 10, tokens: 5000 } });
    await desk.submitReport(second, reportInput({ status: "failed", evidence: [], error: "Timeout", cost: { usd: 0.25, tool_calls: 2, tokens: 900 } }), WORKER);
    await desk.review(second, MANAGER, "rework", "Try the mirror");
    await desk.submitReport(second, reportInput({ cost: { usd: 0.6, tool_calls: 6, tokens: 3000 } }), WORKER);
    await desk.review(second, MANAGER, "approve");

    const declined = (await desk.create(orderInput(), MANAGER)).order.id;
    await desk.decline(declined, WORKER, "busy");
    const cancelled = await workingOrder(desk);
    await desk.cancel(cancelled, MANAGER);
    await workingOrder(desk);
    await desk.create(orderInput({ to: HELPER }), MANAGER);

    assert.deepEqual(await desk.trackRecord(WORKER), {
      agent: WORKER, orders: 5, active: 1, approved: 2, declined: 1, expired: 0, cancelled: 1, approved_first_time: 1, reworks: 1,
      reports: { done: 2, blocked: 0, failed: 1 },
      spent: { usd: 1.1, tool_calls: 10, tokens: 3000 },
      budget: { usd: 3, tool_calls: 30, tokens: 5000 },
    });

    const recent = await desk.trackRecord(WORKER, { since: "2026-01-01T09:00:30Z" });
    assert.equal(recent.since, "2026-01-01T09:00:30Z");
    assert.deepEqual([recent.orders, recent.approved, recent.approved_first_time], [4, 1, 0]);

    assert.equal((await desk.trackRecord("agent:nobody")).orders, 0);
  });

  test("counts expired orders, and an over-budget report expires its order", async () => {
    const { desk, clock } = newDesk();
    await workingOrder(desk);   // expires at the deadline
    const spent = await workingOrder(desk);
    await desk.submitReport(spent, reportInput({ cost: { usd: 5, tool_calls: 7 } }), WORKER);
    clock.set("2026-01-01T13:00:00Z");
    const record = await desk.trackRecord(WORKER);
    assert.deepEqual([record.orders, record.expired, record.active], [2, 2, 0]);
    assert.deepEqual(record.spent, { usd: 5, tool_calls: 7 });
  });

  test("rejects a bad since", async () => {
    const { desk } = newDesk();
    await rejectsWith(desk.trackRecord(WORKER, { since: "last week" }), "BAD_REQUEST");
    await rejectsWith(desk.trackRecord(""), "BAD_REQUEST");
  });
});
