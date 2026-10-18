import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { webcrypto } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { FileStore, WorkDesk, decodePass, signPass, verifyPass } from "agent-work-layer";
import type { PassJwk, WorkOrder } from "agent-work-layer";
import { createDeskServer, createGateway } from "../src/index.ts";
import type { GatewayOptions } from "../src/index.ts";
import { upstreamServer } from "./fixtures/upstream.ts";
import { MANAGER, STRANGER, WORKER, orderInput, tempDir } from "./helpers.ts";

const ISSUER = "https://desk.example.com";
const pair = (await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as webcrypto.CryptoKeyPair;
const priv = (await webcrypto.subtle.exportKey("jwk", pair.privateKey)) as PassJwk;
const pub = (await webcrypto.subtle.exportKey("jwk", pair.publicKey)) as PassJwk;

const cleanup: (() => Promise<unknown>)[] = [];
after(() => Promise.all(cleanup.map((f) => f())));

async function link(server: { connect: Client["connect"] }) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(clientSide);
  cleanup.push(() => client.close());
  return client;
}

type Result = { isError?: boolean; content: { text: string }[]; _meta?: Record<string, unknown> };
const body = (r: Result) => JSON.parse(r.content[0].text);

/** An order as the desk would store it, signed into a pass for WORKER. */
const order = (overrides: Partial<WorkOrder> = {}) =>
  ({ spec: "awl/work-order@0.2", id: "wo_1", created_at: "2026-01-01T00:00:00Z", from: MANAGER, ...orderInput(), ...overrides }) as WorkOrder;
const passFor = (o: WorkOrder = order(), options = {}) => signPass(o, priv, { issuer: ISSUER, attempt: 1, jti: "jti-1", ...options });

/** A gateway that works from passes only: no desk anywhere. */
async function passGateway(extra: Partial<GatewayOptions> = {}) {
  const upstreams: Record<string, Client> = {};
  const arrived: string[] = [];
  for (const name of ["filings", "calc", "shell"]) upstreams[name] = await link(upstreamServer(name, arrived));
  const gateway = await createGateway({ orderId: "wo_1", upstreams, actor: WORKER, passKeys: pub, issuer: ISSUER, ...extra });
  const client = await link(gateway.server);
  const call = async (name: string, meta?: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: {}, ...(meta ? { _meta: meta } : {}) })) as Result;
  return { gateway, client, call, arrived };
}

describe("gateway working from Delegation Passes", () => {
  test("allows the pass's tools without a desk, and records the grant on every call", async () => {
    const { call, gateway, client, arrived } = await passGateway({ pass: await passFor() });
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["awl_usage", "calc__ratio", "filings__broken", "filings__get_section", "filings__search"]);

    const ok = await call("filings__search");
    assert.equal(ok.isError, undefined);
    assert.deepEqual(
      { ref: ok._meta?.["awl/ref"], order: ok._meta?.["awl/order"], attempt: ok._meta?.["awl/attempt"], jti: ok._meta?.["awl/jti"] },
      { ref: "filings/search#1", order: "wo_1", attempt: 1, jti: "jti-1" },
    );
    const refused = await call("shell__exec");
    assert.equal(body(refused).code, "TOOL_NOT_ALLOWED");
    assert.deepEqual(arrived, ["filings/search"]);

    const calls = (await gateway.usage()).calls;
    assert.deepEqual(calls.map(({ order_id, attempt, jti }) => ({ order_id, attempt, jti })), [
      { order_id: "wo_1", attempt: 1, jti: "jti-1" },
      { order_id: "wo_1", attempt: 1, jti: "jti-1" },
    ]);
  });

  test("refuses calls with no pass, an expired pass, or a pass for another worker or order", async () => {
    let token: string | undefined;
    let now = new Date();
    const { call, client, arrived } = await passGateway({ pass: () => token, clock: () => now });
    const code = async () => {
      const r = body(await call("filings__search"));
      return `${r.code}${r.message ? ` ${r.message.split(":")[0]}` : ""}`;
    };

    assert.equal(await code(), "PASS_INVALID no Delegation Pass for order \"wo_1\"");
    assert.deepEqual((await client.listTools()).tools.map((t) => t.name), ["awl_usage"]);

    token = await passFor(order(), { now: new Date(now.getTime() - 3_600_000) });
    assert.equal(await code(), "PASS_INVALID EXPIRED");
    token = await passFor(order({ to: STRANGER }), { now });
    assert.equal(await code(), "PASS_INVALID WRONG_WORKER");
    token = await passFor(order({ id: "wo_2" }), { now });
    assert.equal(await code(), "PASS_INVALID WRONG_ORDER");
    token = await signPass(order(), priv, { issuer: "https://evil.example.com", now });
    assert.equal(await code(), "PASS_INVALID WRONG_ISSUER");
    const good = await passFor(order(), { now });
    token = good.slice(0, -4) + (good.endsWith("AAAA") ? "BBBB" : "AAAA");
    assert.equal(await code(), "PASS_INVALID BAD_SIGNATURE");
    assert.deepEqual(arrived, []);

    token = await passFor(order(), { now });
    assert.equal((await call("filings__search")).isError, undefined);
    now = new Date(now.getTime() + 901_000);
    assert.equal(await code(), "PASS_INVALID EXPIRED");
  });

  test("enforces the pass's tool_calls budget", async () => {
    const { call } = await passGateway({ pass: await passFor(order({ budget: { tool_calls: 1 } })) });
    assert.equal((await call("filings__search")).isError, undefined);
    assert.equal(body(await call("filings__search")).code, "BUDGET_SPENT");
  });

  test("a pass in the call's _meta wins over the configured one", async () => {
    const { call } = await passGateway({ pass: await passFor(order({ to: STRANGER })) });
    assert.equal(body(await call("filings__search")).code, "PASS_INVALID");
    const r = await call("filings__search", { "awl/pass": await passFor(order(), { jti: "jti-meta" }) });
    assert.equal(r._meta?.["awl/jti"], "jti-meta");
  });

  test("with enforce: false, a bad pass is logged as a violation", async () => {
    const { call, gateway } = await passGateway({ enforce: false });
    const r = await call("filings__search");
    assert.equal(r._meta?.["awl/violation"], "PASS_INVALID");
    assert.equal((await gateway.usage()).calls[0].violation, "PASS_INVALID");
  });

  test("needs the worker's actor", async () => {
    await assert.rejects(createGateway({ orderId: "wo_1", upstreams: {}, passKeys: pub }), /actor/);
    await assert.rejects(createGateway({ orderId: "wo_1", upstreams: {} }), /desk/);
  });
});

