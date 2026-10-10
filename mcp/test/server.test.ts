import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { WorkDesk } from "agent-work-layer";
import { createDeskServer } from "../src/index.ts";
import { FAR, LEAD, MANAGER, STRANGER, WORKER, orderInput, reportInput } from "./helpers.ts";
const clients: Client[] = [];
after(() => Promise.all(clients.map((c) => c.close())));

/** Connects a client to a desk server bound to `actor` (or unbound). */
async function connect(desk: WorkDesk, actor?: string) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createDeskServer({ desk, actor }).connect(serverSide);
  const client = new Client({ name: actor ?? "anon", version: "0" });
  await client.connect(clientSide);
  clients.push(client);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    return { ok: !r.isError, body: JSON.parse(r.content[0].text) };
  };
}

async function pair() {
  const desk = new WorkDesk();
  return { desk, manager: await connect(desk, MANAGER), worker: await connect(desk, WORKER) };
}

describe("desk MCP server", () => {
  test("exposes the eleven desk tools", async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createDeskServer({ desk: new WorkDesk() }).connect(serverSide);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(clientSide);
    clients.push(client);
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "accept_work_order", "answer_question", "cancel_work_order", "create_work_order", "decline_work_order",
      "get_work_order", "list_work_orders", "review_work_report", "start_work_order", "submit_work_report", "wait_for_update",
    ]);
  });

  test("runs a full job between two sessions", async () => {
    const { manager, worker } = await pair();
    const created = await manager("create_work_order", { ...orderInput({ deadline: FAR }) });
    assert.ok(created.ok, JSON.stringify(created.body));
    const id = created.body.id;
    assert.equal(created.body.order.from, MANAGER);

    const inbox = await worker("list_work_orders", { to: WORKER, state: "offered" });
    assert.deepEqual(inbox.body.map((s: { id: string }) => s.id), [id]);

    assert.equal((await worker("accept_work_order", { id })).body.state, "accepted");
    const submitted = await worker("submit_work_report", { id, ...reportInput() });
    assert.equal(submitted.body.state, "submitted");
    assert.deepEqual(submitted.body.findings, []);

    const approved = await manager("review_work_report", { id, decision: "approve" });
    assert.equal(approved.body.state, "approved");
    assert.equal(approved.body.latest_report.from, WORKER);
    assert.equal(approved.body.events.length, 5);
  });

  test("a session cannot act as someone else", async () => {
    const { manager, worker } = await pair();
    const id = (await manager("create_work_order", { ...orderInput({ deadline: FAR }) })).body.id;
    const spoof = await worker("cancel_work_order", { id, actor: MANAGER });
    assert.equal(spoof.ok, false);
    assert.equal(spoof.body.code, "FORBIDDEN");
  });

  test("a bound session may repeat its own identity", async () => {
    const { manager } = await pair();
    assert.ok((await manager("create_work_order", { ...orderInput({ deadline: FAR }), actor: MANAGER })).ok);
  });

  test("an unbound session needs an actor argument", async () => {
    const call = await connect(new WorkDesk());
    const missing = await call("create_work_order", { ...orderInput({ deadline: FAR }) });
    assert.equal(missing.body.code, "BAD_REQUEST");
    assert.ok((await call("create_work_order", { ...orderInput({ deadline: FAR }), actor: LEAD })).ok);
  });

  test("returns validation findings as a tool error", async () => {
    const { manager, worker } = await pair();
    const id = (await manager("create_work_order", { ...orderInput({ deadline: FAR }) })).body.id;
    await worker("accept_work_order", { id });
    const bad = await worker("submit_work_report", { id, ...reportInput({ evidence: [] }) });
    assert.equal(bad.ok, false);
    assert.equal(bad.body.code, "VALIDATION_FAILED");
    assert.deepEqual(bad.body.findings.map((f: { rule: string }) => f.rule), ["R4", "R4"]);
  });

  test("returns lifecycle and lookup errors with codes", async () => {
    const { manager, worker } = await pair();
    assert.equal((await manager("get_work_order", { id: "nope" })).body.code, "NOT_FOUND");
    const id = (await manager("create_work_order", { ...orderInput({ deadline: FAR }) })).body.id;
    assert.equal((await worker("start_work_order", { id })).body.code, "INVALID_TRANSITION");
    assert.equal((await worker("accept_work_order", { id: "../../etc" })).body.code, "NOT_FOUND");
  });

  test("blocked questions reach the manager and answers reach the worker", async () => {
    const { manager, worker } = await pair();
    const id = (await manager("create_work_order", { ...orderInput({ deadline: FAR }) })).body.id;
    await worker("accept_work_order", { id });
    await worker("submit_work_report", { id, ...reportInput({ status: "blocked", evidence: [], questions: ["Which year?"] }) });
    const seen = await manager("get_work_order", { id });
    assert.deepEqual(seen.body.latest_report.questions, ["Which year?"]);
    await manager("answer_question", { id, answer: "FY2025" });
    const back = await worker("get_work_order", { id });
    assert.equal(back.body.state, "working");
    assert.equal(back.body.events.at(-1).note, "FY2025");
  });

  test("wait_for_update follows the other session live", async () => {
    const { manager, worker } = await pair();
    const id = (await manager("create_work_order", { ...orderInput({ deadline: FAR }) })).body.id;
    const waiting = manager("wait_for_update", { id, since_seq: 1, timeout_s: 5 });
    setTimeout(() => void worker("accept_work_order", { id }), 50);
    assert.equal((await waiting).body.state, "accepted");
  });

  test("drops undefined optional fields before validation", async () => {
    const { manager } = await pair();
    const created = await manager("create_work_order", { ...orderInput({ deadline: FAR }), escalate_to: undefined, metadata: undefined });
    assert.ok(created.ok, JSON.stringify(created.body));
  });

  test("rejects malformed arguments before they reach the desk", async () => {
    const { manager } = await pair();
    const r = await manager("create_work_order", { ...orderInput({ deadline: FAR }), budget: { usd: -5 } }).catch((e) => ({ ok: false, body: String(e) }));
    assert.equal(r.ok, false);
  });

  test("cancel and decline work through tools", async () => {
    const { manager, worker } = await pair();
    const a = (await manager("create_work_order", { ...orderInput({ deadline: FAR }) })).body.id;
    const b = (await manager("create_work_order", { ...orderInput({ deadline: FAR }) })).body.id;
    assert.equal((await worker("decline_work_order", { id: a, reason: "busy" })).body.state, "declined");
    assert.equal((await manager("cancel_work_order", { id: b })).body.state, "cancelled");
    assert.equal((await manager("list_work_orders", { from: MANAGER, state: "cancelled" })).body.length, 1);
    assert.equal((await manager("list_work_orders", { from: STRANGER })).body.length, 0);
  });
});

