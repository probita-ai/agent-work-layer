import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { VERSION, workOrderSchema, workReportSchema } from "../src/index.ts";

const root = new URL("..", import.meta.url);
const json = (path: string) => JSON.parse(readFileSync(new URL(path, root), "utf8"));

/** Every module reachable from `entry` through relative imports, with its bare imports. */
function importGraph(entry: string) {
  const seen = new Map<string, string[]>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    const source = readFileSync(new URL(file, root), "utf8");
    const specifiers = [...source.matchAll(/^\s*(?:import|export)[^"']*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
    seen.set(file, specifiers.filter((s) => !s.startsWith(".")));
    for (const s of specifiers.filter((s) => s.startsWith("."))) visit(new URL(s, new URL(file, root)).pathname.slice(new URL(root).pathname.length));
  };
  visit(entry);
  return seen;
}

describe("runtime independence", () => {
  test("src/generated.ts matches package.json and schemas/", () => {
    const r = spawnSync(process.execPath, [fileURLToPath(new URL("scripts/generate.ts", root)), "--check"], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(VERSION, json("package.json").version);
    assert.deepEqual(workOrderSchema, json("schemas/work-order.schema.json"));
    assert.deepEqual(workReportSchema, json("schemas/work-report.schema.json"));
  });

  test("agent-work-layer/validate imports nothing from Node", () => {
    const graph = importGraph("src/validator.ts");
    assert.ok(graph.has("src/validate.ts") && graph.has("src/generated.ts"));
    const bare = [...new Set([...graph.values()].flat())].sort();
    assert.deepEqual(bare, ["ajv", "ajv-formats", "ajv/dist/2020.js"]);
  });

  test("the core never imports the MCP SDK or zod", () => {
    const bare = [...importGraph("src/index.ts").values(), ...importGraph("src/cli.ts").values()].flat();
    assert.deepEqual(bare.filter((s) => /modelcontextprotocol|^zod/.test(s)), []);
  });
});
