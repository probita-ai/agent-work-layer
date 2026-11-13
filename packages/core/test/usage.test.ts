// Reports checked against what the order's gateway measured (SPEC.md §7.3, R17–R19, #53).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { FileStore, SqliteStore, lastSeq, validateReport, validateUsage } from "../src/index.ts";
import type { MeasuredUsage } from "../src/index.ts";
import { MANAGER, WORKER, newDesk, order, rejectsWith, report, reportInput, rules, tempDir, workingOrder } from "./helpers.ts";

const measured = (overrides: Partial<MeasuredUsage> = {}): MeasuredUsage => ({
  tool_calls: 5,
  seconds: 120,
  tools_used: ["filings/search", "filings/get_section"],
  refs: ["filings/search#1", "filings/get_section#2", "filings/get_section#3", "filings/search#4", "filings/get_section#5"],
  ...overrides,
});

describe("validateUsage (R17–R19)", () => {
  test("a report that matches what the gateway measured, or claims more, passes", () => {
    assert.deepEqual(validateUsage(report({ cost: { usd: 0.8, tool_calls: 7, seconds: 300 } }), measured()), []);
    assert.deepEqual(validateReport(report(), order(), { usage: measured() }), []);
  });

  test("R17: tool_call evidence must name a logged call; other evidence types are not checked", () => {
    const r = report({ evidence: [
      { criterion: "c1", type: "tool_call", ref: "filings/get_section#9" },
      { criterion: "c2", type: "citation", ref: "anything#1" },
      { criterion: "c2", type: "tool_call" },
    ] });
    assert.deepEqual(validateUsage(r, measured()).map((f) => [f.rule, f.path]), [["R17", "/evidence/0/ref"]]);
  });

  test("R18: fewer tool calls or seconds than measured, or no tool_calls at all", () => {
    assert.deepEqual(validateUsage(report({ cost: { usd: 1, tool_calls: 4 } }), measured()).map((f) => f.path), ["/cost/tool_calls"]);
    assert.deepEqual(validateUsage(report({ cost: { usd: 1 } }), measured()).map((f) => f.path), ["/cost/tool_calls"]);
    assert.deepEqual(validateUsage(report({ cost: { usd: 1, tool_calls: 7, seconds: 60 } }), measured()).map((f) => f.path), ["/cost/seconds"]);
    // Seconds unreported, or a gateway that made no calls, are not flagged here.
    const notes = [{ criterion: "c1", type: "note" as const, note: "Read offline" }];
    assert.deepEqual(validateUsage(report({ cost: { usd: 1 }, evidence: notes }), measured({ tool_calls: 0, tools_used: [], refs: [] })), []);
  });

  test("R19: tools_used must include every tool the gateway logged", () => {
    const f = validateUsage(report({ tools_used: ["filings/search"] }), measured());
    assert.deepEqual(rules(f), ["R19"]);
    assert.match(f[0].message, /filings\/get_section/);
  });

  test("validateReport runs R17–R19 only when usage is given", () => {
    const r = report({ cost: { usd: 1, tool_calls: 1 } });
    assert.deepEqual(validateReport(r, order()), []);
    assert.deepEqual(rules(validateReport(r, order(), { usage: measured() })), ["R18"]);
  });
});

describe("desk.recordUsage", () => {
  test("records no event, and a report that under-reports is rejected and changes nothing", async () => {
    const { desk } = newDesk();
    const id = await workingOrder(desk);
    const seq = lastSeq(await desk.get(id));
    const record = await desk.recordUsage(id, WORKER, measured());
    assert.equal(lastSeq(record), seq);
    assert.deepEqual(record.usage, measured());

    const e = await rejectsWith(desk.submitReport(id, reportInput({ cost: { usd: 0.8, tool_calls: 2 } }), WORKER), "VALIDATION_FAILED");
    assert.deepEqual(rules(e.findings), ["R18"]);
    assert.equal((await desk.get(id)).state, "working");
    assert.equal((await desk.submitReport(id, reportInput(), WORKER)).record.state, "submitted");
  });

  test("measurements only add up: a smaller one takes nothing away", async () => {
    const { desk } = newDesk();
    const id = await workingOrder(desk);
    await desk.recordUsage(id, WORKER, measured());
    const { usage } = await desk.recordUsage(id, WORKER, { tool_calls: 1, tools_used: ["calc/ratio"], refs: ["calc/ratio#6"] });
    assert.deepEqual(usage, {
      tool_calls: 5, seconds: 120,
      tools_used: ["filings/search", "filings/get_section", "calc/ratio"],
      refs: [...measured().refs, "calc/ratio#6"],
    });
  });

  test("survives a rework, so the next attempt is checked against every call", async () => {
    const { desk } = newDesk();
    const id = await workingOrder(desk);
    await desk.recordUsage(id, WORKER, measured());
    await desk.submitReport(id, reportInput(), WORKER);
    await desk.review(id, MANAGER, "rework", "Quote the debt note");
    await rejectsWith(desk.submitReport(id, reportInput({ tools_used: ["filings/search"] }), WORKER), "VALIDATION_FAILED");
  });

  test("is stored with the record", async () => {
    const dir = tempDir();
    const { desk } = newDesk({ store: new FileStore(dir) });
    const id = await workingOrder(desk);
    await desk.recordUsage(id, WORKER, measured());
    assert.deepEqual((await newDesk({ store: new FileStore(dir) }).desk.get(id)).usage, measured());
  });

  test("only the worker, only while working, and only well-formed", async () => {
    const { desk } = newDesk();
    const id = await workingOrder(desk);
    await rejectsWith(desk.recordUsage(id, MANAGER, measured()), "FORBIDDEN");
    await rejectsWith(desk.recordUsage(id, WORKER, measured({ tool_calls: -1 })), "BAD_REQUEST");
    await rejectsWith(desk.recordUsage(id, WORKER, measured({ seconds: 1.5 })), "BAD_REQUEST");
    await rejectsWith(desk.recordUsage(id, WORKER, { tool_calls: 1, tools_used: "filings/search" } as never), "BAD_REQUEST");
    await desk.submitReport(id, reportInput(), WORKER);
    await rejectsWith(desk.recordUsage(id, WORKER, measured()), "INVALID_TRANSITION");
  });
});

describe("writes that record no event still conflict (PR #55 review)", () => {
  for (const [name, make] of [
    ["MemoryStore", () => undefined],
    ["FileStore", () => new FileStore(tempDir())],
    ["SqliteStore", () => new SqliteStore(":memory:")],
  ] as const) {
    test(`${name}: a write based on a read from before a usage write is refused`, async () => {
      const { desk } = newDesk(make() ? { store: make()! } : {});
      const id = await workingOrder(desk);
      const stale = await desk.get(id);
      await desk.recordUsage(id, WORKER, measured());
      const fresh = await desk.get(id);
      assert.equal(lastSeq(fresh), lastSeq(stale));
      assert.equal(fresh.rev, (stale.rev ?? 0) + 1);
      // The stale writer would overwrite the measurement; the store refuses it.
      await rejectsWith(desk.store.update({ ...stale, rev: (stale.rev ?? 0) + 1 }, lastSeq(stale), stale.rev ?? 0), "CONFLICT");
      assert.deepEqual((await desk.get(id)).usage, measured());
    });
  }

  test("a store that ignores rev still works, checking seq only", async () => {
    const { desk } = newDesk();
    const id = await workingOrder(desk);
    const record = await desk.get(id);
    await desk.store.update(record, lastSeq(record));
  });
});
