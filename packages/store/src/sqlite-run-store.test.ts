import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";

import {
  ApplicationError,
  RunApplicationService,
  RunExecutionService,
  RunStoreError,
  validateWorkspaceOperationRecord,
  type ActorContext,
  type ApplicationIdKind,
  type RunStore,
  type WorkspaceOperationRecord,
} from "@crewon/application";
import {
  createRunGoalAccountingCursor,
  prepareToolExecutionReceipt,
  startRunGoalAccounting,
  type RunGoalBinding,
  type RunState,
} from "@crewon/domain";

import {
  createRunningCommitFixture,
  ManualLeaseClock,
  registerRunStoreConformance,
  runningStateFixture,
} from "./run-store-conformance.test-support.ts";
import { registerRunExecutionStoreConformance } from "./run-execution-store-conformance.test-support.ts";
import { SqliteRunStore } from "./sqlite-run-store.ts";
import {
  createThreadCommitFixture,
  registerThreadStoreConformance,
  seedThread,
  threadStateFixture,
} from "./thread-store-conformance.test-support.ts";
import {
  configureAndMigrateSqlite,
  readUserVersion,
  SQLITE_SCHEMA_VERSION,
} from "./sqlite-schema.ts";
import {
  agentVersionAsset,
  registerAgentVersionStoreConformance,
} from "./agent-version-store-conformance.test-support.ts";
import {
  registerAgentVersionReleaseStoreConformance,
  releaseActivation,
  releaseBundle,
} from "./agent-version-release-store-conformance.test-support.ts";
import { registerTurnStartStoreConformance } from "./turn-start-store-conformance.test-support.ts";
import {
  goalActivation,
  goalFixture,
  goalMutationInput,
  registerThreadGoalMutationStoreConformance,
} from "./thread-goal-mutation-store-conformance.test-support.ts";
import {
  commitThreadRollbackFixture,
  registerThreadRollbackStoreConformance,
} from "./thread-rollback-store-conformance.test-support.ts";
import { registerAutomationStoreConformance } from "./automation-store-conformance.test-support.ts";
import {
  prepareInput,
  receiptQuery,
  registerWorkspaceOperationStoreConformance,
  seedWorkspaceThread,
} from "./workspace-operation-store-conformance.test-support.ts";
import { workspaceOperationResultDigest } from "./workspace-operation-store-support.ts";

registerWorkspaceOperationStoreConformance(
  "SqliteRunStore workspace operation authority (:memory:)",
  () => new SqliteRunStore(":memory:"),
);

test("bounds SQLite snapshot and high-cursor reads independently of old revisions", async (context) => {
  const path = temporaryDatabasePath(context);
  const store = new SqliteRunStore(path);
  context.after(() => store.close());
  await seedWorkspaceThread(store);
  const prepared = await store.prepareWorkspaceOperation(prepareInput());
  const database = new DatabaseSync(path);
  context.after(() => database.close());
  const insert = database.prepare(
    `INSERT INTO workspace_operation_revisions (
       tenant_id, execution_id, revision, result_digest, operation_json
     ) VALUES (?, ?, ?, ?, ?)`,
  );
  let head = prepared.operation;
  database.exec("BEGIN IMMEDIATE");
  for (let revision = 2; revision <= 150; revision += 1) {
    head = unknownWorkspaceRevision(prepared.operation, revision);
    insert.run(
      head.tenantId,
      head.executionId,
      head.revision,
      workspaceOperationResultDigest(head),
      JSON.stringify(head),
    );
  }
  database
    .prepare(
      `UPDATE workspace_operations
       SET revision = ?, status = ?, operation_json = ?
       WHERE tenant_id = ? AND execution_id = ?`,
    )
    .run(
      head.revision,
      head.status,
      JSON.stringify(head),
      head.tenantId,
      head.executionId,
    );
  database
    .prepare(
      `UPDATE workspace_operation_revisions
       SET operation_json = json_set(operation_json, '$.unexpected', 1)
       WHERE tenant_id = ? AND execution_id = ? AND revision = 1`,
    )
    .run(head.tenantId, head.executionId);
  database.exec("COMMIT");

  const locator = workspaceOperationLocator(head);
  assert.deepEqual(await store.loadWorkspaceOperationSnapshot(locator), {
    operation: head,
    eventSequence: 150,
  });
  assert.deepEqual(
    await store.listWorkspaceOperations({
      tenantId: head.tenantId,
      spaceId: head.spaceId,
      threadId: head.threadId,
      afterExecutionId: null,
      limit: 100,
    }),
    { operations: [head], nextAfterExecutionId: null },
  );
  assert.deepEqual(
    await store.listWorkspaceOperationEvents({
      ...locator,
      afterSequence: 149,
      limit: 100,
    }),
    [{ sequence: 150, operation: head }],
  );
  await assert.rejects(
    store.listWorkspaceOperationEvents({
      ...locator,
      afterSequence: 0,
      limit: 1,
    }),
  );
});

