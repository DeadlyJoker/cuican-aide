import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import {
  WorkspaceListDispatchError,
  WorkspaceListCommandFactoryError,
  type FrozenWorkspaceListCommand,
  type WorkspaceDeliveryLease,
  type WorkspaceOperationRecord,
} from "@crewon/application";
import {
  RUNTIME_WORKER_WORKSPACE_DISPATCH_PATH,
  RUNTIME_WORKER_WORKSPACE_FREEZE_COMMAND_PATH,
  parseRuntimeWorkerWorkspaceDispatchRequest,
  parseRuntimeWorkerWorkspaceFreezeCommandRequest,
  type RuntimeWorkerWorkspacePhase,
} from "@crewon/contracts";
import { startRuntimeWorkspacePrivateServer } from "@crewon/runtime-worker";

import {
  LoopbackRuntimeWorkspaceWorkerClient,
  RuntimeWorkspaceWorkerClientError,
} from "./workspace-runtime-worker-client.ts";

export const TOKEN = "control-runtime-workspace-token-0001";
export const ACTION_DIGEST = `sha256:${"1".repeat(64)}`;
export const COMMAND_DIGEST = `sha256:${"2".repeat(64)}`;
export function clientFixture(
  dependencies: ConstructorParameters<
    typeof LoopbackRuntimeWorkspaceWorkerClient
  >[1] = {},
): LoopbackRuntimeWorkspaceWorkerClient {
  return new LoopbackRuntimeWorkspaceWorkerClient(
    { origin: "http://127.0.0.1:3211", token: TOKEN },
    dependencies,
  );
}

export function factoryInput() {
  return {
    actor: {
      principalId: "principal-1",
      actorId: "actor-1",
      tenantId: "tenant-1",
      spaceId: "space-1",
    },
    threadId: "thread-1",
    expectedThreadRevision: 1,
    idempotencyKey: "workspace-idempotency-1",
    maxEntries: 5,
  };
}

export function freezeRequest() {
  return {
    schemaVersion: "crewon.runtime-worker-workspace-freeze-request.v0" as const,
    apiVersion: 1 as const,
    tenantId: "tenant-1",
    spaceId: "space-1",
    actor: { principalId: "principal-1", actorId: "actor-1" },
    threadFence: { threadId: "thread-1", expectedRevision: 1 },
    idempotencyKey: "workspace-idempotency-1",
    maxEntries: 5,
  };
}

export function frozenCommand(): FrozenWorkspaceListCommand {
  return {
    executionId: "workspace-execution-1",
    workspaceBindingId: "workspace-1",
    incarnationId: "incarnation-1",
    deviceBindingId: "device-binding-1",
    deviceId: "device-1",
    runtimeBindingId: "runtime-binding-1",
    policySnapshotId: "policy-1",
    actionDigest: ACTION_DIGEST,
    commandDigest: COMMAND_DIGEST,
    limits: {
      depth: 0,
      maxEntries: 5,
      maxNameBytes: 255,
      maxOutputBytes: 65_536,
      maxScannedEntries: 10_000,
      maxScannedNameBytes: 1_048_576,
      timeoutMs: 30_000,
    },
  };
}

export function freezeResponse() {
  return {
    schemaVersion:
      "crewon.runtime-worker-workspace-freeze-response.v0" as const,
    apiVersion: 1 as const,
    command: frozenCommand(),
  };
}

export function operation(
  status: "prepared" | "unknownOutcome",
): WorkspaceOperationRecord {
  const command = frozenCommand();
  return {
    schemaVersion: "crewon.workspace-operation.v0",
    tenantId: "tenant-1",
    spaceId: "space-1",
    threadId: "thread-1",
    expectedThreadRevision: 1,
    principalId: "principal-1",
    actorId: "actor-1",
    idempotencyKey: "workspace-idempotency-1",
    executionId: command.executionId,
    revision: status === "prepared" ? 1 : 2,
    status,
    command,
    resolution:
      status === "prepared"
        ? null
        : {
            status: "unknownOutcome",
            executionId: command.executionId,
            actionDigest: command.actionDigest,
            commandDigest: command.commandDigest,
            providerReceiptId: "gateway-receipt-1",
          },
  };
}

export function lease(
  phase: RuntimeWorkerWorkspacePhase,
): WorkspaceDeliveryLease {
  return {
    schemaVersion: "crewon.workspace-delivery-lease.v0",
    executionId: "workspace-execution-1",
    attemptNumber: phase === "execute" ? 1 : 2,
    phase,
    ownerId: "control-api-workspace-1",
    leaseId: `delivery-${phase}`,
    epoch: 1,
    leasedAt: "2026-08-10T00:00:00.000Z",
    expiresAt: "2026-08-10T00:01:00.000Z",
  };
}

export function completedResolution() {
  return {
    status: "completed" as const,
    executionId: "workspace-execution-1",
    actionDigest: ACTION_DIGEST,
    commandDigest: COMMAND_DIGEST,
    providerReceiptId: "gateway-receipt-1",
    entries: [{ name: "README.md", kind: "file" as const }],
    truncated: false,
  };
}

export function dispatchResponse(phase: RuntimeWorkerWorkspacePhase) {
  return {
    schemaVersion:
      "crewon.runtime-worker-workspace-dispatch-response.v0" as const,
    apiVersion: 1 as const,
    phase,
    resolution: completedResolution(),
  };
}

export function jsonResponse(value: unknown, status = 200): Response {
  const body = JSON.stringify(value);
  return new Response(body, {
    status,
    headers: {
      "content-length": String(Buffer.byteLength(body)),
      "content-type": "application/json; charset=utf-8",
    },
  });
}

export function hasDispatchCertainty(certainty: "notSent" | "possiblySent") {
  return (error: unknown) =>
    error instanceof WorkspaceListDispatchError &&
    error.certainty === certainty;
}

export function hasClientError(
  code: string,
  certainty: "notSent" | "possiblySent",
) {
  return (error: unknown) =>
    error instanceof RuntimeWorkspaceWorkerClientError &&
    error.code === code &&
    error.certainty === certainty;
}

export function hasFactoryKind(kind: "unavailable" | "invalidAuthority") {
  return (error: unknown) =>
    error instanceof WorkspaceListCommandFactoryError && error.kind === kind;
}
