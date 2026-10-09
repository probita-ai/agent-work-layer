#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WorkDesk } from "./desk.ts";
import { createDeskServer } from "./mcp.ts";
import { FileStore } from "./store.ts";
import { hasInvalid, validateChildOrder, validateOrder, validateReport, workOrderSchema, workReportSchema } from "./validate.ts";
import type { Finding, WorkOrder } from "./types.ts";
import { VERSION } from "./version.ts";

const HELP = `awl ${VERSION} — Agent Work Layer

Usage:
  awl validate <order.json> [report.json] [--parent <parent-order.json>] [--json]
  awl desk [--store <dir>] [--actor <agent-ref>]     Run the desk as an MCP server on stdio
  awl schema <order|report>                          Print a JSON Schema
  awl --version | --help

Environment for "awl desk": AWL_STORE (default ./.awl), AWL_ACTOR.
Exit codes: 0 ok, 1 invalid document, 2 usage or file error.`;

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new UsageError(`cannot read ${path}: ${(e as Error).message}`);
  }
}

class UsageError extends Error {}

function validate(args: string[]): number {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { parent: { type: "string" }, json: { type: "boolean" } } });
  const [orderPath, reportPath] = positionals;
  if (!orderPath) throw new UsageError("validate needs an order file");

  const results: { file: string; findings: Finding[] }[] = [];
  const order = readJson(orderPath);
  results.push({ file: orderPath, findings: validateOrder(order) });
  const orderOk = !hasInvalid(results[0].findings);

  if (orderOk && values.parent) {
    const parent = readJson(values.parent);
    const parentFindings = validateOrder(parent);
    results.push({ file: values.parent, findings: parentFindings });
    if (!hasInvalid(parentFindings)) results.push({ file: `${orderPath} (within parent)`, findings: validateChildOrder(order as WorkOrder, parent as WorkOrder) });
  }
  if (orderOk && reportPath) results.push({ file: reportPath, findings: validateReport(readJson(reportPath), order as WorkOrder) });

  const failed = results.some((r) => hasInvalid(r.findings));
  if (values.json) {
    console.log(JSON.stringify({ ok: !failed, results }, null, 2));
  } else {
    for (const { file, findings } of results) {
      console.log(`${!findings.length ? "✓" : hasInvalid(findings) ? "✗" : "!"} ${file}`);
      for (const f of findings) console.log(`  ${f.rule.padEnd(4)} ${f.kind.padEnd(7)} ${f.path}  ${f.message}`);
    }
  }
  return failed ? 1 : 0;
}

async function desk(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { store: { type: "string" }, actor: { type: "string" } } });
  const store = new FileStore(values.store ?? process.env.AWL_STORE ?? ".awl");
  const server = createDeskServer({ desk: new WorkDesk({ store }), actor: values.actor ?? process.env.AWL_ACTOR });
  await server.connect(new StdioServerTransport());
}

async function main(argv: string[]): Promise<number | undefined> {
  const [command, ...rest] = argv;
  switch (command) {
    case "validate":
      return validate(rest);
    case "desk":
      await desk(rest);
      return undefined; // keep running
    case "schema": {
      const which = rest[0];
      if (which !== "order" && which !== "report") throw new UsageError('schema needs "order" or "report"');
      console.log(JSON.stringify(which === "order" ? workOrderSchema : workReportSchema, null, 2));
      return 0;
    }
    case "--version":
    case "-v":
      console.log(VERSION);
      return 0;
    case undefined:
    case "--help":
    case "-h":
      console.log(HELP);
      return 0;
    default:
      throw new UsageError(`unknown command "${command}"`);
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code !== undefined) process.exitCode = code;
  },
  (e) => {
    console.error(e instanceof UsageError ? `awl: ${e.message}\n\n${HELP}` : e);
    process.exitCode = 2;
  },
);
