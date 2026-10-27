// Starts an MCP server over stdio and checks it the way a client or a registry scanner would:
// handshake, tools/list, a read-only call, and with --exercise a write and a read back.
// Plain JavaScript with no dependencies, so it runs on any Node the package supports and
// against any way of installing the server (source build, packed tarball, npx).
//
//   node scripts/mcp-probe.mjs [--expect <tools.json>] [--exercise] -- <command> [args...]
//
// Fails on: anything on stdout that is not a JSON-RPC message, the server exiting early,
// a request that gets no answer, an error result, or a tool list that differs from --expect.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const split = argv.indexOf("--");
if (split < 1 && argv[0] !== "--") usage();
const flags = argv.slice(0, split);
const [command, ...args] = argv.slice(split + 1);
if (!command) usage();
const expectFile = flags.includes("--expect") ? flags[flags.indexOf("--expect") + 1] : undefined;
const exercise = flags.includes("--exercise");

function usage() {
  console.error("usage: node mcp-probe.mjs [--expect <tools.json>] [--exercise] -- <command> [args...]");
  process.exit(2);
}

const TIMEOUT_MS = 30_000;
const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
let stderr = "";
child.stderr.on("data", (d) => (stderr += d));

const fail = (message) => {
  console.error(`mcp-probe: FAIL: ${message}`);
  if (stderr.trim()) console.error(`--- server stderr ---\n${stderr.trim()}`);
  child.kill("SIGKILL");
  process.exit(1);
};

let exited = false;
child.on("error", (e) => fail(`could not start "${command}": ${e.message}`));
child.on("exit", (code, signal) => {
  exited = true;
  if (!closing) fail(`server exited early (code ${code}, signal ${signal})`);
});

const waiting = new Map();
let buffer = "";
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      fail(`stdout is the protocol channel, but the server wrote: ${line.slice(0, 200)}`);
    }
    if (message.jsonrpc !== "2.0") fail(`not a JSON-RPC 2.0 message: ${line.slice(0, 200)}`);
    if (message.id !== undefined && waiting.has(message.id)) {
      waiting.get(message.id)(message);
      waiting.delete(message.id);
    }
  }
});

let nextId = 1;
function request(method, params) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve) => {
    const timer = setTimeout(() => fail(`no answer to ${method} within ${TIMEOUT_MS / 1000}s`), TIMEOUT_MS);
    waiting.set(id, (message) => {
      clearTimeout(timer);
      if (message.error) fail(`${method} returned an error: ${JSON.stringify(message.error)}`);
      resolve(message.result);
    });
  });
}

async function call(name, args) {
  const result = await request("tools/call", { name, arguments: args });
  const text = result.content?.find((c) => c.type === "text")?.text ?? "";
  if (result.isError) fail(`${name} returned an error result: ${text.slice(0, 300)}`);
  return text;
}

let closing = false;
const init = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mcp-probe", version: "1" } });
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
const { tools } = await request("tools/list", {});
const names = tools.map((t) => t.name).sort();

if (expectFile) {
  const expected = [...JSON.parse(readFileSync(expectFile, "utf8")).tools].sort();
  const missing = expected.filter((n) => !names.includes(n));
  const extra = names.filter((n) => !expected.includes(n));
  if (missing.length || extra.length) fail(`tool list differs from ${expectFile}. missing: [${missing}] unexpected: [${extra}]`);
}

const listed = JSON.parse(await call("list_work_orders", {}));
if (!Array.isArray(listed)) fail(`list_work_orders did not return an array`);

let wrote = "";
if (exercise) {
  const deadline = new Date(Date.now() + 3_600_000).toISOString();
  const created = JSON.parse(
    await call("create_work_order", {
      to: "agent:worker", goal: "Probe the server", criteria: [{ id: "c1", text: "It answers" }], budget: { usd: 1 }, deadline, tools: [],
    }),
  );
  const id = created.order?.id ?? created.id;
  if (!id) fail(`create_work_order returned no order id`);
  const read = await call("get_work_order", { id });
  if (!read.includes(id)) fail(`get_work_order did not return order ${id}`);
  wrote = `, wrote and read back ${id}`;
}

// A clean shutdown: closing stdin should end the server.
closing = true;
child.stdin.end();
await new Promise((resolve) => {
  if (exited) return resolve();
  const timer = setTimeout(() => fail("server did not exit within 5s of stdin closing"), 5_000);
  child.on("exit", () => {
    clearTimeout(timer);
    resolve();
  });
});
console.log(`ok ${init.serverInfo.name} ${init.serverInfo.version}: ${names.length} tools${expectFile ? " as expected" : ""}${wrote}`);
