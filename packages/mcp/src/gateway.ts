// An MCP gateway for one work order (SPEC.md §9.1): it sits between a worker and its real
// MCP servers and enforces the order's `tools` and `budget` at every tool call. Calls to the
// order's `staged` tools are held back and run only once the report is approved (§4.6).
import { appendFile, mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { AwlError, PassError, decodePass, effectReferences, toolAllowed, verifyPass } from "agent-work-layer";
import type { Amounts, Effect, OrderRecord, PassKeys, WorkDesk } from "agent-work-layer";
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
export type RefusalCode = "UNKNOWN_TOOL" | "TOOL_NOT_ALLOWED" | "ORDER_NOT_WORKING" | "BUDGET_SPENT" | "PASS_INVALID" | "PENDING_REFERENCE";

/**
 * One line of the call log. Refused calls have no `n` or `ref` and do not count against the budget.
 * A staged call is logged with its `arguments` and did not reach the tool; when it is committed
 * after approval, a second line with the same `ref`, `commit: true` and no `n` records the result.
 */
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
  /**
   * `running`: a commit is about to call the tool; a final line follows unless the process died.
   * `unknown`: a commit sent the call but got no answer, so the effect may or may not have happened.
   */
  outcome: "ok" | "error" | "refused" | "staged" | "skipped" | "running" | "unknown";
  /** Staged calls: the arguments to run them with once approved. Commits: the arguments run, when references were filled in. */
  arguments?: Record<string, unknown>;
  /** Set on the result of running a staged call after approval. */
  commit?: true;
  /** Commits: the tool's result, which later effects may refer to. */
  result?: CallToolResult;
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
  /** Staged calls waiting for approval, to copy into the report's `effects`. */
  effects: Effect[];
  calls: CallRecord[];
}

/** A staged effect run by `commit()`. */
export interface Committed {
  ref: string;
  tool: string;
  /**
   * `error`: the tool returned an error. `skipped`: not run, because an effect it uses did not succeed or
   * has no value at the pointer. `unknown`: the call was sent but no answer came back (the connection
   * failed, or an earlier commit died during it), so it may have happened. It is never run again; check
   * with the receiver, which got the effect's ref in `_meta["awl/ref"]`.
   */
  outcome: "ok" | "error" | "skipped" | "unknown";
  /** The tool's result. Absent when an earlier commit already ran this effect, or when it was skipped. */
  result?: CallToolResult;
  /** Why it was skipped, or why its outcome is unknown. */
  message?: string;
  /** An earlier commit ran it; it was not run again. */
  earlier?: true;
}

