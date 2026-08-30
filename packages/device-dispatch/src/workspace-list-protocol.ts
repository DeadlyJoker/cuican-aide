import { createHash } from "node:crypto";
import {
  WORKSPACE_LIST_HARD_LIMITS,
  WorkspaceListExecutionError,
  type WorkspaceDirectoryBinding,
  type WorkspaceExecutionAuthority,
  type WorkspaceListCommand,
  type WorkspaceListLimits,
  type WorkspaceListProjection,
  type WorkspaceListResult,
} from "./workspace-list-types.ts";

import { parseProjectedEntry } from "./workspace-list-runtime.ts";

export const OUTPUT_SCHEMA_VERSION = "crewon.workspace-list-result.v0" as const;
const COMMAND_SCHEMA_VERSION = "crewon.workspace-list-command.v1" as const;
const ACTION_SCHEMA_VERSION = "crewon.workspace-list-action.v1" as const;
const DISPATCH_SCHEMA_VERSION =
  "crewon.workspace-list-dispatch-command.v0" as const;

export function createWorkspaceListCommand(
  input: Readonly<{
    executionId: string;
    idempotencyKey: string;
    authority: WorkspaceExecutionAuthority;
    binding: WorkspaceDirectoryBinding;
    policySnapshotId: string;
    limits: WorkspaceListLimits;
  }>,
): WorkspaceListCommand {
  const candidate = {
    schemaVersion: COMMAND_SCHEMA_VERSION,
    executionId: requireOpaqueId(
      input.executionId,
      "workspace_list_execution_id_invalid",
    ),
    idempotencyKey: requireOpaqueId(
      input.idempotencyKey,
      "workspace_list_idempotency_key_invalid",
    ),
    authority: parseAuthority(input.authority),
    binding: parseBinding(input.binding),
    policySnapshotId: requireOpaqueId(
      input.policySnapshotId,
      "workspace_list_policy_invalid",
    ),
    operation: "listTopLevel" as const,
    limits: parseLimits(input.limits),
  };
  const actionDigest = workspaceListActionDigest(candidate);
  return {
    ...candidate,
    actionDigest,
    commandDigest: workspaceListCommandDigest({ ...candidate, actionDigest }),
  };
}

export function parseWorkspaceListCommand(
  input: unknown,
): WorkspaceListCommand {
  if (
    !hasExactKeys(input, [
      "actionDigest",
      "authority",
      "binding",
      "commandDigest",
      "executionId",
      "idempotencyKey",
      "limits",
      "operation",
      "policySnapshotId",
      "schemaVersion",
    ]) ||
    input.schemaVersion !== COMMAND_SCHEMA_VERSION ||
    input.operation !== "listTopLevel"
  ) {
    throw new WorkspaceListExecutionError("workspace_list_command_invalid");
  }
  const command = createWorkspaceListCommand({
    executionId: requireOpaqueId(
      input.executionId,
      "workspace_list_execution_id_invalid",
    ),
    idempotencyKey: requireOpaqueId(
      input.idempotencyKey,
      "workspace_list_idempotency_key_invalid",
    ),
    authority: parseAuthority(input.authority),
    binding: parseBinding(input.binding),
    policySnapshotId: requireOpaqueId(
      input.policySnapshotId,
      "workspace_list_policy_invalid",
    ),
    limits: parseLimits(input.limits),
  });
  if (input.actionDigest !== command.actionDigest) {
    throw new WorkspaceListExecutionError(
      "workspace_list_action_digest_invalid",
    );
  }
  if (input.commandDigest !== command.commandDigest) {
    throw new WorkspaceListExecutionError(
      "workspace_list_command_digest_invalid",
    );
  }
  return command;
}

export function projectWorkspaceListResult(
  input: unknown,
  expectedCommand: WorkspaceListCommand,
): WorkspaceListProjection {
  const result = parseWorkspaceListResult(input, expectedCommand);
  return {
    entries: result.entries.map((entry) => ({ ...entry })),
    truncated: result.truncated,
  };
}

