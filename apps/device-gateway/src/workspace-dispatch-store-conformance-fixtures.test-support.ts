import assert from "node:assert/strict";
import test from "node:test";

import type {
  DeviceWorkspaceListCommand,
  DeviceWorkspaceListDispatchResolution,
  DeviceWorkspaceListEvent,
  DeviceWorkspaceListPeerRoute,
} from "@crewon/contracts";

import { DeviceGatewayError } from "./device-gateway-error.ts";
import {
  parseWorkspaceDispatchAuthorityRecord,
  workspaceDispatchFingerprint,
  type WorkspaceDispatchAuthorityRecord,
  type WorkspaceDispatchStorePort,
} from "./workspace-dispatch-store.ts";
export function command(
  overrides: Partial<DeviceWorkspaceListCommand> = {},
): DeviceWorkspaceListCommand {
  return {
    schemaVersion: "crewon.device-workspace-list-command.v0",
    protocolVersion: 1,
    commandKind: "workspaceList",
    deviceId: "device-1",
    executionId: "workspace-execution-1",
    leaseId: "workspace-lease-1",
    leaseEpoch: 4,
    expiresAt: "2026-08-09T01:00:00.000Z",
    workspaceBindingId: "workspace-binding-1",
    incarnationId: "incarnation-1",
    deviceBindingId: "device-binding-1",
    runtimeBindingId: "runtime-binding-1",
    policySnapshotId: "policy-1",
    operation: "listTopLevel",
    limits: {
      depth: 0,
      maxEntries: 200,
      maxNameBytes: 255,
      maxOutputBytes: 64 * 1024,
      maxScannedEntries: 10_000,
      maxScannedNameBytes: 1024 * 1024,
      timeoutMs: 30_000,
    },
    actionDigest: `sha256:${"a".repeat(64)}`,
    commandDigest: `sha256:${"b".repeat(64)}`,
    idempotencyKey: "workspace-list-key-1",
    traceContext: { traceparent: null, tracestate: null },
    authorization: {
      schemaVersion: "crewon.device-authorization.v0",
      scheme: "ed25519",
      keyId: "control-key-1",
      issuedAt: "2026-08-09T00:00:00.000Z",
      expiresAt: "2026-08-09T00:30:00.000Z",
      approvalProof: null,
      signature: "A".repeat(86),
    },
    ...overrides,
  };
}

export function route(): DeviceWorkspaceListPeerRoute {
  return {
    deviceId: "device-1",
    gatewayId: "gateway-1",
    connectionId: "connection-1",
    connectionEpoch: 3,
    leaseExpiresAt: "2026-08-09T00:05:00.000Z",
  };
}

export function acceptedEvent(
  overrides: Partial<
    Extract<DeviceWorkspaceListEvent, { type: "workspace_list.accepted" }>
  > = {},
): Extract<DeviceWorkspaceListEvent, { type: "workspace_list.accepted" }> {
  return {
    ...eventEnvelope(1),
    type: "workspace_list.accepted",
    data: {
      leaseId: "workspace-lease-1",
      leaseEpoch: 4,
      expiresAt: "2026-08-09T01:00:00.000Z",
      policySnapshotId: "policy-1",
    },
    ...overrides,
  };
}

export function completedEvent(
  overrides: Partial<
    Extract<DeviceWorkspaceListEvent, { type: "workspace_list.completed" }>
  > = {},
): Extract<DeviceWorkspaceListEvent, { type: "workspace_list.completed" }> {
  return {
    ...eventEnvelope(2),
    type: "workspace_list.completed",
    data: {
      result: {
        schemaVersion: "crewon.workspace-list-result.v0",
        executionId: "workspace-execution-1",
        actionDigest: `sha256:${"a".repeat(64)}`,
        commandDigest: `sha256:${"b".repeat(64)}`,
        entries: [
          { name: "a", kind: "directory" },
          { name: "z.txt", kind: "file" },
        ],
        truncated: false,
      },
    },
    ...overrides,
  };
}

export function completedResolution(): Extract<
  DeviceWorkspaceListDispatchResolution,
  { status: "completed" }
> {
  return {
    status: "completed",
    executionId: "workspace-execution-1",
    receiptId: "workspace-receipt-1",
    terminal: completedEvent(),
  };
}

export function eventEnvelope(sequence: 1 | 2) {
  return {
    schemaVersion: "crewon.device-workspace-list-event.v0" as const,
    protocolVersion: 1 as const,
    commandKind: "workspaceList" as const,
    deviceId: "device-1",
    executionId: "workspace-execution-1",
    receiptId: "workspace-receipt-1",
    connectionEpoch: 3,
    workspaceBindingId: "workspace-binding-1",
    incarnationId: "incarnation-1",
    deviceBindingId: "device-binding-1",
    runtimeBindingId: "runtime-binding-1",
    actionDigest: `sha256:${"a".repeat(64)}`,
    commandDigest: `sha256:${"b".repeat(64)}`,
    sequence,
    observedAt: `2026-08-09T00:00:0${sequence}.000Z`,
  };
}

export function acknowledgement(throughSequence: 1 | 2) {
  const event = eventEnvelope(throughSequence);
  return {
    schemaVersion: "crewon.device-workspace-list-ack.v0",
    protocolVersion: 1,
    commandKind: "workspaceList",
    deviceId: event.deviceId,
    executionId: event.executionId,
    receiptId: event.receiptId,
    connectionEpoch: event.connectionEpoch,
    workspaceBindingId: event.workspaceBindingId,
    incarnationId: event.incarnationId,
    deviceBindingId: event.deviceBindingId,
    runtimeBindingId: event.runtimeBindingId,
    actionDigest: event.actionDigest,
    commandDigest: event.commandDigest,
    throughSequence,
  };
}

export function timestamp(offsetSeconds: number): string {
  return new Date(Date.UTC(2026, 7, 9, 0, 0, offsetSeconds)).toISOString();
}

export function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    (error instanceof DeviceGatewayError || error instanceof Error) &&
    "code" in error &&
    error.code === code;
}
