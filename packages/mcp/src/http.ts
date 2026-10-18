// The desk over Streamable HTTP, with the actor taken from an authenticated identity (SPEC.md §10).
// Every agent connects to one desk; `authenticate` turns each request's credential into an agent
// ref, and the request's tools act as that ref and refuse any other `actor` argument.
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AgentRef, WorkDesk } from "agent-work-layer";
import { createDeskServer } from "./index.ts";

/**
 * Turns a request's credential into the agent it belongs to. Return the agent ref, or throw
 * (preferably an `AuthError`) to refuse the request. Returning nothing also refuses it.
 */
export type Authenticate = (req: IncomingMessage) => AgentRef | undefined | Promise<AgentRef | undefined>;

/** Refuses a request: 401 when the credential is missing or invalid, 403 when it is valid but names no agent. */
export class AuthError extends Error {
  readonly status: 401 | 403;
  /** `WWW-Authenticate` header value for a 401. Default `Bearer`. */
  readonly challenge?: string;

  constructor(message: string, { status = 401, challenge }: { status?: 401 | 403; challenge?: string } = {}) {
    super(message);
    this.name = "AuthError";
    this.status = status;
    this.challenge = challenge;
  }
}

/** OAuth 2.0 Protected Resource Metadata (RFC 9728), which MCP clients read to find the authorization server. */
export interface ProtectedResourceMetadata {
  /** The desk's URL, e.g. `https://desk.example.com/mcp`. Tokens must be issued for it. */
  resource: string;
  authorization_servers: string[];
  scopes_supported?: string[];
  [key: string]: unknown;
}

export interface DeskHttpOptions {
  desk: WorkDesk;
  /** Called on every request. In HTTP mode this is the only source of `actor`. */
  authenticate: Authenticate;
  /** Path the MCP endpoint is served on. Default `/mcp`. */
  path?: string;
  /** When set, served without authentication at `/.well-known/oauth-protected-resource<path>`. */
  resourceMetadata?: ProtectedResourceMetadata;
  name?: string;
}

const WELL_KNOWN = "/.well-known/oauth-protected-resource";

/** The URL of the metadata document a handler with these options serves for `resource`. */
export const resourceMetadataUrl = (resource: string, path = "/mcp") => new URL(WELL_KNOWN + path, resource).href;

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
}

/**
 * Builds a Node `http` request handler for the desk. Each request is authenticated, then served
 * by a stateless MCP server bound to the authenticated agent, so no session outlives its credential.
 */
export function createDeskHttpHandler({ desk, authenticate, path = "/mcp", resourceMetadata, name }: DeskHttpOptions) {
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let pathname: string;
    try {
      ({ pathname } = new URL(req.url ?? "/", "http://desk"));
    } catch {
      return send(res, 400, { error: "bad_request" });
    }
    if (resourceMetadata && pathname === WELL_KNOWN + path && req.method === "GET") return send(res, 200, resourceMetadata);
    if (pathname !== path) return send(res, 404, { error: "not_found" });

    let actor: AgentRef | undefined;
    try {
      actor = await authenticate(req);
    } catch (e) {
      // Fail closed: any error refuses the request, but only an AuthError's message is shown.
      const known = e instanceof AuthError;
      const status = known ? e.status : 401;
      const headers: Record<string, string> = status === 401 ? { "www-authenticate": (known && e.challenge) || "Bearer" } : {};
      return send(res, status, { error: status === 401 ? "invalid_token" : "insufficient_scope", error_description: known ? e.message : "authentication failed" }, headers);
    }
    if (!actor) return send(res, 401, { error: "invalid_token", error_description: "no credential" }, { "www-authenticate": "Bearer" });

    const server = createDeskServer({ desk, actor, name });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => void server.close());
    await server.connect(transport);
    await transport.handleRequest(req, res);
  };

  // Never rejects, so it can be passed straight to `http.createServer`.
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      await handle(req, res);
    } catch {
      if (!res.headersSent) send(res, 500, { error: "server_error" });
      else res.end();
    }
  };
}

