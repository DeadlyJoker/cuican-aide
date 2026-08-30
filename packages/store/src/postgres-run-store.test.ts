import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { RunStoreError } from "@crewon/application";
import { Pool } from "pg";

import { PostgresRunStore } from "./postgres-run-store.ts";
import { registerRunApplicationConformance } from "./run-application-conformance.test-support.ts";
import {
  createRunningCommitFixture,
  registerRunStoreConformance,
} from "./run-store-conformance.test-support.ts";
import { seedThread } from "./thread-store-conformance.test-support.ts";
import {
  registerTurnStartStoreConformance,
  turnStartCommit,
} from "./turn-start-store-conformance.test-support.ts";
import {
  goalActivation,
  goalFixture,
  goalMutationInput,
  registerThreadGoalMutationStoreConformance,
} from "./thread-goal-mutation-store-conformance.test-support.ts";

const connectionString = process.env.CREWON_TEST_POSTGRES_URL;

if (connectionString === undefined) {
  test.skip("PostgresRunStore conformance requires CREWON_TEST_POSTGRES_URL", () => {});
} else {
  registerRunStoreConformance(
    "PostgresRunStore Run authority",
    () => createTestStore(connectionString),
    { databaseTimeQueue: true },
  );
  registerRunApplicationConformance(
    "RunApplicationService + PostgresRunStore",
    () => createTestStore(connectionString),
  );
  registerTurnStartStoreConformance("PostgresRunStore atomic Turn start", () =>
    createTestStore(connectionString),
  );
  registerThreadGoalMutationStoreConformance(
    "PostgresRunStore atomic Goal mutation",
    () => createTestStore(connectionString),
  );

  test("migrates a drained Run authority from v1 to the Goal accounting v2 gate", async () => {
    const schema = testSchema();
    const admin = new Pool({ connectionString, max: 1 });
    let initialized: TestPostgresRunStore | null = null;
    let migrated: TestPostgresRunStore | null = null;
    try {
      initialized = await createTestStore(connectionString, schema, false);
      await seedThread(initialized);
      const input = turnStartCommit();
      await initialized.commitTurnStart(input);
      const runId = input.run.events[0]!.identity.runId;
      const fresh = await runAuthoritySchemaState(admin, schema);
      assert.equal(fresh.version, 2);
      assert.equal(
        fresh.constraints.includes("run_snapshots_goal_accounting_v2_ck"),
        true,
      );
      await downgradeRunAuthorityToV1(admin, schema, runId, "missing");
      const before = await runAuthoritySchemaState(admin, schema);
      assert.equal(before.version, 1);
      assert.equal(
        before.constraints.includes("run_snapshots_goal_accounting_v2_ck"),
        false,
      );
      await initialized.close();
      initialized = null;

      migrated = await createTestStore(connectionString, schema, false);

      const after = await runAuthoritySchemaState(admin, schema);
      assert.equal(after.version, 2);
      assert.equal(
        after.constraints.includes("run_snapshots_goal_accounting_v2_ck"),
        true,
      );
      assert.deepEqual(after.tables, before.tables);
      assert.equal(
        (
          await migrated.loadRun({
            tenantId: input.tenantId,
            runId,
          })
        )?.goalAccounting,
        null,
      );
    } finally {
      await initialized?.close();
      await migrated?.close();
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });

  for (const accounting of ["missing", "null"] as const) {
    test(`rejects a v1 active Goal Run with ${accounting} accounting without partial migration`, async () => {
      const schema = testSchema();
      const admin = new Pool({ connectionString, max: 1 });
      let initialized: TestPostgresRunStore | null = null;
      try {
        initialized = await createTestStore(connectionString, schema, false);
        await seedThread(initialized);
        const goal = goalFixture();
        const committed = await initialized.commitThreadGoalMutation(
          goalMutationInput({
            idempotencyKey: `legacy-goal-accounting-${accounting}`,
            goal: { kind: "set", expectedRevision: null, goal },
            expectedActiveRun: null,
            continuation: goalActivation(goal, 1),
          }),
        );
        assert.ok(committed.continuation !== null);
        const runId = committed.continuation.runState.runId;
        await downgradeRunAuthorityToV1(admin, schema, runId, accounting);
        await downgradeThreadAuthorityToV2(admin, schema);
        const before = await runAuthoritySchemaState(admin, schema);
        assert.deepEqual(before.versions, [
          { component: "durable_queue", version: 1 },
          { component: "run_authority", version: 1 },
          { component: "thread_authority", version: 2 },
        ]);
        const beforeSnapshot = await legacyGoalAccountingSnapshot(
          admin,
          schema,
          runId,
        );
        await initialized.close();
        initialized = null;

        await assert.rejects(async () => {
          const unexpectedlyOpened = await PostgresRunStore.open({
            connectionString,
            schema,
            maxPoolSize: 2,
            statementTimeoutMs: 2_000,
          });
          await unexpectedlyOpened.close();
        }, hasStoreCode("legacy_goal_run_requires_drain"));

        assert.deepEqual(await runAuthoritySchemaState(admin, schema), before);
        assert.deepEqual(
          await legacyGoalAccountingSnapshot(admin, schema, runId),
          beforeSnapshot,
        );
      } finally {
        await initialized?.close();
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await admin.end();
      }
    });
  }

  test("rechecks the v1 Goal accounting gate under the final Run table lock", async () => {
    const schema = testSchema();
    const admin = new Pool({ connectionString, max: 1 });
    const lockPool = new Pool({ connectionString, max: 2 });
    const blocker = await lockPool.connect();
    const probe = await lockPool.connect();
    let initialized: TestPostgresRunStore | null = null;
    let blockerTransactionOpen = false;
    let openPromise: Promise<PostgresRunStore> | null = null;
    try {
      initialized = await createTestStore(connectionString, schema, false);
      await seedThread(initialized);
      const goal = goalFixture();
      const committed = await initialized.commitThreadGoalMutation(
        goalMutationInput({
          idempotencyKey: "legacy-goal-accounting-race",
          goal: { kind: "set", expectedRevision: null, goal },
          expectedActiveRun: null,
          continuation: goalActivation(goal, 1),
        }),
      );
      assert.ok(committed.continuation !== null);
      const runId = committed.continuation.runState.runId;
      await downgradeRunAuthorityToV1(admin, schema, runId, "keep");
      await downgradeThreadAuthorityToV2(admin, schema);
      const before = await runAuthoritySchemaState(admin, schema);
      await initialized.close();
      initialized = null;

      await blocker.query("BEGIN");
      blockerTransactionOpen = true;
      await blocker.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`crewon:${schema}:run-authority`],
      );
      const blockerPid = await postgresBackendPid(blocker);
      openPromise = PostgresRunStore.open({
        connectionString,
        schema,
        maxPoolSize: 2,
        statementTimeoutMs: 2_000,
      }).then(async (unexpectedlyOpened) => {
        await unexpectedlyOpened.close();
        return unexpectedlyOpened;
      });
      await waitForAdvisoryLockWaiter(probe, blockerPid);
      await writeLegacyGoalAccounting(admin, schema, runId, "missing");
      const racedSnapshot = await legacyGoalAccountingSnapshot(
        admin,
        schema,
        runId,
      );

      await blocker.query("ROLLBACK");
      blockerTransactionOpen = false;
      await assert.rejects(
        openPromise,
        hasStoreCode("legacy_goal_run_requires_drain"),
      );

      assert.deepEqual(await runAuthoritySchemaState(admin, schema), before);
      assert.deepEqual(
        await legacyGoalAccountingSnapshot(admin, schema, runId),
        racedSnapshot,
      );
    } finally {
      if (blockerTransactionOpen) {
        await blocker.query("ROLLBACK");
      }
      await openPromise?.catch(() => undefined);
      await initialized?.close();
      blocker.release();
      probe.release();
      await lockPool.end();
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });

  test("serializes one Run and queue handoff across independent pools", async () => {
    const schema = testSchema();
    const first = await createTestStore(connectionString, schema, false);
    const second = await createTestStore(connectionString, schema, true);
    try {
      await seedThread(first);
      const input = createRunningCommitFixture();
      const results = await Promise.all([
        first.commitRun(input),
        second.commitRun(input),
      ]);
      assert.deepEqual(results.map((result) => result.disposition).sort(), [
        "committed",
        "replayed",
      ]);
      assert.deepEqual(await first.listPendingOutbox(10), input.outbox);
      assert.deepEqual(await first.listPendingWorkItems(10), input.workItems);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  test("locks the expected Run before its leased Work Item during Goal mutation", async () => {
    const schema = testSchema();
    const store = await createTestStore(connectionString, schema);
    const lockPool = new Pool({ connectionString, max: 2 });
    const blocker = await lockPool.connect();
    const probe = await lockPool.connect();
    let blockerTransactionOpen = false;
    let mutationPromise: ReturnType<
      typeof store.commitThreadGoalMutation
    > | null = null;
    try {
      await seedThread(store);
      const currentGoal = goalFixture();
      await store.commitThreadGoalMutation(
        goalMutationInput({
          idempotencyKey: "lock-order-initial-goal",
          goal: { kind: "set", expectedRevision: null, goal: currentGoal },
          expectedActiveRun: null,
          continuation: goalActivation(currentGoal, 1),
        }),
      );
      const claim = await store.claimNextWorkItem({
        ownerId: "lock-order-worker",
        leaseId: "lock-order-lease",
        leaseDurationMs: 60_000,
      });
      assert.ok(claim !== null);
      const nextGoal = {
        ...currentGoal,
        revision: 2,
        objective: "question-1 revised while leased",
        updatedAt: "2026-08-08T00:00:03Z",
      };
      const mutation = goalMutationInput({
        idempotencyKey: "lock-order-goal-mutation",
        goal: { kind: "set", expectedRevision: 1, goal: nextGoal },
        expectedActiveRun: {
          runId: claim.workItem.runId,
          expectedRevision: 1,
        },
        cancellationRunId: claim.workItem.runId,
        cancellationSequence: 2,
        continuation: goalActivation(nextGoal, 2),
      });

      await blocker.query("BEGIN");
      blockerTransactionOpen = true;
      await blocker.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`run:${mutation.tenantId}:${claim.workItem.runId}`],
      );
      mutationPromise = store.commitThreadGoalMutation(mutation);
      await waitForAdvisoryLockHeld(
        probe,
        `idempotency:${mutation.idempotency.scope}:${mutation.idempotency.key}`,
      );

      const workItem = await blocker.query(
        `SELECT work_item_id
         FROM "${schema}".work_items
         WHERE work_item_id=$1
         FOR UPDATE NOWAIT`,
        [claim.workItem.workItemId],
      );
      assert.equal(workItem.rowCount, 1);

      await blocker.query("ROLLBACK");
      blockerTransactionOpen = false;
      assert.equal((await mutationPromise).disposition, "committed");
    } finally {
      if (blockerTransactionOpen) {
        await blocker.query("ROLLBACK");
      }
      await mutationPromise?.catch(() => undefined);
      blocker.release();
      probe.release();
      await lockPool.end();
      await store.close();
    }
  });

  test("replays Turn start before acquiring its proposed Run or Thread locks", async () => {
    const schema = testSchema();
    const store = await createTestStore(connectionString, schema);
    const lockPool = new Pool({ connectionString, max: 1 });
    const blocker = await lockPool.connect();
    let blockerTransactionOpen = false;
    try {
      await seedThread(store);
      const input = turnStartCommit({
        runId: `run-turn-lock-order-${schema}`,
      });
      const committed = await store.commitTurnStart(input);

      await blocker.query("BEGIN");
      blockerTransactionOpen = true;
      await blocker.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`run:${input.tenantId}:${input.run.events[0]!.identity.runId}`],
      );
      await blocker.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [
          `thread:${input.tenantId}:${input.thread.events[0]!.identity.threadId}`,
        ],
      );

      assert.deepEqual(await store.commitTurnStart(input), {
        ...committed,
        disposition: "replayed",
      });
    } finally {
      if (blockerTransactionOpen) {
        await blocker.query("ROLLBACK");
      }
      blocker.release();
      await lockPool.end();
      await store.close();
    }
  });

  test("waits on the proposed Run before acquiring the Turn start Thread lock", async () => {
    const schema = testSchema();
    const store = await createTestStore(connectionString, schema);
    const lockPool = new Pool({ connectionString, max: 2 });
    const blocker = await lockPool.connect();
    const probe = await lockPool.connect();
    let blockerTransactionOpen = false;
    let turnStartPromise: ReturnType<typeof store.commitTurnStart> | null =
      null;
    try {
      await seedThread(store);
      const input = turnStartCommit({
        runId: `run-turn-wait-order-${schema}`,
      });
      const runId = input.run.events[0]!.identity.runId;
      const threadId = input.thread.events[0]!.identity.threadId;

      await blocker.query("BEGIN");
      blockerTransactionOpen = true;
      await blocker.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`run:${input.tenantId}:${runId}`],
      );
      const blockerPid = await postgresBackendPid(blocker);
      turnStartPromise = store.commitTurnStart(input);
      const turnStartPid = await waitForAdvisoryLockWaiter(probe, blockerPid);

      assert.equal(
        await advisoryLockHeldByBackend(
          probe,
          turnStartPid,
          `thread:${input.tenantId}:${threadId}`,
        ),
        false,
      );

      await blocker.query("ROLLBACK");
      blockerTransactionOpen = false;
      assert.equal((await turnStartPromise).disposition, "committed");
    } finally {
      if (blockerTransactionOpen) {
        await blocker.query("ROLLBACK");
      }
      await turnStartPromise?.catch(() => undefined);
      blocker.release();
      probe.release();
      await lockPool.end();
      await store.close();
    }
  });

  test("checks the active Run fence without locking that existing Run after the Thread", async () => {
    const schema = testSchema();
    const store = await createTestStore(connectionString, schema);
    const lockPool = new Pool({ connectionString, max: 1 });
    const blocker = await lockPool.connect();
    let blockerTransactionOpen = false;
    try {
      await seedThread(store);
      const active = turnStartCommit();
      await store.commitTurnStart(active);
      const parallel = turnStartCommit({
        key: "turn-start-active-fence",
        fingerprint: "turn-start-active-fence-fingerprint",
        runId: "run-turn-active-fence",
        expectedThreadRevision: 2,
        threadEventSequence: 3,
        messageSequence: 2,
        historySequence: 2,
        occurredAt: "2026-08-08T00:00:03Z",
      });

      await blocker.query("BEGIN");
      blockerTransactionOpen = true;
      await blocker.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`run:${active.tenantId}:${active.run.events[0]!.identity.runId}`],
      );

      await assert.rejects(
        store.commitTurnStart(parallel),
        hasStoreCode("thread_active_run_conflict"),
      );
    } finally {
      if (blockerTransactionOpen) {
        await blocker.query("ROLLBACK");
      }
      blocker.release();
      await lockPool.end();
      await store.close();
    }
  });

  test("fails closed on corrupt Goal state in a mutation receipt", async () => {
    const store = await createTestStore(connectionString);
    try {
      const { input, result } = await committedGoalMutation(
        store,
        "corrupt-goal",
      );
      assert.ok(result.goalState !== null);
      await store.replaceThreadGoalMutationReceipt(input.idempotency, {
        ...result,
        goalState: { ...result.goalState, tokensUsed: -1 },
      });

      await assert.rejects(
        store.loadThreadGoalMutationReceipt({
          tenantId: input.tenantId,
          threadId: input.threadId,
          idempotency: input.idempotency,
        }),
        hasStoreCode("goal_mutation_receipt_invalid"),
      );
    } finally {
      await store.close();
    }
  });

  test("fails closed on cross-tenant continuation data in a mutation receipt", async () => {
    const store = await createTestStore(connectionString);
    try {
      const { input, result } = await committedGoalMutation(
        store,
        "corrupt-continuation",
      );
      assert.ok(result.continuation !== null);
      await store.replaceThreadGoalMutationReceipt(input.idempotency, {
        ...result,
        continuation: {
          ...result.continuation,
          outbox: result.continuation.outbox.map((message, index) =>
            index === 0 ? { ...message, tenantId: "tenant-other" } : message,
          ),
        },
      });

      await assert.rejects(
        store.loadThreadGoalMutationReceipt({
          tenantId: input.tenantId,
          threadId: input.threadId,
          idempotency: input.idempotency,
        }),
        hasStoreCode("goal_mutation_receipt_invalid"),
      );
    } finally {
      await store.close();
    }
  });
}

