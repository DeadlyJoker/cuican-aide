import type {
  WorkspaceOperationEvent,
  WorkspaceOperationEventQuery,
  WorkspaceOperationListPage,
  WorkspaceOperationListQuery,
  WorkspaceOperationLocator,
  WorkspaceOperationRecord,
  WorkspaceOperationSnapshot,
} from "./workspace-operation-store-port.ts";
import {
  WORKSPACE_OPERATION_EVENT_PAGE_MAX_LIMIT,
  WORKSPACE_OPERATION_LIST_PAGE_MAX_LIMIT,
} from "./workspace-operation-store-port.ts";
import {
  compareBytes,
  boundedIdentity,
  hasExactKeys,
  opaqueId,
  positiveInteger,
  workspaceStoreError,
} from "./workspace-operation-validation-common.ts";
import {
  validateFrozenWorkspaceListCommand,
  validateWorkspaceListResolution,
} from "./workspace-operation-command-validation.ts";
export function validateWorkspaceOperationRecord(
  input: unknown,
): WorkspaceOperationRecord {
  if (
    !hasExactKeys(input, [
      "actorId",
      "command",
      "executionId",
      "expectedThreadRevision",
      "idempotencyKey",
      "principalId",
      "resolution",
      "revision",
      "schemaVersion",
      "spaceId",
      "status",
      "tenantId",
      "threadId",
    ]) ||
    input.schemaVersion !== "crewon.workspace-operation.v0"
  ) {
    throw workspaceStoreError("workspace_operation_invalid");
  }
  const command = validateFrozenWorkspaceListCommand(input.command);
  const resolution =
    input.resolution === null
      ? null
      : validateWorkspaceListResolution(input.resolution, command);
  const status = input.status;
  if (
    (status !== "prepared" &&
      status !== "completed" &&
      status !== "failed" &&
      status !== "canceled" &&
      status !== "unknownOutcome") ||
    (status === "prepared") !== (resolution === null) ||
    (resolution !== null && resolution.status !== status)
  ) {
    throw workspaceStoreError("workspace_operation_invalid");
  }
  const executionId = opaqueId(input.executionId);
  if (command.executionId !== executionId) {
    throw workspaceStoreError("workspace_operation_invalid");
  }
  return {
    schemaVersion: "crewon.workspace-operation.v0",
    tenantId: opaqueId(input.tenantId),
    spaceId: opaqueId(input.spaceId),
    threadId: opaqueId(input.threadId),
    expectedThreadRevision: positiveInteger(input.expectedThreadRevision),
    principalId: boundedIdentity(input.principalId),
    actorId: boundedIdentity(input.actorId),
    idempotencyKey: boundedIdentity(input.idempotencyKey, 256),
    executionId,
    revision: positiveInteger(input.revision),
    status,
    command,
    resolution,
  };
}

export function validateWorkspaceOperationLocator(
  input: unknown,
): WorkspaceOperationLocator {
  if (
    !hasExactKeys(input, ["executionId", "spaceId", "tenantId", "threadId"])
  ) {
    throw workspaceStoreError("workspace_operation_locator_invalid");
  }
  return {
    tenantId: opaqueId(input.tenantId),
    spaceId: opaqueId(input.spaceId),
    threadId: opaqueId(input.threadId),
    executionId: opaqueId(input.executionId),
  };
}

export function validateWorkspaceOperationSnapshot(
  input: unknown,
): WorkspaceOperationSnapshot {
  if (!hasExactKeys(input, ["eventSequence", "operation"])) {
    throw workspaceStoreError("workspace_operation_snapshot_invalid");
  }
  const operation = validateWorkspaceOperationRecord(input.operation);
  const eventSequence = positiveInteger(input.eventSequence);
  if (eventSequence !== operation.revision) {
    throw workspaceStoreError("workspace_operation_snapshot_invalid");
  }
  return { operation, eventSequence };
}

export function validateWorkspaceOperationEvent(
  input: unknown,
): WorkspaceOperationEvent {
  if (!hasExactKeys(input, ["operation", "sequence"])) {
    throw workspaceStoreError("workspace_operation_event_invalid");
  }
  const operation = validateWorkspaceOperationRecord(input.operation);
  const sequence = positiveInteger(input.sequence);
  if (sequence !== operation.revision) {
    throw workspaceStoreError("workspace_operation_event_invalid");
  }
  return { sequence, operation };
}

