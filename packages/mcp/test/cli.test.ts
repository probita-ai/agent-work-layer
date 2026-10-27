import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FileStore, WorkDesk } from "agent-work-layer";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { VERSION } from "../src/version.ts";
import { MANAGER, WORKER, orderInput, reportInput, tempDir } from "./helpers.ts";
import { deliveries } from "./fixtures/receiver.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = join(root, "src", "cli.ts");
const upstream = join(root, "test", "fixtures", "upstream.ts");
const receiver = join(root, "test", "fixtures", "receiver.ts");

describe("awl-desk CLI", () => {
  test("--version and --help", () => {
    assert.equal(spawnSync(process.execPath, [cli, "--version"], { encoding: "utf8" }).stdout.trim(), VERSION);
    const help = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /AWL_STORE/);
  });

  test("unknown flags exit 2", () => {
    const r = spawnSync(process.execPath, [cli, "--frobnicate"], { encoding: "utf8" });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /awl-desk:/);
  });
});

describe("awl-desk over stdio", () => {
  const clients: Client[] = [];
  after(() => Promise.all(clients.map((c) => c.close())));

  async function session(actor: string, store: string, viaFlags: boolean) {
    const args = viaFlags ? [cli, "--store", store, "--actor", actor] : [cli];
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

    const id = (await manager("create_work_order", { ...orderInput() })).body.id;
    const waiting = manager("wait_for_update", { id, since_seq: 1, timeout_s: 10 });
    await worker("accept_work_order", { id });
    assert.equal((await waiting).body.state, "accepted");

    assert.equal((await worker("review_work_report", { id, decision: "approve", actor: MANAGER })).body.code, "FORBIDDEN");
    await worker("submit_work_report", { id, ...reportInput() });
    assert.equal((await manager("review_work_report", { id, decision: "approve" })).body.state, "approved");
  });
});

describe("awl-desk gateway", () => {
  test("--help, and missing flags exit 2", () => {
    const help = spawnSync(process.execPath, [cli, "gateway", "--help"], { encoding: "utf8" });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /mcpServers/);
    const r = spawnSync(process.execPath, [cli, "gateway", "--order", "x"], { encoding: "utf8" });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--config/);
  });

  test("enforces an order in front of stdio servers and logs to the store", async () => {
    const store = tempDir();
    const desk = new WorkDesk({ store: new FileStore(store) });
    const id = (await desk.create(orderInput({ tools: ["filings/search"], budget: { tool_calls: 1 } }), MANAGER)).order.id;
    await desk.accept(id, WORKER);

    const config = join(store, "upstream.json");
    const server = (name: string) => ({ command: process.execPath, args: [upstream, name] });
    writeFileSync(config, JSON.stringify({ mcpServers: { filings: server("filings"), shell: server("shell") } }));

    const client = new Client({ name: WORKER, version: "0" });
    await client.connect(
      new StdioClientTransport({ command: process.execPath, args: [cli, "gateway", "--order", id, "--config", config, "--store", store], stderr: "ignore" }),
    );
    try {
      assert.deepEqual((await client.listTools()).tools.map((t) => t.name).sort(), ["awl_usage", "filings__search"]);
      const call = async (name: string) => (await client.callTool({ name, arguments: {} })) as { isError?: boolean; content: { text: string }[] };
      assert.equal((await call("filings__search")).content.at(-1)?.text, `[awl evidence ref: filings/search#1]`);
      assert.match((await call("filings__search")).content[0].text, /BUDGET_SPENT/);
      assert.match((await call("shell__exec")).content[0].text, /TOOL_NOT_ALLOWED/);
    } finally {
      await client.close();
    }
    assert.equal((await desk.get(id)).state, "working");
    const log = readFileSync(join(store, "calls", `${id}.jsonl`), "utf8").trim().split("\n");
    assert.equal(log.length, 3);
  });

  test("--commit runs an approved report's staged effects", async () => {
    const store = tempDir();
    const desk = new WorkDesk({ store: new FileStore(store) });
    const id = (await desk.create(orderInput({ tools: ["gmail/*"], staged: ["gmail/send"] }), MANAGER)).order.id;
    await desk.accept(id, WORKER);

    const config = join(store, "upstream.json");
    writeFileSync(config, JSON.stringify({ mcpServers: { gmail: { command: process.execPath, args: [upstream, "gmail"] } } }));
    const gateway = [cli, "gateway", "--order", id, "--config", config, "--store", store];

    const client = new Client({ name: WORKER, version: "0" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: gateway, stderr: "ignore" }));
    try {
      const r = (await client.callTool({ name: "gmail__send", arguments: { q: "hi" } })) as { content: { text: string }[] };
      assert.equal(r.content[0].text, "pending:gmail/send#1");
    } finally {
      await client.close();
    }

    const early = spawnSync(process.execPath, [...gateway, "--commit"], { encoding: "utf8" });
    assert.equal(early.status, 1);
    assert.match(early.stderr, /only once its report is approved/);

    const effects = [{ ref: "gmail/send#1", tool: "gmail/send", arguments: { q: "hi" } }];
    await desk.submitReport(id, reportInput({ tools_used: ["gmail/send"], cost: { usd: 0.1, tool_calls: 1 }, effects }), WORKER);
    await desk.review(id, MANAGER, "approve");
    const done = spawnSync(process.execPath, [...gateway, "--commit"], { encoding: "utf8" });
    assert.equal(done.status, 0, done.stderr);
    const [committed] = JSON.parse(done.stdout);
    assert.deepEqual([committed.ref, committed.outcome, committed.result.content[0].text], ["gmail/send#1", "ok", "gmail/send(hi)"]);

    const r = spawnSync(process.execPath, [...gateway, "--commit", "--pass-keys", config, "--actor", WORKER], { encoding: "utf8" });
    assert.equal(r.status, 2);
  });
});

