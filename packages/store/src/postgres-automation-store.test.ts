import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { Pool } from "pg";

import {
  AutomationStoreError,
  type AutomationInvocationResult,
  type CommitAutomationInvocationInput,
} from "@crewon/application";
import {
  reduceRunLifecycleEvent,
  reduceThreadLifecycleEvent,
  type RunLifecycleEvent,
  type RunState,
  type ThreadLifecycleEvent,
} from "@crewon/domain";

import {
  automationApplicationService,
  automationCreateCommand,
  automationRunCommand,
  registerAutomationStoreConformance,
  seedAutomationThread,
} from "./automation-store-conformance.test-support.ts";
import { POSTGRES_AUTOMATION_SCHEMA_VERSION } from "./postgres-automation-schema.ts";
import { PostgresDomainStore } from "./postgres-domain-store.ts";

const connectionString = process.env.CREWON_TEST_POSTGRES_URL;

if (connectionString === undefined) {
  test.skip("Postgres Automation authority requires CREWON_TEST_POSTGRES_URL", () => {});
} else {
  registerAutomationStoreConformance(
    "PostgresDomainStore Automation authority",
    () => createTestStore(connectionString),
  );

  test("installs independent Automation v1 with tenant-scoped receipts", async () => {
    const store = await createTestStore(connectionString);
    try {
      const migration = await store.admin.query<{
        component: string;
        version: number;
      }>(
        `SELECT component, version FROM ${store.quotedSchema}.schema_migrations
         WHERE component='automation_authority'`,
      );
      assert.deepEqual(migration.rows, [
        {
          component: "automation_authority",
          version: POSTGRES_AUTOMATION_SCHEMA_VERSION,
        },
      ]);
      const primaryKey = await store.admin.query<{ column_name: string }>(
        `SELECT column_name
         FROM information_schema.key_column_usage
         WHERE table_schema=$1
           AND table_name='automation_invocation_receipts'
           AND constraint_name='automation_invocation_receipts_pkey'
         ORDER BY ordinal_position`,
        [store.schemaName],
      );
      assert.deepEqual(
        primaryKey.rows.map(({ column_name }) => column_name),
        ["tenant_id", "scope", "idempotency_key"],
      );
    } finally {
      await store.close();
    }
  });

  test("atomically admits one leased scheduled Automation", async () => {
    const store = await createTestStore(connectionString);
    try {
      await seedAutomationThread(store);
      const automations = automationApplicationService(store);
      await automations.createAutomation(
        automationActor(),
        automationCreateCommand(),
      );
      const claims = await Promise.all([
        store.claimNextDueAutomation({
          ownerId: "postgres-scheduler-1",
          leaseId: "postgres-schedule-lease-1",
          leaseDurationMs: 30_000,
          observedAt: "2026-08-10T10:01:00.000Z",
        }),
        store.claimNextDueAutomation({
          ownerId: "postgres-scheduler-2",
          leaseId: "postgres-schedule-lease-2",
          leaseDurationMs: 30_000,
          observedAt: "2026-08-10T10:01:00.000Z",
        }),
      ]);
      const admittedClaims = claims.filter((claim) => claim !== null);
      assert.equal(admittedClaims.length, 1);
      const claim = admittedClaims[0];
      assert.ok(claim);
      const prepared = await automations.prepare({
        actor: automationActor(),
        claim,
      });
      const receipt = {
        tenantId: "tenant-1",
        automationId: "automation-1",
        scheduleRevision: 1 as const,
        scheduledFor: claim.scheduledFor,
        occurrenceDigest: claim.occurrenceDigest,
      };
      const committed = await store.commitScheduledAutomationInvocation({
        receipt,
        lease: {
          tenantId: "tenant-1",
          automationId: "automation-1",
          scheduleRevision: 1,
          scheduledFor: claim.scheduledFor,
          ownerId: claim.lease.ownerId,
          leaseId: claim.lease.leaseId,
          leaseEpoch: claim.lease.epoch,
        },
        expectedDefinitionDigest: claim.record.definitionDigest,
        expectedScheduleStateRevision: claim.record.scheduleState.revision,
        invocation: prepared,
        nextScheduleState: {
          ...claim.record.scheduleState,
          nextOccurrenceAt: "2026-08-11T10:00:00.000Z",
          lastScheduledFor: claim.scheduledFor,
          retryAt: null,
          revision: 2,
          updatedAt: claim.observedAt,
        },
      });

      assert.equal(committed.disposition, "committed");
      assert.deepEqual(await store.loadScheduledAutomationReceipt(receipt), {
        ...committed,
        disposition: "replayed",
      });
      assert.equal(
        (
          await store.loadAutomation({
            tenantId: "tenant-1",
            spaceId: "space-1",
            automationId: "automation-1",
          })
        )?.scheduleState.revision,
        2,
      );
    } finally {
      await store.close();
    }
  });

  test("replays an invocation receipt without waiting for later run or thread locks", async () => {
    const store = await createTestStore(connectionString);
    try {
      await seedAutomationThread(store);
      const service = automationApplicationService(store);
      await service.createAutomation(
        automationActor(),
        automationCreateCommand(),
      );
      const committed = await service.runAutomationNow(
        automationActor(),
        automationRunCommand(),
      );
      const invocationInput = store.lastAutomationInvocationInput;
      assert.ok(invocationInput !== null);

      const lock = await store.admin.connect();
      await lock.query("BEGIN");
      await lock.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`run:tenant-1:${committed.runState.runId}`],
      );
      await lock.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        ["thread:tenant-1:thread-1"],
      );
      try {
        const replay = await Promise.race([
          store.commitAutomationInvocation(invocationInput),
          new Promise<never>((_resolve, reject) =>
            setTimeout(
              () => reject(new Error("automation_receipt_replay_blocked")),
              1_000,
            ),
          ),
        ]);
        assert.deepEqual(replay, { ...committed, disposition: "replayed" });
      } finally {
        await lock.query("ROLLBACK");
        lock.release();
      }
    } finally {
      await store.close();
    }
  });

  test("replays from one snapshot while Run and Thread authority advance", async () => {
    const store = await createTestStore(connectionString);
    try {
      await seedAutomationThread(store);
      const service = automationApplicationService(store);
      await service.createAutomation(
        automationActor(),
        automationCreateCommand(),
      );
      const committed = await service.runAutomationNow(
        automationActor(),
        automationRunCommand(),
      );
      const invocationInput = store.lastAutomationInvocationInput;
      assert.ok(invocationInput !== null);

      const blocker = await store.admin.connect();
      await blocker.query("BEGIN");
      await blocker.query(
        `LOCK TABLE ${store.quotedSchema}.automations IN ACCESS EXCLUSIVE MODE`,
      );
      const replay = store.commitAutomationInvocation(invocationInput);
      try {
        await waitForRelationWaiter(store, "automations");
        await advanceRunAndThreadAuthority(store, committed);
      } finally {
        await blocker.query("COMMIT");
        blocker.release();
      }
      assert.deepEqual(await replay, {
        ...committed,
        disposition: "replayed",
      });
    } finally {
      await store.close();
    }
  });

  test("fresh invocation waits on the production proposed-Run fence", async () => {
    const store = await createTestStore(connectionString);
    try {
      await seedAutomationThread(store);
      const service = automationApplicationService(store);
      await service.createAutomation(
        automationActor(),
        automationCreateCommand(),
      );
      store.captureAutomationInvocationOnly = true;
      await assert.rejects(
        service.runAutomationNow(automationActor(), automationRunCommand()),
        hasStoreCode("automation_test_capture_only"),
      );
      store.captureAutomationInvocationOnly = false;
      const invocationInput = store.lastAutomationInvocationInput;
      assert.ok(invocationInput !== null);

      const lock = await store.admin.connect();
      await lock.query("BEGIN");
      await lock.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`run:tenant-1:${invocationInput.binding.runId}`],
      );
      const waitingBefore = await waitingAdvisoryLocks(store);
      let settled = false;
      const commit = store
        .commitAutomationInvocation(invocationInput)
        .finally(() => {
          settled = true;
        });
      try {
        await waitForAdvisoryWaiter(store, waitingBefore + 1);
        assert.equal(settled, false);
      } finally {
        await lock.query("COMMIT");
        lock.release();
      }
      assert.equal((await commit).disposition, "committed");
    } finally {
      await store.close();
    }
  });

  test("rejects a receipt Thread-state substitution from durable JSON", async () => {
    const store = await createTestStore(connectionString);
    try {
      await seedAutomationThread(store);
      const service = automationApplicationService(store);
      await service.createAutomation(
        automationActor(),
        automationCreateCommand(),
      );
      await service.runAutomationNow(automationActor(), automationRunCommand());
      await store.admin.query(
        `UPDATE ${store.quotedSchema}.automation_invocation_receipts
         SET result_json=jsonb_set(result_json, '{threadState,title}', '"forged"')`,
      );
      await assert.rejects(
        service.runAutomationNow(automationActor(), automationRunCommand()),
        hasStoreCode("automation_invocation_receipt_invalid"),
      );
    } finally {
      await store.close();
    }
  });
}

