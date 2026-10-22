/**
 * Validation only: document types, JSON Schemas, every check in SPEC.md §7–§8, and Delegation Pass
 * signing and verification (§10.2, WebCrypto).
 * Imports no Node built-ins, so it runs in browsers, Deno and Bun.
 * @packageDocumentation
 */
export * from "./types.ts";
export {
  validateOrder, validateReport, validateChildOrder, validateChildBudgets, validateOwnCost, heldBySubOrders, hasInvalid,
  isWorkOrder, isWorkReport, toolAllowed, patternCovered,
  workOrderSchema, workReportSchema,
} from "./validate.ts";
export type { SubOrder } from "./validate.ts";
export { signPass, verifyPass, decodePass, PassError, PASS_TYP, PASS_TTL_SECONDS } from "./pass.ts";
export type { PassClaims, PassKey, PassKeys, PassJwk, PassCryptoKey, PassErrorCode, SignPassOptions, VerifyPassOptions, VerifiedPass } from "./pass.ts";
