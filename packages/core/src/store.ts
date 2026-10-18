// Storage for desks. Implement DeskStore to back a desk with a database.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { AwlError } from "./errors.ts";
import type { OrderRecord } from "./types.ts";
import type { DatabaseSync } from "node:sqlite";

export interface DeskStore {
  /** Returns the record, or null when there is none. */
  read(id: string): Promise<OrderRecord | null>;
  /** Stores a new record. Throws ALREADY_EXISTS if the id is taken. */
  insert(record: OrderRecord): Promise<void>;
  /**
   * Replaces a record. `expectedSeq` is the last event seq the caller read; the store
   * throws CONFLICT if the stored record has moved on since (optimistic concurrency).
   */
  update(record: OrderRecord, expectedSeq: number): Promise<void>;
  /** Every stored record. */
  list(): Promise<OrderRecord[]>;
}

const lastSeq = (r: OrderRecord) => r.events.at(-1)?.seq ?? 0;
const clone = <T>(value: T): T => structuredClone(value);

/** Keeps records in memory. Useful for tests and single-process apps. */
export class MemoryStore implements DeskStore {
  #records = new Map<string, OrderRecord>();

  async read(id: string) {
    const r = this.#records.get(id);
    return r ? clone(r) : null;
  }

  async insert(record: OrderRecord) {
    if (this.#records.has(record.order.id)) throw new AwlError("ALREADY_EXISTS", `order "${record.order.id}" already exists`);
    this.#records.set(record.order.id, clone(record));
  }

  async update(record: OrderRecord, expectedSeq: number) {
    const current = this.#records.get(record.order.id);
    if (!current) throw new AwlError("NOT_FOUND", `no order "${record.order.id}"`);
    if (lastSeq(current) !== expectedSeq) throw new AwlError("CONFLICT", `order "${record.order.id}" changed since it was read`);
    this.#records.set(record.order.id, clone(record));
  }

  async list() {
    return [...this.#records.values()].map(clone);
  }
}

const SAFE_ID = /^[A-Za-z0-9_.-]{1,128}$/;

/**
 * One JSON file per order in `<dir>/orders`. Several processes may share a folder.
 * Writes are atomic (write then rename). Within one process, writes to an order run one at a
 * time, so the CONFLICT check is exact; across processes it is best-effort.
 */
export class FileStore implements DeskStore {
  readonly dir: string;
  #ready: Promise<unknown>;
  /** Tail of each order's queue of pending writes. */
  #queues = new Map<string, Promise<unknown>>();

  constructor(dir: string) {
    this.dir = join(dir, "orders");
    this.#ready = mkdir(this.dir, { recursive: true });
  }

  #path(id: string) {
    if (!SAFE_ID.test(id)) throw new AwlError("BAD_REQUEST", `order id "${id}" may only use letters, digits, ".", "_" and "-"`);
    return join(this.dir, `${id}.json`);
  }

  async #write(record: OrderRecord) {
    const file = this.#path(record.order.id);
    const tmp = `${file}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(record, null, 2));
    await rename(tmp, file);
  }

  async read(id: string): Promise<OrderRecord | null> {
    await this.#ready;
    try {
      return JSON.parse(await readFile(this.#path(id), "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }

  /** Runs `fn` after every earlier write to order `id` in this process has finished. */
  async #serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.#queues.get(id) ?? Promise.resolve()).then(fn);
    const tail = run.catch(() => {});
    this.#queues.set(id, tail);
    try {
      return await run;
    } finally {
      if (this.#queues.get(id) === tail) this.#queues.delete(id);
    }
  }

  async insert(record: OrderRecord) {
    await this.#serial(record.order.id, async () => {
      if (await this.read(record.order.id)) throw new AwlError("ALREADY_EXISTS", `order "${record.order.id}" already exists`);
      await this.#write(record);
    });
  }

  async update(record: OrderRecord, expectedSeq: number) {
    await this.#serial(record.order.id, async () => {
      const current = await this.read(record.order.id);
      if (!current) throw new AwlError("NOT_FOUND", `no order "${record.order.id}"`);
      if (lastSeq(current) !== expectedSeq) throw new AwlError("CONFLICT", `order "${record.order.id}" changed since it was read`);
      await this.#write(record);
    });
  }

  async list() {
    await this.#ready;
    const files = (await readdir(this.dir)).filter((f) => f.endsWith(".json"));
    const records = await Promise.all(files.map((f) => this.read(f.slice(0, -5))));
    return records.filter((r): r is OrderRecord => r !== null);
  }
}

/**
 * One SQLite database, using Node's built-in `node:sqlite` (Node 22.13+). Pass a file path,
 * or ":memory:" for a throwaway database. Several processes may share a file; the CONFLICT
 * check is atomic (`UPDATE ... WHERE last_seq = ?`).
 */
export class SqliteStore implements DeskStore {
  readonly db: DatabaseSync;

  constructor(path = ":memory:") {
    // Loaded here so importing the package does not need node:sqlite.
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        last_seq INTEGER NOT NULL,
        record TEXT NOT NULL
      ) STRICT;
    `);
  }

  async read(id: string): Promise<OrderRecord | null> {
    const row = this.db.prepare("SELECT record FROM orders WHERE id = ?").get(id) as { record: string } | undefined;
    return row ? JSON.parse(row.record) : null;
  }

  async insert(record: OrderRecord) {
    const { changes } = this.db
      .prepare("INSERT INTO orders (id, last_seq, record) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING")
      .run(record.order.id, lastSeq(record), JSON.stringify(record));
    if (!changes) throw new AwlError("ALREADY_EXISTS", `order "${record.order.id}" already exists`);
  }

  async update(record: OrderRecord, expectedSeq: number) {
    const { changes } = this.db
      .prepare("UPDATE orders SET last_seq = ?, record = ? WHERE id = ? AND last_seq = ?")
      .run(lastSeq(record), JSON.stringify(record), record.order.id, expectedSeq);
    if (changes) return;
    if (!(await this.read(record.order.id))) throw new AwlError("NOT_FOUND", `no order "${record.order.id}"`);
    throw new AwlError("CONFLICT", `order "${record.order.id}" changed since it was read`);
  }

  async list() {
    const rows = this.db.prepare("SELECT record FROM orders ORDER BY id").all() as { record: string }[];
    return rows.map((r) => JSON.parse(r.record) as OrderRecord);
  }

  /** Closes the database. */
  close() {
    this.db.close();
  }
}
