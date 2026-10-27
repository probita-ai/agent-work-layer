// An MCP gateway for one work order (SPEC.md §9.1): it sits between a worker and its real
// MCP servers and enforces the order's `tools` and `budget` at every tool call. Calls to the
// order's `staged` tools are held back and run only once the report is approved (§4.6).
import { appendFile, mkdir, open, readFile, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { AwlError, PassError, approvedEffects, decodePass, effectOutcomes, effectReferences, toolAllowed, verifyPass } from "agent-work-layer";
import type { Amounts, Effect, EffectOutcome, OrderRecord, PassKeys, WorkDesk } from "agent-work-layer";
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
   * `not_run`: the worker settled an unknown effect as never having happened (with `settled`).
   */
  outcome: "ok" | "error" | "refused" | "staged" | "skipped" | "running" | "unknown" | "not_run";
  /** Staged calls: the arguments to run them with once approved. Commits: the arguments run, when references were filled in. */
  arguments?: Record<string, unknown>;
  /** Set on the result of running a staged call after approval. */
  commit?: true;
  /** Set on a commit line the worker recorded, settling an unknown outcome; `message` holds the evidence. */
  settled?: true;
  /** Set on a commit line for a retry the manager allowed: 1 for the first retry. */
  retry?: number;
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
  outcome: "ok" | "error" | "skipped" | "unknown" | "not_run";
  /** The tool's result. Absent when an earlier commit already ran this effect, or when it was skipped. */
  result?: CallToolResult;
  /** Why it was skipped, why its outcome is unknown, or the evidence it was settled with. */
  message?: string;
  /** An earlier commit ran it; it was not run again. */
  earlier?: true;
  /** A retry the manager allowed: 1 for the first. */
  retry?: number;
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
  /**
   * Records what the worker found out about an effect whose outcome is `unknown`: it happened (`ok`,
   * optionally with the result later effects can refer to) or it did not (`not_run`), with the evidence
   * in `note`. Logs it and records it on the desk (§6.4). Never runs anything.
   */
  settle(ref: string, outcome: "ok" | "not_run", options: { note: string; result?: CallToolResult }): Promise<Committed>;
  /**
   * Runs once more each approved effect the manager allowed a retry of (`allowRetry` on the desk) that
   * has not happened: settled `not_run`, or `skipped`. Rechecks the approval and the staged call first,
   * and sends the same `_meta["awl/ref"]`, with `_meta["awl/try"]`, so a receiver can still drop a duplicate.
   */
  retry(): Promise<Committed[]>;
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

/** Who holds a commit lock: written into the lock file, so a later run can tell whether that process is still alive. */
interface LockHolder {
  pid: number;
  host: string;
  started_at: string;
}

async function createLock(lock: string): Promise<() => Promise<void>> {
  const handle = await open(lock, "wx");
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, host: hostname(), started_at: new Date().toISOString() } satisfies LockHolder));
  } finally {
    await handle.close();
  }
  return () => rm(lock, { force: true });
}

