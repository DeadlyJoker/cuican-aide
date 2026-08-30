import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  RunStoreError,
  validateAbandonWorkspaceDeliveryInput,
  validateClaimWorkspaceDeliveryInput,
  validateCommitWorkspaceOperationResolutionInput,
  validatePrepareWorkspaceOperationActionInput,
  validatePrepareWorkspaceOperationInput,
  validateWorkspaceDeliveryAttempt,
  validateWorkspaceDeliveryAttemptQuery,
  validateWorkspaceListResolution,
  validateWorkspaceOperationEventQuery,
  validateWorkspaceOperationListQuery,
  validateWorkspaceOperationLocator,
  validateWorkspaceOperationReceiptQuery,
  validateWorkspaceOperationRecord,
  type AbandonWorkspaceDeliveryInput,
  type ClaimWorkspaceDeliveryInput,
  type CommitWorkspaceOperationResolutionInput,
  type PrepareWorkspaceOperationActionInput,
  type PrepareWorkspaceOperationInput,
  type WorkspaceDeliveryAttempt,
  type WorkspaceDeliveryAttemptQuery,
  type WorkspaceDeliverySettlementResult,
  type WorkspaceOperationMutationResult,
  type WorkspaceOperationEvent,
  type WorkspaceOperationEventQuery,
  type WorkspaceOperationLocator,
  type WorkspaceOperationListPage,
  type WorkspaceOperationListQuery,
  type WorkspaceOperationPreparationResult,
  type WorkspaceOperationReceiptQuery,
  type WorkspaceOperationRecord,
  type WorkspaceOperationSnapshot,
} from "@crewon/application";
import {
  workspaceOperationEventPageAuthority,
  workspaceOperationListPageAuthority,
  workspaceOperationSnapshotAuthority,
} from "./workspace-operation-read-authority.ts";
import { validateWorkspaceOperationDigestAuthority } from "./workspace-operation-digest-authority.ts";
import {
  attemptSelect,
  decodeAttempt,
  decodeOperation,
  decodeWorkspaceOperationRevision,
  insertAttempt,
  insertOperation,
  insertRevision,
  nextAttemptNumber,
  requireAttempt,
  requireOperation,
  requireRevision,
  requireRevisionChain,
  selectMaximumRevision,
  selectAttempt,
  selectAttempts,
  selectOperation,
  selectRevisionPage,
  updateAttempt,
  type SqliteWorkspaceAttemptRow,
  type SqliteWorkspaceOperationRow,
  type SqliteWorkspaceRevisionRow,
} from "./sqlite-workspace-operation-codec.ts";
import {
  WORKSPACE_DELIVERY_COMMIT_MARGIN_MS,
  isFinalWorkspaceOperation,
  pendingWorkspaceDeliveryAttempt,
  requireWorkspaceExactLease,
  sameWorkspaceAuthority,
  settledWorkspaceDeliveryAttempt,
  validateWorkspaceAttemptScope,
  validateWorkspaceAttemptTransition,
  validWorkspaceOperationSuccessor,
  workspaceAttemptMatchesResult,
  workspaceDeliveryLease,
  workspaceDeliveryAttemptIdentity,
  workspaceMutationResult,
  workspaceOperationResultDigest,
  workspacePreparation,
  workspaceReceiptQuery,
  workspaceSettlementResult,
} from "./workspace-operation-store-support.ts";
import {
  readHead,
  requireLocator,
  transaction,
} from "./sqlite-workspace-operation-store-transaction.ts";

type ReceiptRow = Readonly<{
  tenant_id: string;
  space_id: string;
  phase: string;
  scope: string;
  idempotency_key: string;
  thread_id: string;
  execution_id: string;
  action_digest: string;
  command_digest: string;
  fingerprint: string;
  attempt_number: number | null;
  attempt_identity: string | null;
  seed_result_revision: number;
  seed_result_digest: string;
}>;

type SqliteWorkspaceOperationListRow = SqliteWorkspaceOperationRow &
  Readonly<{
    revision_tenant_id: string | null;
    revision_execution_id: string | null;
    revision_revision: number | null;
    revision_result_digest: string | null;
    revision_operation_json: string | null;
    maximum_revision: number | null;
  }>;

