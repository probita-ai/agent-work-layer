import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { AwlError, PassError, WorkDesk, decodePass, signPass, verifyPass } from "../src/index.ts";
import * as validator from "../src/validator.ts";
import type { PassJwk, PassKey, PassErrorCode, VerifiedPass, WorkOrder } from "../src/index.ts";
import { DEADLINE, MANAGER, STRANGER, T0, WORKER, order, orderInput, reportInput, rules } from "./helpers.ts";

const ISSUER = "https://desk.example.com";
const NOW = new Date("2026-01-01T10:00:00Z");

async function keyPair(alg: "ES256" | "EdDSA", kid?: string): Promise<{ priv: PassJwk; pub: PassJwk }> {
  const params = alg === "ES256" ? { name: "ECDSA", namedCurve: "P-256" } : { name: "Ed25519" };
  const pair = (await webcrypto.subtle.generateKey(params, true, ["sign", "verify"])) as webcrypto.CryptoKeyPair;
  const priv = (await webcrypto.subtle.exportKey("jwk", pair.privateKey)) as PassJwk;
  const pub = (await webcrypto.subtle.exportKey("jwk", pair.publicKey)) as PassJwk;
  return kid ? { priv: { ...priv, kid }, pub: { ...pub, kid } } : { priv, pub };
}

const es = await keyPair("ES256", "k1");
const ed = await keyPair("EdDSA");

const sign = (o: WorkOrder = order(), key: PassKey = es.priv, options = {}) => signPass(o, key, { issuer: ISSUER, now: NOW, ...options });
const verify = (token: string, options = {}) => verifyPass(token, es.pub, { now: NOW, ...options });

async function rejects(p: Promise<unknown>, code: PassErrorCode) {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof PassError, String(e));
    assert.equal(e.code, code, e.message);
    return true;
  });
}

const tamper = (token: string, change: (claims: Record<string, unknown>) => void) => {
  const [h, , s] = token.split(".");
  const claims = decodePass(token) as unknown as Record<string, unknown>;
  change(claims);
  return `${h}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${s}`;
};

