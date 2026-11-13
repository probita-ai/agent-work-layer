// A manager and a worker agent hand one job over A2A (SPEC.md §9.2) until it is approved.
// Run from the repo root (Node 22.18+): node examples/a2a.ts
//
// The worker is an A2A server: an Agent Card that lists the AWL extension, and JSON-RPC `message/send`.
// The manager keeps the desk: it sends the order as a data part, records what the worker's task says
// with recordTask, and sends its reviews back on the same task. Plain node:http and fetch stand in for
// an A2A SDK; any A2A v0.3 implementation sends the same JSON.
//
// In your own project, import from "agent-work-layer" and "agent-work-layer/a2a" instead.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { WorkDesk, reportSpecFor } from "../packages/core/src/index.ts";
import type { WorkOrder, WorkReport } from "../packages/core/src/index.ts";
import {
  AWL_A2A_EXTENSION, agentCardExtension, orderPart, readParts, recordTask, reportPart, reviewPart, taskState,
} from "../packages/core/src/a2a.ts";
import type { A2APart, A2ATask, AwlReview } from "../packages/core/src/a2a.ts";

const MANAGER = "agent:manager";
const WORKER = "agent:researcher";

const say = (who: string, text: string) => console.log(`\n${who}: ${text}`);

// ---- the worker: an A2A server ---------------------------------------------

/** The worker's tasks: one per order, with the reports sent so far. */
const tasks = new Map<string, { task: A2ATask & { kind: "task" }; order: WorkOrder }>();

function writeReport(order: WorkOrder, attempt: number): WorkReport {
  const report = {
    order_id: order.id,
    from: WORKER,
    status: "done" as const,
    result: {
      summary: attempt === 1
        ? "Refinancing, customer concentration and FX risk. Debt 1.2B USD."
        : "Refinancing, customer concentration and FX risk. Debt 1.2B USD at the end of FY2025 (note 12).",
    },
    evidence: [
      { criterion: "c1", type: "citation" as const, ref: "https://example.com/ar-2025.pdf#page=14", note: "Item 1A" },
      { criterion: "c2", type: "citation" as const, ref: `https://example.com/ar-2025.pdf#page=${attempt === 1 ? 40 : 88}`, note: attempt === 1 ? "Balance sheet" : "Note 12, Debt" },
    ],
    cost: { usd: 0.4 * attempt },
    tools_used: [],
    finished_at: new Date().toISOString(),
    attempt,
  };
  return { spec: reportSpecFor(report), ...report };
}

const status = (state: A2ATask["status"]["state"], text: string) => ({
  state, timestamp: new Date().toISOString(),
  message: { kind: "message", role: "agent", messageId: randomUUID(), parts: [{ kind: "text", text }] as A2APart[] },
});

/** What the worker does with each message it is sent. */
function onMessage(message: { parts: A2APart[]; taskId?: string }): A2ATask {
  const { orders, reviews } = readParts(message.parts);
  if (orders.length) {
    const order = orders[0];
    if (order.to !== WORKER) {
      return { id: randomUUID(), status: status("rejected", `This order is for ${order.to}`) };
    }
    const report = writeReport(order, 1);
    const task = {
      kind: "task" as const, id: randomUUID(), contextId: randomUUID(),
      status: status("input-required", "Report ready for review"),
      artifacts: [{ artifactId: "report-1", name: "Work Report, attempt 1", parts: [reportPart(report)] }],
      metadata: { "awl/order": order.id },
    };
    tasks.set(task.id, { task, order });
    return task;
  }
  const held = message.taskId ? tasks.get(message.taskId) : undefined;
  if (!held || !reviews.length) throw new Error("expected an order, or a review on a known task");
  const review: AwlReview = reviews[0];
  if (review.decision === "approve") {
    held.task.status = status("completed", "Thanks");
  } else {
    const attempt = held.task.artifacts.length + 1;
    held.task.artifacts.push({ artifactId: `report-${attempt}`, name: `Work Report, attempt ${attempt}`, parts: [reportPart(writeReport(held.order, attempt))] });
    held.task.status = status("input-required", `Reworked: ${review.reason}`);
  }
  return held.task;
}