test("fails closed on SQLite revision gaps, digest drift, and head mismatches", async (context) => {
  for (const corruption of [
    "gap",
    "digest",
    "extraHead",
    "headJson",
  ] as const) {
    const path = temporaryDatabasePath(context);
    const store = new SqliteRunStore(path);
    await seedWorkspaceThread(store);
    const prepared = await store.prepareWorkspaceOperation(prepareInput());
    const database = new DatabaseSync(path);
    database.exec("PRAGMA foreign_keys = OFF");
    if (corruption === "gap") {
      database
        .prepare(
          `DELETE FROM workspace_operation_revisions
           WHERE tenant_id = ? AND execution_id = ? AND revision = 1`,
        )
        .run(prepared.operation.tenantId, prepared.operation.executionId);
    } else if (corruption === "digest") {
      database
        .prepare(
          `UPDATE workspace_operation_revisions SET result_digest = ?
           WHERE tenant_id = ? AND execution_id = ? AND revision = 1`,
        )
        .run(
          `sha256:${"f".repeat(64)}`,
          prepared.operation.tenantId,
          prepared.operation.executionId,
        );
    } else if (corruption === "extraHead") {
      const extra = unknownWorkspaceRevision(prepared.operation, 2);
      database
        .prepare(
          `INSERT INTO workspace_operation_revisions (
             tenant_id, execution_id, revision, result_digest, operation_json
           ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          extra.tenantId,
          extra.executionId,
          extra.revision,
          workspaceOperationResultDigest(extra),
          JSON.stringify(extra),
        );
    } else {
      database
        .prepare(
          `UPDATE workspace_operations
           SET operation_json = json_set(operation_json, '$.unexpected', 1)
           WHERE tenant_id = ? AND execution_id = ?`,
        )
        .run(prepared.operation.tenantId, prepared.operation.executionId);
    }
    await assert.rejects(
      store.loadWorkspaceOperationSnapshot(
        workspaceOperationLocator(prepared.operation),
      ),
    );
    await assert.rejects(
      store.listWorkspaceOperations({
        tenantId: prepared.operation.tenantId,
        spaceId: prepared.operation.spaceId,
        threadId: prepared.operation.threadId,
        afterExecutionId: null,
        limit: 100,
      }),
    );
    database.close();
    await store.close();
  }
});

test("SQLite workspace lease expiry requires a new reconcile attempt", async () => {
  const clock = new ManualLeaseClock(Date.parse("2026-08-10T00:00:00.000Z"));
  const store = new SqliteRunStore(":memory:", { clock });
  await seedWorkspaceThread(store);
  const prepared = await store.prepareWorkspaceOperation(prepareInput());
  const attempt = prepared.deliveryAttempt!;
  await store.claimWorkspaceOperationDelivery({
    tenantId: attempt.tenantId,
    spaceId: attempt.spaceId,
    threadId: attempt.threadId,
    executionId: attempt.executionId,
    attemptNumber: attempt.attemptNumber,
    operationRevision: attempt.operationRevision,
    phase: attempt.phase,
    ownerId: "owner-1",
    leaseDurationMs: 35_000,
  });
  clock.advance(35_000);
  await assert.rejects(
    store.claimWorkspaceOperationDelivery({
      tenantId: attempt.tenantId,
      spaceId: attempt.spaceId,
      threadId: attempt.threadId,
      executionId: attempt.executionId,
      attemptNumber: attempt.attemptNumber,
      operationRevision: attempt.operationRevision,
      phase: attempt.phase,
      ownerId: "owner-2",
      leaseDurationMs: 35_000,
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "workspace_delivery_reconcile_required",
  );
  const reconcile = receiptQuery("reconcile");
  const recovered = await store.prepareWorkspaceOperationAction({
    tenantId: attempt.tenantId,
    spaceId: attempt.spaceId,
    threadId: attempt.threadId,
    executionId: attempt.executionId,
    expectedOperationRevision: attempt.operationRevision,
    phase: "reconcile",
    idempotency: reconcile.idempotency,
  });
  assert.equal(recovered.deliveryAttempt?.phase, "reconcile");
  await store.close();
});

registerAutomationStoreConformance(
  "SqliteRunStore Automation authority (:memory:)",
  () => new SqliteRunStore(":memory:"),
);

registerRunStoreConformance(
  "SqliteRunStore (:memory:)",
  (clock) => new SqliteRunStore(":memory:", { clock }),
);

registerThreadStoreConformance(
  "SqliteRunStore Thread authority (:memory:)",
  (clock) => new SqliteRunStore(":memory:", { clock }),
);

registerRunExecutionStoreConformance(
  "SqliteRunStore execution authority (:memory:)",
  (clock) => new SqliteRunStore(":memory:", { clock }),
);

registerAgentVersionStoreConformance(
  "SqliteRunStore AgentVersion authority (:memory:)",
  () => new SqliteRunStore(":memory:"),
);

registerAgentVersionReleaseStoreConformance(
  "SqliteRunStore AgentVersion release authority (:memory:)",
  () => new SqliteRunStore(":memory:"),
);

registerTurnStartStoreConformance(
  "SqliteRunStore atomic Turn start (:memory:)",
  () => new SqliteRunStore(":memory:"),
);

registerThreadGoalMutationStoreConformance(
  "SqliteRunStore atomic Goal mutation (:memory:)",
  () => new SqliteRunStore(":memory:"),
);

registerThreadRollbackStoreConformance(
  "SqliteRunStore append-only Thread rollback (:memory:)",
  (clock) => new SqliteRunStore(":memory:", { clock }),
);

test("fails closed when a SQLite rollback receipt omits one invalidation", async (context) => {
  const path = temporaryDatabasePath(context);
  const store = new SqliteRunStore(path);
  context.after(() => store.close());
  const { input } = await commitThreadRollbackFixture(store);
  const database = new DatabaseSync(path);
  try {
    database
      .prepare(
        `UPDATE thread_idempotency_receipts
         SET result_json = json_remove(result_json, '$.invalidatedMessages[0]')
         WHERE scope = ? AND idempotency_key = ?`,
      )
      .run(input.idempotency.scope, input.idempotency.key);
  } finally {
    database.close();
  }

  await assert.rejects(
    store.loadThreadRollbackReceipt({
      tenantId: input.tenantId,
      threadId: input.event.identity.threadId,
      idempotency: input.idempotency,
    }),
    hasStoreCode("thread_rollback_receipt_authority_invalid"),
  );
});

test("migrates v18 Thread authority to append-only rollback v19", async (context) => {
  const path = temporaryDatabasePath(context);
  const initialized = new SqliteRunStore(path);
  await initialized.close();
  const versionEighteen = new DatabaseSync(path);
  try {
    versionEighteen.exec(`
      DROP TABLE thread_rollback_commits;
      DROP TABLE message_invalidations;
      PRAGMA user_version = 18;
    `);
  } finally {
    versionEighteen.close();
  }

  const migrated = new SqliteRunStore(path);
  context.after(() => migrated.close());
  const { result } = await commitThreadRollbackFixture(migrated);
  assert.equal(result.marker.type, "rollback");
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(readUserVersion(database), SQLITE_SCHEMA_VERSION);
    const rows = database
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type='table'
           AND name IN ('message_invalidations', 'thread_rollback_commits')
         ORDER BY name`,
      )
      .all() as unknown as { name: string }[];
    assert.deepEqual(
      rows.map(({ name }) => name),
      ["message_invalidations", "thread_rollback_commits"],
    );
  } finally {
    database.close();
  }
});

test("persists snapshot, events, queues and idempotency across restart", async (context) => {
  const path = temporaryDatabasePath(context);
  const input = createRunningCommitFixture();
  const first = new SqliteRunStore(path);
  await seedThread(first);
  await first.commitRun(input);
  await first.close();

  const reopened = new SqliteRunStore(path);
  context.after(() => reopened.close());
  assert.deepEqual(await reopened.loadRun(runLocator()), runningStateFixture());
  assert.deepEqual(
    await reopened.listRunEvents(runLocator(), 0, 100),
    input.events,
  );
  assert.deepEqual(await reopened.listPendingOutbox(100), input.outbox);
  assert.deepEqual(await reopened.listPendingWorkItems(100), input.workItems);
  assert.deepEqual(await reopened.commitRun(input), {
    disposition: "replayed",
    state: runningStateFixture(),
    events: input.events,
    outbox: input.outbox,
    workItems: input.workItems,
  });
});

test("reclaims Outbox and Work Item leases after an unclean owner restart", async (context) => {
  const path = temporaryDatabasePath(context);
  const clock = new ManualLeaseClock();
  const input = createRunningCommitFixture();
  const first = new SqliteRunStore(path, { clock });
  await seedThread(first);
  await first.commitRun(input);
  const outboxLease = await first.claimNextOutbox({
    ownerId: "process-before-crash",
    leaseId: "outbox-before-crash",
    leaseDurationMs: 1_000,
  });
  const workLease = await first.claimNextWorkItem({
    ownerId: "process-before-crash",
    leaseId: "work-before-crash",
    leaseDurationMs: 1_000,
  });
  assert.equal(outboxLease?.lease.epoch, 1);
  assert.equal(workLease?.lease.epoch, 1);
  await first.close();

  clock.advance(1_000);
  const recovered = new SqliteRunStore(path, { clock });
  context.after(() => recovered.close());
  const reclaimedOutbox = await recovered.claimNextOutbox({
    ownerId: "process-after-crash",
    leaseId: "outbox-after-crash",
    leaseDurationMs: 1_000,
  });
  const reclaimedWork = await recovered.claimNextWorkItem({
    ownerId: "process-after-crash",
    leaseId: "work-after-crash",
    leaseDurationMs: 1_000,
  });
  assert.equal(reclaimedOutbox?.lease.epoch, 2);
  assert.equal(reclaimedWork?.lease.epoch, 2);
  assert.ok(reclaimedOutbox !== null);
  assert.ok(reclaimedWork !== null);

  await recovered.acknowledgeOutbox({
    messageId: reclaimedOutbox.message.messageId,
    ownerId: reclaimedOutbox.lease.ownerId,
    leaseId: reclaimedOutbox.lease.leaseId,
    leaseEpoch: reclaimedOutbox.lease.epoch,
  });
  await recovered.completeWorkItem({
    workItemId: reclaimedWork.workItem.workItemId,
    ownerId: reclaimedWork.lease.ownerId,
    leaseId: reclaimedWork.lease.leaseId,
    leaseEpoch: reclaimedWork.lease.epoch,
  });
  assert.deepEqual(await recovered.listPendingOutbox(100), []);
  assert.deepEqual(await recovered.listPendingWorkItems(100), []);
});

test("persists Attempt history and links recovery across a SQLite restart", async (context) => {
  const path = temporaryDatabasePath(context);
  const clock = new ManualLeaseClock();
  const first = new SqliteRunStore(path, { clock });
  await seedThread(first);
  await first.commitRun(createRunningCommitFixture());
  const crashedClaim = await first.claimNextWorkItem({
    ownerId: "worker-before-crash",
    leaseId: "lease-before-crash",
    leaseDurationMs: 1_000,
  });
  assert.ok(crashedClaim !== null);
  await first.beginRunAttempt({
    tenantId: "tenant-1",
    lease: {
      workItemId: crashedClaim.workItem.workItemId,
      ownerId: crashedClaim.lease.ownerId,
      leaseId: crashedClaim.lease.leaseId,
      leaseEpoch: crashedClaim.lease.epoch,
    },
    runId: "run-store-1",
    stepId: "work-item-1",
    kind: "model",
    attemptId: "attempt-before-restart",
    startedAt: "2026-08-08T00:01:01Z",
  });
  await first.close();

  clock.advance(1_000);
  const recovered = new SqliteRunStore(path, { clock });
  context.after(() => recovered.close());
  const recoveredClaim = await recovered.claimNextWorkItem({
    ownerId: "worker-after-crash",
    leaseId: "lease-after-crash",
    leaseDurationMs: 1_000,
  });
  assert.ok(recoveredClaim !== null);
  const second = await recovered.beginRunAttempt({
    tenantId: "tenant-1",
    lease: {
      workItemId: recoveredClaim.workItem.workItemId,
      ownerId: recoveredClaim.lease.ownerId,
      leaseId: recoveredClaim.lease.leaseId,
      leaseEpoch: recoveredClaim.lease.epoch,
    },
    runId: "run-store-1",
    stepId: "work-item-1",
    kind: "model",
    attemptId: "attempt-after-restart",
    startedAt: "2026-08-08T00:01:02Z",
  });

  assert.equal(second.attempt.retryOfAttemptId, "attempt-before-restart");
  assert.equal(second.abandonedAttempt?.status, "abandoned");
  assert.deepEqual(
    (
      await recovered.listRunAttempts(
        {
          tenantId: "tenant-1",
          runId: "run-store-1",
          stepId: "work-item-1",
        },
        0,
        100,
      )
    ).map(({ attemptId, attemptNumber, retryOfAttemptId, status }) => ({
      attemptId,
      attemptNumber,
      retryOfAttemptId,
      status,
    })),
    [
      {
        attemptId: "attempt-before-restart",
        attemptNumber: 1,
        retryOfAttemptId: null,
        status: "abandoned",
      },
      {
        attemptId: "attempt-after-restart",
        attemptNumber: 2,
        retryOfAttemptId: "attempt-before-restart",
        status: "running",
      },
    ],
  );
});

test("migrates a v9 Tool receipt to an explicit legacy ActionIntent", async (context) => {
  const path = temporaryDatabasePath(context);
  const clock = new ManualLeaseClock();
  const first = new SqliteRunStore(path, { clock });
  await seedThread(first);
  await first.commitRun(createRunningCommitFixture());
  const claim = await first.claimNextWorkItem({
    ownerId: "tool-worker-before-restart",
    leaseId: "tool-lease-before-restart",
    leaseDurationMs: 1_000,
  });
  assert.ok(claim !== null);
  const lease = {
    workItemId: claim.workItem.workItemId,
    ownerId: claim.lease.ownerId,
    leaseId: claim.lease.leaseId,
    leaseEpoch: claim.lease.epoch,
  };
  await first.beginRunAttempt({
    tenantId: "tenant-1",
    lease,
    runId: "run-store-1",
    stepId: "tool-step-before-restart",
    kind: "tool",
    attemptId: "tool-attempt-before-restart",
    startedAt: "2026-08-08T00:01:01Z",
  });
  const prepared = prepareToolExecutionReceipt({
    receiptId: "tool-receipt-before-restart",
    tenantId: "tenant-1",
    runId: "run-store-1",
    stepId: "tool-step-before-restart",
    attemptId: "tool-attempt-before-restart",
    workItemId: claim.workItem.workItemId,
    executionId: "tool-execution-before-restart",
    idempotencyKey: "run-store-1/tool/call-before-restart",
    actionDigest: `sha256:${"a".repeat(64)}`,
    actionIntent: {
      schemaVersion: "crewon.action-intent.v0",
      runId: "run-store-1",
      segmentId: "segment-before-restart",
      callId: "call-before-restart",
      tool: {
        kind: "function",
        name: "filesystem.write",
        inputDigest: `sha256:${"b".repeat(64)}`,
      },
      effect: "mutation",
      recovery: "reconcilable",
      policySnapshotId: "policy-1",
      workspaceBindingId: "workspace-1",
      resourceBindingId: null,
      credentialBindingId: null,
      executionTarget: { kind: "device", bindingId: "device-1" },
      capability: "workspace.write",
      approvalRequirement: "perAction",
      limits: {
        timeoutMs: 30_000,
        maxOutputBytes: 64 * 1024,
        maxArtifactBytes: 1024 * 1024,
      },
    },
    call: {
      segmentId: "segment-before-restart",
      callId: "call-before-restart",
      kind: "function",
      name: "filesystem.write",
      inputDigest: `sha256:${"b".repeat(64)}`,
    },
    effect: "mutation",
    recovery: "reconcilable",
    preparedAt: "2026-08-08T00:01:01Z",
  });
  await first.prepareToolExecution({ lease, receipt: prepared });
  const dispatched = await first.transitionToolExecution({
    tenantId: prepared.tenantId,
    runId: prepared.runId,
    receiptId: prepared.receiptId,
    lease,
    expectedRevision: prepared.revision,
    transition: {
      kind: "dispatch",
      occurredAt: "2026-08-08T00:01:02Z",
    },
  });
  await first.close();

  const versionNine = new DatabaseSync(path);
  versionNine.exec(`
    UPDATE tool_execution_receipts
    SET state_json = json_remove(state_json, '$.actionIntent');
    PRAGMA user_version = 9;
  `);
  versionNine.close();

  const recovered = new SqliteRunStore(path, { clock });
  context.after(() => recovered.close());
  const legacy = await recovered.loadToolExecutionReceipt({
    tenantId: prepared.tenantId,
    runId: prepared.runId,
    receiptId: prepared.receiptId,
  });
  assert.ok(legacy !== null);
  assert.deepEqual(legacy, { ...dispatched, actionIntent: null });
  assert.deepEqual(
    await recovered.loadToolExecutionReceiptByAction({
      tenantId: prepared.tenantId,
      runId: prepared.runId,
      actionDigest: prepared.actionDigest,
    }),
    { ...dispatched, actionIntent: null },
  );
  const execution = new RunExecutionService({
    store: recovered,
    clock: { now: () => "2026-08-08T00:01:03Z" },
    ids: { nextId: (kind) => `${kind}-legacy-validation` },
    digester: { sha256: () => legacy.call.inputDigest },
  });
  assert.throws(
    () => execution.validateToolExecutionInput(legacy, "legacy input"),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.code === "tool_action_intent_mismatch",
  );
});

test("migrates a v10 authority to the durable Tool approval table", async (context) => {
  const path = temporaryDatabasePath(context);
  const current = new SqliteRunStore(path);
  await current.close();
  const versionTen = new DatabaseSync(path);
  versionTen.exec(`
    DROP TABLE tool_approvals;
    PRAGMA user_version = 10;
  `);
  versionTen.close();

  const migrated = new SqliteRunStore(path);
  await migrated.close();
  const database = new DatabaseSync(path);
  context.after(() => database.close());
  assert.equal(
    (
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tool_approvals'",
        )
        .get() as { name: string } | undefined
    )?.name,
    "tool_approvals",
  );
  assert.deepEqual(plainRow(database.prepare("PRAGMA user_version").get()), {
    user_version: SQLITE_SCHEMA_VERSION,
  });
});

