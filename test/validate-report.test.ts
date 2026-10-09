import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { isWorkReport, validateReport } from "../src/index.ts";
import { DEADLINE, order, report, rules, without } from "./helpers.ts";

const withOutput = order({
  output_schema: {
    type: "object",
    required: ["risks"],
    properties: { risks: { type: "array", minItems: 3, items: { type: "string" } } },
  },
});

describe("validateReport", () => {
  test("accepts a complete done report", () => {
    assert.deepEqual(validateReport(report(), order()), []);
  });

  test("accepts every optional field", () => {
    const full = report({
      started_at: "2026-01-01T09:30:00Z",
      attempt: 2,
      questions: [],
      metadata: { model: "x" },
      result: { summary: "ok", output: { a: 1 }, artifacts: [{ uri: "s3://bucket/memo.pdf", media_type: "application/pdf" }] },
    });
    assert.deepEqual(validateReport(full, order()), []);
  });

  describe("R1 structure", () => {
    for (const field of ["spec", "order_id", "from", "status", "result", "evidence", "cost", "finished_at", "tools_used"]) {
      test(`rejects a missing "${field}"`, () => {
        assert.deepEqual(rules(validateReport(without(report(), field), order())), ["R1"]);
      });
    }

    const bad: [string, Record<string, unknown>][] = [
      ["unknown status", { status: "partial" }],
      ["result without summary", { result: {} }],
      ["unknown evidence type", { evidence: [{ criterion: "c1", type: "vibes" }] }],
      ["evidence without criterion", { evidence: [{ type: "note" }] }],
      ["wildcard in tools_used", { tools_used: ["filings/*"] }],
      ["bare tool name", { tools_used: ["search"] }],
      ["unknown cost unit", { cost: { usd: 1, euros: 1 } }],
      ["zero attempt", { attempt: 0 }],
      ["empty question", { questions: [""] }],
      ["unknown top-level field", { confidence: 0.9 }],
    ];
    for (const [name, change] of bad) {
      test(`rejects ${name}`, () => {
        assert.deepEqual(rules(validateReport({ ...report(), ...change }, order())), ["R1"]);
      });
    }

    test("allows x- extensions", () => {
      assert.deepEqual(validateReport({ ...report(), "x-trace-id": "abc" }, order()), []);
    });
  });

  test("R2 rejects a report for another order", () => {
    assert.deepEqual(rules(validateReport(report({ order_id: "wo_other" }), order())), ["R2"]);
  });

  test("R3 rejects evidence for an unknown criterion", () => {
    const evidence = [...report().evidence, { criterion: "c9", type: "note" as const }];
    const findings = validateReport(report({ evidence }), order());
    assert.deepEqual(rules(findings), ["R3"]);
    assert.equal(findings[0].path, "/evidence/2/criterion");
  });

  describe("R4 evidence coverage", () => {
    test("rejects done without evidence for every criterion", () => {
      const findings = validateReport(report({ evidence: [report().evidence[0]] }), order());
      assert.deepEqual(rules(findings), ["R4"]);
      assert.match(findings[0].message, /"c2"/);
    });

    test("reports one finding per unproven criterion", () => {
      assert.deepEqual(rules(validateReport(report({ evidence: [] }), order())), ["R4", "R4"]);
    });

    test("accepts several evidence items for one criterion", () => {
      const evidence = [...report().evidence, { criterion: "c1", type: "artifact" as const, ref: "memo.pdf" }];
      assert.deepEqual(validateReport(report({ evidence }), order()), []);
    });

    test("does not apply to blocked reports", () => {
      assert.deepEqual(validateReport(report({ status: "blocked", evidence: [], questions: ["Which year?"] }), order()), []);
    });

    test("does not apply to failed reports", () => {
      assert.deepEqual(validateReport(report({ status: "failed", evidence: [], error: "source down" }), order()), []);
    });
  });

  describe("R5 tools", () => {
    test("rejects a tool outside the allowed patterns", () => {
      const findings = validateReport(report({ tools_used: ["filings/search", "web/browse"] }), order());
      assert.deepEqual(rules(findings), ["R5"]);
      assert.equal(findings[0].path, "/tools_used/1");
    });

    test("accepts an exact match", () => {
      assert.deepEqual(validateReport(report({ tools_used: ["calc/ratio"] }), order()), []);
    });

    test("rejects a sibling of an exact match", () => {
      assert.deepEqual(rules(validateReport(report({ tools_used: ["calc/sum"] }), order())), ["R5"]);
    });

    test("accepts anything under *", () => {
      assert.deepEqual(validateReport(report({ tools_used: ["any/thing"] }), order({ tools: ["*"] })), []);
    });

    test("rejects every tool when none are allowed", () => {
      assert.deepEqual(rules(validateReport(report(), order({ tools: [] }))), ["R5", "R5"]);
    });

    test("accepts no tools when none are allowed", () => {
      assert.deepEqual(validateReport(report({ tools_used: [] }), order({ tools: [] })), []);
    });
  });

  describe("R6 and R7 cost", () => {
    test("R6 rejects a cost that omits a budgeted unit", () => {
      assert.deepEqual(rules(validateReport(report({ cost: { usd: 1 } }), order())), ["R6"]);
    });

    test("allows cost units the budget does not set", () => {
      assert.deepEqual(validateReport(report({ cost: { usd: 1, tool_calls: 3, tokens: 9000 } }), order()), []);
    });

    test("R7 flags spending over budget as a limit finding", () => {
      const findings = validateReport(report({ cost: { usd: 2.01, tool_calls: 7 } }), order());
      assert.deepEqual(rules(findings), ["R7"]);
      assert.equal(findings[0].kind, "limit");
      assert.equal(findings[0].path, "/cost/usd");
    });

    test("R7 allows spending exactly the budget", () => {
      assert.deepEqual(validateReport(report({ cost: { usd: 2, tool_calls: 20 } }), order()), []);
    });

    test("R7 checks every unit", () => {
      assert.deepEqual(rules(validateReport(report({ cost: { usd: 9, tool_calls: 99 } }), order())), ["R7", "R7"]);
    });
  });

  describe("R8 deadline", () => {
    test("flags finishing after the deadline as a limit finding", () => {
      const [f] = validateReport(report({ finished_at: "2026-01-01T12:00:01Z" }), order());
      assert.equal(f.rule, "R8");
      assert.equal(f.kind, "limit");
    });

    test("allows finishing exactly at the deadline", () => {
      assert.deepEqual(validateReport(report({ finished_at: DEADLINE }), order()), []);
    });
  });

  test("R9 rejects a blocked report with no questions", () => {
    assert.deepEqual(rules(validateReport(report({ status: "blocked", evidence: [] }), order())), ["R9"]);
    assert.deepEqual(rules(validateReport(report({ status: "blocked", evidence: [], questions: [] }), order())), ["R9"]);
  });

  test("R10 rejects a failed report with no error", () => {
    assert.deepEqual(rules(validateReport(report({ status: "failed", evidence: [] }), order())), ["R10"]);
  });

  describe("R11 output_schema", () => {
    test("accepts matching output", () => {
      const r = report({ result: { summary: "ok", output: { risks: ["a", "b", "c"] } } });
      assert.deepEqual(validateReport(r, withOutput), []);
    });

    test("rejects output that does not match, with paths", () => {
      const findings = validateReport(report({ result: { summary: "ok", output: { risks: ["a"] } } }), withOutput);
      assert.deepEqual(rules(findings), ["R11"]);
      assert.equal(findings[0].path, "/result/output/risks");
    });

    test("rejects missing output", () => {
      assert.deepEqual(rules(validateReport(report(), withOutput)), ["R11"]);
    });

    test("is skipped when the report is not done", () => {
      assert.deepEqual(validateReport(report({ status: "failed", evidence: [], error: "x" }), withOutput), []);
    });
  });

  test("R12 rejects started_at after finished_at", () => {
    assert.deepEqual(rules(validateReport(report({ started_at: "2026-01-01T11:00:00Z" }), order())), ["R12"]);
  });

  test("reports every independent problem at once", () => {
    const bad = report({
      order_id: "wo_x",
      evidence: [{ criterion: "c9", type: "note" }],
      cost: { usd: 5 },
      tools_used: ["web/browse"],
      finished_at: "2026-01-02T00:00:00Z",
    });
    assert.deepEqual(rules(validateReport(bad, order())), ["R2", "R3", "R4", "R4", "R5", "R6", "R7", "R8"]);
  });
});

describe("isWorkReport", () => {
  test("narrows valid documents", () => assert.equal(isWorkReport(report()), true));
  test("rejects invalid documents", () => assert.equal(isWorkReport({ ...report(), status: "?" }), false));
});