describe("signPass and verifyPass", () => {
  test("round-trips an order's authority", async () => {
    const o = order({ budget: { usd: 2, tool_calls: 20 }, tools: ["filings/*", "calc/ratio"] });
    const token = await sign(o, es.priv, { attempt: 2, jti: "p-1" });
    const pass = await verify(token, { issuer: ISSUER, worker: WORKER, order: "wo_1" });
    assert.deepEqual(pass.claims, {
      iss: ISSUER, sub: WORKER, awl_order: "wo_1", awl_tools: ["filings/*", "calc/ratio"], awl_budget: { usd: 2, tool_calls: 20 },
      awl_deadline: o.deadline, awl_attempt: 2, iat: NOW.getTime() / 1000, exp: NOW.getTime() / 1000 + 900, jti: "p-1",
    });
    assert.deepEqual(pass.header, { alg: "ES256", typ: "awl-pass+jwt", kid: "k1" });
    assert.equal(pass.allows("filings/search"), true);
    assert.equal(pass.allows("calc/ratio"), true);
    assert.equal(pass.allows("web/browse"), false);
  });

  test("works with Ed25519 keys and with WebCrypto keys", async () => {
    assert.equal((await verifyPass(await sign(order(), ed.priv), ed.pub, { now: NOW })).header.alg, "EdDSA");
    const pair = (await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"])) as webcrypto.CryptoKeyPair;
    const token = await sign(order(), pair.privateKey);
    assert.equal((await verifyPass(token, pair.publicKey, { now: NOW })).claims.sub, WORKER);
  });

  test("accepts a key list or a JWK Set and picks the key by kid", async () => {
    const token = await sign();
    const other = await keyPair("ES256", "k2");
    assert.ok(await verifyPass(token, [other.pub, ed.pub, es.pub], { now: NOW }));
    assert.ok(await verifyPass(token, { keys: [other.pub, es.pub] }, { now: NOW }));
    await rejects(verifyPass(token, { keys: [{ ...es.pub, kid: "k2" }] }, { now: NOW }), "BAD_SIGNATURE");
    // A private JWK verifies too: only its public part is used.
    assert.ok(await verifyPass(token, es.priv, { now: NOW }));
  });

  test("caps the lifetime at the order's deadline", async () => {
    const pass = await verify(await sign(order(), es.priv, { ttlSeconds: 86_400 }));
    assert.equal(pass.claims.exp, Date.parse(DEADLINE) / 1000);
    assert.equal(pass.expiresAt.toISOString(), DEADLINE);
    await rejects(sign(order(), es.priv, { now: new Date(DEADLINE) }), "EXPIRED");
  });

  test("names the parent of a sub-order", async () => {
    assert.equal(decodePass(await sign(order({ id: "wo_2", parent_id: "wo_1" }))).awl_parent, "wo_1");
  });

  test("rejects an expired pass, or one issued in the future", async () => {
    const token = await sign();
    await rejects(verify(token, { now: new Date(NOW.getTime() + 900_000) }), "EXPIRED");
    assert.ok(await verify(token, { now: new Date(NOW.getTime() + 900_000), clockToleranceSeconds: 5 }));
    await rejects(verify(token, { now: new Date(NOW.getTime() - 60_000) }), "NOT_YET_VALID");
  });

  test("rejects a bad signature, a tampered claim and a foreign key", async () => {
    const token = await sign();
    await rejects(verify(token.slice(0, -4) + (token.endsWith("AAAA") ? "BBBB" : "AAAA")), "BAD_SIGNATURE");
    await rejects(verify(tamper(token, (c) => (c.awl_tools = ["*"]))), "BAD_SIGNATURE");
    await rejects(verifyPass(token, (await keyPair("ES256")).pub, { now: NOW }), "BAD_SIGNATURE");
    await rejects(verifyPass(token, ed.pub, { now: NOW }), "BAD_SIGNATURE");
  });

  test("rejects the wrong worker, order or issuer", async () => {
    const token = await sign();
    await rejects(verify(token, { worker: STRANGER }), "WRONG_WORKER");
    await rejects(verify(token, { order: "wo_other" }), "WRONG_ORDER");
    await rejects(verify(token, { issuer: "https://evil.example.com" }), "WRONG_ISSUER");
  });

  test("rejects malformed tokens, unsigned tokens and other token types", async () => {
    for (const bad of ["", "a.b", "a.b.c.d", "!!.e30.sig", 42 as unknown as string]) await rejects(verify(bad), "MALFORMED");
    const [, payload] = (await sign()).split(".");
    const head = (h: object) => Buffer.from(JSON.stringify(h)).toString("base64url");
    await rejects(verify(`${head({ alg: "none", typ: "awl-pass+jwt" })}.${payload}.`), "UNSUPPORTED");
    await rejects(verify(`${head({ alg: "HS256", typ: "awl-pass+jwt" })}.${payload}.x`), "UNSUPPORTED");
    await rejects(verify(`${head({ alg: "ES256", typ: "JWT" })}.${payload}.x`), "MALFORMED");
  });

  test("rejects signed claims that are not a pass", async () => {
    // Signed by the right key, but missing fields: only the shape check can catch it.
    const pair = es.priv;
    const signed = async (claims: object) => {
      const enc = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");
      const input = `${enc({ alg: "ES256", typ: "awl-pass+jwt" })}.${enc(claims)}`;
      const key = await webcrypto.subtle.importKey("jwk", pair, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
      const sig = await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(input));
      return `${input}.${Buffer.from(sig).toString("base64url")}`;
    };
    const good = decodePass(await sign());
    await rejects(verify(await signed({ ...good, awl_tools: "filings/*" })), "MALFORMED");
    await rejects(verify(await signed({ ...good, awl_budget: { usd: -1 } })), "MALFORMED");
    await rejects(verify(await signed({ ...good, awl_budget: { dollars: 1 } })), "MALFORMED");
    await rejects(verify(await signed({ ...good, exp: undefined })), "MALFORMED");
    assert.ok(await verify(await signed(good)));
  });

  test("refuses keys it does not support", async () => {
    await rejects(sign(order(), { kty: "RSA", crv: "", x: "" }), "UNSUPPORTED");
    await rejects(sign(order(), es.pub), "UNSUPPORTED");
  });

  test("is exported from the browser-safe entry point", () => {
    assert.equal(validator.signPass, signPass);
    assert.equal(validator.verifyPass, verifyPass);
  });
});

describe("narrowing across passes", () => {
  const root = order({ id: "wo_1", budget: { usd: 2, tool_calls: 20 }, tools: ["filings/*", "calc/ratio"], deadline: DEADLINE });
  const child = order({ id: "wo_2", parent_id: "wo_1", to: "agent:helper", budget: { usd: 1, tool_calls: 10 }, tools: ["filings/*"], deadline: "2026-01-01T11:30:00Z" });
  const grandchild = (overrides: Partial<WorkOrder> = {}) =>
    order({ id: "wo_3", parent_id: "wo_2", to: "agent:sub", budget: { usd: 0.5, tool_calls: 5 }, tools: ["filings/search"], deadline: "2026-01-01T11:00:00Z", ...overrides });

  async function chain(...orders: WorkOrder[]): Promise<VerifiedPass> {
    let parent: VerifiedPass | undefined;
    for (const o of orders) parent = await verify(await sign(o), { parent });
    return parent!;
  }

  test("verifies two levels of sub-orders from the top down", async () => {
    const leaf = await chain(root, child, grandchild());
    assert.equal(leaf.claims.awl_parent, "wo_2");
    assert.equal(leaf.allows("filings/search"), true);
    assert.equal(leaf.allows("filings/get"), false);
  });

  test("rejects a pass wider than its parent: C1, C2 and C3", async () => {
    const parent = await chain(root, child);
    const check = async (o: WorkOrder, rule: string) => {
      const err = await verify(await sign(o), { parent }).catch((e) => e);
      assert.equal(err.code, "WIDER_THAN_PARENT");
      assert.deepEqual(rules(err.findings), [rule]);
    };
    await check(grandchild({ budget: { usd: 5, tool_calls: 5 } }), "C1");
    await check(grandchild({ budget: { usd: 0.5 } }), "C1");
    await check(grandchild({ tools: ["calc/ratio"] }), "C2");
    await check(grandchild({ tools: ["*"] }), "C2");
    await check(grandchild({ deadline: DEADLINE }), "C3");
  });

  test("rejects a pass that names another parent, or none", async () => {
    const parent = await chain(root, child);
    await rejects(verify(await sign(grandchild({ parent_id: "wo_9" })), { parent }), "WRONG_PARENT");
    await rejects(verify(await sign(grandchild({ parent_id: undefined })), { parent }), "WRONG_PARENT");
  });
});

describe("desk issues passes", () => {
  const passes = { key: es.priv, issuer: ISSUER };
  let now = new Date(T0);
  const desk = () => new WorkDesk({ passes, clock: () => now });

  test("on start, on re-entering working, and on request; dropped when work stops", async () => {
    now = new Date(T0);
    const d = desk();
    const { order: o } = await d.create(orderInput(), MANAGER);
    assert.equal((await d.accept(o.id, WORKER)).pass, undefined);

    const started = await d.start(o.id, WORKER);
    const first = await verifyPass(started.pass!, es.pub, { now, issuer: ISSUER, worker: WORKER, order: o.id });
    assert.equal(first.claims.awl_attempt, 1);
    assert.deepEqual(first.claims.awl_tools, o.tools);

    const blocked = (await d.submitReport(o.id, reportInput({ status: "blocked", evidence: [], questions: ["Which year?"] }), WORKER)).record;
    assert.equal(blocked.pass, undefined);
    const answered = await d.answer(o.id, MANAGER, "FY2025");
    const second = await verifyPass(answered.pass!, es.pub, { now });
    assert.equal(second.claims.awl_attempt, 2);
    assert.notEqual(second.claims.jti, first.claims.jti);

    now = new Date(Date.parse(T0) + 600_000);
    const renewed = await d.issuePass(o.id, WORKER);
    assert.equal((await verifyPass(renewed, es.pub, { now })).claims.iat, now.getTime() / 1000);
    assert.equal((await d.get(o.id)).pass, renewed);

    assert.equal((await d.cancel(o.id, MANAGER)).pass, undefined);
  });

  test("issuePass is for the worker of a working order only", async () => {
    now = new Date(T0);
    const d = desk();
    const { order: o } = await d.create(orderInput(), MANAGER);
    await assert.rejects(d.issuePass(o.id, WORKER), (e: AwlError) => e.code === "INVALID_TRANSITION");
    await d.accept(o.id, WORKER);
    await d.start(o.id, WORKER);
    await assert.rejects(d.issuePass(o.id, MANAGER), (e: AwlError) => e.code === "FORBIDDEN");
    await assert.rejects(new WorkDesk().issuePass(o.id, WORKER), (e: AwlError) => e.code === "BAD_REQUEST");
  });

  test("a sub-order's pass verifies against its parent's", async () => {
    now = new Date(T0);
    const d = desk();
    const parent = (await d.create(orderInput(), MANAGER)).order.id;
    await d.accept(parent, WORKER);
    const parentPass = await verifyPass((await d.start(parent, WORKER)).pass!, es.pub, { now });
    const child = (await d.create(orderInput({ to: STRANGER, parent_id: parent, budget: { usd: 1, tool_calls: 5 }, tools: ["filings/search"] }), WORKER)).order.id;
    await d.accept(child, STRANGER);
    const childPass = await verifyPass((await d.start(child, STRANGER)).pass!, es.pub, { now, parent: parentPass, worker: STRANGER });
    assert.equal(childPass.claims.awl_parent, parent);
  });

  test("an expired order drops its pass", async () => {
    now = new Date(T0);
    const d = desk();
    const { order: o } = await d.create(orderInput(), MANAGER);
    await d.accept(o.id, WORKER);
    await d.start(o.id, WORKER);
    now = new Date(Date.parse(DEADLINE) + 1000);
    const expired = await d.get(o.id);
    assert.equal(expired.state, "expired");
    assert.equal(expired.pass, undefined);
    assert.equal((await d.store.read(o.id))!.pass, undefined);
  });
});
