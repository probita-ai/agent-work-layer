// Fixtures for the MCP package. These tests run against the built core package,
// the same way a user's install would.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkOrderInput, WorkReportInput } from "agent-work-layer";

export const MANAGER = "agent:manager";
export const WORKER = "agent:worker";
export const LEAD = "human:lead";
export const STRANGER = "agent:stranger";
export const FAR = "2999-01-01T00:00:00Z";

export function orderInput(overrides: Partial<WorkOrderInput> = {}): WorkOrderInput {
  return {
    to: WORKER,
    goal: "Summarize the risk factors in the annual report",
    criteria: [
      { id: "c1", text: "Lists three risk factors with quotes" },
      { id: "c2", text: "States total debt and fiscal year" },
    ],
    budget: { usd: 2, tool_calls: 20 },
    deadline: FAR,
    tools: ["filings/*", "calc/ratio"],
    ...overrides,
  };
}

export function reportInput(overrides: Partial<WorkReportInput> = {}): WorkReportInput {
  return {
    status: "done",
    result: { summary: "Three risks found; debt 1.2B USD FY2025" },
    evidence: [
      { criterion: "c1", type: "tool_call", ref: "filings/get_section#3" },
      { criterion: "c2", type: "citation", ref: "filings/get_section#5" },
    ],
    cost: { usd: 0.8, tool_calls: 7 },
    tools_used: ["filings/search", "filings/get_section"],
    ...overrides,
  };
}

export const tempDir = (prefix = "awl-mcp-test-") => mkdtempSync(join(tmpdir(), prefix));
