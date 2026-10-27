import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { ORDER_SPEC, REPORT_SPEC, approvedEffects, decodePass, effectOutcomes, orderSpecFor, reportSpecFor, effectReferences, signPass, validateChildOrder, validateOrder, validateReport, verifyPass } from "../src/index.ts";
import type { PassJwk } from "../src/index.ts";
import { HELPER, MANAGER, WORKER, newDesk, order, orderInput, rejectsWith, report, reportInput, rules, workingOrder } from "./helpers.ts";

const staged = (overrides = {}) => order({ tools: ["filings/*", "gmail/*"], staged: ["gmail/send"], ...overrides });
const effect = (overrides = {}) => ({ ref: "gmail/send#4", tool: "gmail/send", arguments: { to: "cfo@example.com" }, ...overrides });

describe("staged tools", () => {
  test("are part of the v0.4 order and v0.3 report formats, and older versions still validate", () => {
    assert.equal(ORDER_SPEC, "awl/work-order@0.4");
    assert.equal(REPORT_SPEC, "awl/work-report@0.3");
    assert.deepEqual(validateOrder(staged()), []);
    assert.deepEqual(validateOrder(order({ spec: "awl/work-order@0.3" })), []);
    assert.deepEqual(validateReport(report({ spec: "awl/work-report@0.2" }), order()), []);
    assert.deepEqual(rules(validateOrder(staged({ staged: ["gmail send"] }))), ["O1"]);
    assert.deepEqual(rules(validateReport(report({ effects: [{ ref: "gmail/send#4", tool: "gmail/send" }] as never }), staged())), ["R1"]);
  });

  test("O5: staged patterns must be covered by the order's tools", () => {
    assert.deepEqual(validateOrder(staged({ staged: ["gmail/*", "filings/search"] })), []);
    assert.deepEqual(validateOrder(staged({ tools: ["*"], staged: ["*"] })), []);
    const findings = validateOrder(staged({ staged: ["gmail/send", "github/create_issue", "*"] }));
    assert.deepEqual(findings.map((f) => [f.rule, f.path]), [["O5", "/staged/1"], ["O5", "/staged/2"]]);
  });

  test("R14: every effect's tool must be staged", () => {
    assert.deepEqual(validateReport(report({ effects: [effect()] }), staged()), []);
    const findings = validateReport(report({ effects: [effect(), effect({ ref: "filings/search#5", tool: "filings/search" })] }), staged());
    assert.deepEqual(findings.map((f) => [f.rule, f.path]), [["R14", "/effects/1/tool"]]);
    assert.deepEqual(rules(validateReport(report({ effects: [effect()] }), order())), ["R14"]);
  });

  test("R15: effect refs name their tool and call number, and appear once", () => {
    const check = (...effects: ReturnType<typeof effect>[]) => validateReport(report({ effects }), staged()).map((f) => [f.rule, f.path]);
    assert.deepEqual(check(effect(), effect({ ref: "gmail/send#7" })), []);
    assert.deepEqual(check(effect({ ref: "gmail/draft#4" })), [["R15", "/effects/0/ref"]]);
    assert.deepEqual(check(effect({ ref: "pending:gmail/send#4" })), [["R15", "/effects/0/ref"]]);
    assert.deepEqual(check(effect({ ref: "gmail/send#04" })), [["R15", "/effects/0/ref"]]);
    assert.deepEqual(check(effect(), effect()), [["R15", "/effects/1/ref"]]);
  });

  test("C5: a sub-order may not allow a tool its parent stages", () => {
    const parent = staged({ staged: ["gmail/send"] });
    const child = (tools: string[]) => validateChildOrder(order({ tools }), parent).map((f) => [f.rule, f.path]);
    assert.deepEqual(child(["filings/*", "gmail/draft"]), []);
    assert.deepEqual(child(["gmail/send"]), [["C5", "/tools/0"]]);
    assert.deepEqual(child(["filings/*", "gmail/*"]), [["C5", "/tools/1"]]);
    assert.deepEqual(validateChildOrder(order({ tools: ["gmail/send"] }), staged({ tools: ["*"], staged: ["*"] })).map((f) => f.rule), ["C5"]);
  });

  test("the desk keeps staged and effects, and refuses a sub-order that breaks C5", async () => {
    const { desk } = newDesk();
    const id = await workingOrder(desk, { tools: ["filings/*", "gmail/*"], staged: ["gmail/send"] });
    assert.deepEqual((await desk.get(id)).order.staged, ["gmail/send"]);
    assert.equal((await desk.get(id)).order.spec, "awl/work-order@0.4");

    const e = await rejectsWith(desk.create(orderInput({ to: HELPER, parent_id: id, budget: { usd: 1, tool_calls: 5 }, tools: ["gmail/*"] }), WORKER), "VALIDATION_FAILED");
    assert.deepEqual(rules(e.findings), ["C5"]);
    await desk.create(orderInput({ to: HELPER, parent_id: id, budget: { usd: 1, tool_calls: 5 }, tools: ["gmail/draft"] }), WORKER);

    await rejectsWith(desk.create(orderInput({ staged: ["gmail/send"] }), MANAGER), "VALIDATION_FAILED");

    const { record } = await desk.submitReport(id, reportInput({ effects: [effect()] }), WORKER);
    assert.deepEqual(record.reports[0].effects, [effect()]);
    assert.equal(record.reports[0].spec, "awl/work-report@0.3");
  });

  test("documents get the lowest version that has every field they use", () => {
    const handoff = { next_step: "send it" };
    assert.deepEqual(
      [{}, { handoff }, { continues: "wo_1", handoff }, { staged: [], continues: "wo_1" }].map(orderSpecFor),
      ["awl/work-order@0.1", "awl/work-order@0.2", "awl/work-order@0.3", ORDER_SPEC],
    );
    assert.deepEqual([{}, { handoff }, { effects: [], handoff }].map(reportSpecFor), ["awl/work-report@0.1", "awl/work-report@0.2", REPORT_SPEC]);
  });

  test("a pass carries the staged tools, and a child pass may not allow them", async () => {
    const pair = (await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as webcrypto.CryptoKeyPair;
    const priv = (await webcrypto.subtle.exportKey("jwk", pair.privateKey)) as PassJwk;
    const pub = (await webcrypto.subtle.exportKey("jwk", pair.publicKey)) as PassJwk;
    const now = new Date("2026-01-01T10:00:00Z");
    const sign = (o = order()) => signPass(o, priv, { issuer: "desk", now });

    assert.equal("awl_staged" in decodePass(await sign()), false);
    const parent = await verifyPass(await sign(staged()), pub, { now });
    assert.deepEqual(parent.claims.awl_staged, ["gmail/send"]);

    const narrow = await sign(order({ id: "wo_2", parent_id: "wo_1", tools: ["gmail/draft"] }));
    await verifyPass(narrow, pub, { now, parent });
    const wide = await sign(order({ id: "wo_2", parent_id: "wo_1", tools: ["gmail/send"] }));
    await assert.rejects(verifyPass(wide, pub, { now, parent }), (e: { code: string; findings: { rule: string }[] }) => {
      assert.equal(e.code, "WIDER_THAN_PARENT");
      assert.deepEqual(rules(e.findings as never), ["C5"]);
      return true;
    });
  });

  test("effectReferences finds references to earlier effects anywhere in the arguments", () => {
    const args = { issue: { $ref: "github/create_issue#3", pointer: "/structuredContent/number" }, cc: [{ $ref: "a/b#1" }], "x/y": { $ref: "c/d#2", pointer: "" } };
    assert.deepEqual(effectReferences(args), [
      { ref: "github/create_issue#3", pointer: "/structuredContent/number", path: "/issue" },
      { ref: "a/b#1", pointer: "", path: "/cc/0" },
      { ref: "c/d#2", pointer: "", path: "/x~1y" },
    ]);
    // Not references: other members, or a $ref that is not a string.
    assert.deepEqual(effectReferences({ a: { $ref: "a/b#1", note: "x" }, b: { $ref: 3 } }), []);
  });

  test("R16: a reference names an effect listed earlier, with a JSON Pointer", () => {
    const order = staged({ staged: ["gmail/*"] });
    const first = effect({ ref: "gmail/draft#1", tool: "gmail/draft" });
    const ref = (target: string, pointer = "/structuredContent/id") => effect({ ref: "gmail/send#2", arguments: { draft: { $ref: target, pointer } } });
    const check = (...effects: ReturnType<typeof effect>[]) => validateReport(report({ effects }), order).map((f) => [f.rule, f.path]);
    assert.deepEqual(check(first, ref("gmail/draft#1")), []);
    assert.deepEqual(check(first, ref("gmail/draft#1", "")), []);
    assert.deepEqual(check(ref("gmail/draft#1"), first), [["R16", "/effects/0/arguments/draft"]]);
    assert.deepEqual(check(first, ref("gmail/send#2")), [["R16", "/effects/1/arguments/draft"]]);
    assert.deepEqual(check(first, ref("gmail/draft#1", "structuredContent")), [["R16", "/effects/1/arguments/draft"]]);
  });

  test("an approval may choose effects, keeping the ones they use", async () => {
    const { desk } = newDesk();
    const tools = { tools: ["filings/*", "gmail/*"], staged: ["gmail/*"] };
    const effects = [
      effect({ ref: "gmail/draft#1", tool: "gmail/draft" }),
      effect({ ref: "gmail/send#2", arguments: { draft: { $ref: "gmail/draft#1", pointer: "/structuredContent/id" } } }),
      effect({ ref: "gmail/send#3" }),
    ];
    const submitted = async () => {
      const id = await workingOrder(desk, tools);
      await desk.submitReport(id, reportInput({ effects }), WORKER);
      return id;
    };

    const id = await submitted();
    await rejectsWith(desk.review(id, MANAGER, "approve", undefined, { effects: ["gmail/send#9"] }), "BAD_REQUEST");
    const e = await rejectsWith(desk.review(id, MANAGER, "approve", undefined, { effects: ["gmail/send#2"] }), "BAD_REQUEST");
    assert.match(e.message, /uses the result of "gmail\/draft#1"/);
    await rejectsWith(desk.review(id, MANAGER, "rework", "No", { effects: [] }), "BAD_REQUEST");
    await rejectsWith(desk.review(id, HELPER, "approve", undefined, { effects: [] }), "FORBIDDEN");
    assert.equal((await desk.get(id)).state, "submitted");

    const done = await desk.review(id, MANAGER, "approve", "Only the drafted one", { effects: ["gmail/send#2", "gmail/draft#1"] });
    assert.equal(done.state, "approved");
    assert.deepEqual(done.events.at(-1)!.effects, ["gmail/draft#1", "gmail/send#2"]);

    const none = await desk.review(await submitted(), MANAGER, "approve", undefined, { effects: [] });
    assert.deepEqual(none.events.at(-1)!.effects, []);
    const all = await desk.review(await submitted(), MANAGER, "approve");
    assert.equal("effects" in all.events.at(-1)!, false);
  });

  test("after approval: the worker records and settles outcomes, the manager allows retries (§6.4)", async () => {
    const { desk } = newDesk();
    const effects = [effect({ ref: "gmail/send#1" }), effect({ ref: "gmail/send#2" }), effect({ ref: "gmail/send#3" })];
    const id = await workingOrder(desk, { tools: ["filings/*", "gmail/*"], staged: ["gmail/send"] });
    await desk.submitReport(id, reportInput({ effects }), WORKER);
    await rejectsWith(desk.recordCommit(id, WORKER, [{ ref: "gmail/send#1", outcome: "ok" }]), "INVALID_TRANSITION");
    await desk.review(id, MANAGER, "approve", undefined, { effects: ["gmail/send#1", "gmail/send#2"] });

    // Only the worker records what ran, only for approved effects, and never not_run.
    await rejectsWith(desk.recordCommit(id, MANAGER, [{ ref: "gmail/send#1", outcome: "ok" }]), "FORBIDDEN");
    await rejectsWith(desk.recordCommit(id, WORKER, [{ ref: "gmail/send#3", outcome: "ok" }]), "BAD_REQUEST");
    await rejectsWith(desk.recordCommit(id, WORKER, [{ ref: "gmail/send#1", outcome: "not_run" }]), "BAD_REQUEST");
    await rejectsWith(desk.recordCommit(id, WORKER, []), "BAD_REQUEST");
    const ran = await desk.recordCommit(id, WORKER, [{ ref: "gmail/send#1", outcome: "unknown", note: "no answer" }, { ref: "gmail/send#2", outcome: "ok" }]);
    assert.equal(ran.state, "approved");
    assert.deepEqual(ran.events.at(-1)!.outcomes, [{ ref: "gmail/send#1", outcome: "unknown", note: "no answer" }, { ref: "gmail/send#2", outcome: "ok" }]);

    // Only an unknown outcome is settled, by the worker, with evidence.
    await rejectsWith(desk.settle(id, WORKER, "gmail/send#2", "not_run", "receiver has nothing"), "INVALID_TRANSITION");
    await rejectsWith(desk.settle(id, MANAGER, "gmail/send#1", "not_run", "receiver has nothing"), "FORBIDDEN");
    await rejectsWith(desk.settle(id, WORKER, "gmail/send#1", "unknown" as never, "x"), "BAD_REQUEST");
    await rejectsWith(desk.settle(id, WORKER, "gmail/send#1", "not_run", ""), "BAD_REQUEST");
    await rejectsWith(desk.allowRetry(id, MANAGER, ["gmail/send#1"]), "INVALID_TRANSITION");
    await desk.settle(id, WORKER, "gmail/send#1", "not_run", "receiver has nothing for awl/ref gmail/send#1");

    // Only the manager allows a retry, only of what never happened.
    await rejectsWith(desk.allowRetry(id, WORKER, ["gmail/send#1"]), "FORBIDDEN");
    await rejectsWith(desk.allowRetry(id, MANAGER, ["gmail/send#2"]), "INVALID_TRANSITION");
    await rejectsWith(desk.allowRetry(id, MANAGER, ["gmail/send#1", "gmail/send#1"]), "BAD_REQUEST");
    const allowed = await desk.allowRetry(id, MANAGER, ["gmail/send#1"], "nothing was sent");
    assert.deepEqual([allowed.events.at(-1)!.action, allowed.events.at(-1)!.effects, allowed.state], ["allow_retry", ["gmail/send#1"], "approved"]);
    assert.deepEqual(
      [...effectOutcomes(allowed)].map(([ref, o]) => [ref, o.outcome]),
      [["gmail/send#1", "not_run"], ["gmail/send#2", "ok"]],
    );
    assert.deepEqual(approvedEffects(allowed), ["gmail/send#1", "gmail/send#2"]);
  });
});