// Where a commit can stop between the gateway and the service it calls. The receiver counts what reached
// it on its own, so these check the gateway's log against what actually happened.
describe("--commit at the crash boundaries", () => {
  /** An approved order whose report has one staged gmail/send, and a receiver in `mode` behind the gateway. */
  async function approved(mode: string) {
    const store = tempDir();
    const sent = join(store, "deliveries.jsonl");
    const config = join(store, "upstream.json");
    const setMode = (m: string) =>
      writeFileSync(config, JSON.stringify({ mcpServers: { gmail: { command: process.execPath, args: [receiver, sent, m] } } }));
    setMode(mode);

    const desk = new WorkDesk({ store: new FileStore(store) });
    const id = (await desk.create(orderInput({ tools: ["gmail/*"], staged: ["gmail/send"] }), MANAGER)).order.id;
    await desk.accept(id, WORKER);
    const gateway = [cli, "gateway", "--order", id, "--config", config, "--store", store];
    const client = new Client({ name: WORKER, version: "0" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: gateway, stderr: "ignore" }));
    try {
      await client.callTool({ name: "gmail__send", arguments: { q: "hi" } });
    } finally {
      await client.close();
    }
    const effects = [{ ref: "gmail/send#1", tool: "gmail/send", arguments: { q: "hi" } }];
    await desk.submitReport(id, reportInput({ tools_used: ["gmail/send"], cost: { usd: 0.1, tool_calls: 1 }, effects }), WORKER);
    await desk.review(id, MANAGER, "approve");

    const commit = () => {
      const r = spawnSync(process.execPath, [...gateway, "--commit"], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout)[0] as { outcome: string; message?: string; earlier?: true };
    };
    return { id, store, sent, gateway, setMode, commit, desk };
  }

  test("the receiver acts on the call and the gateway dies before the answer: unknown, never sent again", async () => {
    const s = await approved("hang");
    const child = spawn(process.execPath, [...s.gateway, "--commit"], { stdio: "ignore" });
    for (let i = 0; i < 200 && deliveries(s.sent).length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    child.kill("SIGKILL");
    await new Promise((r) => child.once("exit", r));
    s.setMode("answer");

    // The dead commit left its lock behind; the next run sees its process is gone and takes it over (#44).
    assert.ok(existsSync(join(s.store, "calls", `${s.id}.jsonl.commit-lock`)));

    const settled = s.commit();
    assert.deepEqual([settled.outcome, settled.earlier], ["unknown", true]);
    assert.match(settled.message!, /interrupted/);
    assert.equal(s.commit().outcome, "unknown");
    assert.deepEqual(deliveries(s.sent), [{ tool: "gmail/send", q: "hi", ref: "gmail/send#1", order: s.id }]);
  });

  test("the receiver acts on the call and the answer is lost: unknown, never sent again", async () => {
    const s = await approved("exit");
    const lost = s.commit();
    assert.equal(lost.outcome, "unknown");
    assert.match(lost.message!, /no answer from the tool/);
    s.setMode("answer");
    assert.deepEqual([s.commit().outcome, s.commit().outcome], ["unknown", "unknown"]);
    assert.equal(deliveries(s.sent).length, 1);
  });

  test("--settle records what the receiver shows, and --retry runs only what the manager allowed", async () => {
    const s = await approved("exit");
    assert.equal(s.commit().outcome, "unknown");
    s.setMode("answer");
    const run = (...flags: string[]) => spawnSync(process.execPath, [...s.gateway, ...flags], { encoding: "utf8" });

    assert.equal(run("--settle", "gmail/send#1", "--outcome", "not_run").status, 2);
    const settled = run("--settle", "gmail/send#1", "--outcome", "not-run", "--note", "receiver log has no gmail/send#1");
    assert.equal(settled.status, 0, settled.stderr);
    assert.equal(JSON.parse(settled.stdout).outcome, "not_run");

    assert.deepEqual(JSON.parse(run("--retry").stdout), []);
    await s.desk.allowRetry(s.id, MANAGER, ["gmail/send#1"]);
    const retried = run("--retry");
    assert.equal(retried.status, 0, retried.stderr);
    assert.deepEqual(JSON.parse(retried.stdout).map((c: { outcome: string; retry: number }) => [c.outcome, c.retry]), [["ok", 1]]);
    assert.deepEqual(JSON.parse(run("--retry").stdout), []);

    // The same ref both times, so a receiver that dedupes would have dropped the second.
    assert.deepEqual(deliveries(s.sent).map((d) => [d.ref, d.try ?? 1]), [["gmail/send#1", 1], ["gmail/send#1", 2]]);
    assert.equal(run("--commit", "--retry").status, 2);
  });

  test("a recorded result is not sent again when --commit repeats", async () => {
    const s = await approved("answer");
    assert.equal(s.commit().outcome, "ok");
    const again = s.commit();
    assert.deepEqual([again.outcome, again.earlier], ["ok", true]);
    assert.equal(deliveries(s.sent).length, 1);
  });
});