class TestPostgresRunStore extends PostgresRunStore {
  readonly #admin: Pool;
  readonly #schemaSql: string;
  readonly #dropSchema: boolean;
  #cleaned = false;

  constructor(url: string, schema: string, dropSchema: boolean) {
    super({
      connectionString: url,
      schema,
      maxPoolSize: 2,
      statementTimeoutMs: 2_000,
    });
    this.#admin = new Pool({ connectionString: url, max: 1 });
    this.#schemaSql = `"${schema}"`;
    this.#dropSchema = dropSchema;
  }

  override async close(): Promise<void> {
    if (this.#cleaned) return;
    this.#cleaned = true;
    await super.close();
    try {
      if (this.#dropSchema) {
        await this.#admin.query(
          `DROP SCHEMA IF EXISTS ${this.#schemaSql} CASCADE`,
        );
      }
    } finally {
      await this.#admin.end();
    }
  }

  async replaceThreadGoalMutationReceipt(
    idempotency: Readonly<{ scope: string; key: string }>,
    result: unknown,
  ): Promise<void> {
    const updated = await this.#admin.query(
      `UPDATE ${this.#schemaSql}.thread_idempotency_receipts
       SET result_json=$1::jsonb
       WHERE scope=$2 AND idempotency_key=$3`,
      [result, idempotency.scope, idempotency.key],
    );
    assert.equal(updated.rowCount, 1);
  }
}

