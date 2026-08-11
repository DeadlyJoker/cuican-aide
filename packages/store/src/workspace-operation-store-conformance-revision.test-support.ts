import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test, type TestContext } from "node:test";

import {
  canonicalWorkspaceListAction,
  canonicalWorkspaceListDispatchCommand,
  type DomainStore,
  type IdempotencyDescriptor,
  type WorkspaceDeliveryAttempt,
  type WorkspaceListResolution,
  type WorkspaceOperationRecord,
} from "@crewon/application";
import type { ThreadLifecycleEvent } from "@crewon/domain";

type ConformanceStore = DomainStore;
import {
  deliveryIdentity,
  claim,
  deliveryLocator,
  pendingAttempt,
  seedWorkspaceThread,
  prepareInput,
  prepareExecution,
  operation,
  receiptQuery,
  resolution,
  locator,
  attemptQuery,
  executeIdempotency,
  reconcileIdempotency,
  cancelIdempotency,
  idempotency,
  renameWorkspaceThread,
  managed,
  sha256,
  hasCode,
} from "./workspace-operation-store-conformance.test-support.ts";
export function registerWorkspaceOperationStoreRevisionConformance(
  name: string,
  createStore: () => ConformanceStore | Promise<ConformanceStore>,
): void {
  describe(name, () => {
    test("lists 100 of 101 thread-scoped heads with a proven lexicographic recovery cursor", async (context) => {
      const store = await managed(context, createStore);
      await seedWorkspaceThread(store);
      const operations: WorkspaceOperationRecord[] = [];
      for (let index = 0; index < 101; index += 1) {
        const input = prepareExecution(
          `workspace-page-${String(index).padStart(3, "0")}`,
        );
        operations.push(
          (await store.prepareWorkspaceOperation(input)).operation,
        );
      }
      const first = await store.listWorkspaceOperations({
        tenantId: "tenant-1",
        spaceId: "space-1",
        threadId: "thread-1",
        afterExecutionId: null,
        limit: 100,
      });
      assert.deepEqual(first, {
        operations: operations.slice(0, 100),
        nextAfterExecutionId: "workspace-page-099",
      });
      assert.deepEqual(
        await store.listWorkspaceOperations({
          tenantId: "tenant-1",
          spaceId: "space-1",
          threadId: "thread-1",
          afterExecutionId: first.nextAfterExecutionId,
          limit: 100,
        }),
        { operations: [operations[100]!], nextAfterExecutionId: null },
      );
      assert.deepEqual(
        await store.listWorkspaceOperations({
          tenantId: "tenant-1",
          spaceId: "space-2",
          threadId: "thread-1",
          afterExecutionId: null,
          limit: 100,
        }),
        { operations: [], nextAfterExecutionId: null },
      );
      await assert.rejects(
        store.listWorkspaceOperations({
          tenantId: "tenant-1",
          spaceId: "space-1",
          threadId: "thread-1",
          afterExecutionId: null,
          limit: 101,
        }),
        hasCode("workspace_operation_list_query_invalid"),
      );
    });

    test("rejects changed payload for the same physical receipt key", async (context) => {
      const store = await managed(context, createStore);
      await seedWorkspaceThread(store);
      await store.prepareWorkspaceOperation(prepareInput());
      await assert.rejects(
        store.prepareWorkspaceOperation({
          ...prepareInput(),
          idempotency: {
            ...executeIdempotency(),
            requestFingerprint: sha256("changed"),
          },
        }),
        hasCode("workspace_operation_idempotency_conflict"),
      );
    });

    test("recovers crash-prepared and unknown states only through explicit actions", async (context) => {
      const store = await managed(context, createStore);
      await seedWorkspaceThread(store);
      const prepared = await store.prepareWorkspaceOperation(prepareInput());
      const recovery = await store.prepareWorkspaceOperationAction({
        ...locator(prepared.operation),
        expectedOperationRevision: prepared.operation.revision,
        phase: "reconcile",
        idempotency: reconcileIdempotency(),
      });
      assert.equal(recovery.operation.revision, 1);
      assert.equal(recovery.deliveryAttempt?.phase, "reconcile");
      const recoveryAttempts =
        await store.listWorkspaceOperationDeliveryAttempts(
          attemptQuery(prepared.operation),
        );
      assert.deepEqual(
        recoveryAttempts.map(({ phase, status, lease, settlement }) => ({
          phase,
          status,
          lease,
          settlement: settlement?.kind ?? null,
        })),
        [
          {
            phase: "execute",
            status: "settled",
            lease: null,
            settlement: "superseded",
          },
          {
            phase: "reconcile",
            status: "pending",
            lease: null,
            settlement: null,
          },
        ],
      );
      const leased = await claim(store, recovery.deliveryAttempt!, "owner-1");
      const completed = await store.settleWorkspaceOperationDelivery({
        ...locator(recovery.operation),
        expectedOperationRevision: recovery.operation.revision,
        deliveryLease: leased.lease!,
        resolution: resolution(recovery.operation, "completed"),
      });
      assert.equal(completed.operation.status, "completed");
      assert.deepEqual(
        await store.prepareWorkspaceOperationAction({
          ...locator(prepared.operation),
          expectedOperationRevision: prepared.operation.revision,
          phase: "reconcile",
          idempotency: reconcileIdempotency(),
        }),
        {
          disposition: "replayed",
          operation: completed.operation,
          deliveryAttempt: null,
        },
      );
    });

    test("keeps terminal state and creates no delivery for a later action", async (context) => {
      const store = await managed(context, createStore);
      await seedWorkspaceThread(store);
      const prepared = await store.prepareWorkspaceOperation(prepareInput());
      const leased = await claim(store, prepared.deliveryAttempt!, "owner-1");
      const completed = await store.settleWorkspaceOperationDelivery({
        ...locator(prepared.operation),
        expectedOperationRevision: prepared.operation.revision,
        deliveryLease: leased.lease!,
        resolution: resolution(prepared.operation, "completed"),
      });
      const canceled = await store.prepareWorkspaceOperationAction({
        ...locator(completed.operation),
        expectedOperationRevision: completed.operation.revision,
        phase: "cancel",
        idempotency: cancelIdempotency(),
      });
      assert.equal(canceled.operation.status, "completed");
      assert.equal(canceled.deliveryAttempt, null);
    });
  });
}
