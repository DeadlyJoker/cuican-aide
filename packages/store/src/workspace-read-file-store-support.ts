import { createHash } from "node:crypto";

import {
  WORKSPACE_READ_FILE_LIMITS,
  canonicalJson,
  RunStoreError,
  type FrozenWorkspaceReadFileDispatch,
  type IdempotencyDescriptor,
  type WorkspaceReadFileLocator,
  type WorkspaceReadFileRecord,
  type WorkspaceReadFileResolution,
} from "@crewon/application";

const EMPTY_DIGEST = `sha256:${"0".repeat(64)}`;

export function validateFrozenWorkspaceReadFileDispatch(
  input: FrozenWorkspaceReadFileDispatch,
): FrozenWorkspaceReadFileDispatch {
  if (
    !exactKeys(input, [
      "actionDigest",
      "attemptId",
      "commandDigest",
      "executionId",
      "expiresAt",
      "incarnationId",
      "leaseEpoch",
      "leaseId",
      "limits",
      "policySnapshotId",
      "providerReceiptId",
      "relativePathSegments",
      "runId",
      "runtimeBindingId",
      "schemaVersion",
      "stepId",
      "workspaceBindingId",
    ]) ||
    input.schemaVersion !== "crewon.workspace-read-file-command.v0" ||
    !Number.isSafeInteger(input.leaseEpoch) ||
    input.leaseEpoch < 1 ||
    !canonicalTimestamp(input.expiresAt) ||
    !exactKeys(input.limits, [
      "maxArtifactBytes",
      "maxOutputBytes",
      "timeoutMs",
    ]) ||
    input.limits.timeoutMs !== WORKSPACE_READ_FILE_LIMITS.timeoutMs ||
    input.limits.maxOutputBytes !== WORKSPACE_READ_FILE_LIMITS.maxOutputBytes ||
    input.limits.maxArtifactBytes !==
      WORKSPACE_READ_FILE_LIMITS.maxArtifactBytes ||
    !Array.isArray(input.relativePathSegments) ||
    input.relativePathSegments.length < 1 ||
    input.relativePathSegments.length > 32
  ) {
    invalid();
  }
  for (const value of [
    input.executionId,
    input.runId,
    input.stepId,
    input.attemptId,
    input.leaseId,
    input.workspaceBindingId,
    input.incarnationId,
    input.runtimeBindingId,
    input.policySnapshotId,
  ]) {
    id(value);
  }
  for (const segment of input.relativePathSegments) pathSegment(segment);
  digest(input.actionDigest);
  digest(input.commandDigest);
  if (input.providerReceiptId !== null) id(input.providerReceiptId);
  const base: FrozenWorkspaceReadFileDispatch = {
    ...input,
    commandDigest: EMPTY_DIGEST,
    providerReceiptId: null,
  };
  if (
    input.commandDigest !==
    sha256(
      canonicalJson({
        schemaVersion: "crewon.workspace-read-file-command-digest.v0",
        command: base,
      }),
    )
  ) {
    invalid();
  }
  return structuredClone(input);
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
  ) {
    invalid();
  }
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
  ) {
    invalid();
  }
  return structuredClone(input);
}

export function validateWorkspaceReadFileRecord(
  input: WorkspaceReadFileRecord,
): WorkspaceReadFileRecord {
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
  ) {
    invalid();
  }
  const locator = validateWorkspaceReadFileLocator({
    tenantId: input.tenantId,
    spaceId: input.spaceId,
    runId: input.runId,
    stepId: input.stepId,
    attemptId: input.attemptId,
    executionId: input.executionId,
  });
  const frozen = validateFrozenWorkspaceReadFileDispatch(input.frozen);
  if (
    frozen.executionId !== locator.executionId ||
    frozen.runId !== locator.runId ||
    frozen.stepId !== locator.stepId ||
    frozen.attemptId !== locator.attemptId
  ) {
    invalid();
  }
  if (input.resolution === null) {
    if (input.status !== "prepared" && input.status !== "possiblySent")
      invalid();
  } else {
    const parsed = exactResolution(
      { ...input, frozen, resolution: null },
      "execute",
      input.resolution,
    );
    if (
      input.status !== parsed.status ||
      frozen.providerReceiptId !== parsed.providerReceiptId
    ) {
      invalid();
    }
  }
  return structuredClone({ ...input, frozen });
}