describe("desk-mode gateway records the grant too", () => {
  test("order id, attempt and the desk's pass jti", async () => {
    const desk = new WorkDesk({ passes: { key: priv, issuer: ISSUER } });
    const id = (await desk.create(orderInput(), MANAGER)).order.id;
    await desk.accept(id, WORKER);
    const upstreams = { filings: await link(upstreamServer("filings")) };
    const gateway = await createGateway({ desk, orderId: id, upstreams });
    const client = await link(gateway.server);
    const r = (await client.callTool({ name: "filings__search", arguments: {} })) as Result;
    const { jti } = decodePass((await desk.get(id)).pass!);
    assert.deepEqual([r._meta?.["awl/order"], r._meta?.["awl/attempt"], r._meta?.["awl/jti"]], [id, 1, jti]);
    const [record] = (await gateway.usage()).calls;
    assert.deepEqual([record.order_id, record.attempt, record.jti], [id, 1, jti]);
  });

  test("without passes, records order id and attempt", async () => {
    const desk = new WorkDesk();
    const id = (await desk.create(orderInput(), MANAGER)).order.id;
    await desk.accept(id, WORKER);
    const gateway = await createGateway({ desk, orderId: id, upstreams: { filings: await link(upstreamServer("filings")) } });
    await (await link(gateway.server)).callTool({ name: "filings__search", arguments: {} });
    const [record] = (await gateway.usage()).calls;
    assert.deepEqual([record.order_id, record.attempt, record.jti], [id, 1, undefined]);
  });
});

describe("desk tools and passes", () => {
  async function sessions() {
    const desk = new WorkDesk({ passes: { key: priv, issuer: ISSUER } });
    const tool = async (actor: string) => {
      const client = await link(createDeskServer({ desk, actor }));
      return async (name: string, args: Record<string, unknown>) => body((await client.callTool({ name, arguments: args })) as Result);
    };
    return { manager: await tool(MANAGER), worker: await tool(WORKER) };
  }

  test("the worker gets its pass from start and get_work_order, and can renew it; the manager never sees it", async () => {
    const { manager, worker } = await sessions();
    const id = (await manager("create_work_order", { ...orderInput() })).id;
    await worker("accept_work_order", { id });
    const started = await worker("start_work_order", { id });
    const pass = await verifyPass(started.pass, pub, { worker: WORKER, order: id, issuer: ISSUER });
    assert.equal(pass.claims.awl_attempt, 1);

    assert.equal((await worker("get_work_order", { id })).pass, started.pass);
    assert.equal((await manager("get_work_order", { id })).pass, undefined);
    assert.equal((await manager("get_work_order", { id, actor: WORKER })).code, "FORBIDDEN");

    const renewed = await worker("renew_work_pass", { id });
    assert.notEqual(decodePass(renewed.pass).jti, pass.claims.jti);
    assert.equal((await manager("renew_work_pass", { id })).code, "FORBIDDEN");
  });

  test("renew_work_pass is only listed when the desk issues passes", async () => {
    const names = async (desk: WorkDesk) => (await (await link(createDeskServer({ desk }))).listTools()).tools.map((t) => t.name);
    assert.ok((await names(new WorkDesk({ passes: { key: priv, issuer: ISSUER } }))).includes("renew_work_pass"));
    assert.ok(!(await names(new WorkDesk())).includes("renew_work_pass"));
  });
});

