import type { Finding } from "./types.ts";

export type AwlErrorCode =
  | "NOT_FOUND"
  | "ALREADY_EXISTS"
  | "FORBIDDEN"
  | "INVALID_TRANSITION"
  | "VALIDATION_FAILED"
  | "CONFLICT"
  | "BAD_REQUEST";

/** Every error the SDK throws on purpose. `findings` is set when `code` is VALIDATION_FAILED. */
export class AwlError extends Error {
  readonly code: AwlErrorCode;
  readonly findings: Finding[];

  constructor(code: AwlErrorCode, message: string, findings: Finding[] = []) {
    super(message);
    this.name = "AwlError";
    this.code = code;
    this.findings = findings;
  }

  toJSON() {
    return { code: this.code, message: this.message, findings: this.findings };
  }
}

export const isAwlError = (e: unknown): e is AwlError => e instanceof AwlError;
