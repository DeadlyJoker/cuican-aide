import assert from "node:assert/strict";
import test from "node:test";

import type {
  DeviceWorkspaceListCommand,
  DeviceWorkspaceListDispatchReference,
  DeviceWorkspaceListDispatchResolution,
  RuntimeWorkerFrozenWorkspaceCommand,
  RuntimeWorkerWorkspaceDispatchRequest,
} from "@crewon/contracts";

import type {
  DeviceWorkspaceListCommandSignerPort,
  DeviceWorkspaceListDispatchClientPort,
} from "@crewon/device-dispatch";

import { NodeSha256ContentDigester } from "./standalone-adapters.ts";
import type {
  RuntimeWorkspaceDispatchAuthority,
  RuntimeWorkspaceDispatchAuthorityPort,
  RuntimeWorkspaceBindingQuery,
  RuntimeWorkspaceBindingResolverPort,
  RuntimeWorkspaceBindingSnapshot,
} from "./runtime-workspace-binding-resolver.ts";
import { RuntimeWorkspaceDispatchService } from "./runtime-workspace-dispatch-service.ts";
import { RuntimeWorkspaceError } from "./runtime-workspace-error.ts";
import { RuntimeWorkspaceFreezeService } from "./runtime-workspace-freeze-service.ts";

export const now = () => new Date("2026-08-10T00:00:30.000Z");
export function freezeService(): RuntimeWorkspaceFreezeService {
  let sequence = 0;
  return new RuntimeWorkspaceFreezeService({
    bindings: resolver([binding(), binding()]),
    ids: { nextExecutionId: () => `workspace-execution-${(sequence += 1)}` },
    digester: new NodeSha256ContentDigester(),
  });
}

export async function frozenCommand(): Promise<RuntimeWorkerFrozenWorkspaceCommand> {
  return (
    await freezeService().freeze(freezeRequest(), new AbortController().signal)
  ).command;
}

export function dispatchService(
  overrides: Partial<{
    authority: RuntimeWorkspaceDispatchAuthorityPort;
    signer: DeviceWorkspaceListCommandSignerPort;
    gateway: DeviceWorkspaceListDispatchClientPort;
  }> = {},
): RuntimeWorkspaceDispatchService {
  return new RuntimeWorkspaceDispatchService({
    authority:
      overrides.authority ??
      authority([
        dispatchAuthorityFromBinding(binding()),
        dispatchAuthorityFromBinding(binding()),
      ]),
    digester: new NodeSha256ContentDigester(),
    signer: overrides.signer ?? signer(),
    gateway: overrides.gateway ?? gatewayFixture({}),
    now,
  });
}

export function resolver(
  values: readonly RuntimeWorkspaceBindingSnapshot[],
): RuntimeWorkspaceBindingResolverPort {
  let index = 0;
  return {
    async resolve(query: RuntimeWorkspaceBindingQuery) {
      const value = values[Math.min(index, values.length - 1)]!;
      index += 1;
      void query;
      return value;
    },
  };
}

export function authority(
  values: readonly RuntimeWorkspaceDispatchAuthority[],
  afterAdmit?: () => void,
): RuntimeWorkspaceDispatchAuthorityPort {
  let index = 0;
  return {
    async admit() {
      const value = values[Math.min(index, values.length - 1)]!;
      index += 1;
      afterAdmit?.();
      return value;
    },
  };
}

export function dispatchAuthorityFromBinding(
  value: RuntimeWorkspaceBindingSnapshot,
): RuntimeWorkspaceDispatchAuthority {
  return {
    tenantId: value.tenantId,
    spaceId: value.spaceId,
    workspaceBindingId: value.workspaceBindingId,
    incarnationId: value.incarnationId,
    deviceBindingId: value.deviceBindingId,
    deviceId: value.deviceId,
    runtimeBindingId: value.runtimeBindingId,
    policySnapshotId: value.policySnapshotId,
  };
}

