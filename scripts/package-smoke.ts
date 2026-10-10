// Packs both packages, installs the tarballs into empty projects, and checks that the
// published entry points, types, schemas and CLIs work the way a user would use them.
// Also checks that installing the core alone does not pull in the MCP SDK.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const coreDir = fileURLToPath(new URL("../packages/core", import.meta.url));
const mcpDir = fileURLToPath(new URL("../packages/mcp", import.meta.url));
// Drop settings inherited from a parent npm command (e.g. dry-run during `npm publish --dry-run`).
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.toLowerCase().startsWith("npm_config_")));
const run = (cmd: string, args: string[], cwd: string) => execFileSync(cmd, args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const fail = (message: string): never => {
  throw new Error(message);
};

interface Packed {
  tarball: string;
  files: string[];
  summary: string;
}

function pack(dir: string, required: string[]): Packed {
  const packed = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", tmpdir()], dir))[0];
  const files: string[] = packed.files.map((f: { path: string }) => f.path);
  const missing = required.filter((f) => !files.includes(f));
  const leaked = files.filter((f) => /^(src|test|scripts|examples|mcp)\/|\.map$|tsconfig/.test(f));
  if (missing.length || leaked.length) fail(`bad tarball ${packed.filename}. missing: ${missing.join(", ")} leaked: ${leaked.join(", ")}`);
  return { tarball: join(tmpdir(), packed.filename), files, summary: `${packed.filename}, ${files.length} files, ${(packed.size / 1024).toFixed(1)} kB` };
}

function project(tarballs: string[]) {
  const app = mkdtempSync(join(tmpdir(), "awl-consumer-"));
  writeFileSync(join(app, "package.json"), JSON.stringify({ name: "consumer", type: "module", private: true }));
  run("npm", ["install", "--no-audit", "--no-fund", ...tarballs], app);
  const installed = run("npm", ["ls", "--all", "--parseable"], app).trim().split("\n").length - 1;
  return { app, installed };
}

function script(app: string, name: string, body: string) {
  writeFileSync(join(app, name), body);
  const out = run("node", [name], app);
  if (!out.startsWith("ok")) fail(`${name} failed: ${out}`);
}

const corePkg = JSON.parse(readFileSync(join(coreDir, "package.json"), "utf8"));
const mcpPkg = JSON.parse(readFileSync(join(mcpDir, "package.json"), "utf8"));

const core = pack(coreDir, [
  "dist/index.js", "dist/index.d.ts", "dist/validator.js", "dist/validator.d.ts", "dist/generated.js", "dist/cli.js",
  "schemas/work-order.schema.json", "schemas/work-report.schema.json", "README.md", "LICENSE", "SPEC.md", "CHANGELOG.md",
]);
if (core.files.includes("dist/mcp.js")) fail("core tarball still contains dist/mcp.js");
const mcp = pack(mcpDir, ["dist/index.js", "dist/index.d.ts", "dist/cli.js", "README.md", "LICENSE"]);

// 1. The core on its own.
const alone = project([core.tarball]);
if (existsSync(join(alone.app, "node_modules", "@modelcontextprotocol"))) fail("core install pulled in the MCP SDK");
if (existsSync(join(alone.app, "node_modules", "zod"))) fail("core install pulled in zod");
script(
  alone.app,
  "core.mjs",
  `
import assert from "node:assert/strict";
import { WorkDesk, validateOrder, VERSION, workOrderSchema, ORDER_SPEC } from "agent-work-layer";
import * as validator from "agent-work-layer/validate";
import schema from "agent-work-layer/schemas/work-order.schema.json" with { type: "json" };

const desk = new WorkDesk();
const rec = await desk.create({ to: "w", goal: "g", criteria: [{ id: "c1", text: "t" }], budget: { usd: 1 }, deadline: "2999-01-01T00:00:00Z", tools: [], handoff: { next_step: "n" } }, "m");
assert.equal(rec.state, "offered");
assert.equal(rec.order.spec, ORDER_SPEC);
assert.deepEqual(validateOrder(rec.order), []);
assert.deepEqual(validator.validateOrder(rec.order), []);
assert.equal(validator.WorkDesk, undefined);
assert.deepEqual(schema, workOrderSchema);
await assert.rejects(import("agent-work-layer/mcp"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
console.log("ok", VERSION);
`,
);
const awl = join(alone.app, "node_modules", ".bin", "awl");
if (run(awl, ["--version"], alone.app).trim() !== corePkg.version) fail("awl --version does not match package.json");
try {
  run(awl, ["desk"], alone.app);
  fail("awl desk should exit 2");
} catch (e) {
  const err = e as { status?: number; stderr?: string };
  if (err.status !== 2 || !err.stderr?.includes("agent-work-layer-mcp")) fail(`awl desk should point to the MCP package, got: ${err.stderr}`);
}
const orderFile = join(alone.app, "order.json");
const reportFile = join(alone.app, "report.json");
writeFileSync(orderFile, run(awl, ["new", "order"], alone.app));
writeFileSync(reportFile, run(awl, ["new", "report"], alone.app));
run(awl, ["validate", orderFile, reportFile], alone.app);
if (!existsSync(join(alone.app, "node_modules", "agent-work-layer", "dist", "validator.d.ts"))) fail("types missing");

// 2. The MCP package, which brings the core with it.
const withMcp = project([core.tarball, mcp.tarball]);
script(
  withMcp.app,
  "mcp.mjs",
  `
import assert from "node:assert/strict";
import { WorkDesk } from "agent-work-layer";
import { createDeskServer } from "agent-work-layer-mcp";
assert.equal(typeof createDeskServer({ desk: new WorkDesk(), actor: "m" }).connect, "function");
console.log("ok");
`,
);
if (run(join(withMcp.app, "node_modules", ".bin", "awl-desk"), ["--version"], withMcp.app).trim() !== mcpPkg.version) fail("awl-desk --version does not match");

console.log(`core ok: ${core.summary}; installs ${alone.installed} packages`);
console.log(`mcp  ok: ${mcp.summary}; installs ${withMcp.installed} packages with the core`);
