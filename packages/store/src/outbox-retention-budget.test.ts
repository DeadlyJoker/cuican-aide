import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { Client, Pool } from "pg";
import { SqliteRunStore } from "./sqlite-run-store.ts";
import { InMemoryRunStore } from "./in-memory-run-store.ts";
import { PostgresQueueStore } from "./postgres-queue-store.ts";
import { pruneSqliteDeliveredOutbox } from "./sqlite-outbox-retention.ts";
import {
  createRunningCommitFixture,
  ManualLeaseClock,
} from "./run-store-conformance.test-support.ts";
import { seedThread } from "./thread-store-conformance.test-support.ts";

const policy = {
  retentionMs: 1_000,
  minimumIntervalMs: 1_000,
  maxBatchSize: 2,
};
const deferred = { disposition: "deferred", deletedMessages: 0 } as const;
const connectionString = process.env.CREWON_TEST_POSTGRES_URL;

async function sqlite(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "crewon-outbox-budget-"));
  const path = join(directory, "store.sqlite");
  const clock = new ManualLeaseClock();
  const store = new SqliteRunStore(path, { clock });
  const db = new DatabaseSync(path);
  t.after(async () => {
    db.close();
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await seedThread(store);
  const original = createRunningCommitFixture();
  const input = {
    ...original,
    outbox: [0, 1].map((i) => ({
      ...original.outbox[0]!,
      messageId: `budget-${i}`,
    })),
  };
  const receipt = await store.commitRun(input);
  db.exec("UPDATE outbox SET status='delivered', delivered_at_ms=0");
  return { store, db, input, receipt };
}

for (const kind of ["SQLite", "InMemory"] as const) {
  test(`${kind} public retention entry rejects invalid duration and defers pre-canceled work`, async (t) => {
    const store =
      kind === "SQLite" ? (await sqlite(t)).store : new InMemoryRunStore();
    if (kind === "InMemory") t.after(() => store.close());
    for (const maxDurationMs of [0, NaN, 5001])
      await assert.rejects(
        store.outboxRetention.pruneDeliveredOutbox(policy, { maxDurationMs }),
        /outbox_retention_options_invalid/,
      );
    const abort = new AbortController();
    abort.abort();
    assert.deepEqual(
      await store.outboxRetention.pruneDeliveredOutbox(policy, {
        signal: abort.signal,
      }),
      deferred,
    );
  });
}

for (const interruption of ["abort", "deadline"] as const) {
  test(`SQLite ${interruption} between deletes rolls back data and maintenance cadence, preserving exact replay`, async (t) => {
    const { db, store, input, receipt } = await sqlite(t);
    const abort = new AbortController();
    let now = 0;
    const time = t.mock.method(performance, "now", () => now);
    db.function("interrupt_retention", () => {
      if (interruption === "abort") abort.abort();
      else now = 101;
      return 1;
    });
    db.exec(
      "CREATE TRIGGER interrupt_retention AFTER DELETE ON outbox BEGIN SELECT interrupt_retention(); END",
    );
    assert.deepEqual(
      pruneSqliteDeliveredOutbox(db, policy, 10_000, {
        signal: abort.signal,
        maxDurationMs: 100,
      }),
      deferred,
    );
    time.mock.restore();
    assert.equal(db.prepare("SELECT count(*) n FROM outbox").get()!.n, 2);
    assert.equal(
      db.prepare("SELECT next_due_ms n FROM outbox_maintenance").get()!.n,
      0,
    );
    assert.deepEqual(await store.commitRun(input), {
      ...receipt,
      disposition: "replayed",
    });
    db.exec("DROP TRIGGER interrupt_retention");
    assert.deepEqual(pruneSqliteDeliveredOutbox(db, policy, 10_000), {
      disposition: "pruned",
      deletedMessages: 2,
    });
    assert.deepEqual(await store.commitRun(input), {
      ...receipt,
      disposition: "replayed",
    });
  });
}

async function postgres(t: TestContext, max = 2) {
  assert(connectionString);
  const schema = `outbox_budget_${randomUUID().replaceAll("-", "")}`;
  const quoted = `"${schema}"`;
  const pool = new Pool({ connectionString, max });
  const admin = new Pool({ connectionString, max: 1 });
  const store = new PostgresQueueStore({ pool, schema });
  t.after(async () => {
    await store.close();
    await pool.end();
    try {
      await admin.query(`DROP SCHEMA ${quoted} CASCADE`);
    } finally {
      await admin.end();
    }
  });
  await store.migrate();
  for (const id of ["budget-0", "budget-1"]) {
    const message = {
      messageId: id,
      tenantId: "tenant",
      runId: "run",
      topic: "run.changed",
      payload: {},
      createdAt: "2020-01-01T00:00:00Z",
    };
    await admin.query(
      `INSERT INTO ${quoted}.outbox(message_id,tenant_id,run_id,topic,message_json,created_at,available_at,status,delivered_at)
      VALUES ($1,'tenant','run','run.changed',$2,'2020-01-01','2020-01-01','delivered','2020-01-01')`,
      [id, message],
    );
  }
  return { store, pool, admin, quoted };
}

test(
  "PostgreSQL cancellation during a real delete rolls back before COMMIT and returns the connection",
  { skip: !connectionString },
  async (t) => {
    const { store, pool, admin, quoted } = await postgres(t);
    const abort = new AbortController();
    const query = Client.prototype.query;
    let deleted = false;
    t.mock.method(Client.prototype, "query", function (
      this: Client,
      ...args: unknown[]
    ) {
      const value = Reflect.apply(query, this, args);
      if (
        typeof args[0] === "string" &&
        args[0].startsWith(`DELETE FROM ${quoted}.outbox AS original`)
      )
        return Promise.resolve(value).then((result) => {
          deleted = true;
          abort.abort();
          return result;
        });
      return value;
    } as typeof query);
    assert.deepEqual(
      await store.outboxRetention.pruneDeliveredOutbox(policy, {
        signal: abort.signal,
      }),
      deferred,
    );
    assert(deleted);
    assert.equal(
      (await admin.query(`SELECT count(*) n FROM ${quoted}.outbox`)).rows[0].n,
      "2",
    );
    assert.equal(pool.waitingCount, 0);
    assert.equal(pool.idleCount, 1);
    assert.deepEqual(await store.outboxRetention.pruneDeliveredOutbox(policy), {
      disposition: "pruned",
      deletedMessages: 2,
    });
  },
);

test(
  "PostgreSQL late checkout after cancellation starts no transaction and releases its client",
  { skip: !connectionString },
  async (t) => {
    const { store, pool } = await postgres(t, 1);
    const held = await pool.connect();
    let begins = 0;
    const query = held.query;
    t.mock.method(held, "query", function (
      this: typeof held,
      ...args: unknown[]
    ) {
      if (args[0] === "BEGIN") begins++;
      return Reflect.apply(query, this, args);
    } as typeof query);
    const abort = new AbortController();
    const pending = store.outboxRetention.pruneDeliveredOutbox(policy, {
      signal: abort.signal,
    });
    assert.equal(pool.waitingCount, 1);
    abort.abort();
    held.release();
    assert.deepEqual(await pending, deferred);
    assert.equal(begins, 0);
    assert.equal(pool.waitingCount, 0);
    assert.equal(pool.idleCount, 1);
  },
);

test(
  "PostgreSQL failed rollback discards the client instead of reusing an uncertain transaction",
  { skip: !connectionString },
  async (t) => {
    const { store, pool, quoted } = await postgres(t, 1);
    const query = Client.prototype.query;
    const abort = new AbortController();
    let rolledBack = false;
    t.mock.method(Client.prototype, "query", function (
      this: Client,
      ...args: unknown[]
    ) {
      const result = Reflect.apply(query, this, args);
      if (
        typeof args[0] === "string" &&
        args[0].startsWith(`DELETE FROM ${quoted}.outbox AS original`)
      )
        return Promise.resolve(result).then((value) => {
          abort.abort();
          return value;
        });
      if (args[0] === "ROLLBACK")
        return Promise.resolve(result).then(() => {
          rolledBack = true;
          throw new Error("rollback transport failed");
        });
      return result;
    } as typeof query);
    assert.deepEqual(
      await store.outboxRetention.pruneDeliveredOutbox(policy, {
        signal: abort.signal,
      }),
      deferred,
    );
    assert(rolledBack);
    assert.equal(pool.totalCount, 0);
    assert.equal(pool.waitingCount, 0);
  },
);
