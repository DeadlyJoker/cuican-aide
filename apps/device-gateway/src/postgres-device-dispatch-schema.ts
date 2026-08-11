import type { Pool, PoolClient } from "pg";

import { DeviceGatewayError } from "./device-gateway-error.ts";

const SCHEMA_VERSION = 4;

export async function migratePostgresDeviceDispatchSchema(
  pool: Pool,
  schema: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`${schema}:device-dispatch-schema`],
    );
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${schema}.device_dispatch_schema (
        component TEXT PRIMARY KEY,
        version INTEGER NOT NULL CHECK (version > 0)
      )
    `);
    const migration = await client.query<{ version: number }>(
      `SELECT version
         FROM ${schema}.device_dispatch_schema
        WHERE component = 'dispatch-authority'`,
    );
    const version = migration.rows[0]?.version;
    if (version !== undefined && version > SCHEMA_VERSION) {
      throw new DeviceGatewayError("device_dispatch_schema_newer");
    }
    if (version === SCHEMA_VERSION) {
      await assertPostgresDeviceDispatchSchema(client, schema);
      await client.query("COMMIT");
      return;
    }
    if (version === undefined) {
      await createCurrentSchema(client, schema);
    } else if (version === 3) {
      await migrateVersionThree(client, schema);
    } else {
      await migrateLegacySchema(client, schema);
    }
    await client.query(
      `INSERT INTO ${schema}.device_dispatch_schema (component, version)
       VALUES ('dispatch-authority', $1)
       ON CONFLICT (component) DO UPDATE SET version = EXCLUDED.version`,
      [SCHEMA_VERSION],
    );
    await assertPostgresDeviceDispatchSchema(client, schema);
    await client.query("COMMIT");
  } catch (error) {
    await rollback(client);
    throw error;
  } finally {
    client.release();
  }
}

async function createCurrentSchema(
  client: PoolClient,
  schema: string,
): Promise<void> {
  await client.query(executionKindsSql(schema));
  await client.query(toolRecordsSql(schema));
  await client.query(workspaceRecordsSql(schema));
  await client.query(workspaceReadRecordsSql(schema));
  await createRoutes(client, schema);
}

async function migrateVersionThree(
  client: PoolClient,
  schema: string,
): Promise<void> {
  await client.query(
    `ALTER TABLE ${schema}.device_execution_kinds DROP CONSTRAINT device_execution_kinds_command_kind_check`,
  );
  await client.query(
    `ALTER TABLE ${schema}.device_execution_kinds ADD CONSTRAINT device_execution_kinds_command_kind_check CHECK (command_kind IN ('tool', 'workspaceList', 'workspaceRead'))`,
  );
  await client.query(workspaceReadRecordsSql(schema));
}

async function migrateLegacySchema(
  client: PoolClient,
  schema: string,
): Promise<void> {
  await client.query(`
    ALTER TABLE ${schema}.device_dispatch_schema
      ADD CONSTRAINT device_dispatch_schema_version_v3_check
      CHECK (version > 0)
  `);
  await client.query(executionKindsSql(schema));
  await client.query(`
    INSERT INTO ${schema}.device_execution_kinds (execution_id, command_kind)
    SELECT execution_id, 'tool'
      FROM ${schema}.device_dispatch_records
    ON CONFLICT (execution_id) DO NOTHING
  `);
  await client.query(`
    ALTER TABLE ${schema}.device_dispatch_records
      ADD COLUMN command_kind TEXT NOT NULL DEFAULT 'tool'
  `);
  await client.query(`
    ALTER TABLE ${schema}.device_dispatch_records
      ADD CONSTRAINT device_dispatch_records_command_kind_check
      CHECK (command_kind = 'tool'),
      ADD CONSTRAINT device_dispatch_records_fingerprint_v3_check
      CHECK (fingerprint ~ '^sha256:[0-9a-f]{64}$'),
      ADD CONSTRAINT device_dispatch_records_command_json_v3_check
      CHECK (jsonb_typeof(command_json) = 'object'),
      ADD CONSTRAINT device_dispatch_records_resolution_json_v3_check
      CHECK (
        resolution_json IS NULL OR jsonb_typeof(resolution_json) = 'object'
      ),
      ADD CONSTRAINT device_dispatch_records_time_v3_check
      CHECK (updated_at >= created_at),
      ADD CONSTRAINT device_dispatch_records_execution_kind_fk
      FOREIGN KEY (execution_id, command_kind)
      REFERENCES ${schema}.device_execution_kinds(execution_id, command_kind)
      ON DELETE RESTRICT
  `);
  await client.query(workspaceRecordsSql(schema));
  await createRoutes(client, schema);
  await client.query(`
    ALTER TABLE ${schema}.device_connection_routes
      ADD CONSTRAINT device_connection_routes_epoch_v3_check
      CHECK (epoch > 0)
  `);
}

function executionKindsSql(schema: string): string {
  return `
    CREATE TABLE ${schema}.device_execution_kinds (
      execution_id TEXT PRIMARY KEY,
      command_kind TEXT NOT NULL CHECK (
        command_kind IN ('tool', 'workspaceList', 'workspaceRead')
      ),
      CONSTRAINT device_execution_kinds_identity_kind_key
        UNIQUE (execution_id, command_kind)
    )
  `;
}

function toolRecordsSql(schema: string): string {
  return `
    CREATE TABLE ${schema}.device_dispatch_records (
      execution_id TEXT PRIMARY KEY,
      command_kind TEXT NOT NULL DEFAULT 'tool' CHECK (command_kind = 'tool'),
      fingerprint TEXT NOT NULL CHECK (
        fingerprint ~ '^sha256:[0-9a-f]{64}$'
      ),
      command_json JSONB NOT NULL CHECK (
        jsonb_typeof(command_json) = 'object'
      ),
      resolution_json JSONB CHECK (
        resolution_json IS NULL OR jsonb_typeof(resolution_json) = 'object'
      ),
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL CHECK (updated_at >= created_at),
      CONSTRAINT device_dispatch_records_execution_kind_fk
        FOREIGN KEY (execution_id, command_kind)
        REFERENCES ${schema}.device_execution_kinds(execution_id, command_kind)
        ON DELETE RESTRICT
    )
  `;
}

function workspaceRecordsSql(schema: string): string {
  return `
    CREATE TABLE ${schema}.workspace_dispatch_records (
      execution_id TEXT PRIMARY KEY,
      command_kind TEXT NOT NULL DEFAULT 'workspaceList' CHECK (
        command_kind = 'workspaceList'
      ),
      record_json JSONB NOT NULL CHECK (
        jsonb_typeof(record_json) = 'object'
      ),
      CONSTRAINT workspace_dispatch_records_execution_kind_fk
        FOREIGN KEY (execution_id, command_kind)
        REFERENCES ${schema}.device_execution_kinds(execution_id, command_kind)
        ON DELETE RESTRICT
    )
  `;
}

function workspaceReadRecordsSql(schema: string): string {
  return `CREATE TABLE ${schema}.workspace_read_dispatch_records (
    execution_id TEXT PRIMARY KEY,
    command_kind TEXT NOT NULL DEFAULT 'workspaceRead' CHECK (command_kind = 'workspaceRead'),
    record_json JSONB NOT NULL CHECK (jsonb_typeof(record_json) = 'object'),
    CONSTRAINT workspace_read_dispatch_records_execution_kind_fk FOREIGN KEY (execution_id, command_kind)
      REFERENCES ${schema}.device_execution_kinds(execution_id, command_kind) ON DELETE RESTRICT
  )`;
}

async function createRoutes(client: PoolClient, schema: string): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${schema}.device_connection_routes (
      device_id TEXT PRIMARY KEY,
      gateway_id TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      epoch BIGINT NOT NULL CHECK (epoch > 0),
      lease_expires_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS device_connection_routes_gateway_idx
        ON ${schema}.device_connection_routes (gateway_id, lease_expires_at)
  `);
}