/** Reads the token from `Authorization: Bearer <token>`. */
export function bearerToken(req: IncomingMessage): string | undefined {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? "");
  return match?.[1];
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * Example authenticator for small setups: a static map of API key to agent ref, sent as
 * `Authorization: Bearer <key>`. Keys are compared by hash, so lookups do not leak timing.
 */
export function apiKeyAuth(keys: Record<string, AgentRef>): Authenticate {
  const byHash = new Map<string, AgentRef>();
  for (const [key, agent] of Object.entries(keys)) {
    if (!key || typeof agent !== "string" || !agent) throw new Error("apiKeyAuth: every key and agent ref must be a non-empty string");
    byHash.set(sha256(key), agent);
  }
  return (req) => {
    const token = bearerToken(req);
    if (!token) throw new AuthError("no API key", { challenge: "Bearer" });
    const agent = byHash.get(sha256(token));
    if (!agent) throw new AuthError("unknown API key", { challenge: 'Bearer error="invalid_token"' });
    return agent;
  };
}

/** Claims of an access token the deployment has already verified (signature, issuer). */
export interface TokenClaims {
  sub?: string;
  aud?: string | string[];
  /** Expiry, in seconds since the epoch. */
  exp?: number;
  [claim: string]: unknown;
}

export interface BearerAuthOptions {
  /**
   * Checks the token's signature and issuer and returns its claims; throws if it is not valid.
   * For a JWT, e.g. jose's `jwtVerify(token, JWKS, { issuer })`; for an opaque token, introspection.
   */
  verify: (token: string) => TokenClaims | Promise<TokenClaims>;
  /** The desk's resource URL. A token whose `aud` does not include it is refused. */
  audience: string;
  /**
   * Maps a token to an agent ref: a map from `sub`, or a function of the claims. Default: `sub` as is.
   * A token that maps to no agent is refused with 403.
   */
  agents?: Record<string, AgentRef> | ((claims: TokenClaims) => AgentRef | undefined);
  /** Advertised in 401 challenges so MCP clients can find the authorization server. */
  resourceMetadataUrl?: string;
  /** Current time. Override in tests. */
  clock?: () => Date;
}

/**
 * Example authenticator for OAuth 2.1 bearer tokens, as the MCP authorization spec describes:
 * the desk is the resource server, the token must be unexpired and issued for the desk
 * (`aud`), and its subject is mapped to an agent ref.
 */
export function bearerAuth({ verify, audience, agents = (c) => c.sub, resourceMetadataUrl, clock = () => new Date() }: BearerAuthOptions): Authenticate {
  if (!audience) throw new Error("bearerAuth: audience is required");
  const refuse = (message: string, error?: string) => {
    const params = [error && `error="${error}", error_description="${message}"`, resourceMetadataUrl && `resource_metadata="${resourceMetadataUrl}"`].filter(Boolean);
    return new AuthError(message, { challenge: ["Bearer", params.join(", ")].filter(Boolean).join(" ") });
  };
  const toAgent = typeof agents === "function" ? agents : (c: TokenClaims) => (c.sub !== undefined && Object.hasOwn(agents, c.sub) ? agents[c.sub] : undefined);

  return async (req) => {
    const token = bearerToken(req);
    if (!token) throw refuse("no bearer token");
    let claims: TokenClaims;
    try {
      claims = await verify(token);
    } catch {
      throw refuse("token could not be verified", "invalid_token");
    }
    if (typeof claims.exp !== "number" || claims.exp * 1000 <= clock().getTime()) throw refuse("token has expired or has no exp", "invalid_token");
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(audience)) throw refuse("token was not issued for this desk", "invalid_token");
    const agent = toAgent(claims);
    if (!agent) throw new AuthError(`no agent for subject "${claims.sub ?? ""}"`, { status: 403 });
    return agent;
  };
}
