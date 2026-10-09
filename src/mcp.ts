// The desk as an MCP server (SPEC.md §9, MCP binding).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AwlError } from "./errors.ts";
import { STATES } from "./lifecycle.ts";
import { summarize } from "./desk.ts";
import type { WorkDesk } from "./desk.ts";
import type { OrderRecord, State, WorkOrderInput, WorkReportInput } from "./types.ts";
import { VERSION } from "./version.ts";

export interface DeskServerOptions {
  desk: WorkDesk;
  /**
   * Fixes who this server acts as. When set, tools act as this identity and refuse any
   * other `actor` argument, so a worker session cannot approve its own work.
   */
  actor?: string;
  name?: string;
}

const amounts = z
  .object({
    usd: z.number().min(0).optional(),
    tokens: z.number().int().min(0).optional(),
    tool_calls: z.number().int().min(0).optional(),
    seconds: z.number().min(0).optional(),
  })
  .strict();
const actorArg = z.string().optional().describe("Who is acting. Omit to use this session's identity.");
const idArg = z.string().describe("Work order id");

const view = (r: OrderRecord) => ({ ...summarize(r), order: r.order, latest_report: r.reports.at(-1) ?? null, findings: r.findings, events: r.events });

/** Drops keys whose value is undefined so they don't reach JSON Schema validation. */
const defined = <T extends object>(o: T): T => JSON.parse(JSON.stringify(o));

async function respond(fn: () => unknown) {
  try {
    const value = await fn();
    return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
  } catch (e) {
    const body = e instanceof AwlError ? e.toJSON() : { code: "INTERNAL", message: String(e) };
    return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
  }
}