export function dispatchAuthority(
  frozen: RuntimeWorkerFrozenWorkspaceCommand,
): RuntimeWorkspaceDispatchAuthority {
  return {
    tenantId: "tenant-1",
    spaceId: "space-1",
    workspaceBindingId: frozen.workspaceBindingId,
    incarnationId: frozen.incarnationId,
    deviceBindingId: frozen.deviceBindingId,
    deviceId: frozen.deviceId,
    runtimeBindingId: frozen.runtimeBindingId,
    policySnapshotId: frozen.policySnapshotId,
  };
}

export function binding(): RuntimeWorkspaceBindingSnapshot {
  return {
    ...scope(),
    workspaceBindingId: "workspace-1",
    incarnationId: "incarnation-1",
    deviceBindingId: "device-binding-1",
    deviceId: "device-1",
    runtimeBindingId: "runtime-binding-1",
    policySnapshotId: "policy-1",
  };
}

export function scope(
  overrides: Partial<RuntimeWorkspaceBindingQuery> = {},
): RuntimeWorkspaceBindingQuery {
  return {
    tenantId: "tenant-1",
    spaceId: "space-1",
    threadId: "thread-1",
    expectedThreadRevision: 1,
    principalId: "principal-1",
    actorId: "actor-1",
    ...overrides,
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

export function dispatchRequest(
  phase: "execute" | "reconcile" | "cancel",
  frozen: RuntimeWorkerFrozenWorkspaceCommand,
  operation: RuntimeWorkerWorkspaceDispatchRequest["operation"] = preparedOperation(
    frozen,
  ),
): RuntimeWorkerWorkspaceDispatchRequest {
  return {
    schemaVersion: "crewon.runtime-worker-workspace-dispatch-request.v0",
    apiVersion: 1,
    phase,
    operation,
    deliveryLease: {
      schemaVersion: "crewon.workspace-delivery-lease.v0",
      executionId: frozen.executionId,
      attemptNumber: phase === "execute" ? 1 : 2,
      phase,
      ownerId: "runtime-worker-1",
      leaseId: `delivery-${phase}`,
      epoch: 1,
      leasedAt: "2026-08-10T00:00:00.000Z",
      expiresAt: "2026-08-10T00:01:00.000Z",
    },
  };
}

export function preparedOperation(frozen: RuntimeWorkerFrozenWorkspaceCommand) {
  return {
    schemaVersion: "crewon.workspace-operation.v0" as const,
    tenantId: "tenant-1",
    spaceId: "space-1",
    threadId: "thread-1",
    expectedThreadRevision: 1,
    principalId: "principal-1",
    actorId: "actor-1",
    idempotencyKey: "workspace-idempotency-1",
    executionId: frozen.executionId,
    revision: 1,
    status: "prepared" as const,
    command: frozen,
    resolution: null,
  };
}

export function unknownOperation(
  frozen: RuntimeWorkerFrozenWorkspaceCommand,
  providerReceiptId: string | null,
) {
  return {
    ...preparedOperation(frozen),
    revision: 2,
    status: "unknownOutcome" as const,
    resolution: {
      status: "unknownOutcome" as const,
      executionId: frozen.executionId,
      actionDigest: frozen.actionDigest,
      commandDigest: frozen.commandDigest,
      providerReceiptId,
    },
  };
}

export function signer(): DeviceWorkspaceListCommandSignerPort {
  return {
    async sign({ command }) {
      return {
        ...command,
        authorization: {
          schemaVersion: "crewon.device-authorization.v0",
          scheme: "ed25519",
          keyId: "workspace-key-1",
          issuedAt: "2026-08-10T00:00:30.000Z",
          expiresAt: command.expiresAt,
          approvalProof: null,
          signature: "A".repeat(86),
        },
      };
    },
  };
}

export function gatewayFixture(
  overrides: Partial<DeviceWorkspaceListDispatchClientPort>,
): DeviceWorkspaceListDispatchClientPort {
  return {
    execute:
      overrides.execute ??
      (async (command) => completedGatewayResolution(command)),
    reconcile:
      overrides.reconcile ??
      (async () => assert.fail("reconcile not expected")),
    cancel:
      overrides.cancel ?? (async () => assert.fail("cancel not expected")),
    close: overrides.close ?? (async () => undefined),
  };
}

export function signedCommand(
  request: RuntimeWorkerWorkspaceDispatchRequest,
  frozen: RuntimeWorkerFrozenWorkspaceCommand,
): DeviceWorkspaceListCommand {
  return {
    schemaVersion: "crewon.device-workspace-list-command.v0",
    protocolVersion: 1,
    commandKind: "workspaceList",
    deviceId: frozen.deviceId,
    executionId: frozen.executionId,
    leaseId: request.deliveryLease.leaseId,
    leaseEpoch: request.deliveryLease.epoch,
    expiresAt: request.deliveryLease.expiresAt,
    workspaceBindingId: frozen.workspaceBindingId,
    incarnationId: frozen.incarnationId,
    deviceBindingId: frozen.deviceBindingId,
    runtimeBindingId: frozen.runtimeBindingId,
    policySnapshotId: frozen.policySnapshotId,
    operation: "listTopLevel",
    limits: frozen.limits,
    actionDigest: frozen.actionDigest,
    commandDigest: frozen.commandDigest,
    idempotencyKey: "workspace-idempotency-1",
    traceContext: { traceparent: null, tracestate: null },
    authorization: {
      schemaVersion: "crewon.device-authorization.v0",
      scheme: "ed25519",
      keyId: "workspace-key-1",
      issuedAt: "2026-08-10T00:00:30.000Z",
      expiresAt: request.deliveryLease.expiresAt,
      approvalProof: null,
      signature: "A".repeat(86),
    },
  };
}

export function completedGatewayResolution(
  command: DeviceWorkspaceListCommand,
): Extract<DeviceWorkspaceListDispatchResolution, { status: "completed" }> {
  return {
    status: "completed",
    executionId: command.executionId,
    receiptId: "gateway-receipt-1",
    terminal: {
      schemaVersion: "crewon.device-workspace-list-event.v0",
      protocolVersion: 1,
      commandKind: "workspaceList",
      deviceId: command.deviceId,
      executionId: command.executionId,
      receiptId: "gateway-receipt-1",
      connectionEpoch: 1,
      workspaceBindingId: command.workspaceBindingId,
      incarnationId: command.incarnationId,
      deviceBindingId: command.deviceBindingId,
      runtimeBindingId: command.runtimeBindingId,
      actionDigest: command.actionDigest,
      commandDigest: command.commandDigest,
      sequence: 2,
      observedAt: "2026-08-10T00:00:31.000Z",
      type: "workspace_list.completed",
      data: {
        result: {
          schemaVersion: "crewon.workspace-list-result.v0",
          executionId: command.executionId,
          actionDigest: command.actionDigest,
          commandDigest: command.commandDigest,
          entries: [{ name: "README.md", kind: "file" }],
          truncated: false,
        },
      },
    },
  };
}

export function reference(
  frozen: RuntimeWorkerFrozenWorkspaceCommand,
  receiptId: string | null,
): DeviceWorkspaceListDispatchReference {
  return {
    deviceId: frozen.deviceId,
    executionId: frozen.executionId,
    workspaceBindingId: frozen.workspaceBindingId,
    incarnationId: frozen.incarnationId,
    deviceBindingId: frozen.deviceBindingId,
    runtimeBindingId: frozen.runtimeBindingId,
    actionDigest: frozen.actionDigest,
    commandDigest: frozen.commandDigest,
    receiptId,
  };
}

export function hasRuntimeError(
  code: string,
  certainty: "notSent" | "possiblySent",
): (error: unknown) => boolean {
  return (error) =>
    error instanceof RuntimeWorkspaceError &&
    error.code === code &&
    error.certainty === certainty;
}
