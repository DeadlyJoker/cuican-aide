import {
  RunStoreError,
  validateWorkspaceDeliveryAttempt,
  validateWorkspaceOperationRecord,
  type WorkspaceDeliveryAttempt,
  type WorkspaceOperationRecord,
} from "@crewon/application";
import type { Pool, PoolClient } from "pg";

import { validateWorkspaceOperationDigestAuthority } from "./workspace-operation-digest-authority.ts";
import {
  sameWorkspaceAuthority,
  validWorkspaceOperationSuccessor,
  validateWorkspaceAttemptScope,
  validateWorkspaceAttemptTransition,
  workspaceOperationResultDigest,
} from "./workspace-operation-store-support.ts";
import {
  nullableSafeInteger,
  safeInteger,
} from "./postgres-workspace-operation-revision-codec.ts";

export type PostgresWorkspaceOperationRow = Readonly<{
  tenant_id: string;
  space_id: string;
  thread_id: string;
  execution_id: string;
  base_revision: string | number;
  revision: string | number;
  status: string;
  action_digest: string;
  command_digest: string;
  operation_json: unknown;
}>;

export type PostgresWorkspaceRevisionRow = Readonly<{
  tenant_id: string;
  execution_id: string;
  revision: string | number;
  result_digest: string;
  operation_json: unknown;
}>;

export type PostgresWorkspaceAttemptRow = Readonly<{
  tenant_id: string;
  space_id: string;
  thread_id: string;
  execution_id: string;
  attempt_number: string | number;
  operation_revision: string | number;
  phase: string;
  status: string;
  action_digest: string;
  command_digest: string;
  created_at: string;
  lease_owner_id: string | null;
  lease_id: string | null;
  lease_epoch: string | number | null;
  leased_at: string | null;
  expires_at: string | null;
  settlement_kind: string | null;
  resolution_status: string | null;
  settled_at: string | null;
  result_revision: string | number | null;
  result_digest: string | null;
  attempt_json: unknown;
}>;

export async function insertOperation(
  client: PoolClient,
  schemaSql: string,
  operation: WorkspaceOperationRecord,
): Promise<void> {
  await client.query(
    `INSERT INTO ${schemaSql}.workspace_operations (
       tenant_id, space_id, thread_id, execution_id, base_revision, revision,
       status, action_digest, command_digest, operation_json
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
    [
      operation.tenantId,
      operation.spaceId,
      operation.threadId,
      operation.executionId,
      operation.revision,
      operation.revision,
      operation.status,
      operation.command.actionDigest,
      operation.command.commandDigest,
      JSON.stringify(operation),
    ],
  );
}

export async function insertRevision(
  client: PoolClient,
  schemaSql: string,
  operation: WorkspaceOperationRecord,
): Promise<void> {
  await client.query(
    `INSERT INTO ${schemaSql}.workspace_operation_revisions (
       tenant_id, execution_id, revision, result_digest, operation_json
     ) VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [
      operation.tenantId,
      operation.executionId,
      operation.revision,
      workspaceOperationResultDigest(operation),
      JSON.stringify(operation),
    ],
  );
}

export async function insertAttempt(
  client: PoolClient,
  schemaSql: string,
  attempt: WorkspaceDeliveryAttempt,
): Promise<void> {
  const values = attemptValues(attempt);
  await client.query(
    `INSERT INTO ${schemaSql}.workspace_delivery_attempts (
       tenant_id, space_id, thread_id, execution_id, attempt_number,
       operation_revision, phase, status, action_digest, command_digest,
       created_at, lease_owner_id, lease_id, lease_epoch, leased_at, expires_at,
       settlement_kind, resolution_status, settled_at, result_revision,
       result_digest, attempt_json
     ) VALUES (${values.map((_, index) => `$${index + 1}`).join(", ")})`,
    values,
  );
}

