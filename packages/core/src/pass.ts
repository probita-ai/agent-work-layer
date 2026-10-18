// Delegation Pass (SPEC.md §10.2): an order's authority as a signed JWT anyone can verify.
// WebCrypto only, no Node built-ins: this also runs in browsers, Deno and Bun (see src/validator.ts).
import { toolAllowed, validateChildOrder } from "./validate.ts";
import { UNITS } from "./types.ts";
import type { AgentRef, Amounts, Finding, WorkOrder } from "./types.ts";

/** The JWS `typ` of every pass, so a pass is never mistaken for another kind of token. */
export const PASS_TYP = "awl-pass+jwt";
/** Default lifetime: 15 minutes, and never past the order's deadline. */
export const PASS_TTL_SECONDS = 900;
/** How far in the future `iat` may be: the issuer's clock may run ahead of the verifier's. */
const IAT_SKEW_SECONDS = 60;

export interface PassClaims {
  /** The desk that issued the pass. */
  iss: string;
  /** The worker the pass was issued to: the order's `to`. */
  sub: AgentRef;
  awl_order: string;
  /** The parent order's id, for sub-orders. */
  awl_parent?: string;
  /** The order's tool patterns. */
  awl_tools: string[];
  /** The order's whole budget, not what is left of it. */
  awl_budget: Amounts;
  /** The order's deadline (RFC 3339). `exp` is never later. */
  awl_deadline: string;
  /** The report attempt the pass was issued for: 1, then +1 per report. */
  awl_attempt?: number;
  /** Issue and expiry times, in seconds since the epoch. */
  iat: number;
  exp: number;
  /** Unique id of this pass. */
  jti: string;
}

/** A JWK: a P-256 EC key (ES256) or an Ed25519 OKP key (EdDSA). */
export interface PassJwk {
  kty: string;
  crv: string;
  x: string;
  y?: string;
  /** The private part; needed to sign. */
  d?: string;
  kid?: string;
  [member: string]: unknown;
}

/** A WebCrypto `CryptoKey`, described by shape so this module needs no DOM or Node types. */
export interface PassCryptoKey {
  readonly type: string;
  readonly algorithm: { name: string; namedCurve?: string };
  readonly usages: readonly string[];
}

/** A JWK or a WebCrypto key. Private to sign, public to verify. */
export type PassKey = PassJwk | PassCryptoKey;
/** One key, several, or a JWK Set. */
export type PassKeys = PassKey | readonly PassKey[] | { keys: readonly PassJwk[] };

export type PassErrorCode =
  | "MALFORMED"
  | "UNSUPPORTED"
  | "BAD_SIGNATURE"
  | "EXPIRED"
  | "NOT_YET_VALID"
  | "WRONG_ISSUER"
  | "WRONG_WORKER"
  | "WRONG_ORDER"
  | "WRONG_PARENT"
  | "WIDER_THAN_PARENT";

/** Why a pass could not be signed or was rejected. `findings` is set for WIDER_THAN_PARENT (rules C1–C3). */
export class PassError extends Error {
  readonly code: PassErrorCode;
  readonly findings: Finding[];

  constructor(code: PassErrorCode, message: string, findings: Finding[] = []) {
    super(message);
    this.name = "PassError";
    this.code = code;
    this.findings = findings;
  }

  toJSON() {
    return { code: this.code, message: this.message, findings: this.findings };
  }
}

export interface SignPassOptions {
  /** Goes in `iss`; verifiers check it. */
  issuer: string;
  /** The report attempt the pass is for. */
  attempt?: number;
  /** Lifetime in seconds, capped at the order's deadline. Default 900. */
  ttlSeconds?: number;
  /** Key id for the JWS header. Default: the JWK's `kid`. */
  kid?: string;
  now?: Date;
  jti?: string;
}

export interface VerifyPassOptions {
  /** Required `iss`. */
  issuer?: string;
  /** Required `sub`: the worker presenting the pass. */
  worker?: AgentRef;
  /** Required `awl_order`. */
  order?: string;
  /**
   * The parent order's verified pass. The pass must then name it in `awl_parent` and be no
   * wider than it (C1–C3). Verify a chain from the top down, passing each result to the next.
   */
  parent?: VerifiedPass;
  /** Seconds of clock skew to allow on `exp` (default 0) and on `iat` (at least 60, since issuer and verifier clocks differ). */
  clockToleranceSeconds?: number;
  now?: Date;
}

export interface VerifiedPass {
  claims: PassClaims;
  header: { alg: string; typ: string; kid?: string };
  /** When the pass stops being valid: `exp`, or the deadline if sooner. */
  expiresAt: Date;
  /** Does the pass allow this concrete tool (`server/tool`)? */
  allows(tool: string): boolean;
}

