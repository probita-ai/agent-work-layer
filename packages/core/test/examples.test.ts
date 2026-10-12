import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../..", import.meta.url));

test("examples/two-agents.ts runs to approval", () => {
  const r = spawnSync(process.execPath, ["examples/two-agents.ts"], { encoding: "utf8", cwd: repo });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /no evidence for criterion "c2"/);
  assert.match(r.stdout, /rework \(submitted -> working\)/);
  assert.match(r.stdout, /Final state: approved after 2 reports/);
});
