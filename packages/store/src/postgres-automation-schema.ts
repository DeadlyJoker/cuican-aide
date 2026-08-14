import { RunStoreError } from "@crewon/application";
import { type PoolClient } from "pg";

export const POSTGRES_AUTOMATION_SCHEMA_VERSION = 3;

export async function migratePostgresAutomationSchema(
  client: PoolClient,
  schema: string,
  schemaName: string,
): Promise<void> {
  const current = await client.query<{ version: number }>(
    `SELECT version FROM ${schema}.schema_migrations
     WHERE component = 'automation_authority'`,
  );
  const version = current.rows[0]?.version;
  if (version !== undefined && version !== POSTGRES_AUTOMATION_SCHEMA_VERSION) {
    throw new RunStoreError(
      version > POSTGRES_AUTOMATION_SCHEMA_VERSION
        ? "postgres_schema_too_new"
        : "postgres_schema_version_unsupported",
    );
  }
  if (version === undefined) {
    await client.query(postgresAutomationSchemaSql(schema));
  }
  await assertPostgresAutomationSchema(client, schema, schemaName);
}

export function postgresAutomationSchemaSql(schema: string): string {
  return `
    INSERT INTO ${schema}.schema_migrations(component, version)
      VALUES ('automation_authority', ${POSTGRES_AUTOMATION_SCHEMA_VERSION})
      ON CONFLICT (component) DO NOTHING;

    CREATE TABLE IF NOT EXISTS ${schema}.automations (
      automation_id text PRIMARY KEY,
      tenant_id text NOT NULL,
      space_id text NOT NULL,
      thread_id text NOT NULL,
      revision bigint NOT NULL CHECK (revision = 1),
      definition_digest text NOT NULL,
      definition_json jsonb NOT NULL CHECK (jsonb_typeof(definition_json) = 'object'),
      schedule_state_json jsonb NOT NULL CHECK (jsonb_typeof(schedule_state_json) = 'object'),
      updated_at timestamptz NOT NULL,
      UNIQUE (tenant_id, automation_id),
      FOREIGN KEY (tenant_id, thread_id)
        REFERENCES ${schema}.threads(tenant_id, thread_id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS ${schema}.automation_create_receipts (
      tenant_id text NOT NULL,
      scope text NOT NULL,
      idempotency_key text NOT NULL,
      automation_id text NOT NULL,
      fingerprint text NOT NULL,
      result_json jsonb NOT NULL CHECK (jsonb_typeof(result_json) = 'object'),
      PRIMARY KEY (tenant_id, scope, idempotency_key),
      FOREIGN KEY (tenant_id, automation_id)
        REFERENCES ${schema}.automations(tenant_id, automation_id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS ${schema}.automation_invocation_receipts (
      tenant_id text NOT NULL,
      scope text NOT NULL,
      idempotency_key text NOT NULL,
      automation_id text NOT NULL,
      run_id text NOT NULL,
      fingerprint text NOT NULL,
      result_json jsonb NOT NULL CHECK (jsonb_typeof(result_json) = 'object'),
      PRIMARY KEY (tenant_id, scope, idempotency_key),
      FOREIGN KEY (tenant_id, automation_id)
        REFERENCES ${schema}.automations(tenant_id, automation_id) ON DELETE RESTRICT,
      FOREIGN KEY (tenant_id, run_id)
        REFERENCES ${schema}.run_snapshots(tenant_id, run_id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS ${schema}.automation_schedule_claims (
      tenant_id text NOT NULL,
      automation_id text NOT NULL,
      schedule_revision bigint NOT NULL CHECK (schedule_revision = 1),
      scheduled_for timestamptz NOT NULL,
      occurrence_digest text NOT NULL,
      observed_at timestamptz NOT NULL,
      lease_owner_id text NOT NULL,
      lease_id text NOT NULL,
      lease_epoch bigint NOT NULL CHECK (lease_epoch >= 1),
      lease_expires_at timestamptz NOT NULL,
      PRIMARY KEY (tenant_id, automation_id),
      UNIQUE (tenant_id, lease_id),
      CONSTRAINT automation_schedule_claims_automation_fk
        FOREIGN KEY (tenant_id, automation_id)
        REFERENCES ${schema}.automations(tenant_id, automation_id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS ${schema}.automation_scheduled_invocation_receipts (
      tenant_id text NOT NULL,
      automation_id text NOT NULL,
      schedule_revision bigint NOT NULL CHECK (schedule_revision = 1),
      scheduled_for timestamptz NOT NULL,
      occurrence_digest text NOT NULL,
      invocation_scope text NOT NULL,
      invocation_key text NOT NULL,
      run_id text NOT NULL,
      PRIMARY KEY (tenant_id, automation_id, schedule_revision, scheduled_for),
      CONSTRAINT automation_scheduled_receipts_occurrence_key
        UNIQUE (tenant_id, occurrence_digest),
      CONSTRAINT automation_scheduled_receipts_automation_fk
        FOREIGN KEY (tenant_id, automation_id)
        REFERENCES ${schema}.automations(tenant_id, automation_id) ON DELETE RESTRICT,
      CONSTRAINT automation_scheduled_receipts_invocation_fk
        FOREIGN KEY (tenant_id, invocation_scope, invocation_key)
        REFERENCES ${schema}.automation_invocation_receipts(tenant_id, scope, idempotency_key)
        ON DELETE RESTRICT,
      CONSTRAINT automation_scheduled_receipts_run_fk
        FOREIGN KEY (tenant_id, run_id)
        REFERENCES ${schema}.run_snapshots(tenant_id, run_id) ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS automations_tenant_space_updated_idx
      ON ${schema}.automations(tenant_id, space_id, updated_at DESC, automation_id DESC);
    CREATE INDEX IF NOT EXISTS automations_tenant_thread_idx
      ON ${schema}.automations(tenant_id, thread_id, automation_id);
    CREATE INDEX IF NOT EXISTS automation_invocation_receipts_run_idx
      ON ${schema}.automation_invocation_receipts(tenant_id, run_id);
    CREATE INDEX IF NOT EXISTS automation_schedule_claims_due_idx
      ON ${schema}.automation_schedule_claims(lease_expires_at, automation_id);
    CREATE INDEX IF NOT EXISTS automation_scheduled_receipts_run_idx
      ON ${schema}.automation_scheduled_invocation_receipts(tenant_id, run_id);
  `;
}

