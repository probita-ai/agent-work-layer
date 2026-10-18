import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { WorkDesk } from "agent-work-layer";
import { AuthError, apiKeyAuth, bearerAuth, createDeskHttpHandler, resourceMetadataUrl } from "../src/index.ts";
import type { Authenticate, DeskHttpOptions, TokenClaims } from "../src/index.ts";
import { LEAD, MANAGER, WORKER, orderInput, reportInput, tempDir } from "./helpers.ts";

const KEYS = { "key-manager": MANAGER, "key-worker": WORKER, "key-lead": LEAD };
const cleanup: (() => Promise<unknown>)[] = [];
after(() => Promise.all(cleanup.map((f) => f())));

/** Serves a desk over HTTP on a free port and returns its /mcp URL. */
async function serve(authenticate: Authenticate, options: Partial<DeskHttpOptions> = {}) {
  const handle = createDeskHttpHandler({ desk: new WorkDesk(), authenticate, ...options });
  const http = createServer((req, res) => void handle(req, res));
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise((resolve) => http.close(resolve)));
  return new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`);
}

async function connect(url: URL, token: string) {
  const client = new Client({ name: token, version: "0" });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  cleanup.push(() => client.close());
  return async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    return { ok: !r.isError, body: JSON.parse(r.content[0].text) };
  };
}

const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } } };
const post = (url: URL, headers: Record<string, string> = {}) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(initialize) });

describe("desk over HTTP with API keys", () => {
  test("an unauthenticated request is refused with 401", async () => {
    const url = await serve(apiKeyAuth(KEYS));
    const none = await post(url);
    assert.equal(none.status, 401);
    assert.match(none.headers.get("www-authenticate") ?? "", /^Bearer/);
    assert.equal(((await none.json()) as { error: string }).error, "invalid_token");
    assert.equal((await post(url, { authorization: "Bearer nope" })).status, 401);
    await assert.rejects(connect(url, "nope"));
    assert.equal((await post(url, { authorization: "Bearer key-worker" })).status, 200);
  });

  test("runs a full job, with the actor taken from the key", async () => {
    const url = await serve(apiKeyAuth(KEYS));
    const manager = await connect(url, "key-manager");
    const worker = await connect(url, "key-worker");
    const created = await manager("create_work_order", { ...orderInput() });
    assert.ok(created.ok, JSON.stringify(created.body));
    const id = created.body.id;
    assert.equal(created.body.order.from, MANAGER);

    const waiting = manager("wait_for_update", { id, since_seq: 1, timeout_s: 5 });
    await worker("accept_work_order", { id });
    assert.equal((await waiting).body.state, "accepted");
    await worker("submit_work_report", { id, ...reportInput() });
    const approved = await manager("review_work_report", { id, decision: "approve" });
    assert.equal(approved.body.state, "approved");
    assert.equal(approved.body.latest_report.from, WORKER);
  });

  test("an authenticated worker can't approve its own report", async () => {
    const url = await serve(apiKeyAuth(KEYS));
    const manager = await connect(url, "key-manager");
    const worker = await connect(url, "key-worker");
    const id = (await manager("create_work_order", { ...orderInput() })).body.id;
    await worker("accept_work_order", { id });
    await worker("submit_work_report", { id, ...reportInput() });
    const review = await worker("review_work_report", { id, decision: "approve" });
    assert.equal(review.ok, false);
    assert.equal(review.body.code, "FORBIDDEN");
  });

  test("a spoofed actor argument is refused", async () => {
    const url = await serve(apiKeyAuth(KEYS));
    const manager = await connect(url, "key-manager");
    const worker = await connect(url, "key-worker");
    const id = (await manager("create_work_order", { ...orderInput() })).body.id;
    for (const [tool, args] of [
      ["cancel_work_order", { id }],
      ["create_work_order", { ...orderInput() }],
      ["answer_question", { id, answer: "x" }],
    ] as const) {
      const spoof = await worker(tool, { ...args, actor: MANAGER });
      assert.equal(spoof.body.code, "FORBIDDEN", tool);
    }
    assert.equal((await manager("get_work_order", { id })).body.state, "offered");
    assert.ok((await worker("accept_work_order", { id, actor: WORKER })).ok);
  });

  test("serves only the MCP path", async () => {
    const url = await serve(apiKeyAuth(KEYS));
    assert.equal((await post(new URL("/other", url), { authorization: "Bearer key-worker" })).status, 404);
  });

  test("answers a malformed request target with 400", async () => {
    const url = await serve(apiKeyAuth(KEYS));
    const status = await new Promise((resolve, reject) =>
      request({ host: url.hostname, port: url.port, path: "//[/mcp", method: "POST" }, (res) => resolve(res.resume().statusCode)).on("error", reject).end(),
    );
    assert.equal(status, 400);
    assert.equal((await post(url, { authorization: "Bearer key-worker" })).status, 200, "server still up");
  });

  test("rejects empty keys and agent refs", () => {
    assert.throws(() => apiKeyAuth({ "": MANAGER }));
    assert.throws(() => apiKeyAuth({ k: "" }));
    assert.throws(() => apiKeyAuth({ k: 1 } as unknown as Record<string, string>));
  });
});

describe("custom authenticate hooks", () => {
  test("an AuthError sets the status and challenge; other errors fail closed", async () => {
    const auth: Authenticate = (req) => {
      if (req.headers["x-who"] === "nobody") throw new AuthError("not an agent", { status: 403 });
      if (req.headers["x-who"] === "boom") throw new Error("secret detail");
      if (req.headers["x-who"] === "empty") return undefined;
      throw new AuthError("mTLS required", { challenge: 'Mutual realm="desk"' });
    };
    const url = await serve(auth);
    assert.equal((await post(url, { "x-who": "nobody" })).status, 403);
    const boom = await post(url, { "x-who": "boom" });
    assert.equal(boom.status, 401);
    assert.doesNotMatch(await boom.text(), /secret detail/);
    assert.equal((await post(url, { "x-who": "empty" })).status, 401);
    assert.equal((await post(url)).headers.get("www-authenticate"), 'Mutual realm="desk"');
  });
});

describe("desk over HTTP with OAuth bearer tokens", () => {
  const AUD = "https://desk.example.com/mcp";
  const NOW = new Date("2026-10-17T12:00:00Z");
  const exp = NOW.getTime() / 1000 + 300;
  // Stands in for signature and issuer checks: a token is the JSON of its claims, or "bad".
  const verify = (token: string): TokenClaims => {
    if (token === "bad") throw new Error("signature");
    return JSON.parse(Buffer.from(token, "base64url").toString());
  };
  const token = (claims: TokenClaims) => Buffer.from(JSON.stringify(claims)).toString("base64url");
  const bearer = (claims: TokenClaims) => ({ authorization: `Bearer ${token(claims)}` });

  test("checks expiry and audience, and maps sub to an agent", async () => {
    const meta = resourceMetadataUrl(AUD);
    const url = await serve(bearerAuth({ verify, audience: AUD, agents: { "u-1": MANAGER }, resourceMetadataUrl: meta, clock: () => NOW }));

    const missing = await post(url);
    assert.equal(missing.status, 401);
    assert.equal(missing.headers.get("www-authenticate"), `Bearer resource_metadata="${meta}"`);
    const bad = await post(url, { authorization: "Bearer bad" });
    assert.match(bad.headers.get("www-authenticate") ?? "", /error="invalid_token".*resource_metadata=/);

    assert.equal((await post(url, bearer({ sub: "u-1", aud: AUD, exp: exp - 600 }))).status, 401, "expired");
    assert.equal((await post(url, bearer({ sub: "u-1", aud: AUD }))).status, 401, "no exp");
    assert.equal((await post(url, bearer({ sub: "u-1", aud: "https://other.example.com", exp }))).status, 401, "wrong audience");
    assert.equal((await post(url, bearer({ sub: "u-2", aud: AUD, exp }))).status, 403, "unmapped subject");
    assert.equal((await post(url, bearer({ sub: "toString", aud: AUD, exp }))).status, 403, "prototype key");
    assert.equal((await post(url, bearer({ sub: "u-1", aud: ["x", AUD], exp }))).status, 200);

    const manager = await connect(url, token({ sub: "u-1", aud: AUD, exp }));
    assert.equal((await manager("create_work_order", { ...orderInput() })).body.order.from, MANAGER);
  });

  test("uses sub as is by default, or a mapping function", async () => {
    const asIs = await serve(bearerAuth({ verify, audience: AUD, clock: () => NOW }));
    const call = await connect(asIs, token({ sub: LEAD, aud: AUD, exp }));
    assert.equal((await call("create_work_order", { ...orderInput() })).body.order.from, LEAD);

    const ruled = await serve(bearerAuth({ verify, audience: AUD, agents: (c) => (c.sub ? `agent:${c.sub}` : undefined), clock: () => NOW }));
    const worker = await connect(ruled, token({ sub: "worker", aud: AUD, exp }));
    assert.equal((await worker("create_work_order", { ...orderInput(), actor: MANAGER })).body.code, "FORBIDDEN");
  });

  test("serves protected resource metadata without authentication", async () => {
    const resourceMetadata = { resource: AUD, authorization_servers: ["https://auth.example.com"] };
    const url = await serve(bearerAuth({ verify, audience: AUD }), { resourceMetadata });
    const r = await fetch(new URL("/.well-known/oauth-protected-resource/mcp", url));
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), resourceMetadata);
    assert.equal(resourceMetadataUrl(AUD), "https://desk.example.com/.well-known/oauth-protected-resource/mcp");
  });

  test("requires an audience", () => {
    assert.throws(() => bearerAuth({ verify, audience: "" }));
  });
});

describe("awl-desk serve", () => {
  const cli = join(fileURLToPath(new URL("..", import.meta.url)), "src", "cli.ts");

  async function exitOf(args: string[]) {
    const child = spawn(process.execPath, [cli, "serve", ...args], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    const code = await new Promise((resolve) => child.on("exit", resolve));
    return { code, stderr };
  }

  test("refuses to start without keys", async () => {
    const r = await exitOf([]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--keys is required/);
  });

  test("refuses a malformed keys file instead of inventing keys", async () => {
    const dir = tempDir();
    for (const keys of [["agent:manager"], { k: 1 }, {}, "agent:manager"]) {
      const file = join(dir, "keys.json");
      writeFileSync(file, JSON.stringify({ keys }));
      const r = await exitOf(["--keys", file, "--port", "0"]);
      assert.equal(r.code, 2, JSON.stringify(keys));
      assert.match(r.stderr, /keys/);
    }
  });

  test("serves a shared desk where the key decides the actor", async () => {
    const store = tempDir();
    const keys = join(store, "keys.json");
    writeFileSync(keys, JSON.stringify({ keys: KEYS }));
    const child = spawn(process.execPath, [cli, "serve", "--keys", keys, "--port", "0", "--store", store], { stdio: ["ignore", "ignore", "pipe"] });
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

    assert.equal((await post(url)).status, 401);
    const manager = await connect(url, "key-manager");
    const worker = await connect(url, "key-worker");
    const id = (await manager("create_work_order", { ...orderInput() })).body.id;
    assert.equal((await worker("cancel_work_order", { id, actor: MANAGER })).body.code, "FORBIDDEN");
    assert.equal((await worker("accept_work_order", { id })).body.state, "accepted");
  });
});
