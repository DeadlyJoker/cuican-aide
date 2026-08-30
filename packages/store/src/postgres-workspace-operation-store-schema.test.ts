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
  test("fails closed when a PostgreSQL list head or exact head revision is corrupt", async () => {
    for (const corruption of ["revisionJson", "extraRevision"] as const) {
      const store = await createTestStore(connectionString);
      try {
        await seedWorkspaceThread(store);
        const prepared = await store.prepareWorkspaceOperation(prepareInput());
        if (corruption === "revisionJson") {
          await store.admin.query(
            `UPDATE ${store.quotedSchema}.workspace_operation_revisions
             SET operation_json = operation_json || '{"unexpected":true}'::jsonb
             WHERE tenant_id = $1 AND execution_id = $2 AND revision = 1`,
            [prepared.operation.tenantId, prepared.operation.executionId],
          );
        } else {
          const extra = unknownWorkspaceRevision(prepared.operation, 2);
          await store.admin.query(
            `INSERT INTO ${store.quotedSchema}.workspace_operation_revisions (
               tenant_id, execution_id, revision, result_digest, operation_json
             ) VALUES ($1, $2, $3, $4, $5::jsonb)`,
            [
              extra.tenantId,
              extra.executionId,
              extra.revision,
              workspaceOperationResultDigest(extra),
              JSON.stringify(extra),
            ],
          );
        }
        await assert.rejects(
          store.listWorkspaceOperations({
            tenantId: prepared.operation.tenantId,
            spaceId: prepared.operation.spaceId,
            threadId: prepared.operation.threadId,
            afterExecutionId: null,
            limit: 100,
          }),
        );
      } finally {
        await store.close();
      }
    }
  });

  test("installs independent workspace operation v2 with strict receipt authority", async () => {
    const store = await createTestStore(connectionString);
    try {
      const migration = await store.admin.query<{ version: number }>(
        `SELECT version FROM ${store.quotedSchema}.schema_migrations
         WHERE component = 'workspace_operation_authority'`,
      );
      assert.deepEqual(migration.rows, [
        { version: POSTGRES_WORKSPACE_OPERATION_SCHEMA_VERSION },
      ]);
      const primaryKey = await store.admin.query<{ column_name: string }>(
        `SELECT column_name
         FROM information_schema.key_column_usage
         WHERE table_schema = $1
           AND table_name = 'workspace_operation_receipts'
           AND constraint_name = 'workspace_operation_receipts_pkey'
         ORDER BY ordinal_position`,
        [store.schemaName],
      );
      assert.deepEqual(
        primaryKey.rows.map(({ column_name }) => column_name),
        ["tenant_id", "space_id", "phase", "scope", "idempotency_key"],
      );
    } finally {
      await store.close();
    }
  });

  test("serializes the same receipt key across independent pools", async () => {
    const first = await createTestStore(connectionString);
    const second = new TestPostgresDomainStore(
      connectionString,
      first.schemaName,
      false,
    );
    await second.migrate();
    try {
      await seedWorkspaceThread(first);
      const results = await Promise.all([
        first.prepareWorkspaceOperation(prepareInput()),
        second.prepareWorkspaceOperation(prepareInput()),
      ]);
      assert.deepEqual(results.map(({ disposition }) => disposition).sort(), [
        "committed",
        "replayed",
      ]);
      assert.deepEqual(results[0]?.operation, results[1]?.operation);
    } finally {
      await second.close();
      await first.close();
    }
  });

  test("refreshes the receipt snapshot after waiting behind a committing writer", async () => {
    const store = await createTestStore(connectionString);
    try {
      await seedWorkspaceThread(store);
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
      const writer = store.prepareWorkspaceOperation(prepareInput());
      await waitForAdvisoryWaiter(
        store.admin,
        held.rows[0]!.classid,
        held.rows[0]!.objid,
        1,
      );
      const loader = store.loadWorkspaceOperationReceipt(
        receiptQuery("execute"),
      );
      await waitForAdvisoryWaiter(
        store.admin,
        held.rows[0]!.classid,
        held.rows[0]!.objid,
        2,
      );
      await blocker.query("COMMIT");
      blocker.release();
      const committed = await writer;
      assert.equal(committed.disposition, "committed");
      assert.deepEqual(await loader, {
        disposition: "replayed",
        operation: committed.operation,
      });
    } finally {
      await store.close();
    }
  });

  test("serializes both execute-cancel winner directions across two pools", async () => {
    for (const winnerPhase of ["execute", "cancel"] as const) {
      const first = await createTestStore(connectionString);
      const second: TestPostgresDomainStore = new TestPostgresDomainStore(
        connectionString,
        first.schemaName,
        false,
      );
      await second.migrate();
      try {
        await seedWorkspaceThread(first);
        const prepared = await first.prepareWorkspaceOperation(prepareInput());
        const executeAttempt = prepared.deliveryAttempt!;
        const execute = await first.claimWorkspaceOperationDelivery({
          tenantId: executeAttempt.tenantId,
          spaceId: executeAttempt.spaceId,
          threadId: executeAttempt.threadId,
          executionId: executeAttempt.executionId,
          attemptNumber: executeAttempt.attemptNumber,
          operationRevision: executeAttempt.operationRevision,
          phase: executeAttempt.phase,
          ownerId: "execute-owner",
          leaseDurationMs: 35_000,
        });
        const cancelReceipt = receiptQuery("cancel");
        const cancelPrepared = await first.prepareWorkspaceOperationAction({
          tenantId: executeAttempt.tenantId,
          spaceId: executeAttempt.spaceId,
          threadId: executeAttempt.threadId,
          executionId: executeAttempt.executionId,
          expectedOperationRevision: executeAttempt.operationRevision,
          phase: "cancel",
          idempotency: cancelReceipt.idempotency,
        });
        const cancelAttempt = cancelPrepared.deliveryAttempt!;
        const cancel = await first.claimWorkspaceOperationDelivery({
          tenantId: cancelAttempt.tenantId,
          spaceId: cancelAttempt.spaceId,
          threadId: cancelAttempt.threadId,
          executionId: cancelAttempt.executionId,
          attemptNumber: cancelAttempt.attemptNumber,
          operationRevision: cancelAttempt.operationRevision,
          phase: cancelAttempt.phase,
          ownerId: "cancel-owner",
          leaseDurationMs: 35_000,
        });
        const executeInput = {
          tenantId: executeAttempt.tenantId,
          spaceId: executeAttempt.spaceId,
          threadId: executeAttempt.threadId,
          executionId: executeAttempt.executionId,
          expectedOperationRevision: executeAttempt.operationRevision,
          deliveryLease: execute.lease!,
          resolution: {
            status: "completed" as const,
            executionId: executeAttempt.executionId,
            actionDigest: executeAttempt.actionDigest,
            commandDigest: executeAttempt.commandDigest,
            providerReceiptId: "execute-receipt",
            entries: [{ name: "README.md", kind: "file" as const }],
            truncated: false,
          },
        };
        const cancelInput = {
          tenantId: cancelAttempt.tenantId,
          spaceId: cancelAttempt.spaceId,
          threadId: cancelAttempt.threadId,
          executionId: cancelAttempt.executionId,
          expectedOperationRevision: cancelAttempt.operationRevision,
          deliveryLease: cancel.lease!,
          resolution: {
            status: "canceled" as const,
            executionId: cancelAttempt.executionId,
            actionDigest: cancelAttempt.actionDigest,
            commandDigest: cancelAttempt.commandDigest,
            providerReceiptId: "cancel-receipt",
          },
        };
        const blocker = await first.admin.connect();
        await blocker.query("BEGIN");
        const xid = await blocker.query<{ xid: string }>(
          "SELECT txid_current()::text AS xid",
        );
        await blocker.query(
          `SELECT execution_id FROM ${first.quotedSchema}.workspace_operations
           WHERE tenant_id = $1 AND execution_id = $2 FOR UPDATE`,
          [executeAttempt.tenantId, executeAttempt.executionId],
        );
        const winnerStore: TestPostgresDomainStore =
          winnerPhase === "execute" ? first : second;
        const loserStore: TestPostgresDomainStore =
          winnerPhase === "execute" ? second : first;
        const winnerInput =
          winnerPhase === "execute" ? executeInput : cancelInput;
        const loserInput =
          winnerPhase === "execute" ? cancelInput : executeInput;
        let winner: Promise<WorkspaceDeliverySettlementResult>;
        let loser: Promise<WorkspaceDeliverySettlementResult>;
        try {
          winner = winnerStore.settleWorkspaceOperationDelivery(winnerInput);
          await waitForTransactionWaiters(first.admin, xid.rows[0]!.xid, 1);
          loser = loserStore.settleWorkspaceOperationDelivery(loserInput);
          await blocker.query("COMMIT");
        } catch (error) {
          await blocker.query("ROLLBACK");
          blocker.release();
          throw error;
        }
        blocker.release();
        const results: WorkspaceDeliverySettlementResult[] = await Promise.all([
          winner,
          loser,
        ]);
        assert.deepEqual(
          results.map(({ outcome }) => outcome),
          ["committed", "lostRace"],
        );
        const winnerOperation = results[0]!.operation;
        assert.equal(
          winnerOperation.status,
          winnerPhase === "execute" ? "completed" : "canceled",
        );
        assert.deepEqual(results[1]!.operation, winnerOperation);
        assert.deepEqual(
          await first.loadWorkspaceOperation({
            tenantId: executeAttempt.tenantId,
            spaceId: executeAttempt.spaceId,
            threadId: executeAttempt.threadId,
            executionId: executeAttempt.executionId,
          }),
          winnerOperation,
        );
        const attempts = await first.listWorkspaceOperationDeliveryAttempts({
          tenantId: executeAttempt.tenantId,
          spaceId: executeAttempt.spaceId,
          threadId: executeAttempt.threadId,
          executionId: executeAttempt.executionId,
          afterAttemptNumber: 0,
          limit: 100,
          view: "audit",
        });
        assert.deepEqual(
          attempts.map(({ phase, settlement }) => ({
            phase,
            settlement: settlement?.kind,
          })),
          winnerPhase === "execute"
            ? [
                { phase: "execute", settlement: "resolution" },
                { phase: "cancel", settlement: "superseded" },
              ]
            : [
                { phase: "execute", settlement: "superseded" },
                { phase: "cancel", settlement: "resolution" },
              ],
        );
        assert.deepEqual(
          await first.loadWorkspaceOperationReceipt(receiptQuery("execute")),
          { disposition: "replayed", operation: winnerOperation },
        );
        assert.deepEqual(
          await first.loadWorkspaceOperationReceipt(cancelReceipt),
          { disposition: "replayed", operation: winnerOperation },
        );
      } finally {
        await second.close();
        await first.close();
      }
    }
  });
}
