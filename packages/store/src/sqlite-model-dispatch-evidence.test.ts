import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";

import { RunStoreError } from "@crewon/application";

import {
  createRunningCommitFixture,
  ManualLeaseClock,
} from "./run-store-conformance.test-support.ts";
import { seedThread } from "./thread-store-conformance.test-support.ts";
import { SqliteRunStore } from "./sqlite-run-store.ts";
import { SQLITE_SCHEMA_VERSION } from "./sqlite-schema.ts";

const REQUEST_DIGEST = `sha256:${"a".repeat(64)}`;
const CHECKPOINT_DIGEST = `sha256:${"b".repeat(64)}`;

test("SQLite model dispatch evidence is fenced, CAS-idempotent, and durable", async (context) => {
  const fixture = await receiptFixture(context);
  const prepared = await fixture.store.prepareModelDispatch(fixture.prepare);
  assert.equal(prepared.status, "prepared");
  assert.deepEqual(
    await fixture.store.prepareModelDispatch(fixture.prepare),
    prepared,
  );
  await assert.rejects(
    fixture.store.prepareModelDispatch({
      ...fixture.prepare,
      requestDigest: `sha256:${"c".repeat(64)}`,
    }),
    storeCode("model_dispatch_receipt_conflict"),
  );

  const sentInput = {
    tenantId: fixture.prepare.tenantId,
    runId: fixture.prepare.runId,
    lease: fixture.prepare.lease,
    attempt: fixture.prepare.attempt,
    operationId: fixture.prepare.operationId,
    requestSequence: fixture.prepare.requestSequence,
    expectedRevision: prepared.revision,
    transitionedAt: "2026-08-08T00:01:02Z",
  } as const;
  const sent = await fixture.store.markModelDispatchPossiblySent(sentInput);
  assert.deepEqual(
    await fixture.store.markModelDispatchPossiblySent(sentInput),
    sent,
  );
  const observed = await fixture.store.observeModelDispatchResponse({
    ...sentInput,
    expectedRevision: sent.revision,
    checkpointDigest: CHECKPOINT_DIGEST,
    transitionedAt: "2026-08-08T00:01:03Z",
  });
  await assert.rejects(
    fixture.store.terminateModelDispatch({
      ...sentInput,
      expectedRevision: 1,
      outcome: {
        kind: "failed",
        code: "stale",
        certainty: "responseObserved",
      },
      transitionedAt: "2026-08-08T00:01:04Z",
    }),
    storeCode("model_dispatch_revision_conflict"),
  );
  fixture.clock.advance(60_001);

  await fixture.store.close();
  const reopened = new SqliteRunStore(fixture.path, { clock: fixture.clock });
  context.after(() => reopened.close());
  assert.deepEqual(
    await reopened.loadModelDispatchReceipt({
      tenantId: fixture.prepare.tenantId,
      runId: fixture.prepare.runId,
      ...fixture.prepare.attempt,
      operationId: fixture.prepare.operationId,
    }),
    observed,
  );
});

test("SQLite model dispatch evidence rejects stale leases and stored tampering", async (context) => {
  const fixture = await receiptFixture(context);
  const prepared = await fixture.store.prepareModelDispatch(fixture.prepare);
  await assert.rejects(
    fixture.store.markModelDispatchPossiblySent({
      tenantId: fixture.prepare.tenantId,
      runId: fixture.prepare.runId,
      lease: { ...fixture.prepare.lease, leaseEpoch: 99 },
      attempt: fixture.prepare.attempt,
      operationId: fixture.prepare.operationId,
      requestSequence: fixture.prepare.requestSequence,
      expectedRevision: prepared.revision,
      transitionedAt: "2026-08-08T00:01:02Z",
    }),
    storeCode("stale_lease"),
  );

  const database = new DatabaseSync(fixture.path);
  database
    .prepare(
      `UPDATE model_dispatch_receipts
       SET state_json = json_set(state_json, '$.requestDigest', ?)
       WHERE attempt_id = ?`,
    )
    .run(`sha256:${"d".repeat(64)}`, fixture.prepare.attempt.attemptId);
  database.close();
  await assert.rejects(
    fixture.store.loadModelDispatchReceipt({
      tenantId: fixture.prepare.tenantId,
      runId: fixture.prepare.runId,
      ...fixture.prepare.attempt,
      operationId: fixture.prepare.operationId,
    }),
    storeCode("stored_model_dispatch_receipt_invalid"),
  );
});

