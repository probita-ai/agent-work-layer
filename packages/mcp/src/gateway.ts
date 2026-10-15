// An MCP gateway for one work order (SPEC.md §9.1): it sits between a worker and its real
// MCP servers and enforces the order's `tools` and `budget` at every tool call.
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { AwlError, toolAllowed } from "agent-work-layer";
import type { Amounts, OrderRecord, WorkDesk } from "agent-work-layer";
import { VERSION } from "./version.ts";

export interface GatewayOptions {
  desk: WorkDesk;
  /** The order whose `tools` and `budget` this gateway enforces. */
  orderId: string;
  /** Connected clients for the worker's real MCP servers, keyed by server name (the `server` in `server/tool`). */
  upstreams: Record<string, Client>;
  /** Who the gateway acts as. Must be the order's worker. Default: the order's `to`. */
  actor?: string;
  /**
   * Refuse calls the order does not allow. Default true. With false, the gateway only observes:
   * every tool is listed, nothing is refused, and calls the order would not allow are logged with
   * a `violation`. Use it when your own gateway or policy engine already enforces access.
   */
  enforce?: boolean;
  /** JSONL file of calls. Loaded at start so a restart does not reset the budget, and appended to after each call. */
  logFile?: string;
  /** Joins server and tool names in exposed tool names. Default "__", since MCP clients may reject "/". */
  separator?: string;
  /** Current time. Override in tests. */
  clock?: () => Date;
  name?: string;
}

/** Why a call was refused before it reached the tool, or, when not enforcing, would have been. */
export type RefusalCode = "UNKNOWN_TOOL" | "TOOL_NOT_ALLOWED" | "ORDER_NOT_WORKING" | "BUDGET_SPENT";

/** One line of the call log. Refused calls have no `n` or `ref` and do not count against the budget. */
export interface CallRecord {
  /** 1 for the order's first call, +1 per call that reached a tool. */
  n?: number;
  /** Evidence ref for this call: `server/tool#n`. */
  ref?: string;
  /** `server/tool`. */
  tool: string;
  at: string;
  outcome: "ok" | "error" | "refused";
  ms?: number;
  refusal?: RefusalCode;
  /** Set when not enforcing: the call went through, but the order did not allow it. */
  violation?: RefusalCode;
  message?: string;
}

/** What the gateway measured, shaped to copy into a Work Report. */
export interface Usage {
  order_id: string;
  tools_used: string[];
  cost: Amounts;
  /** Budget left in the units the gateway enforces. */
  remaining: Amounts;
  calls: CallRecord[];
}

export interface Gateway {
  server: Server;
  usage(): Promise<Usage>;
}

export const USAGE_TOOL = "awl_usage";

class Refusal extends Error {
  readonly code: RefusalCode;

  constructor(code: RefusalCode, message: string) {
    super(message);
    this.code = code;
  }
}

const text = (value: unknown) => ({ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) });

/** Seconds since the order was first started, or undefined if it has not been. */
function workingSeconds(record: OrderRecord, now: Date): number | undefined {
  const start = record.events.find((e) => e.action === "start");
  return start ? Math.max(0, (now.getTime() - Date.parse(start.at)) / 1000) : undefined;
}

