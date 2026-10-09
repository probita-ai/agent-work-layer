// Packs the library, installs the tarball into an empty project, and checks that the
// published entry points, types, schemas and CLI work the way a user would use them.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
// Drop settings inherited from a parent npm command (e.g. dry-run during `npm publish --dry-run`).
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.toLowerCase().startsWith("npm_config_")));
const run = (cmd: string, args: string[], cwd: string) => execFileSync(cmd, args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const packed = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", tmpdir()], root))[0];
const tarball = join(tmpdir(), packed.filename);
const files: string[] = packed.files.map((f: { path: string }) => f.path);

const required = ["dist/index.js", "dist/index.d.ts", "dist/mcp.js", "dist/cli.js", "schemas/work-order.schema.json", "schemas/work-report.schema.json", "README.md", "LICENSE", "SPEC.md"];
const missing = required.filter((f) => !files.includes(f));
const leaked = files.filter((f) => /^(src|test|scripts|examples)\/|\.map$|tsconfig/.test(f));
if (missing.length || leaked.length) throw new Error(`bad tarball. missing: ${missing.join(", ")} leaked: ${leaked.join(", ")}`);

const app = mkdtempSync(join(tmpdir(), "awl-consumer-"));
writeFileSync(join(app, "package.json"), JSON.stringify({ name: "consumer", type: "module", private: true }));
run("npm", ["install", "--no-audit", "--no-fund", tarball], app);

writeFileSync(
  join(app, "check.mjs"),
  `
import assert from "node:assert/strict";
import { WorkDesk, validateOrder, VERSION, workOrderSchema } from "agent-work-layer";
import { createDeskServer } from "agent-work-layer/mcp";
import schema from "agent-work-layer/schemas/work-order.schema.json" with { type: "json" };

const desk = new WorkDesk();
const rec = await desk.create({ to: "w", goal: "g", criteria: [{ id: "c1", text: "t" }], budget: { usd: 1 }, deadline: "2999-01-01T00:00:00Z", tools: [] }, "m");
assert.equal(rec.state, "offered");
assert.deepEqual(validateOrder(rec.order), []);
assert.equal(typeof createDeskServer, "function");
assert.equal(schema.title, workOrderSchema.title);
console.log("ok", VERSION);
`,
);
const out = run("node", ["check.mjs"], app);
if (!out.startsWith("ok ")) throw new Error(`import check failed: ${out}`);

const version = run(join(app, "node_modules", ".bin", "awl"), ["--version"], app).trim();
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
if (version !== pkg.version) throw new Error(`bin printed ${version}, expected ${pkg.version}`);
if (!existsSync(join(app, "node_modules", "agent-work-layer", "dist", "index.d.ts"))) throw new Error("types missing");

console.log(`package ok: ${packed.filename}, ${files.length} files, ${(packed.size / 1024).toFixed(1)} kB`);
