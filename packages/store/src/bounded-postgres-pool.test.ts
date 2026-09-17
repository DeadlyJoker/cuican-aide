import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { Pool } from "pg";
import { RunStoreError } from "@crewon/application";
import { BoundedPostgresPool } from "./bounded-postgres-pool.ts";
import { createPostgresPool } from "./postgres-store-support.ts";
import { postgresResponseGate } from "./bounded-postgres-pool.test-support.ts";

const connectionString = process.env.CREWON_TEST_POSTGRES_URL;
const options = { skip: connectionString === undefined, timeout: 15_000 };
const code = (expected: string) => (error: unknown) =>
  error instanceof RunStoreError && error.code === expected;

test("owned pools have bounded admission and caller-owned pools preserve lifecycle ownership", async () => {
  const owned = createPostgresPool(
    {
      connectionString: "postgresql:///unused",
      maxPoolSize: 2,
      statementTimeoutMs: 1001,
    },
    "test",
  );
  assert.ok(owned.pool instanceof BoundedPostgresPool);
  assert.equal(owned.pool.resourceSnapshot().maximumPendingConnections, 32);
  assert.equal(owned.ownsPool, true);
  const borrowed = createPostgresPool({ pool: owned.pool }, "shared");
  assert.equal(borrowed.pool, owned.pool);
  assert.equal(borrowed.ownsPool, false);
  await owned.pool.end();
  for (const override of [
    { maximumClientQueries: 0 },
    { maximumPendingConnections: 201 },
    { queryTimeoutMs: Infinity },
    { closeTimeoutMs: 0 },
  ])
    assert.throws(
      () => new BoundedPostgresPool({}, override),
      code("postgres_resource_limits_invalid"),
    );
});

test(
  "20,000 acquisition attempts cannot enlarge a full queue and admitted requests still complete",
  options,
  async (context) => {
    const pool = new BoundedPostgresPool(
      { connectionString, max: 1, connectionTimeoutMillis: 5000 },
      { maximumPendingConnections: 2 },
    );
    context.after(() => pool.end());
    const held = await pool.connect();
    const pending = [
      pool.connect().then((client) => client.release()),
      pool.connect().then((client) => client.release()),
    ];
    assert.equal(pool.waitingCount, 2);
    for (let i = 0; i < 20_000; i++)
      await assert.rejects(
        pool.connect(),
        code("postgres_connection_capacity_exhausted"),
      );
    assert.equal(pool.totalCount, 1);
    assert.equal(pool.waitingCount, 2);
    assert.equal(pool.resourceSnapshot().pendingAcquisitions, 2);
    held.release();
    await Promise.all(pending);
    assert.equal(
      (await pool.query<{ value: number }>("SELECT 42 as value")).rows[0]
        ?.value,
      42,
    );
    assert.equal(pool.waitingCount, 0);
    assert.equal(pool.resourceSnapshot().pendingAcquisitions, 0);
  },
);

test(
  "waiting acquisition deadlines remove the physical pool waiter",
  options,
  async (context) => {
    const pool = new BoundedPostgresPool({
      connectionString,
      max: 1,
      connectionTimeoutMillis: 5_000,
    });
    context.after(() => pool.end());
    const held = await pool.connect();
    // Test the occupied pool's 30 ms waiter deadline independently of server startup/load.
    pool.options.connectionTimeoutMillis = 30;
    const waiting = pool.connect();
    assert.equal(pool.waitingCount, 1);
    await assert.rejects(waiting, /timeout/);
    assert.equal(pool.waitingCount, 0);
    assert.equal(pool.resourceSnapshot().pendingAcquisitions, 0);
    held.release();
    assert.equal((await pool.query("SELECT 1 as value")).rows[0]?.value, 1);
  },
);

test(
  "abandoned checkouts expire during normal operation and a late release cannot recycle a dead client",
  options,
  async (context) => {
    const pool = new BoundedPostgresPool(
      { connectionString, max: 1 },
      { checkoutTimeoutMs: 50 },
    );
    context.after(() => pool.end());
    const abandoned = await pool.connect();
    await delay(80);
    assert.equal(pool.resourceSnapshot().borrowedConnections, 0);
    assert.equal(
      pool.resourceSnapshot().lastFailureCode,
      "postgres_checkout_deadline_exceeded",
    );
    await assert.rejects(
      abandoned.query("SELECT 1"),
      code("postgres_connection_unavailable"),
    );
    abandoned.release();
    assert.equal((await pool.query("SELECT 42 as value")).rows[0]?.value, 42);
  },
);

test(
  "Promise, callback and array result modes retain their pg semantics",
  options,
  async (context) => {
    const pool = new BoundedPostgresPool({ connectionString, max: 1 });
    context.after(() => pool.end());
    assert.deepEqual(
      (await pool.query({ text: "SELECT $1::int as value", values: [3] })).rows,
      [{ value: 3 }],
    );
    await new Promise<void>((resolve, reject) =>
      pool.query("SELECT $1::int as value", [4], (error, result) => {
        if (error) {
          reject(error);
          return;
        }
        assert.deepEqual(result.rows, [{ value: 4 }]);
        resolve();
      }),
    );
    const client = await pool.connect();
    try {
      assert.deepEqual(
        (
          await client.query({
            text: "SELECT $1::int as value",
            values: [5],
            rowMode: "array",
          })
        ).rows,
        [[5]],
      );
      await new Promise<void>((resolve, reject) =>
        client.query("SELECT 6 as value", (error, result) => {
          if (error) {
            reject(error);
            return;
          }
          assert.equal(result.rows[0]?.value, 6);
          resolve();
        }),
      );
    } finally {
      client.release();
    }
    assert.equal(pool.resourceSnapshot().borrowedConnections, 0);
  },
);