interface Subtle {
  importKey(format: "jwk", key: object, algorithm: object, extractable: boolean, usages: string[]): Promise<PassCryptoKey>;
  sign(algorithm: object, key: PassCryptoKey, data: Uint8Array): Promise<ArrayBuffer>;
  verify(algorithm: object, key: PassCryptoKey, signature: Uint8Array, data: Uint8Array): Promise<boolean>;
}
const webcrypto = () => (globalThis as unknown as { crypto: { subtle: Subtle; randomUUID(): string } }).crypto;

type Alg = "ES256" | "EdDSA";
const ALGS: Record<Alg, { key: object; sign: object }> = {
  ES256: { key: { name: "ECDSA", namedCurve: "P-256" }, sign: { name: "ECDSA", hash: "SHA-256" } },
  EdDSA: { key: { name: "Ed25519" }, sign: { name: "Ed25519" } },
};

const utf8 = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) throw new PassError("MALFORMED", "not base64url");
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const isCryptoKey = (key: PassKey): key is PassCryptoKey => "algorithm" in key && "usages" in key;

function algOf(key: PassKey): Alg {
  if (isCryptoKey(key)) {
    const a = key.algorithm;
    if (a.name === "ECDSA" && a.namedCurve === "P-256") return "ES256";
    if (a.name === "Ed25519") return "EdDSA";
  } else {
    if (key.kty === "EC" && key.crv === "P-256") return "ES256";
    if (key.kty === "OKP" && key.crv === "Ed25519") return "EdDSA";
  }
  throw new PassError("UNSUPPORTED", "pass keys must be P-256 (ES256) or Ed25519 (EdDSA)");
}

async function cryptoKey(key: PassKey, alg: Alg, use: "sign" | "verify"): Promise<PassCryptoKey> {
  if (isCryptoKey(key)) return key;
  // Verifying only needs the public part; dropping the rest also drops key_ops that would forbid it.
  const { kty, crv, x, y, d } = key;
  const jwk = { kty, crv, x, ...(y ? { y } : {}), ...(use === "sign" ? { d } : {}) };
  if (use === "sign" && !d) throw new PassError("UNSUPPORTED", "signing needs a private key");
  return webcrypto().subtle.importKey("jwk", jwk, ALGS[alg].key, false, [use]);
}

function keyList(keys: PassKeys): readonly PassKey[] {
  if (Array.isArray(keys)) return keys;
  if ("keys" in keys && Array.isArray(keys.keys)) return keys.keys;
  return [keys as PassKey];
}

/** Signs a pass for an order's worker. */
export async function signPass(order: WorkOrder, key: PassKey, options: SignPassOptions): Promise<string> {
  const { issuer, attempt, ttlSeconds = PASS_TTL_SECONDS, now = new Date(), jti = webcrypto().randomUUID() } = options;
  if (!issuer) throw new PassError("MALFORMED", "a pass needs an issuer");
  const alg = algOf(key);
  const kid = options.kid ?? (isCryptoKey(key) ? undefined : key.kid);

  const iat = Math.floor(now.getTime() / 1000);
  const exp = Math.floor(Math.min(now.getTime() + ttlSeconds * 1000, Date.parse(order.deadline)) / 1000);
  if (exp <= iat) throw new PassError("EXPIRED", `order "${order.id}" is past its deadline`);

  const claims: PassClaims = {
    iss: issuer,
    sub: order.to,
    awl_order: order.id,
    ...(order.parent_id ? { awl_parent: order.parent_id } : {}),
    awl_tools: [...order.tools],
    awl_budget: { ...order.budget },
    awl_deadline: order.deadline,
    ...(attempt !== undefined ? { awl_attempt: attempt } : {}),
    iat,
    exp,
    jti,
  };
  const header = { alg, typ: PASS_TYP, ...(kid ? { kid } : {}) };
  const input = `${b64url(utf8.encode(JSON.stringify(header)))}.${b64url(utf8.encode(JSON.stringify(claims)))}`;
  const signature = await webcrypto().subtle.sign(ALGS[alg].sign, await cryptoKey(key, alg, "sign"), utf8.encode(input));
  return `${input}.${b64url(new Uint8Array(signature))}`;
}

/** Reads a pass's claims without checking anything. For display and routing only; use verifyPass to trust it. */
export function decodePass(token: string): PassClaims {
  const parts = typeof token === "string" ? token.split(".") : [];
  if (parts.length !== 3) throw new PassError("MALFORMED", "a pass is three base64url parts joined by dots");
  try {
    return JSON.parse(new TextDecoder().decode(unb64url(parts[1])));
  } catch (e) {
    throw e instanceof PassError ? e : new PassError("MALFORMED", "the claims are not JSON");
  }
}