const worker = createServer(async (req, res) => {
  const send = (body: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
  if (req.method === "GET" && req.url === "/.well-known/agent-card.json") {
    return send({
      name: "Researcher", description: "Reads filings and reports with evidence.", url: `http://127.0.0.1:${(worker.address() as AddressInfo).port}/`,
      protocolVersion: "0.3.0", version: "1.0.0", defaultInputModes: ["application/json"], defaultOutputModes: ["application/json"],
      capabilities: { extensions: [agentCardExtension()] }, skills: [{ id: "research", name: "Research", description: "Answers from filings", tags: ["filings"] }],
    });
  }
  let body = "";
  for await (const chunk of req) body += chunk;
  const rpc = JSON.parse(body);
  try {
    if (rpc.method !== "message/send") throw new Error(`unknown method ${rpc.method}`);
    send({ jsonrpc: "2.0", id: rpc.id, result: onMessage(rpc.params.message) });
  } catch (e) {
    send({ jsonrpc: "2.0", id: rpc.id, error: { code: -32602, message: (e as Error).message } });
  }
});
await new Promise<void>((resolve) => worker.listen(0, "127.0.0.1", resolve));
const workerUrl = `http://127.0.0.1:${(worker.address() as AddressInfo).port}`;

// ---- the manager: keeps the desk, talks A2A to the worker ---------------------

const desk = new WorkDesk({
  onEvent: (e) => {
    const move = e.from ? `${e.from} -> ${e.to}` : e.to;
    console.log(`  [event ${e.seq}] ${e.actor} ${e.action} (${move})${e.note ? ` - ${e.note}` : ""}`);
  },
});

async function messageSend(parts: A2APart[], taskId?: string): Promise<A2ATask> {
  const message = { kind: "message", role: "user", messageId: randomUUID(), parts, extensions: [AWL_A2A_EXTENSION], ...(taskId ? { taskId } : {}) };
  const res = await fetch(workerUrl, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method: "message/send", params: { message } }),
  });
  const rpc = await res.json();
  if (rpc.error) throw new Error(rpc.error.message);
  return rpc.result;
}

try {
  // 1. The manager checks that the worker speaks AWL, then issues the order over A2A.
  const card = await (await fetch(`${workerUrl}/.well-known/agent-card.json`)).json();
  const speaksAwl = card.capabilities.extensions.some((x: { uri: string }) => x.uri === AWL_A2A_EXTENSION);
  say(MANAGER, `${card.name}'s Agent Card ${speaksAwl ? "lists" : "does not list"} the AWL extension. Sending the order.`);
  const { order } = await desk.create(
    {
      to: WORKER,
      goal: "Summarize the main credit risk factors for Example Corp from its latest annual report",
      criteria: [
        { id: "c1", text: "Names three risk factors from the filing" },
        { id: "c2", text: "States total debt and its fiscal year, citing the debt note" },
      ],
      budget: { usd: 2 },
      deadline: new Date(Date.now() + 3_600_000).toISOString(),
      tools: [],
    },
    MANAGER,
  );
  let task = await messageSend([orderPart(order)]);

  // 2. The worker's task says it accepted and reported. The manager's desk records both.
  // A real manager authenticates the A2A peer as WORKER before letting the desk act as it.
  say(WORKER, `(task ${task.status.state}) ${task.status.message?.parts.map((p) => ("text" in p ? p.text : "")).join("")}`);
  await recordTask(desk, order.id, task, WORKER);

  // 3. The fiscal year and the debt note are missing: rework, sent on the same task.
  say(MANAGER, "The debt figure needs its fiscal year and the debt note. Sending it back.");
  await desk.review(order.id, MANAGER, "rework", "State the fiscal year and cite the debt note");
  task = await messageSend([reviewPart({ order_id: order.id, decision: "rework", reason: "State the fiscal year and cite the debt note" })], task.id);
  say(WORKER, `(task ${task.status.state}) ${task.status.message?.parts.map((p) => ("text" in p ? p.text : "")).join("")}`);
  let { record } = await recordTask(desk, order.id, task, WORKER);

  // 4. Approved, on the desk and on the task.
  say(MANAGER, `Attempt ${record.reports.length}: "${record.reports.at(-1)!.result.summary}" Approved.`);
  record = await desk.review(order.id, MANAGER, "approve");
  task = await messageSend([reviewPart({ order_id: order.id, decision: "approve" })], task.id);

  console.log(`\nDesk: ${record.state} (A2A: ${taskState(record.state)}). Worker's task: ${task.status.state}.`);
  if (taskState(record.state) !== task.status.state) throw new Error("the desk and the task disagree");
} finally {
  worker.close();
}