test("SQLite rolls back provider checkpoint when response evidence cannot commit", async (context) => {
  const fixture = await receiptFixture(context);
  const prepared = await fixture.store.prepareModelDispatch(fixture.prepare);
  const sent = await fixture.store.markModelDispatchPossiblySent({
    tenantId: fixture.prepare.tenantId,
    runId: fixture.prepare.runId,
    lease: fixture.prepare.lease,
    attempt: fixture.prepare.attempt,
    operationId: fixture.prepare.operationId,
    requestSequence: fixture.prepare.requestSequence,
    expectedRevision: prepared.revision,
    transitionedAt: "2026-08-08T00:01:02Z",
  });
  const database = new DatabaseSync(fixture.path);
  database
    .prepare(
      `UPDATE model_dispatch_receipts
       SET state_json = json_set(state_json, '$.requestDigest', ?)
       WHERE attempt_id = ? AND request_sequence = ?`,
    )
    .run(
      `sha256:${"d".repeat(64)}`,
      fixture.prepare.attempt.attemptId,
      fixture.prepare.requestSequence,
    );
  database.close();

  await assert.rejects(
    fixture.store.checkpointRunAttempt({
      tenantId: fixture.prepare.tenantId,
      runId: fixture.prepare.runId,
      lease: fixture.prepare.lease,
      attempt: fixture.prepare.attempt,
      checkpoint: {
        schemaVersion: "crewon.provider-checkpoint.v0",
        adapterName: "responses",
        adapterVersion: "1",
        modelId: "gpt-test",
        opaquePayload: { responseId: "response-1" },
      },
      checkpointDigest: CHECKPOINT_DIGEST,
      checkpointedAt: "2026-08-08T00:01:03Z",
      modelDispatch: {
        requestSequence: fixture.prepare.requestSequence,
        operationId: fixture.prepare.operationId,
        expectedRevision: sent.revision,
      },
    }),
    storeCode("stored_model_dispatch_receipt_invalid"),
  );
  assert.equal(
    (
      await fixture.store.loadRunAttempt({
        tenantId: fixture.prepare.tenantId,
        runId: fixture.prepare.runId,
        ...fixture.prepare.attempt,
      })
    )?.providerCheckpoint,
    null,
  );
});

test("SQLite migrates v23 and physically gates a forged current receipt table", async (context) => {
  const path = temporaryDatabasePath(context);
  const initialized = new SqliteRunStore(path);
  await initialized.close();
  const old = new DatabaseSync(path);
  old.exec(`
    DROP TABLE model_dispatch_receipts;
    PRAGMA user_version = 23;
  `);
  old.close();
  const migrated = new SqliteRunStore(path);
  await migrated.close();
  const inspected = new DatabaseSync(path);
  assert.equal(
    (inspected.prepare("PRAGMA user_version").get() as { user_version: number })
      .user_version,
    SQLITE_SCHEMA_VERSION,
  );
  inspected.exec(`
    ALTER TABLE model_dispatch_receipts RENAME TO valid_model_dispatch_receipts;
    CREATE TABLE model_dispatch_receipts (
      tenant_id TEXT, run_id TEXT, step_id TEXT, attempt_id TEXT,
      operation_id TEXT, request_sequence INTEGER, operation TEXT,
      work_item_id TEXT, lease_epoch INTEGER, request_digest TEXT,
      status TEXT, revision INTEGER, state_json TEXT, prepared_at TEXT,
      updated_at TEXT
    );
  `);
  inspected.close();
  assert.throws(
    () => new SqliteRunStore(path),
    storeCode("sqlite_schema_version_unsupported"),
  );
});

async function receiptFixture(context: TestContext) {
  const path = temporaryDatabasePath(context);
  const clock = new ManualLeaseClock();
  const store = new SqliteRunStore(path, { clock });
  await seedThread(store);
  await store.commitRun(createRunningCommitFixture());
  const claim = await store.claimNextWorkItem({
    ownerId: "dispatch-worker",
    leaseId: "dispatch-lease",
    leaseDurationMs: 60_000,
  });
  assert.ok(claim !== null);
  const lease = {
    workItemId: claim.workItem.workItemId,
    ownerId: claim.lease.ownerId,
    leaseId: claim.lease.leaseId,
    leaseEpoch: claim.lease.epoch,
  } as const;
  const attempt = { stepId: "work-item-1", attemptId: "attempt-dispatch-1" };
  await store.beginRunAttempt({
    tenantId: "tenant-1",
    lease,
    runId: "run-store-1",
    stepId: attempt.stepId,
    kind: "model",
    attemptId: attempt.attemptId,
    startedAt: "2026-08-08T00:01:01Z",
  });
  return {
    path,
    clock,
    store,
    prepare: {
      tenantId: "tenant-1",
      runId: "run-store-1",
      lease,
      attempt,
      operationId: "segment:attempt-dispatch-1:request:1",
      requestSequence: 1,
      operation: "dispatch",
      requestDigest: REQUEST_DIGEST,
      provider: {
        agentVersionId: "agent-version-1",
        adapterName: "responses",
        adapterVersion: "1",
        modelId: "gpt-test",
      },
      preparedAt: "2026-08-08T00:01:01Z",
    } as const,
  };
}

function temporaryDatabasePath(context: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "crewon-model-dispatch-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "runs.sqlite3");
}

function storeCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof RunStoreError && error.code === code;
}