export async function updateAttempt(
  client: PoolClient,
  schemaSql: string,
  previous: WorkspaceDeliveryAttempt,
  next: WorkspaceDeliveryAttempt,
): Promise<void> {
  validateWorkspaceAttemptTransition(previous, next);
  const values = attemptValues(next);
  const updated = await client.query(
    `UPDATE ${schemaSql}.workspace_delivery_attempts SET
       space_id = $1, thread_id = $2, operation_revision = $3, phase = $4,
       status = $5, action_digest = $6, command_digest = $7, created_at = $8,
       lease_owner_id = $9, lease_id = $10, lease_epoch = $11,
       leased_at = $12, expires_at = $13, settlement_kind = $14,
       resolution_status = $15, settled_at = $16, result_revision = $17,
       result_digest = $18, attempt_json = $19::jsonb
     WHERE tenant_id = $20 AND execution_id = $21 AND attempt_number = $22
       AND status = $23 AND attempt_json = $24::jsonb`,
    [
      ...values.slice(1, 3),
      ...values.slice(5, 22),
      previous.tenantId,
      previous.executionId,
      previous.attemptNumber,
      previous.status,
      JSON.stringify(previous),
    ],
  );
  if (updated.rowCount !== 1) {
    throw new RunStoreError("workspace_delivery_attempt_stale");
  }
}

export function attemptValues(
  attemptInput: WorkspaceDeliveryAttempt,
): unknown[] {
  const attempt = validateWorkspaceDeliveryAttempt(attemptInput);
  return [
    attempt.tenantId,
    attempt.spaceId,
    attempt.threadId,
    attempt.executionId,
    attempt.attemptNumber,
    attempt.operationRevision,
    attempt.phase,
    attempt.status,
    attempt.actionDigest,
    attempt.commandDigest,
    attempt.createdAt,
    attempt.lease?.ownerId ?? null,
    attempt.lease?.leaseId ?? null,
    attempt.lease?.epoch ?? null,
    attempt.lease?.leasedAt ?? null,
    attempt.lease?.expiresAt ?? null,
    attempt.settlement?.kind ?? null,
    attempt.settlement?.resolutionStatus ?? null,
    attempt.settlement?.settledAt ?? null,
    attempt.settlement?.resultRevision ?? null,
    attempt.settlement?.resultDigest ?? null,
    JSON.stringify(attempt),
  ];
}

export async function selectOperation(
  client: Pick<PoolClient, "query"> | Pool,
  schemaSql: string,
  tenantId: string,
  executionId: string,
  lock: "" | "FOR SHARE" | "FOR UPDATE",
): Promise<PostgresWorkspaceOperationRow | undefined> {
  const selected = await client.query<PostgresWorkspaceOperationRow>(
    `SELECT tenant_id, space_id, thread_id, execution_id, base_revision,
            revision, status, action_digest, command_digest, operation_json
     FROM ${schemaSql}.workspace_operations
     WHERE tenant_id = $1 AND execution_id = $2 ${lock}`,
    [tenantId, executionId],
  );
  return selected.rows[0];
}

export async function requireOperation(
  client: PoolClient,
  schemaSql: string,
  input: {
    tenantId: string;
    spaceId: string;
    threadId: string;
    executionId: string;
  },
  lock: "FOR UPDATE" | "FOR SHARE",
): Promise<WorkspaceOperationRecord> {
  const row = await selectOperation(
    client,
    schemaSql,
    input.tenantId,
    input.executionId,
    lock,
  );
  if (
    row === undefined ||
    row.space_id !== input.spaceId ||
    row.thread_id !== input.threadId
  ) {
    throw new RunStoreError("workspace_operation_not_found");
  }
  return decodeOperation(row).operation;
}

