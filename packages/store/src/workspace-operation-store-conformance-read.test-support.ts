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
export function registerWorkspaceOperationStoreReadConformance(
  name: string,
  createStore: () => ConformanceStore | Promise<ConformanceStore>,
): void {
  describe(name, () => {
    test("receipt replay returns only its exact durable delivery attempt", async (context) => {
      const store = await managed(context, createStore);
      await seedWorkspaceThread(store);
      const input = prepareInput();
      const first = await store.prepareWorkspaceOperation(input);
      assert.equal(first.disposition, "committed");
      assert.deepEqual(first.operation, input.operation);
      assert.deepEqual(
        deliveryIdentity(first.deliveryAttempt!),
        deliveryIdentity(pendingAttempt(input.operation, 1, "execute")),
      );
      await renameWorkspaceThread(store);
      assert.deepEqual(await store.prepareWorkspaceOperation(input), {
        disposition: "replayed",
        operation: input.operation,
        deliveryAttempt: first.deliveryAttempt,
      });
      assert.deepEqual(
        await store.loadWorkspaceOperationReceipt(receiptQuery("execute")),
        {
          disposition: "replayed",
          operation: input.operation,
          deliveryAttempt: first.deliveryAttempt,
        },
      );
      assert.deepEqual(
        await store.listWorkspaceOperationDeliveryAttempts({
          ...attemptQuery(input.operation),
          limit: 1,
        }),
        [first.deliveryAttempt],
      );
      for (const drift of [
        { tenantId: "tenant-substituted" },
        { spaceId: "space-substituted" },
        { threadId: "thread-substituted" },
        { executionId: "execution-substituted" },
      ]) {
        assert.deepEqual(
          await store.listWorkspaceOperationDeliveryAttempts({
            ...attemptQuery(input.operation),
            ...drift,
            limit: 1,
          }),
          [],
        );
      }
    });

    test("keeps an exclusive cursor stable when a lower executionId appears between pages", async (context) => {
      const store = await managed(context, createStore);
      await seedWorkspaceThread(store);
      const first = (
        await store.prepareWorkspaceOperation(prepareExecution("workspace-100"))
      ).operation;
      const third = (
        await store.prepareWorkspaceOperation(prepareExecution("workspace-300"))
      ).operation;
      const page = await store.listWorkspaceOperations({
        tenantId: "tenant-1",
        spaceId: "space-1",
        threadId: "thread-1",
        afterExecutionId: null,
        limit: 1,
      });
      assert.deepEqual(page, {
        operations: [first],
        nextAfterExecutionId: first.executionId,
      });

      await store.prepareWorkspaceOperation(prepareExecution("workspace-050"));
      const second = (
        await store.prepareWorkspaceOperation(prepareExecution("workspace-200"))
      ).operation;
      assert.deepEqual(
        await store.listWorkspaceOperations({
          tenantId: "tenant-1",
          spaceId: "space-1",
          threadId: "thread-1",
          afterExecutionId: page.nextAfterExecutionId,
          limit: 100,
        }),
        { operations: [second, third], nextAfterExecutionId: null },
      );
    });

    test("claims one exact lease and settles operation plus attempt", async (context) => {
      const store = await managed(context, createStore);
      await seedWorkspaceThread(store);
      const prepared = await store.prepareWorkspaceOperation(prepareInput());
      const pending = prepared.deliveryAttempt!;
      const claims = await Promise.allSettled([
        claim(store, pending, "owner-1"),
        claim(store, pending, "owner-2"),
      ]);
      assert.equal(
        claims.filter(({ status }) => status === "fulfilled").length,
        1,
      );
      const leased = claims.find(
        (
          candidate,
        ): candidate is PromiseFulfilledResult<WorkspaceDeliveryAttempt> =>
          candidate.status === "fulfilled",
      )!.value;
      assert.equal(leased.status, "leased");
      const unknown = await store.settleWorkspaceOperationDelivery({
        ...locator(prepared.operation),
        expectedOperationRevision: 1,
        deliveryLease: leased.lease!,
        resolution: resolution(prepared.operation, "unknownOutcome"),
      });
      assert.equal(unknown.outcome, "committed");
      assert.equal(unknown.operation.status, "unknownOutcome");
      assert.deepEqual(
        await store.settleWorkspaceOperationDelivery({
          ...locator(prepared.operation),
          expectedOperationRevision: 1,
          deliveryLease: leased.lease!,
          resolution: resolution(prepared.operation, "unknownOutcome"),
        }),
        { ...unknown, outcome: "replayed" },
      );
      const beforeConflict = await store.listWorkspaceOperationDeliveryAttempts(
        attemptQuery(prepared.operation),
      );
      await assert.rejects(
        store.settleWorkspaceOperationDelivery({
          ...locator(prepared.operation),
          expectedOperationRevision: 1,
          deliveryLease: leased.lease!,
          resolution: resolution(prepared.operation, "completed"),
        }),
        hasCode("workspace_delivery_terminal_conflict"),
      );
      assert.deepEqual(
        await store.listWorkspaceOperationDeliveryAttempts(
          attemptQuery(prepared.operation),
        ),
        beforeConflict,
      );
    });

    test("freezes each phase receipt at its own historical result revision", async (context) => {
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
      assert.deepEqual(
        await store.loadWorkspaceOperationReceipt(receiptQuery("execute")),
        {
          disposition: "replayed",
          operation: unknown.operation,
          deliveryAttempt: unknown.deliveryAttempt,
        },
      );
      const reconcileLease = await claim(
        store,
        reconcile.deliveryAttempt!,
        "reconcile-owner",
      );
      assert.deepEqual(
        await store.loadWorkspaceOperationReceipt(receiptQuery("execute")),
        {
          disposition: "replayed",
          operation: unknown.operation,
          deliveryAttempt: unknown.deliveryAttempt,
        },
      );
      const secondUnknown = await store.settleWorkspaceOperationDelivery({
        ...locator(reconcile.operation),
        expectedOperationRevision: reconcile.operation.revision,
        deliveryLease: reconcileLease.lease!,
        resolution: resolution(reconcile.operation, "unknownOutcome"),
      });
      const secondReconcileIdempotency = reconcileIdempotency("-2");
      const secondReconcile = await store.prepareWorkspaceOperationAction({
        ...locator(secondUnknown.operation),
        expectedOperationRevision: secondUnknown.operation.revision,
        phase: "reconcile",
        idempotency: secondReconcileIdempotency,
      });
      const secondLease = await claim(
        store,
        secondReconcile.deliveryAttempt!,
        "reconcile-owner-2",
      );
      const completed = await store.settleWorkspaceOperationDelivery({
        ...locator(secondReconcile.operation),
        expectedOperationRevision: secondReconcile.operation.revision,
        deliveryLease: secondLease.lease!,
        resolution: resolution(secondReconcile.operation, "completed"),
      });
      assert.equal(completed.operation.revision, 4);
      assert.deepEqual(
        await store.loadWorkspaceOperationReceipt(receiptQuery("execute")),
        {
          disposition: "replayed",
          operation: unknown.operation,
          deliveryAttempt: unknown.deliveryAttempt,
        },
      );
      assert.deepEqual(
        await store.loadWorkspaceOperationReceipt(receiptQuery("reconcile")),
        {
          disposition: "replayed",
          operation: secondUnknown.operation,
          deliveryAttempt: secondUnknown.deliveryAttempt,
        },
      );
      assert.deepEqual(
        await store.loadWorkspaceOperationReceipt({
          ...receiptQuery("reconcile"),
          idempotency: secondReconcileIdempotency,
        }),
        {
          disposition: "replayed",
          operation: completed.operation,
          deliveryAttempt: completed.deliveryAttempt,
        },
      );
      assert.deepEqual(
        await store.loadWorkspaceOperation(locator(completed.operation)),
        completed.operation,
      );
      assert.deepEqual(
        await store.settleWorkspaceOperationDelivery({
          ...locator(prepared.operation),
          expectedOperationRevision: prepared.operation.revision,
          deliveryLease: execute.lease!,
          resolution: resolution(prepared.operation, "unknownOutcome"),
        }),
        { ...unknown, outcome: "replayed" },
      );
    });
  });
}
