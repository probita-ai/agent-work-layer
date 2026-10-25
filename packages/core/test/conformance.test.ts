// Runs every vector in conformance/vectors (see conformance/README.md) through this validator.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateChildBudgets, validateChildOrder, validateOrder, validateOwnCost, validateReport } from "../src/index.ts";
import type { Finding, State, WorkOrder, WorkReport } from "../src/index.ts";

const dir = fileURLToPath(new URL("../../../conformance/vectors/", import.meta.url));

type Expected = { rule: string; kind: Finding["kind"]; path?: string };
type Sibling = { state: State; order: WorkOrder };
type Vector = { name: string; order: WorkOrder; report?: unknown; parent?: WorkOrder; siblings?: Sibling[]; sub_orders?: Sibling[]; expect: Expected[] };
type VectorFile = { rule: string; check: "order" | "report" | "child" | "siblings" | "own-cost"; description: string; vectors: Vector[] };

const RULES = ["O1", "O2", "O3", "O4", "O5", "R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9", "R10", "R11", "R12", "R13", "R14", "R15", "R16", "C1", "C2", "C3", "C4", "C5"];

const files: VectorFile[] = readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(dir + f, "utf8")));

function run(file: VectorFile, v: Vector): Finding[] {
  if (file.check === "order") return validateOrder(v.order);
  if (file.check === "report") return validateReport(v.report, v.order);
  if (file.check === "own-cost") return validateOwnCost(v.report as WorkReport, v.order, v.sub_orders!);
  if (file.check === "child") return validateChildOrder(v.order, v.parent!);
  return validateChildBudgets(v.order, v.parent!, v.siblings!);
}

const matches = (f: Finding, e: Expected) => f.rule === e.rule && f.kind === e.kind && (e.path === undefined || f.path === e.path);

/** The README's matching rule: every expected entry is found, and every finding is expected. */
function assertConforms(actual: Finding[], expected: Expected[]) {
  const show = (xs: object[]) => JSON.stringify(xs.map(({ rule, kind, path }: Partial<Finding>) => ({ rule, kind, path })));
  const missing = expected.filter((e) => !actual.some((f) => matches(f, e)));
  const extra = actual.filter((f) => !expected.some((e) => matches(f, e)));
  assert.ok(!missing.length && !extra.length, `expected ${show(expected)}, got ${show(actual)}`);
}

describe("conformance vectors", () => {
  for (const file of files) {
    describe(file.rule, () => {
      for (const v of file.vectors) test(v.name, () => assertConforms(run(file, v), v.expect));
    });
  }
});

describe("conformance coverage", () => {
  test("every rule has a file of the right check", () => {
    assert.deepEqual(files.map((f) => f.rule).sort(), [...RULES].sort());
    const special: Record<string, string> = { C4: "siblings", R13: "own-cost" };
    const check = (rule: string) => (special[rule] ?? { O: "order", R: "report", C: "child" }[rule[0]]);
    for (const f of files) assert.equal(f.check, check(f.rule), f.rule);
  });

  for (const file of files) {
    test(`${file.rule} has a passing and a failing vector, each about ${file.rule} only`, () => {
      assert.ok(file.vectors.some((v) => v.expect.length === 0), "no passing vector");
      assert.ok(file.vectors.some((v) => v.expect.length > 0), "no failing vector");
      for (const v of file.vectors) for (const e of v.expect) assert.equal(e.rule, file.rule, v.name);
    });

    if (file.check !== "order") {
      test(`${file.rule} vectors run against valid orders`, () => {
        for (const v of file.vectors) {
          for (const o of [v.order, v.parent, ...[...(v.siblings ?? []), ...(v.sub_orders ?? [])].map((s) => s.order)]) if (o) assert.deepEqual(validateOrder(o), [], v.name);
        }
      });
    }
  }
});