async function loadLog(file: string): Promise<CallRecord[]> {
  try {
    return (await readFile(file, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

/**
 * Builds a gateway server for one order. It lists only the upstream tools the order allows,
 * and refuses calls that are not allowed, that come after the `tool_calls` or `seconds` budget
 * is spent, or while the order is not `working`. With `enforce: false` it logs those calls
 * instead of refusing them. Connect it to any transport.
 */
export async function createGateway(options: GatewayOptions): Promise<Gateway> {
  const { desk, orderId, upstreams, logFile, enforce = true, separator = "__", clock = () => new Date(), name = "awl-gateway" } = options;
  const { order } = await desk.get(orderId);
  const actor = options.actor ?? order.to;
  if (actor !== order.to) throw new AwlError("FORBIDDEN", `only the order's worker "${order.to}" can use its gateway, not "${actor}"`);

  const calls: CallRecord[] = logFile ? await loadLog(logFile) : [];
  let count = calls.reduce((max, c) => Math.max(max, c.n ?? 0), 0);
  let logging = Promise.resolve();
  const log = (record: CallRecord) => {
    calls.push(record);
    if (logFile) {
      const file = logFile;
      logging = logging.then(async () => {
        await mkdir(dirname(file), { recursive: true });
        await appendFile(file, JSON.stringify(record) + "\n");
      });
    }
    return logging;
  };

  /** Exposed tool name → upstream server and tool. Rebuilt on every listing. */
  let routes = new Map<string, { server: string; tool: string; allowed: boolean }>();

  async function listUpstream(): Promise<Tool[]> {
    const next = new Map<string, { server: string; tool: string; allowed: boolean }>();
    const exposed: Tool[] = [];
    for (const [server, client] of Object.entries(upstreams)) {
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined);
        for (const tool of page.tools) {
          const allowed = toolAllowed(`${server}/${tool.name}`, order.tools);
          const exposedName = `${server}${separator}${tool.name}`;
          next.set(exposedName, { server, tool: tool.name, allowed });
          if (allowed || !enforce) exposed.push({ ...tool, name: exposedName, description: `[${server}] ${tool.description ?? ""}`.trim() });
        }
        cursor = page.nextCursor;
      } while (cursor);
    }
    routes = next;
    return exposed;
  }

  async function usage(): Promise<Usage> {
    const record = await desk.get(orderId);
    const seconds = workingSeconds(record, clock());
    const cost: Amounts = { tool_calls: count, ...(seconds === undefined ? {} : { seconds: Math.ceil(seconds) }) };
    const remaining: Amounts = {};
    if (order.budget.tool_calls !== undefined) remaining.tool_calls = Math.max(0, order.budget.tool_calls - count);
    if (order.budget.seconds !== undefined) remaining.seconds = Math.max(0, order.budget.seconds - (seconds ?? 0));
    const tools_used = [...new Set(calls.filter((c) => c.n !== undefined).map((c) => c.tool))];
    return { order_id: orderId, tools_used, cost, remaining, calls: [...calls] };
  }

  /**
   * Checks the call against the order and reserves its number. Returns the seconds left when
   * enforcing a time limit, and what the order would refuse when not enforcing.
   */
  async function admit(server: string, tool: string): Promise<{ n: number; secondsLeft?: number; violation?: Refusal }> {
    let record = await desk.get(orderId);
    if (record.state === "accepted") {
      // Started on first use, as the desk does on a report. Another call may get there first.
      record = await desk.start(orderId, actor).catch((e) => {
        if (e instanceof AwlError && e.code === "CONFLICT") return desk.get(orderId);
        throw e;
      });
    }

    const { tool_calls, seconds } = order.budget;
    const secondsLeft = seconds === undefined ? undefined : seconds - (workingSeconds(record, clock()) ?? 0);
    const violation =
      record.state !== "working" ? new Refusal("ORDER_NOT_WORKING", `order "${orderId}" is ${record.state}`)
      : !toolAllowed(`${server}/${tool}`, order.tools) ? new Refusal("TOOL_NOT_ALLOWED", `"${server}/${tool}" is not allowed by order "${orderId}"`)
      : tool_calls !== undefined && count >= tool_calls ? new Refusal("BUDGET_SPENT", `all ${tool_calls} tool calls are spent`)
      : secondsLeft !== undefined && secondsLeft <= 0 ? new Refusal("BUDGET_SPENT", `all ${seconds} seconds are spent`)
      : undefined;
    if (!enforce) return { n: ++count, violation };
    if (violation) throw violation;
    // No await between the budget check and here, so concurrent calls cannot overspend.
    return { n: ++count, secondsLeft };
  }

  const server = new Server({ name, version: VERSION }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...(await listUpstream()),
      {
        name: USAGE_TOOL,
        description:
          `Tool calls and time spent on order "${orderId}" so far, with each call's evidence ref. ` +
          "Copy tools_used and cost into your work report, and cite refs as tool_call evidence.",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
    const exposedName = request.params.name;
    if (exposedName === USAGE_TOOL) return { content: [text(await usage())] };

    if (!routes.has(exposedName)) await listUpstream();
    const route = routes.get(exposedName);
    const at = clock().toISOString();
    const qualified = route ? `${route.server}/${route.tool}` : exposedName;

    let admitted: Awaited<ReturnType<typeof admit>>;
    try {
      if (!route) throw new Refusal("UNKNOWN_TOOL", `no tool "${exposedName}" on this gateway`);
      admitted = await admit(route.server, route.tool);
    } catch (e) {
      if (e instanceof AwlError) return { isError: true, content: [text(e.toJSON())] };
      if (!(e instanceof Refusal)) throw e;
      await log({ tool: qualified, at, outcome: "refused", refusal: e.code, message: e.message });
      return { isError: true, content: [text({ code: e.code, message: e.message })] };
    }

    const { n, secondsLeft, violation } = admitted;
    const ref = `${qualified}#${n}`;
    const started = Date.now();
    const timeout = secondsLeft === undefined ? undefined : Math.max(1, Math.floor(secondsLeft * 1000));
    let result: CallToolResult;
    try {
      result = (await upstreams[route!.server].callTool(
        { name: route!.tool, arguments: request.params.arguments },
        undefined,
        { signal: extra.signal, ...(timeout ? { timeout } : {}) },
      )) as CallToolResult;
    } catch (e) {
      result = { isError: true, content: [text(`call failed: ${(e as Error).message}`)] };
    }
    await log({
      n, ref, tool: qualified, at, outcome: result.isError ? "error" : "ok", ms: Date.now() - started,
      ...(violation ? { violation: violation.code, message: violation.message } : {}),
    });
    const note = violation ? `[awl evidence ref: ${ref}; not allowed by the order: ${violation.message}]` : `[awl evidence ref: ${ref}]`;
    return {
      ...result,
      content: [...(result.content ?? []), text(note)],
      _meta: { ...result._meta, "awl/ref": ref, ...(violation ? { "awl/violation": violation.code } : {}) },
    };
  });

  return { server, usage };
}
