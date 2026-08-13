import { canonicalJson } from "./canonical-json.ts";
import type {
  FrozenWorkspaceListCommand,
  WorkspaceListLimits,
  WorkspaceListResolution,
} from "./workspace-operation-store-port.ts";
import { WORKSPACE_OPERATION_LIMITS } from "./workspace-operation-store-port.ts";
import { validateWorkspaceOperationRecord } from "./workspace-operation-record-validation.ts";
import {
  boundedIdentity,
  digest,
  hasExactKeys,
  integer,
  isPlainObject,
  opaqueId,
  positiveInteger,
  requireRawByteOrder,
  validateWorkspaceListEntry,
  workspaceStoreError,
} from "./workspace-operation-validation-common.ts";
export function validateFrozenWorkspaceListCommand(
  input: unknown,
): FrozenWorkspaceListCommand {
  if (
    !hasExactKeys(input, [
      "actionDigest",
      "commandDigest",
      "executionId",
      "incarnationId",
      "limits",
      "policySnapshotId",
      "runtimeBindingId",
      "workspaceBindingId",
    ])
  ) {
    throw workspaceStoreError("workspace_operation_command_invalid");
  }
  return {
    executionId: opaqueId(input.executionId),
    workspaceBindingId: opaqueId(input.workspaceBindingId),
    incarnationId: opaqueId(input.incarnationId),
    runtimeBindingId: opaqueId(input.runtimeBindingId),
    policySnapshotId: opaqueId(input.policySnapshotId),
    actionDigest: digest(input.actionDigest),
    commandDigest: digest(input.commandDigest),
    limits: validateWorkspaceListLimits(input.limits),
  };
}

export function canonicalWorkspaceListAction(input: {
  idempotencyKey: string;
  command: FrozenWorkspaceListCommand;
}): string {
  const command = validateFrozenWorkspaceListCommand(input.command);
  boundedIdentity(input.idempotencyKey, 256);
  return canonicalJson({
    schemaVersion: "crewon.workspace-list-action.v1",
    executionId: command.executionId,
    idempotencyKey: input.idempotencyKey,
    binding: {
      workspaceBindingId: command.workspaceBindingId,
      incarnationId: command.incarnationId,
      runtimeBindingId: command.runtimeBindingId,
    },
    policySnapshotId: command.policySnapshotId,
    operation: "listTopLevel",
    limits: command.limits,
  });
}

export function canonicalWorkspaceListDispatchCommand(input: {
  tenantId: string;
  spaceId: string;
  threadId: string;
  expectedThreadRevision: number;
  principalId: string;
  actorId: string;
  idempotencyKey: string;
  command: FrozenWorkspaceListCommand;
}): string {
  const command = validateFrozenWorkspaceListCommand(input.command);
  return canonicalJson({
    schemaVersion: "crewon.workspace-list-dispatch-command.v0",
    tenantId: opaqueId(input.tenantId),
    spaceId: opaqueId(input.spaceId),
    threadId: opaqueId(input.threadId),
    expectedThreadRevision: positiveInteger(input.expectedThreadRevision),
    principalId: boundedIdentity(input.principalId),
    actorId: boundedIdentity(input.actorId),
    idempotencyKey: boundedIdentity(input.idempotencyKey, 256),
    executionId: command.executionId,
    actionDigest: command.actionDigest,
    binding: {
      workspaceBindingId: command.workspaceBindingId,
      incarnationId: command.incarnationId,
      runtimeBindingId: command.runtimeBindingId,
    },
    policySnapshotId: command.policySnapshotId,
    operation: "listTopLevel",
    limits: command.limits,
  });
}

export function canonicalWorkspaceOperationResult(input: unknown): string {
  const operation = validateWorkspaceOperationRecord(input);
  return canonicalJson({
    schemaVersion: "crewon.workspace-operation-result-digest.v0",
    operation,
  });
}