export function parseWorkspaceListResult(
  input: unknown,
  expectedCommand: WorkspaceListCommand,
): WorkspaceListResult {
  const expected = parseWorkspaceListCommand(expectedCommand);
  if (
    !hasExactKeys(input, [
      "actionDigest",
      "commandDigest",
      "entries",
      "executionId",
      "schemaVersion",
      "truncated",
    ]) ||
    input.schemaVersion !== OUTPUT_SCHEMA_VERSION ||
    typeof input.truncated !== "boolean" ||
    !Array.isArray(input.entries) ||
    input.entries.length > expected.limits.maxEntries
  ) {
    throw new WorkspaceListExecutionError("workspace_list_result_invalid");
  }
  const entries = input.entries.map((entry) => parseProjectedEntry(entry));
  for (let index = 1; index < entries.length; index += 1) {
    if (
      compareBytes(
        utf8(entries[index - 1]!.name),
        utf8(entries[index]!.name),
      ) >= 0
    ) {
      throw new WorkspaceListExecutionError("workspace_list_result_invalid");
    }
  }
  const result: WorkspaceListResult = {
    schemaVersion: OUTPUT_SCHEMA_VERSION,
    executionId: requireOpaqueId(
      input.executionId,
      "workspace_list_execution_id_invalid",
    ),
    actionDigest: requireDigest(input.actionDigest),
    commandDigest: requireDigest(input.commandDigest),
    entries,
    truncated: input.truncated,
  };
  if (
    result.executionId !== expected.executionId ||
    result.actionDigest !== expected.actionDigest ||
    result.commandDigest !== expected.commandDigest
  ) {
    throw new WorkspaceListExecutionError(
      "workspace_list_result_identity_mismatch",
    );
  }
  requireOutputBound(result, expected.limits.maxOutputBytes);
  return result;
}

export function parseBinding(input: unknown): WorkspaceDirectoryBinding {
  if (
    !hasExactKeys(input, [
      "deviceBindingId",
      "deviceId",
      "incarnationId",
      "runtimeBindingId",
      "workspaceBindingId",
    ])
  ) {
    throw new WorkspaceListExecutionError("workspace_list_binding_invalid");
  }
  return {
    workspaceBindingId: requireOpaqueId(
      input.workspaceBindingId,
      "workspace_list_binding_invalid",
    ),
    incarnationId: requireOpaqueId(
      input.incarnationId,
      "workspace_list_binding_invalid",
    ),
    deviceBindingId: requireOpaqueId(
      input.deviceBindingId,
      "workspace_list_binding_invalid",
    ),
    deviceId: requireOpaqueId(input.deviceId, "workspace_list_binding_invalid"),
    runtimeBindingId: requireOpaqueId(
      input.runtimeBindingId,
      "workspace_list_binding_invalid",
    ),
  };
}

export function parseAuthority(input: unknown): WorkspaceExecutionAuthority {
  if (
    !hasExactKeys(input, [
      "actorId",
      "expectedThreadRevision",
      "principalId",
      "spaceId",
      "tenantId",
      "threadId",
    ])
  ) {
    throw new WorkspaceListExecutionError("workspace_list_authority_invalid");
  }
  return {
    tenantId: requireOpaqueId(
      input.tenantId,
      "workspace_list_authority_invalid",
    ),
    spaceId: requireOpaqueId(input.spaceId, "workspace_list_authority_invalid"),
    threadId: requireOpaqueId(
      input.threadId,
      "workspace_list_authority_invalid",
    ),
    expectedThreadRevision: boundedInteger(
      input.expectedThreadRevision,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    principalId: requireOpaqueId(
      input.principalId,
      "workspace_list_authority_invalid",
    ),
    actorId: requireOpaqueId(input.actorId, "workspace_list_authority_invalid"),
  };
}

export function parseLimits(input: unknown): WorkspaceListLimits {
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
    throw new WorkspaceListExecutionError("workspace_list_limits_invalid");
  }
  const limits: WorkspaceListLimits = {
    depth: 0,
    maxEntries: boundedInteger(
      input.maxEntries,
      1,
      WORKSPACE_LIST_HARD_LIMITS.maxEntries,
    ),
    maxNameBytes: boundedInteger(
      input.maxNameBytes,
      1,
      WORKSPACE_LIST_HARD_LIMITS.maxNameBytes,
    ),
    maxOutputBytes: boundedInteger(
      input.maxOutputBytes,
      1,
      WORKSPACE_LIST_HARD_LIMITS.maxOutputBytes,
    ),
    maxScannedEntries: boundedInteger(
      input.maxScannedEntries,
      1,
      WORKSPACE_LIST_HARD_LIMITS.maxScannedEntries,
    ),
    maxScannedNameBytes: boundedInteger(
      input.maxScannedNameBytes,
      1,
      WORKSPACE_LIST_HARD_LIMITS.maxScannedNameBytes,
    ),
    timeoutMs: boundedInteger(
      input.timeoutMs,
      WORKSPACE_LIST_HARD_LIMITS.minTimeoutMs,
      WORKSPACE_LIST_HARD_LIMITS.maxTimeoutMs,
    ),
  };
  if (limits.maxScannedEntries < limits.maxEntries) {
    throw new WorkspaceListExecutionError("workspace_list_limits_invalid");
  }
  return limits;
}

