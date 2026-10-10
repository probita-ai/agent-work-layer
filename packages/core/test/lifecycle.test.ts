import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { allowedActions, isTerminal, nextState, ROLE_FOR, STATES } from "../src/index.ts";
import type { Action, State } from "../src/index.ts";

// The full transition table from SPEC.md §6. Anything not listed must be refused.
const EXPECTED: Record<State, Partial<Record<Action, State>>> = {
  offered: { accept: "accepted", decline: "declined", cancel: "cancelled", expire: "expired" },
  accepted: { start: "working", cancel: "cancelled", expire: "expired" },
  working: { report_done: "submitted", report_failed: "submitted", report_blocked: "blocked", cancel: "cancelled", expire: "expired" },
  blocked: { answer: "working", cancel: "cancelled", expire: "expired" },
  submitted: { approve: "approved", rework: "working", cancel: "cancelled", expire: "expired" },
  approved: {},
  declined: {},
  expired: {},
  cancelled: {},
};
const ACTIONS = Object.keys(ROLE_FOR) as Action[];

describe("nextState", () => {
  for (const state of STATES) {
    for (const action of ACTIONS) {
      const expected = EXPECTED[state][action] ?? null;
      test(`${state} --${action}--> ${expected ?? "refused"}`, () => assert.equal(nextState(state, action), expected));
    }
  }
});

describe("states", () => {
  test("there are nine states, four of them terminal", () => {
    assert.equal(STATES.length, 9);
    assert.deepEqual(STATES.filter(isTerminal), ["approved", "declined", "expired", "cancelled"]);
  });

  test("allowedActions lists exactly the table's actions", () => {
    for (const state of STATES) {
      assert.deepEqual(allowedActions(state).sort(), Object.keys(EXPECTED[state]).sort(), state);
    }
  });

  test("every non-terminal state can still end", () => {
    for (const state of STATES.filter((s) => !isTerminal(s))) {
      assert.ok(allowedActions(state).includes("cancel") && allowedActions(state).includes("expire"), state);
    }
  });
});

describe("roles", () => {
  test("workers move the work forward, managers judge it, the desk expires it", () => {
    assert.deepEqual(ACTIONS.filter((a) => ROLE_FOR[a] === "worker").sort(), ["accept", "decline", "report_blocked", "report_done", "report_failed", "start"]);
    assert.deepEqual(ACTIONS.filter((a) => ROLE_FOR[a] === "manager").sort(), ["answer", "approve", "cancel", "rework"]);
    assert.deepEqual(ACTIONS.filter((a) => ROLE_FOR[a] === "desk"), ["expire"]);
  });
});
