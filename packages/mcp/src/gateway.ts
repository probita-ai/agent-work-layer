// An MCP gateway for one work order (SPEC.md §9.1): it sits between a worker and its real
// MCP servers and enforces the order's `tools` and `budget` at every tool call.
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { AwlError, PassError, decodePass, toolAllowed, verifyPass } from "agent-work-layer";
import type { Amounts, OrderRecord, PassKeys, WorkDesk } from "agent-work-layer";
import { VERSION } from "./version.ts";

export interface GatewayOptions {
  /** The desk whose order state the gateway reads. Not needed with `passKeys`. */
  desk?: WorkDesk;
  /** The order whose `tools` and `budget` this gateway enforces. */
  orderId: string;
  /** Connected clients for the worker's real MCP servers, keyed by server name (the `server` in `server/tool`). */
  upstreams: Record<string, Client>;
  /** Who the gateway acts as. Must be the order's worker. Default: the order's `to`; required with `passKeys`. */
  actor?: string;
  /**
   * Work from Delegation Passes (SPEC.md §10.2) instead of the desk's order state: every call
   * needs a valid pass for this order and worker, signed by one of these keys, and the pass's
   * `awl_tools` and `awl_budget` are what is enforced. The desk is not read.
   */
  passKeys?: PassKeys;
  /** The current pass, or a function returning it (e.g. reading a file the worker refreshes). A call's `_meta["awl/pass"]` wins. */
  pass?: string | (() => string | undefined | Promise<string | undefined>);
  /** Required `iss` of passes. */
  issuer?: string;
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
export type RefusalCode = "UNKNOWN_TOOL" | "TOOL_NOT_ALLOWED" | "ORDER_NOT_WORKING" | "BUDGET_SPENT" | "PASS_INVALID";

/** One line of the call log. Refused calls have no `n` or `ref` and do not count against the budget. */
export interface CallRecord {
  /** 1 for the order's first call, +1 per call that reached a tool. */
  n?: number;
  /** Evidence ref for this call: `server/tool#n`. */
  ref?: string;
  /** `server/tool`. */
  tool: string;
  /** The authority the call ran under: the order, the report attempt in progress and the pass's `jti`. */
  order_id: string;
  attempt?: number;
  jti?: string;
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

/** What a call runs under: from the desk's record, or from a verified pass. */
interface Authority {
  tools: readonly string[];
  budget: Amounts;
  attempt?: number;
  jti?: string;
  /** Seconds worked so far; unknown in pass mode, so `seconds` is left to the desk's report checks. */
  worked?: number;
  /** Why no call may run under it right now. */
  refusal?: Refusal;
}

/**
 * Builds a gateway server for one order. It lists only the upstream tools the order allows,
 * and refuses calls that are not allowed, that come after the `tool_calls` or `seconds` budget
 * is spent, or while the order is not `working`. With `passKeys` it enforces a Delegation Pass
 * instead of the desk's order state. With `enforce: false` it logs those calls instead of
 * refusing them. Connect it to any transport.
 */
export async function createGateway(options: GatewayOptions): Promise<Gateway> {
  const { desk, orderId, upstreams, logFile, passKeys, issuer, enforce = true, separator = "__", clock = () => new Date(), name = "awl-gateway" } = options;
  let actor: string;
  // In desk mode the order's tools are fixed, so they are read once.
  let deskTools: readonly string[] | undefined;
  if (passKeys) {
    if (!options.actor) throw new AwlError("BAD_REQUEST", "a gateway that works from passes needs the worker's actor");
    actor = options.actor;
  } else {
    if (!desk) throw new AwlError("BAD_REQUEST", "a gateway needs a desk, or passKeys to work from passes");
    const { order } = await desk.get(orderId);
    actor = options.actor ?? order.to;
    if (actor !== order.to) throw new AwlError("FORBIDDEN", `only the order's worker "${order.to}" can use its gateway, not "${actor}"`);
    deskTools = order.tools;
  }

  const calls: CallRecord[] = logFile ? await loadLog(logFile) : [];
  let count = calls.reduce((max, c) => Math.max(max, c.n ?? 0), 0);
  /** The latest authority seen, for usage(). */
  let last: Authority | undefined;
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

  async function fromDesk(): Promise<Authority> {
    let record = await desk!.get(orderId);
    if (record.state === "accepted") {
      // Started on first use, as the desk does on a report. Another call may get there first.
      record = await desk!.start(orderId, actor).catch((e) => {
        if (e instanceof AwlError && e.code === "CONFLICT") return desk!.get(orderId);
        throw e;
      });
    }
    return {
      tools: record.order.tools,
      budget: record.order.budget,
      attempt: record.reports.length + 1,
      ...(record.pass ? { jti: decodePass(record.pass).jti } : {}),
      worked: workingSeconds(record, clock()),
      ...(record.state !== "working" ? { refusal: new Refusal("ORDER_NOT_WORKING", `order "${orderId}" is ${record.state}`) } : {}),
    };
  }

  async function fromPass(meta?: Record<string, unknown>): Promise<Authority> {
    const given = meta?.["awl/pass"];
    const token = typeof given === "string" ? given : typeof options.pass === "function" ? await options.pass() : options.pass;
    if (!token) return { tools: [], budget: {}, refusal: new Refusal("PASS_INVALID", `no Delegation Pass for order "${orderId}"`) };
    try {
      const { claims } = await verifyPass(token, passKeys!, { issuer, worker: actor, order: orderId, now: clock() });
      return { tools: claims.awl_tools, budget: claims.awl_budget, attempt: claims.awl_attempt, jti: claims.jti };
    } catch (e) {
      if (!(e instanceof PassError)) throw e;
      return { tools: [], budget: {}, refusal: new Refusal("PASS_INVALID", `${e.code}: ${e.message}`) };
    }
  }

  const authority = async (meta?: Record<string, unknown>) => (last = await (passKeys ? fromPass(meta) : fromDesk()));

  /** Exposed tool name → upstream server and tool. Rebuilt on every listing. */
  let routes = new Map<string, { server: string; tool: string }>();

  async function listUpstream(meta?: Record<string, unknown>): Promise<Tool[]> {
    let allowedTools: readonly string[] = deskTools ?? [];
    if (passKeys) {
      const current = await authority(meta);
      allowedTools = current.refusal ? [] : current.tools;
    }
    const next = new Map<string, { server: string; tool: string }>();
    const exposed: Tool[] = [];
    for (const [server, client] of Object.entries(upstreams)) {
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined);
        for (const tool of page.tools) {
          const exposedName = `${server}${separator}${tool.name}`;
          next.set(exposedName, { server, tool: tool.name });
          if (!enforce || toolAllowed(`${server}/${tool.name}`, allowedTools)) {
            exposed.push({ ...tool, name: exposedName, description: `[${server}] ${tool.description ?? ""}`.trim() });
          }
        }
        cursor = page.nextCursor;
      } while (cursor);
    }
    routes = next;
    return exposed;
  }

