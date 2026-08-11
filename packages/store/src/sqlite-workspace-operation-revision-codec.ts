import type { DatabaseSync } from "node:sqlite";
import {
  RunStoreError,
  validateWorkspaceOperationRecord,
  type WorkspaceOperationRecord,
} from "@crewon/application";
import {
  decodeOperation,
  selectOperation,
  type SqliteWorkspaceRevisionRow,
} from "./sqlite-workspace-operation-codec.ts";
import { validateWorkspaceOperationDigestAuthority } from "./workspace-operation-digest-authority.ts";
import {
  sameWorkspaceAuthority,
  validWorkspaceOperationSuccessor,
  workspaceOperationResultDigest,
} from "./workspace-operation-store-support.ts";

export function requireRevision(
  database: DatabaseSync,
  authority: WorkspaceOperationRecord,
  revision: number,
): WorkspaceOperationRecord {
  const row = database
    .prepare(
      `SELECT tenant_id, execution_id, revision, result_digest, operation_json
       FROM workspace_operation_revisions
       WHERE tenant_id = ? AND execution_id = ? AND revision = ?`,
    )
    .get(authority.tenantId, authority.executionId, revision) as
    | SqliteWorkspaceRevisionRow
    | undefined;
  if (row === undefined) {
    throw new RunStoreError("workspace_operation_stored_state_invalid");
  }
  return decodeWorkspaceOperationRevision(row, authority);
}

export function selectMaximumRevision(
  database: DatabaseSync,
  authority: WorkspaceOperationRecord,
): number | null {
  const row = database
    .prepare(
      `SELECT MAX(revision) AS maximum
       FROM workspace_operation_revisions
       WHERE tenant_id = ? AND execution_id = ?`,
    )
    .get(authority.tenantId, authority.executionId) as {
    maximum: number | null;
  };
  if (
    row.maximum !== null &&
    (!Number.isSafeInteger(row.maximum) || row.maximum < 1)
  ) {
    throw new RunStoreError("workspace_operation_stored_state_invalid");
  }
  return row.maximum;
}

export function selectRevisionPage(
  database: DatabaseSync,
  authority: WorkspaceOperationRecord,
  afterSequence: number,
  limit: number,
): WorkspaceOperationRecord[] {
  const rows = database
    .prepare(
      `SELECT tenant_id, execution_id, revision, result_digest, operation_json
       FROM workspace_operation_revisions
       WHERE tenant_id = ? AND execution_id = ? AND revision > ?
       ORDER BY revision LIMIT ?`,
    )
    .all(
      authority.tenantId,
      authority.executionId,
      afterSequence,
      limit,
    ) as SqliteWorkspaceRevisionRow[];
  return rows.map((row) => decodeWorkspaceOperationRevision(row, authority));
}

export function decodeWorkspaceOperationRevision(
  row: SqliteWorkspaceRevisionRow,
  authority: WorkspaceOperationRecord,
): WorkspaceOperationRecord {
  const operation = validateWorkspaceOperationDigestAuthority(
    validateWorkspaceOperationRecord(parseJson(row.operation_json)),
  );
  if (
    row.tenant_id !== authority.tenantId ||
    row.execution_id !== authority.executionId ||
    row.revision !== operation.revision ||
    row.result_digest !== workspaceOperationResultDigest(operation)
  ) {
    throw new RunStoreError("workspace_operation_stored_state_invalid");
  }
  return operation;
}

export function requireRevisionChain(
  database: DatabaseSync,
  frozen: WorkspaceOperationRecord,
  authority: WorkspaceOperationRecord,
): void {
  const head = decodeOperation(
    selectOperation(database, authority.tenantId, authority.executionId)!,
  );
  let previous: WorkspaceOperationRecord | null = null;
  let count = 0;
  for (const raw of database
    .prepare(
      `SELECT tenant_id, execution_id, revision, result_digest, operation_json
       FROM workspace_operation_revisions
       WHERE tenant_id = ? AND execution_id = ?
       ORDER BY revision`,
    )
    .iterate(
      authority.tenantId,
      authority.executionId,
    ) as Iterable<SqliteWorkspaceRevisionRow>) {
    const current = requireRevision(database, authority, raw.revision);
    if (
      current.revision !== head.baseRevision + count ||
      (previous !== null &&
        !validWorkspaceOperationSuccessor(previous, current))
    ) {
      throw new RunStoreError("workspace_operation_stored_state_invalid");
    }
    previous = current;
    count += 1;
  }
  if (
    count !== authority.revision - head.baseRevision + 1 ||
    !sameWorkspaceAuthority(previous, authority) ||
    !sameWorkspaceAuthority(
      requireRevision(database, authority, frozen.revision),
      frozen,
    )
  ) {
    throw new RunStoreError("workspace_operation_stored_state_invalid");
  }
}

export function nextAttemptNumber(
  database: DatabaseSync,
  operation: WorkspaceOperationRecord,
): number {
  const row = database
    .prepare(
      `SELECT COALESCE(MAX(attempt_number), 0) + 1 AS next
       FROM workspace_delivery_attempts
       WHERE tenant_id = ? AND execution_id = ?`,
    )
    .get(operation.tenantId, operation.executionId) as { next: number };
  if (!Number.isSafeInteger(row.next) || row.next < 1) {
    throw new RunStoreError("workspace_delivery_stored_state_invalid");
  }
  return row.next;
}

export function parseJson(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch (error) {
    throw new RunStoreError("workspace_operation_stored_state_invalid", {
      cause: error,
    });
  }
}
