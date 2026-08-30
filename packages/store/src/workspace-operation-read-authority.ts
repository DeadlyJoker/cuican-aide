import {
  RunStoreError,
  validateWorkspaceOperationEvent,
  validateWorkspaceOperationEventPage,
  validateWorkspaceOperationEventQuery,
  validateWorkspaceOperationListPage,
  validateWorkspaceOperationListQuery,
  validateWorkspaceOperationSnapshot,
  type WorkspaceOperationEvent,
  type WorkspaceOperationEventQuery,
  type WorkspaceOperationListPage,
  type WorkspaceOperationListQuery,
  type WorkspaceOperationRecord,
  type WorkspaceOperationSnapshot,
} from "@crewon/application";

import { validateWorkspaceOperationDigestAuthority } from "./workspace-operation-digest-authority.ts";
import {
  sameWorkspaceAuthority,
  validWorkspaceOperationSuccessor,
} from "./workspace-operation-store-support.ts";

export function workspaceOperationSnapshotAuthority(
  headInput: WorkspaceOperationRecord,
  headRevisionInput: WorkspaceOperationRecord,
  maximumRevision: number | null,
): WorkspaceOperationSnapshot {
  const head = validateWorkspaceOperationDigestAuthority(headInput);
  const headRevision =
    validateWorkspaceOperationDigestAuthority(headRevisionInput);
  if (
    (head.revision === 1) !== (head.status === "prepared") ||
    maximumRevision !== head.revision ||
    !sameWorkspaceAuthority(headRevision, head)
  ) {
    throw new RunStoreError("workspace_operation_stored_state_invalid");
  }
  return validateWorkspaceOperationSnapshot({
    operation: head,
    eventSequence: head.revision,
  });
}

export function workspaceOperationEventPageAuthority(
  headInput: WorkspaceOperationRecord,
  headRevisionInput: WorkspaceOperationRecord,
  maximumRevision: number | null,
  boundaryInput: WorkspaceOperationRecord | null,
  pageInputs: readonly WorkspaceOperationRecord[],
  queryInput: WorkspaceOperationEventQuery,
): readonly WorkspaceOperationEvent[] {
  const query = validateWorkspaceOperationEventQuery(queryInput);
  const snapshot = workspaceOperationSnapshotAuthority(
    headInput,
    headRevisionInput,
    maximumRevision,
  );
  const head = snapshot.operation;
  if (query.afterSequence > head.revision) {
    throw new RunStoreError("workspace_operation_event_cursor_invalid");
  }
  const boundary =
    boundaryInput === null
      ? null
      : validateWorkspaceOperationDigestAuthority(boundaryInput);
  if (
    (query.afterSequence === 0) !== (boundary === null) ||
    (boundary !== null && boundary.revision !== query.afterSequence)
  ) {
    throw new RunStoreError("workspace_operation_event_cursor_invalid");
  }
  if (boundary !== null) {
    validateScope(boundary, head);
    validateRevisionPosition(boundary);
  }

  let previous = boundary;
  const events = pageInputs.map((input, index) => {
    const operation = validateWorkspaceOperationDigestAuthority(input);
    validateScope(operation, head);
    validateRevisionPosition(operation);
    if (
      operation.revision !== query.afterSequence + index + 1 ||
      (previous !== null &&
        !validWorkspaceOperationSuccessor(previous, operation))
    ) {
      throw new RunStoreError("workspace_operation_stored_state_invalid");
    }
    previous = operation;
    return validateWorkspaceOperationEvent({
      sequence: operation.revision,
      operation,
    });
  });
  const expectedLength = Math.min(
    query.limit,
    head.revision - query.afterSequence,
  );
  if (
    events.length !== expectedLength ||
    (events.at(-1)?.sequence === head.revision &&
      !sameWorkspaceAuthority(events.at(-1)?.operation, head))
  ) {
    throw new RunStoreError("workspace_operation_stored_state_invalid");
  }
  return validateWorkspaceOperationEventPage(events, query);
}

export function workspaceOperationListPageAuthority(
  candidateInputs: readonly WorkspaceOperationRecord[],
  queryInput: WorkspaceOperationListQuery,
): WorkspaceOperationListPage {
  const query = validateWorkspaceOperationListQuery(queryInput);
  if (candidateInputs.length > query.limit + 1) {
    throw new RunStoreError("workspace_operation_stored_state_invalid");
  }
  const candidates = candidateInputs.map(
    validateWorkspaceOperationDigestAuthority,
  );
  let previousExecutionId = query.afterExecutionId;
  for (const operation of candidates) {
    if (
      operation.tenantId !== query.tenantId ||
      operation.spaceId !== query.spaceId ||
      operation.threadId !== query.threadId ||
      (previousExecutionId !== null &&
        compareRawUtf8(previousExecutionId, operation.executionId) >= 0)
    ) {
      throw new RunStoreError("workspace_operation_stored_state_invalid");
    }
    previousExecutionId = operation.executionId;
  }
  const hasMore = candidates.length > query.limit;
  const operations = candidates.slice(0, query.limit);
  return validateWorkspaceOperationListPage(
    {
      operations,
      nextAfterExecutionId: hasMore
        ? (operations.at(-1)?.executionId ?? null)
        : null,
    },
    query,
  );
}

function validateRevisionPosition(operation: WorkspaceOperationRecord): void {
  if ((operation.revision === 1) !== (operation.status === "prepared")) {
    throw new RunStoreError("workspace_operation_stored_state_invalid");
  }
}

function validateScope(
  operation: WorkspaceOperationRecord,
  head: WorkspaceOperationRecord,
): void {
  if (
    operation.tenantId !== head.tenantId ||
    operation.spaceId !== head.spaceId ||
    operation.threadId !== head.threadId ||
    operation.executionId !== head.executionId
  ) {
    throw new RunStoreError("workspace_operation_stored_state_invalid");
  }
}

function compareRawUtf8(left: string, right: string): number {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.min(leftBytes.byteLength, rightBytes.byteLength);
  for (let index = 0; index < length; index += 1) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference;
  }
  return leftBytes.byteLength - rightBytes.byteLength;
}