export async function loadOperationInClient(
  client: PoolClient,
  schemaSql: string,
  input: {
    tenantId: string;
    spaceId: string;
    threadId: string;
    executionId: string;
  },
): Promise<WorkspaceOperationRecord | null> {
  const row = await selectOperation(
    client,
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
}

export function decodeOperation(row: PostgresWorkspaceOperationRow): {
  operation: WorkspaceOperationRecord;
  baseRevision: number;
} {
  const operation = validateWorkspaceOperationDigestAuthority(
    validateWorkspaceOperationRecord(row.operation_json),
  );
  const baseRevision = safeInteger(row.base_revision);
  if (
    operation.tenantId !== row.tenant_id ||
    operation.spaceId !== row.space_id ||
    operation.threadId !== row.thread_id ||
    operation.executionId !== row.execution_id ||
    operation.revision !== safeInteger(row.revision) ||
    operation.status !== row.status ||
    operation.command.actionDigest !== row.action_digest ||
    operation.command.commandDigest !== row.command_digest ||
    baseRevision > operation.revision
  ) {
    throw new RunStoreError("workspace_operation_stored_state_invalid");
  }
  return { operation, baseRevision };
}

export async function selectAttempt(
  client: PoolClient,
  schemaSql: string,
  tenantId: string,
  executionId: string,
  attemptNumber: number,
  lock: "" | "FOR SHARE" | "FOR UPDATE",
): Promise<WorkspaceDeliveryAttempt | null> {
  const selected = await client.query<PostgresWorkspaceAttemptRow>(
    `${attemptSelect(schemaSql)}
     WHERE tenant_id = $1 AND execution_id = $2 AND attempt_number = $3 ${lock}`,
    [tenantId, executionId, attemptNumber],
  );
  return selected.rows[0] === undefined
    ? null
    : decodeAttempt(selected.rows[0]);
}

export async function requireAttempt(
  client: PoolClient,
  schemaSql: string,
  input: { tenantId: string; executionId: string; attemptNumber: number },
  lock: "FOR UPDATE" | "FOR SHARE",
): Promise<WorkspaceDeliveryAttempt> {
  const attempt = await selectAttempt(
    client,
    schemaSql,
    input.tenantId,
    input.executionId,
    input.attemptNumber,
    lock,
  );
  if (attempt === null) {
    throw new RunStoreError("workspace_delivery_attempt_stale");
  }
  return attempt;
}

export async function selectAttempts(
  client: PoolClient,
  schemaSql: string,
  operation: WorkspaceOperationRecord,
  lock: "" | "FOR UPDATE",
): Promise<WorkspaceDeliveryAttempt[]> {
  const selected = await client.query<PostgresWorkspaceAttemptRow>(
    `${attemptSelect(schemaSql)}
     WHERE tenant_id = $1 AND execution_id = $2
     ORDER BY attempt_number ${lock}`,
    [operation.tenantId, operation.executionId],
  );
  return selected.rows.map((row) => {
    const attempt = decodeAttempt(row);
    validateWorkspaceAttemptScope(attempt, operation);
    return attempt;
  });
}

export function decodeAttempt(
  row: PostgresWorkspaceAttemptRow,
): WorkspaceDeliveryAttempt {
  const attempt = validateWorkspaceDeliveryAttempt(row.attempt_json);
  const expected = attemptValues(attempt);
  const actual = [
    row.tenant_id,
    row.space_id,
    row.thread_id,
    row.execution_id,
    safeInteger(row.attempt_number),
    safeInteger(row.operation_revision),
    row.phase,
    row.status,
    row.action_digest,
    row.command_digest,
    row.created_at,
    row.lease_owner_id,
    row.lease_id,
    nullableSafeInteger(row.lease_epoch),
    row.leased_at,
    row.expires_at,
    row.settlement_kind,
    row.resolution_status,
    row.settled_at,
    nullableSafeInteger(row.result_revision),
    row.result_digest,
    JSON.stringify(attempt),
  ];
  if (!sameWorkspaceAuthority(actual, expected)) {
    throw new RunStoreError("workspace_delivery_stored_state_invalid");
  }
  return attempt;
}

export function attemptSelect(schemaSql: string): string {
  const timestamp = (column: string) =>
    `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ${column}`;
  return `SELECT tenant_id, space_id, thread_id, execution_id, attempt_number,
                 operation_revision, phase, status, action_digest,
                 command_digest, ${timestamp("created_at")}, lease_owner_id,
                 lease_id, lease_epoch, ${timestamp("leased_at")},
                 ${timestamp("expires_at")}, settlement_kind, resolution_status,
                 ${timestamp("settled_at")}, result_revision, result_digest,
                 attempt_json
          FROM ${schemaSql}.workspace_delivery_attempts`;
}

export * from "./postgres-workspace-operation-revision-codec.ts";