export function workspaceListActionDigest(
  input: Omit<WorkspaceListCommand, "actionDigest" | "commandDigest">,
): string {
  const canonical = canonicalJson({
    schemaVersion: ACTION_SCHEMA_VERSION,
    executionId: input.executionId,
    idempotencyKey: input.idempotencyKey,
    binding: {
      workspaceBindingId: input.binding.workspaceBindingId,
      incarnationId: input.binding.incarnationId,
      deviceBindingId: input.binding.deviceBindingId,
      deviceId: input.binding.deviceId,
      runtimeBindingId: input.binding.runtimeBindingId,
    },
    policySnapshotId: input.policySnapshotId,
    operation: input.operation,
    limits: input.limits,
  });
  return sha256(canonical);
}

export function workspaceListCommandDigest(
  input: Omit<WorkspaceListCommand, "commandDigest">,
): string {
  return sha256(
    canonicalJson({
      schemaVersion: DISPATCH_SCHEMA_VERSION,
      ...input.authority,
      idempotencyKey: input.idempotencyKey,
      executionId: input.executionId,
      actionDigest: input.actionDigest,
      binding: input.binding,
      policySnapshotId: input.policySnapshotId,
      operation: input.operation,
      limits: input.limits,
    }),
  );
}

export function requireSameBinding(
  actual: WorkspaceDirectoryBinding,
  expected: WorkspaceDirectoryBinding,
): void {
  const binding = parseBinding(actual);
  if (
    Object.keys(binding).some(
      (key) =>
        binding[key as keyof WorkspaceDirectoryBinding] !==
        expected[key as keyof WorkspaceDirectoryBinding],
    )
  ) {
    throw new WorkspaceListExecutionError(
      "workspace_list_capability_binding_mismatch",
    );
  }
}

export function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(stabilize(value));
}

export function stabilize(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(stabilize);
  if (!isPlainObject(value)) {
    throw new WorkspaceListExecutionError("workspace_list_command_invalid");
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stabilize(value[key])]),
  );
}

export function requireOutputBound(
  result: WorkspaceListResult,
  maximum: number,
): void {
  if (utf8(JSON.stringify(result)).byteLength > maximum) {
    throw new WorkspaceListExecutionError("workspace_list_output_too_large");
  }
}

export function requireOpaqueId(value: unknown, code: string): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(value)
  ) {
    throw new WorkspaceListExecutionError(code);
  }
  return value;
}

export function requireDigest(value: unknown): string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw new WorkspaceListExecutionError(
      "workspace_list_action_digest_invalid",
    );
  }
  return value;
}

export function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < minimum ||
    Number(value) > maximum
  ) {
    throw new WorkspaceListExecutionError("workspace_list_limits_invalid");
  }
  return Number(value);
}

export function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.byteLength, right.byteLength);
  for (let index = 0; index < length; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) {
      return difference;
    }
  }
  return left.byteLength - right.byteLength;
}

export function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function hasExactKeys(
  input: unknown,
  expected: readonly string[],
): input is Record<string, unknown> {
  if (!isPlainObject(input)) {
    return false;
  }
  const actual = Object.keys(input).sort();
  const required = [...expected].sort();
  return (
    actual.length === required.length &&
    actual.every((key, index) => key === required[index])
  );
}

export function isPlainObject(
  input: unknown,
): input is Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(input);
  return prototype === Object.prototype || prototype === null;
}