async function createTestStore(
  url: string,
  schema = testSchema(),
  dropSchema = true,
): Promise<TestPostgresRunStore> {
  const store = new TestPostgresRunStore(url, schema, dropSchema);
  try {
    await store.migrate();
    return store;
  } catch (error) {
    await store.close();
    throw error;
  }
}

function testSchema(): string {
  return `crewon_run_${randomUUID().replaceAll("-", "_")}`;
}

async function committedGoalMutation(
  store: TestPostgresRunStore,
  idempotencyKey: string,
) {
  await seedThread(store);
  const goal = goalFixture();
  const input = goalMutationInput({
    idempotencyKey,
    goal: { kind: "set", expectedRevision: null, goal },
    expectedActiveRun: null,
    continuation: goalActivation(goal, 1),
  });
  return { input, result: await store.commitThreadGoalMutation(input) };
}

async function downgradeRunAuthorityToV1(
  admin: Pool,
  schema: string,
  runId: string,
  accounting: "keep" | "missing" | "null",
): Promise<void> {
  await admin.query(
    `ALTER TABLE "${schema}".run_snapshots
     DROP CONSTRAINT run_snapshots_goal_accounting_v2_ck`,
  );
  if (accounting !== "keep") {
    await writeLegacyGoalAccounting(admin, schema, runId, accounting);
  }
  await admin.query(
    `UPDATE "${schema}".schema_migrations
     SET version=1 WHERE component='run_authority'`,
  );
}

