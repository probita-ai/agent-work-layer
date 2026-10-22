/**
 * Agent Work Layer SDK: Work Orders, Work Reports, validation, and a desk that
 * runs the lifecycle. See SPEC.md for the format.
 * @packageDocumentation
 */
export * from "./types.ts";
export { AwlError, isAwlError } from "./errors.ts";
export type { AwlErrorCode } from "./errors.ts";
export {
  validateOrder, validateReport, validateChildOrder, validateChildBudgets, validateOwnCost, heldBySubOrders, hasInvalid,
  isWorkOrder, isWorkReport, toolAllowed, patternCovered,
  workOrderSchema, workReportSchema,
} from "./validate.ts";
export type { SubOrder } from "./validate.ts";
export { signPass, verifyPass, decodePass, PassError, PASS_TYP, PASS_TTL_SECONDS } from "./pass.ts";
export type { PassClaims, PassKey, PassKeys, PassJwk, PassCryptoKey, PassErrorCode, SignPassOptions, VerifyPassOptions, VerifiedPass } from "./pass.ts";
export { STATES, TERMINAL_STATES, ROLE_FOR, isTerminal, nextState, allowedActions } from "./lifecycle.ts";
export type { Role } from "./lifecycle.ts";
export { WorkDesk, summarize, lastSeq } from "./desk.ts";
export type { DeskOptions, PassOptions, ListFilter, WaitOptions, SubmitResult } from "./desk.ts";
export { MemoryStore, FileStore, SqliteStore } from "./store.ts";
export type { DeskStore } from "./store.ts";
export { VERSION } from "./version.ts";
