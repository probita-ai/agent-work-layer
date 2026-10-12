import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AwlError, WorkDesk } from "agent-work-layer";
import type { WorkOrderInput } from "agent-work-layer";
import { createGateway, USAGE_TOOL } from "../src/index.ts";
import type { GatewayOptions } from "../src/index.ts";
import { MANAGER, STRANGER, WORKER, orderInput, reportInput, tempDir } from "./helpers.ts";
import { upstreamServer } from "./fixtures/upstream.ts";

const clients: Client[] = [];
after(() => Promise.all(clients.map((c) => c.close())));

async function link(server: { connect: Client["connect"] }, name: string) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name, version: "0" });
  await client.connect(clientSide);
  clients.push(client);
  return client;
}

type Call = { ok: boolean; texts: string[]; body: any; meta?: Record<string, unknown> };

/** A desk with one accepted order, a gateway for it in front of three upstream servers, and a worker client. */
async function setup(order: Partial<WorkOrderInput> = {}, extra: Partial<GatewayOptions> = {}) {
  const desk = (extra.desk as WorkDesk | undefined) ?? new WorkDesk();
  const id = (await desk.create(orderInput(order), MANAGER)).order.id;
  await desk.accept(id, WORKER);

  const arrived: string[] = [];
  const upstreams: Record<string, Client> = {};
  for (const name of ["filings", "calc", "shell"]) upstreams[name] = await link(upstreamServer(name, arrived), "gateway");

  const gateway = await createGateway({ desk, orderId: id, upstreams, ...extra });
  const client = await link(gateway.server, WORKER);
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<Call> => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[]; _meta?: Record<string, unknown> };
    const texts = r.content.map((c) => c.text);
    let body: unknown;
    try {
      body = JSON.parse(texts[0]);
    } catch {
      body = texts[0];
    }
    return { ok: !r.isError, texts, body, meta: r._meta };
  };
  return { desk, id, gateway, client, call, arrived, upstreams };
}