test("grants one Outbox claim across independent SQLite connections", async (context) => {
  const path = temporaryDatabasePath(context);
  const clock = new ManualLeaseClock();
  const seed = new SqliteRunStore(path, { clock });
  await seedThread(seed);
  await seed.commitRun(createRunningCommitFixture());
  await seed.close();

  const first = new SqliteRunStore(path, { clock });
  const second = new SqliteRunStore(path, { clock });
  context.after(async () => {
    await first.close();
    await second.close();
  });
  const claims = await Promise.all([
    first.claimNextOutbox({
      ownerId: "connection-a",
      leaseId: "connection-lease-a",
      leaseDurationMs: 1_000,
    }),
    second.claimNextOutbox({
      ownerId: "connection-b",
      leaseId: "connection-lease-b",
      leaseDurationMs: 1_000,
    }),
  ]);

  assert.equal(claims.filter((claim) => claim !== null).length, 1);
  assert.equal(claims.filter((claim) => claim === null).length, 1);
});

test("migrates v1 pending Outbox rows without losing delivery intent", async (context) => {
  const path = temporaryDatabasePath(context);
  const message = {
    messageId: "legacy-outbox-1",
    tenantId: "tenant-legacy-1",
    runId: "run-legacy-1",
    topic: "run.updated",
    payload: {
      eventId: "event-legacy-1",
      eventType: "run.created",
      throughSequence: 1,
    },
    createdAt: "2026-08-08T00:00:01Z",
  } as const;
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE run_snapshots (
      tenant_id TEXT NOT NULL,
      space_id TEXT NOT NULL,
      run_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL,
      last_sequence INTEGER NOT NULL,
      state_json TEXT NOT NULL CHECK (json_valid(state_json)),
      updated_at TEXT NOT NULL,
      UNIQUE (tenant_id, run_id)
    ) STRICT;
    CREATE TABLE run_events (
      tenant_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      event_id TEXT NOT NULL UNIQUE,
      event_json TEXT NOT NULL CHECK (json_valid(event_json)),
      PRIMARY KEY (run_id, sequence),
      FOREIGN KEY (tenant_id, run_id)
        REFERENCES run_snapshots(tenant_id, run_id) ON DELETE CASCADE
    ) STRICT;
    CREATE TABLE outbox (
      outbox_order INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL UNIQUE,
      tenant_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      topic TEXT NOT NULL,
      message_json TEXT NOT NULL CHECK (json_valid(message_json)),
      created_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status = 'pending'),
      FOREIGN KEY (tenant_id, run_id)
        REFERENCES run_snapshots(tenant_id, run_id) ON DELETE CASCADE
    ) STRICT;
    CREATE TABLE idempotency_receipts (
      tenant_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      run_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      result_json TEXT NOT NULL CHECK (json_valid(result_json)),
      PRIMARY KEY (scope, idempotency_key),
      FOREIGN KEY (tenant_id, run_id)
        REFERENCES run_snapshots(tenant_id, run_id) ON DELETE CASCADE
    ) STRICT;
    CREATE INDEX outbox_pending_idx ON outbox(status, outbox_order);
    PRAGMA user_version = 1;
  `);
  legacy
    .prepare(
      `INSERT INTO run_snapshots (
        tenant_id, space_id, run_id, revision, last_sequence, state_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      message.tenantId,
      "space-legacy-1",
      message.runId,
      1,
      1,
      JSON.stringify({
        runId: message.runId,
        threadId: "thread-legacy-1",
        tenantId: message.tenantId,
        spaceId: "space-legacy-1",
        createdByActorId: "actor-legacy-1",
        authorityId: "standalone-legacy-1",
        runtimeGeneration: "rust-v0",
        agentVersionId: "agent-version-legacy-1",
        policySnapshotId: "policy-legacy-1",
        workspaceBindingId: null,
        status: "queued",
        revision: 1,
        lastSequence: 1,
        cancelRequested: false,
        waitingApproval: null,
        suspensionReasonCode: null,
        reconciliationReceiptId: null,
        outputRef: null,
        failure: null,
        createdAt: message.createdAt,
        updatedAt: message.createdAt,
        terminalAt: null,
      }),
      message.createdAt,
    );
  legacy
    .prepare(
      `INSERT INTO outbox (
        message_id, tenant_id, run_id, topic, message_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      message.messageId,
      message.tenantId,
      message.runId,
      message.topic,
      JSON.stringify(message),
      message.createdAt,
    );
  legacy.close();

  const migrated = new SqliteRunStore(path, {
    clock: new ManualLeaseClock(),
  });
  context.after(() => migrated.close());
  assert.deepEqual(
    await migrated.loadThread({
      tenantId: message.tenantId,
      threadId: "thread-legacy-1",
    }),
    {
      threadId: "thread-legacy-1",
      tenantId: message.tenantId,
      spaceId: "space-legacy-1",
      createdByActorId: "actor-legacy-1",
      title: null,
      status: "active",
      revision: 1,
      lastEventSequence: 1,
      lastMessageSequence: 0,
      createdAt: message.createdAt,
      updatedAt: message.createdAt,
      archivedAt: null,
      deletedAt: null,
      deletedByActorId: null,
      forkedFromThreadId: null,
      forkedThroughHistorySequence: null,
    },
  );
  assert.equal(
    (
      await migrated.loadRun({
        tenantId: message.tenantId,
        runId: message.runId,
      })
    )?.threadId,
    "thread-legacy-1",
  );
  assert.deepEqual(await migrated.listPendingOutbox(100), [message]);
  const claim = await migrated.claimNextOutbox({
    ownerId: "migration-dispatcher",
    leaseId: "migration-lease",
    leaseDurationMs: 1_000,
  });
  assert.deepEqual(claim?.message, message);
  assert.equal(claim?.lease.epoch, 1);
});

test("fails the v2 migration when one legacy Thread crosses spaces", (context) => {
  const path = temporaryDatabasePath(context);
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE run_snapshots (
      tenant_id TEXT NOT NULL,
      space_id TEXT NOT NULL,
      run_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL,
      last_sequence INTEGER NOT NULL,
      state_json TEXT NOT NULL CHECK (json_valid(state_json)),
      updated_at TEXT NOT NULL,
      UNIQUE (tenant_id, run_id)
    ) STRICT;
    PRAGMA user_version = 2;
  `);
  const insert = legacy.prepare(
    `INSERT INTO run_snapshots (
      tenant_id, space_id, run_id, revision, last_sequence, state_json, updated_at
    ) VALUES (?, ?, ?, 1, 1, ?, ?)`,
  );
  insert.run(
    "tenant-conflict",
    "space-a",
    "run-a",
    JSON.stringify(legacyRunState("run-a", "space-a")),
    "2026-08-08T00:00:01Z",
  );
  insert.run(
    "tenant-conflict",
    "space-b",
    "run-b",
    JSON.stringify(legacyRunState("run-b", "space-b")),
    "2026-08-08T00:00:02Z",
  );
  legacy.close();

  assert.throws(
    () => new SqliteRunStore(path),
    hasStoreCode("sqlite_thread_backfill_conflict"),
  );
  const inspected = new DatabaseSync(path);
  context.after(() => inspected.close());
  assert.deepEqual(plainRow(inspected.prepare("PRAGMA user_version").get()), {
    user_version: 2,
  });
  assert.equal(
    inspected
      .prepare(
        "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'threads'",
      )
      .get(),
    undefined,
  );
});

