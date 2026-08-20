import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { Pool } from "pg";

import {
  validateWorkspaceOperationRecord,
  type WorkspaceDeliverySettlementResult,
  type WorkspaceOperationRecord,
} from "@crewon/application";

import { POSTGRES_WORKSPACE_OPERATION_SCHEMA_VERSION } from "./postgres-workspace-operation-schema.ts";
import { PostgresDomainStore } from "./postgres-domain-store.ts";
import { PostgresThreadStore } from "./postgres-thread-store.ts";
import {
  prepareInput,
  receiptQuery,
  registerWorkspaceOperationStoreConformance,
  seedWorkspaceThread,
} from "./workspace-operation-store-conformance.test-support.ts";
import { workspaceOperationResultDigest } from "./workspace-operation-store-support.ts";

import {
  TestPostgresDomainStore,
  createTestStore,
  receiptLockKey,
  unknownWorkspaceRevision,
  workspaceOperationLocator,
  waitForAdvisoryWaiter,
  waitForRelationWaiters,
  waitForTransactionWaiters,
  hasCode,
} from "./postgres-workspace-operation-store.test-support.ts";
const connectionString = process.env.CREWON_TEST_POSTGRES_URL;
if (connectionString !== undefined) {
  test("bounds PostgreSQL snapshot and high-cursor reads independently of old revisions", async () => {
    const store = await createTestStore(connectionString);
    try {
      await seedWorkspaceThread(store);
      const prepared = await store.prepareWorkspaceOperation(prepareInput());
      const revisions: Array<{
        tenantId: string;
        executionId: string;
        revision: number;
        resultDigest: string;
        operation: WorkspaceOperationRecord;
      }> = [];
      let head = prepared.operation;
      for (let revision = 2; revision <= 150; revision += 1) {
        head = unknownWorkspaceRevision(prepared.operation, revision);
        revisions.push({
          tenantId: head.tenantId,
          executionId: head.executionId,
          revision,
          resultDigest: workspaceOperationResultDigest(head),
          operation: head,
        });
      }
      await store.admin.query(
        `INSERT INTO ${store.quotedSchema}.workspace_operation_revisions (
           tenant_id, execution_id, revision, result_digest, operation_json
         )
         SELECT tenant_id, execution_id, revision, result_digest, operation_json
         FROM jsonb_to_recordset($1::jsonb) AS rows(
           tenant_id TEXT, execution_id TEXT, revision BIGINT,
           result_digest TEXT, operation_json JSONB
         )`,
        [
          JSON.stringify(
            revisions.map((revision) => ({
              tenant_id: revision.tenantId,
              execution_id: revision.executionId,
              revision: revision.revision,
              result_digest: revision.resultDigest,
              operation_json: revision.operation,
            })),
          ),
        ],
      );
      await store.admin.query(
        `UPDATE ${store.quotedSchema}.workspace_operations
         SET revision = $1, status = $2, operation_json = $3::jsonb
         WHERE tenant_id = $4 AND execution_id = $5`,
        [
          head.revision,
          head.status,
          JSON.stringify(head),
          head.tenantId,
          head.executionId,
        ],
      );
      await store.admin.query(
        `UPDATE ${store.quotedSchema}.workspace_operation_revisions
         SET operation_json = operation_json || '{"unexpected":true}'::jsonb
         WHERE tenant_id = $1 AND execution_id = $2 AND revision = 1`,
        [head.tenantId, head.executionId],
      );

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
    } finally {
      await store.close();
    }
  });

  test("receipt replay does not wait for later operation or attempt locks", async () => {
    const store = await createTestStore(connectionString);
    try {
      await seedWorkspaceThread(store);
      const prepared = await store.prepareWorkspaceOperation(prepareInput());
      const blocker = await store.admin.connect();
      await blocker.query("BEGIN");
      await blocker.query(
        `SELECT execution_id FROM ${store.quotedSchema}.workspace_operations
         WHERE tenant_id = $1 AND execution_id = $2 FOR UPDATE`,
        [prepared.operation.tenantId, prepared.operation.executionId],
      );
      await blocker.query(
        `SELECT attempt_number FROM ${store.quotedSchema}.workspace_delivery_attempts
         WHERE tenant_id = $1 AND execution_id = $2 AND attempt_number = 1
         FOR UPDATE`,
        [prepared.operation.tenantId, prepared.operation.executionId],
      );
      try {
        assert.deepEqual(
          await store.loadWorkspaceOperationReceipt(receiptQuery("execute")),
          {
            disposition: "replayed",
            operation: prepared.operation,
            deliveryAttempt: prepared.deliveryAttempt,
          },
        );
      } finally {
        await blocker.query("COMMIT");
        blocker.release();
      }
    } finally {
      await store.close();
    }
  });

  test("requires explicit reconcile after a database-authoritative lease expiry", async () => {
    const store = await createTestStore(connectionString);
    try {
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
      await store.admin.query(
        `WITH frozen AS (
           SELECT to_char(
             clock_timestamp() AT TIME ZONE 'UTC' - interval '1 millisecond',
             'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
           ) AS past
         )
         UPDATE ${store.quotedSchema}.workspace_delivery_attempts AS attempts
         SET expires_at = frozen.past::timestamptz,
             attempt_json = jsonb_set(
               attempts.attempt_json,
               '{lease,expiresAt}',
               to_jsonb(frozen.past)
             )
         FROM frozen
         WHERE attempts.tenant_id = $1 AND attempts.execution_id = $2
           AND attempts.attempt_number = 1`,
        [attempt.tenantId, attempt.executionId],
      );
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
        hasCode("workspace_delivery_reconcile_required"),
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
      assert.deepEqual(
        (
          await store.listWorkspaceOperationDeliveryAttempts({
            tenantId: attempt.tenantId,
            spaceId: attempt.spaceId,
            threadId: attempt.threadId,
            executionId: attempt.executionId,
            afterAttemptNumber: 0,
            limit: 100,
            view: "audit",
          })
        ).map(({ phase, status, settlement }) => ({
          phase,
          status,
          settlement: settlement?.kind ?? null,
        })),
        [
          { phase: "execute", status: "settled", settlement: "leaseExpired" },
          { phase: "reconcile", status: "pending", settlement: null },
        ],
      );
    } finally {
      await store.close();
    }
  });

  test("migrates workspace v1 data and freezes its legacy receipt at the head", async () => {
    const schema = `crewon_workspace_v1_${randomUUID().replaceAll("-", "_")}`;
    const threads = await PostgresThreadStore.open({
      connectionString,
      schema,
      maxPoolSize: 2,
      statementTimeoutMs: 2_000,
    });
    await threads.close();
    const store = new TestPostgresDomainStore(connectionString, schema);
    const input = prepareInput();
    const query = receiptQuery("execute");
    try {
      await store.admin.query(`
        CREATE TABLE ${store.quotedSchema}.workspace_operations (
          tenant_id TEXT NOT NULL,
          space_id TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          execution_id TEXT NOT NULL,
          revision BIGINT NOT NULL CONSTRAINT workspace_operations_revision_check
            CHECK (revision >= 1),
          status TEXT NOT NULL,
          action_digest TEXT NOT NULL,
          command_digest TEXT NOT NULL,
          operation_json JSONB NOT NULL,
          CONSTRAINT workspace_operations_pkey
            PRIMARY KEY (tenant_id, execution_id)
        );
        CREATE INDEX workspace_operations_thread_idx
          ON ${store.quotedSchema}.workspace_operations
          (tenant_id, space_id, thread_id, execution_id);
        CREATE TABLE ${store.quotedSchema}.workspace_operation_receipts (
          tenant_id TEXT NOT NULL,
          space_id TEXT NOT NULL,
          phase TEXT NOT NULL,
          scope TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          execution_id TEXT NOT NULL,
          action_digest TEXT NOT NULL,
          command_digest TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          CONSTRAINT workspace_operation_receipts_pkey
            PRIMARY KEY (tenant_id, space_id, phase, scope, idempotency_key),
          CONSTRAINT workspace_operation_receipts_operation_fkey
            FOREIGN KEY (tenant_id, execution_id)
            REFERENCES ${store.quotedSchema}.workspace_operations(
              tenant_id, execution_id
            ) ON DELETE RESTRICT
        );
        INSERT INTO ${store.quotedSchema}.schema_migrations (component, version)
        VALUES ('workspace_operation_authority', 1);
      `);
      await store.admin.query(
        `INSERT INTO ${store.quotedSchema}.workspace_operations (
           tenant_id, space_id, thread_id, execution_id, revision, status,
           action_digest, command_digest, operation_json
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
        [
          input.operation.tenantId,
          input.operation.spaceId,
          input.operation.threadId,
          input.operation.executionId,
          input.operation.revision,
          input.operation.status,
          input.operation.command.actionDigest,
          input.operation.command.commandDigest,
          JSON.stringify(input.operation),
        ],
      );
      await store.admin.query(
        `INSERT INTO ${store.quotedSchema}.workspace_operation_receipts (
           tenant_id, space_id, phase, scope, idempotency_key, thread_id,
           execution_id, action_digest, command_digest, fingerprint
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          query.tenantId,
          query.spaceId,
          query.phase,
          query.idempotency.scope,
          query.idempotency.key,
          input.operation.threadId,
          input.operation.executionId,
          input.operation.command.actionDigest,
          input.operation.command.commandDigest,
          query.idempotency.requestFingerprint,
        ],
      );
      await store.migrate();
      assert.deepEqual(await store.loadWorkspaceOperationReceipt(query), {
        disposition: "replayed",
        operation: input.operation,
        deliveryAttempt: null,
      });
      const migration = await store.admin.query<{ version: number }>(
        `SELECT version FROM ${store.quotedSchema}.schema_migrations
         WHERE component = 'workspace_operation_authority'`,
      );
      assert.deepEqual(migration.rows, [
        { version: POSTGRES_WORKSPACE_OPERATION_SCHEMA_VERSION },
      ]);
    } finally {
      await store.close();
    }
  });
}