async function readHolder(lock: string): Promise<LockHolder | undefined> {
  try {
    const holder = JSON.parse(await readFile(lock, "utf8"));
    return Number.isInteger(holder?.pid) && typeof holder.host === "string" ? holder : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a process with this id exists on this machine. One we may not signal still exists. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Takes the commit lock for an order, and returns how to release it. A lock left by a process that
 * died on this machine is taken over; one held by a live process, by another machine, or written by
 * an older gateway that did not record its holder, is refused, since it may still be in use.
 */
async function takeLock(lock: string, orderId: string): Promise<() => Promise<void>> {
  await mkdir(dirname(lock), { recursive: true });
  const busy = (why: string) => new AwlError("CONFLICT", `another commit for order "${orderId}" may be running (${why}); if none is, check the log and remove ${lock}`);
  try {
    return await createLock(lock);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  const holder = await readHolder(lock);
  if (!holder) throw busy("its lock does not say which process holds it");
  if (holder.host !== hostname()) throw busy(`held on ${holder.host}`);
  if (alive(holder.pid)) throw busy(`process ${holder.pid} holds it`);
  // The holder died. Only one process takes over: the first to create the takeover file.
  const takeover = `${lock}.takeover`;
  const handle = await open(takeover, "wx").catch((e: NodeJS.ErrnoException) => {
    if (e.code === "EEXIST") throw busy(`another process is taking over the lock; if none is, remove ${takeover} too`);
    throw e;
  });
  try {
    const again = await readHolder(lock);
    if (!again || again.pid !== holder.pid || again.started_at !== holder.started_at) throw busy("another process took it over");
    await rm(lock, { force: true });
    return await createLock(lock).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "EEXIST") throw busy("another process took it over");
      throw e;
    });
  } finally {
    await handle.close();
    await rm(takeover, { force: true });
  }
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

  /** The approved effects to work on, checked against the log, and what the log says of each so far. */
  async function approvedRun(what: string) {
    if (!desk || passKeys) throw new AwlError("BAD_REQUEST", `${what} staged effects needs the desk, to see that the report was approved`);
    const record = await desk.get(orderId);
    if (record.state !== "approved") {
      throw new AwlError("INVALID_TRANSITION", `order "${orderId}" is ${record.state}; staged effects run only once its report is approved`);
    }
    // The approval may have chosen some of the report's effects (§4.6).
    const chosen = new Set(approvedEffects(record));
    const effects = (record.reports.at(-1)?.effects ?? []).filter((e) => chosen.has(e.ref));
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
    /** The last commit line for each effect. */
    const latest = new Map(logged.filter((c) => c.commit).map((c) => [c.ref!, c]));
    /** Results of effects that succeeded, for later effects that refer to them. */
    const results = new Map<string, CallToolResult>();
    for (const [ref, c] of latest) if (c.outcome === "ok" && c.result) results.set(ref, c.result);
    const base = (e: Effect) => {
      const { attempt, jti } = staged.get(e.ref)!;
      return { ref: e.ref, tool: e.tool, order_id: orderId, ...grant({ attempt, jti }), at: clock().toISOString(), commit: true as const };
    };
    return { record, effects, latest, results, base, logged };
  }

  /** Runs one effect and logs the outcome. `retry` numbers a retry the manager allowed (§6.4). */
  async function runEffect(e: Effect, base: Omit<CallRecord, "outcome">, results: Map<string, CallToolResult>, retry?: number): Promise<Committed> {
    const tag = retry ? { retry } : {};
    let args: Record<string, unknown>;
    try {
      args = fillReferences(e.arguments, results);
    } catch (err) {
      const message = `skipped: ${(err as Error).message}`;
      await log({ ...base, ...tag, outcome: "skipped", message });
      return { ref: e.ref, tool: e.tool, outcome: "skipped", message };
    }
    const [serverName, tool] = e.tool.split("/");
    const filled = canonical(args) !== canonical(e.arguments) ? { arguments: args } : {};
    const client = upstreams[serverName];
    if (!client) {
      const message = `no upstream server "${serverName}"`;
      await log({ ...base, ...tag, outcome: "error", message, ...filled });
      return { ref: e.ref, tool: e.tool, outcome: "error", message };
    }
    // Logged before the call, so a crash during it is never mistaken for an effect that did not run.
    await log({ ...base, ...tag, outcome: "running" });
    const started = Date.now();
    let result: CallToolResult;
    try {
      // The ref lets the receiver drop a duplicate, also of a retry, and lets whoever settles an unknown outcome find it.
      const _meta = { "awl/ref": e.ref, "awl/order": orderId, ...(retry ? { "awl/try": retry + 1 } : {}) };
      result = (await client.callTool({ name: tool, arguments: args, _meta })) as CallToolResult;
    } catch (err) {
      // An error response is an answer: the tool refused the call. Anything else may have reached it.
      const answered = err instanceof McpError && err.code !== ErrorCode.ConnectionClosed && err.code !== ErrorCode.RequestTimeout;
      if (answered) result = { isError: true, content: [text(`call failed: ${err.message}`)] };
      else {
        const message = `no answer from the tool, so it may have run: ${(err as Error).message}`;
        await log({ ...base, ...tag, outcome: "unknown", ms: Date.now() - started, message, ...filled });
        return { ref: e.ref, tool: e.tool, outcome: "unknown", message };
      }
    }
    const outcome = result.isError ? "error" : "ok";
    await log({ ...base, ...tag, outcome, ms: Date.now() - started, result, ...filled });
    if (outcome === "ok") results.set(e.ref, result);
    return { ref: e.ref, tool: e.tool, outcome, result };
  }

  /** Settles an effect that an earlier run died during: it may have run, so it is unknown, never run again. */
  async function interrupted(e: Effect, base: Omit<CallRecord, "outcome">): Promise<Committed> {
    const message = "an earlier commit was interrupted while running it; it may have run, so it is not run again";
    await log({ ...base, outcome: "unknown", message });
    return { ref: e.ref, tool: e.tool, outcome: "unknown", message, earlier: true };
  }

  /**
   * Tells the desk what became of the approved effects (§6.4): every outcome the log has that the desk
   * does not show yet, so a commit whose report to the desk failed is caught up by the next run.
   */
  async function reportToDesk() {
    const fresh = await (logFile ? loadLog(logFile) : Promise.resolve(calls));
    const latest = new Map(fresh.filter((c) => c.commit && c.outcome !== "running").map((c) => [c.ref!, c]));
    for (let tries = 0; ; tries++) {
      const record = await desk!.get(orderId);
      const known = effectOutcomes(record);
      const outcomes = approvedEffects(record).flatMap((ref) => {
        const c = latest.get(ref);
        if (!c || c.settled || (known.get(ref)?.outcome === c.outcome && known.get(ref)?.note === c.message)) return [];
        return [{ ref, outcome: c.outcome as EffectOutcome["outcome"], ...(c.message ? { note: c.message } : {}) }];
      });
      if (!outcomes.length) return;
      try {
        await desk!.recordCommit(orderId, actor, outcomes);
        return;
      } catch (e) {
        // The manager may have acted on the order at the same moment; read it again.
        if (!(e instanceof AwlError && e.code === "CONFLICT") || tries >= 3) throw e;
      }
    }
  }

  async function runCommit(): Promise<Committed[]> {
    const { effects, latest, results, base } = await approvedRun("committing");
    const out: Committed[] = [];
    for (const e of effects) {
      const before = latest.get(e.ref);
      if (before?.outcome === "running") out.push(await interrupted(e, base(e)));
      else if (before) {
        out.push({ ref: e.ref, tool: e.tool, outcome: before.outcome as Committed["outcome"], ...(before.message ? { message: before.message } : {}), earlier: true });
      } else out.push(await runEffect(e, base(e), results));
    }
    await reportToDesk();
    return out;
  }

  async function runSettle(ref: string, outcome: "ok" | "not_run", note: string, result?: CallToolResult): Promise<Committed> {
    if (outcome !== "ok" && outcome !== "not_run") throw new AwlError("BAD_REQUEST", `an effect is settled as ok or not_run, not "${outcome}"`);
    if (result && outcome !== "ok") throw new AwlError("BAD_REQUEST", "only an effect settled as ok has a result");
    const { effects, latest, base } = await approvedRun("settling");
    const e = effects.find((x) => x.ref === ref);
    if (!e) throw new AwlError("BAD_REQUEST", `"${ref}" is not an approved effect of order "${orderId}"`);
    const now = latest.get(ref)?.outcome;
    if (now === "running") throw new AwlError("INVALID_TRANSITION", `effect "${ref}" is still running, or a commit died during it; run --commit first`);
    if (now !== "unknown") throw new AwlError("INVALID_TRANSITION", `effect "${ref}" is ${now ?? "not run yet"}; only an unknown outcome can be settled`);
    // The desk may not have heard of the unknown outcome yet, if reporting it failed.
    await reportToDesk();
    await desk!.settle(orderId, actor, ref, outcome, note);
    await log({ ...base(e), outcome, settled: true, message: note, ...(result ? { result } : {}) });
    return { ref, tool: e.tool, outcome, message: note };
  }

  async function runRetry(): Promise<Committed[]> {
    const { record, effects, latest, results, base, logged } = await approvedRun("retrying");
    /** How many retries the manager allowed, and how many ran, for each effect. */
    const allowed = new Map<string, number>();
    for (const ev of record.events) if (ev.action === "allow_retry") for (const ref of ev.effects ?? []) allowed.set(ref, (allowed.get(ref) ?? 0) + 1);
    const tried = new Map<string, number>();
    for (const c of logged) if (c.commit && c.retry) tried.set(c.ref!, Math.max(tried.get(c.ref!) ?? 0, c.retry));
    const out: Committed[] = [];
    for (const e of effects) {
      const before = latest.get(e.ref);
      if (before?.outcome === "running") {
        out.push(await interrupted(e, base(e)));
        continue;
      }
      const done = tried.get(e.ref) ?? 0;
      if (done >= (allowed.get(e.ref) ?? 0) || (before?.outcome !== "not_run" && before?.outcome !== "skipped")) continue;
      out.push({ ...(await runEffect(e, base(e), results, done + 1)), retry: done + 1 });
    }
    await reportToDesk();
    return out;
  }

  /**
   * One run at a time, so an effect never runs twice: in this process by queueing, and across
   * processes sharing the log by a lock file next to it, which a later run takes over when the
   * process that holds it has died (§9.1 rule 10).
   */
  function exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = committing.then(async () => {
      if (!logFile) return run();
      const release = await takeLock(`${logFile}.commit-lock`, orderId);
      try {
        return await run();
      } finally {
        await release();
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

  return {
    server,
    usage,
    commit: () => exclusive(runCommit),
    settle: (ref, outcome, { note, result } = { note: "" }) => exclusive(() => runSettle(ref, outcome, note, result)),
    retry: () => exclusive(runRetry),
  };
}

/** The attempt and pass id a call ran under, for its call record. */
const grant = (auth?: Pick<Authority, "attempt" | "jti">) => ({
  ...(auth?.attempt !== undefined ? { attempt: auth.attempt } : {}),
  ...(auth?.jti ? { jti: auth.jti } : {}),
});
