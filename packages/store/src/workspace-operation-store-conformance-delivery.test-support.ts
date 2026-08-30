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
export function registerWorkspaceOperationStoreDeliveryConformance(
  name: string,
  createStore: () => ConformanceStore | Promise<ConformanceStore>,
): void {
  describe(name, () => {
    test("filters scope before limit and never projects delivery attempts as operation events", async (context) => {
      const store = await managed(context, createStore);
      await seedWorkspaceThread(store);
      const prepared = await store.prepareWorkspaceOperation(prepareInput());
      const locatorInput = locator(prepared.operation);
      const leased = await claim(store, prepared.deliveryAttempt!, "owner-1");
      await store.abandonWorkspaceOperationDelivery({
        ...locatorInput,
        operationRevision: prepared.operation.revision,
        deliveryLease: leased.lease!,
        reason: "notSent",
      });
      assert.deepEqual(
        await store.listWorkspaceOperationEvents({
          ...locatorInput,
          afterSequence: 0,
          limit: 1,
        }),
        [{ sequence: 1, operation: prepared.operation }],
      );
      assert.equal(
        await store.loadWorkspaceOperationSnapshot({
          ...locatorInput,
          spaceId: "space-2",
        }),
        null,
      );
      assert.deepEqual(
        await store.listWorkspaceOperationEvents({
          ...locatorInput,
          spaceId: "space-2",
          afterSequence: 0,
          limit: 1,
        }),
        [],
      );
      await assert.rejects(
        store.listWorkspaceOperationEvents({
          ...locatorInput,
          afterSequence: 0,
          limit: 101,
        }),
        hasCode("workspace_operation_event_query_invalid"),
      );
      await assert.rejects(
        store.listWorkspaceOperationEvents({
          ...locatorInput,
          afterSequence: 0,
          limit: 1,
          unexpected: true,
        } as never),
        hasCode("workspace_operation_event_query_invalid"),
      );
      await assert.rejects(
        store.loadWorkspaceOperationSnapshot({
          ...locatorInput,
          unexpected: true,
        } as never),
        hasCode("workspace_operation_locator_invalid"),
      );
    });

    test("enforces frozen timeout plus commit margin in Store claim authority", async (context) => {
      const store = await managed(context, createStore);
      await seedWorkspaceThread(store);
      const prepared = await store.prepareWorkspaceOperation(prepareInput());
      const pending = prepared.deliveryAttempt!;
      await assert.rejects(
        store.claimWorkspaceOperationDelivery({
          ...deliveryLocator(pending),
          ownerId: "owner-1",
          leaseDurationMs: 34_999,
        }),
        hasCode("workspace_delivery_lease_duration_invalid"),
      );
      const leased = await store.claimWorkspaceOperationDelivery({
        ...deliveryLocator(pending),
        ownerId: "owner-1",
        leaseDurationMs: 35_000,
      });
      assert.equal(
        Date.parse(leased.lease!.expiresAt) -
          Date.parse(leased.lease!.leasedAt),
        35_000,
      );
    });

    test("allows a target-bound cancel lease to race an active execute lease", async (context) => {
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
      assert.equal(cancel.deliveryAttempt?.phase, "cancel");
      const cancelLease = await claim(
        store,
        cancel.deliveryAttempt!,
        "cancel-owner",
      );
      const canceled = await store.settleWorkspaceOperationDelivery({
        ...locator(prepared.operation),
        expectedOperationRevision: prepared.operation.revision,
        deliveryLease: cancelLease.lease!,
        resolution: resolution(prepared.operation, "canceled"),
      });
      assert.equal(canceled.operation.status, "canceled");
      const lost = await store.settleWorkspaceOperationDelivery({
        ...locator(prepared.operation),
        expectedOperationRevision: prepared.operation.revision,
        deliveryLease: execute.lease!,
        resolution: resolution(prepared.operation, "completed"),
      });
      assert.equal(lost.outcome, "lostRace");
      assert.deepEqual(lost.operation, canceled.operation);
      assert.equal(lost.deliveryAttempt.settlement?.kind, "superseded");
      const attempts = await store.listWorkspaceOperationDeliveryAttempts(
        attemptQuery(prepared.operation),
      );
      assert.deepEqual(
        attempts.map(({ phase, status, settlement }) => ({
          phase,
          status,
          settlement: settlement?.kind ?? null,
        })),
        [
          { phase: "execute", status: "settled", settlement: "superseded" },
          { phase: "cancel", status: "settled", settlement: "resolution" },
        ],
      );
      assert.deepEqual(
        await store.loadWorkspaceOperationReceipt(receiptQuery("execute")),
        { disposition: "replayed", operation: canceled.operation },
      );
      assert.deepEqual(
        await store.loadWorkspaceOperation(locator(prepared.operation)),
        canceled.operation,
      );
    });

    test("rejects forged digest authority before partial persistence", async (context) => {
      const store = await managed(context, createStore);
      await seedWorkspaceThread(store);
      const input = prepareInput();
      await assert.rejects(
        store.prepareWorkspaceOperation({
          ...input,
          operation: {
            ...input.operation,
            command: {
              ...input.operation.command,
              runtimeBindingId: "substituted-runtime",
            },
          },
        }),
        hasCode("workspace_operation_digest_authority_invalid"),
      );
      assert.equal(
        await store.loadWorkspaceOperationReceipt(receiptQuery("execute")),
        null,
      );
    });
  });
}
