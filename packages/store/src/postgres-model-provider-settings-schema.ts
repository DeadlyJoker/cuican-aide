import { RunStoreError } from "@crewon/application";
import type { PoolClient } from "pg";

export const POSTGRES_MODEL_PROVIDER_SETTINGS_SCHEMA_VERSION = 1;

export async function migratePostgresModelProviderSettingsSchema(
  client: PoolClient,
  schema: string,
  schemaName: string,
): Promise<void> {
  const current = await client.query<{ version: number }>(
    `SELECT version FROM ${schema}.schema_migrations
     WHERE component = 'model_provider_settings_authority'`,
  );
  const version = current.rows[0]?.version;
  if (version !== undefined && version !== 1) {
    throw new RunStoreError(
      version > POSTGRES_MODEL_PROVIDER_SETTINGS_SCHEMA_VERSION
        ? "postgres_schema_too_new"
        : "postgres_schema_version_unsupported",
    );
  }
  if (version === undefined) {
    await client.query(postgresModelProviderSettingsSchemaSql(schema));
  }
  await assertPostgresModelProviderSettingsSchema(client, schemaName);
}

export function postgresModelProviderSettingsSchemaSql(schema: string): string {
  return `
    INSERT INTO ${schema}.schema_migrations(component, version)
      VALUES ('model_provider_settings_authority', ${POSTGRES_MODEL_PROVIDER_SETTINGS_SCHEMA_VERSION})
      ON CONFLICT (component) DO NOTHING;

    CREATE TABLE IF NOT EXISTS ${schema}.model_provider_settings (
      tenant_id text PRIMARY KEY,
      revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
      active_provider_id text,
      catalog_json jsonb NOT NULL CHECK (jsonb_typeof(catalog_json) = 'object'),
      updated_at timestamptz NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ${schema}.model_provider_settings_operations (
      tenant_id text NOT NULL,
      operation_id text NOT NULL,
      coordinator_binding text NOT NULL,
      base_revision bigint NOT NULL CHECK (base_revision BETWEEN 0 AND 9007199254740991),
      operation_json jsonb NOT NULL CHECK (jsonb_typeof(operation_json) = 'object'),
      status text NOT NULL CHECK (status IN ('pending', 'finalized', 'aborted', 'expired')),
      prepared_at timestamptz NOT NULL,
      expires_at timestamptz NOT NULL,
      terminal_binding text,
      completed_at timestamptz,
      result_json jsonb CHECK (result_json IS NULL OR jsonb_typeof(result_json) = 'object'),
      PRIMARY KEY (tenant_id, operation_id),
      CHECK (
        (status = 'pending' AND terminal_binding IS NULL
          AND completed_at IS NULL AND result_json IS NULL)
        OR
        (status IN ('finalized', 'aborted', 'expired')
          AND terminal_binding IS NOT NULL
          AND completed_at IS NOT NULL AND result_json IS NOT NULL)
      )
    );

    CREATE TABLE IF NOT EXISTS ${schema}.model_provider_settings_receipts (
      tenant_id text NOT NULL,
      phase text NOT NULL CHECK (phase IN ('prepare', 'finalize', 'abort', 'expire')),
      idempotency_key text NOT NULL,
      fingerprint text NOT NULL,
      result_json jsonb NOT NULL CHECK (jsonb_typeof(result_json) = 'object'),
      PRIMARY KEY (tenant_id, phase, idempotency_key)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS model_provider_settings_pending_tenant_idx
      ON ${schema}.model_provider_settings_operations(tenant_id)
      WHERE status = 'pending';

    CREATE INDEX IF NOT EXISTS model_provider_settings_pending_expiry_idx
      ON ${schema}.model_provider_settings_operations(expires_at, tenant_id)
      WHERE status = 'pending';

    CREATE UNIQUE INDEX IF NOT EXISTS model_provider_settings_finalized_revision_idx
      ON ${schema}.model_provider_settings_operations(tenant_id, base_revision)
      WHERE status = 'finalized';`;
}