class TestPostgresDomainStore extends PostgresDomainStore {
  readonly admin: Pool;
  readonly schemaName: string;
  readonly quotedSchema: string;
  captureAutomationInvocationOnly = false;
  lastAutomationInvocationInput: CommitAutomationInvocationInput | null = null;
  #closed = false;

  constructor(url: string, schema: string) {
    super({
      connectionString: url,
      schema,
      maxPoolSize: 3,
      statementTimeoutMs: 2_000,
    });
    this.admin = new Pool({ connectionString: url, max: 2 });
    this.schemaName = schema;
    this.quotedSchema = `"${schema}"`;
  }

  override async commitAutomationInvocation(
    input: CommitAutomationInvocationInput,
  ): Promise<AutomationInvocationResult> {
    this.lastAutomationInvocationInput = structuredClone(input);
    if (this.captureAutomationInvocationOnly) {
      throw new AutomationStoreError("automation_test_capture_only");
    }
    return super.commitAutomationInvocation(input);
  }

  override async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await super.close();
    try {
      await this.admin.query(
        `DROP SCHEMA IF EXISTS ${this.quotedSchema} CASCADE`,
      );
    } finally {
      await this.admin.end();
    }
  }
}

async function createTestStore(url: string): Promise<TestPostgresDomainStore> {
  const schema = `crewon_automation_${randomUUID().replaceAll("-", "_")}`;
  const store = new TestPostgresDomainStore(url, schema);
  try {
    await store.migrate();
    return store;
  } catch (error) {
    await store.close();
    throw error;
  }
}

