import { createHash } from "node:crypto";
import type { ThreadState } from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import type { ActorContext } from "./authorization-port.ts";
import {
  validateWorkspaceDeliveryAttempt,
  type WorkspaceDeliveryAttempt,
} from "./workspace-delivery-store-port.ts";
import type { ExecuteWorkspaceListCommand } from "./workspace-list-application-service.ts";
import {
  canonicalWorkspaceListAction,
  canonicalWorkspaceListDispatchCommand,
  validateWorkspaceOperationRecord,
  type FrozenWorkspaceListCommand,
  type WorkspaceListResolution,
  type WorkspaceOperationMutationResult,
  type WorkspaceOperationReceiptQuery,
  type WorkspaceOperationRecord,
} from "./workspace-operation-store-port.ts";
export function frozenCommand(input: {
  actor: ActorContext;
  threadId: string;
  expectedThreadRevision: number;
  idempotencyKey: string;
  maxEntries: number;
}): FrozenWorkspaceListCommand {
  const draft: FrozenWorkspaceListCommand = {
    executionId: "workspace-execution-1",
    workspaceBindingId: "workspace-1",
    incarnationId: "incarnation-1",
    deviceBindingId: "device-binding-1",
    deviceId: "device-1",
    runtimeBindingId: "runtime-binding-1",
    policySnapshotId: "policy-1",
    actionDigest: `sha256:${"0".repeat(64)}`,
    commandDigest: `sha256:${"0".repeat(64)}`,
    limits: {
      depth: 0,
      maxEntries: input.maxEntries,
      maxNameBytes: 255,
      maxOutputBytes: 64 * 1024,
      maxScannedEntries: 10_000,
      maxScannedNameBytes: 1024 * 1024,
      timeoutMs: 30_000,
    },
  };
  const actionDigest = sha256(
    canonicalWorkspaceListAction({
      idempotencyKey: input.idempotencyKey,
      command: draft,
    }),
  );
  const commandDigest = sha256(
    canonicalWorkspaceListDispatchCommand({
      tenantId: input.actor.tenantId,
      spaceId: input.actor.spaceId,
      threadId: input.threadId,
      expectedThreadRevision: input.expectedThreadRevision,
      principalId: input.actor.principalId,
      actorId: input.actor.actorId,
      idempotencyKey: input.idempotencyKey,
      command: { ...draft, actionDigest },
    }),
  );
  return { ...draft, actionDigest, commandDigest };
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

export function settled(
  current: WorkspaceOperationRecord,
  next: WorkspaceListResolution,
): WorkspaceOperationRecord {
  return validateWorkspaceOperationRecord({
    ...current,
    revision: current.revision + 1,
    status: next.status,
    resolution: next,
  });
}

export function mutation(
  disposition: WorkspaceOperationMutationResult["disposition"],
  operation: WorkspaceOperationRecord,
): WorkspaceOperationMutationResult {
  return { disposition, operation: structuredClone(operation) };
}

export function preparation(
  disposition: WorkspaceOperationMutationResult["disposition"],
  operation: WorkspaceOperationRecord,
  deliveryAttempt: WorkspaceDeliveryAttempt,
) {
  return { ...mutation(disposition, operation), deliveryAttempt };
}

export function pendingAttempt(
  operation: WorkspaceOperationRecord,
  phase: WorkspaceDeliveryAttempt["phase"],
  attemptNumber: number,
): WorkspaceDeliveryAttempt {
  return validateWorkspaceDeliveryAttempt({
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
  });
}

export function executeCommand(): ExecuteWorkspaceListCommand {
  return {
    kind: "workspaceList.execute",
    idempotencyKey: "execute-key-1",
    threadId: "thread-1",
    expectedRevision: 1,
    maxEntries: 5,
  };
}

export function threadFixture(): ThreadState {
  return {
    threadId: "thread-1",
    tenantId: "tenant-1",
    spaceId: "space-1",
    createdByActorId: "actor-1",
    title: null,
    status: "active",
    revision: 1,
    lastEventSequence: 1,
    lastMessageSequence: 0,
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
    archivedAt: null,
    deletedAt: null,
    deletedByActorId: null,
    forkedFromThreadId: null,
    forkedThroughHistorySequence: null,
  };
}

export function receiptKey(query: WorkspaceOperationReceiptQuery): string {
  return [
    query.tenantId,
    query.spaceId,
    query.phase,
    query.idempotency.scope,
    query.idempotency.key,
  ].join(":");
}

export function emptyCounts() {
  return {
    receiptReads: 0,
    threadReads: 0,
    operationReads: 0,
    prepares: 0,
    actions: 0,
    claims: 0,
    settlements: 0,
  };
}

export function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export function signal(): AbortSignal {
  return new AbortController().signal;
}

export function storeError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

export function applicationError(category: string, code: string) {
  return (error: unknown) =>
    error instanceof ApplicationError &&
    error.category === category &&
    error.code === code;
}
