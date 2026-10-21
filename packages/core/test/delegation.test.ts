import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { patternCovered, toolAllowed, validateChildBudgets, validateChildOrder } from "../src/index.ts";
import { order, rules } from "./helpers.ts";

describe("toolAllowed", () => {
  const cases: [string, string[], boolean][] = [
    ["filings/search", ["filings/search"], true],
    ["filings/search", ["filings/*"], true],
    ["filings/search", ["*"], true],
    ["filings/search", ["filings/get"], false],
    ["filings/search", ["filingsx/*"], false],
    ["filings/search", ["files/*", "calc/*"], false],
    ["filings/search", [], false],
  ];
  for (const [tool, patterns, expected] of cases) {
    test(`${tool} with [${patterns.join(", ")}] → ${expected}`, () => assert.equal(toolAllowed(tool, patterns), expected));
  }
});

describe("patternCovered", () => {
  const cases: [string, string[], boolean][] = [
    ["filings/search", ["filings/search"], true],
    ["filings/search", ["filings/*"], true],
    ["filings/*", ["filings/*"], true],
    ["filings/*", ["*"], true],
    ["*", ["*"], true],
    ["filings/*", ["filings/search"], false],
    ["*", ["filings/*"], false],
    ["calc/sum", ["filings/*"], false],
    ["calc/sum", [], false],
  ];
  for (const [child, parent, expected] of cases) {
    test(`${child} within [${parent.join(", ")}] → ${expected}`, () => assert.equal(patternCovered(child, parent), expected));
  }
});

describe("validateChildOrder", () => {
  const parent = order({ budget: { usd: 2, tool_calls: 20 }, tools: ["filings/*", "calc/ratio"] });
  const child = (overrides = {}) =>
    order({ id: "wo_child", parent_id: "wo_1", budget: { usd: 1, tool_calls: 5 }, tools: ["filings/search"], deadline: "2026-01-01T11:00:00Z", ...overrides });

  test("accepts a strictly narrower child", () => {
    assert.deepEqual(validateChildOrder(child(), parent), []);
  });

  test("accepts a child equal to its parent", () => {
    assert.deepEqual(validateChildOrder(child({ budget: parent.budget, tools: parent.tools, deadline: parent.deadline }), parent), []);
  });

  test("accepts extra budget units the parent does not limit", () => {
    assert.deepEqual(validateChildOrder(child({ budget: { usd: 1, tool_calls: 5, tokens: 1000 } }), parent), []);
  });

  test("C1 rejects a child that drops a parent budget unit", () => {
    const findings = validateChildOrder(child({ budget: { usd: 1 } }), parent);
    assert.deepEqual(rules(findings), ["C1"]);
    assert.match(findings[0].message, /tool_calls/);
  });

  test("C1 rejects a larger budget", () => {
    const findings = validateChildOrder(child({ budget: { usd: 3, tool_calls: 5 } }), parent);
    assert.deepEqual(rules(findings), ["C1"]);
    assert.equal(findings[0].path, "/budget/usd");
  });

  test("C2 rejects a wider tool pattern", () => {
    assert.deepEqual(rules(validateChildOrder(child({ tools: ["calc/*"] }), parent)), ["C2"]);
  });

  test("C2 rejects a tool the parent does not have", () => {
    assert.deepEqual(rules(validateChildOrder(child({ tools: ["web/browse"] }), parent)), ["C2"]);
  });

  test("C3 rejects a later deadline", () => {
    assert.deepEqual(rules(validateChildOrder(child({ deadline: "2026-01-01T12:00:01Z" }), parent)), ["C3"]);
  });

  test("reports every violation at once", () => {
    const findings = validateChildOrder(child({ budget: { usd: 9 }, tools: ["*"], deadline: "2027-01-01T00:00:00Z" }), parent);
    assert.deepEqual(rules(findings), ["C1", "C1", "C2", "C3"]);
  });
});

describe("validateChildBudgets", () => {
  const parent = order({ budget: { usd: 2, tokens: 1000, tool_calls: 20, seconds: 60 } });
  const sibling = (budget: object, state = "working" as const) => ({ order: order({ budget }), state });

  test("accepts sub-orders that fill the budget exactly", () => {
    assert.deepEqual(validateChildBudgets(order({ budget: { usd: 1 } }), parent, [sibling({ usd: 1 })]), []);
  });

  test("rejects each unit that the sub-orders overrun together", () => {
    const findings = validateChildBudgets(order({ budget: { usd: 1, tool_calls: 15 } }), parent, [sibling({ usd: 1.5, tool_calls: 10 })]);
    assert.deepEqual(findings.map((f) => f.path), ["/budget/usd", "/budget/tool_calls"]);
  });

  test("does not add up seconds", () => {
    assert.deepEqual(validateChildBudgets(order({ budget: { seconds: 60 } }), parent, [sibling({ seconds: 60 })]), []);
  });

  test("does not count declined siblings", () => {
    assert.deepEqual(validateChildBudgets(order({ budget: { usd: 2 } }), parent, [{ ...sibling({ usd: 2 }), state: "declined" }]), []);
  });

  test("absorbs floating-point error", () => {
    const tight = order({ budget: { usd: 0.3 } });
    assert.deepEqual(validateChildBudgets(order({ budget: { usd: 0.2 } }), tight, [sibling({ usd: 0.1 })]), []);
  });
});
