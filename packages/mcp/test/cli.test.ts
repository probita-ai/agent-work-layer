import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FileStore, WorkDesk } from "agent-work-layer";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { VERSION } from "../src/version.ts";
import { MANAGER, WORKER, orderInput, reportInput, tempDir } from "./helpers.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = join(root, "src", "cli.ts");
const upstream = join(root, "test", "fixtures", "upstream.ts");

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
