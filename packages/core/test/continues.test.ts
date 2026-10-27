import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ORDER_SPEC, validateOrder } from "../src/index.ts";
import { HELPER, MANAGER, STRANGER, WORKER, newDesk, order, orderInput, rejectsWith, reportInput, workingOrder } from "./helpers.ts";

describe("continues", () => {
  test("is part of the order format since v0.3, and older versions still validate", () => {
    assert.equal(ORDER_SPEC, "awl/work-order@0.4");
    assert.deepEqual(validateOrder(order({ spec: "awl/work-order@0.3", continues: "wo_0" })), []);
    assert.deepEqual(validateOrder(order({ continues: "wo_0" })), []);
    assert.deepEqual(validateOrder(order({ spec: "awl/work-order@0.2" })), []);
    assert.equal(validateOrder(order({ continues: "" }))[0].rule, "O1");
  });

  test("links a chain of three orders that a manager can follow", async () => {
    const { desk } = newDesk();
    const handoff = { summary: "Parser done; export runs out of memory", next_step: "Stream rows" };

    const first = await workingOrder(desk);
    await desk.submitReport(first, reportInput({ status: "failed", evidence: [], error: "Out of memory", handoff }), WORKER);
    // A failed report leaves the order submitted; the manager ends it before reissuing.
    await rejectsWith(desk.create(orderInput({ to: HELPER, continues: first }), MANAGER), "INVALID_TRANSITION");
    await desk.cancel(first, MANAGER, "reissuing to another worker");

    const second = (await desk.create(orderInput({ to: HELPER, continues: first, handoff }), MANAGER)).order;
    assert.equal(second.continues, first);
    assert.equal(second.spec, "awl/work-order@0.3");
    await desk.decline(second.id, HELPER, "busy");

    // A different worker, budget and tools: no narrowing applies.
    const third = (await desk.create(orderInput({ to: STRANGER, continues: second.id, budget: { usd: 50 }, tools: ["*"] }), MANAGER)).order;

    const chain = [first];
    for (let next = await desk.list({ continues: first }); next.length; next = await desk.list({ continues: next[0].id })) chain.push(next[0].id);
    assert.deepEqual(chain, [first, second.id, third.id]);
    assert.equal((await desk.list({ continues: second.id }))[0].continues, second.id);
  });

  test("refuses an order that is still live", async () => {
    const { desk } = newDesk();
    const live = await workingOrder(desk);
    const err = await rejectsWith(desk.create(orderInput({ continues: live }), MANAGER), "INVALID_TRANSITION");
    assert.match(err.message, /working/);
    const offered = (await desk.create(orderInput(), MANAGER)).order.id;
    await rejectsWith(desk.create(orderInput({ continues: offered }), MANAGER), "INVALID_TRANSITION");
  });

  test("accepts every terminal state", async () => {
    const { desk, clock } = newDesk();
    const approved = await workingOrder(desk);
    await desk.submitReport(approved, reportInput(), WORKER);
    await desk.review(approved, MANAGER, "approve");
    const declined = (await desk.create(orderInput(), MANAGER)).order.id;
    await desk.decline(declined, WORKER);
    const cancelled = (await desk.create(orderInput(), MANAGER)).order.id;
    await desk.cancel(cancelled, MANAGER);
    const expired = (await desk.create(orderInput({ deadline: new Date(clock.now().getTime() + 60_000).toISOString() }), MANAGER)).order.id;
    clock.advance(120_000);

    for (const id of [approved, declined, cancelled, expired]) {
      const next = await desk.create(orderInput({ continues: id, deadline: new Date(clock.now().getTime() + 3_600_000).toISOString() }), MANAGER);
      assert.equal(next.order.continues, id);
    }
  });

  test("refuses an unknown order, another manager, and a second continuation", async () => {
    const { desk } = newDesk();
    await rejectsWith(desk.create(orderInput({ continues: "wo_missing" }), MANAGER), "NOT_FOUND");
    const done = (await desk.create(orderInput(), MANAGER)).order.id;
    await desk.cancel(done, MANAGER);
    await rejectsWith(desk.create(orderInput({ continues: done }), STRANGER), "FORBIDDEN");
    await desk.create(orderInput({ continues: done }), MANAGER);
    const err = await rejectsWith(desk.create(orderInput({ continues: done }), MANAGER), "ALREADY_EXISTS");
    assert.match(err.message, /already continued/);
    assert.equal((await desk.list({ continues: done })).length, 1);
  });

  test("works together with parent_id: a sub-order reissued under the same parent", async () => {
    const { desk } = newDesk();
    const parent = await workingOrder(desk);
    const child = (await desk.create(orderInput({ to: HELPER, parent_id: parent, budget: { usd: 1, tool_calls: 5 }, tools: ["filings/search"] }), WORKER)).order.id;
    await desk.decline(child, HELPER);
    const again = await desk.create(orderInput({ to: STRANGER, parent_id: parent, continues: child, budget: { usd: 1, tool_calls: 5 }, tools: ["filings/search"] }), WORKER);
    assert.deepEqual([again.order.parent_id, again.order.continues], [parent, child]);
  });
});