function automationActor() {
  return {
    principalId: "principal-1",
    actorId: "actor-1",
    tenantId: "tenant-1",
    spaceId: "space-1",
  } as const;
}

function hasStoreCode(code: string) {
  return (error: unknown) =>
    error instanceof Error &&
    "code" in error &&
    (error as Error & { code: string }).code === code;
}

async function waitForRelationWaiter(
  store: TestPostgresDomainStore,
  relation: string,
): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const result = await store.admin.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM pg_locks AS locks
       JOIN pg_class AS relations ON relations.oid=locks.relation
       JOIN pg_namespace AS namespaces
         ON namespaces.oid=relations.relnamespace
       WHERE namespaces.nspname=$1 AND relations.relname=$2
         AND locks.granted=false`,
      [store.schemaName, relation],
    );
    if (Number(result.rows[0]?.count ?? 0) > 0) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("automation_relation_waiter_timeout");
}

async function advanceRunAndThreadAuthority(
  store: TestPostgresDomainStore,
  committed: AutomationInvocationResult,
): Promise<void> {
  const threadEvent: ThreadLifecycleEvent = {
    schemaVersion: "crewon.thread-event.v0",
    identity: { threadId: "thread-1" },
    eventId: "automation-replay-race-thread-event",
    sequence: 3,
    occurredAt: "2026-08-09T00:00:01Z",
    type: "thread.renamed",
    data: { actorId: "actor-1", title: "Advanced thread" },
  };
  const runEvents: RunLifecycleEvent[] = [
    {
      schemaVersion: "crewon.run-event.v0",
      identity: { runId: committed.runState.runId },
      eventId: "automation-replay-race-run-started",
      sequence: 2,
      occurredAt: "2026-08-09T00:00:01Z",
      type: "run.started",
      data: {},
    },
    {
      schemaVersion: "crewon.run-event.v0",
      identity: { runId: committed.runState.runId },
      eventId: "automation-replay-race-run-completed",
      sequence: 3,
      occurredAt: "2026-08-09T00:00:02Z",
      type: "run.completed",
      data: { outputRef: null },
    },
  ];
  const nextThread = reduceThreadLifecycleEvent(
    committed.threadState,
    threadEvent,
  );
  let nextRun: RunState = committed.runState;
  for (const event of runEvents) {
    nextRun = reduceRunLifecycleEvent(nextRun, event);
  }
  const writer = await store.admin.connect();
  try {
    await writer.query("BEGIN");
    await writer.query(
      `INSERT INTO ${store.quotedSchema}.thread_events
         (tenant_id, thread_id, sequence, event_id, event_json)
       VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [
        "tenant-1",
        "thread-1",
        threadEvent.sequence,
        threadEvent.eventId,
        JSON.stringify(threadEvent),
      ],
    );
    await writer.query(
      `UPDATE ${store.quotedSchema}.threads
       SET title=$1, revision=$2, last_event_sequence=$3,
           state_json=$4::jsonb, updated_at=$5::timestamptz
       WHERE tenant_id='tenant-1' AND thread_id='thread-1'`,
      [
        nextThread.title,
        nextThread.revision,
        nextThread.lastEventSequence,
        JSON.stringify(nextThread),
        nextThread.updatedAt,
      ],
    );
    for (const event of runEvents) {
      await writer.query(
        `INSERT INTO ${store.quotedSchema}.run_events
           (tenant_id, run_id, sequence, event_id, event_json)
         VALUES ($1,$2,$3,$4,$5::jsonb)`,
        [
          "tenant-1",
          committed.runState.runId,
          event.sequence,
          event.eventId,
          JSON.stringify(event),
        ],
      );
    }
    await writer.query(
      `UPDATE ${store.quotedSchema}.run_snapshots
       SET revision=$1, last_sequence=$2, state_json=$3::jsonb,
           updated_at=$4::timestamptz
       WHERE tenant_id='tenant-1' AND run_id=$5`,
      [
        nextRun.revision,
        nextRun.lastSequence,
        JSON.stringify(nextRun),
        nextRun.updatedAt,
        nextRun.runId,
      ],
    );
    await writer.query("COMMIT");
  } catch (error) {
    await writer.query("ROLLBACK");
    throw error;
  } finally {
    writer.release();
  }
}

async function waitingAdvisoryLocks(
  store: TestPostgresDomainStore,
): Promise<number> {
  const result = await store.admin.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM pg_locks
     WHERE locktype='advisory' AND granted=false`,
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function waitForAdvisoryWaiter(
  store: TestPostgresDomainStore,
  expected: number,
): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if ((await waitingAdvisoryLocks(store)) >= expected) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("automation_advisory_waiter_timeout");
}
