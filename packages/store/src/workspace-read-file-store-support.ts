import { createHash } from "node:crypto";

import {
  canonicalDeviceFilesystemReadCommandDigest,
  parseDeviceFilesystemReadDispatchReference,
  parseDeviceFilesystemReadWorkerDispatchRequest,
  parseDeviceFilesystemReadWorkerDispatchResponse,
} from "@crewon/contracts";
import {
  RunStoreError,
  type FrozenWorkspaceReadFileDispatch,
  type IdempotencyDescriptor,
  type WorkspaceReadFileLocator,
  type WorkspaceReadFileRecord,
} from "@crewon/application";

export function validateFrozenWorkspaceReadFileDispatch(
  input: FrozenWorkspaceReadFileDispatch,
): FrozenWorkspaceReadFileDispatch {
  const request = parseDeviceFilesystemReadWorkerDispatchRequest({
    schemaVersion: "crewon.device-filesystem-read-dispatch-request.v0",
    apiVersion: 1,
    operation: "execute",
    routeIntent: input.routeIntent,
    command: input.command,
  });
  if (request.operation !== "execute") invalid();
  const reference = parseDeviceFilesystemReadDispatchReference(input.reference);
  const command = request.command;
  if (
    reference.receiptId !== null ||
    reference.deviceId !== command.deviceId ||
    reference.executionId !== command.executionId ||
    reference.workspaceBindingId !== command.workspaceBindingId ||
    reference.incarnationId !== command.arguments.workspaceIncarnationId ||
    reference.deviceBindingId !== request.routeIntent.deviceBindingId ||
    reference.runtimeBindingId !== request.routeIntent.runtimeBindingId ||
    reference.actionDigest !== command.actionDigest ||
    reference.commandDigest !==
      canonicalDeviceFilesystemReadCommandDigest(command, digest) ||
    reference.leaseId !== command.leaseId ||
    reference.leaseEpoch !== command.leaseEpoch
  )
    invalid();
  return structuredClone({
    command,
    routeIntent: request.routeIntent,
    reference,
  });
}

export function validateWorkspaceReadFileLocator(
  input: WorkspaceReadFileLocator,
) {
  const expected = [
    "attemptId",
    "executionId",
    "runId",
    "spaceId",
    "stepId",
    "tenantId",
  ];
  if (!exactKeys(input, expected)) invalid();
  for (const value of Object.values(input)) id(value);
  return structuredClone(input);
}

export function requireWorkspaceReadFileLocator(
  operation: WorkspaceReadFileRecord,
  input: WorkspaceReadFileLocator,
): void {
  const locator = validateWorkspaceReadFileLocator({
    tenantId: input.tenantId,
    spaceId: input.spaceId,
    runId: input.runId,
    stepId: input.stepId,
    attemptId: input.attemptId,
    executionId: input.executionId,
  });
  if (
    operation.tenantId !== locator.tenantId ||
    operation.spaceId !== locator.spaceId ||
    operation.runId !== locator.runId ||
    operation.stepId !== locator.stepId ||
    operation.attemptId !== locator.attemptId ||
    operation.executionId !== locator.executionId
  )
    invalid();
}

export function validateWorkspaceReadFileIdempotency(
  input: IdempotencyDescriptor,
): IdempotencyDescriptor {
  if (
    !exactKeys(input, ["key", "requestFingerprint", "scope"]) ||
    typeof input.scope !== "string" ||
    typeof input.key !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(input.scope) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(input.key) ||
    typeof input.requestFingerprint !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(input.requestFingerprint)
  )
    invalid();
  return structuredClone(input);
}

export function validateWorkspaceReadFileRecord(
  input: WorkspaceReadFileRecord,
) {
  if (
    !exactKeys(input, [
      "attemptId",
      "executionId",
      "frozen",
      "resolution",
      "revision",
      "runId",
      "schemaVersion",
      "spaceId",
      "status",
      "stepId",
      "tenantId",
    ]) ||
    input.schemaVersion !== "crewon.workspace-read-file-operation.v0" ||
    !Number.isSafeInteger(input.revision) ||
    input.revision < 1
  )
    invalid();
  const locator = validateWorkspaceReadFileLocator({
    tenantId: input.tenantId,
    spaceId: input.spaceId,
    runId: input.runId,
    stepId: input.stepId,
    attemptId: input.attemptId,
    executionId: input.executionId,
  });
  const frozen = validateFrozenOrUpgraded(input.frozen);
  if (
    frozen.command.executionId !== locator.executionId ||
    frozen.command.runId !== locator.runId ||
    frozen.command.stepId !== locator.stepId ||
    frozen.command.attemptId !== locator.attemptId
  )
    invalid();
  if (input.resolution === null) {
    if (!["prepared", "possiblySent"].includes(input.status)) invalid();
  } else {
    const parsed = exactResolution(
      { ...input, frozen, resolution: null },
      "execute",
      input.resolution,
    );
    if (
      input.status !== parsed.status ||
      frozen.reference.receiptId !== parsed.receiptId
    )
      invalid();
  }
  return structuredClone({ ...input, frozen });
}

export function exactResolution(
  operation: WorkspaceReadFileRecord,
  phase: "execute" | "reconcile" | "cancel",
  resolution: unknown,
) {
  const request =
    phase === "execute"
      ? {
          schemaVersion: "crewon.device-filesystem-read-dispatch-request.v0",
          apiVersion: 1,
          operation: phase,
          routeIntent: operation.frozen.routeIntent,
          command: operation.frozen.command,
        }
      : {
          schemaVersion: "crewon.device-filesystem-read-dispatch-request.v0",
          apiVersion: 1,
          operation: phase,
          routeIntent: operation.frozen.routeIntent,
          reference: operation.frozen.reference,
        };
  return parseDeviceFilesystemReadWorkerDispatchResponse(
    {
      schemaVersion: "crewon.device-filesystem-read-dispatch-response.v0",
      apiVersion: 1,
      operation: phase,
      resolution,
    },
    parseDeviceFilesystemReadWorkerDispatchRequest(request),
    digest,
  ).resolution;
}

export function withResolution(
  operation: WorkspaceReadFileRecord,
  resolution: ReturnType<typeof exactResolution>,
): WorkspaceReadFileRecord {
  const oldReceipt = operation.frozen.reference.receiptId;
  if (oldReceipt !== null && resolution.receiptId !== oldReceipt) invalid();
  const receiptId = resolution.receiptId ?? oldReceipt;
  return validateWorkspaceReadFileRecord({
    ...operation,
    revision: operation.revision + 1,
    status: resolution.status,
    frozen: {
      ...operation.frozen,
      reference: { ...operation.frozen.reference, receiptId },
    },
    resolution,
  });
}

function validateFrozenOrUpgraded(input: FrozenWorkspaceReadFileDispatch) {
  const receiptId = input.reference.receiptId;
  const frozen = validateFrozenWorkspaceReadFileDispatch({
    ...input,
    reference: { ...input.reference, receiptId: null },
  });
  return receiptId === null
    ? frozen
    : {
        ...frozen,
        reference: { ...frozen.reference, receiptId: id(receiptId) },
      };
}
function digest(value: string) {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
function exactKeys(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.keys(value).sort().join(",") === [...keys].sort().join(",")
  );
}
function id(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(value)
  )
    invalid();
  return value;
}
function invalid(): never {
  throw new RunStoreError("workspace_read_file_stored_state_invalid");
}
