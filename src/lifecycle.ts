// Lifecycle from SPEC.md §6.
import type { Action, State } from "./types.ts";

export type Role = "worker" | "manager" | "desk";

export const STATES: readonly State[] = [
  "offered", "accepted", "working", "blocked", "submitted",
  "approved", "declined", "expired", "cancelled",
];

export const TERMINAL_STATES: ReadonlySet<State> = new Set<State>(["approved", "declined", "expired", "cancelled"]);

const MOVES: Partial<Record<State, Partial<Record<Action, State>>>> = {
  offered: { accept: "accepted", decline: "declined" },
  accepted: { start: "working" },
  working: { report_done: "submitted", report_failed: "submitted", report_blocked: "blocked" },
  blocked: { answer: "working" },
  submitted: { approve: "approved", rework: "working" },
};

/** Who may perform each action. `answer` is also open to the order's escalation contact. */
export const ROLE_FOR: Readonly<Record<Action, Role>> = {
  accept: "worker",
  decline: "worker",
  start: "worker",
  report_done: "worker",
  report_failed: "worker",
  report_blocked: "worker",
  answer: "manager",
  approve: "manager",
  rework: "manager",
  cancel: "manager",
  expire: "desk",
};

export const isTerminal = (state: State): boolean => TERMINAL_STATES.has(state);

/** The state after `action`, or null when the action is not allowed from `state`. */
export function nextState(state: State, action: Action): State | null {
  if (isTerminal(state)) return null;
  if (action === "cancel") return "cancelled";
  if (action === "expire") return "expired";
  return MOVES[state]?.[action] ?? null;
}

/** Actions allowed from `state`, in a stable order. */
export function allowedActions(state: State): Action[] {
  return (Object.keys(ROLE_FOR) as Action[]).filter((a) => nextState(state, a) !== null);
}
