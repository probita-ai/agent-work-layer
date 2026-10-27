import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { AwlError, WorkDesk } from "agent-work-layer";
import type { WorkOrderInput, WorkReportInput } from "agent-work-layer";
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

/** A desk with one accepted order, a gateway for it in front of four upstream servers, and a worker client. */
async function setup(order: Partial<WorkOrderInput> = {}, extra: Partial<GatewayOptions> = {}) {
  const desk = (extra.desk as WorkDesk | undefined) ?? new WorkDesk();
  const id = (await desk.create(orderInput(order), MANAGER)).order.id;
  await desk.accept(id, WORKER);

  const arrived: string[] = [];
  const upstreams: Record<string, Client> = {};
  for (const name of ["filings", "calc", "shell", "gmail"]) upstreams[name] = await link(upstreamServer(name, arrived), "gateway");

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

  test("marks awl_usage as a read-only tool", async () => {
    const { client } = await setup();
    const usage = (await client.listTools()).tools.find((t) => t.name === USAGE_TOOL);
    assert.deepEqual(usage?.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
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

  test("does not spend the tool calls its sub-orders hold", async () => {
    const { desk, id, call } = await setup({ budget: { tool_calls: 3 } });
    const child = await desk.create(orderInput({ to: "agent:helper", parent_id: id, budget: { tool_calls: 2 } }), WORKER);
    assert.ok((await call("filings__search")).ok);
    const r = await call("filings__search");
    assert.equal(r.body.code, "BUDGET_SPENT");
    assert.match(r.body.message, /sub-orders hold 2 of 3/);

    await desk.decline(child.order.id, "agent:helper");
    assert.ok((await call("filings__search")).ok);
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

describe("MCP gateway with staged tools", () => {
  const STAGED = { tools: ["filings/*", "gmail/*"], staged: ["gmail/send"] };

  /** Submits a done report listing the gateway's pending effects, as awl_usage gives them. */
  async function report(s: Awaited<ReturnType<typeof setup>>, overrides: Partial<WorkReportInput> = {}) {
    const usage = await s.gateway.usage();
    return s.desk.submitReport(s.id, reportInput({ tools_used: usage.tools_used, cost: { usd: 0.1, ...usage.cost }, effects: usage.effects, ...overrides }), WORKER);
  }

  test("holds back a staged call, counts it and returns a placeholder", async () => {
    const s = await setup(STAGED);
    const tools = (await s.client.listTools()).tools;
    assert.match(tools.find((t) => t.name === "gmail__send")!.description!, /Staged/);
    assert.doesNotMatch(tools.find((t) => t.name === "gmail__draft")!.description!, /Staged/);

    await s.call("filings__search", { q: "risk" });
    const r = await s.call("gmail__send", { q: "hello" });
    assert.ok(r.ok);
    assert.equal(r.texts[0], "pending:gmail/send#2");
    assert.match(r.texts.at(-1)!, /evidence ref: gmail\/send#2; staged/);
    assert.equal(r.meta?.["awl/ref"], "gmail/send#2");
    assert.equal(r.meta?.["awl/staged"], true);
    assert.ok((await s.call("gmail__draft", { q: "draft" })).ok);
    assert.deepEqual(s.arrived, ["filings/search", "gmail/draft"]);

    const usage = (await s.call(USAGE_TOOL)).body;
    assert.equal(usage.cost.tool_calls, 3);
    assert.deepEqual(usage.tools_used, ["filings/search", "gmail/send", "gmail/draft"]);
    assert.deepEqual(usage.effects, [{ ref: "gmail/send#2", tool: "gmail/send", arguments: { q: "hello" } }]);
    assert.equal(usage.calls[1].outcome, "staged");
  });

  test("runs the effects once the report is approved, and only once", async () => {
    const s = await setup(STAGED);
    await s.call("gmail__send", { q: "first" });
    await s.call("gmail__send", { q: "second" });
    const { findings } = await report(s);
    assert.deepEqual(findings, []);

    await rejectsCode(s.gateway.commit(), "INVALID_TRANSITION");
    assert.deepEqual(s.arrived, []);

    await s.desk.review(s.id, MANAGER, "approve");
    const committed = await s.gateway.commit();
    assert.deepEqual(committed.map((c) => [c.ref, c.outcome]), [["gmail/send#1", "ok"], ["gmail/send#2", "ok"]]);
    assert.equal((committed[1].result!.content as { text: string }[])[0].text, "gmail/send(second)");
    assert.deepEqual(s.arrived, ["gmail/send", "gmail/send"]);

    const again = await Promise.all([s.gateway.commit(), s.gateway.commit()]);
    assert.ok(again.flat().every((c) => c.earlier && !c.result));
    assert.equal(s.arrived.length, 2);

    const usage = await s.gateway.usage();
    assert.deepEqual(usage.effects, []);
    assert.equal(usage.cost.tool_calls, 2);
    assert.deepEqual(usage.calls.map((c) => [c.ref, c.outcome, c.commit ?? false]), [
      ["gmail/send#1", "staged", false], ["gmail/send#2", "staged", false],
      ["gmail/send#1", "running", true], ["gmail/send#1", "ok", true], ["gmail/send#2", "running", true], ["gmail/send#2", "ok", true],
    ]);
  });

  test("runs nothing when an effect in the report does not match the log", async () => {
    const s = await setup(STAGED);
    await s.call("gmail__send", { q: "to the team" });
    await s.call("gmail__send", { q: "to the board" });
    const effects = (await s.gateway.usage()).effects;
    await report(s, { effects: [effects[0], { ...effects[1], arguments: { q: "to everyone" } }] });
    await s.desk.review(s.id, MANAGER, "approve");
    await rejectsCode(s.gateway.commit(), "CONFLICT");

    const forged = await setup(STAGED);
    await report(forged, { effects: [{ ref: "gmail/send#1", tool: "gmail/send", arguments: {} }] });
    await forged.desk.review(forged.id, MANAGER, "approve");
    await rejectsCode(forged.gateway.commit(), "CONFLICT");
    assert.deepEqual([...s.arrived, ...forged.arrived], []);
  });

  test("argument order does not matter", async () => {
    const s = await setup({ ...STAGED, tools: ["*"], staged: ["*"] });
    await s.call("gmail__send", { q: "hi", nested: { b: 1, a: [1, { y: 2, x: 1 }] } } as never);
    await report(s, { effects: [{ ref: "gmail/send#1", tool: "gmail/send", arguments: { nested: { a: [1, { x: 1, y: 2 }], b: 1 }, q: "hi" } }] });
    await s.desk.review(s.id, MANAGER, "approve");
    assert.equal((await s.gateway.commit())[0].outcome, "ok");
  });

  test("a rework drops the effects staged before it; a blocked report does not", async () => {
    const s = await setup(STAGED);
    await s.call("gmail__send", { q: "draft one" });
    const stale = (await s.gateway.usage()).effects;
    await report(s);
    await s.desk.review(s.id, MANAGER, "rework", "Wrong recipient");
    assert.deepEqual((await s.gateway.usage()).effects, []);

    await s.call("gmail__send", { q: "draft two" });
    await s.desk.submitReport(s.id, reportInput({ status: "blocked", evidence: [], questions: ["CC legal?"] }), WORKER);
    await s.desk.answer(s.id, MANAGER, "No");
    await s.call("gmail__send", { q: "draft three" });
    const live = (await s.gateway.usage()).effects;
    assert.deepEqual(live.map((e) => e.arguments.q), ["draft two", "draft three"]);

    await report(s, { effects: [...stale, ...live] });
    await s.desk.review(s.id, MANAGER, "approve");
    await rejectsCode(s.gateway.commit(), "CONFLICT");
    assert.deepEqual(s.arrived, []);
  });

  test("effects left out of the report never run", async () => {
    const s = await setup(STAGED);
    await s.call("gmail__send", { q: "keep" });
    await s.call("gmail__send", { q: "skip" });
    await report(s, { effects: (await s.gateway.usage()).effects.slice(0, 1) });
    await s.desk.review(s.id, MANAGER, "approve");
    assert.deepEqual((await s.gateway.commit()).map((c) => c.ref), ["gmail/send#1"]);
    assert.deepEqual(s.arrived, ["gmail/send"]);
  });

  test("a gateway restarted from the log can commit, and a failed effect is not retried", async () => {
    const logFile = join(tempDir(), "calls", "order.jsonl");
    const s = await setup({ ...STAGED, tools: ["*"], staged: ["filings/broken", "gmail/send"] }, { logFile });
    await s.call("filings__broken");
    await s.call("gmail__send", { q: "after" });
    await report(s);
    await s.desk.review(s.id, MANAGER, "approve");

    const again = await createGateway({ desk: s.desk, orderId: s.id, upstreams: s.upstreams, logFile });
    assert.deepEqual((await again.commit()).map((c) => [c.ref, c.outcome]), [["filings/broken#1", "error"], ["gmail/send#2", "ok"]]);
    const third = await createGateway({ desk: s.desk, orderId: s.id, upstreams: s.upstreams, logFile });
    assert.deepEqual((await third.commit()).map((c) => [c.outcome, c.earlier]), [["error", true], ["ok", true]]);
    // The worker's gateway loaded the log before those commits; it reads the file again, so runs nothing twice.
    assert.ok((await s.gateway.commit()).every((c) => c.earlier));
    assert.deepEqual(s.arrived, ["filings/broken", "gmail/send"]);
  });

  test("fills references to earlier effects' results when it runs them", async () => {
    const s = await setup({ ...STAGED, staged: ["gmail/*"] });
    const draft = await s.call("gmail__draft", { q: "Q3 risks" });
    assert.match(draft.texts.at(-1)!, /"\$ref": "gmail\/draft#1"/);
    await s.call("gmail__send", { q: { $ref: "gmail/draft#1", pointer: "/content/0/text" } } as never);
    await report(s);
    await s.desk.review(s.id, MANAGER, "approve");

    const committed = await s.gateway.commit();
    assert.deepEqual(committed.map((c) => c.outcome), ["ok", "ok"]);
    assert.equal((committed[1].result!.content as { text: string }[])[0].text, "gmail/send(gmail/draft(Q3 risks))");
    const sent = (await s.gateway.usage()).calls.at(-1)!;
    assert.deepEqual([sent.commit, sent.arguments], [true, { q: "gmail/draft(Q3 risks)" }]);
  });

  test("refuses a reference to a staged call in a call that is not staged, without counting it", async () => {
    const s = await setup(STAGED);
    await s.call("gmail__send", { q: "hello" });
    const r = await s.call("gmail__draft", { q: { $ref: "gmail/send#1", pointer: "/content/0/text" } });
    assert.equal(r.ok, false);
    assert.equal(r.body.code, "PENDING_REFERENCE");
    assert.match(r.body.message, /"gmail\/send#1"/);
    // A $ref that names no staged call, like a JSON Schema's, is just an argument.
    assert.ok((await s.call("filings__search", { schema: { $ref: "#/definitions/q" } })).ok);
    assert.deepEqual(s.arrived, ["filings/search"]);
    const usage = await s.gateway.usage();
    assert.equal(usage.cost.tool_calls, 2);
    assert.deepEqual(usage.calls.map((c) => c.outcome), ["staged", "refused", "ok"]);
  });

  test("with enforce: false, a reference to a staged call goes through and is logged as a violation", async () => {
    const s = await setup(STAGED, { enforce: false });
    await s.call("gmail__send", { q: "hello" });
    const r = await s.call("gmail__draft", { issue: { $ref: "gmail/send#1" } });
    assert.ok(r.ok);
    assert.equal(r.meta?.["awl/violation"], "PENDING_REFERENCE");
    assert.deepEqual(s.arrived, ["gmail/draft"]);
    assert.equal((await s.gateway.usage()).calls[1].violation, "PENDING_REFERENCE");
  });

  test("skips an effect whose reference cannot be filled in, and the effects that use it", async () => {
    const logFile = join(tempDir(), "calls", "order.jsonl");
    const s = await setup({ tools: ["*"], staged: ["filings/broken", "gmail/*"] }, { logFile });
    await s.call("filings__broken");
    await s.call("gmail__draft", { q: { $ref: "filings/broken#1", pointer: "/content/0/text" } } as never);
    await s.call("gmail__send", { q: { $ref: "gmail/draft#2", pointer: "/content/0/text" } } as never);
    await s.call("gmail__draft", { q: "fine" });
    await s.call("gmail__send", { q: { $ref: "gmail/draft#4", pointer: "/structuredContent/id" } } as never);
    await report(s);
    await s.desk.review(s.id, MANAGER, "approve");

    const committed = await s.gateway.commit();
    assert.deepEqual(committed.map((c) => c.outcome), ["error", "skipped", "skipped", "ok", "skipped"]);
    assert.match(committed[1].message!, /"filings\/broken#1" did not succeed/);
    assert.match(committed[4].message!, /nothing at "\/structuredContent\/id"/);
    assert.deepEqual(s.arrived, ["filings/broken", "gmail/draft"]);

    // Skipped effects are not tried again, and a restarted gateway still has the results references need.
    const again = await createGateway({ desk: s.desk, orderId: s.id, upstreams: s.upstreams, logFile });
    assert.deepEqual((await again.commit()).map((c) => [c.outcome, c.earlier]), committed.map((c) => [c.outcome, true]));
    assert.equal(s.arrived.length, 2);
  });

  test("runs only the effects the approval chose", async () => {
    const s = await setup({ ...STAGED, staged: ["gmail/*"] });
    await s.call("gmail__draft", { q: "a" });
    await s.call("gmail__send", { q: "b" });
    await s.call("gmail__send", { q: { $ref: "gmail/draft#1", pointer: "/content/0/text" } } as never);
    await report(s);
    await s.desk.review(s.id, MANAGER, "approve", undefined, { effects: ["gmail/send#3", "gmail/draft#1"] });
    assert.deepEqual((await s.gateway.commit()).map((c) => [c.ref, c.outcome]), [["gmail/draft#1", "ok"], ["gmail/send#3", "ok"]]);
    assert.deepEqual(s.arrived, ["gmail/draft", "gmail/send"]);

    const none = await setup(STAGED);
    await none.call("gmail__send", { q: "x" });
    await report(none);
    await none.desk.review(none.id, MANAGER, "approve", undefined, { effects: [] });
    assert.deepEqual(await none.gateway.commit(), []);
    assert.deepEqual(none.arrived, []);
  });

  test("a dropped effect need not match the log", async () => {
    const s = await setup(STAGED);
    await s.call("gmail__send", { q: "real" });
    const [real] = (await s.gateway.usage()).effects;
    await report(s, { effects: [real, { ref: "gmail/send#9", tool: "gmail/send", arguments: {} }] });
    await s.desk.review(s.id, MANAGER, "approve", undefined, { effects: ["gmail/send#1"] });
    assert.deepEqual((await s.gateway.commit()).map((c) => c.outcome), ["ok"]);
  });

  test("a call that gets no answer is unknown; an error response is an error", async () => {
    const s = await setup({ ...STAGED, staged: ["gmail/*"] });
    await s.call("gmail__send", { q: "lost" });
    await s.call("gmail__draft", { q: "refused" });
    await report(s);
    await s.desk.review(s.id, MANAGER, "approve");
    const sent: unknown[] = [];
    s.upstreams.gmail.callTool = (async (params: { name: string; _meta?: unknown }) => {
      sent.push(params._meta);
      if (params.name === "send") throw new McpError(ErrorCode.ConnectionClosed, "Connection closed");
      throw new McpError(ErrorCode.InvalidParams, "no such draft");
    }) as never;

    const committed = await s.gateway.commit();
    assert.deepEqual(committed.map((c) => [c.ref, c.outcome]), [["gmail/send#1", "unknown"], ["gmail/draft#2", "error"]]);
    assert.match(committed[0].message!, /no answer from the tool, so it may have run/);
    assert.deepEqual(sent, [{ "awl/ref": "gmail/send#1", "awl/order": s.id }, { "awl/ref": "gmail/draft#2", "awl/order": s.id }]);
    assert.deepEqual((await s.gateway.commit()).map((c) => c.outcome), ["unknown", "error"]);
    assert.equal(sent.length, 2);
  });

  test("an effect a crashed commit started is settled as unknown, never run again", async () => {
    const logFile = join(tempDir(), "calls", "order.jsonl");
    const s = await setup(STAGED, { logFile });
    await s.call("gmail__send", { q: "first" });
    await s.call("gmail__send", { q: "second" });
    await report(s);
    await s.desk.review(s.id, MANAGER, "approve");
    // As if a commit died right after logging gmail/send#1 as running, before or after sending it.
    appendFileSync(logFile, JSON.stringify({ ref: "gmail/send#1", tool: "gmail/send", order_id: s.id, at: "2026-01-01T10:00:00Z", outcome: "running", commit: true }) + "\n");

    const committed = await s.gateway.commit();
    assert.deepEqual(committed.map((c) => [c.ref, c.outcome]), [["gmail/send#1", "unknown"], ["gmail/send#2", "ok"]]);
    assert.match(committed[0].message!, /may have run/);
    assert.deepEqual(s.arrived, ["gmail/send"]);
    assert.deepEqual((await s.gateway.commit()).map((c) => c.outcome), ["unknown", "ok"]);
    assert.equal(s.arrived.length, 1);
  });

  test("a second process cannot commit while one is committing", async () => {
    const logFile = join(tempDir(), "calls", "order.jsonl");
    const s = await setup(STAGED, { logFile });
    await s.call("gmail__send", { q: "once" });
    await report(s);
    await s.desk.review(s.id, MANAGER, "approve");
    writeFileSync(`${logFile}.commit-lock`, "");
    const other = await createGateway({ desk: s.desk, orderId: s.id, upstreams: s.upstreams, logFile });
    await rejectsCode(other.commit(), "CONFLICT");
    assert.deepEqual(s.arrived, []);

    rmSync(`${logFile}.commit-lock`);
    assert.deepEqual((await other.commit()).map((c) => c.outcome), ["ok"]);
    assert.equal(existsSync(`${logFile}.commit-lock`), false);
  });

  test("an order without staged tools commits nothing, and a pass-mode gateway cannot commit", async () => {
    const s = await setup();
    await s.call("filings__search");
    await report(s);
    await s.desk.review(s.id, MANAGER, "approve");
    assert.deepEqual(await s.gateway.commit(), []);

    const passOnly = await createGateway({ orderId: s.id, upstreams: {}, actor: WORKER, passKeys: [] });
    await rejectsCode(passOnly.commit(), "BAD_REQUEST");
  });
});

async function rejectsCode(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: AwlError) => {
    assert.ok(e instanceof AwlError, String(e));
    assert.equal(e.code, code, e.message);
    return true;
  });
}
