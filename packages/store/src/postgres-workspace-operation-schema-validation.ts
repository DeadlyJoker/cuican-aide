import { RunStoreError } from "@crewon/application";
import type { PoolClient } from "pg";

export async function assertSchema(
  client: PoolClient,
  schemaName: string,
): Promise<void> {
  const tables = await client.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = $1
       AND table_name IN (
         'workspace_operations', 'workspace_operation_revisions',
         'workspace_delivery_attempts', 'workspace_operation_receipts'
       )
     ORDER BY table_name`,
    [schemaName],
  );
  if (tables.rows.length !== 4) {
    throw new RunStoreError("postgres_schema_version_unsupported");
  }
  const requiredColumns = new Map<string, readonly string[]>([
    [
      "workspace_operations",
      [
        "tenant_id",
        "space_id",
        "thread_id",
        "execution_id",
        "base_revision",
        "revision",
        "status",
        "action_digest",
        "command_digest",
        "operation_json",
      ],
    ],
    [
      "workspace_operation_revisions",
      [
        "tenant_id",
        "execution_id",
        "revision",
        "result_digest",
        "operation_json",
      ],
    ],
    [
      "workspace_operation_receipts",
      [
        "tenant_id",
        "space_id",
        "phase",
        "scope",
        "idempotency_key",
        "thread_id",
        "execution_id",
        "action_digest",
        "command_digest",
        "fingerprint",
        "attempt_number",
        "attempt_identity",
        "seed_result_revision",
        "seed_result_digest",
      ],
    ],
    [
      "workspace_delivery_attempts",
      [
        "tenant_id",
        "space_id",
        "thread_id",
        "execution_id",
        "attempt_number",
        "operation_revision",
        "phase",
        "status",
        "action_digest",
        "command_digest",
        "created_at",
        "lease_owner_id",
        "lease_id",
        "lease_epoch",
        "leased_at",
        "expires_at",
        "settlement_kind",
        "resolution_status",
        "settled_at",
        "result_revision",
        "result_digest",
        "attempt_json",
      ],
    ],
  ]);
  for (const [table, expected] of requiredColumns) {
    const columns = await client.query<{
      column_name: string;
      is_nullable: "YES" | "NO";
    }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2
       ORDER BY ordinal_position`,
      [schemaName, table],
    );
    if (
      JSON.stringify(
        columns.rows.map(({ column_name }) => column_name).sort(),
      ) !== JSON.stringify([...expected].sort())
    ) {
      throw new RunStoreError("postgres_schema_version_unsupported");
    }
  }
  const constraints = await client.query<{
    constraint_name: string;
    constraint_type: string;
    definition: string;
  }>(
    `SELECT authority.conname AS constraint_name,
            authority.contype AS constraint_type,
            pg_get_constraintdef(authority.oid, true) AS definition
     FROM pg_constraint AS authority
     JOIN pg_class AS relation ON relation.oid = authority.conrelid
     JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = $1
       AND relation.relname IN (
         'workspace_operations', 'workspace_operation_revisions',
         'workspace_delivery_attempts', 'workspace_operation_receipts'
       )`,
    [schemaName],
  );
  const byName = new Map(
    constraints.rows.map((row) => [row.constraint_name, row] as const),
  );
  for (const [name, type, fragment] of [
    ["workspace_operations_pkey", "p", "PRIMARY KEY (tenant_id, execution_id)"],
    [
      "workspace_operation_revisions_pkey",
      "p",
      "PRIMARY KEY (tenant_id, execution_id, revision)",
    ],
    [
      "workspace_operation_revisions_result_key",
      "u",
      "UNIQUE (tenant_id, execution_id, revision, result_digest)",
    ],
    [
      "workspace_operation_revisions_operation_fkey",
      "f",
      "FOREIGN KEY (tenant_id, execution_id)",
    ],
    [
      "workspace_delivery_attempts_pkey",
      "p",
      "PRIMARY KEY (tenant_id, execution_id, attempt_number)",
    ],
    [
      "workspace_delivery_attempts_operation_revision_fkey",
      "f",
      "FOREIGN KEY (tenant_id, execution_id, operation_revision)",
    ],
    [
      "workspace_delivery_attempts_result_fkey",
      "f",
      "FOREIGN KEY (tenant_id, execution_id, result_revision, result_digest)",
    ],
    ["workspace_delivery_attempts_state_check", "c", "CHECK ("],
    ["workspace_delivery_attempts_resolution_check", "c", "CHECK ("],
    [
      "workspace_operation_receipts_pkey",
      "p",
      "PRIMARY KEY (tenant_id, space_id, phase, scope, idempotency_key)",
    ],
    [
      "workspace_operation_receipts_operation_fkey",
      "f",
      "FOREIGN KEY (tenant_id, execution_id)",
    ],
    [
      "workspace_operation_receipts_attempt_fkey",
      "f",
      "FOREIGN KEY (tenant_id, execution_id, attempt_number)",
    ],
    [
      "workspace_operation_receipts_result_fkey",
      "f",
      "FOREIGN KEY (tenant_id, execution_id, seed_result_revision, seed_result_digest)",
    ],
  ] as const) {
    const constraint = byName.get(name);
    if (
      constraint === undefined ||
      constraint.constraint_type !== type ||
      !constraint.definition.includes(fragment)
    ) {
      throw new RunStoreError("postgres_schema_version_unsupported");
    }
  }
  const claimIndex = await client.query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes
     WHERE schemaname = $1 AND tablename = 'workspace_delivery_attempts'
       AND indexname = 'workspace_delivery_attempts_claim_idx'`,
    [schemaName],
  );
  if (
    claimIndex.rows.length !== 1 ||
    !claimIndex.rows[0]!.indexdef.includes(
      "(tenant_id, space_id, status, execution_id, attempt_number)",
    )
  ) {
    throw new RunStoreError("postgres_schema_version_unsupported");
  }
}

export function safeInteger(value: string | number): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new RunStoreError("postgres_schema_version_unsupported");
  }
  return parsed;
}