export function exactResolution(
  operation: WorkspaceReadFileRecord,
  _phase: "execute" | "reconcile" | "cancel",
  input: unknown,
): WorkspaceReadFileResolution {
  if (!plainObject(input)) invalid();
  const common = {
    executionId: id(input.executionId),
    actionDigest: digest(input.actionDigest),
    commandDigest: digest(input.commandDigest),
  };
  if (
    common.executionId !== operation.executionId ||
    common.actionDigest !== operation.frozen.actionDigest ||
    common.commandDigest !== operation.frozen.commandDigest
  ) {
    invalid();
  }
  if (input.status === "completed") {
    if (
      !exactKeys(input, [
        "actionDigest",
        "commandDigest",
        "executionId",
        "providerReceiptId",
        "result",
        "status",
      ]) ||
      !plainObject(input.result) ||
      !exactKeys(input.result, [
        "byteLength",
        "content",
        "encoding",
        "outputDigest",
        "schemaVersion",
      ]) ||
      input.result.schemaVersion !== "crewon.workspace-file-read-result.v0" ||
      input.result.encoding !== "utf8" ||
      typeof input.result.content !== "string" ||
      input.result.byteLength !== Buffer.byteLength(input.result.content) ||
      input.result.byteLength > WORKSPACE_READ_FILE_LIMITS.maxOutputBytes ||
      input.result.outputDigest !== sha256(input.result.content)
    ) {
      invalid();
    }
    return {
      status: "completed",
      ...common,
      providerReceiptId: id(input.providerReceiptId),
      result: {
        schemaVersion: "crewon.workspace-file-read-result.v0",
        encoding: "utf8",
        content: input.result.content,
        byteLength: input.result.byteLength,
        outputDigest: input.result.outputDigest,
      },
    };
  }
  if (input.status === "failed") {
    if (
      !exactKeys(input, [
        "actionDigest",
        "code",
        "commandDigest",
        "executionId",
        "providerReceiptId",
        "retryable",
        "status",
      ]) ||
      typeof input.code !== "string" ||
      !/^[a-z0-9_.:-]{1,128}$/u.test(input.code) ||
      typeof input.retryable !== "boolean"
    ) {
      invalid();
    }
    return {
      status: "failed",
      ...common,
      providerReceiptId: id(input.providerReceiptId),
      code: input.code,
      retryable: input.retryable,
    };
  }
  if (input.status !== "canceled" && input.status !== "unknownOutcome")
    invalid();
  if (
    !exactKeys(input, [
      "actionDigest",
      "commandDigest",
      "executionId",
      "providerReceiptId",
      "status",
    ]) ||
    (input.status === "canceled" && input.providerReceiptId === null)
  ) {
    invalid();
  }
  return {
    status: input.status,
    ...common,
    providerReceiptId:
      input.providerReceiptId === null ? null : id(input.providerReceiptId),
  };
}

export function withResolution(
  operation: WorkspaceReadFileRecord,
  resolution: ReturnType<typeof exactResolution>,
): WorkspaceReadFileRecord {
  const oldReceipt = operation.frozen.providerReceiptId;
  if (oldReceipt !== null && resolution.providerReceiptId !== oldReceipt)
    invalid();
  const committedResolution =
    resolution.status === "unknownOutcome" &&
    resolution.providerReceiptId === null &&
    oldReceipt !== null
      ? { ...resolution, providerReceiptId: oldReceipt }
      : resolution;
  return validateWorkspaceReadFileRecord({
    ...operation,
    revision: operation.revision + 1,
    status: resolution.status,
    frozen: {
      ...operation.frozen,
      providerReceiptId: committedResolution.providerReceiptId,
    },
    resolution: committedResolution,
  });
}

function canonicalTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function pathSegment(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    Buffer.byteLength(value) > 255 ||
    value === "." ||
    value === ".." ||
    /[\\/:\0]/u.test(value)
  ) {
    invalid();
  }
  return value;
}

function digest(value: unknown): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value))
    invalid();
  return value;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function exactKeys(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    plainObject(value) &&
    Object.keys(value).sort().join(",") === [...keys].sort().join(",")
  );
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function id(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(value)
  ) {
    invalid();
  }
  return value;
}

function invalid(): never {
  throw new RunStoreError("workspace_read_file_stored_state_invalid");
}