export interface Gateway {
  server: Server;
  usage(): Promise<Usage>;
  /**
   * Runs the staged effects of the order's approved report that the approval chose (all, by default),
   * in the order listed, filling in references to earlier effects' results, and logs each result. Needs
   * the desk. Refuses, running nothing, unless the order is `approved` and every effect to run matches a
   * staged call in the log with the same tool and arguments, made since the last rework. An effect whose
   * reference cannot be filled in is skipped. Effects an earlier commit ran or skipped are not run again.
   */
  commit(): Promise<Committed[]>;
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

/** Staged calls made up to this report attempt were dropped by a rework: the reports before the last rework. */
function reworkedThrough(record: OrderRecord): number {
  let reports = 0;
  let through = 0;
  for (const e of record.events) {
    if (e.action.startsWith("report_")) reports++;
    else if (e.action === "rework") through = reports;
  }
  return through;
}

/** JSON with object keys sorted, so the same arguments always compare equal. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The value a JSON Pointer (RFC 6901) names in `doc`, or undefined when there is none. */
function atPointer(doc: unknown, pointer: string): unknown {
  if (pointer === "") return doc;
  let value = doc;
  for (const raw of pointer.slice(1).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (value === null || typeof value !== "object" || !Object.prototype.hasOwnProperty.call(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/** The first reference in `args` to a call of a staged tool, which has no result until approval (§4.6). */
function pendingReference(args: Record<string, unknown>, staged: readonly string[]): string | undefined {
  return effectReferences(args).find((r) => {
    const hash = r.ref.lastIndexOf("#");
    return hash > 0 && /^\d+$/.test(r.ref.slice(hash + 1)) && toolAllowed(r.ref.slice(0, hash), staged);
  })?.ref;
}

/**
 * A copy of `args` with every reference to an earlier effect replaced by the value it names in that
 * effect's result (§4.6). Throws when an effect it uses did not succeed or has nothing at the pointer.
 */
function fillReferences(args: Record<string, unknown>, results: ReadonlyMap<string, CallToolResult>): Record<string, unknown> {
  let out: unknown = structuredClone(args);
  for (const r of effectReferences(args)) {
    const result = results.get(r.ref);
    if (!result) throw new Error(`"${r.ref}" did not succeed`);
    const value = atPointer(result, r.pointer);
    if (value === undefined) throw new Error(`the result of "${r.ref}" has nothing at "${r.pointer}"`);
    if (r.path === "") {
      out = value;
      continue;
    }
    const keys = r.path.slice(1).split("/").map((k) => k.replace(/~1/g, "/").replace(/~0/g, "~"));
    const parent = keys.slice(0, -1).reduce((o, k) => (o as Record<string, unknown>)[k], out) as Record<string, unknown>;
    parent[keys.at(-1)!] = value;
  }
  if (!out || typeof out !== "object" || Array.isArray(out)) throw new Error("the arguments must be an object");
  return out as Record<string, unknown>;
}

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
  /** Tools whose calls are held back until approval. */
  staged: readonly string[];
  budget: Amounts;
  attempt?: number;
  jti?: string;
  /** Seconds worked so far; unknown in pass mode, so `seconds` is left to the desk's report checks. */
  worked?: number;
  /** Budget the order's sub-orders hold, which it may not spend itself (§8); unknown in pass mode. */
  held?: Amounts;
  /** Staged calls up to this attempt were dropped by a rework; unknown in pass mode. */
  dropped?: number;
  /** Why no call may run under it right now. */
  refusal?: Refusal;
}

/**
 * Builds a gateway server for one order. It lists only the upstream tools the order allows,
 * and refuses calls that are not allowed, that come after the `tool_calls` or `seconds` budget
 * is spent (less the tool calls its sub-orders hold), or while the order is not `working`. With `passKeys` it enforces a Delegation Pass
 * instead of the desk's order state. With `enforce: false` it logs those calls instead of
 * refusing them. Calls to the order's `staged` tools are counted and logged but not forwarded;
 * `commit()` runs them once the report is approved. Connect it to any transport.
 */
export async function createGateway(options: GatewayOptions): Promise<Gateway> {
  const { desk, orderId, upstreams, logFile, passKeys, issuer, enforce = true, separator = "__", clock = () => new Date(), name = "awl-gateway" } = options;
  let actor: string;
  // In desk mode the order's tools are fixed, so they are read once.
  let deskTools: readonly string[] | undefined;
  let deskStaged: readonly string[] = [];
  if (passKeys) {
    if (!options.actor) throw new AwlError("BAD_REQUEST", "a gateway that works from passes needs the worker's actor");
    actor = options.actor;
  } else {
    if (!desk) throw new AwlError("BAD_REQUEST", "a gateway needs a desk, or passKeys to work from passes");
    const { order } = await desk.get(orderId);
    actor = options.actor ?? order.to;
    if (actor !== order.to) throw new AwlError("FORBIDDEN", `only the order's worker "${order.to}" can use its gateway, not "${actor}"`);
    deskTools = order.tools;
    deskStaged = order.staged ?? [];
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
      staged: record.order.staged ?? [],
      budget: record.order.budget,
      attempt: record.reports.length + 1,
      ...(record.pass ? { jti: decodePass(record.pass).jti } : {}),
      worked: workingSeconds(record, clock()),
      held: await desk!.held(orderId),
      dropped: reworkedThrough(record),
      ...(record.state !== "working" ? { refusal: new Refusal("ORDER_NOT_WORKING", `order "${orderId}" is ${record.state}`) } : {}),
    };
  }

  async function fromPass(meta?: Record<string, unknown>): Promise<Authority> {
    const given = meta?.["awl/pass"];
    const token = typeof given === "string" ? given : typeof options.pass === "function" ? await options.pass() : options.pass;
    if (!token) return { tools: [], staged: [], budget: {}, refusal: new Refusal("PASS_INVALID", `no Delegation Pass for order "${orderId}"`) };
    try {
      const { claims } = await verifyPass(token, passKeys!, { issuer, worker: actor, order: orderId, now: clock() });
      return { tools: claims.awl_tools, staged: claims.awl_staged ?? [], budget: claims.awl_budget, attempt: claims.awl_attempt, jti: claims.jti };
    } catch (e) {
      if (!(e instanceof PassError)) throw e;
      return { tools: [], staged: [], budget: {}, refusal: new Refusal("PASS_INVALID", `${e.code}: ${e.message}`) };
    }
  }

  const authority = async (meta?: Record<string, unknown>) => (last = await (passKeys ? fromPass(meta) : fromDesk()));

  /** Exposed tool name → upstream server and tool. Rebuilt on every listing. */
  let routes = new Map<string, { server: string; tool: string }>();

  async function listUpstream(meta?: Record<string, unknown>): Promise<Tool[]> {
    let allowedTools: readonly string[] = deskTools ?? [];
    let staged = deskStaged;
    if (passKeys) {
      const current = await authority(meta);
      allowedTools = current.refusal ? [] : current.tools;
      staged = current.staged;
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
            const note = toolAllowed(`${server}/${tool.name}`, staged) ? " (Staged: returns a placeholder and runs only if the work report is approved.)" : "";
            exposed.push({ ...tool, name: exposedName, description: `[${server}] ${tool.description ?? ""}`.trim() + note });
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
    if (budget.tool_calls !== undefined) remaining.tool_calls = Math.max(0, budget.tool_calls - (current?.held?.tool_calls ?? 0) - count);
    if (budget.seconds !== undefined && seconds !== undefined) remaining.seconds = Math.max(0, budget.seconds - seconds);
    const tools_used = [...new Set(calls.filter((c) => c.n !== undefined).map((c) => c.tool))];
    const effects = pending(current?.dropped ?? 0).map((c) => ({ ref: c.ref!, tool: c.tool, arguments: c.arguments ?? {} }));
    return { order_id: orderId, tools_used, cost, remaining, effects, calls: [...calls] };
  }

  /** Staged calls not dropped by a rework and not yet committed. */
  function pending(dropped: number): CallRecord[] {
    const committed = new Set(calls.filter((c) => c.commit).map((c) => c.ref));
    return calls.filter((c) => c.outcome === "staged" && (c.attempt === undefined || c.attempt > dropped) && !committed.has(c.ref));
  }

  let committing: Promise<unknown> = Promise.resolve();

  async function runCommit(): Promise<Committed[]> {
    if (!desk || passKeys) throw new AwlError("BAD_REQUEST", "committing staged effects needs the desk, to see that the report was approved");
    const record = await desk.get(orderId);
    if (record.state !== "approved") {
      throw new AwlError("INVALID_TRANSITION", `order "${orderId}" is ${record.state}; staged effects run only once its report is approved`);
    }
    // The approval may have chosen some of the report's effects (§4.6).
    const approved = [...record.events].reverse().find((e) => e.action === "approve")?.effects;
    const effects = (record.reports.at(-1)?.effects ?? []).filter((e) => !approved || approved.includes(e.ref));
    const dropped = reworkedThrough(record);
    // The file, not memory, so effects another process committed (e.g. `--commit`) are not run again.
    await logging;
    const logged = logFile ? await loadLog(logFile) : calls;
    const staged = new Map(logged.filter((c) => c.outcome === "staged" && (c.attempt === undefined || c.attempt > dropped)).map((c) => [c.ref, c]));
    // All effects are checked before any runs, so a report that doesn't match the log runs nothing.
    for (const e of effects) {
      const call = staged.get(e.ref);
      if (!call || call.tool !== e.tool || canonical(call.arguments ?? {}) !== canonical(e.arguments)) {
        throw new AwlError("CONFLICT", `effect "${e.ref}" does not match a staged call in the gateway's log; nothing was run`);
      }
    }

    const earlier = new Map(logged.filter((c) => c.commit).map((c) => [c.ref, c]));
    /** Results of effects that succeeded, for later effects that refer to them. */
    const results = new Map<string, CallToolResult>();
    const out: Committed[] = [];
    for (const e of effects) {
      const before = earlier.get(e.ref);
      const { attempt, jti } = staged.get(e.ref)!;
      const base = { ref: e.ref, tool: e.tool, order_id: orderId, ...grant({ attempt, jti }), at: clock().toISOString(), commit: true as const };
      if (before?.outcome === "running") {
        // An earlier commit died while calling the tool. It may have run, so it is settled as unknown, not retried.
        const message = "an earlier commit was interrupted while running it; it may have run, so it is not run again";
        await log({ ...base, outcome: "unknown", message });
        out.push({ ref: e.ref, tool: e.tool, outcome: "unknown", message, earlier: true });
        continue;
      }
      if (before) {
        if (before.outcome === "ok" && before.result) results.set(e.ref, before.result);
        out.push({ ref: e.ref, tool: e.tool, outcome: before.outcome as Committed["outcome"], ...(before.message ? { message: before.message } : {}), earlier: true });
        continue;
      }
      let args: Record<string, unknown>;
      try {
        args = fillReferences(e.arguments, results);
      } catch (err) {
        const message = `skipped: ${(err as Error).message}`;
        await log({ ...base, outcome: "skipped", message });
        out.push({ ref: e.ref, tool: e.tool, outcome: "skipped", message });
        continue;
      }
      const [serverName, tool] = e.tool.split("/");
      const filled = canonical(args) !== canonical(e.arguments) ? { arguments: args } : {};
      const client = upstreams[serverName];
      if (!client) {
        const message = `no upstream server "${serverName}"`;
        await log({ ...base, outcome: "error", message, ...filled });
        out.push({ ref: e.ref, tool: e.tool, outcome: "error", message });
        continue;
      }
      // Logged before the call, so a crash during it is never mistaken for an effect that did not run.
      await log({ ...base, outcome: "running" });
      const started = Date.now();
      let result: CallToolResult;
      try {
        // The ref lets the receiver drop a duplicate, and lets whoever settles an unknown outcome find it.
        result = (await client.callTool({ name: tool, arguments: args, _meta: { "awl/ref": e.ref, "awl/order": orderId } })) as CallToolResult;
      } catch (err) {
        // An error response is an answer: the tool refused the call. Anything else may have reached it.
        const answered = err instanceof McpError && err.code !== ErrorCode.ConnectionClosed && err.code !== ErrorCode.RequestTimeout;
        if (answered) result = { isError: true, content: [text(`call failed: ${err.message}`)] };
        else {
          const message = `no answer from the tool, so it may have run: ${(err as Error).message}`;
          await log({ ...base, outcome: "unknown", ms: Date.now() - started, message, ...filled });
          out.push({ ref: e.ref, tool: e.tool, outcome: "unknown", message });
          continue;
        }
      }
      const outcome = result.isError ? "error" : "ok";
      await log({ ...base, outcome, ms: Date.now() - started, result, ...filled });
      if (outcome === "ok") results.set(e.ref, result);
      out.push({ ref: e.ref, tool: e.tool, outcome, result });
    }
    return out;
  }

  /**
   * One commit at a time, so an effect never runs twice: in this process by queueing, and across
   * processes sharing the log by a lock file next to it.
   */
  function commit(): Promise<Committed[]> {
    const next = committing.then(async () => {
      if (!logFile) return runCommit();
      const lock = `${logFile}.commit-lock`;
      await mkdir(dirname(lock), { recursive: true });
      const handle = await open(lock, "wx").catch((e: NodeJS.ErrnoException) => {
        if (e.code !== "EEXIST") throw e;
        throw new AwlError("CONFLICT", `another commit for order "${orderId}" is running; if one crashed, check the log and remove ${lock}`);
      });
      try {
        return await runCommit();
      } finally {
        await handle.close();
        await rm(lock, { force: true });
      }
    });
    committing = next.catch(() => {});
    return next;
  }

  /**
   * Checks the call against the order (or its pass) and reserves its number. Returns the seconds
   * left when enforcing a time limit, and what the order would refuse when not enforcing.
   */
  async function admit(server: string, tool: string, args: Record<string, unknown>, auth: Authority): Promise<{ n: number; secondsLeft?: number; violation?: Refusal }> {
    const { tool_calls, seconds } = auth.budget;
    const pending = toolAllowed(`${server}/${tool}`, auth.staged) ? undefined : pendingReference(args, auth.staged);
    const held = auth.held?.tool_calls ?? 0;
    const secondsLeft = seconds === undefined || passKeys ? undefined : seconds - (auth.worked ?? 0);
    const violation =
      auth.refusal ? auth.refusal
      : !toolAllowed(`${server}/${tool}`, auth.tools) ? new Refusal("TOOL_NOT_ALLOWED", `"${server}/${tool}" is not allowed by order "${orderId}"`)
      : pending ? new Refusal("PENDING_REFERENCE", `"${server}/${tool}" is not staged, so its arguments cannot use "${pending}": that result exists only once the work report is approved`)
      : tool_calls !== undefined && count >= tool_calls - held ? new Refusal("BUDGET_SPENT", held ? `this order's own tool calls are spent: sub-orders hold ${held} of ${tool_calls}` : `all ${tool_calls} tool calls are spent`)
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
          `Tool calls and time spent on order "${orderId}" so far, with each call's evidence ref, and the staged calls waiting for approval. ` +
          "Copy tools_used, cost and effects into your work report, and cite refs as tool_call evidence.",
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
      admitted = await admit(route.server, route.tool, request.params.arguments ?? {}, auth);
    } catch (e) {
      if (e instanceof AwlError) return { isError: true, content: [text(e.toJSON())] };
      if (!(e instanceof Refusal)) throw e;
      await log({ tool: qualified, order_id: orderId, ...grant(auth), at, outcome: "refused", refusal: e.code, message: e.message });
      return { isError: true, content: [text({ code: e.code, message: e.message })] };
    }

    const { n, secondsLeft, violation } = admitted;
    const ref = `${qualified}#${n}`;
    const tags = {
      "awl/ref": ref, "awl/order": orderId,
      ...(auth?.attempt !== undefined ? { "awl/attempt": auth.attempt } : {}),
      ...(auth?.jti ? { "awl/jti": auth.jti } : {}),
      ...(violation ? { "awl/violation": violation.code } : {}),
    };

    if (toolAllowed(qualified, auth?.staged ?? [])) {
      const args = request.params.arguments ?? {};
      await log({
        n, ref, tool: qualified, order_id: orderId, ...grant(auth), at, outcome: "staged", arguments: args,
        ...(violation ? { violation: violation.code, message: violation.message } : {}),
      });
      return {
        content: [
          text(`pending:${ref}`),
          text(
            `[awl evidence ref: ${ref}; staged: it runs only if the work report is approved, so list it in the report's effects. ` +
            `To use its result in a later staged call, pass {"$ref": "${ref}", "pointer": "<JSON Pointer into the result>"}]`,
          ),
        ],
        _meta: { ...tags, "awl/staged": true },
      };
    }

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
      _meta: { ...result._meta, ...tags },
    };
  });

  return { server, usage, commit };
}

/** The attempt and pass id a call ran under, for its call record. */
const grant = (auth?: Pick<Authority, "attempt" | "jti">) => ({
  ...(auth?.attempt !== undefined ? { attempt: auth.attempt } : {}),
  ...(auth?.jti ? { jti: auth.jti } : {}),
});