async function writeLegacyGoalAccounting(
  admin: Pool,
  schema: string,
  runId: string,
  accounting: "missing" | "null",
): Promise<void> {
  await admin.query(
    accounting === "missing"
      ? `UPDATE "${schema}".run_snapshots
         SET state_json = state_json - 'goalAccounting'
         WHERE run_id=$1`
      : `UPDATE "${schema}".run_snapshots
         SET state_json = jsonb_set(
           state_json, '{goalAccounting}', 'null'::jsonb, true
         )
         WHERE run_id=$1`,
    [runId],
  );
}

async function downgradeThreadAuthorityToV2(
  admin: Pool,
  schema: string,
): Promise<void> {
  await admin.query(`DROP TABLE "${schema}".thread_goal_events`);
  await admin.query(
    `UPDATE "${schema}".schema_migrations
     SET version=2 WHERE component='thread_authority'`,
  );
}

async function runAuthoritySchemaState(admin: Pool, schema: string) {
  const versions = await admin.query<{ component: string; version: number }>(
    `SELECT component, version FROM "${schema}".schema_migrations
     ORDER BY component`,
  );
  const constraints = await admin.query<{ conname: string }>(
    `SELECT constraints.conname
     FROM pg_constraint AS constraints
     JOIN pg_class AS tables ON tables.oid = constraints.conrelid
     JOIN pg_namespace AS namespaces ON namespaces.oid = tables.relnamespace
     WHERE namespaces.nspname=$1
     ORDER BY constraints.conname`,
    [schema],
  );
  const tables = await admin.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema=$1 AND table_type='BASE TABLE'
     ORDER BY table_name`,
    [schema],
  );
  return {
    version: versions.rows.find((entry) => entry.component === "run_authority")
      ?.version,
    versions: versions.rows,
    constraints: constraints.rows.map((row) => row.conname),
    tables: tables.rows.map((row) => row.table_name),
  };
}

async function legacyGoalAccountingSnapshot(
  admin: Pool,
  schema: string,
  runId: string,
) {
  const result = await admin.query<{
    has_goal_accounting: boolean;
    goal_accounting: unknown;
  }>(
    `SELECT state_json ? 'goalAccounting' AS has_goal_accounting,
            state_json->'goalAccounting' AS goal_accounting
     FROM "${schema}".run_snapshots
     WHERE run_id=$1`,
    [runId],
  );
  return result.rows[0];
}

async function waitForAdvisoryLockHeld(
  client: import("pg").PoolClient,
  key: string,
): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const result = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",
      [key],
    );
    if (result.rows[0]?.acquired === false) return;
    await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [
      key,
    ]);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("goal_mutation_did_not_reach_run_lock");
}

async function postgresBackendPid(
  client: import("pg").PoolClient,
): Promise<number> {
  const result = await client.query<{ pid: number }>(
    "SELECT pg_backend_pid() AS pid",
  );
  const pid = result.rows[0]?.pid;
  if (!Number.isInteger(pid)) throw new Error("postgres_backend_pid_invalid");
  return pid;
}

async function waitForAdvisoryLockWaiter(
  client: import("pg").PoolClient,
  blockerPid: number,
): Promise<number> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const result = await client.query<{ pid: number }>(
      `SELECT waiting.pid
       FROM pg_locks AS held
       JOIN pg_locks AS waiting
         ON waiting.locktype = held.locktype
        AND waiting.database IS NOT DISTINCT FROM held.database
        AND waiting.classid IS NOT DISTINCT FROM held.classid
        AND waiting.objid IS NOT DISTINCT FROM held.objid
        AND waiting.objsubid IS NOT DISTINCT FROM held.objsubid
       WHERE held.locktype = 'advisory'
         AND held.pid = $1
         AND held.granted = true
         AND waiting.granted = false
       ORDER BY waiting.pid
       LIMIT 1`,
      [blockerPid],
    );
    const waiterPid = result.rows[0]?.pid;
    if (Number.isInteger(waiterPid)) return waiterPid!;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("advisory_lock_waiter_not_observed");
}

async function advisoryLockHeldByBackend(
  client: import("pg").PoolClient,
  backendPid: number,
  key: string,
): Promise<boolean> {
  const result = await client.query<{ held: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM pg_locks
       WHERE locktype = 'advisory'
         AND pid = $1
         AND granted = true
         AND classid::bigint = (
           (hashtextextended($2, 0) >> 32) & 4294967295::bigint
         )
         AND objid::bigint = (
           hashtextextended($2, 0) & 4294967295::bigint
         )
         AND objsubid = 1
     ) AS held`,
    [backendPid, key],
  );
  return result.rows[0]?.held === true;
}

function hasStoreCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof RunStoreError && error.code === code;
}