test("migrates a v3 authority without losing existing Run state", async (context) => {
  const path = temporaryDatabasePath(context);
  const first = new SqliteRunStore(path);
  await seedThread(first);
  await first.commitRun(createRunningCommitFixture());
  await first.close();
  const versionThree = new DatabaseSync(path);
  versionThree.exec("DROP TABLE tool_execution_receipts");
  versionThree.exec("DROP TABLE run_attempts");
  versionThree.exec("DROP TABLE run_steps");
  versionThree.exec("DROP TABLE thread_continuations");
  versionThree.exec("DROP TABLE model_history_items");
  versionThree.exec("PRAGMA user_version = 3");
  versionThree.close();

  const migrated = new SqliteRunStore(path);
  context.after(() => migrated.close());
  assert.deepEqual(await migrated.loadRun(runLocator()), runningStateFixture());
  const database = new DatabaseSync(path);
  context.after(() => database.close());
  assert.deepEqual(plainRow(database.prepare("PRAGMA user_version").get()), {
    user_version: SQLITE_SCHEMA_VERSION,
  });
  assert.deepEqual(
    plainRow(
      database
        .prepare(
          `SELECT name FROM sqlite_schema
           WHERE type = 'table' AND name = 'thread_continuations'`,
        )
        .get(),
    ),
    { name: "thread_continuations" },
  );
});

test("migrates a v4 authority to empty Step and Attempt tables", async (context) => {
  const path = temporaryDatabasePath(context);
  const first = new SqliteRunStore(path);
  await seedThread(first);
  await first.commitRun(createRunningCommitFixture());
  await first.close();
  const versionFour = new DatabaseSync(path);
  versionFour.exec("DROP TABLE run_attempts");
  versionFour.exec("DROP TABLE run_steps");
  downgradeModelHistoryAuthority(versionFour);
  versionFour.exec("PRAGMA user_version = 4");
  versionFour.close();

  const migrated = new SqliteRunStore(path);
  context.after(() => migrated.close());
  assert.deepEqual(await migrated.loadRun(runLocator()), runningStateFixture());
  assert.equal(
    await migrated.loadRunStep({
      tenantId: "tenant-1",
      runId: "run-store-1",
      stepId: "work-item-1",
    }),
    null,
  );
  const database = new DatabaseSync(path);
  context.after(() => database.close());
  assert.deepEqual(plainRow(database.prepare("PRAGMA user_version").get()), {
    user_version: SQLITE_SCHEMA_VERSION,
  });
  assert.deepEqual(
    database
      .prepare(
        `SELECT name FROM sqlite_schema
         WHERE type = 'table' AND name IN ('run_steps', 'run_attempts')
         ORDER BY name`,
      )
      .all()
      .map(plainRow),
    [{ name: "run_attempts" }, { name: "run_steps" }],
  );
});

test("migrates v5 Messages into canonical Model History", async (context) => {
  const path = temporaryDatabasePath(context);
  const first = new SqliteRunStore(path);
  await seedThread(first);
  const contentDigest = `sha256:${"a".repeat(64)}`;
  const createdAt = "2026-08-08T00:00:02Z";
  const message = {
    messageId: "message-v5",
    tenantId: "tenant-1",
    threadId: "thread-1",
    sequence: 1,
    role: "user" as const,
    content: "legacy message",
    contentDigest,
    createdAt,
    origin: null,
  };
  await first.commitThread({
    tenantId: "tenant-1",
    idempotency: {
      scope: "migration-v5",
      key: "append",
      requestFingerprint: "migration-v5-append",
    },
    expectedRevision: 1,
    events: [
      {
        schemaVersion: "crewon.thread-event.v0",
        identity: { threadId: "thread-1" },
        eventId: "thread-event-v5-message",
        sequence: 2,
        occurredAt: createdAt,
        type: "thread.message.appended",
        data: {
          messageId: message.messageId,
          messageSequence: message.sequence,
          role: message.role,
          contentDigest,
        },
      },
    ],
    messages: [message],
    history: {
      expectedLastSequence: 0,
      items: [
        {
          schemaVersion: "crewon.model-history-item.v0",
          itemId: "history-before-downgrade",
          tenantId: "tenant-1",
          threadId: "thread-1",
          sequence: 1,
          runId: null,
          segmentId: null,
          createdAt,
          type: "message",
          role: "user",
          source: "thread_message",
          content: message.content,
          contentDigest,
        },
      ],
    },
  });
  await first.close();

  const versionFive = new DatabaseSync(path);
  downgradeModelHistoryAuthority(versionFive);
  versionFive.exec("PRAGMA user_version = 5");
  versionFive.close();

  const migrated = new SqliteRunStore(path);
  context.after(() => migrated.close());
  assert.deepEqual(
    await migrated.listModelHistoryItems(
      { tenantId: "tenant-1", threadId: "thread-1" },
      0,
      100,
    ),
    [
      {
        schemaVersion: "crewon.model-history-item.v0",
        itemId: "history:migration:message-v5",
        tenantId: "tenant-1",
        threadId: "thread-1",
        sequence: 1,
        runId: null,
        segmentId: null,
        createdAt,
        type: "message",
        role: "user",
        source: "thread_message",
        content: "legacy message",
        contentDigest,
      },
    ],
  );
});