export function validateWorkspaceListResolution(
  input: unknown,
  expected?: FrozenWorkspaceListCommand,
): WorkspaceListResolution {
  if (!isPlainObject(input)) {
    throw workspaceStoreError("workspace_operation_resolution_invalid");
  }
  const common = {
    executionId: opaqueId(input.executionId),
    actionDigest: digest(input.actionDigest),
    commandDigest: digest(input.commandDigest),
  };
  if (
    expected !== undefined &&
    (common.executionId !== expected.executionId ||
      common.actionDigest !== expected.actionDigest ||
      common.commandDigest !== expected.commandDigest)
  ) {
    throw workspaceStoreError(
      "workspace_operation_resolution_identity_mismatch",
    );
  }
  let resolution: WorkspaceListResolution;
  if (input.status === "completed") {
    if (
      !hasExactKeys(input, [
        "actionDigest",
        "commandDigest",
        "entries",
        "executionId",
        "providerReceiptId",
        "status",
        "truncated",
      ]) ||
      !Array.isArray(input.entries) ||
      input.entries.length > WORKSPACE_OPERATION_LIMITS.maxEntries ||
      typeof input.truncated !== "boolean"
    ) {
      throw workspaceStoreError("workspace_operation_resolution_invalid");
    }
    const entries = input.entries.map(validateWorkspaceListEntry);
    requireRawByteOrder(entries);
    resolution = {
      status: "completed",
      ...common,
      providerReceiptId: opaqueId(input.providerReceiptId),
      entries,
      truncated: input.truncated,
    };
  } else if (input.status === "failed") {
    if (
      !hasExactKeys(input, [
        "actionDigest",
        "code",
        "commandDigest",
        "executionId",
        "providerReceiptId",
        "retryable",
        "status",
      ]) ||
      typeof input.retryable !== "boolean" ||
      typeof input.code !== "string" ||
      !/^[a-z0-9_.:-]{1,128}$/u.test(input.code)
    ) {
      throw workspaceStoreError("workspace_operation_resolution_invalid");
    }
    resolution = {
      status: "failed",
      ...common,
      providerReceiptId: opaqueId(input.providerReceiptId),
      code: input.code,
      retryable: input.retryable,
    };
  } else if (input.status === "canceled" || input.status === "unknownOutcome") {
    if (
      !hasExactKeys(input, [
        "actionDigest",
        "commandDigest",
        "executionId",
        "providerReceiptId",
        "status",
      ])
    ) {
      throw workspaceStoreError("workspace_operation_resolution_invalid");
    }
    resolution = {
      status: input.status,
      ...common,
      providerReceiptId:
        input.providerReceiptId === null
          ? null
          : opaqueId(input.providerReceiptId),
    };
  } else {
    throw workspaceStoreError("workspace_operation_resolution_invalid");
  }
  if (
    new TextEncoder().encode(JSON.stringify(resolution)).byteLength >
    (expected?.limits.maxOutputBytes ??
      WORKSPACE_OPERATION_LIMITS.maxOutputBytes)
  ) {
    throw workspaceStoreError("workspace_operation_resolution_too_large");
  }
  return resolution;
}

export function validateWorkspaceListLimits(
  input: unknown,
): WorkspaceListLimits {
  if (
    !hasExactKeys(input, [
      "depth",
      "maxEntries",
      "maxNameBytes",
      "maxOutputBytes",
      "maxScannedEntries",
      "maxScannedNameBytes",
      "timeoutMs",
    ]) ||
    input.depth !== 0
  ) {
    throw workspaceStoreError("workspace_operation_limits_invalid");
  }
  const limits = {
    depth: 0 as const,
    maxEntries: integer(
      input.maxEntries,
      1,
      WORKSPACE_OPERATION_LIMITS.maxEntries,
    ),
    maxNameBytes: integer(
      input.maxNameBytes,
      1,
      WORKSPACE_OPERATION_LIMITS.maxNameBytes,
    ),
    maxOutputBytes: integer(
      input.maxOutputBytes,
      1,
      WORKSPACE_OPERATION_LIMITS.maxOutputBytes,
    ),
    maxScannedEntries: integer(
      input.maxScannedEntries,
      1,
      WORKSPACE_OPERATION_LIMITS.maxScannedEntries,
    ),
    maxScannedNameBytes: integer(
      input.maxScannedNameBytes,
      1,
      WORKSPACE_OPERATION_LIMITS.maxScannedNameBytes,
    ),
    timeoutMs: integer(
      input.timeoutMs,
      1,
      WORKSPACE_OPERATION_LIMITS.maxTimeoutMs,
    ),
  };
  if (limits.maxScannedEntries < limits.maxEntries) {
    throw workspaceStoreError("workspace_operation_limits_invalid");
  }
  return limits;
}
