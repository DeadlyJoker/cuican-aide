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
import { registerWorkspaceOperationStoreReadConformance } from "./workspace-operation-store-conformance-read.test-support.ts";
import { registerWorkspaceOperationStoreReceiptConformance } from "./workspace-operation-store-conformance-receipt.test-support.ts";
import { registerWorkspaceOperationStoreDeliveryConformance } from "./workspace-operation-store-conformance-delivery.test-support.ts";
import { registerWorkspaceOperationStoreRevisionConformance } from "./workspace-operation-store-conformance-revision.test-support.ts";

export function registerWorkspaceOperationStoreConformance(
  name: string,
  createStore: () => ConformanceStore | Promise<ConformanceStore>,
): void {
  registerWorkspaceOperationStoreReadConformance(name, createStore);
  registerWorkspaceOperationStoreReceiptConformance(name, createStore);
  registerWorkspaceOperationStoreDeliveryConformance(name, createStore);
  registerWorkspaceOperationStoreRevisionConformance(name, createStore);
}

export function deliveryIdentity(attempt: WorkspaceDeliveryAttempt) {
  const { createdAt: _createdAt, ...identity } = attempt;
  return identity;
}

export async function claim(
  store: ConformanceStore,
  attempt: WorkspaceDeliveryAttempt,
  ownerId: string,
) {
  return store.claimWorkspaceOperationDelivery({
    tenantId: attempt.tenantId,
    spaceId: attempt.spaceId,
    threadId: attempt.threadId,
    executionId: attempt.executionId,
    attemptNumber: attempt.attemptNumber,
    operationRevision: attempt.operationRevision,
    phase: attempt.phase,
    ownerId,
    leaseDurationMs: 35_000,
  });
}

