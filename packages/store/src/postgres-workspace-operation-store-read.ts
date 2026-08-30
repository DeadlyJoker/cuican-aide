import { randomUUID } from "node:crypto";

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
import type { Pool, PoolClient } from "pg";

import {
  normalizePostgresError,
  rollbackPostgres,
} from "./postgres-store-support.ts";
import { validateWorkspaceOperationDigestAuthority } from "./workspace-operation-digest-authority.ts";
import {
  workspaceOperationEventPageAuthority,
  workspaceOperationListPageAuthority,
  workspaceOperationSnapshotAuthority,
} from "./workspace-operation-read-authority.ts";
import {
  attemptSelect,
  decodeAttempt,
  decodeOperation,
  decodeWorkspaceOperationRevision,
  insertAttempt,
  insertOperation,
  insertRevision,
  loadOperationInClient,
  nullableSafeInteger,
  requireAttempt,
  requireOperation,
  requireRevision,
  requireRevisionChain,
  safeInteger,
  selectMaximumRevision,
  selectAttempt,
  selectAttempts,
  selectOperation,
  selectRevisionPage,
  updateAttempt,
  type PostgresWorkspaceAttemptRow,
  type PostgresWorkspaceOperationRow,
  type PostgresWorkspaceRevisionRow,
} from "./postgres-workspace-operation-codec.ts";
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
  normalizeWorkspaceError,
  read,
  readHead,
  requireLocator,
} from "./postgres-workspace-operation-store-transaction.ts";

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
  attempt_number: string | number | null;
  attempt_identity: string | null;
  seed_result_revision: string | number;
  seed_result_digest: string;
}>;

type PostgresWorkspaceOperationListRow = PostgresWorkspaceOperationRow &
  Readonly<{
    revision_tenant_id: string | null;
    revision_execution_id: string | null;
    revision_revision: string | number | null;
    revision_result_digest: string | null;
    revision_operation_json: unknown;
    maximum_revision: string | number | null;
  }>;

export async function loadPostgresWorkspaceOperation(
  pool: Pool,
  schemaSql: string,
  input: {
    tenantId: string;
    spaceId: string;
    threadId: string;
    executionId: string;
  },
): Promise<WorkspaceOperationRecord | null> {
  requireLocator(input);
  try {
    const row = await selectOperation(
      pool,
      schemaSql,
      input.tenantId,
      input.executionId,
      "",
    );
    if (
      row === undefined ||
      row.space_id !== input.spaceId ||
      row.thread_id !== input.threadId
    ) {
      return null;
    }
    return decodeOperation(row).operation;
  } catch (error) {
    throw normalizeWorkspaceError(error);
  }
}

export async function loadPostgresWorkspaceOperationSnapshot(
  pool: Pool,
  schemaSql: string,
  locatorInput: WorkspaceOperationLocator,
): Promise<WorkspaceOperationSnapshot | null> {
  const locator = validateWorkspaceOperationLocator(locatorInput);
  return read(pool, async (client) => {
    const head = await readHead(client, schemaSql, locator);
    if (head === null) return null;
    return workspaceOperationSnapshotAuthority(
      head,
      await requireRevision(client, schemaSql, head, head.revision),
      await selectMaximumRevision(client, schemaSql, head),
    );
  });
}

export async function listPostgresWorkspaceOperationEvents(
  pool: Pool,
  schemaSql: string,
  queryInput: WorkspaceOperationEventQuery,
): Promise<readonly WorkspaceOperationEvent[]> {
  const query = validateWorkspaceOperationEventQuery(queryInput);
  return read(pool, async (client) => {
    const head = await readHead(client, schemaSql, query);
    if (head === null) return [];
    const headRevision = await requireRevision(
      client,
      schemaSql,
      head,
      head.revision,
    );
    return workspaceOperationEventPageAuthority(
      head,
      headRevision,
      await selectMaximumRevision(client, schemaSql, head),
      query.afterSequence === 0 || query.afterSequence > head.revision
        ? null
        : query.afterSequence === head.revision
          ? headRevision
          : await requireRevision(client, schemaSql, head, query.afterSequence),
      query.afterSequence >= head.revision
        ? []
        : await selectRevisionPage(
            client,
            schemaSql,
            head,
            query.afterSequence,
            query.limit,
          ),
      query,
    );
  });
}

export async function listPostgresWorkspaceOperations(
  pool: Pool,
  schemaSql: string,
  queryInput: WorkspaceOperationListQuery,
): Promise<WorkspaceOperationListPage> {
  const query = validateWorkspaceOperationListQuery(queryInput);
  return read(pool, async (client) => {
    const selected = await client.query<PostgresWorkspaceOperationListRow>(
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
                 FROM ${schemaSql}.workspace_operation_revisions AS candidate
                WHERE candidate.tenant_id = operation.tenant_id
                  AND candidate.execution_id = operation.execution_id
              ) AS maximum_revision
         FROM ${schemaSql}.workspace_operations AS operation
         LEFT JOIN ${schemaSql}.workspace_operation_revisions AS revision
           ON revision.tenant_id = operation.tenant_id
          AND revision.execution_id = operation.execution_id
          AND revision.revision = operation.revision
        WHERE operation.tenant_id = $1
          AND operation.space_id = $2
          AND operation.thread_id = $3
          AND ($4::text IS NULL OR
               operation.execution_id COLLATE "C" > $4::text COLLATE "C")
        ORDER BY operation.execution_id COLLATE "C"
        LIMIT $5`,
      [
        query.tenantId,
        query.spaceId,
        query.threadId,
        query.afterExecutionId,
        query.limit + 1,
      ],
    );
    const candidates = selected.rows.map((row) => {
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
      const revision: PostgresWorkspaceRevisionRow = {
        tenant_id: row.revision_tenant_id,
        execution_id: row.revision_execution_id,
        revision: row.revision_revision,
        result_digest: row.revision_result_digest,
        operation_json: row.revision_operation_json,
      };
      return workspaceOperationSnapshotAuthority(
        operation,
        decodeWorkspaceOperationRevision(revision, operation),
        row.maximum_revision === null
          ? null
          : safeInteger(row.maximum_revision),
      ).operation;
    });
    return workspaceOperationListPageAuthority(candidates, query);
  });
}