describe("MCP gateway", () => {
  test("lists only the tools the order allows, plus awl_usage", async () => {
    const { client } = await setup({ tools: ["filings/*", "calc/ratio"] });
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(names, [USAGE_TOOL, "calc__ratio", "filings__broken", "filings__get_section", "filings__search"]);
  });

  test("passes allowed calls through and tags each with an evidence ref", async () => {
    const { call, arrived } = await setup();
    const r = await call("filings__search", { q: "risk" });
    assert.ok(r.ok);
    assert.equal(r.texts[0], "filings/search(risk)");
    assert.equal(r.texts.at(-1), "[awl evidence ref: filings/search#1]");
    assert.equal(r.meta?.["awl/ref"], "filings/search#1");
    assert.equal((await call("calc__ratio")).meta?.["awl/ref"], "calc/ratio#2");
    assert.deepEqual(arrived, ["filings/search", "calc/ratio"]);
  });

  test("starts an accepted order on its first call", async () => {
    const { desk, id, call } = await setup();
    await call("filings__search");
    const record = await desk.get(id);
    assert.equal(record.state, "working");
    assert.equal(record.events.at(-1)?.actor, WORKER);
  });

  test("refuses tools the order does not allow, without counting them", async () => {
    const { call, arrived, gateway } = await setup({ tools: ["filings/*"] });
    const r = await call("shell__exec", { q: "rm -rf /" });
    assert.equal(r.ok, false);
    assert.equal(r.body.code, "TOOL_NOT_ALLOWED");
    assert.equal((await call("nope__nothing")).body.code, "UNKNOWN_TOOL");
    assert.deepEqual(arrived, []);
    const usage = await gateway.usage();
    assert.equal(usage.cost.tool_calls, 0);
    assert.deepEqual(usage.calls.map((c) => c.refusal), ["TOOL_NOT_ALLOWED", "UNKNOWN_TOOL"]);
  });

  test("refuses calls once the tool_calls budget is spent", async () => {
    const { call, arrived } = await setup({ budget: { tool_calls: 2 } });
    assert.ok((await call("filings__search")).ok);
    assert.ok((await call("filings__search")).ok);
    const r = await call("filings__search");
    assert.equal(r.body.code, "BUDGET_SPENT");
    assert.equal(arrived.length, 2);
  });

  test("concurrent calls cannot overspend the budget", async () => {
    const { call, arrived } = await setup({ budget: { tool_calls: 3 } });
    const results = await Promise.all(Array.from({ length: 8 }, () => call("calc__ratio")));
    assert.equal(results.filter((r) => r.ok).length, 3);
    assert.equal(arrived.length, 3);
  });

  test("refuses calls once the seconds budget is spent", async () => {
    let now = Date.parse("2026-10-11T12:00:00Z");
    const clock = () => new Date(now);
    const desk = new WorkDesk({ clock });
    const { call, gateway } = await setup({ budget: { seconds: 60 }, deadline: "2026-10-12T00:00:00Z" }, { desk, clock });
    assert.ok((await call("filings__search")).ok);
    now += 30_000;
    assert.ok((await call("filings__search")).ok);
    assert.deepEqual((await gateway.usage()).remaining, { seconds: 30 });
    now += 31_000;
    assert.equal((await call("filings__search")).body.code, "BUDGET_SPENT");
  });

  test("refuses calls while the order is not working", async () => {
    const { desk, id, call } = await setup();
    await call("filings__search");
    await desk.submitReport(id, reportInput({ status: "blocked", evidence: [], questions: ["Which year?"] }), WORKER);
    const blocked = await call("filings__search");
    assert.equal(blocked.body.code, "ORDER_NOT_WORKING");
    assert.match(blocked.body.message, /blocked/);

    await desk.answer(id, MANAGER, "FY2025");
    assert.ok((await call("filings__search")).ok);
    await desk.cancel(id, MANAGER, "no longer needed");
    assert.equal((await call("filings__search")).body.code, "ORDER_NOT_WORKING");
  });

  test("an upstream error still counts as a call", async () => {
    const { call, gateway } = await setup();
    const r = await call("filings__broken");
    assert.equal(r.ok, false);
    assert.equal(r.texts.at(-1), "[awl evidence ref: filings/broken#1]");
    const usage = await gateway.usage();
    assert.equal(usage.cost.tool_calls, 1);
    assert.equal(usage.calls[0].outcome, "error");
  });

  test("awl_usage gives tools_used and cost that the desk accepts", async () => {
    const { desk, id, call } = await setup({ budget: { usd: 2, tool_calls: 20, seconds: 600 } });
    await call("filings__search");
    await call("filings__get_section");
    await call("filings__search");
    const usage = (await call(USAGE_TOOL)).body;
    assert.deepEqual(usage.tools_used, ["filings/search", "filings/get_section"]);
    assert.equal(usage.cost.tool_calls, 3);
    assert.equal(usage.remaining.tool_calls, 17);
    assert.deepEqual(usage.calls.map((c: { ref: string }) => c.ref), ["filings/search#1", "filings/get_section#2", "filings/search#3"]);

    const { findings, record } = await desk.submitReport(
      id,
      reportInput({
        tools_used: usage.tools_used,
        cost: { usd: 0.4, ...usage.cost },
        evidence: [
          { criterion: "c1", type: "tool_call", ref: usage.calls[1].ref },
          { criterion: "c2", type: "tool_call", ref: usage.calls[2].ref },
        ],
      }),
      WORKER,
    );
    assert.deepEqual(findings, []);
    assert.equal(record.state, "submitted");
  });

  test("the call log survives a restart, so the budget does not reset", async () => {
    const logFile = join(tempDir(), "calls", "order.jsonl");
    const first = await setup({ budget: { tool_calls: 2 } }, { logFile });
    await first.call("filings__search");
    await first.call("shell__exec");
    await first.call("calc__ratio");

    const again = await createGateway({ desk: first.desk, orderId: first.id, upstreams: first.upstreams, logFile });
    const client = await link(again.server, WORKER);
    const r = (await client.callTool({ name: "filings__search", arguments: {} })) as { content: { text: string }[] };
    assert.equal(JSON.parse(r.content[0].text).code, "BUDGET_SPENT");

    const lines = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => l.ref ?? l.refusal), ["filings/search#1", "TOOL_NOT_ALLOWED", "calc/ratio#2", "BUDGET_SPENT"]);
    assert.equal((await again.usage()).cost.tool_calls, 2);
  });

  test("with enforce: false, it lists every tool and refuses nothing, but logs violations", async () => {
    const { client, call, arrived, gateway, desk, id } = await setup({ tools: ["filings/*"], budget: { tool_calls: 1 } }, { enforce: false });
    assert.ok((await client.listTools()).tools.some((t) => t.name === "shell__exec"));

    assert.equal((await call("filings__search")).meta?.["awl/violation"], undefined);
    const shell = await call("shell__exec");
    assert.ok(shell.ok);
    assert.equal(shell.meta?.["awl/violation"], "TOOL_NOT_ALLOWED");
    assert.match(shell.texts.at(-1)!, /shell\/exec#2; not allowed by the order/);
    await desk.cancel(id, MANAGER);
    assert.ok((await call("filings__search")).ok);
    assert.equal((await call("nope__nothing")).body.code, "UNKNOWN_TOOL");

    assert.deepEqual(arrived, ["filings/search", "shell/exec", "filings/search"]);
    const usage = await gateway.usage();
    assert.equal(usage.cost.tool_calls, 3);
    assert.deepEqual(usage.calls.map((c) => c.violation ?? c.refusal ?? null), [null, "TOOL_NOT_ALLOWED", "ORDER_NOT_WORKING", "UNKNOWN_TOOL"]);
  });

  test("with enforce: false, overspending is logged and left to the desk's report checks", async () => {
    const { call, gateway } = await setup({ budget: { tool_calls: 1 } }, { enforce: false });
    await call("filings__search");
    assert.equal((await call("filings__search")).meta?.["awl/violation"], "BUDGET_SPENT");
    const usage = await gateway.usage();
    assert.deepEqual(usage.cost.tool_calls, 2);
    assert.deepEqual(usage.remaining, { tool_calls: 0 });
  });

  test("only the order's worker can run its gateway", async () => {
    const desk = new WorkDesk();
    const id = (await desk.create(orderInput(), MANAGER)).order.id;
    await assert.rejects(createGateway({ desk, orderId: id, upstreams: {}, actor: STRANGER }), (e: AwlError) => e.code === "FORBIDDEN");
    await assert.rejects(createGateway({ desk, orderId: "missing", upstreams: {} }), (e: AwlError) => e.code === "NOT_FOUND");
  });
});