describe("CLIs with passes", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const cli = join(root, "src", "cli.ts");

  test("awl-desk serve signs passes that awl-desk gateway --pass-keys enforces", async () => {
    const store = tempDir();
    const file = (name: string, value: unknown) => {
      const path = join(store, name);
      writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
      return path;
    };
    const keys = file("keys.json", { keys: { "key-manager": MANAGER, "key-worker": WORKER } });
    const child = spawn(process.execPath, [cli, "serve", "--keys", keys, "--port", "0", "--store", store, "--pass-key", file("priv.json", priv), "--issuer", ISSUER], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    cleanup.push(async () => child.kill());
    const url = await new Promise<URL>((resolve, reject) => {
      let stderr = "";
      child.stderr.on("data", (d) => {
        stderr += d;
        const m = /listening on (\S+)/.exec(stderr);
        if (m) resolve(new URL(m[1]));
      });
      child.on("exit", () => reject(new Error(stderr)));
    });
    const session = async (key: string) => {
      const client = new Client({ name: key, version: "0" });
      await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${key}` } } }));
      cleanup.push(() => client.close());
      return async (name: string, args: Record<string, unknown>) => body((await client.callTool({ name, arguments: args })) as Result);
    };
    const manager = await session("key-manager");
    const worker = await session("key-worker");
    const id = (await manager("create_work_order", { ...orderInput({ tools: ["filings/search"] }) })).id;
    await worker("accept_work_order", { id });
    const { pass } = await worker("start_work_order", { id });
    assert.equal(decodePass(pass).iss, ISSUER);

    // The gateway gets the public key and the pass, and never reads the desk's store.
    const upstream = join(root, "test", "fixtures", "upstream.ts");
    const config = file("upstream.json", { mcpServers: { filings: { command: process.execPath, args: [upstream, "filings"] } } });
    const gatewayClient = new Client({ name: WORKER, version: "0" });
    await gatewayClient.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [cli, "gateway", "--order", id, "--config", config, "--store", tempDir(), "--actor", WORKER, "--pass-keys", file("pub.json", pub), "--pass-file", file("pass.txt", pass), "--issuer", ISSUER],
        stderr: "ignore",
      }),
    );
    cleanup.push(() => gatewayClient.close());
    const callGateway = async (name: string) => (await gatewayClient.callTool({ name, arguments: {} })) as Result;
    assert.deepEqual((await gatewayClient.listTools()).tools.map((t) => t.name).sort(), ["awl_usage", "filings__search"]);
    assert.equal((await callGateway("filings__search"))._meta?.["awl/jti"], decodePass(pass).jti);
    assert.equal(body(await callGateway("filings__get_section")).code, "TOOL_NOT_ALLOWED");

    // The worker renews; the gateway reads the new pass from the file on the next call.
    const renewed = (await worker("renew_work_pass", { id })).pass;
    file("pass.txt", renewed);
    assert.equal((await callGateway("filings__search"))._meta?.["awl/jti"], decodePass(renewed).jti);
    file("pass.txt", "");
    assert.equal(body(await callGateway("filings__search")).code, "PASS_INVALID");
    assert.equal((await new FileStore(store).read(id))!.state, "working");
  });

  test("serve refuses a pass key without an issuer, or one that cannot sign", async () => {
    const dir = tempDir();
    const keys = join(dir, "keys.json");
    writeFileSync(keys, JSON.stringify({ keys: { k: MANAGER } }));
    const pubFile = join(dir, "pub.json");
    writeFileSync(pubFile, JSON.stringify(pub));
    const exit = (args: string[]) =>
      new Promise((resolve) => spawn(process.execPath, [cli, "serve", "--keys", keys, "--port", "0", ...args], { stdio: "ignore" }).on("exit", resolve));
    assert.equal(await exit(["--pass-key", pubFile]), 2);
    assert.equal(await exit(["--pass-key", pubFile, "--issuer", ISSUER]), 2);
  });
});
