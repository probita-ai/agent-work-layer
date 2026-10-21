// Checks from SPEC.md §7 (orders and reports) and §8 (sub-orders). No Node built-ins here:
// the validator also runs in browsers, Deno and Bun (see src/validator.ts).
import Ajv2020Module from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import type { ErrorObject, ValidateFunction } from "ajv";
import { workOrderSchema, workReportSchema } from "./generated.ts";
import { UNITS } from "./types.ts";
import type { Finding, State, WorkOrder, WorkReport } from "./types.ts";

// ajv and ajv-formats are CommonJS; their classes live on `.default` under NodeNext.
const Ajv2020 = Ajv2020Module.default;
const addFormats = addFormatsModule.default;

function newAjv() {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv;
}

/** The JSON Schemas shipped with this package. */
export { workOrderSchema, workReportSchema };

const ajv = newAjv();
const orderShape = ajv.compile<WorkOrder>(workOrderSchema);
const reportShape = ajv.compile<WorkReport>(workReportSchema);

const time = (s: string) => Date.parse(s);
const finding = (rule: string, kind: Finding["kind"], path: string, message: string): Finding => ({ rule, kind, path, message });

function schemaFindings(rule: string, errors: ErrorObject[] | null | undefined, prefix = ""): Finding[] {
  return (errors ?? []).map((e) => {
    const extra = (e.params as { additionalProperty?: string }).additionalProperty;
    return finding(rule, "invalid", prefix + (e.instancePath || "") || "/", extra ? `unknown field "${extra}"` : (e.message ?? "schema error"));
  });
}

/** Compiles a caller-supplied JSON Schema in its own instance so ids cannot collide. */
function compileUserSchema(schema: Record<string, unknown>): ValidateFunction {
  return newAjv().compile(schema);
}

/** Does a concrete tool name (`server/tool`) match one of the allowed patterns? */
export function toolAllowed(tool: string, patterns: readonly string[]): boolean {
  const server = tool.split("/")[0];
  return patterns.some((p) => p === "*" || p === tool || p === `${server}/*`);
}

/** Is everything a child pattern allows also allowed by the parent's patterns? */
export function patternCovered(child: string, parent: readonly string[]): boolean {
  if (parent.includes("*")) return true;
  if (child === "*") return false;
  const [server, tool] = child.split("/");
  if (tool === "*") return parent.includes(`${server}/*`);
  return toolAllowed(child, parent);
}

/** Type guard: structurally a Work Order (rule O1 only). */
export const isWorkOrder = (value: unknown): value is WorkOrder => orderShape(value);

/** Type guard: structurally a Work Report (rule R1 only). */
export const isWorkReport = (value: unknown): value is WorkReport => reportShape(value);

/** Runs order checks O1–O4. Returns an empty array when the order is valid. */
export function validateOrder(order: unknown): Finding[] {
  if (!orderShape(order)) return schemaFindings("O1", orderShape.errors);
  const out: Finding[] = [];

  const seen = new Set<string>();
  order.criteria.forEach((c, i) => {
    if (seen.has(c.id)) out.push(finding("O2", "invalid", `/criteria/${i}/id`, `duplicate criterion id "${c.id}"`));
    seen.add(c.id);
  });

  if (time(order.deadline) <= time(order.created_at)) {
    out.push(finding("O3", "invalid", "/deadline", "deadline must be later than created_at"));
  }

  if (order.output_schema) {
    try {
      compileUserSchema(order.output_schema);
    } catch (e) {
      out.push(finding("O4", "invalid", "/output_schema", `not a valid JSON Schema: ${(e as Error).message}`));
    }
  }
  return out;
}

