import {
  RunStoreError,
  validateWorkspaceOperationRecord,
  type WorkspaceOperationRecord,
} from "@crewon/application";
import type { PoolClient } from "pg";
import {
  decodeOperation,
  selectOperation,
  type PostgresWorkspaceRevisionRow,
} from "./postgres-workspace-operation-codec.ts";
import { validateWorkspaceOperationDigestAuthority } from "./workspace-operation-digest-authority.ts";
import {
  sameWorkspaceAuthority,
  validWorkspaceOperationSuccessor,
  workspaceOperationResultDigest,
} from "./workspace-operation-store-support.ts";

export async function requireRevision(
  client: PoolClient,
  schemaSql: string,
  authority: WorkspaceOperationRecord,
  revision: number,
): Promise<WorkspaceOperationRecord> {
  const selected = await client.query<PostgresWorkspaceRevisionRow>(
    `SELECT tenant_id, execution_id, revision, result_digest, operation_json
     FROM ${schemaSql}.workspace_operation_revisions
     WHERE tenant_id = $1 AND execution_id = $2 AND revision = $3`,
    [authority.tenantId, authority.executionId, revision],
  );
  const row = selected.rows[0];
  if (row === undefined) {
    throw new RunStoreError("workspace_operation_stored_state_invalid");
  }
  return decodeWorkspaceOperationRevision(row, authority);
}

export async function selectMaximumRevision(
  client: Pick<PoolClient, "query">,
  schemaSql: string,
  authority: WorkspaceOperationRecord,
): Promise<number | null> {
  const selected = await client.query<{ maximum: string | number | null }>(
    `SELECT MAX(revision) AS maximum
     FROM ${schemaSql}.workspace_operation_revisions
     WHERE tenant_id = $1 AND execution_id = $2`,
    [authority.tenantId, authority.executionId],
  );
  const maximum = selected.rows[0]?.maximum ?? null;
  return maximum === null ? null : safeInteger(maximum);
}

export async function selectRevisionPage(
  client: Pick<PoolClient, "query">,
  schemaSql: string,
  authority: WorkspaceOperationRecord,
  afterSequence: number,
  limit: number,
): Promise<WorkspaceOperationRecord[]> {
  const selected = await client.query<PostgresWorkspaceRevisionRow>(
    `SELECT tenant_id, execution_id, revision, result_digest, operation_json
     FROM ${schemaSql}.workspace_operation_revisions
     WHERE tenant_id = $1 AND execution_id = $2 AND revision > $3
     ORDER BY revision LIMIT $4`,
    [authority.tenantId, authority.executionId, afterSequence, limit],
  );
  return selected.rows.map((row) =>
    decodeWorkspaceOperationRevision(row, authority),
  );
}

export function decodeWorkspaceOperationRevision(
  row: PostgresWorkspaceRevisionRow,
  authority: WorkspaceOperationRecord,
): WorkspaceOperationRecord {
  const operation = validateWorkspaceOperationDigestAuthority(
    validateWorkspaceOperationRecord(row.operation_json),
  );
  if (
    row.tenant_id !== authority.tenantId ||
    row.execution_id !== authority.executionId ||
    safeInteger(row.revision) !== operation.revision ||
    row.result_digest !== workspaceOperationResultDigest(operation)
  ) {
    throw new RunStoreError("workspace_operation_stored_state_invalid");
  }
  return operation;
}

export async function requireRevisionChain(
  client: PoolClient,
  schemaSql: string,
  frozen: WorkspaceOperationRecord,
  authority: WorkspaceOperationRecord,
): Promise<void> {
  const headRow = await selectOperation(
    client,
    schemaSql,
    authority.tenantId,
    authority.executionId,
    "",
  );
  if (headRow === undefined) {
    throw new RunStoreError("workspace_operation_stored_state_invalid");
  }
  const head = decodeOperation(headRow);
  let after = head.baseRevision - 1;
  let previous: WorkspaceOperationRecord | null = null;
  let count = 0;
  for (;;) {
    const page = await client.query<PostgresWorkspaceRevisionRow>(
      `SELECT tenant_id, execution_id, revision, result_digest, operation_json
       FROM ${schemaSql}.workspace_operation_revisions
       WHERE tenant_id = $1 AND execution_id = $2
         AND revision > $3 AND revision <= $4
       ORDER BY revision LIMIT 100`,
      [authority.tenantId, authority.executionId, after, authority.revision],
    );
    if (page.rows.length === 0) break;
    for (const row of page.rows) {
      const current = await requireRevision(
        client,
        schemaSql,
        authority,
        safeInteger(row.revision),
      );
      if (
        current.revision !== head.baseRevision + count ||
        (previous !== null &&
          !validWorkspaceOperationSuccessor(previous, current))
      ) {
        throw new RunStoreError("workspace_operation_stored_state_invalid");
      }
      previous = current;
      count += 1;
      after = current.revision;
    }
    if (page.rows.length < 100) break;
  }
  if (
    count !== authority.revision - head.baseRevision + 1 ||
    !sameWorkspaceAuthority(previous, authority) ||
    !sameWorkspaceAuthority(
      await requireRevision(client, schemaSql, authority, frozen.revision),
      frozen,
    )
  ) {
    throw new RunStoreError("workspace_operation_stored_state_invalid");
  }
}

export function safeInteger(value: unknown): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || Number(parsed) < 1) {
    throw new RunStoreError("workspace_operation_stored_state_invalid");
  }
  return Number(parsed);
}

export function nullableSafeInteger(value: unknown): number | null {
  return value === null ? null : safeInteger(value);
}