export function deliveryLocator(attempt: WorkspaceDeliveryAttempt) {
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

export function pendingAttempt(
  operation: WorkspaceOperationRecord,
  attemptNumber: number,
  phase: WorkspaceDeliveryAttempt["phase"],
): WorkspaceDeliveryAttempt {
  return {
    schemaVersion: "crewon.workspace-delivery-attempt.v0",
    tenantId: operation.tenantId,
    spaceId: operation.spaceId,
    threadId: operation.threadId,
    executionId: operation.executionId,
    attemptNumber,
    operationRevision: operation.revision,
    phase,
    status: "pending",
    actionDigest: operation.command.actionDigest,
    commandDigest: operation.command.commandDigest,
    createdAt: "2026-08-10T00:00:00.000Z",
    lease: null,
    settlement: null,
  };
}

export async function seedWorkspaceThread(store: DomainStore): Promise<void> {
  const event: ThreadLifecycleEvent = {
    schemaVersion: "crewon.thread-event.v0",
    identity: { threadId: "thread-1" },
    eventId: "workspace-thread-created",
    sequence: 1,
    occurredAt: "2026-08-10T00:00:00.000Z",
    type: "thread.created",
    data: {
      tenantId: "tenant-1",
      spaceId: "space-1",
      createdByActorId: "actor-1",
      title: "Workspace",
    },
  };
  await store.commitThread({
    tenantId: "tenant-1",
    idempotency: {
      scope: "workspace-thread",
      key: "create",
      requestFingerprint: "create",
    },
    expectedRevision: 0,
    events: [event],
    messages: [],
    history: { expectedLastSequence: 0, items: [] },
  });
}

export function prepareInput(suffix = "") {
  const idempotency = executeIdempotency(suffix);
  return {
    tenantId: "tenant-1",
    spaceId: "space-1",
    threadFence: { threadId: "thread-1", expectedRevision: 1 },
    idempotency,
    operation: operation(idempotency.key, `workspace-execution-1${suffix}`),
  } as const;
}

export function prepareExecution(executionId: string) {
  const descriptor = idempotency(
    "workspace-list.execute:space-1",
    `execute-${executionId}`,
    executionId,
  );
  return {
    tenantId: "tenant-1",
    spaceId: "space-1",
    threadFence: { threadId: "thread-1", expectedRevision: 1 },
    idempotency: descriptor,
    operation: operation(descriptor.key, executionId),
  } as const;
}

export function operation(
  idempotencyKey: string,
  executionId = "workspace-execution-1",
): WorkspaceOperationRecord {
  const draft = {
    executionId,
    workspaceBindingId: "workspace-1",
    incarnationId: "incarnation-1",
    runtimeBindingId: "runtime-binding-1",
    policySnapshotId: "policy-1",
    actionDigest: `sha256:${"0".repeat(64)}`,
    commandDigest: `sha256:${"0".repeat(64)}`,
    limits: {
      depth: 0 as const,
      maxEntries: 5,
      maxNameBytes: 255,
      maxOutputBytes: 64 * 1024,
      maxScannedEntries: 10_000,
      maxScannedNameBytes: 1024 * 1024,
      timeoutMs: 30_000,
    },
  };
  const actionDigest = sha256(
    canonicalWorkspaceListAction({ idempotencyKey, command: draft }),
  );
  const commandDigest = sha256(
    canonicalWorkspaceListDispatchCommand({
      tenantId: "tenant-1",
      spaceId: "space-1",
      threadId: "thread-1",
      expectedThreadRevision: 1,
      principalId: "principal-1",
      actorId: "actor-1",
      idempotencyKey,
      command: { ...draft, actionDigest },
    }),
  );
  return {
    schemaVersion: "crewon.workspace-operation.v0",
    tenantId: "tenant-1",
    spaceId: "space-1",
    threadId: "thread-1",
    expectedThreadRevision: 1,
    principalId: "principal-1",
    actorId: "actor-1",
    idempotencyKey,
    executionId: draft.executionId,
    revision: 1,
    status: "prepared",
    command: { ...draft, actionDigest, commandDigest },
    resolution: null,
  };
}

export function receiptQuery(phase: "execute" | "reconcile" | "cancel") {
  return {
    tenantId: "tenant-1",
    spaceId: "space-1",
    phase,
    idempotency:
      phase === "execute"
        ? executeIdempotency()
        : phase === "reconcile"
          ? reconcileIdempotency()
          : cancelIdempotency(),
  } as const;
}

export function resolution(
  operation: WorkspaceOperationRecord,
  status: "completed" | "canceled" | "unknownOutcome",
): WorkspaceListResolution {
  const common = {
    executionId: operation.executionId,
    actionDigest: operation.command.actionDigest,
    commandDigest: operation.command.commandDigest,
  };
  return status === "completed"
    ? {
        status,
        ...common,
        providerReceiptId: "receipt-1",
        entries: [{ name: "README.md", kind: "file" }],
        truncated: false,
      }
    : {
        status,
        ...common,
        providerReceiptId: status === "canceled" ? "receipt-1" : null,
      };
}

export function locator(operation: WorkspaceOperationRecord) {
  return {
    tenantId: operation.tenantId,
    spaceId: operation.spaceId,
    threadId: operation.threadId,
    executionId: operation.executionId,
  };
}

export function attemptQuery(operation: WorkspaceOperationRecord) {
  return {
    ...locator(operation),
    afterAttemptNumber: 0,
    limit: 100,
    view: "audit" as const,
  };
}

export function executeIdempotency(suffix = ""): IdempotencyDescriptor {
  return idempotency(
    "workspace-list.execute:space-1",
    `execute-key${suffix}`,
    `execute${suffix}`,
  );
}

export function reconcileIdempotency(suffix = ""): IdempotencyDescriptor {
  return idempotency(
    "workspace-list.reconcile:space-1",
    `reconcile-key${suffix}`,
    `reconcile${suffix}`,
  );
}

export function cancelIdempotency(): IdempotencyDescriptor {
  return idempotency("workspace-list.cancel:space-1", "cancel-key", "cancel");
}

export function idempotency(scope: string, key: string, body: string) {
  return { scope, key, requestFingerprint: sha256(body) };
}

export async function renameWorkspaceThread(store: DomainStore): Promise<void> {
  await store.commitThread({
    tenantId: "tenant-1",
    idempotency: {
      scope: "workspace-thread",
      key: "rename",
      requestFingerprint: "rename",
    },
    expectedRevision: 1,
    events: [
      {
        schemaVersion: "crewon.thread-event.v0",
        identity: { threadId: "thread-1" },
        eventId: "workspace-thread-renamed",
        sequence: 2,
        occurredAt: "2026-08-10T00:00:01.000Z",
        type: "thread.renamed",
        data: { actorId: "actor-1", title: "Changed" },
      },
    ],
    messages: [],
    history: { expectedLastSequence: 0, items: [] },
  });
}

export async function managed(
  context: TestContext,
  createStore: () => ConformanceStore | Promise<ConformanceStore>,
) {
  const store = await createStore();
  context.after(() => store.close());
  return store;
}

export function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export function hasCode(code: string) {
  return (error: unknown) =>
    error instanceof Error &&
    "code" in error &&
    (error as Error & { code: string }).code === code;
}