/** Runs report checks R1–R12 against the order it answers. The order is assumed valid. */
export function validateReport(report: unknown, order: WorkOrder): Finding[] {
  if (!reportShape(report)) return schemaFindings("R1", reportShape.errors);
  const out: Finding[] = [];
  const add = (rule: string, kind: Finding["kind"], path: string, message: string) => out.push(finding(rule, kind, path, message));

  if (report.order_id !== order.id) add("R2", "invalid", "/order_id", `does not match order id "${order.id}"`);

  const criterionIds = new Set(order.criteria.map((c) => c.id));
  report.evidence.forEach((e, i) => {
    if (!criterionIds.has(e.criterion)) add("R3", "invalid", `/evidence/${i}/criterion`, `unknown criterion "${e.criterion}"`);
  });

  if (report.status === "done") {
    const proven = new Set(report.evidence.map((e) => e.criterion));
    for (const c of order.criteria) {
      if (!proven.has(c.id)) add("R4", "invalid", "/evidence", `no evidence for criterion "${c.id}"`);
    }
  }

  report.tools_used.forEach((t, i) => {
    if (!toolAllowed(t, order.tools)) add("R5", "invalid", `/tools_used/${i}`, `tool "${t}" is not allowed by this order`);
  });

  for (const unit of UNITS) {
    const limit = order.budget[unit];
    if (limit === undefined) continue;
    const spent = report.cost[unit];
    if (spent === undefined) add("R6", "invalid", "/cost", `cost must report "${unit}" because the budget sets it`);
    else if (spent > limit) add("R7", "limit", `/cost/${unit}`, `spent ${spent} ${unit}, budget is ${limit}`);
  }

  if (time(report.finished_at) > time(order.deadline)) add("R8", "limit", "/finished_at", "finished after the deadline");
  if (report.status === "blocked" && !report.questions?.length) add("R9", "invalid", "/questions", "a blocked report must ask at least one question");
  if (report.status === "failed" && !report.error) add("R10", "invalid", "/error", "a failed report must say what went wrong");

  if (report.status === "done" && order.output_schema) {
    const check = compileUserSchema(order.output_schema);
    if (!check(report.result.output)) out.push(...schemaFindings("R11", check.errors, "/result/output"));
  }

  if (report.started_at && time(report.started_at) > time(report.finished_at)) {
    add("R12", "invalid", "/started_at", "started_at is after finished_at");
  }
  return out;
}

/** The parts of an order (or a Delegation Pass) that carry authority. */
type Authority = Pick<WorkOrder, "budget" | "tools" | "deadline">;

/** Runs sub-order checks C1–C3: a child order may only narrow its parent's authority. */
export function validateChildOrder(child: Authority, parent: Authority): Finding[] {
  const out: Finding[] = [];
  for (const unit of UNITS) {
    const limit = parent.budget[unit];
    if (limit === undefined) continue;
    const asked = child.budget[unit];
    if (asked === undefined) out.push(finding("C1", "invalid", "/budget", `must set "${unit}" because the parent does`));
    else if (asked > limit) out.push(finding("C1", "invalid", `/budget/${unit}`, `${asked} exceeds parent's ${limit}`));
  }
  child.tools.forEach((p, i) => {
    if (!patternCovered(p, parent.tools)) out.push(finding("C2", "invalid", `/tools/${i}`, `"${p}" is wider than the parent allows`));
  });
  if (time(child.deadline) > time(parent.deadline)) {
    out.push(finding("C3", "invalid", "/deadline", "later than the parent's deadline"));
  }
  return out;
}

/** Units whose sub-order budgets add up (C4). `seconds` is wall-clock time, and sub-orders run side by side. */
const SHARED_UNITS = ["usd", "tokens", "tool_calls"] as const;

/** Absorbs floating-point error in sums of money, so 0.1 + 0.2 fits a budget of 0.3. */
const EPSILON = 1e-9;

/**
 * Runs sub-order check C4: a parent's sub-orders, this one included, stay within its budget together.
 * `siblings` are the parent's existing sub-orders with their states; declined ones are not counted.
 */
export function validateChildBudgets(
  child: Pick<WorkOrder, "budget">,
  parent: Pick<WorkOrder, "budget">,
  siblings: readonly { order: Pick<WorkOrder, "budget">; state: State }[],
): Finding[] {
  const counted = siblings.filter((s) => s.state !== "declined").map((s) => s.order);
  const out: Finding[] = [];
  for (const unit of SHARED_UNITS) {
    const limit = parent.budget[unit];
    if (limit === undefined) continue;
    const total = [child, ...counted].reduce((sum, o) => sum + (o.budget[unit] ?? 0), 0);
    if (total - limit > EPSILON) {
      out.push(finding("C4", "invalid", `/budget/${unit}`, `sub-orders would total ${Number(total.toFixed(9))} ${unit}, parent's budget is ${limit}`));
    }
  }
  return out;
}

/** True when any finding rejects the document. */
export const hasInvalid = (findings: readonly Finding[]): boolean => findings.some((f) => f.kind === "invalid");
