import { registerRunStoreConformance } from "./run-store-conformance.test-support.ts";
import { ManualLeaseClock } from "./run-store-conformance.test-support.ts";
import { registerRunExecutionStoreConformance } from "./run-execution-store-conformance.test-support.ts";
import { registerThreadStoreConformance } from "./thread-store-conformance.test-support.ts";
import { registerAgentVersionStoreConformance } from "./agent-version-store-conformance.test-support.ts";
import { registerAgentVersionReleaseStoreConformance } from "./agent-version-release-store-conformance.test-support.ts";
import { InMemoryRunStore } from "./in-memory-run-store.ts";
import { registerTurnStartStoreConformance } from "./turn-start-store-conformance.test-support.ts";
import { registerThreadGoalMutationStoreConformance } from "./thread-goal-mutation-store-conformance.test-support.ts";
import { registerThreadRollbackStoreConformance } from "./thread-rollback-store-conformance.test-support.ts";
import { registerAutomationStoreConformance } from "./automation-store-conformance.test-support.ts";
import {
  prepareInput,
  receiptQuery,
  registerWorkspaceOperationStoreConformance,
  seedWorkspaceThread,
} from "./workspace-operation-store-conformance.test-support.ts";

registerWorkspaceOperationStoreConformance(
  "InMemoryRunStore workspace operation authority",
  () => new InMemoryRunStore(),
);

