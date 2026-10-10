import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ORDER_SPEC, REPORT_SPEC, validateOrder, validateReport } from "../src/index.ts";
import type { Handoff } from "../src/index.ts";
import { WORKER, newDesk, order, orderInput, report, reportInput, rules, workingOrder } from "./helpers.ts";

const handoff: Handoff = {
  summary: "Parser done; export fails on files over 2 GB",
  decisions: [{ text: "Stream rows instead of buffering", why: "Memory limit" }],
  tried: [{ text: "xlsx library", result: "Too slow on large files" }],
  open_questions: ["Quote style for commas?"],
  next_step: "Add tests for null cells",
};

describe("handoff (SPEC.md §4.4)", () => {
  test("is accepted on orders and reports", () => {
    assert.deepEqual(validateOrder(order({ handoff })), []);
    assert.deepEqual(validateReport(report({ status: "failed", evidence: [], error: "OOM", handoff }), order()), []);
  });

  test("every sub-field is optional, but the object may not be empty", () => {
    assert.deepEqual(validateOrder(order({ handoff: { next_step: "Add tests" } })), []);
    assert.deepEqual(rules(validateOrder(order({ handoff: {} }))), ["O1"]);
  });

  test("rejects unknown fields and empty text", () => {
    const unknown = validateOrder(order({ handoff: { notes: "x" } as Handoff }));
    assert.deepEqual(rules(unknown), ["O1"]);
    assert.match(unknown[0].message, /unknown field "notes"/);
    assert.deepEqual(rules(validateOrder(order({ handoff: { decisions: [{ text: "" }] } }))), ["O1"]);
    assert.deepEqual(rules(validateReport(report({ handoff: { tried: [{ result: "x" }] } as unknown as Handoff }), order())), ["R1"]);
  });

  test("the desk stores it on both documents and writes spec 0.2", async () => {
    const { desk } = newDesk();
    const { order: created } = await desk.create(orderInput({ handoff }), "agent:manager");
    assert.equal(created.spec, ORDER_SPEC);
    assert.deepEqual(created.handoff, handoff);

    const id = await workingOrder(desk);
    const { record } = await desk.submitReport(id, reportInput({ status: "failed", evidence: [], error: "OOM", handoff }), WORKER);
    assert.equal(record.reports[0].spec, REPORT_SPEC);
    assert.deepEqual(record.reports[0].handoff, handoff);
  });
});

describe("spec versions (SPEC.md §11)", () => {
  test("0.1 documents are still accepted", () => {
    const old = order({ spec: "awl/work-order@0.1" });
    assert.deepEqual(validateOrder(old), []);
    assert.deepEqual(validateReport(report({ spec: "awl/work-report@0.1" }), old), []);
  });

  test("unknown versions are rejected", () => {
    assert.deepEqual(rules(validateOrder({ ...order(), spec: "awl/work-order@1.0" })), ["O1"]);
    assert.deepEqual(rules(validateReport({ ...report(), spec: "awl/work-report@0.3" }, order())), ["R1"]);
  });
});
