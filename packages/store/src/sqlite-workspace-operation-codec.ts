import type { DatabaseSync } from "node:sqlite";

import {
  RunStoreError,
  validateWorkspaceDeliveryAttempt,
  validateWorkspaceOperationRecord,
  type WorkspaceDeliveryAttempt,
  type WorkspaceOperationRecord,
} from "@crewon/application";
import { validateWorkspaceOperationDigestAuthority } from "./workspace-operation-digest-authority.ts";
import {
  sameWorkspaceAuthority,
  validWorkspaceOperationSuccessor,
  validateWorkspaceAttemptScope,
  validateWorkspaceAttemptTransition,
  workspaceOperationResultDigest,
} from "./workspace-operation-store-support.ts";
import { parseJson } from "./sqlite-workspace-operation-revision-codec.ts";

export type SqliteWorkspaceOperationRow = Readonly<{
  tenant_id: string;
  space_id: string;
  thread_id: string;
  execution_id: string;
  base_revision: number;
  revision: number;
  status: string;
  action_digest: string;
  command_digest: string;
  operation_json: string;
}>;

export type SqliteWorkspaceRevisionRow = Readonly<{
  tenant_id: string;
  execution_id: string;
  revision: number;
  result_digest: string;
  operation_json: string;
}>;

export type SqliteWorkspaceAttemptRow = Readonly<{
  tenant_id: string;
  space_id: string;
  thread_id: string;
  execution_id: string;
  attempt_number: number;
  operation_revision: number;
  phase: string;
  status: string;
  action_digest: string;
  command_digest: string;
  created_at: string;
  lease_owner_id: string | null;
  lease_id: string | null;
  lease_epoch: number | null;
  leased_at: string | null;
  expires_at: string | null;
  settlement_kind: string | null;
  resolution_status: string | null;
  settled_at: string | null;
  result_revision: number | null;
  result_digest: string | null;
  attempt_json: string;
}>;

type SqlValue = string | number | bigint | Uint8Array | null;

export function insertOperation(
  database: DatabaseSync,
  operation: WorkspaceOperationRecord,
): void {
  database
    .prepare(
      `INSERT INTO workspace_operations (
         tenant_id, space_id, thread_id, execution_id, base_revision, revision,
         status, action_digest, command_digest, operation_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
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
    );
}

export function insertRevision(
  database: DatabaseSync,
  operation: WorkspaceOperationRecord,
): void {
  database
    .prepare(
      `INSERT INTO workspace_operation_revisions (
         tenant_id, execution_id, revision, result_digest, operation_json
       ) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      operation.tenantId,
      operation.executionId,
      operation.revision,
      workspaceOperationResultDigest(operation),
      JSON.stringify(operation),
    );
}

export function insertAttempt(
  database: DatabaseSync,
  attempt: WorkspaceDeliveryAttempt,
): void {
  const values = attemptValues(attempt);
  database
    .prepare(
      `INSERT INTO workspace_delivery_attempts (
         tenant_id, space_id, thread_id, execution_id, attempt_number,
         operation_revision, phase, status, action_digest, command_digest,
         created_at, lease_owner_id, lease_id, lease_epoch, leased_at, expires_at,
         settlement_kind, resolution_status, settled_at, result_revision,
         result_digest, attempt_json
       ) VALUES (${Array.from({ length: values.length }, () => "?").join(", ")})`,
    )
    .run(...values);
}

export function updateAttempt(
  database: DatabaseSync,
  previous: WorkspaceDeliveryAttempt,
  next: WorkspaceDeliveryAttempt,
): void {
  validateWorkspaceAttemptTransition(previous, next);
  const values = attemptValues(next);
  const update = database
    .prepare(
      `UPDATE workspace_delivery_attempts SET
         space_id = ?, thread_id = ?, operation_revision = ?, phase = ?,
         status = ?, action_digest = ?, command_digest = ?, created_at = ?,
         lease_owner_id = ?, lease_id = ?, lease_epoch = ?, leased_at = ?,
         expires_at = ?, settlement_kind = ?, resolution_status = ?,
         settled_at = ?, result_revision = ?, result_digest = ?, attempt_json = ?
       WHERE tenant_id = ? AND execution_id = ? AND attempt_number = ?
         AND status = ? AND attempt_json = ?`,
    )
    .run(
      ...values.slice(1, 3),
      ...values.slice(5, 22),
      previous.tenantId,
      previous.executionId,
      previous.attemptNumber,
      previous.status,
      JSON.stringify(previous),
    );
  if (update.changes !== 1) {
    throw new RunStoreError("workspace_delivery_attempt_stale");
  }
}