async function assertPostgresDeviceDispatchSchema(
  client: PoolClient,
  schema: string,
): Promise<void> {
  await requireColumns(client, schema, "device_dispatch_schema", [
    "component:text:NO",
    "version:integer:NO",
  ]);
  await requireColumns(client, schema, "device_execution_kinds", [
    "execution_id:text:NO",
    "command_kind:text:NO",
  ]);
  await requireColumns(client, schema, "device_dispatch_records", [
    "execution_id:text:NO",
    "command_kind:text:NO",
    "fingerprint:text:NO",
    "command_json:jsonb:NO",
    "resolution_json:jsonb:YES",
    "created_at:timestamp with time zone:NO",
    "updated_at:timestamp with time zone:NO",
  ]);
  await requireColumns(client, schema, "workspace_dispatch_records", [
    "execution_id:text:NO",
    "command_kind:text:NO",
    "record_json:jsonb:NO",
  ]);
  await requireColumns(client, schema, "workspace_read_dispatch_records", [
    "execution_id:text:NO",
    "command_kind:text:NO",
    "record_json:jsonb:NO",
  ]);
  await requireColumns(client, schema, "device_connection_routes", [
    "device_id:text:NO",
    "gateway_id:text:NO",
    "connection_id:text:NO",
    "epoch:bigint:NO",
    "lease_expires_at:timestamp with time zone:NO",
    "updated_at:timestamp with time zone:NO",
  ]);
  await requireConstraints(client, schema, "device_execution_kinds", [
    "PRIMARY KEY (execution_id)",
    "UNIQUE (execution_id, command_kind)",
    "'workspaceRead'::text",
  ]);
  await requireConstraints(client, schema, "device_dispatch_schema", [
    "PRIMARY KEY (component)",
    "CHECK (version > 0)",
  ]);
  await requireConstraints(client, schema, "device_dispatch_records", [
    "PRIMARY KEY (execution_id)",
    `FOREIGN KEY (execution_id, command_kind) REFERENCES ${schema}.device_execution_kinds(execution_id, command_kind) ON DELETE RESTRICT`,
    "CHECK (command_kind = 'tool'::text)",
    "CHECK (fingerprint ~ '^sha256:[0-9a-f]{64}$'::text)",
    "CHECK (jsonb_typeof(command_json) = 'object'::text)",
    "CHECK (resolution_json IS NULL OR jsonb_typeof(resolution_json) = 'object'::text)",
    "CHECK (updated_at >= created_at)",
  ]);
  await requireConstraints(client, schema, "workspace_dispatch_records", [
    "PRIMARY KEY (execution_id)",
    `FOREIGN KEY (execution_id, command_kind) REFERENCES ${schema}.device_execution_kinds(execution_id, command_kind) ON DELETE RESTRICT`,
    "CHECK (command_kind = 'workspaceList'::text)",
    "CHECK (jsonb_typeof(record_json) = 'object'::text)",
  ]);
  await requireConstraints(client, schema, "workspace_read_dispatch_records", [
    "PRIMARY KEY (execution_id)",
    `FOREIGN KEY (execution_id, command_kind) REFERENCES ${schema}.device_execution_kinds(execution_id, command_kind) ON DELETE RESTRICT`,
    "CHECK (command_kind = 'workspaceRead'::text)",
    "CHECK (jsonb_typeof(record_json) = 'object'::text)",
  ]);
  await requireConstraints(client, schema, "device_connection_routes", [
    "PRIMARY KEY (device_id)",
    "CHECK (epoch > 0)",
  ]);
  await requireColumnDefault(
    client,
    schema,
    "device_dispatch_records",
    "command_kind",
    "'tool'::text",
  );
  await requireColumnDefault(
    client,
    schema,
    "workspace_read_dispatch_records",
    "command_kind",
    "'workspaceRead'::text",
  );
  await requireColumnDefault(
    client,
    schema,
    "workspace_dispatch_records",
    "command_kind",
    "'workspaceList'::text",
  );
  const index = await client.query<{ columns: string }>(
    `SELECT string_agg(attribute.attname, ',' ORDER BY key.ordinality) AS columns
       FROM pg_class index_class
       JOIN pg_namespace namespace ON namespace.oid = index_class.relnamespace
       JOIN pg_index index_meta ON index_meta.indexrelid = index_class.oid
       JOIN unnest(index_meta.indkey) WITH ORDINALITY key(attnum, ordinality)
         ON true
       JOIN pg_class table_class ON table_class.oid = index_meta.indrelid
       JOIN pg_attribute attribute
         ON attribute.attrelid = table_class.oid AND attribute.attnum = key.attnum
      WHERE namespace.nspname = $1
        AND index_class.relname = 'device_connection_routes_gateway_idx'
      GROUP BY index_class.oid`,
    [schema],
  );
  if (index.rows[0]?.columns !== "gateway_id,lease_expires_at") {
    throw new DeviceGatewayError("device_dispatch_schema_invalid");
  }
}