test(
  "a held client has a bounded query queue and resumes after its database lock clears",
  options,
  async (context) => {
    const admin = new Pool({ connectionString, max: 1 });
    const blocker = await admin.connect();
    const key = Math.floor(Math.random() * 2_000_000_000);
    await blocker.query("SELECT pg_advisory_lock($1)", [key]);
    const pool = new BoundedPostgresPool(
      { connectionString, max: 1, statement_timeout: 5000 },
      { maximumClientQueries: 2, queryTimeoutMs: 6000 },
    );
    context.after(async () => {
      await pool.end();
      blocker.release();
      await admin.end();
    });
    const client = await pool.connect();
    const first = client.query("SELECT pg_advisory_lock($1)", [key]);
    const second = client.query("SELECT 2 as value");
    for (let i = 0; i < 1000; i++)
      await assert.rejects(
        client.query("SELECT 3"),
        code("postgres_query_capacity_exhausted"),
      );
    await blocker.query("SELECT pg_advisory_unlock($1)", [key]);
    await first;
    assert.equal((await second).rows[0]?.value, 2);
    await client.query("SELECT pg_advisory_unlock($1)", [key]);
    client.release();
  },
);

test(
  "lost write responses discard the old connection without assuming the transaction rolled back",
  options,
  async (context) => {
    const gate = await postgresResponseGate(context, connectionString!);
    const admin = new Pool({ connectionString, max: 1 });
    const table = `deadline_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE TABLE ${table} (value int primary key)`);
    const pool = new BoundedPostgresPool(
      {
        connectionString: gate.connectionString,
        max: 1,
        statement_timeout: 1000,
      },
      { queryTimeoutMs: 250, closeTimeoutMs: 100 },
    );
    context.after(async () => {
      await pool.end();
      await admin.query(`DROP TABLE ${table}`);
      await admin.end();
    });
    const before = (await pool.query("SELECT pg_backend_pid() as pid")).rows[0]!
      .pid;
    gate.block(true);
    await assert.rejects(
      pool.query(`INSERT INTO ${table} VALUES (1)`),
      code("postgres_query_deadline_exceeded"),
    );
    gate.block(false);
    assert.equal(
      (await admin.query(`SELECT count(*)::int as count FROM ${table}`)).rows[0]
        ?.count,
      1,
    );
    const after = (await pool.query("SELECT pg_backend_pid() as pid")).rows[0]!
      .pid;
    assert.notEqual(after, before);
    assert.equal(pool.resourceSnapshot().borrowedConnections, 0);
    assert.equal(pool.resourceSnapshot().pendingAcquisitions, 0);
    assert.ok(pool.resourceSnapshot().failures >= 1);
  },
);

test(
  "shutdown bounds active queries and abandoned checkouts, and repeated close shares one completion",
  options,
  async (context) => {
    const pool = new BoundedPostgresPool(
      {
        connectionString,
        max: 2,
        statement_timeout: 3000,
        connectionTimeoutMillis: 100,
      },
      { queryTimeoutMs: 4000, closeTimeoutMs: 50 },
    );
    const admin = new Pool({ connectionString, max: 1 });
    context.after(async () => {
      await pool.end();
      await admin.end();
    });
    const abandoned = await pool.connect();
    await abandoned.query("BEGIN");
    const active = await pool.connect();
    const pid = (await active.query("SELECT pg_backend_pid() AS pid")).rows[0]!
      .pid;
    const pending = active.query("SELECT pg_sleep(10)");
    const rejected = assert.rejects(pending);
    let observed = false;
    for (let attempt = 0; attempt < 100 && !observed; attempt++) {
      observed =
        (
          await admin.query(
            "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND state='active' AND query='SELECT pg_sleep(10)') AS active",
            [pid],
          )
        ).rows[0]?.active === true;
      if (!observed) await delay(5);
    }
    assert.equal(
      observed,
      true,
      "shutdown must interrupt an actually running PostgreSQL query",
    );
    const queued = assert.rejects(pool.connect());
    assert.equal(pool.waitingCount, 1);
    const closing = pool.end();
    for (let i = 0; i < 20_000; i++) assert.equal(pool.end(), closing);
    await closing;
    await rejected;
    await queued;
    abandoned.release(); // Late transaction cleanup after forced pool shutdown is safe.
    active.release();
    assert.equal(pool.totalCount, 0);
    assert.equal(pool.waitingCount, 0);
    assert.equal(pool.resourceSnapshot().borrowedConnections, 0);
    assert.equal(pool.resourceSnapshot().pendingAcquisitions, 0);
    await assert.rejects(pool.query("SELECT 1"), code("postgres_pool_closed"));
  },
);

test(
  "an idle backend failure is observed without crashing the host and a fresh connection remains usable",
  options,
  async (context) => {
    const pool = new BoundedPostgresPool({ connectionString, max: 1 });
    const admin = new Pool({ connectionString, max: 1 });
    context.after(async () => {
      await pool.end();
      await admin.end();
    });
    const pid = (await pool.query("SELECT pg_backend_pid() as pid")).rows[0]!
      .pid;
    const failure = new Promise<void>((resolve) =>
      pool.once("error", () => resolve()),
    );
    await admin.query("SELECT pg_terminate_backend($1)", [pid]);
    await failure;
    assert.ok(pool.resourceSnapshot().failures >= 1);
    assert.notEqual(
      (await pool.query("SELECT pg_backend_pid() as pid")).rows[0]?.pid,
      pid,
    );
  },
);
