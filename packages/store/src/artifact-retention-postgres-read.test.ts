import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  setImmediate as turn,
  setTimeout as delay,
} from "node:timers/promises";
import test from "node:test";
import { Pool, type PoolClient } from "pg";
import { readPostgresArtifactEvidence } from "./artifact-retention-postgres-read.ts";
import { BoundedPostgresPool } from "./bounded-postgres-pool.ts";
import { postgresResponseGate } from "./bounded-postgres-pool.test-support.ts";

const connectionString = process.env.CREWON_TEST_POSTGRES_URL;
const live = { skip: connectionString === undefined, timeout: 10_000 };

test("late authority checkout releases once without starting a transaction after cancellation", async () => {
  let resolveCheckout!: (client: PoolClient) => void;
  const checkout = new Promise<PoolClient>((resolve) => {
    resolveCheckout = resolve;
  });
  let queries = 0,
    releases = 0;
  const client = {
    query: async () => {
      queries++;
    },
    release: (destroy: boolean) => {
      assert.equal(destroy, false);
      releases++;
    },
  } as unknown as PoolClient;
  const pool = { connect: () => checkout } as unknown as Pool;
  const controller = new AbortController();
  const read = readPostgresArtifactEvidence({
    pool,
    text: "SELECT 1",
    values: [],
    options: { signal: controller.signal, maxDurationMs: 1000 },
  });
  const rejected = assert.rejects(read, /stopped/);
  controller.abort(new Error("stopped"));
  await turn();
  assert.equal(releases, 0);
  resolveCheckout(client);
  await rejected;
  assert.equal(queries, 0);
  assert.equal(releases, 1);
});

test("failed rollback destroys the borrowed client exactly once and preserves the original read error", async () => {
  const readError = new Error("read_failed");
  let releases = 0;
  const commands: string[] = [];
  const client = {
    query: async (text: string) => {
      commands.push(text);
      if (text === "SELECT evidence") throw readError;
      if (text === "ROLLBACK") throw new Error("rollback_failed");
      return { rows: [] };
    },
    release: (destroy: boolean) => {
      assert(destroy);
      releases++;
    },
  } as unknown as PoolClient;
  const pool = { connect: async () => client } as unknown as Pool;
  await assert.rejects(
    readPostgresArtifactEvidence({
      pool,
      text: "SELECT evidence",
      values: [],
      options: { signal: new AbortController().signal, maxDurationMs: 1000 },
    }),
    (error) => error === readError,
  );
  assert.equal(commands.at(-1), "ROLLBACK");
  assert.equal(
    commands.length,
    3,
    "setup, read and rollback use three serial round trips",
  );
  assert.equal(releases, 1);
});

test(
  "actual PostgreSQL stops a canceled maintenance query at its server budget before returning its connection",
  live,
  async (t) => {
    const name = `artifact_read_${randomUUID()}`;
    const pool = new Pool({
      connectionString,
      max: 1,
      application_name: name,
      statement_timeout: 3000,
    });
    const admin = new Pool({ connectionString, max: 1 });
    t.after(async () => {
      await pool.end();
      await admin.end();
    });
    const controller = new AbortController();
    const started = performance.now();
    const work = readPostgresArtifactEvidence({
      pool,
      text: "SELECT pg_sleep(10)",
      values: [],
      options: { signal: controller.signal, maxDurationMs: 400 },
    });
    let settled = false;
    const rejected = assert.rejects(work, { code: "57014" }).finally(() => {
      settled = true;
    });
    let active = false;
    for (let n = 0; n < 100; n++) {
      const result = await admin.query(
        "SELECT state FROM pg_stat_activity WHERE application_name=$1 AND query='SELECT pg_sleep(10)'",
        [name],
      );
      if (result.rows[0]?.state === "active") {
        active = true;
        break;
      }
      await delay(2);
    }
    assert(
      active,
      "the real server must be executing the maintenance statement before abort",
    );
    controller.abort();
    await turn();
    assert.equal(settled, false);
    assert.equal(pool.idleCount, 0);
    assert.equal(pool.totalCount, 1);
    await rejected;
    assert(performance.now() - started < 2000);
    assert.equal(pool.idleCount, 1);
    const restored = await pool.query(
      "SELECT current_setting('statement_timeout') AS timeout, current_setting('transaction_read_only') AS readonly",
    );
    assert.deepEqual(restored.rows, [{ timeout: "3s", readonly: "off" }]);
    const backend = await admin.query(
      "SELECT state FROM pg_stat_activity WHERE application_name=$1",
      [name],
    );
    assert.equal(backend.rows[0]?.state, "idle");
  },
);

test(
  "maintenance honors a shorter PostgreSQL timeout and successful reads restore caller-owned session settings",
  live,
  async (t) => {
    const pool = new Pool({ connectionString, max: 1, statement_timeout: 50 });
    t.after(() => pool.end());
    const read = (text: string) =>
      readPostgresArtifactEvidence({
        pool,
        text,
        values: [],
        options: { signal: new AbortController().signal, maxDurationMs: 1000 },
      });
    const result = await read(
      "SELECT 42 AS evidence, current_setting('transaction_read_only') AS readonly",
    );
    assert.deepEqual(result.rows, [{ evidence: 42, readonly: "on" }]);
    const start = performance.now();
    await assert.rejects(read("SELECT pg_sleep(10)"), { code: "57014" });
    assert(performance.now() - start < 700);
    assert.deepEqual((await pool.query("SHOW statement_timeout")).rows, [
      { statement_timeout: "50ms" },
    ]);
  },
);

test(
  "dropped PostgreSQL responses retain the read until the owned transport deadline and discard the unusable client",
  live,
  async (t) => {
    const gate = await postgresResponseGate(t, connectionString!);
    const pool = new BoundedPostgresPool(
      {
        connectionString: gate.connectionString,
        max: 1,
        statement_timeout: 1000,
      },
      { queryTimeoutMs: 180, closeTimeoutMs: 500 },
    );
    t.after(() => pool.end());
    await pool.query("SELECT 1");
    gate.block(true);
    const start = performance.now();
    await assert.rejects(
      readPostgresArtifactEvidence({
        pool,
        text: "SELECT 1",
        values: [],
        options: { signal: new AbortController().signal, maxDurationMs: 80 },
      }),
      { code: "postgres_query_deadline_exceeded" },
    );
    assert(performance.now() - start < 1500);
    assert.equal(pool.totalCount, 0);
    assert.equal(pool.waitingCount, 0);
    gate.block(false);
    assert.equal((await pool.query("SELECT 42 AS value")).rows[0].value, 42);
  },
);
