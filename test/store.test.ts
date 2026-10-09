import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { FileStore, MemoryStore, WorkDesk } from "../src/index.ts";
import type { DeskStore, OrderRecord } from "../src/index.ts";
import { MANAGER, WORKER, order, orderInput, rejectsWith, tempDir } from "./helpers.ts";

const record = (id = "wo_1"): OrderRecord => ({
  order: order({ id }),
  state: "offered",
  reports: [],
  events: [{ seq: 1, at: "2026-01-01T09:00:00Z", actor: MANAGER, action: "create", from: null, to: "offered" }],
  findings: [],
});

const advanced = (r: OrderRecord): OrderRecord => ({
  ...r,
  state: "accepted",
  events: [...r.events, { seq: 2, at: "2026-01-01T09:01:00Z", actor: WORKER, action: "accept", from: "offered", to: "accepted" }],
});

// Every DeskStore must pass the same contract.
const stores: [string, () => DeskStore][] = [
  ["MemoryStore", () => new MemoryStore()],
  ["FileStore", () => new FileStore(tempDir())],
];

for (const [name, make] of stores) {
  describe(`${name} contract`, () => {
    test("reads back what was inserted", async () => {
      const store = make();
      await store.insert(record());
      assert.deepEqual(await store.read("wo_1"), record());
    });

    test("returns null for an unknown id", async () => {
      assert.equal(await make().read("missing"), null);
    });

    test("refuses a duplicate insert", async () => {
      const store = make();
      await store.insert(record());
      await rejectsWith(store.insert(record()), "ALREADY_EXISTS");
    });

    test("updates when the expected seq matches", async () => {
      const store = make();
      await store.insert(record());
      await store.update(advanced(record()), 1);
      assert.equal((await store.read("wo_1"))!.state, "accepted");
    });

    test("refuses an update from a stale read", async () => {
      const store = make();
      await store.insert(record());
      await store.update(advanced(record()), 1);
      await rejectsWith(store.update(advanced(record()), 1), "CONFLICT");
    });

    test("refuses to update a missing record", async () => {
      await rejectsWith(make().update(record(), 1), "NOT_FOUND");
    });

    test("lists every record", async () => {
      const store = make();
      await store.insert(record("wo_a"));
      await store.insert(record("wo_b"));
      assert.deepEqual((await store.list()).map((r) => r.order.id).sort(), ["wo_a", "wo_b"]);
    });

    test("lists nothing when empty", async () => {
      assert.deepEqual(await make().list(), []);
    });

    test("isolates stored data from caller mutations", async () => {
      const store = make();
      const r = record();
      await store.insert(r);
      r.state = "approved";
      const read = (await store.read("wo_1"))!;
      read.state = "cancelled";
      assert.equal((await store.read("wo_1"))!.state, "offered");
    });
  });
}

describe("FileStore", () => {
  for (const id of ["../escape", "a/b", "", "x".repeat(129), "white space"]) {
    test(`refuses unsafe id ${JSON.stringify(id.slice(0, 20))}`, async () => {
      await rejectsWith(new FileStore(tempDir()).read(id), "BAD_REQUEST");
    });
  }

  test("two stores on one folder share orders", async () => {
    const dir = tempDir();
    const manager = new WorkDesk({ store: new FileStore(dir) });
    const worker = new WorkDesk({ store: new FileStore(dir) });
    const { order } = await manager.create(orderInput({ deadline: "2999-01-01T00:00:00Z" }), MANAGER);
    await worker.accept(order.id, WORKER);
    assert.equal((await manager.get(order.id)).state, "accepted");
  });

  test("leaves no temporary files behind", async () => {
    const dir = tempDir();
    const store = new FileStore(dir);
    await store.insert(record());
    await store.update(advanced(record()), 1);
    assert.deepEqual(readdirSync(join(dir, "orders")), ["wo_1.json"]);
  });

  test("ignores files that are not orders", async () => {
    const dir = tempDir();
    const store = new FileStore(dir);
    await store.insert(record());
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dir, "orders", "notes.txt"), "hello");
    assert.equal((await store.list()).length, 1);
  });
});
