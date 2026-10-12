// A manager and a worker agent pass one job back and forth until it is approved.
// Run from the repo root (Node 22.18+): node examples/two-agents.ts
//
// In your own project, import from "agent-work-layer" instead.
import { isAwlError, WorkDesk } from "../packages/core/src/index.ts";
import type { WorkReportInput } from "../packages/core/src/index.ts";

const MANAGER = "agent:manager";
const WORKER = "agent:researcher";

const say = (who: string, text: string) => console.log(`\n${who}: ${text}`);

// Print each event as the desk records it.
const desk = new WorkDesk({
  onEvent: (e) => {
    const move = e.from ? `${e.from} -> ${e.to}` : e.to;
    console.log(`  [event ${e.seq}] ${e.actor} ${e.action} (${move})${e.note ? ` - ${e.note}` : ""}`);
  },
});

// 1. The manager issues a work order.
say(MANAGER, "I need the main risk factors from Example Corp's annual report.");
const { order } = await desk.create(
  {
    to: WORKER,
    goal: "Summarize the main credit risk factors for Example Corp from its latest annual report",
    criteria: [
      { id: "c1", text: "Names three risk factors from the filing" },
      { id: "c2", text: "States total debt and its fiscal year" },
    ],
    budget: { usd: 2, tool_calls: 20 },
    deadline: new Date(Date.now() + 3_600_000).toISOString(),
    tools: ["filings/*"],
  },
  MANAGER,
);

// 2. The worker accepts and reports, but forgets the evidence for c2.
say(WORKER, "Accepted. Here is my report.");
await desk.accept(order.id, WORKER);

const draft: WorkReportInput = {
  status: "done",
  result: { summary: "Refinancing, customer concentration and FX exposure. Debt 1.2B USD." },
  evidence: [{ criterion: "c1", type: "tool_call", ref: "filings/get_section#3" }],
  cost: { usd: 0.6, tool_calls: 5 },
  tools_used: ["filings/search", "filings/get_section"],
};

try {
  await desk.submitReport(order.id, draft, WORKER);
} catch (e) {
  if (!isAwlError(e) || e.code !== "VALIDATION_FAILED") throw e;
  say("desk", `report rejected, nothing was recorded:`);
  for (const f of e.findings) console.log(`  ${f.rule} ${f.path}: ${f.message}`);
}

// 3. The worker adds the missing evidence and resubmits. The manager wants more.
say(WORKER, "Added a citation for total debt. Resubmitting.");
await desk.submitReport(
  order.id,
  {
    ...draft,
    evidence: [...draft.evidence, { criterion: "c2", type: "citation", ref: "filings/get_section#5" }],
  },
  WORKER,
);

const rework = "The debt figure has no fiscal year. Say which year it is reported for.";
say(MANAGER, rework);
await desk.review(order.id, MANAGER, "rework", rework);

// 4. The worker fixes the result and resubmits. The manager approves.
say(WORKER, "Fixed: debt is for FY2025.");
await desk.submitReport(
  order.id,
  {
    ...draft,
    result: { summary: "Refinancing, customer concentration and FX exposure. Debt 1.2B USD (FY2025)." },
    evidence: [
      { criterion: "c1", type: "tool_call", ref: "filings/get_section#3" },
      { criterion: "c2", type: "citation", ref: "filings/get_section#5", note: "Note 9, Debt" },
    ],
    cost: { usd: 0.84, tool_calls: 7 },
  },
  WORKER,
);

say(MANAGER, "Looks good. Approved.");
await desk.review(order.id, MANAGER, "approve");

// The record keeps every event and every report.
const record = await desk.get(order.id);
console.log(`\nFinal state: ${record.state} after ${record.reports.length} reports. Event log:`);
for (const e of record.events) {
  console.log(`  ${String(e.seq).padStart(2)}  ${e.actor.padEnd(17)} ${e.action.padEnd(12)} ${(e.from ?? "").padEnd(10)} -> ${e.to}`);
}
