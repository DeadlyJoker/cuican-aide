import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";

import { RunStoreError } from "@crewon/application";
import { Pool } from "pg";

import { PostgresWorkflowRunCompositionStore } from "./postgres-workflow-run-composition-store.ts";
import { createRunningCommitFixture } from "./run-store-conformance.test-support.ts";
import { seedThread } from "./thread-store-conformance.test-support.ts";

const postgresUrl = process.env.CREWON_TEST_POSTGRES_URL;
const REQUEST_DIGEST = `sha256:${"a".repeat(64)}`;
const CHECKPOINT_DIGEST = `sha256:${"b".repeat(64)}`;
const digester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};

test(
  "PostgreSQL model dispatch evidence is fenced, CAS-idempotent, and terminal",
  { skip: postgresUrl === undefined },
  async (context) => {
    const fixture = await receiptFixture(context);
    const prepared = await fixture.store.prepareModelDispatch(fixture.prepare);
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
    const transition = {
      tenantId: fixture.prepare.tenantId,
      runId: fixture.prepare.runId,
      lease: fixture.prepare.lease,
      attempt: fixture.prepare.attempt,
      operationId: fixture.prepare.operationId,
      requestSequence: 1,
      expectedRevision: prepared.revision,
      transitionedAt: "2026-08-08T00:01:02Z",
    } as const;
    const sent = await fixture.store.markModelDispatchPossiblySent(transition);
    assert.deepEqual(
      await fixture.store.markModelDispatchPossiblySent(transition),
      sent,
    );
    const observed = await fixture.store.observeModelDispatchResponse({
      ...transition,
      expectedRevision: sent.revision,
      checkpointDigest: CHECKPOINT_DIGEST,
      transitionedAt: "2026-08-08T00:01:03Z",
    });
    const terminalInput = {
      ...transition,
      expectedRevision: observed.revision,
      outcome: {
        kind: "completed",
        code: null,
        certainty: "responseObserved",
      },
      transitionedAt: "2026-08-08T00:01:04Z",
    } as const;
    const terminal = await fixture.store.terminateModelDispatch(terminalInput);
    assert.deepEqual(
      await fixture.store.terminateModelDispatch(terminalInput),
      terminal,
    );
    assert.deepEqual(
      await fixture.store.loadModelDispatchReceipt({
        tenantId: fixture.prepare.tenantId,
        runId: fixture.prepare.runId,
        ...fixture.prepare.attempt,
        operationId: fixture.prepare.operationId,
      }),
      terminal,
    );
  },
);

test(
  "PostgreSQL checkpoints an Attempt and response evidence atomically",
  { skip: postgresUrl === undefined },
  async (context) => {
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
    const checkpoint = {
      schemaVersion: "crewon.provider-checkpoint.v0" as const,
      adapterName: "responses",
      adapterVersion: "1",
      modelId: "gpt-test",
      opaquePayload: { responseId: "response-1" },
    };

    const attempt = await fixture.store.checkpointRunAttempt({
      tenantId: fixture.prepare.tenantId,
      runId: fixture.prepare.runId,
      lease: fixture.prepare.lease,
      attempt: fixture.prepare.attempt,
      checkpoint,
      checkpointDigest: CHECKPOINT_DIGEST,
      checkpointedAt: "2026-08-08T00:01:03Z",
      modelDispatch: {
        operationId: fixture.prepare.operationId,
        requestSequence: fixture.prepare.requestSequence,
        expectedRevision: sent.revision,
      },
    });

    assert.deepEqual(attempt.providerCheckpoint, checkpoint);
    assert.equal(attempt.checkpointDigest, CHECKPOINT_DIGEST);
    assert.deepEqual(
      await fixture.store.loadModelDispatchReceipt({
        tenantId: fixture.prepare.tenantId,
        runId: fixture.prepare.runId,
        ...fixture.prepare.attempt,
        operationId: fixture.prepare.operationId,
      }),
      {
        ...sent,
        status: "responseObserved",
        revision: sent.revision + 1,
        responseObservedAt: "2026-08-08T00:01:03Z",
        responseCheckpointDigest: CHECKPOINT_DIGEST,
        updatedAt: "2026-08-08T00:01:03Z",
      },
    );
  },
);

test(
  "PostgreSQL model dispatch rejects stale leases and indexed/JSON tampering",
  { skip: postgresUrl === undefined },
  async (context) => {
    const fixture = await receiptFixture(context);
    const prepared = await fixture.store.prepareModelDispatch(fixture.prepare);
    await assert.rejects(
      fixture.store.markModelDispatchPossiblySent({
        tenantId: fixture.prepare.tenantId,
        runId: fixture.prepare.runId,
        lease: { ...fixture.prepare.lease, leaseEpoch: 99 },
        attempt: fixture.prepare.attempt,
        operationId: fixture.prepare.operationId,
        requestSequence: 1,
        expectedRevision: prepared.revision,
        transitionedAt: "2026-08-08T00:01:02Z",
      }),
      storeCode("stale_lease"),
    );
    await fixture.pool.query(
      `UPDATE ${fixture.schemaSql}.model_dispatch_receipts
       SET state_json=jsonb_set(state_json, '{requestDigest}', to_jsonb($1::text))`,
      [`sha256:${"e".repeat(64)}`],
    );
    await assert.rejects(
      fixture.store.loadModelDispatchReceipt({
        tenantId: fixture.prepare.tenantId,
        runId: fixture.prepare.runId,
        ...fixture.prepare.attempt,
        operationId: fixture.prepare.operationId,
      }),
      storeCode("stored_model_dispatch_receipt_invalid"),
    );
  },
);

test(
  "PostgreSQL physically gates a forged current model dispatch schema",
  { skip: postgresUrl === undefined },
  async (context) => {
    const fixture = await postgresFixture(context);
    await fixture.pool.query(
      `DROP TABLE ${fixture.schemaSql}.model_dispatch_receipts`,
    );
    await fixture.pool
      .query(`CREATE TABLE ${fixture.schemaSql}.model_dispatch_receipts (
      tenant_id text, run_id text, step_id text, attempt_id text, operation_id text
    )`);
    await assert.rejects(
      fixture.store.migrate(),
      storeCode("postgres_schema_version_unsupported"),
    );
  },
);

async function receiptFixture(context: TestContext) {
  const fixture = await postgresFixture(context);
  await seedThread(fixture.store);
  await fixture.store.commitRun(createRunningCommitFixture());
  const claim = await fixture.store.claimNextWorkItem({
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
  await fixture.store.beginRunAttempt({
    tenantId: "tenant-1",
    runId: "run-store-1",
    lease,
    stepId: attempt.stepId,
    kind: "model",
    attemptId: attempt.attemptId,
    startedAt: "2026-08-08T00:01:01Z",
  });
  return {
    ...fixture,
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

async function postgresFixture(context: TestContext) {
  const schema = `model_dispatch_${randomUUID().replaceAll("-", "")}`;
  const schemaSql = `"${schema}"`;
  const pool = new Pool({ connectionString: postgresUrl });
  const store = await PostgresWorkflowRunCompositionStore.open({
    pool,
    schema,
    digester,
  });
  context.after(async () => {
    await store.close();
    await pool.query(`DROP SCHEMA IF EXISTS ${schemaSql} CASCADE`);
    await pool.end();
  });
  return { pool, schemaSql, store };
}

function storeCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof RunStoreError && error.code === code;
}
