import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool, type PoolClient } from "pg";
import { RunStoreBusyError, RunStoreError } from "@crewon/application";
import { PostgresCompactionCheckpointStore } from "./postgres-compaction-checkpoint-store.ts";
import { PostgresRunExecutionProgressStore } from "./postgres-run-execution-progress-store.ts";

const options = {
  skip: !process.env.CREWON_TEST_POSTGRES_URL,
  timeout: 10_000,
};
type Kind = "progress" | "compaction";
function reader(
  kind: Kind,
  pool: Pool,
  scope: { tenantId: string; runId: string },
  guard: (client: PoolClient) => Promise<void>,
  operation: "load" | "save" = "load",
) {
  const lease = {
    workItemId: "work",
    ownerId: "owner",
    leaseId: "lease",
    leaseEpoch: 1,
  };
  if (kind === "progress") {
    const store = new PostgresRunExecutionProgressStore(
      pool,
      '"fixture"',
      guard,
    );
    return () =>
      operation === "load"
        ? store.load({ scope, lease })
        : store.save({
            scope,
            lease,
            expectedThroughSequence: 0,
            checkpoint: {
              throughSequence: 1,
              sourceEventId: "source",
              payload: "saved",
            },
          });
  }
  const store = new PostgresCompactionCheckpointStore(pool, '"fixture"', guard);
  const input = {
    scope: { ...scope, stepId: "compaction:work:1", attemptId: "attempt" },
    lease,
    contextDigest: "a".repeat(64),
  };
  return () =>
    operation === "load"
      ? store.load(input)
      : store.save({ ...input, expectedRevision: 0, payload: "saved" });
}

for (const kind of ["progress", "compaction"] as const) {
  test(
    `${kind}: checkpoint writes keep their failure semantics when the same lock is held`,
    options,
    async (t) => {
      const pool = new Pool({
        connectionString: process.env.CREWON_TEST_POSTGRES_URL,
        max: 2,
      });
      const blocker = await pool.connect();
      t.after(async () => {
        try {
          await blocker.query("ROLLBACK");
        } finally {
          blocker.release();
          await pool.end();
        }
      });
      const scope = { tenantId: randomUUID(), runId: "run" };
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`run:${scope.tenantId}:${scope.runId}`],
      );
      let guards = 0;
      const save = reader(
        kind,
        pool,
        scope,
        async () => {
          guards++;
        },
        "save",
      );
      await assert.rejects(
        save(),
        (error: unknown) =>
          error instanceof RunStoreError &&
          !(error instanceof RunStoreBusyError) &&
          error.code === "postgres_error",
      );
      assert.equal(guards, 0);
      assert.equal(pool.idleCount, 1);
    },
  );
  test(
    `${kind}: real lock timeout rolls back before yielding and cannot enter the authority guard`,
    options,
    async (t) => {
      const pool = new Pool({
        connectionString: process.env.CREWON_TEST_POSTGRES_URL,
        max: 2,
      });
      const blocker = await pool.connect();
      t.after(async () => {
        try {
          await blocker.query("ROLLBACK");
        } finally {
          blocker.release();
          await pool.end();
        }
      });
      const scope = { tenantId: randomUUID(), runId: "run" };
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`run:${scope.tenantId}:${scope.runId}`],
      );
      let guards = 0;
      const load = reader(kind, pool, scope, async () => {
        guards++;
        throw new RunStoreError("fixture_authority_guard");
      });
      await assert.rejects(
        load(),
        (error: unknown) =>
          error instanceof RunStoreBusyError &&
          error.retryAfterMs === 250 &&
          (error.cause as { code: string }).code === "55P03",
      );
      assert.equal(guards, 0);
      assert.equal(pool.idleCount, 1);
      await blocker.query("ROLLBACK");
      await assert.rejects(load(), { code: "fixture_authority_guard" });
      assert.equal(guards, 1);
      assert.equal(pool.idleCount, 1);
    },
  );

  test(
    `${kind}: a later lock error is not misreported as a known pre-action deferral`,
    options,
    async (t) => {
      const pool = new Pool({
        connectionString: process.env.CREWON_TEST_POSTGRES_URL,
        max: 1,
      });
      t.after(() => pool.end());
      const source = Object.assign(new Error("later_action_error"), {
        code: "55P03",
      });
      const load = reader(
        kind,
        pool,
        { tenantId: randomUUID(), runId: "run" },
        async () => {
          throw source;
        },
      );
      await assert.rejects(
        load(),
        (error: unknown) =>
          error instanceof RunStoreError &&
          !(error instanceof RunStoreBusyError) &&
          error.code === "postgres_error" &&
          error.cause === source,
      );
      assert.equal(pool.idleCount, 1);
    },
  );

  test(
    `${kind}: an unconfirmed rollback destroys the client and cannot report a safe deferral`,
    options,
    async (t) => {
      const pool = new Pool({
        connectionString: process.env.CREWON_TEST_POSTGRES_URL,
        max: 1,
      });
      t.after(() => pool.end());
      const client = await pool.connect();
      t.mock.method(pool, "connect", async () => client);
      const original = client.query;
      t.mock.method(
        client,
        "query",
        async (sql: string, ...args: unknown[]) => {
          if (sql.includes("pg_advisory_xact_lock"))
            throw Object.assign(new Error("fixture_contention"), {
              code: "55P03",
            });
          const result: unknown = await Reflect.apply(original, client, [
            sql,
            ...args,
          ]);
          if (sql === "ROLLBACK") throw new Error("fixture_rollback_ack_lost");
          return result;
        },
      );
      let guards = 0;
      const load = reader(
        kind,
        pool,
        { tenantId: randomUUID(), runId: "run" },
        async () => {
          guards++;
        },
      );
      await assert.rejects(load(), {
        code: "postgres_checkpoint_rollback_failed",
      });
      assert.equal(guards, 0);
      assert.equal(pool.totalCount, 0);
    },
  );
}
