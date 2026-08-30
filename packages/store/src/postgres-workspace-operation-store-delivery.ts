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
  normalizeWorkspaceError,
  readHead,
  replaySettlement,
  write,
} from "./postgres-workspace-operation-store-transaction.ts";
export async function claimPostgresWorkspaceOperationDelivery(
  pool: Pool,
  schemaSql: string,
  input: ClaimWorkspaceDeliveryInput,
): Promise<WorkspaceDeliveryAttempt> {
  validateClaimWorkspaceDeliveryInput(input);
  return write(pool, async (client) => {
    const authority = await requireOperation(
      client,
      schemaSql,
      input,
      "FOR UPDATE",
    );
    if (authority.revision !== input.operationRevision) {
      throw new RunStoreError("workspace_delivery_attempt_stale");
    }
    if (
      input.leaseDurationMs <
      authority.command.limits.timeoutMs + WORKSPACE_DELIVERY_COMMIT_MARGIN_MS
    ) {
      throw new RunStoreError("workspace_delivery_lease_duration_invalid");
    }
    const attempt = await requireAttempt(
      client,
      schemaSql,
      input,
      "FOR UPDATE",
    );
    if (
      attempt.operationRevision !== input.operationRevision ||
      attempt.phase !== input.phase ||
      attempt.status === "settled"
    ) {
      throw new RunStoreError("workspace_delivery_attempt_stale");
    }
    const now = await databaseNow(client);
    if (attempt.status === "leased" && attempt.lease !== null) {
      throw new RunStoreError(
        Date.parse(attempt.lease.expiresAt) > now
          ? "workspace_delivery_lease_active"
          : "workspace_delivery_reconcile_required",
      );
    }
    const leased = validateWorkspaceDeliveryAttempt({
      ...attempt,
      status: "leased",
      lease: workspaceDeliveryLease(
        attempt,
        input.ownerId,
        `workspace-lease-${randomUUID()}`,
        now,
        input.leaseDurationMs,
      ),
    });
    await updateAttempt(client, schemaSql, attempt, leased);
    return leased;
  });
}

export async function listPostgresWorkspaceOperationDeliveryAttempts(
  pool: Pool,
  schemaSql: string,
  query: WorkspaceDeliveryAttemptQuery,
): Promise<readonly WorkspaceDeliveryAttempt[]> {
  validateWorkspaceDeliveryAttemptQuery(query);
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const operation = await loadOperationInClient(client, schemaSql, query);
    if (operation === null) {
      await client.query("COMMIT");
      return [];
    }
    const statusFilter =
      query.view === "claimable" ? "AND status = 'pending'" : "";
    const selected = await client.query<PostgresWorkspaceAttemptRow>(
      `${attemptSelect(schemaSql)}
       WHERE tenant_id = $1 AND execution_id = $2 AND attempt_number > $3
         ${statusFilter}
       ORDER BY attempt_number
       LIMIT $4`,
      [
        query.tenantId,
        query.executionId,
        query.afterAttemptNumber,
        query.limit,
      ],
    );
    const attempts = selected.rows.map(decodeAttempt);
    for (const attempt of attempts)
      validateWorkspaceAttemptScope(attempt, operation);
    if (query.view === "audit" && attempts.length > 0) {
      if (attempts[0]!.attemptNumber !== query.afterAttemptNumber + 1) {
        throw new RunStoreError("workspace_delivery_stored_state_invalid");
      }
      for (let index = 1; index < attempts.length; index += 1) {
        if (
          attempts[index]!.attemptNumber !==
          attempts[index - 1]!.attemptNumber + 1
        ) {
          throw new RunStoreError("workspace_delivery_stored_state_invalid");
        }
      }
    }
    await client.query("COMMIT");
    return attempts;
  } catch (error) {
    await rollbackPostgres(client);
    throw normalizeWorkspaceError(error);
  } finally {
    client.release();
  }
}

