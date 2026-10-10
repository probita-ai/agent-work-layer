import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { isWorkOrder, validateOrder } from "../src/index.ts";
import { order, rules, without } from "./helpers.ts";

describe("validateOrder", () => {
  test("accepts a complete order", () => {
    assert.deepEqual(validateOrder(order()), []);
  });

  test("accepts every optional field", () => {
    const full = order({
      escalate_to: "human:lead",
      inputs: { issuer: "Example Corp" },
      context: [{ uri: "https://example.com/10k.pdf", note: "latest filing" }],
      output_schema: { type: "object" },
      parent_id: "wo_0",
      metadata: { team: "credit" },
    });
    assert.deepEqual(validateOrder(full), []);
  });

  describe("O1 structure", () => {
    for (const field of ["spec", "id", "created_at", "from", "to", "goal", "criteria", "budget", "deadline", "tools"]) {
      test(`rejects a missing "${field}"`, () => {
        assert.deepEqual(rules(validateOrder(without(order(), field))), ["O1"]);
      });
    }

    const bad: [string, Record<string, unknown>][] = [
      ["wrong spec version", { spec: "awl/work-order@9.0" }],
      ["empty criteria", { criteria: [] }],
      ["criterion without text", { criteria: [{ id: "c1" }] }],
      ["empty budget", { budget: {} }],
      ["unknown budget unit", { budget: { euros: 5 } }],
      ["negative budget", { budget: { usd: -1 } }],
      ["fractional tokens", { budget: { tokens: 1.5 } }],
      ["empty goal", { goal: "" }],
      ["non-date deadline", { deadline: "tomorrow" }],
      ["unknown top-level field", { priority: "high" }],
      ["non-object inputs", { inputs: "x" }],
      ["context without uri", { context: [{ note: "x" }] }],
    ];
    for (const [name, change] of bad) {
      test(`rejects ${name}`, () => {
        assert.deepEqual(rules(validateOrder({ ...order(), ...change })), ["O1"]);
      });
    }

    test("reports the offending path", () => {
      const [f] = validateOrder({ ...order(), budget: { usd: -1 } });
      assert.equal(f.path, "/budget/usd");
      assert.equal(f.kind, "invalid");
    });

    test("names unknown fields in the message", () => {
      const [f] = validateOrder({ ...order(), priority: "high" });
      assert.match(f.message, /unknown field "priority"/);
    });

    test("allows x- extensions", () => {
      assert.deepEqual(validateOrder({ ...order(), "x-cost-center": "CR-12" }), []);
    });

    test("rejects non-objects", () => {
      for (const value of [null, 42, "order", [], undefined]) assert.deepEqual(rules(validateOrder(value)), ["O1"]);
    });

    for (const pattern of ["*", "filings/*", "filings/get_section", "my-server.v2/tool_1"]) {
      test(`accepts tool pattern "${pattern}"`, () => assert.deepEqual(validateOrder(order({ tools: [pattern] })), []));
    }
    for (const pattern of ["", "filings", "*/search", "a/b/c", "filings/ search", "**"]) {
      test(`rejects tool pattern "${pattern}"`, () => assert.deepEqual(rules(validateOrder(order({ tools: [pattern] }))), ["O1"]));
    }

    test("accepts an empty tool list", () => {
      assert.deepEqual(validateOrder(order({ tools: [] })), []);
    });
  });

  test("O2 rejects duplicate criterion ids", () => {
    const findings = validateOrder(order({ criteria: [{ id: "c1", text: "a" }, { id: "c1", text: "b" }] }));
    assert.deepEqual(rules(findings), ["O2"]);
    assert.equal(findings[0].path, "/criteria/1/id");
  });

  test("O3 rejects a deadline equal to created_at", () => {
    assert.deepEqual(rules(validateOrder(order({ deadline: order().created_at }))), ["O3"]);
  });

  test("O3 rejects a deadline before created_at", () => {
    assert.deepEqual(rules(validateOrder(order({ deadline: "2025-12-31T00:00:00Z" }))), ["O3"]);
  });

  test("O4 rejects an invalid output_schema", () => {
    assert.deepEqual(rules(validateOrder(order({ output_schema: { type: "not-a-type" } }))), ["O4"]);
  });

  test("O4 tolerates two orders using the same $id", () => {
    const schema = { $id: "https://example.com/out", type: "object" };
    assert.deepEqual(validateOrder(order({ output_schema: schema })), []);
    assert.deepEqual(validateOrder(order({ output_schema: { ...schema } })), []);
  });

  test("reports several semantic problems at once", () => {
    const findings = validateOrder(order({ criteria: [{ id: "a", text: "x" }, { id: "a", text: "y" }], deadline: order().created_at }));
    assert.deepEqual(rules(findings), ["O2", "O3"]);
  });
});

describe("isWorkOrder", () => {
  test("narrows valid documents", () => {
    const value: unknown = order();
    assert.equal(isWorkOrder(value), true);
  });

  test("rejects invalid documents", () => {
    assert.equal(isWorkOrder(without(order(), "goal")), false);
  });
});
