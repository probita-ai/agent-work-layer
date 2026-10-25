import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lastSeq } from "../src/index.ts";
import { MANAGER, WORKER, newDesk, orderInput, rejectsWith, reportInput, workingOrder } from "./helpers.ts";

describe("progress events", () => {
  test("the worker posts notes while working; they change no state", async () => {
    const seen: string[] = [];
    const { desk } = newDesk({ onEvent: (e) => seen.push(e.action) });
    const id = await workingOrder(desk);
    const before = lastSeq(await desk.get(id));

    const record = await desk.progress(id, WORKER, "Read the 10-K; extracting risk factors", 40);
    assert.equal(record.state, "working");
    assert.deepEqual(record.events.at(-1), {
      seq: before + 1, at: record.events.at(-1)!.at, actor: WORKER, action: "progress", from: "working", to: "working",
      note: "Read the 10-K; extracting risk factors", percent: 40,
    });
    assert.equal("percent" in (await desk.progress(id, WORKER, "Checking the debt note")).events.at(-1)!, false);
    assert.deepEqual(seen.slice(-2), ["progress", "progress"]);

    await desk.submitReport(id, reportInput(), WORKER);
    assert.equal((await desk.get(id)).state, "submitted");
  });

  test("wakes a manager waiting for changes", async () => {
    const { desk } = newDesk();
    const id = await workingOrder(desk);
    const waiting = desk.waitForChange(id, lastSeq(await desk.get(id)), { timeoutMs: 2000, pollMs: 5 });
    await desk.progress(id, WORKER, "Halfway", 50);
    assert.equal((await waiting).events.at(-1)!.action, "progress");
  });

  test("only the worker, only while working, and only with a note", async () => {
    const { desk } = newDesk();
    const id = await workingOrder(desk);
    await rejectsWith(desk.progress(id, MANAGER, "Nudging"), "FORBIDDEN");
    await rejectsWith(desk.progress(id, WORKER, "  "), "BAD_REQUEST");
    await rejectsWith(desk.progress(id, WORKER, "Done-ish", 101), "BAD_REQUEST");
    await rejectsWith(desk.progress(id, WORKER, "Done-ish", Number.NaN), "BAD_REQUEST");

    const offered = (await desk.create(orderInput(), MANAGER)).order.id;
    await rejectsWith(desk.progress(offered, WORKER, "Starting"), "INVALID_TRANSITION");
    await desk.submitReport(id, reportInput({ status: "blocked", evidence: [], questions: ["Which year?"] }), WORKER);
    await rejectsWith(desk.progress(id, WORKER, "Still waiting"), "INVALID_TRANSITION");
    await rejectsWith(desk.progress("missing", WORKER, "Hello"), "NOT_FOUND");
  });
});