/** Builds an MCP server exposing the desk's operations as tools. Connect it to any transport. */
export function createDeskServer({ desk, actor: sessionActor, name = "awl-work-desk" }: DeskServerOptions): McpServer {
  const server = new McpServer({ name, version: VERSION });

  const who = (arg?: string): string => {
    if (sessionActor && arg && arg !== sessionActor) throw new AwlError("FORBIDDEN", `this session acts as "${sessionActor}", not "${arg}"`);
    const actor = arg ?? sessionActor;
    if (!actor) throw new AwlError("BAD_REQUEST", 'no actor: pass "actor" or start the desk with an identity');
    return actor;
  };

  server.registerTool(
    "create_work_order",
    {
      description:
        "Issue a Work Order to a worker agent. Every criterion must be provable with evidence. " +
        "Set parent_id to split your own order into a sub-order; it may only narrow budget, tools and deadline.",
      inputSchema: {
        actor: actorArg,
        to: z.string().describe("Worker agent reference (Agent Card URL or name)"),
        goal: z.string().describe("What to achieve, in plain language"),
        criteria: z.array(z.object({ id: z.string(), text: z.string() })).min(1).describe("How done will be judged"),
        budget: amounts.describe("Upper limits; set at least one unit"),
        deadline: z.string().describe("RFC 3339 timestamp"),
        tools: z.array(z.string()).describe('Allowed tools: "server/tool", "server/*" or "*"'),
        escalate_to: z.string().optional(),
        inputs: z.record(z.any()).optional(),
        context: z.array(z.object({ uri: z.string(), note: z.string().optional() })).optional(),
        output_schema: z.record(z.any()).optional().describe("JSON Schema that result.output must match"),
        parent_id: z.string().optional(),
        id: z.string().optional().describe("Optional explicit id"),
        metadata: z.record(z.any()).optional(),
      },
    },
    async ({ actor, ...input }) => respond(async () => view(await desk.create(defined(input) as WorkOrderInput, who(actor)))),
  );

  server.registerTool(
    "list_work_orders",
    {
      description: "List work orders. Workers: filter by to=<yourself> and state=offered to find new jobs.",
      inputSchema: {
        to: z.string().optional(),
        from: z.string().optional(),
        state: z.enum(STATES as [State, ...State[]]).optional(),
        parent_id: z.string().optional(),
      },
    },
    async (filter) => respond(() => desk.list(defined(filter))),
  );

  server.registerTool(
    "get_work_order",
    { description: "Full order, current state, latest report, check findings and event log.", inputSchema: { id: idArg } },
    async ({ id }) => respond(async () => view(await desk.get(id))),
  );

  server.registerTool(
    "accept_work_order",
    { description: "Worker accepts an offered order.", inputSchema: { id: idArg, actor: actorArg } },
    async ({ id, actor }) => respond(async () => view(await desk.accept(id, who(actor)))),
  );

  server.registerTool(
    "decline_work_order",
    { description: "Worker declines an offered order.", inputSchema: { id: idArg, actor: actorArg, reason: z.string().optional() } },
    async ({ id, actor, reason }) => respond(async () => view(await desk.decline(id, who(actor), reason))),
  );

  server.registerTool(
    "start_work_order",
    { description: "Worker starts an accepted order.", inputSchema: { id: idArg, actor: actorArg } },
    async ({ id, actor }) => respond(async () => view(await desk.start(id, who(actor)))),
  );

  server.registerTool(
    "submit_work_report",
    {
      description:
        "Worker reports on an order. done needs evidence for every criterion; blocked needs questions; failed needs error. " +
        "A rejected report returns the failed checks so you can fix it and resubmit.",
      inputSchema: {
        id: idArg,
        actor: actorArg,
        status: z.enum(["done", "blocked", "failed"]),
        result: z.object({
          summary: z.string(),
          output: z.any().optional(),
          artifacts: z.array(z.object({ uri: z.string(), media_type: z.string().optional(), note: z.string().optional() })).optional(),
        }),
        evidence: z.array(
          z.object({
            criterion: z.string(),
            type: z.enum(["tool_call", "artifact", "citation", "note"]),
            ref: z.string().optional(),
            note: z.string().optional(),
          }),
        ),
        cost: amounts,
        tools_used: z.array(z.string()).describe('Exact tool names called, as "server/tool"'),
        started_at: z.string().optional(),
        finished_at: z.string().optional(),
        questions: z.array(z.string()).optional(),
        error: z.string().optional(),
        metadata: z.record(z.any()).optional(),
      },
    },
    async ({ id, actor, ...input }) =>
      respond(async () => {
        const { record, findings } = await desk.submitReport(id, defined(input) as WorkReportInput, who(actor));
        return { ...summarize(record), findings };
      }),
  );

  server.registerTool(
    "answer_question",
    { description: "Manager or escalation contact answers a blocked worker; the order returns to working.", inputSchema: { id: idArg, actor: actorArg, answer: z.string() } },
    async ({ id, actor, answer }) => respond(async () => view(await desk.answer(id, who(actor), answer))),
  );

  server.registerTool(
    "review_work_report",
    {
      description: "Manager approves a submitted report, or sends it back for rework with a reason.",
      inputSchema: { id: idArg, actor: actorArg, decision: z.enum(["approve", "rework"]), reason: z.string().optional() },
    },
    async ({ id, actor, decision, reason }) => respond(async () => view(await desk.review(id, who(actor), decision, reason))),
  );

  server.registerTool(
    "cancel_work_order",
    { description: "Manager cancels an order that is not finished.", inputSchema: { id: idArg, actor: actorArg, reason: z.string().optional() } },
    async ({ id, actor, reason }) => respond(async () => view(await desk.cancel(id, who(actor), reason))),
  );

  server.registerTool(
    "wait_for_update",
    {
      description: "Wait until the order changes after since_seq (up to timeout_s seconds). Use it to follow a job live.",
      inputSchema: { id: idArg, since_seq: z.number().int().min(0), timeout_s: z.number().min(1).max(55).optional() },
    },
    async ({ id, since_seq, timeout_s }, extra) =>
      respond(async () => view(await desk.waitForChange(id, since_seq, { timeoutMs: (timeout_s ?? 25) * 1000, signal: extra.signal }))),
  );

  return server;
}
