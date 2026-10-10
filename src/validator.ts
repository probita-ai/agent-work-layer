/**
 * Validation only: document types, JSON Schemas and every check in SPEC.md §7–§8.
 * Imports no Node built-ins, so it runs in browsers, Deno and Bun.
 * @packageDocumentation
 */
export * from "./types.ts";
export {
  validateOrder, validateReport, validateChildOrder, hasInvalid,
  isWorkOrder, isWorkReport, toolAllowed, patternCovered,
  workOrderSchema, workReportSchema,
} from "./validate.ts";