async function assertPostgresAutomationSchema(
  client: PoolClient,
  schema: string,
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
     WHERE table_schema=$1 AND table_name=ANY($2::text[])
     ORDER BY table_name, ordinal_position`,
    [
      schemaName,
      [
        "automations",
        "automation_create_receipts",
        "automation_invocation_receipts",
        "automation_schedule_claims",
        "automation_scheduled_invocation_receipts",
      ],
    ],
  );
  const actual = columns.rows.map(
    ({ table_name, column_name, data_type, is_nullable }) =>
      [table_name, column_name, data_type, is_nullable].join(":"),
  );
  const expected = [
    "automations:automation_id:text:NO",
    "automations:tenant_id:text:NO",
    "automations:space_id:text:NO",
    "automations:thread_id:text:NO",
    "automations:revision:bigint:NO",
    "automations:definition_digest:text:NO",
    "automations:definition_json:jsonb:NO",
    "automations:schedule_state_json:jsonb:NO",
    "automations:updated_at:timestamp with time zone:NO",
    "automation_create_receipts:tenant_id:text:NO",
    "automation_create_receipts:scope:text:NO",
    "automation_create_receipts:idempotency_key:text:NO",
    "automation_create_receipts:automation_id:text:NO",
    "automation_create_receipts:fingerprint:text:NO",
    "automation_create_receipts:result_json:jsonb:NO",
    "automation_invocation_receipts:tenant_id:text:NO",
    "automation_invocation_receipts:scope:text:NO",
    "automation_invocation_receipts:idempotency_key:text:NO",
    "automation_invocation_receipts:automation_id:text:NO",
    "automation_invocation_receipts:run_id:text:NO",
    "automation_invocation_receipts:fingerprint:text:NO",
    "automation_invocation_receipts:result_json:jsonb:NO",
    "automation_schedule_claims:tenant_id:text:NO",
    "automation_schedule_claims:automation_id:text:NO",
    "automation_schedule_claims:schedule_revision:bigint:NO",
    "automation_schedule_claims:scheduled_for:timestamp with time zone:NO",
    "automation_schedule_claims:occurrence_digest:text:NO",
    "automation_schedule_claims:observed_at:timestamp with time zone:NO",
    "automation_schedule_claims:lease_owner_id:text:NO",
    "automation_schedule_claims:lease_id:text:NO",
    "automation_schedule_claims:lease_epoch:bigint:NO",
    "automation_schedule_claims:lease_expires_at:timestamp with time zone:NO",
    "automation_scheduled_invocation_receipts:tenant_id:text:NO",
    "automation_scheduled_invocation_receipts:automation_id:text:NO",
    "automation_scheduled_invocation_receipts:schedule_revision:bigint:NO",
    "automation_scheduled_invocation_receipts:scheduled_for:timestamp with time zone:NO",
    "automation_scheduled_invocation_receipts:occurrence_digest:text:NO",
    "automation_scheduled_invocation_receipts:invocation_scope:text:NO",
    "automation_scheduled_invocation_receipts:invocation_key:text:NO",
    "automation_scheduled_invocation_receipts:run_id:text:NO",
  ].sort();
  if (actual.sort().join("\0") !== expected.join("\0")) {
    throw new RunStoreError("postgres_schema_version_unsupported");
  }

  const constraints = await client.query<{
    table_name: string;
    constraint_name: string;
    constraint_type: string;
  }>(
    `SELECT table_name, constraint_name, constraint_type
     FROM information_schema.table_constraints
     WHERE table_schema=$1 AND table_name=ANY($2::text[])
     ORDER BY table_name, constraint_name`,
    [
      schemaName,
      [
        "automations",
        "automation_create_receipts",
        "automation_invocation_receipts",
        "automation_schedule_claims",
        "automation_scheduled_invocation_receipts",
      ],
    ],
  );
  const actualConstraints = new Set(
    constraints.rows.map(
      ({ table_name, constraint_name, constraint_type }) =>
        `${table_name}:${constraint_name}:${constraint_type}`,
    ),
  );
  const requiredConstraints = [
    "automations:automations_pkey:PRIMARY KEY",
    "automations:automations_tenant_id_automation_id_key:UNIQUE",
    "automations:automations_tenant_id_thread_id_fkey:FOREIGN KEY",
    "automation_create_receipts:automation_create_receipts_pkey:PRIMARY KEY",
    "automation_create_receipts:automation_create_receipts_tenant_id_automation_id_fkey:FOREIGN KEY",
    "automation_invocation_receipts:automation_invocation_receipts_pkey:PRIMARY KEY",
    "automation_invocation_receipts:automation_invocation_receipts_tenant_id_automation_id_fkey:FOREIGN KEY",
    "automation_invocation_receipts:automation_invocation_receipts_tenant_id_run_id_fkey:FOREIGN KEY",
    "automation_schedule_claims:automation_schedule_claims_pkey:PRIMARY KEY",
    "automation_schedule_claims:automation_schedule_claims_tenant_id_lease_id_key:UNIQUE",
    "automation_schedule_claims:automation_schedule_claims_automation_fk:FOREIGN KEY",
    "automation_scheduled_invocation_receipts:automation_scheduled_invocation_receipts_pkey:PRIMARY KEY",
    "automation_scheduled_invocation_receipts:automation_scheduled_receipts_occurrence_key:UNIQUE",
    "automation_scheduled_invocation_receipts:automation_scheduled_receipts_automation_fk:FOREIGN KEY",
    "automation_scheduled_invocation_receipts:automation_scheduled_receipts_invocation_fk:FOREIGN KEY",
    "automation_scheduled_invocation_receipts:automation_scheduled_receipts_run_fk:FOREIGN KEY",
  ];
  if (requiredConstraints.some((value) => !actualConstraints.has(value))) {
    throw new RunStoreError("postgres_schema_version_unsupported");
  }

  const indexes = await client.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes
     WHERE schemaname=$1 AND indexname=ANY($2::text[])`,
    [
      schemaName,
      [
        "automations_tenant_space_updated_idx",
        "automations_tenant_thread_idx",
        "automation_invocation_receipts_run_idx",
        "automation_schedule_claims_due_idx",
        "automation_scheduled_receipts_run_idx",
      ],
    ],
  );
  if (indexes.rowCount !== 5) {
    throw new RunStoreError("postgres_schema_version_unsupported");
  }

  const migration = await client.query<{ version: number }>(
    `SELECT version FROM ${schema}.schema_migrations
     WHERE component='automation_authority'`,
  );
  if (migration.rows[0]?.version !== POSTGRES_AUTOMATION_SCHEMA_VERSION) {
    throw new RunStoreError("postgres_schema_version_unsupported");
  }
}