export function loadSqliteWorkspaceOperation(
  database: DatabaseSync,
  input: {
    tenantId: string;
    spaceId: string;
    threadId: string;
    executionId: string;
  },
): WorkspaceOperationRecord | null {
  requireLocator(input);
  const row = selectOperation(database, input.tenantId, input.executionId);
  if (
    row === undefined ||
    row.space_id !== input.spaceId ||
    row.thread_id !== input.threadId
  ) {
    return null;
  }
  return decodeOperation(row).operation;
}

export function loadSqliteWorkspaceOperationSnapshot(
  database: DatabaseSync,
  locatorInput: WorkspaceOperationLocator,
): WorkspaceOperationSnapshot | null {
  const locator = validateWorkspaceOperationLocator(locatorInput);
  return transaction(database, "deferred", () => {
    const head = readHead(database, locator);
    if (head === null) return null;
    return workspaceOperationSnapshotAuthority(
      head,
      requireRevision(database, head, head.revision),
      selectMaximumRevision(database, head),
    );
  });
}

export function listSqliteWorkspaceOperationEvents(
  database: DatabaseSync,
  queryInput: WorkspaceOperationEventQuery,
): readonly WorkspaceOperationEvent[] {
  const query = validateWorkspaceOperationEventQuery(queryInput);
  return transaction(database, "deferred", () => {
    const head = readHead(database, query);
    if (head === null) return [];
    const headRevision = requireRevision(database, head, head.revision);
    return workspaceOperationEventPageAuthority(
      head,
      headRevision,
      selectMaximumRevision(database, head),
      query.afterSequence === 0 || query.afterSequence > head.revision
        ? null
        : query.afterSequence === head.revision
          ? headRevision
          : requireRevision(database, head, query.afterSequence),
      query.afterSequence >= head.revision
        ? []
        : selectRevisionPage(database, head, query.afterSequence, query.limit),
      query,
    );
  });
}

export function listSqliteWorkspaceOperations(
  database: DatabaseSync,
  queryInput: WorkspaceOperationListQuery,
): WorkspaceOperationListPage {
  const query = validateWorkspaceOperationListQuery(queryInput);
  const rows = database
    .prepare(
      `SELECT operation.tenant_id, operation.space_id, operation.thread_id,
              operation.execution_id, operation.base_revision,
              operation.revision, operation.status, operation.action_digest,
              operation.command_digest, operation.operation_json,
              revision.tenant_id AS revision_tenant_id,
              revision.execution_id AS revision_execution_id,
              revision.revision AS revision_revision,
              revision.result_digest AS revision_result_digest,
              revision.operation_json AS revision_operation_json,
              (SELECT MAX(candidate.revision)
                 FROM workspace_operation_revisions AS candidate
                WHERE candidate.tenant_id = operation.tenant_id
                  AND candidate.execution_id = operation.execution_id
              ) AS maximum_revision
         FROM workspace_operations AS operation
         LEFT JOIN workspace_operation_revisions AS revision
           ON revision.tenant_id = operation.tenant_id
          AND revision.execution_id = operation.execution_id
          AND revision.revision = operation.revision
        WHERE operation.tenant_id = ?
          AND operation.space_id = ?
          AND operation.thread_id = ?
          AND (? IS NULL OR operation.execution_id COLLATE BINARY > ? COLLATE BINARY)
        ORDER BY operation.execution_id COLLATE BINARY
        LIMIT ?`,
    )
    .all(
      query.tenantId,
      query.spaceId,
      query.threadId,
      query.afterExecutionId,
      query.afterExecutionId,
      query.limit + 1,
    ) as SqliteWorkspaceOperationListRow[];
  const candidates = rows.map((row) => {
    const operation = decodeOperation(row).operation;
    if (
      row.revision_tenant_id === null ||
      row.revision_execution_id === null ||
      row.revision_revision === null ||
      row.revision_result_digest === null ||
      row.revision_operation_json === null
    ) {
      throw new RunStoreError("workspace_operation_stored_state_invalid");
    }
    const revision: SqliteWorkspaceRevisionRow = {
      tenant_id: row.revision_tenant_id,
      execution_id: row.revision_execution_id,
      revision: row.revision_revision,
      result_digest: row.revision_result_digest,
      operation_json: row.revision_operation_json,
    };
    return workspaceOperationSnapshotAuthority(
      operation,
      decodeWorkspaceOperationRevision(revision, operation),
      row.maximum_revision,
    ).operation;
  });
  return workspaceOperationListPageAuthority(candidates, query);
}
