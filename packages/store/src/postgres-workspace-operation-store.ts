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
  workspaceOperationResultDigest,
  workspacePreparation,
  workspaceReceiptQuery,
  workspaceSettlementResult,
} from "./workspace-operation-store-support.ts";

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

import {
  databaseNow,
  insertReceipt,
  lockReceipt,
  normalizeWorkspaceError,
  replay,
  write,
} from "./postgres-workspace-operation-store-delivery.ts";

export async function loadPostgresWorkspaceOperationReceipt(
  pool: Pool,
  schemaSql: string,
  schemaName: string,
  query: WorkspaceOperationReceiptQuery,
): Promise<WorkspaceOperationPreparationResult | null> {
  validateWorkspaceOperationReceiptQuery(query);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockReceipt(client, schemaName, query);
    await client.query("COMMIT");
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const replayed = await replay(client, schemaSql, query);
    await client.query("COMMIT");
    return replayed;
  } catch (error) {
    await rollbackPostgres(client);
    throw normalizeWorkspaceError(error);
  } finally {
    client.release();
  }
}

export async function preparePostgresWorkspaceOperation(
  pool: Pool,
  schemaSql: string,
  schemaName: string,
  input: PrepareWorkspaceOperationInput,
): Promise<WorkspaceOperationPreparationResult> {
  validatePrepareWorkspaceOperationInput(input);
  const query = workspaceReceiptQuery(input, "execute");
  return write(pool, async (client) => {
    await lockReceipt(client, schemaName, query);
    const prior = await replay(client, schemaSql, query);
    if (prior !== null) return prior;
    const thread = await client.query<{
      tenant_id: string;
      space_id: string;
      revision: string | number;
      status: string;
    }>(
      `SELECT tenant_id, space_id, revision, status
       FROM ${schemaSql}.threads
       WHERE tenant_id = $1 AND thread_id = $2
       FOR UPDATE`,
      [input.tenantId, input.threadFence.threadId],
    );
    const threadAuthority = thread.rows[0];
    if (
      threadAuthority === undefined ||
      threadAuthority.space_id !== input.spaceId ||
      threadAuthority.status === "deleted"
    ) {
      throw new RunStoreError("workspace_operation_thread_not_found");
    }
    if (
      safeInteger(threadAuthority.revision) !==
      input.threadFence.expectedRevision
    ) {
      throw new RunStoreError("workspace_operation_thread_revision_conflict");
    }
    const operation = validateWorkspaceOperationDigestAuthority(
      input.operation,
    );
    if (operation.revision !== 1) {
      throw new RunStoreError("workspace_operation_initial_revision_invalid");
    }
    const now = await databaseNow(client);
    const attempt = pendingWorkspaceDeliveryAttempt(
      operation,
      "execute",
      1,
      now,
    );
    try {
      await insertOperation(client, schemaSql, operation);
      await insertRevision(client, schemaSql, operation);
      await insertAttempt(client, schemaSql, attempt);
      await insertReceipt(client, schemaSql, query, operation, attempt);
    } catch (error) {
      if (error instanceof RunStoreError) throw error;
      throw new RunStoreError("workspace_operation_identity_conflict", {
        cause: error,
      });
    }
    return workspacePreparation("committed", operation, attempt);
  });
}

export async function preparePostgresWorkspaceOperationAction(
  pool: Pool,
  schemaSql: string,
  schemaName: string,
  input: PrepareWorkspaceOperationActionInput,
): Promise<WorkspaceOperationPreparationResult> {
  validatePrepareWorkspaceOperationActionInput(input);
  const query = workspaceReceiptQuery(input, input.phase);
  return write(pool, async (client) => {
    await lockReceipt(client, schemaName, query);
    const prior = await replay(client, schemaSql, query);
    if (prior !== null) return prior;
    const authority = await requireOperation(
      client,
      schemaSql,
      input,
      "FOR UPDATE",
    );
    if (authority.revision !== input.expectedOperationRevision) {
      throw new RunStoreError("workspace_operation_revision_conflict");
    }
    if (isFinalWorkspaceOperation(authority.status)) {
      await insertReceipt(client, schemaSql, query, authority, null);
      return workspacePreparation("committed", authority, null);
    }
    const attempts = await selectAttempts(
      client,
      schemaSql,
      authority,
      "FOR UPDATE",
    );
    const now = await databaseNow(client);
    for (const attempt of attempts) {
      if (
        attempt.status === "settled" ||
        (input.phase === "cancel" && attempt.phase !== "cancel")
      ) {
        continue;
      }
      if (
        attempt.status === "leased" &&
        attempt.lease !== null &&
        Date.parse(attempt.lease.expiresAt) > now
      ) {
        throw new RunStoreError("workspace_delivery_lease_active");
      }
    }
    for (const attempt of attempts) {
      if (
        attempt.status === "settled" ||
        (input.phase === "cancel" && attempt.phase !== "cancel")
      ) {
        continue;
      }
      const retired =
        attempt.status === "leased"
          ? settledWorkspaceDeliveryAttempt(
              attempt,
              "leaseExpired",
              authority,
              now,
            )
          : settledWorkspaceDeliveryAttempt(
              attempt,
              "superseded",
              authority,
              now,
            );
      await updateAttempt(client, schemaSql, attempt, retired);
    }
    const nextNumber = (attempts.at(-1)?.attemptNumber ?? 0) + 1;
    const attempt = pendingWorkspaceDeliveryAttempt(
      authority,
      input.phase,
      nextNumber,
      now,
    );
    await insertAttempt(client, schemaSql, attempt);
    await insertReceipt(client, schemaSql, query, authority, attempt);
    return workspacePreparation("committed", authority, attempt);
  });
}

export * from "./postgres-workspace-operation-store-read.ts";
export {
  claimPostgresWorkspaceOperationDelivery,
  listPostgresWorkspaceOperationDeliveryAttempts,
  abandonPostgresWorkspaceOperationDelivery,
  settlePostgresWorkspaceOperationDelivery,
} from "./postgres-workspace-operation-store-delivery.ts";