const isString = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isTime = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function checkShape(c: Record<string, unknown>): asserts c is PassClaims & Record<string, unknown> {
  const budget = c.awl_budget as Record<string, unknown> | undefined;
  const ok =
    isString(c.iss) && isString(c.sub) && isString(c.awl_order) && isString(c.jti) &&
    (c.awl_parent === undefined || isString(c.awl_parent)) &&
    Array.isArray(c.awl_tools) && c.awl_tools.every(isString) &&
    !!budget && typeof budget === "object" && !Array.isArray(budget) &&
    Object.entries(budget).every(([unit, v]) => (UNITS as readonly string[]).includes(unit) && typeof v === "number" && v >= 0) &&
    isString(c.awl_deadline) && !Number.isNaN(Date.parse(c.awl_deadline)) &&
    (c.awl_attempt === undefined || (Number.isInteger(c.awl_attempt) && (c.awl_attempt as number) >= 1)) &&
    isTime(c.iat) && isTime(c.exp);
  if (!ok) throw new PassError("MALFORMED", "the claims do not match the pass format");
}

/**
 * Verifies a pass: its signature against `keys`, its type and lifetime, and, when asked,
 * its issuer, worker, order and narrowing against the parent's pass. Throws a PassError.
 */
export async function verifyPass(token: string, keys: PassKeys, options: VerifyPassOptions = {}): Promise<VerifiedPass> {
  const { issuer, worker, order, parent, clockToleranceSeconds = 0, now = new Date() } = options;
  const parts = typeof token === "string" ? token.split(".") : [];
  if (parts.length !== 3) throw new PassError("MALFORMED", "a pass is three base64url parts joined by dots");

  let header: VerifiedPass["header"];
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(new TextDecoder().decode(unb64url(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(unb64url(parts[1])));
  } catch {
    throw new PassError("MALFORMED", "the header or claims are not base64url JSON");
  }
  if (!header || typeof header !== "object" || header.typ !== PASS_TYP) throw new PassError("MALFORMED", `typ must be "${PASS_TYP}"`);
  if (!Object.hasOwn(ALGS, header.alg)) throw new PassError("UNSUPPORTED", `unsupported alg "${String(header.alg)}"`);
  const alg = header.alg as Alg;

  const candidates = keyList(keys).filter((k) => {
    try {
      return algOf(k) === alg && (!header.kid || isCryptoKey(k) || !k.kid || k.kid === header.kid);
    } catch {
      return false;
    }
  });
  const signature = unb64url(parts[2]);
  const data = utf8.encode(`${parts[0]}.${parts[1]}`);
  let valid = false;
  for (const k of candidates) {
    if (await webcrypto().subtle.verify(ALGS[alg].sign, await cryptoKey(k, alg, "verify"), signature, data)) {
      valid = true;
      break;
    }
  }
  if (!valid) throw new PassError("BAD_SIGNATURE", "no key verifies this pass");

  if (!claims || typeof claims !== "object" || Array.isArray(claims)) throw new PassError("MALFORMED", "the claims are not an object");
  checkShape(claims);
  const c = claims as PassClaims;

  if (issuer !== undefined && c.iss !== issuer) throw new PassError("WRONG_ISSUER", `issued by "${c.iss}", not "${issuer}"`);
  const t = now.getTime();
  const expiresAt = new Date(Math.min(c.exp * 1000, Date.parse(c.awl_deadline)));
  if (expiresAt.getTime() + clockToleranceSeconds * 1000 <= t) throw new PassError("EXPIRED", `pass "${c.jti}" expired at ${expiresAt.toISOString()}`);
  if ((c.iat - Math.max(clockToleranceSeconds, IAT_SKEW_SECONDS)) * 1000 > t) throw new PassError("NOT_YET_VALID", `pass "${c.jti}" is issued in the future`);
  if (worker !== undefined && c.sub !== worker) throw new PassError("WRONG_WORKER", `issued to "${c.sub}", not "${worker}"`);
  if (order !== undefined && c.awl_order !== order) throw new PassError("WRONG_ORDER", `for order "${c.awl_order}", not "${order}"`);

  if (parent) {
    if (c.awl_parent !== parent.claims.awl_order) {
      throw new PassError("WRONG_PARENT", `pass names parent "${c.awl_parent ?? "(none)"}", not "${parent.claims.awl_order}"`);
    }
    const findings = validateChildOrder(
      { budget: c.awl_budget, tools: c.awl_tools, deadline: c.awl_deadline },
      { budget: parent.claims.awl_budget, tools: parent.claims.awl_tools, deadline: parent.claims.awl_deadline },
    );
    if (findings.length) throw new PassError("WIDER_THAN_PARENT", `pass for "${c.awl_order}" is wider than its parent's`, findings);
  }

  return { claims: c, header, expiresAt, allows: (tool) => toolAllowed(tool, c.awl_tools) };
}
