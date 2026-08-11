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
export function registerWorkspaceOperationStoreReceiptConformance(
  name: string,
  createStore: () => ConformanceStore | Promise<ConformanceStore>,
): void {
  describe(name, () => {
    test("reads one atomic head snapshot and strictly paginates the revision ledger", async (context) => {
      const store = await managed(context, createStore);
      await seedWorkspaceThread(store);
      const prepared = await store.prepareWorkspaceOperation(prepareInput());
      const execute = await claim(
        store,
        prepared.deliveryAttempt!,
        "execute-owner",
      );
      const unknown = await store.settleWorkspaceOperationDelivery({
        ...locator(prepared.operation),
        expectedOperationRevision: prepared.operation.revision,
        deliveryLease: execute.lease!,
        resolution: resolution(prepared.operation, "unknownOutcome"),
      });
      const reconcile = await store.prepareWorkspaceOperationAction({
        ...locator(unknown.operation),
        expectedOperationRevision: unknown.operation.revision,
        phase: "reconcile",
        idempotency: reconcileIdempotency(),
      });
      const reconcileLease = await claim(
        store,
        reconcile.deliveryAttempt!,
        "reconcile-owner",
      );
      const completed = await store.settleWorkspaceOperationDelivery({
        ...locator(reconcile.operation),
        expectedOperationRevision: reconcile.operation.revision,
        deliveryLease: reconcileLease.lease!,
        resolution: resolution(reconcile.operation, "completed"),
      });

      assert.deepEqual(
        await store.loadWorkspaceOperationSnapshot(
          locator(completed.operation),
        ),
        { operation: completed.operation, eventSequence: 3 },
      );
      assert.deepEqual(
        await store.listWorkspaceOperationEvents({
          ...locator(completed.operation),
          afterSequence: 0,
          limit: 2,
        }),
        [
          { sequence: 1, operation: prepared.operation },
          { sequence: 2, operation: unknown.operation },
        ],
      );
      assert.deepEqual(
        await store.listWorkspaceOperationEvents({
          ...locator(completed.operation),
          afterSequence: 2,
          limit: 100,
        }),
        [{ sequence: 3, operation: completed.operation }],
      );
      assert.deepEqual(
        await store.listWorkspaceOperationEvents({
          ...locator(completed.operation),
          afterSequence: 3,
          limit: 100,
        }),
        [],
      );
      await assert.rejects(
        store.listWorkspaceOperationEvents({
          ...locator(completed.operation),
          afterSequence: 4,
          limit: 100,
        }),
        hasCode("workspace_operation_event_cursor_invalid"),
      );
    });

    test("rejects explicit recovery while a delivery lease is unexpired", async (context) => {
      const store = await managed(context, createStore);
      await seedWorkspaceThread(store);
      const prepared = await store.prepareWorkspaceOperation(prepareInput());
      await claim(store, prepared.deliveryAttempt!, "owner-1");
      await assert.rejects(
        store.prepareWorkspaceOperationAction({
          ...locator(prepared.operation),
          expectedOperationRevision: prepared.operation.revision,
          phase: "reconcile",
          idempotency: reconcileIdempotency(),
        }),
        hasCode("workspace_delivery_lease_active"),
      );
      assert.equal(
        await store.loadWorkspaceOperationReceipt(receiptQuery("reconcile")),
        null,
      );
    });

    test("settles a racing cancel as lost when execute wins first", async (context) => {
      const store = await managed(context, createStore);
      await seedWorkspaceThread(store);
      const prepared = await store.prepareWorkspaceOperation(prepareInput());
      const execute = await claim(
        store,
        prepared.deliveryAttempt!,
        "execute-owner",
      );
      const cancel = await store.prepareWorkspaceOperationAction({
        ...locator(prepared.operation),
        expectedOperationRevision: prepared.operation.revision,
        phase: "cancel",
        idempotency: cancelIdempotency(),
      });
      const cancelLease = await claim(
        store,
        cancel.deliveryAttempt!,
        "cancel-owner",
      );
      const completed = await store.settleWorkspaceOperationDelivery({
        ...locator(prepared.operation),
        expectedOperationRevision: prepared.operation.revision,
        deliveryLease: execute.lease!,
        resolution: resolution(prepared.operation, "completed"),
      });
      const lost = await store.settleWorkspaceOperationDelivery({
        ...locator(prepared.operation),
        expectedOperationRevision: prepared.operation.revision,
        deliveryLease: cancelLease.lease!,
        resolution: resolution(prepared.operation, "canceled"),
      });
      assert.equal(lost.outcome, "lostRace");
      assert.deepEqual(lost.operation, completed.operation);
      assert.equal(lost.deliveryAttempt.settlement?.kind, "superseded");
      assert.deepEqual(
        await store.loadWorkspaceOperationReceipt(receiptQuery("cancel")),
        { disposition: "replayed", operation: completed.operation },
      );
    });

    test("hides receipts and operations across spaces", async (context) => {
      const store = await managed(context, createStore);
      await seedWorkspaceThread(store);
      const prepared = await store.prepareWorkspaceOperation(prepareInput());
      assert.equal(
        await store.loadWorkspaceOperationReceipt({
          ...receiptQuery("execute"),
          spaceId: "space-2",
        }),
        null,
      );
      assert.equal(
        await store.loadWorkspaceOperation({
          ...locator(prepared.operation),
          spaceId: "space-2",
        }),
        null,
      );
    });
  });
}