export function validateWorkspaceOperationEventQuery(
  input: unknown,
): WorkspaceOperationEventQuery {
  if (
    !hasExactKeys(input, [
      "afterSequence",
      "executionId",
      "limit",
      "spaceId",
      "tenantId",
      "threadId",
    ])
  ) {
    throw workspaceStoreError("workspace_operation_event_query_invalid");
  }
  const locator = validateWorkspaceOperationLocator({
    tenantId: input.tenantId,
    spaceId: input.spaceId,
    threadId: input.threadId,
    executionId: input.executionId,
  });
  if (
    !Number.isSafeInteger(input.afterSequence) ||
    Number(input.afterSequence) < 0 ||
    !Number.isSafeInteger(input.limit) ||
    Number(input.limit) < 1 ||
    Number(input.limit) > WORKSPACE_OPERATION_EVENT_PAGE_MAX_LIMIT
  ) {
    throw workspaceStoreError("workspace_operation_event_query_invalid");
  }
  return {
    ...locator,
    afterSequence: Number(input.afterSequence),
    limit: Number(input.limit),
  };
}

export function validateWorkspaceOperationEventPage(
  input: unknown,
  queryInput: WorkspaceOperationEventQuery,
): readonly WorkspaceOperationEvent[] {
  const query = validateWorkspaceOperationEventQuery(queryInput);
  if (!Array.isArray(input) || input.length > query.limit) {
    throw workspaceStoreError("workspace_operation_event_page_invalid");
  }
  const events = input.map(validateWorkspaceOperationEvent);
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    if (
      event.sequence !== query.afterSequence + index + 1 ||
      event.operation.tenantId !== query.tenantId ||
      event.operation.spaceId !== query.spaceId ||
      event.operation.threadId !== query.threadId ||
      event.operation.executionId !== query.executionId
    ) {
      throw workspaceStoreError("workspace_operation_event_page_invalid");
    }
  }
  return events;
}

export function validateWorkspaceOperationListQuery(
  input: unknown,
): WorkspaceOperationListQuery {
  if (
    !hasExactKeys(input, [
      "afterExecutionId",
      "limit",
      "spaceId",
      "tenantId",
      "threadId",
    ])
  ) {
    throw workspaceStoreError("workspace_operation_list_query_invalid");
  }
  if (
    !Number.isSafeInteger(input.limit) ||
    Number(input.limit) < 1 ||
    Number(input.limit) > WORKSPACE_OPERATION_LIST_PAGE_MAX_LIMIT
  ) {
    throw workspaceStoreError("workspace_operation_list_query_invalid");
  }
  return {
    tenantId: opaqueId(input.tenantId),
    spaceId: opaqueId(input.spaceId),
    threadId: opaqueId(input.threadId),
    afterExecutionId:
      input.afterExecutionId === null ? null : opaqueId(input.afterExecutionId),
    limit: Number(input.limit),
  };
}

export function validateWorkspaceOperationListPage(
  input: unknown,
  queryInput: WorkspaceOperationListQuery,
): WorkspaceOperationListPage {
  const query = validateWorkspaceOperationListQuery(queryInput);
  if (
    !hasExactKeys(input, ["nextAfterExecutionId", "operations"]) ||
    !Array.isArray(input.operations) ||
    input.operations.length > query.limit
  ) {
    throw workspaceStoreError("workspace_operation_list_page_invalid");
  }
  const operations = input.operations.map(validateWorkspaceOperationRecord);
  let previousExecutionId = query.afterExecutionId;
  for (const operation of operations) {
    if (
      operation.tenantId !== query.tenantId ||
      operation.spaceId !== query.spaceId ||
      operation.threadId !== query.threadId ||
      (previousExecutionId !== null &&
        compareBytes(previousExecutionId, operation.executionId) >= 0)
    ) {
      throw workspaceStoreError("workspace_operation_list_page_invalid");
    }
    previousExecutionId = operation.executionId;
  }
  const nextAfterExecutionId =
    input.nextAfterExecutionId === null
      ? null
      : opaqueId(input.nextAfterExecutionId);
  if (
    nextAfterExecutionId !== null &&
    (operations.length !== query.limit ||
      nextAfterExecutionId !== operations.at(-1)?.executionId)
  ) {
    throw workspaceStoreError("workspace_operation_list_page_invalid");
  }
  return { operations, nextAfterExecutionId };
}