export function attemptValues(
  attemptInput: WorkspaceDeliveryAttempt,
): SqlValue[] {
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

export function selectOperation(
  database: DatabaseSync,
  tenantId: string,
  executionId: string,
): SqliteWorkspaceOperationRow | undefined {
  return database
    .prepare(
      `SELECT tenant_id, space_id, thread_id, execution_id, base_revision,
              revision, status, action_digest, command_digest, operation_json
       FROM workspace_operations
       WHERE tenant_id = ? AND execution_id = ?`,
    )
    .get(tenantId, executionId) as SqliteWorkspaceOperationRow | undefined;
}

export function requireOperation(
  database: DatabaseSync,
  input: {
    tenantId: string;
    spaceId: string;
    threadId: string;
    executionId: string;
  },
): WorkspaceOperationRecord {
  const row = selectOperation(database, input.tenantId, input.executionId);
  if (
    row === undefined ||
    row.space_id !== input.spaceId ||
    row.thread_id !== input.threadId
  ) {
    throw new RunStoreError("workspace_operation_not_found");
  }
  return decodeOperation(row).operation;
}

export function decodeOperation(row: SqliteWorkspaceOperationRow): {
  operation: WorkspaceOperationRecord;
  baseRevision: number;
} {
  const operation = validateWorkspaceOperationDigestAuthority(
    validateWorkspaceOperationRecord(parseJson(row.operation_json)),
  );
  if (
    operation.tenantId !== row.tenant_id ||
    operation.spaceId !== row.space_id ||
    operation.threadId !== row.thread_id ||
    operation.executionId !== row.execution_id ||
    operation.revision !== row.revision ||
    operation.status !== row.status ||
    operation.command.actionDigest !== row.action_digest ||
    operation.command.commandDigest !== row.command_digest ||
    !Number.isSafeInteger(row.base_revision) ||
    row.base_revision < 1 ||
    row.base_revision > row.revision
  ) {
    throw new RunStoreError("workspace_operation_stored_state_invalid");
  }
  return { operation, baseRevision: row.base_revision };
}

export function selectAttempt(
  database: DatabaseSync,
  tenantId: string,
  executionId: string,
  attemptNumber: number,
): WorkspaceDeliveryAttempt | null {
  const row = database
    .prepare(
      `${attemptSelect()}
       WHERE tenant_id = ? AND execution_id = ? AND attempt_number = ?`,
    )
    .get(tenantId, executionId, attemptNumber) as
    | SqliteWorkspaceAttemptRow
    | undefined;
  return row === undefined ? null : decodeAttempt(row);
}

export function requireAttempt(
  database: DatabaseSync,
  input: { tenantId: string; executionId: string; attemptNumber: number },
): WorkspaceDeliveryAttempt {
  const attempt = selectAttempt(
    database,
    input.tenantId,
    input.executionId,
    input.attemptNumber,
  );
  if (attempt === null) {
    throw new RunStoreError("workspace_delivery_attempt_stale");
  }
  return attempt;
}

export function selectAttempts(
  database: DatabaseSync,
  operation: WorkspaceOperationRecord,
): WorkspaceDeliveryAttempt[] {
  return (
    database
      .prepare(
        `${attemptSelect()}
         WHERE tenant_id = ? AND execution_id = ?
         ORDER BY attempt_number`,
      )
      .all(
        operation.tenantId,
        operation.executionId,
      ) as SqliteWorkspaceAttemptRow[]
  ).map((row) => {
    const attempt = decodeAttempt(row);
    validateWorkspaceAttemptScope(attempt, operation);
    return attempt;
  });
}

export function decodeAttempt(
  row: SqliteWorkspaceAttemptRow,
): WorkspaceDeliveryAttempt {
  const attempt = validateWorkspaceDeliveryAttempt(parseJson(row.attempt_json));
  const expected = attemptValues(attempt);
  const actual = [
    row.tenant_id,
    row.space_id,
    row.thread_id,
    row.execution_id,
    row.attempt_number,
    row.operation_revision,
    row.phase,
    row.status,
    row.action_digest,
    row.command_digest,
    row.created_at,
    row.lease_owner_id,
    row.lease_id,
    row.lease_epoch,
    row.leased_at,
    row.expires_at,
    row.settlement_kind,
    row.resolution_status,
    row.settled_at,
    row.result_revision,
    row.result_digest,
    row.attempt_json,
  ];
  if (!sameWorkspaceAuthority(actual, expected)) {
    throw new RunStoreError("workspace_delivery_stored_state_invalid");
  }
  return attempt;
}

export function attemptSelect(): string {
  return `SELECT tenant_id, space_id, thread_id, execution_id, attempt_number,
                 operation_revision, phase, status, action_digest,
                 command_digest, created_at, lease_owner_id, lease_id,
                 lease_epoch, leased_at, expires_at, settlement_kind,
                 resolution_status, settled_at, result_revision, result_digest,
                 attempt_json
          FROM workspace_delivery_attempts`;
}

export * from "./sqlite-workspace-operation-revision-codec.ts";