async function requireColumns(
  client: PoolClient,
  schema: string,
  table: string,
  expected: readonly string[],
): Promise<void> {
  const result = await client.query<{
    column_name: string;
    data_type: string;
    is_nullable: string;
  }>(
    `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2
      ORDER BY ordinal_position`,
    [schema, table],
  );
  const actual = result.rows.map(
    (row) => `${row.column_name}:${row.data_type}:${row.is_nullable}`,
  );
  if (JSON.stringify(actual.sort()) !== JSON.stringify([...expected].sort())) {
    throw new DeviceGatewayError("device_dispatch_schema_invalid");
  }
}

async function requireConstraints(
  client: PoolClient,
  schema: string,
  table: string,
  requiredFragments: readonly string[],
): Promise<void> {
  const result = await client.query<{ definition: string }>(
    `SELECT pg_get_constraintdef(constraint_meta.oid, true) AS definition
       FROM pg_constraint constraint_meta
       JOIN pg_class table_meta ON table_meta.oid = constraint_meta.conrelid
       JOIN pg_namespace namespace ON namespace.oid = table_meta.relnamespace
      WHERE namespace.nspname = $1 AND table_meta.relname = $2`,
    [schema, table],
  );
  const definitions = result.rows.map((row) => row.definition);
  if (
    requiredFragments.some(
      (fragment) =>
        !definitions.some((definition) => definition.includes(fragment)),
    )
  ) {
    throw new DeviceGatewayError("device_dispatch_schema_invalid");
  }
}

async function requireColumnDefault(
  client: PoolClient,
  schema: string,
  table: string,
  column: string,
  expected: string,
): Promise<void> {
  const result = await client.query<{ column_default: string | null }>(
    `SELECT column_default
       FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
    [schema, table, column],
  );
  if (result.rows[0]?.column_default !== expected) {
    throw new DeviceGatewayError("device_dispatch_schema_invalid");
  }
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the migration or schema assertion failure.
  }
}
