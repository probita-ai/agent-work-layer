import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { VERSION } from "../src/version.ts";
import { MANAGER, WORKER, orderInput, reportInput, tempDir } from "./helpers.ts";

const cli = join(fileURLToPath(new URL("..", import.meta.url)), "src", "cli.ts");

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
