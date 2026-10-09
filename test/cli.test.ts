import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { VERSION } from "../src/index.ts";
import { MANAGER, WORKER, order, orderInput, reportInput, tempDir } from "./helpers.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = join(root, "src", "cli.ts");
const example = (name: string) => join(root, "examples", name);

function awl(...args: string[]) {
  const r = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", cwd: root });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function writeJson(value: unknown) {
  const file = join(tempDir(), "doc.json");
  writeFileSync(file, JSON.stringify(value));
  return file;
}

describe("awl CLI", () => {
  test("--help and no arguments print usage", () => {
    for (const args of [["--help"], []]) {
      const r = awl(...args);
      assert.equal(r.code, 0);
      assert.match(r.out, /awl validate/);
      assert.match(r.out, /awl new <order\|report>/);
    }
  });

  test("--version prints the package version", () => {
    assert.equal(awl("--version").out.trim(), VERSION);
  });

  test("new order prints a valid starter with a one-hour deadline", () => {
    const before = Date.now();
    const r = awl("new", "order");
    const after = Date.now();
    assert.equal(r.code, 0, r.err);
    assert.equal(r.err, "");
    const doc = JSON.parse(r.out);
    assert.ok(Date.parse(doc.created_at) >= before && Date.parse(doc.created_at) <= after);
    assert.equal(Date.parse(doc.deadline) - Date.parse(doc.created_at), 3_600_000);
    assert.equal(doc.criteria.length, 1);
    assert.deepEqual(doc.budget, { usd: 1 });
    assert.deepEqual(doc.tools, []);
    const validated = awl("validate", writeJson(doc));
    assert.equal(validated.code, 0, validated.out + validated.err);
  });

  test("new report validates against the starter order without claiming completion", () => {
    const o = awl("new", "order");
    const before = Date.now();
    const r = awl("new", "report");
    const after = Date.now();
    assert.equal(r.code, 0, r.err);
    assert.equal(r.err, "");
    const doc = JSON.parse(r.out);
    assert.equal(doc.status, "blocked");
    assert.ok(Date.parse(doc.finished_at) >= before && Date.parse(doc.finished_at) <= after);
    const validated = awl("validate", writeJson(JSON.parse(o.out)), writeJson(doc), "--json");
    assert.equal(validated.code, 0, validated.out + validated.err);
    assert.equal(JSON.parse(validated.out).ok, true);
    assert.deepEqual(JSON.parse(validated.out).results.map((x: { findings: unknown[] }) => x.findings), [[], []]);
  });

  test("new rejects missing, unknown and extra document types with exit 2", () => {
    for (const args of [[], ["invoice"], ["order", "extra"], ["--json"]]) {
      const r = awl("new", ...args);
      assert.equal(r.code, 2);
      assert.equal(r.out, "");
      assert.match(r.err, /new needs "order" or "report"/);
    }
  });

  test("validate passes the good example", () => {
    const r = awl("validate", example("risk-summary.order.json"), example("risk-summary.report.json"));
    assert.equal(r.code, 0, r.out + r.err);
    assert.equal(r.out.match(/✓/g)?.length, 2);
  });

  test("validate fails the bad example and names each rule", () => {
    const r = awl("validate", example("risk-summary.order.json"), example("bad.report.json"));
    assert.equal(r.code, 1);
    for (const rule of ["R4", "R5", "R6", "R7", "R8", "R11"]) assert.match(r.out, new RegExp(`\\b${rule}\\b`));
  });

  test("validate --json prints machine-readable results", () => {
    const r = awl("validate", example("risk-summary.order.json"), example("bad.report.json"), "--json");
    const body = JSON.parse(r.out);
    assert.equal(body.ok, false);
    assert.equal(body.results.length, 2);
    assert.ok(body.results[1].findings.some((f: { rule: string }) => f.rule === "R5"));
  });

  test("validate skips the report when the order is invalid", () => {
    const r = awl("validate", writeJson({ ...order(), criteria: [] }), example("risk-summary.report.json"), "--json");
    assert.equal(r.code, 1);
    assert.equal(JSON.parse(r.out).results.length, 1);
  });

  test("validate --parent checks delegation rules", () => {
    const r = awl("validate", example("calc.child-order.json"), "--parent", example("risk-summary.order.json"));
    assert.equal(r.code, 0, r.out);
    const wide = writeJson({ ...order({ id: "c", parent_id: "wo_risk_0001", deadline: "2026-10-09T11:00:00Z", created_at: "2026-10-09T09:05:00Z" }), tools: ["*"] });
    const bad = awl("validate", wide, "--parent", example("risk-summary.order.json"));
    assert.equal(bad.code, 1);
    assert.match(bad.out, /C2/);
  });

  test("a warning-only report exits 0 and marks the file with !", () => {
    const o = order();
    const r = awl("validate", writeJson(o), writeJson({ ...reportInput({ cost: { usd: 9, tool_calls: 1 } }), spec: "awl/work-report@0.1", order_id: o.id, from: WORKER, finished_at: "2026-01-01T10:00:00Z" }));
    assert.equal(r.code, 0);
    assert.match(r.out, /^! /m);
    assert.match(r.out, /R7\s+limit/);
  });

  test("usage errors exit 2", () => {
    assert.equal(awl("validate").code, 2);
    assert.equal(awl("validate", "/no/such/file.json").code, 2);
    assert.equal(awl("frobnicate").code, 2);
    assert.equal(awl("schema", "pizza").code, 2);
    assert.match(awl("frobnicate").err, /unknown command/);
  });

  test("schema prints both JSON Schemas", () => {
    assert.equal(JSON.parse(awl("schema", "order").out).title, "AWL Work Order v0.1");
    assert.equal(JSON.parse(awl("schema", "report").out).title, "AWL Work Report v0.1");
  });
});

describe("awl desk over stdio", () => {
  const clients: Client[] = [];
  after(() => Promise.all(clients.map((c) => c.close())));

  async function session(actor: string, store: string, viaFlags: boolean) {
    const args = viaFlags ? [cli, "desk", "--store", store, "--actor", actor] : [cli, "desk"];
    const env = viaFlags ? { ...process.env } : { ...process.env, AWL_STORE: store, AWL_ACTOR: actor };
    const client = new Client({ name: actor, version: "0" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args, env: env as Record<string, string>, stderr: "ignore" }));
    clients.push(client);
    return async (name: string, a: Record<string, unknown>) => {
      const r = (await client.callTool({ name, arguments: a })) as { isError?: boolean; content: { text: string }[] };
      return { ok: !r.isError, body: JSON.parse(r.content[0].text) };
    };
  }

  test("two processes coordinate through a shared folder", async () => {
    const store = tempDir();
    const manager = await session(MANAGER, store, true);
    const worker = await session(WORKER, store, false);

    const id = (await manager("create_work_order", { ...orderInput({ deadline: "2999-01-01T00:00:00Z" }) })).body.id;
    const waiting = manager("wait_for_update", { id, since_seq: 1, timeout_s: 10 });
    await worker("accept_work_order", { id });
    assert.equal((await waiting).body.state, "accepted");

    assert.equal((await worker("review_work_report", { id, decision: "approve", actor: MANAGER })).body.code, "FORBIDDEN");
    await worker("submit_work_report", { id, ...reportInput() });
    assert.equal((await manager("review_work_report", { id, decision: "approve" })).body.state, "approved");
  });
});