export async function abandonPostgresWorkspaceOperationDelivery(
  pool: Pool,
  schemaSql: string,
  input: AbandonWorkspaceDeliveryInput,
): Promise<WorkspaceDeliveryAttempt> {
  validateAbandonWorkspaceDeliveryInput(input);
  return write(pool, async (client) => {
    const authority = await requireOperation(
      client,
      schemaSql,
      input,
      "FOR UPDATE",
    );
    if (authority.revision !== input.operationRevision) {
      throw new RunStoreError("workspace_delivery_attempt_stale");
    }
    const attempt = await requireAttempt(
      client,
      schemaSql,
      { ...input, attemptNumber: input.deliveryLease.attemptNumber },
      "FOR UPDATE",
    );
    requireWorkspaceExactLease(attempt, input.deliveryLease);
    const now = await databaseNow(client);
    if (Date.parse(input.deliveryLease.expiresAt) <= now) {
      throw new RunStoreError("workspace_delivery_lease_expired");
    }
    const abandoned = settledWorkspaceDeliveryAttempt(
      attempt,
      "abandoned",
      authority,
      now,
    );
    await updateAttempt(client, schemaSql, attempt, abandoned);
    return abandoned;
  });
}

export async function settlePostgresWorkspaceOperationDelivery(
  pool: Pool,
  schemaSql: string,
  input: CommitWorkspaceOperationResolutionInput,
): Promise<WorkspaceDeliverySettlementResult> {
  validateCommitWorkspaceOperationResolutionInput(input);
  return write(pool, async (client) => {
    const authority = await requireOperation(
      client,
      schemaSql,
      input,
      "FOR UPDATE",
    );
    const resolution = validateWorkspaceListResolution(
      input.resolution,
      authority.command,
    );
    const attempt = await requireAttempt(
      client,
      schemaSql,
      { ...input, attemptNumber: input.deliveryLease.attemptNumber },
      "FOR UPDATE",
    );
    requireWorkspaceExactLease(attempt, input.deliveryLease);
    if (attempt.operationRevision !== input.expectedOperationRevision) {
      throw new RunStoreError("workspace_delivery_lease_mismatch");
    }
    if (attempt.status === "settled") {
      return replaySettlement(
        client,
        schemaSql,
        authority,
        attempt,
        resolution,
      );
    }
    const now = await databaseNow(client);
    if (authority.revision !== input.expectedOperationRevision) {
      const winner = await requireRevision(
        client,
        schemaSql,
        authority,
        attempt.operationRevision + 1,
      );
      await requireRevisionChain(client, schemaSql, winner, authority);
      const lost = settledWorkspaceDeliveryAttempt(
        attempt,
        "superseded",
        winner,
        now,
      );
      await updateAttempt(client, schemaSql, attempt, lost);
      return workspaceSettlementResult("lostRace", winner, lost);
    }
    if (attempt.status !== "leased" || attempt.lease === null) {
      throw new RunStoreError("workspace_delivery_lease_mismatch");
    }
    if (Date.parse(attempt.lease.expiresAt) <= now) {
      throw new RunStoreError("workspace_delivery_lease_expired");
    }
    const next = validateWorkspaceOperationRecord({
      ...authority,
      revision: authority.revision + 1,
      status: resolution.status,
      resolution,
    });
    await insertRevision(client, schemaSql, next);
    const updated = await client.query(
      `UPDATE ${schemaSql}.workspace_operations
       SET revision = $1, status = $2, operation_json = $3::jsonb
       WHERE tenant_id = $4 AND execution_id = $5 AND revision = $6`,
      [
        next.revision,
        next.status,
        JSON.stringify(next),
        next.tenantId,
        next.executionId,
        authority.revision,
      ],
    );
    if (updated.rowCount !== 1) {
      throw new RunStoreError("workspace_operation_revision_conflict");
    }
    const resolved = settledWorkspaceDeliveryAttempt(
      attempt,
      "resolution",
      next,
      now,
    );
    await updateAttempt(client, schemaSql, attempt, resolved);
    const others = await selectAttempts(
      client,
      schemaSql,
      authority,
      "FOR UPDATE",
    );
    for (const other of others) {
      if (
        other.attemptNumber !== attempt.attemptNumber &&
        other.status !== "settled" &&
        other.operationRevision === authority.revision
      ) {
        await updateAttempt(
          client,
          schemaSql,
          other,
          settledWorkspaceDeliveryAttempt(other, "superseded", next, now),
        );
      }
    }
    return workspaceSettlementResult("committed", next, resolved);
  });
}

export * from "./postgres-workspace-operation-store-transaction.ts";