describe("handoff over MCP", () => {
  const handoff = {
    summary: "Parser done; export fails on files over 2 GB",
    decisions: [{ text: "Stream rows", why: "Memory limit" }],
    tried: [{ text: "xlsx library", result: "Too slow" }],
    open_questions: ["Quote style for commas?"],
    next_step: "Add tests for null cells",
  };

  test("a failed worker hands off and the next order carries it", async () => {
    const { manager, worker } = await pair();
    const first = (await manager("create_work_order", { ...orderInput() })).body.id;
    await worker("accept_work_order", { id: first });
    const failed = await worker("submit_work_report", { id: first, ...reportInput({ status: "failed", evidence: [], error: "Out of memory" }), handoff });
    assert.ok(failed.ok, JSON.stringify(failed.body));

    const left = (await manager("get_work_order", { id: first })).body.latest_report.handoff;
    assert.deepEqual(left, handoff);

    const next = await manager("create_work_order", { ...orderInput({ to: STRANGER }), handoff: left });
    assert.ok(next.ok, JSON.stringify(next.body));
    assert.deepEqual(next.body.order.handoff, handoff);
  });

  test("rejects unknown handoff fields", async () => {
    const { manager } = await pair();
    const r = await manager("create_work_order", { ...orderInput(), handoff: { notes: "x" } }).catch((e) => ({ ok: false, body: String(e) }));
    assert.equal(r.ok, false);
  });
});
