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
if (connectionString === undefined) {
  test.skip("Postgres workspace operation authority requires CREWON_TEST_POSTGRES_URL", () => {});
} else {
  registerWorkspaceOperationStoreConformance(
    "PostgresDomainStore workspace operation authority",
    () => createTestStore(connectionString),
  );

  test("keeps a PostgreSQL operation snapshot coherent across a concurrent head commit", async () => {
    const store = await createTestStore(connectionString);
    const blocker = await store.admin.connect();
    const writer = await store.admin.connect();
    try {
      await seedWorkspaceThread(store);
      const prepared = await store.prepareWorkspaceOperation(prepareInput());
      const next = unknownWorkspaceRevision(prepared.operation, 2);
      await blocker.query("BEGIN");
      await blocker.query(
        `LOCK TABLE ${store.quotedSchema}.workspace_operation_revisions
         IN ACCESS EXCLUSIVE MODE`,
      );
      await writer.query("BEGIN");
      await writer.query(
        `UPDATE ${store.quotedSchema}.workspace_operations
         SET revision = $1, status = $2, operation_json = $3::jsonb
         WHERE tenant_id = $4 AND execution_id = $5`,
        [
          next.revision,
          next.status,
          JSON.stringify(next),
          next.tenantId,
          next.executionId,
        ],
      );
      const writerLock = writer.query(
        `LOCK TABLE ${store.quotedSchema}.workspace_operation_revisions
         IN ACCESS EXCLUSIVE MODE`,
      );
      await waitForRelationWaiters(
        store.admin,
        `${store.schemaName}.workspace_operation_revisions`,
        1,
      );
      const snapshot = store.loadWorkspaceOperationSnapshot(
        workspaceOperationLocator(prepared.operation),
      );
      await waitForRelationWaiters(
        store.admin,
        `${store.schemaName}.workspace_operation_revisions`,
        2,
      );
      await blocker.query("COMMIT");
      await writerLock;
      await writer.query(
        `INSERT INTO ${store.quotedSchema}.workspace_operation_revisions (
           tenant_id, execution_id, revision, result_digest, operation_json
         ) VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [
          next.tenantId,
          next.executionId,
          next.revision,
          workspaceOperationResultDigest(next),
          JSON.stringify(next),
        ],
      );
      await writer.query("COMMIT");

      assert.deepEqual(await snapshot, {
        operation: prepared.operation,
        eventSequence: 1,
      });
      assert.deepEqual(
        await store.loadWorkspaceOperationSnapshot(
          workspaceOperationLocator(next),
        ),
        { operation: next, eventSequence: 2 },
      );
    } finally {
      await blocker.query("ROLLBACK").catch(() => {});
      await writer.query("ROLLBACK").catch(() => {});
      blocker.release();
      writer.release();
      await store.close();
    }
  });

  test("uses the exact 64-bit receipt advisory lock key", async () => {
    const store = await createTestStore(connectionString);
    try {
      await seedWorkspaceThread(store);
      await store.prepareWorkspaceOperation(prepareInput());
      const blocker = await store.admin.connect();
      await blocker.query("BEGIN");
      const lockKey = receiptLockKey(store.schemaName);
      await blocker.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [lockKey],
      );
      const held = await blocker.query<{ classid: string; objid: string }>(
        `SELECT classid::text, objid::text FROM pg_locks
         WHERE pid = pg_backend_pid() AND locktype = 'advisory' AND granted`,
      );
      const replay = store.loadWorkspaceOperationReceipt(
        receiptQuery("execute"),
      );
      try {
        await waitForAdvisoryWaiter(
          store.admin,
          held.rows[0]!.classid,
          held.rows[0]!.objid,
        );
      } finally {
        await blocker.query("COMMIT");
        blocker.release();
      }
      assert.equal((await replay)?.disposition, "replayed");
    } finally {
      await store.close();
    }
  });

  test("settlement never waits for or updates the immutable receipt", async () => {
    const store = await createTestStore(connectionString);
    try {
      await seedWorkspaceThread(store);
      const prepared = await store.prepareWorkspaceOperation(prepareInput());
      const attempt = prepared.deliveryAttempt!;
      const leased = await store.claimWorkspaceOperationDelivery({
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
      const blocker = await store.admin.connect();
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [receiptLockKey(store.schemaName)],
      );
      try {
        const settled = await store.settleWorkspaceOperationDelivery({
          tenantId: attempt.tenantId,
          spaceId: attempt.spaceId,
          threadId: attempt.threadId,
          executionId: attempt.executionId,
          expectedOperationRevision: attempt.operationRevision,
          deliveryLease: leased.lease!,
          resolution: {
            status: "completed",
            executionId: attempt.executionId,
            actionDigest: attempt.actionDigest,
            commandDigest: attempt.commandDigest,
            providerReceiptId: "receipt-1",
            entries: [{ name: "README.md", kind: "file" }],
            truncated: false,
          },
        });
        assert.equal(settled.outcome, "committed");
      } finally {
        await blocker.query("COMMIT");
        blocker.release();
      }
    } finally {
      await store.close();
    }
  });

  test("fails closed on receipt substitution and component schema drift", async () => {
    const store = await createTestStore(connectionString);
    try {
      await seedWorkspaceThread(store);
      await store.prepareWorkspaceOperation(prepareInput());
      await store.admin.query(
        `UPDATE ${store.quotedSchema}.workspace_operation_receipts
         SET action_digest = $1`,
        [`sha256:${"f".repeat(64)}`],
      );
      await assert.rejects(
        store.loadWorkspaceOperationReceipt(receiptQuery("execute")),
        hasCode("workspace_operation_stored_state_invalid"),
      );
      await store.admin.query(
        `ALTER TABLE ${store.quotedSchema}.workspace_operation_receipts
         DROP CONSTRAINT workspace_operation_receipts_operation_fkey`,
      );
      await assert.rejects(
        store.migrate(),
        hasCode("postgres_schema_version_unsupported"),
      );
    } finally {
      await store.close();
    }
  });

  test("fails closed on missing receipt PK and required columns", async () => {
    for (const mutation of [
      "ALTER TABLE __SCHEMA__.workspace_operation_receipts DROP CONSTRAINT workspace_operation_receipts_pkey",
      "ALTER TABLE __SCHEMA__.workspace_operation_receipts DROP COLUMN command_digest CASCADE",
      "ALTER TABLE __SCHEMA__.workspace_delivery_attempts DROP CONSTRAINT workspace_delivery_attempts_result_fkey",
    ]) {
      const store = await createTestStore(connectionString);
      try {
        await store.admin.query(
          mutation.replace("__SCHEMA__", store.quotedSchema),
        );
        await assert.rejects(
          store.migrate(),
          hasCode("postgres_schema_version_unsupported"),
        );
      } finally {
        await store.close();
      }
    }
  });

  test("fails closed when an attempt column drifts from its canonical JSON", async () => {
    const store = await createTestStore(connectionString);
    try {
      await seedWorkspaceThread(store);
      await store.prepareWorkspaceOperation(prepareInput());
      await store.admin.query(
        `UPDATE ${store.quotedSchema}.workspace_delivery_attempts
         SET phase = 'cancel'
         WHERE tenant_id = 'tenant-1' AND execution_id = 'workspace-execution-1'
           AND attempt_number = 1`,
      );
      await assert.rejects(
        store.loadWorkspaceOperationReceipt(receiptQuery("execute")),
        hasCode("workspace_delivery_stored_state_invalid"),
      );
    } finally {
      await store.close();
    }
  });

  test("rejects a future workspace component before creating its tables", async () => {
    const schema = `crewon_workspace_future_${randomUUID().replaceAll("-", "_")}`;
    const options = {
      connectionString,
      schema,
      maxPoolSize: 2,
      statementTimeoutMs: 2_000,
    };
    const threads = await PostgresThreadStore.open(options);
    await threads.close();
    const store = new TestPostgresDomainStore(connectionString, schema);
    try {
      await store.admin.query(
        `INSERT INTO ${store.quotedSchema}.schema_migrations (component, version)
         VALUES ('workspace_operation_authority', $1)`,
        [POSTGRES_WORKSPACE_OPERATION_SCHEMA_VERSION + 1],
      );
      await assert.rejects(store.migrate(), hasCode("postgres_schema_too_new"));
      const tables = await store.admin.query<{
        operation: string | null;
        receipt: string | null;
      }>(
        "SELECT to_regclass($1)::text AS operation, to_regclass($2)::text AS receipt",
        [
          `${schema}.workspace_operations`,
          `${schema}.workspace_operation_receipts`,
        ],
      );
      assert.deepEqual(tables.rows, [{ operation: null, receipt: null }]);
    } finally {
      await store.close();
    }
  });
}
