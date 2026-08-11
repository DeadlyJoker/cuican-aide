import type { ActorContext } from "./authorization-port.ts";
import { ApplicationError } from "./application-error.ts";
import type {
  FrozenWorkspaceListCommand,
  WorkspaceListOperationPhase,
  WorkspaceListResolution,
  WorkspaceOperationMutationResult,
  WorkspaceOperationPreparationResult,
  WorkspaceOperationRecord,
} from "./workspace-operation-store-port.ts";
import {
  validateWorkspaceOperationMutationResult,
  validateWorkspaceOperationRecord,
} from "./workspace-operation-store-port.ts";
import type {
  CancelWorkspaceListCommand,
  ExecuteWorkspaceListCommand,
  ReconcileWorkspaceListCommand,
} from "./workspace-list-application-service.ts";
export const DELIVERY_COMMIT_MARGIN_MS = 5_000;

export function phaseForCommand(
  command:
    | ExecuteWorkspaceListCommand
    | ReconcileWorkspaceListCommand
    | CancelWorkspaceListCommand,
): WorkspaceListOperationPhase {
  return command.kind === "workspaceList.execute"
    ? "execute"
    : command.kind === "workspaceList.reconcile"
      ? "reconcile"
      : "cancel";
}

export function unknownOutcome(
  operation: WorkspaceOperationRecord,
): WorkspaceListResolution {
  return {
    status: "unknownOutcome",
    executionId: operation.executionId,
    actionDigest: operation.command.actionDigest,
    commandDigest: operation.command.commandDigest,
    providerReceiptId: null,
  };
}

export function operationRecord(
  actor: ActorContext,
  command: ExecuteWorkspaceListCommand,
  frozen: FrozenWorkspaceListCommand,
): WorkspaceOperationRecord {
  return validateWorkspaceOperationRecord({
    schemaVersion: "crewon.workspace-operation.v0",
    tenantId: actor.tenantId,
    spaceId: actor.spaceId,
    threadId: command.threadId,
    expectedThreadRevision: command.expectedRevision,
    principalId: actor.principalId,
    actorId: actor.actorId,
    idempotencyKey: command.idempotencyKey,
    executionId: frozen.executionId,
    revision: 1,
    status: "prepared",
    command: frozen,
    resolution: null,
  });
}

export function validateActor(actor: ActorContext): void {
  if (!hasExactKeys(actor, ["actorId", "principalId", "spaceId", "tenantId"])) {
    throw new ApplicationError("validation", "actor_invalid");
  }
  for (const value of [
    actor.principalId,
    actor.actorId,
    actor.tenantId,
    actor.spaceId,
  ]) {
    requireIdentity(value, "actor_invalid");
  }
}

export function validateExecuteCommand(
  command: ExecuteWorkspaceListCommand,
): void {
  if (
    !hasExactKeys(command, [
      "expectedRevision",
      "idempotencyKey",
      "kind",
      "maxEntries",
      "threadId",
    ]) ||
    command.kind !== "workspaceList.execute" ||
    !Number.isSafeInteger(command.expectedRevision) ||
    command.expectedRevision < 1 ||
    !Number.isSafeInteger(command.maxEntries) ||
    command.maxEntries < 1 ||
    command.maxEntries > 200
  ) {
    throw new ApplicationError("validation", "workspace_list_command_invalid");
  }
  validateCommandIdentity(command);
}

export function validateExistingCommand(
  command: ReconcileWorkspaceListCommand | CancelWorkspaceListCommand,
  phase: "reconcile" | "cancel",
): void {
  if (
    !hasExactKeys(command, [
      "expectedOperationRevision",
      "executionId",
      "idempotencyKey",
      "kind",
      "threadId",
    ]) ||
    command.kind !== `workspaceList.${phase}` ||
    !Number.isSafeInteger(command.expectedOperationRevision) ||
    command.expectedOperationRevision < 1
  ) {
    throw new ApplicationError("validation", "workspace_list_command_invalid");
  }
  validateCommandIdentity(command);
  requireOpaqueId(command.executionId, "workspace_list_command_invalid");
}

function validateCommandIdentity(command: {
  threadId: string;
  idempotencyKey: string;
}): void {
  requireOpaqueId(command.threadId, "workspace_list_command_invalid");
  requireIdentity(
    command.idempotencyKey,
    "workspace_list_command_invalid",
    256,
  );
}

export function mapStoreError(error: unknown): ApplicationError {
  if (error instanceof ApplicationError) return error;
  const code =
    error instanceof Error && "code" in error && typeof error.code === "string"
      ? error.code
      : "workspace_operation_store_failed";
  switch (code) {
    case "workspace_operation_idempotency_conflict":
    case "workspace_operation_revision_conflict":
    case "workspace_operation_resolution_conflict":
    case "workspace_operation_thread_revision_conflict":
    case "workspace_delivery_attempt_stale":
    case "workspace_delivery_lease_active":
    case "workspace_delivery_lease_expired":
    case "workspace_delivery_lease_mismatch":
      return new ApplicationError("conflict", code, { cause: error });
    case "workspace_operation_thread_not_found":
      return new ApplicationError("notFound", "thread_not_found", {
        cause: error,
      });
    default:
      return new ApplicationError("internal", code, { cause: error });
  }
}

export function mutation(
  result: WorkspaceOperationPreparationResult,
): WorkspaceOperationMutationResult {
  return validateWorkspaceOperationMutationResult({
    disposition: result.disposition,
    operation: result.operation,
  });
}

function requireOpaqueId(value: string, code: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(value)) {
    throw new ApplicationError("validation", code);
  }
}

export function requireIdentity(
  value: string,
  code: string,
  maximum = 512,
): void {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value !== value.trim() ||
    new TextEncoder().encode(value).byteLength > maximum ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new ApplicationError("validation", code);
  }
}

function hasExactKeys(
  input: unknown,
  expected: readonly string[],
): input is Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return false;
  }
  const actual = Object.keys(input).sort();
  const sorted = [...expected].sort();
  return (
    actual.length === sorted.length &&
    actual.every((key, index) => key === sorted[index])
  );
}