test("migrates v7 Model History and provider continuation to a canonical context revision", async (context) => {
  const path = temporaryDatabasePath(context);
  const initialized = new SqliteRunStore(path);
  await seedThread(initialized);
  await initialized.close();
  const database = new DatabaseSync(path);
  const item = {
    schemaVersion: "crewon.model-history-item.v0",
    itemId: "history-v7-assistant",
    tenantId: "tenant-1",
    threadId: "thread-1",
    sequence: 1,
    runId: null,
    segmentId: null,
    createdAt: "2026-08-08T00:00:02Z",
    type: "message",
    role: "assistant",
    source: "assistant_completion",
    content: "v7 assistant message",
    contentDigest: `sha256:${"a".repeat(64)}`,
  } as const;
  const checkpoint = {
    schemaVersion: "crewon.provider-checkpoint.v0",
    adapterName: "v7-adapter",
    adapterVersion: "1",
    modelId: "v7-model",
    opaquePayload: { responseId: "v7-response" },
  } as const;
  database
    .prepare(
      `INSERT INTO model_history_items (
        tenant_id,
        thread_id,
        sequence,
        item_id,
        run_id,
        segment_id,
        item_type,
        item_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      item.tenantId,
      item.threadId,
      item.sequence,
      item.itemId,
      item.runId,
      item.segmentId,
      item.type,
      JSON.stringify(item),
      item.createdAt,
    );
  database
    .prepare(
      `INSERT INTO thread_continuations (
        tenant_id,
        thread_id,
        agent_version_id,
        adapter_name,
        adapter_version,
        model_id,
        through_history_sequence,
        context_revision,
        checkpoint_json,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "tenant-1",
      "thread-1",
      "agent-version-v7",
      checkpoint.adapterName,
      checkpoint.adapterVersion,
      checkpoint.modelId,
      1,
      "current-column-removed-by-downgrade",
      JSON.stringify(checkpoint),
      "2026-08-08T00:00:03Z",
    );
  downgradeContextCompactionAuthority(database);
  database.close();

  const migrated = new SqliteRunStore(path);
  context.after(() => migrated.close());
  assert.deepEqual(
    await migrated.listModelHistoryItems(
      { tenantId: "tenant-1", threadId: "thread-1" },
      0,
      100,
    ),
    [item],
  );
  assert.deepEqual(
    await migrated.loadThreadContinuation({
      tenantId: "tenant-1",
      threadId: "thread-1",
      agentVersionId: "agent-version-v7",
      adapterName: checkpoint.adapterName,
      adapterVersion: checkpoint.adapterVersion,
      modelId: checkpoint.modelId,
    }),
    {
      tenantId: "tenant-1",
      threadId: "thread-1",
      agentVersionId: "agent-version-v7",
      adapterName: checkpoint.adapterName,
      adapterVersion: checkpoint.adapterVersion,
      modelId: checkpoint.modelId,
      throughHistorySequence: 1,
      contextRevision: "canonical",
      checkpoint,
      updatedAt: "2026-08-08T00:00:03Z",
    },
  );
});

test("migrates v8 Thread snapshots and idempotency receipts to explicit non-fork lineage", async (context) => {
  const path = temporaryDatabasePath(context);
  const input = createThreadCommitFixture();
  const initialized = new SqliteRunStore(path);
  await initialized.commitThread(input);
  await initialized.close();
  const versionEight = new DatabaseSync(path);
  versionEight.exec(`
    UPDATE threads
    SET state_json = json_remove(
      state_json,
      '$.forkedFromThreadId',
      '$.forkedThroughHistorySequence'
    );
    UPDATE thread_idempotency_receipts
    SET result_json = json_remove(
      result_json,
      '$.state.forkedFromThreadId',
      '$.state.forkedThroughHistorySequence'
    );
    PRAGMA user_version = 8;
  `);
  versionEight.close();

  const migrated = new SqliteRunStore(path);
  context.after(() => migrated.close());
  assert.deepEqual(
    await migrated.loadThread({ tenantId: "tenant-1", threadId: "thread-1" }),
    threadStateFixture(),
  );
  assert.deepEqual(await migrated.commitThread(input), {
    disposition: "replayed",
    state: threadStateFixture(),
    events: input.events,
    messages: [],
    historyItems: [],
  });
});

test("configures WAL and foreign keys and applies the current schema once", (context) => {
  const path = temporaryDatabasePath(context);
  const database = new DatabaseSync(path);
  context.after(() => database.close());

  configureAndMigrateSqlite(database);
  configureAndMigrateSqlite(database);

  assert.deepEqual(plainRow(database.prepare("PRAGMA journal_mode").get()), {
    journal_mode: "wal",
  });
  assert.deepEqual(plainRow(database.prepare("PRAGMA foreign_keys").get()), {
    foreign_keys: 1,
  });
  assert.deepEqual(plainRow(database.prepare("PRAGMA user_version").get()), {
    user_version: SQLITE_SCHEMA_VERSION,
  });
  assert.deepEqual(
    database
      .prepare(
        `SELECT name
         FROM sqlite_schema
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all()
      .map(plainRow),
    [
      { name: "active_agent_version_releases" },
      { name: "agent_version_deployments" },
      { name: "agent_version_release_activations" },
      { name: "agent_version_release_bundles" },
      { name: "agent_versions" },
      { name: "automation_create_receipts" },
      { name: "automation_invocation_receipts" },
      { name: "automations" },
      { name: "idempotency_receipts" },
      { name: "message_invalidations" },
      { name: "messages" },
      { name: "model_history_items" },
      { name: "model_provider_settings" },
      { name: "model_provider_settings_operations" },
      { name: "model_provider_settings_receipts" },
      { name: "outbox" },
      { name: "run_attempts" },
      { name: "run_events" },
      { name: "run_snapshots" },
      { name: "run_steps" },
      { name: "run_thread_bindings" },
      { name: "thread_continuations" },
      { name: "thread_events" },
      { name: "thread_goal_events" },
      { name: "thread_goals" },
      { name: "thread_idempotency_receipts" },
      { name: "thread_model_states" },
      { name: "thread_rollback_commits" },
      { name: "threads" },
      { name: "tool_approvals" },
      { name: "tool_execution_receipts" },
      { name: "work_items" },
      { name: "workspace_delivery_attempts" },
      { name: "workspace_operation_receipts" },
      { name: "workspace_operation_revisions" },
      { name: "workspace_operations" },
    ],
  );
  assert.equal(
    database
      .prepare("PRAGMA foreign_key_list(run_events)")
      .all()
      .some(
        (row) =>
          row.table === "run_snapshots" &&
          row.from === "run_id" &&
          row.to === "run_id",
      ),
    true,
  );
});

test("migrates v12 to durable AgentVersion assets and persists them", async (context) => {
  const path = temporaryDatabasePath(context);
  const initialized = new SqliteRunStore(path);
  await initialized.close();
  const versionTwelve = new DatabaseSync(path);
  versionTwelve.exec(`
    DROP TABLE agent_versions;
    PRAGMA user_version = 12;
  `);
  versionTwelve.close();

  const migrated = new SqliteRunStore(path);
  const asset = agentVersionAsset("tenant-1", "agent-version-a");
  await migrated.registerAgentVersion(asset);
  await migrated.close();

  const reopened = new SqliteRunStore(path);
  context.after(() => reopened.close());
  assert.deepEqual(
    await reopened.loadAgentVersion({
      tenantId: asset.tenantId,
      agentVersionId: asset.agentVersionId,
    }),
    asset,
  );
});

test("migrates v13 to durable AgentVersion deployments", async (context) => {
  const path = temporaryDatabasePath(context);
  const initialized = new SqliteRunStore(path);
  await initialized.close();
  const versionThirteen = new DatabaseSync(path);
  versionThirteen.exec(`
    DROP TABLE agent_version_deployments;
    PRAGMA user_version = 13;
  `);
  versionThirteen.close();

  const bundle = releaseBundle("b", ["agent-version-a"]);
  const activation = releaseActivation(bundle, "activation-v13", null);
  const migrated = new SqliteRunStore(path);
  await migrated.registerAgentVersion(
    agentVersionAsset(bundle.tenantId, bundle.defaultAgentVersionId),
  );
  await migrated.activateAgentVersionRelease({
    bundle,
    activation,
    expectedActiveReleaseId: null,
  });
  await migrated.close();

  const reopened = new SqliteRunStore(path);
  context.after(() => reopened.close());
  assert.deepEqual(
    await reopened.loadAgentVersionDeployment({
      tenantId: bundle.tenantId,
      agentVersionId: bundle.defaultAgentVersionId,
    }),
    { ...bundle.deployments[0], deployedAt: activation.activatedAt },
  );
});

test("migrates v14 to atomic AgentVersion release activation", async (context) => {
  const path = temporaryDatabasePath(context);
  const initialized = new SqliteRunStore(path);
  await initialized.close();
  const versionFourteen = new DatabaseSync(path);
  versionFourteen.exec(`
    DROP TABLE active_agent_version_releases;
    DROP TABLE agent_version_release_activations;
    DROP TABLE agent_version_release_bundles;
    PRAGMA user_version = 14;
  `);
  versionFourteen.close();

  const bundle = releaseBundle("6", ["agent-version-a"]);
  const activation = releaseActivation(bundle, "activation-v14", null);
  const migrated = new SqliteRunStore(path);
  await migrated.registerAgentVersion(
    agentVersionAsset(bundle.tenantId, bundle.defaultAgentVersionId),
  );
  await migrated.activateAgentVersionRelease({
    bundle,
    activation,
    expectedActiveReleaseId: null,
  });
  await migrated.close();

  const reopened = new SqliteRunStore(path);
  context.after(() => reopened.close());
  assert.deepEqual(
    await reopened.loadActiveAgentVersionRelease({
      tenantId: bundle.tenantId,
    }),
    { bundle, activation },
  );
});

test("migrates v16 to the v17 durable Thread Goal event table", async (context) => {
  const path = temporaryDatabasePath(context);
  const initialized = new SqliteRunStore(path);
  await initialized.close();
  const versionSixteen = new DatabaseSync(path);
  versionSixteen.exec(`
    DROP TABLE thread_goal_events;
    PRAGMA user_version = 16;
  `);
  versionSixteen.close();

  const migrated = new SqliteRunStore(path);
  await migrated.close();
  const inspected = new DatabaseSync(path);
  context.after(() => inspected.close());
  assert.deepEqual(plainRow(inspected.prepare("PRAGMA user_version").get()), {
    user_version: SQLITE_SCHEMA_VERSION,
  });
  assert.deepEqual(
    inspected
      .prepare("PRAGMA table_info(thread_goal_events)")
      .all()
      .map((row) => (row as { name: string }).name),
    [
      "tenant_id",
      "thread_id",
      "sequence",
      "event_id",
      "event_type",
      "event_json",
      "occurred_at",
    ],
  );
});

test("migrates v17 Thread snapshots and receipts to terminal tombstone authority", async (context) => {
  const path = temporaryDatabasePath(context);
  const input = createThreadCommitFixture();
  const initialized = new SqliteRunStore(path);
  await initialized.commitThread(input);
  await initialized.close();

  const legacy = new DatabaseSync(path);
  legacy.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN IMMEDIATE;
    DROP INDEX threads_visible_list_idx;
    CREATE TABLE threads_v17 (
      tenant_id TEXT NOT NULL,
      space_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      created_by_actor_id TEXT NOT NULL,
      title TEXT,
      status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
      revision INTEGER NOT NULL CHECK (revision >= 1),
      last_event_sequence INTEGER NOT NULL CHECK (last_event_sequence >= 1),
      last_message_sequence INTEGER NOT NULL CHECK (last_message_sequence >= 0),
      state_json TEXT NOT NULL CHECK (json_valid(state_json)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT,
      PRIMARY KEY (tenant_id, thread_id)
    ) STRICT;
    INSERT INTO threads_v17
    SELECT tenant_id, space_id, thread_id, created_by_actor_id, title, status,
           revision, last_event_sequence, last_message_sequence,
           json_remove(state_json, '$.deletedAt', '$.deletedByActorId'),
           created_at, updated_at, archived_at
    FROM threads;
    DROP TABLE threads;
    ALTER TABLE threads_v17 RENAME TO threads;
    UPDATE thread_idempotency_receipts
    SET result_json = json_remove(
      result_json,
      '$.state.deletedAt',
      '$.state.deletedByActorId'
    );
    PRAGMA user_version = 17;
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
  legacy.close();

  const migrated = new SqliteRunStore(path);
  context.after(() => migrated.close());
  assert.deepEqual(await migrated.commitThread(input), {
    disposition: "replayed",
    state: threadStateFixture(),
    events: input.events,
    messages: [],
    historyItems: [],
  });
  const inspected = new DatabaseSync(path);
  context.after(() => inspected.close());
  assert.deepEqual(plainRow(inspected.prepare("PRAGMA user_version").get()), {
    user_version: SQLITE_SCHEMA_VERSION,
  });
  assert.deepEqual(
    inspected
      .prepare("PRAGMA table_info(threads)")
      .all()
      .map((row) => (row as { name: string }).name),
    [
      "tenant_id",
      "space_id",
      "thread_id",
      "created_by_actor_id",
      "title",
      "status",
      "revision",
      "last_event_sequence",
      "last_message_sequence",
      "state_json",
      "created_at",
      "updated_at",
      "archived_at",
      "deleted_at",
      "deleted_by_actor_id",
    ],
  );
  assert.deepEqual(inspected.prepare("PRAGMA foreign_key_check").all(), []);
});

test("refuses v16 migration while a nonterminal Goal-bound legacy Run needs draining", (context) => {
  const path = temporaryDatabasePath(context);
  prepareVersionSixteenGoalRun(path, "running", "missing");

  assert.throws(
    () => new SqliteRunStore(path),
    hasStoreCode("legacy_goal_run_requires_drain"),
  );
  const inspected = new DatabaseSync(path);
  context.after(() => inspected.close());
  assert.deepEqual(plainRow(inspected.prepare("PRAGMA user_version").get()), {
    user_version: 16,
  });
  assert.equal(
    inspected
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name = 'thread_goal_events'`,
      )
      .get(),
    undefined,
  );
});

test("allows v16 migration after a legacy Goal-bound Run is terminal", (context) => {
  const path = temporaryDatabasePath(context);
  prepareVersionSixteenGoalRun(path, "completed", "missing");

  const migrated = new SqliteRunStore(path);
  context.after(() => migrated.close());
  const inspected = new DatabaseSync(path);
  context.after(() => inspected.close());
  assert.deepEqual(plainRow(inspected.prepare("PRAGMA user_version").get()), {
    user_version: SQLITE_SCHEMA_VERSION,
  });
  assert.deepEqual(
    plainRow(
      inspected
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name = 'thread_goal_events'`,
        )
        .get(),
    ),
    { name: "thread_goal_events" },
  );
});

test("allows v16 migration for a nonterminal Goal-bound Run with a durable cursor", (context) => {
  const path = temporaryDatabasePath(context);
  prepareVersionSixteenGoalRun(path, "running", "valid");

  const migrated = new SqliteRunStore(path);
  context.after(() => migrated.close());
  const inspected = new DatabaseSync(path);
  context.after(() => inspected.close());
  assert.deepEqual(plainRow(inspected.prepare("PRAGMA user_version").get()), {
    user_version: SQLITE_SCHEMA_VERSION,
  });
});

test("fails closed when a stored Thread Goal event disagrees with its indexed columns", async (context) => {
  const path = temporaryDatabasePath(context);
  const store = new SqliteRunStore(path);
  await seedThread(store);
  const goal = goalFixture();
  await store.commitThreadGoalMutation(
    goalMutationInput({
      idempotencyKey: "sqlite-corrupt-goal-event",
      goal: { kind: "set", expectedRevision: null, goal },
      expectedActiveRun: null,
      continuation: goalActivation(goal, 1),
    }),
  );
  await store.close();

  const corrupted = new DatabaseSync(path);
  const row = corrupted
    .prepare(
      `SELECT event_json FROM thread_goal_events
       WHERE tenant_id = ? AND thread_id = ? AND sequence = 1`,
    )
    .get("tenant-1", "thread-1") as { event_json: string };
  const event = JSON.parse(row.event_json) as Record<string, unknown>;
  corrupted
    .prepare(
      `UPDATE thread_goal_events SET event_json = ?
       WHERE tenant_id = ? AND thread_id = ? AND sequence = 1`,
    )
    .run(JSON.stringify({ ...event, sequence: 2 }), "tenant-1", "thread-1");
  corrupted.close();

  const reopened = new SqliteRunStore(path);
  context.after(() => reopened.close());
  await assert.rejects(
    reopened.listThreadGoalEvents(
      { tenantId: "tenant-1", threadId: "thread-1" },
      0,
      10,
    ),
    hasStoreCode("stored_goal_event_invalid"),
  );
});

test("fails closed when the durable Thread Goal event sequence has a gap", async (context) => {
  const path = temporaryDatabasePath(context);
  const store = new SqliteRunStore(path);
  await seedThread(store);
  const goal = goalFixture();
  await store.commitThreadGoalMutation(
    goalMutationInput({
      idempotencyKey: "sqlite-goal-event-gap-set",
      goal: { kind: "set", expectedRevision: null, goal },
      expectedActiveRun: null,
      continuation: goalActivation(goal, 1),
    }),
  );
  await store.commitThreadGoalMutation(
    goalMutationInput({
      idempotencyKey: "sqlite-goal-event-gap-clear",
      goal: {
        kind: "clear",
        expectedRevision: goal.revision,
        occurredAt: "2026-08-08T00:00:05Z",
      },
      expectedActiveRun: {
        runId: "run-goal-activation-1",
        expectedRevision: 1,
      },
      cancellationRunId: "run-goal-activation-1",
      cancellationSequence: 2,
    }),
  );
  await store.close();

  const corrupted = new DatabaseSync(path);
  corrupted
    .prepare(
      `DELETE FROM thread_goal_events
       WHERE tenant_id = ? AND thread_id = ? AND sequence = 1`,
    )
    .run("tenant-1", "thread-1");
  corrupted.close();

  const reopened = new SqliteRunStore(path);
  context.after(() => reopened.close());
  await assert.rejects(
    reopened.listThreadGoalEvents(
      { tenantId: "tenant-1", threadId: "thread-1" },
      0,
      10,
    ),
    hasStoreCode("stored_goal_event_page_invalid"),
  );
});

test("rolls back a release when SQLite fails after the first Deployment insert", async (context) => {
  const path = temporaryDatabasePath(context);
  const store = new SqliteRunStore(path);
  context.after(() => store.close());
  const bundle = releaseBundle("7", ["agent-a", "agent-b"]);
  for (const deployment of bundle.deployments) {
    await store.registerAgentVersion(
      agentVersionAsset(bundle.tenantId, deployment.agentVersionId),
    );
  }
  const injector = new DatabaseSync(path);
  injector.exec(`
    CREATE TRIGGER fail_second_release_deployment
    BEFORE INSERT ON agent_version_deployments
    WHEN NEW.agent_version_id = 'agent-b'
    BEGIN
      SELECT RAISE(ABORT, 'forced_release_failure');
    END;
  `);
  injector.close();

  await assert.rejects(
    store.activateAgentVersionRelease({
      bundle,
      activation: releaseActivation(bundle, "activation-failure", null),
      expectedActiveReleaseId: null,
    }),
  );
  assert.equal(
    await store.loadAgentVersionReleaseBundle({
      tenantId: bundle.tenantId,
      releaseId: bundle.releaseId,
    }),
    null,
  );
  assert.equal(
    await store.loadActiveAgentVersionRelease({ tenantId: bundle.tenantId }),
    null,
  );
  for (const deployment of bundle.deployments) {
    assert.equal(await store.loadAgentVersionDeployment(deployment), null);
  }
});

test("fails closed when AgentVersion asset JSON disagrees with indexed columns", async (context) => {
  const path = temporaryDatabasePath(context);
  const asset = agentVersionAsset("tenant-1", "agent-version-a");
  const initialized = new SqliteRunStore(path);
  await initialized.registerAgentVersion(asset);
  await initialized.close();
  const corrupted = new DatabaseSync(path);
  corrupted
    .prepare(
      `UPDATE agent_versions
       SET content_digest = ?
       WHERE tenant_id = ? AND agent_version_id = ?`,
    )
    .run(`sha256:${"b".repeat(64)}`, asset.tenantId, asset.agentVersionId);
  corrupted.close();

  const reopened = new SqliteRunStore(path);
  context.after(() => reopened.close());
  await assert.rejects(
    reopened.loadAgentVersion({
      tenantId: asset.tenantId,
      agentVersionId: asset.agentVersionId,
    }),
    hasStoreCode("agent_version_asset_corrupt"),
  );
});

test("refuses a database created by a newer schema version", (context) => {
  const path = temporaryDatabasePath(context);
  const database = new DatabaseSync(path);
  database.exec(`PRAGMA user_version = ${SQLITE_SCHEMA_VERSION + 1}`);
  database.close();

  assert.throws(
    () => new SqliteRunStore(path),
    hasStoreCode("sqlite_schema_too_new"),
  );

  const inspected = new DatabaseSync(path);
  context.after(() => inspected.close());
  assert.deepEqual(plainRow(inspected.prepare("PRAGMA user_version").get()), {
    user_version: SQLITE_SCHEMA_VERSION + 1,
  });
});

test("rolls back writes when SQLite fails after snapshot and event insertion", async (context) => {
  const path = temporaryDatabasePath(context);
  const initialized = new SqliteRunStore(path);
  await initialized.close();

  const setup = new DatabaseSync(path);
  setup.exec(`
    CREATE TRIGGER reject_outbox
    BEFORE INSERT ON outbox
    BEGIN
      SELECT RAISE(ABORT, 'forced outbox failure');
    END;
  `);
  setup.close();

  const store = new SqliteRunStore(path);
  context.after(() => store.close());
  await seedThread(store);
  await assert.rejects(
    store.commitRun(createRunningCommitFixture()),
    hasStoreCode("sqlite_error"),
  );
  assert.equal(await store.loadRun(runLocator()), null);
  assert.deepEqual(await store.listRunEvents(runLocator(), 0, 100), []);
  assert.deepEqual(await store.listPendingOutbox(100), []);
});

test("continues an application run from durable state after process restart", async (context) => {
  const path = temporaryDatabasePath(context);
  const first = new SqliteRunStore(path);
  await seedThread(first, {
    tenantId: "tenant-app-1",
    spaceId: "space-app-1",
    threadId: "thread-app-1",
    actorId: "actor-app-1",
  });
  const creator = applicationService(
    first,
    ["run-app-1", "event-app-1", "outbox-app-1", "work-item-app-1"],
    "2026-08-08T01:00:01Z",
  );
  await creator.createRun(applicationActor(), {
    kind: "run.create",
    idempotencyKey: "create-app-1",
    threadId: "thread-app-1",
    route: {
      authorityId: "standalone-1",
      runtimeGeneration: "ts-v0",
      agentVersionId: "agent-version-1",
      policySnapshotId: "policy-1",
      workspaceBindingId: "workspace-1",
    },
  });
  await first.close();

  const second = new SqliteRunStore(path);
  const worker = applicationService(
    second,
    ["event-app-2", "outbox-app-2"],
    "2026-08-08T01:00:02Z",
  );
  await worker.transitionRun(applicationActor(), {
    kind: "run.start",
    runId: "run-app-1",
    expectedRevision: 1,
    idempotencyKey: "start-app-1",
  });
  await second.close();

  const inspected = new SqliteRunStore(path);
  context.after(() => inspected.close());
  assert.equal(
    (
      await inspected.loadRun({
        tenantId: "tenant-app-1",
        runId: "run-app-1",
      })
    )?.status,
    "running",
  );
  assert.deepEqual(
    (
      await inspected.listRunEvents(
        { tenantId: "tenant-app-1", runId: "run-app-1" },
        0,
        100,
      )
    ).map((event) => event.type),
    ["run.created", "run.started"],
  );
  assert.equal((await inspected.listPendingOutbox(100)).length, 2);
});

test("fails closed when stored JSON disagrees with authoritative columns", async (context) => {
  const path = temporaryDatabasePath(context);
  const store = new SqliteRunStore(path);
  await seedThread(store);
  await store.commitRun(createRunningCommitFixture());
  await store.close();

  const corrupted = new DatabaseSync(path);
  corrupted
    .prepare(
      `UPDATE run_snapshots
       SET state_json = json_set(state_json, '$.revision', 999)
       WHERE run_id = ?`,
    )
    .run("run-store-1");
  corrupted.close();

  const reopened = new SqliteRunStore(path);
  context.after(() => reopened.close());
  await assert.rejects(
    reopened.loadRun(runLocator()),
    hasStoreCode("stored_run_state_invalid"),
  );
});

test("fails closed when stored Attempt detail violates its bounded schema", async (context) => {
  const path = temporaryDatabasePath(context);
  const clock = new ManualLeaseClock();
  const store = new SqliteRunStore(path, { clock });
  context.after(() => store.close());
  await seedThread(store);
  await store.commitRun(createRunningCommitFixture());
  const claim = await store.claimNextWorkItem({
    ownerId: "attempt-corruption-worker",
    leaseId: "attempt-corruption-lease",
    leaseDurationMs: 1_000,
  });
  assert.ok(claim !== null);
  await store.beginRunAttempt({
    tenantId: "tenant-1",
    lease: {
      workItemId: claim.workItem.workItemId,
      ownerId: claim.lease.ownerId,
      leaseId: claim.lease.leaseId,
      leaseEpoch: claim.lease.epoch,
    },
    runId: "run-store-1",
    stepId: "work-item-1",
    kind: "model",
    attemptId: "attempt-corrupted",
    startedAt: "2026-08-08T00:01:01Z",
  });
  const corruptor = new DatabaseSync(path);
  corruptor
    .prepare(
      `UPDATE run_attempts
       SET state_json = json_set(state_json, '$.checkpointDigest', 'raw-secret')
       WHERE attempt_id = ?`,
    )
    .run("attempt-corrupted");
  corruptor.close();

  await assert.rejects(
    store.loadRunAttempt({
      tenantId: "tenant-1",
      runId: "run-store-1",
      stepId: "work-item-1",
      attemptId: "attempt-corrupted",
    }),
    hasStoreCode("stored_run_attempt_invalid"),
  );
});

test("fails closed when stored provider turn state violates header grammar", async (context) => {
  const path = temporaryDatabasePath(context);
  const clock = new ManualLeaseClock();
  const store = new SqliteRunStore(path, { clock });
  context.after(() => store.close());
  await seedThread(store);
  await store.commitRun(createRunningCommitFixture());
  const claim = await store.claimNextWorkItem({
    ownerId: "turn-state-corruption-worker",
    leaseId: "turn-state-corruption-lease",
    leaseDurationMs: 1_000,
  });
  assert.ok(claim !== null);
  await store.beginRunAttempt({
    tenantId: "tenant-1",
    lease: {
      workItemId: claim.workItem.workItemId,
      ownerId: claim.lease.ownerId,
      leaseId: claim.lease.leaseId,
      leaseEpoch: claim.lease.epoch,
    },
    runId: "run-store-1",
    stepId: "work-item-1",
    kind: "model",
    attemptId: "attempt-turn-state-corrupted",
    startedAt: "2026-08-08T00:01:01Z",
  });
  for (const invalid of [
    { not: "a-string" },
    "comma,state",
    "control\nstate",
    "x".repeat(4 * 1024 + 1),
  ]) {
    const corruptor = new DatabaseSync(path);
    corruptor
      .prepare(
        `UPDATE run_attempts
         SET state_json = json_set(state_json, '$.providerTurnState', json(?))
         WHERE attempt_id = ?`,
      )
      .run(JSON.stringify(invalid), "attempt-turn-state-corrupted");
    corruptor.close();

    await assert.rejects(
      store.loadRunProviderTurnState({
        tenantId: "tenant-1",
        runId: "run-store-1",
      }),
      hasStoreCode("stored_run_attempt_invalid"),
    );
  }
});

function downgradeModelHistoryAuthority(database: DatabaseSync): void {
  database.exec(`
    DROP TABLE tool_execution_receipts;
    DROP TABLE thread_continuations;
    DROP TABLE model_history_items;
    CREATE TABLE thread_continuations (
      tenant_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      agent_version_id TEXT NOT NULL,
      adapter_name TEXT NOT NULL,
      adapter_version TEXT NOT NULL,
      model_id TEXT NOT NULL,
      through_message_sequence INTEGER NOT NULL
        CHECK (through_message_sequence >= 1),
      checkpoint_json TEXT NOT NULL CHECK (json_valid(checkpoint_json)),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (
        tenant_id,
        thread_id,
        agent_version_id,
        adapter_name,
        adapter_version,
        model_id
      ),
      FOREIGN KEY (tenant_id, thread_id)
        REFERENCES threads(tenant_id, thread_id) ON DELETE CASCADE,
      FOREIGN KEY (tenant_id, thread_id, through_message_sequence)
        REFERENCES messages(tenant_id, thread_id, sequence) ON DELETE CASCADE
    ) STRICT;
    CREATE INDEX thread_continuations_thread_idx
      ON thread_continuations(tenant_id, thread_id, through_message_sequence);
  `);
}

function downgradeContextCompactionAuthority(database: DatabaseSync): void {
  database.exec(`
    PRAGMA foreign_keys = OFF;
    ALTER TABLE thread_continuations RENAME TO thread_continuations_current;
    DROP INDEX IF EXISTS thread_continuations_thread_idx;
    ALTER TABLE model_history_items RENAME TO model_history_items_current;
    DROP INDEX IF EXISTS model_history_items_thread_idx;
    DROP INDEX IF EXISTS model_history_items_run_idx;

    CREATE TABLE model_history_items (
      tenant_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK (sequence >= 1),
      item_id TEXT NOT NULL UNIQUE,
      run_id TEXT,
      segment_id TEXT,
      item_type TEXT NOT NULL
        CHECK (item_type IN ('message', 'tool_call', 'tool_result')),
      item_json TEXT NOT NULL CHECK (json_valid(item_json)),
      created_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, thread_id, sequence),
      FOREIGN KEY (tenant_id, thread_id)
        REFERENCES threads(tenant_id, thread_id) ON DELETE CASCADE
    ) STRICT;
    INSERT INTO model_history_items
      SELECT * FROM model_history_items_current;
    CREATE INDEX model_history_items_thread_idx
      ON model_history_items(tenant_id, thread_id, sequence);
    CREATE INDEX model_history_items_run_idx
      ON model_history_items(tenant_id, run_id, sequence);

    CREATE TABLE thread_continuations (
      tenant_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      agent_version_id TEXT NOT NULL,
      adapter_name TEXT NOT NULL,
      adapter_version TEXT NOT NULL,
      model_id TEXT NOT NULL,
      through_history_sequence INTEGER NOT NULL
        CHECK (through_history_sequence >= 1),
      checkpoint_json TEXT NOT NULL CHECK (json_valid(checkpoint_json)),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (
        tenant_id,
        thread_id,
        agent_version_id,
        adapter_name,
        adapter_version,
        model_id
      ),
      FOREIGN KEY (tenant_id, thread_id)
        REFERENCES threads(tenant_id, thread_id) ON DELETE CASCADE,
      FOREIGN KEY (tenant_id, thread_id, through_history_sequence)
        REFERENCES model_history_items(tenant_id, thread_id, sequence) ON DELETE CASCADE
    ) STRICT;
    INSERT INTO thread_continuations (
      tenant_id,
      thread_id,
      agent_version_id,
      adapter_name,
      adapter_version,
      model_id,
      through_history_sequence,
      checkpoint_json,
      updated_at
    )
    SELECT
      tenant_id,
      thread_id,
      agent_version_id,
      adapter_name,
      adapter_version,
      model_id,
      through_history_sequence,
      checkpoint_json,
      updated_at
    FROM thread_continuations_current;
    CREATE INDEX thread_continuations_thread_idx
      ON thread_continuations(tenant_id, thread_id, through_history_sequence);

    DROP TABLE thread_continuations_current;
    DROP TABLE model_history_items_current;
    PRAGMA user_version = 7;
    PRAGMA foreign_keys = ON;
  `);
}

function unknownWorkspaceRevision(
  prepared: WorkspaceOperationRecord,
  revision: number,
): WorkspaceOperationRecord {
  return validateWorkspaceOperationRecord({
    ...prepared,
    revision,
    status: "unknownOutcome",
    resolution: {
      status: "unknownOutcome",
      executionId: prepared.executionId,
      actionDigest: prepared.command.actionDigest,
      commandDigest: prepared.command.commandDigest,
      providerReceiptId: null,
    },
  });
}

function workspaceOperationLocator(operation: WorkspaceOperationRecord) {
  return {
    tenantId: operation.tenantId,
    spaceId: operation.spaceId,
    threadId: operation.threadId,
    executionId: operation.executionId,
  };
}

function temporaryDatabasePath(context: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "crewon-store-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "runs.sqlite3");
}

function prepareVersionSixteenGoalRun(
  path: string,
  status: "running" | "completed",
  accounting: "missing" | "valid",
): void {
  const database = new DatabaseSync(path);
  configureAndMigrateSqlite(database);
  const binding: RunGoalBinding = {
    goalId: "goal-legacy",
    revision: 1,
    objectiveDigest: `sha256:${"a".repeat(64)}`,
  };
  const base = runningStateFixture();
  const cursor = startRunGoalAccounting(
    createRunGoalAccountingCursor(binding, base.createdAt),
    2,
    base.updatedAt,
  );
  const state: RunState = {
    ...base,
    goalBinding: binding,
    goalAccounting: accounting === "valid" ? cursor : null,
    status,
    terminalAt: status === "completed" ? base.updatedAt : null,
  };
  const stored =
    accounting === "missing"
      ? Object.fromEntries(
          Object.entries(state).filter(([key]) => key !== "goalAccounting"),
        )
      : state;
  database.exec("DROP TABLE thread_goal_events");
  database.exec("PRAGMA user_version = 16");
  database
    .prepare(
      `INSERT INTO run_snapshots (
         tenant_id, space_id, run_id, revision, last_sequence, state_json, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      state.tenantId,
      state.spaceId,
      state.runId,
      state.revision,
      state.lastSequence,
      JSON.stringify(stored),
      state.updatedAt,
    );
  database.close();
}

function hasStoreCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof RunStoreError && error.code === code;
}

function runLocator() {
  return { tenantId: "tenant-1", runId: "run-store-1" } as const;
}

function plainRow(row: unknown): Record<string, unknown> {
  assert.ok(typeof row === "object" && row !== null);
  return Object.fromEntries(Object.entries(row));
}

function legacyRunState(runId: string, spaceId: string) {
  return {
    runId,
    threadId: "thread-conflict",
    tenantId: "tenant-conflict",
    spaceId,
    createdByActorId: "actor-conflict",
    createdAt: "2026-08-08T00:00:01Z",
    updatedAt: "2026-08-08T00:00:02Z",
  };
}

function applicationService(
  store: RunStore,
  scriptedIds: string[],
  timestamp: string,
): RunApplicationService {
  const ids = [...scriptedIds];
  return new RunApplicationService({
    store,
    authorization: {
      authorize: async () => ({ outcome: "allow" }),
    },
    clock: { now: () => timestamp },
    ids: {
      nextId: (_kind: ApplicationIdKind) => {
        const id = ids.shift();
        if (id === undefined) {
          throw new Error("scripted id exhausted");
        }
        return id;
      },
    },
  });
}

function applicationActor(): ActorContext {
  return {
    principalId: "principal-app-1",
    actorId: "actor-app-1",
    tenantId: "tenant-app-1",
    spaceId: "space-app-1",
  };
}