async function assertPostgresModelProviderSettingsSchema(
  client: PoolClient,
  schemaName: string,
): Promise<void> {
  const columns = await client.query<{
    table_name: string;
    column_name: string;
    data_type: string;
    is_nullable: "YES" | "NO";
  }>(
    `SELECT table_name, column_name, data_type, is_nullable
     FROM information_schema.columns
     WHERE table_schema = $1
       AND table_name = ANY($2::text[])
     ORDER BY table_name, ordinal_position`,
    [
      schemaName,
      [
        "model_provider_settings",
        "model_provider_settings_operations",
        "model_provider_settings_receipts",
      ],
    ],
  );
  const actualColumns = columns.rows.map(
    ({ table_name, column_name, data_type, is_nullable }) =>
      [table_name, column_name, data_type, is_nullable].join(":"),
  );
  const expectedColumns = [
    "model_provider_settings:tenant_id:text:NO",
    "model_provider_settings:revision:bigint:NO",
    "model_provider_settings:active_provider_id:text:YES",
    "model_provider_settings:catalog_json:jsonb:NO",
    "model_provider_settings:updated_at:timestamp with time zone:NO",
    "model_provider_settings_operations:tenant_id:text:NO",
    "model_provider_settings_operations:operation_id:text:NO",
    "model_provider_settings_operations:coordinator_binding:text:NO",
    "model_provider_settings_operations:base_revision:bigint:NO",
    "model_provider_settings_operations:operation_json:jsonb:NO",
    "model_provider_settings_operations:status:text:NO",
    "model_provider_settings_operations:prepared_at:timestamp with time zone:NO",
    "model_provider_settings_operations:expires_at:timestamp with time zone:NO",
    "model_provider_settings_operations:terminal_binding:text:YES",
    "model_provider_settings_operations:completed_at:timestamp with time zone:YES",
    "model_provider_settings_operations:result_json:jsonb:YES",
    "model_provider_settings_receipts:tenant_id:text:NO",
    "model_provider_settings_receipts:phase:text:NO",
    "model_provider_settings_receipts:idempotency_key:text:NO",
    "model_provider_settings_receipts:fingerprint:text:NO",
    "model_provider_settings_receipts:result_json:jsonb:NO",
  ].sort();
  if (actualColumns.sort().join("\0") !== expectedColumns.sort().join("\0")) {
    throw new RunStoreError("postgres_schema_version_unsupported");
  }

  const constraints = await client.query<{ definition: string }>(
    `SELECT pg_get_constraintdef(constraints.oid) AS definition
     FROM pg_constraint AS constraints
     JOIN pg_class AS relations ON relations.oid = constraints.conrelid
     JOIN pg_namespace AS namespaces ON namespaces.oid = relations.relnamespace
     WHERE namespaces.nspname = $1
       AND relations.relname = ANY($2::text[])
       AND constraints.contype IN ('p', 'u', 'c')`,
    [
      schemaName,
      [
        "model_provider_settings",
        "model_provider_settings_operations",
        "model_provider_settings_receipts",
      ],
    ],
  );
  const definitions = constraints.rows.map(({ definition }) => definition);
  for (const required of [
    "PRIMARY KEY (tenant_id)",
    "PRIMARY KEY (tenant_id, phase, idempotency_key)",
    "PRIMARY KEY (tenant_id, operation_id)",
  ]) {
    if (!definitions.includes(required)) {
      throw new RunStoreError("postgres_schema_version_unsupported");
    }
  }
  if (
    !definitions.some(
      (definition) =>
        definition.startsWith("CHECK") &&
        definition.includes("phase") &&
        definition.includes("'prepare'::text") &&
        definition.includes("'finalize'::text") &&
        definition.includes("'abort'::text") &&
        definition.includes("'expire'::text"),
    )
  ) {
    throw new RunStoreError("postgres_schema_version_unsupported");
  }
  if (
    !definitions.some(
      (definition) =>
        definition.startsWith("CHECK") &&
        definition.includes("status") &&
        definition.includes("'pending'::text") &&
        definition.includes("'finalized'::text") &&
        definition.includes("'aborted'::text") &&
        definition.includes("'expired'::text"),
    )
  ) {
    throw new RunStoreError("postgres_schema_version_unsupported");
  }
  if (
    !definitions.some(
      (definition) =>
        definition.startsWith("CHECK") &&
        definition.includes("completed_at") &&
        definition.includes("terminal_binding") &&
        definition.includes("result_json") &&
        definition.includes("'pending'::text") &&
        definition.includes("'finalized'::text") &&
        definition.includes("'aborted'::text") &&
        definition.includes("'expired'::text"),
    )
  ) {
    throw new RunStoreError("postgres_schema_version_unsupported");
  }

  const indexes = await client.query<{ indexname: string; indexdef: string }>(
    `SELECT indexname, indexdef FROM pg_indexes
     WHERE schemaname=$1 AND tablename='model_provider_settings_operations'
       AND indexname = ANY($2::text[])`,
    [
      schemaName,
      [
        "model_provider_settings_pending_tenant_idx",
        "model_provider_settings_finalized_revision_idx",
      ],
    ],
  );
  const pendingIndex =
    indexes.rows.find(
      ({ indexname }) =>
        indexname === "model_provider_settings_pending_tenant_idx",
    )?.indexdef ?? "";
  if (
    !pendingIndex.includes("CREATE UNIQUE INDEX") ||
    !pendingIndex.includes("(tenant_id)") ||
    !pendingIndex.includes("WHERE (status = 'pending'::text)")
  ) {
    throw new RunStoreError("postgres_schema_version_unsupported");
  }
  const finalizedIndex =
    indexes.rows.find(
      ({ indexname }) =>
        indexname === "model_provider_settings_finalized_revision_idx",
    )?.indexdef ?? "";
  if (
    !finalizedIndex.includes("CREATE UNIQUE INDEX") ||
    !finalizedIndex.includes("(tenant_id, base_revision)") ||
    !finalizedIndex.includes("WHERE (status = 'finalized'::text)")
  ) {
    throw new RunStoreError("postgres_schema_version_unsupported");
  }
}