  async function usage(): Promise<Usage> {
    const current = passKeys ? last : await authority();
    const budget = current?.budget ?? {};
    const seconds = current?.worked;
    const cost: Amounts = { tool_calls: count, ...(seconds === undefined ? {} : { seconds: Math.ceil(seconds) }) };
    const remaining: Amounts = {};
    if (budget.tool_calls !== undefined) remaining.tool_calls = Math.max(0, budget.tool_calls - count);
    if (budget.seconds !== undefined && seconds !== undefined) remaining.seconds = Math.max(0, budget.seconds - seconds);
    const tools_used = [...new Set(calls.filter((c) => c.n !== undefined).map((c) => c.tool))];
    return { order_id: orderId, tools_used, cost, remaining, calls: [...calls] };
  }

  /**
   * Checks the call against the order (or its pass) and reserves its number. Returns the seconds
   * left when enforcing a time limit, and what the order would refuse when not enforcing.
   */
  async function admit(server: string, tool: string, auth: Authority): Promise<{ n: number; secondsLeft?: number; violation?: Refusal }> {
    const { tool_calls, seconds } = auth.budget;
    const secondsLeft = seconds === undefined || passKeys ? undefined : seconds - (auth.worked ?? 0);
    const violation =
      auth.refusal ? auth.refusal
      : !toolAllowed(`${server}/${tool}`, auth.tools) ? new Refusal("TOOL_NOT_ALLOWED", `"${server}/${tool}" is not allowed by order "${orderId}"`)
      : tool_calls !== undefined && count >= tool_calls ? new Refusal("BUDGET_SPENT", `all ${tool_calls} tool calls are spent`)
      : secondsLeft !== undefined && secondsLeft <= 0 ? new Refusal("BUDGET_SPENT", `all ${seconds} seconds are spent`)
      : undefined;
    if (!enforce) return { n: ++count, violation };
    if (violation) throw violation;
    // No await between the budget check and here, so concurrent calls cannot overspend.
    return { n: ++count, secondsLeft };
  }

  const server = new Server({ name, version: VERSION }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async (request) => ({
    tools: [
      ...(await listUpstream(request.params?._meta)),
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

    if (!routes.has(exposedName)) await listUpstream(request.params._meta);
    const route = routes.get(exposedName);
    const at = clock().toISOString();
    const qualified = route ? `${route.server}/${route.tool}` : exposedName;

    let auth: Authority | undefined;
    let admitted: Awaited<ReturnType<typeof admit>>;
    try {
      if (!route) throw new Refusal("UNKNOWN_TOOL", `no tool "${exposedName}" on this gateway`);
      auth = await authority(request.params._meta);
      admitted = await admit(route.server, route.tool, auth);
    } catch (e) {
      if (e instanceof AwlError) return { isError: true, content: [text(e.toJSON())] };
      if (!(e instanceof Refusal)) throw e;
      await log({ tool: qualified, order_id: orderId, ...grant(auth), at, outcome: "refused", refusal: e.code, message: e.message });
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
      n, ref, tool: qualified, order_id: orderId, ...grant(auth), at, outcome: result.isError ? "error" : "ok", ms: Date.now() - started,
      ...(violation ? { violation: violation.code, message: violation.message } : {}),
    });
    const note = violation ? `[awl evidence ref: ${ref}; not allowed by the order: ${violation.message}]` : `[awl evidence ref: ${ref}]`;
    return {
      ...result,
      content: [...(result.content ?? []), text(note)],
      _meta: {
        ...result._meta, "awl/ref": ref, "awl/order": orderId,
        ...(auth?.attempt !== undefined ? { "awl/attempt": auth.attempt } : {}),
        ...(auth?.jti ? { "awl/jti": auth.jti } : {}),
        ...(violation ? { "awl/violation": violation.code } : {}),
      },
    };
  });

  return { server, usage };
}

/** The attempt and pass id a call ran under, for its call record. */
const grant = (auth?: Authority) => ({
  ...(auth?.attempt !== undefined ? { attempt: auth.attempt } : {}),
  ...(auth?.jti ? { jti: auth.jti } : {}),
});