test("requires reconcile after a workspace delivery lease expires", async () => {
  const clock = new ManualLeaseClock(Date.parse("2026-08-10T00:00:00.000Z"));
  const store = new InMemoryRunStore({ clock });
  await seedWorkspaceThread(store);
  const prepared = await store.prepareWorkspaceOperation(prepareInput());
  const pending = prepared.deliveryAttempt!;
  const first = await store.claimWorkspaceOperationDelivery({
    ...deliveryLocator(pending),
    ownerId: "owner-1",
    leaseDurationMs: 35_000,
  });
  clock.advance(35_000);
  assert.equal(first.lease?.epoch, 1);
  await assert.rejects(
    store.claimWorkspaceOperationDelivery({
      ...deliveryLocator(pending),
      ownerId: "owner-2",
      leaseDurationMs: 35_000,
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "workspace_delivery_reconcile_required",
  );
  const unknown = {
    status: "unknownOutcome" as const,
    executionId: pending.executionId,
    actionDigest: pending.actionDigest,
    commandDigest: pending.commandDigest,
    providerReceiptId: null,
  };
  await assert.rejects(
    store.settleWorkspaceOperationDelivery({
      tenantId: pending.tenantId,
      spaceId: pending.spaceId,
      threadId: pending.threadId,
      executionId: pending.executionId,
      expectedOperationRevision: pending.operationRevision,
      deliveryLease: first.lease!,
      resolution: unknown,
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "workspace_delivery_lease_expired",
  );
  await assert.rejects(
    store.abandonWorkspaceOperationDelivery({
      tenantId: pending.tenantId,
      spaceId: pending.spaceId,
      threadId: pending.threadId,
      executionId: pending.executionId,
      operationRevision: pending.operationRevision,
      deliveryLease: first.lease!,
      reason: "notSent",
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "workspace_delivery_lease_expired",
  );
  await store.close();
});

test("generates different lease ids for different workspace executions", async () => {
  const clock = new ManualLeaseClock(Date.parse("2026-08-10T00:00:00.000Z"));
  const store = new InMemoryRunStore({ clock });
  await seedWorkspaceThread(store);
  const first = await store.prepareWorkspaceOperation(prepareInput());
  const second = await store.prepareWorkspaceOperation(prepareInput("-2"));
  const firstLease = await store.claimWorkspaceOperationDelivery({
    ...deliveryLocator(first.deliveryAttempt!),
    ownerId: "owner-1",
    leaseDurationMs: 35_000,
  });
  const secondLease = await store.claimWorkspaceOperationDelivery({
    ...deliveryLocator(second.deliveryAttempt!),
    ownerId: "owner-1",
    leaseDurationMs: 35_000,
  });
  assert.notEqual(firstLease.lease?.leaseId, secondLease.lease?.leaseId);
  await store.close();
});

test("does not partially prepare workspace authority when timestamp encoding fails", async () => {
  let now = Date.parse("2026-08-10T00:00:00.000Z");
  const store = new InMemoryRunStore({
    clock: { nowEpochMilliseconds: () => now },
  });
  await seedWorkspaceThread(store);
  now = Number.MAX_SAFE_INTEGER;
  const input = prepareInput();
  await assert.rejects(
    store.prepareWorkspaceOperation(input),
    storeCode("workspace_delivery_timestamp_invalid"),
  );
  assert.equal(
    await store.loadWorkspaceOperation(operationLocator(input.operation)),
    null,
  );
  assert.equal(
    await store.loadWorkspaceOperationReceipt(receiptQuery("execute")),
    null,
  );
  assert.deepEqual(
    await store.listWorkspaceOperationDeliveryAttempts(
      deliveryAttemptQuery(input.operation),
    ),
    [],
  );
  await store.close();
});

test("keeps action retirement copy-on-write when timestamp encoding fails", async () => {
  let now = Date.parse("2026-08-10T00:00:00.000Z");
  const store = new InMemoryRunStore({
    clock: { nowEpochMilliseconds: () => now },
  });
  await seedWorkspaceThread(store);
  const input = prepareInput();
  const prepared = await store.prepareWorkspaceOperation(input);
  const beforeAttempts = await store.listWorkspaceOperationDeliveryAttempts(
    deliveryAttemptQuery(input.operation),
  );
  const beforeReceipt = await store.loadWorkspaceOperationReceipt(
    receiptQuery("execute"),
  );
  now = Number.MAX_SAFE_INTEGER;
  await assert.rejects(
    store.prepareWorkspaceOperationAction({
      ...operationLocator(prepared.operation),
      expectedOperationRevision: prepared.operation.revision,
      phase: "reconcile",
      idempotency: {
        scope: "workspace-list.reconcile:space-1",
        key: "reconcile-key",
        requestFingerprint: `sha256:${"1".repeat(64)}`,
      },
    }),
    storeCode("workspace_delivery_timestamp_invalid"),
  );
  assert.deepEqual(
    await store.listWorkspaceOperationDeliveryAttempts(
      deliveryAttemptQuery(input.operation),
    ),
    beforeAttempts,
  );
  assert.deepEqual(
    await store.loadWorkspaceOperationReceipt(receiptQuery("execute")),
    beforeReceipt,
  );
  assert.equal(
    await store.loadWorkspaceOperationReceipt(receiptQuery("reconcile")),
    null,
  );
  assert.deepEqual(
    await store.loadWorkspaceOperation(operationLocator(input.operation)),
    input.operation,
  );
  await store.close();
});

test("keeps operation attempts and receipts unchanged on forged settlement", async () => {
  const now = Date.parse("2026-08-10T00:00:00.000Z");
  const store = new InMemoryRunStore({
    clock: { nowEpochMilliseconds: () => now },
  });
  await seedWorkspaceThread(store);
  const input = prepareInput();
  const prepared = await store.prepareWorkspaceOperation(input);
  const leased = await store.claimWorkspaceOperationDelivery({
    ...deliveryLocator(prepared.deliveryAttempt!),
    ownerId: "owner-1",
    leaseDurationMs: 35_000,
  });
  const beforeOperation = await store.loadWorkspaceOperation(
    operationLocator(input.operation),
  );
  const beforeAttempts = await store.listWorkspaceOperationDeliveryAttempts(
    deliveryAttemptQuery(input.operation),
  );
  const beforeReceipt = await store.loadWorkspaceOperationReceipt(
    receiptQuery("execute"),
  );
  await assert.rejects(
    store.settleWorkspaceOperationDelivery({
      ...operationLocator(input.operation),
      expectedOperationRevision: input.operation.revision,
      deliveryLease: leased.lease!,
      resolution: {
        status: "unknownOutcome",
        executionId: input.operation.executionId,
        actionDigest: input.operation.command.actionDigest,
        commandDigest: `sha256:${"f".repeat(64)}`,
        providerReceiptId: null,
      },
    }),
    storeCode("workspace_operation_resolution_identity_mismatch"),
  );
  assert.deepEqual(
    await store.loadWorkspaceOperation(operationLocator(input.operation)),
    beforeOperation,
  );
  assert.deepEqual(
    await store.listWorkspaceOperationDeliveryAttempts(
      deliveryAttemptQuery(input.operation),
    ),
    beforeAttempts,
  );
  assert.deepEqual(
    await store.loadWorkspaceOperationReceipt(receiptQuery("execute")),
    beforeReceipt,
  );
  await store.close();
});

function deliveryLocator(
  attempt: NonNullable<
    Awaited<
      ReturnType<InMemoryRunStore["prepareWorkspaceOperation"]>
    >["deliveryAttempt"]
  >,
) {
  return {
    tenantId: attempt.tenantId,
    spaceId: attempt.spaceId,
    threadId: attempt.threadId,
    executionId: attempt.executionId,
    attemptNumber: attempt.attemptNumber,
    operationRevision: attempt.operationRevision,
    phase: attempt.phase,
  };
}

function operationLocator(
  operation: ReturnType<typeof prepareInput>["operation"],
) {
  return {
    tenantId: operation.tenantId,
    spaceId: operation.spaceId,
    threadId: operation.threadId,
    executionId: operation.executionId,
  };
}

function deliveryAttemptQuery(
  operation: ReturnType<typeof prepareInput>["operation"],
) {
  return {
    ...operationLocator(operation),
    afterAttemptNumber: 0,
    limit: 100,
    view: "audit" as const,
  };
}

function storeCode(code: string) {
  return (error: unknown) =>
    error instanceof Error &&
    "code" in error &&
    (error as Error & { code: string }).code === code;
}

registerAutomationStoreConformance(
  "InMemoryRunStore Automation authority",
  () => new InMemoryRunStore(),
);

registerRunStoreConformance(
  "InMemoryRunStore",
  (clock) => new InMemoryRunStore({ clock }),
);

registerAgentVersionStoreConformance(
  "InMemoryRunStore AgentVersion authority",
  () => new InMemoryRunStore(),
);

registerAgentVersionReleaseStoreConformance(
  "InMemoryRunStore AgentVersion release authority",
  () => new InMemoryRunStore(),
);

registerThreadStoreConformance(
  "InMemoryRunStore Thread authority",
  (clock) => new InMemoryRunStore({ clock }),
);

registerRunExecutionStoreConformance(
  "InMemoryRunStore execution authority",
  (clock) => new InMemoryRunStore({ clock }),
);

registerTurnStartStoreConformance(
  "InMemoryRunStore atomic Turn start",
  () => new InMemoryRunStore(),
);

registerThreadGoalMutationStoreConformance(
  "InMemoryRunStore atomic Goal mutation",
  () => new InMemoryRunStore(),
);

registerThreadRollbackStoreConformance(
  "InMemoryRunStore append-only Thread rollback",
  (clock) => new InMemoryRunStore({ clock }),
);
import assert from "node:assert/strict";
import test from "node:test";
