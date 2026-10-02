import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";

export const PLUGIN_CREDIT_SCHEMA_VERSION = 1;

export function pluginCreditSchemaName(value: string): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_]{0,62}$/u.test(value))
    throw new Error("plugin_credit_schema_invalid");
  return `"${value}"`;
}

export function pluginCreditSchemaSql(
  input: { dialect: "sqlite" } | { dialect: "postgres"; schema: string },
): string {
  const postgres = input.dialect === "postgres";
  const prefix =
    input.dialect === "postgres"
      ? `${pluginCreditSchemaName(input.schema)}.`
      : "";
  const json = postgres ? "JSONB" : "TEXT";
  const integer = postgres ? "BIGINT" : "INTEGER";
  const strict = postgres ? "" : " STRICT";
  const bytes = (column: string) =>
    postgres
      ? `octet_length(${column}::text)`
      : `length(CAST(${column} AS BLOB))`;
  const validJson = (column: string) =>
    postgres ? "" : ` AND json_valid(${column})`;
  return `
    CREATE TABLE IF NOT EXISTS ${prefix}plugin_credit_accounts (
      tenant_id TEXT NOT NULL, principal_id TEXT NOT NULL, pool_id TEXT NOT NULL,
      revision ${integer} NOT NULL CHECK (revision > 0),
      account_json ${json} NOT NULL CHECK (${bytes("account_json")} <= 4096${validJson("account_json")}),
      PRIMARY KEY (tenant_id, principal_id, pool_id)
    )${strict};
    CREATE TABLE IF NOT EXISTS ${prefix}plugin_credit_reservations (
      tenant_id TEXT NOT NULL, principal_id TEXT NOT NULL, pool_id TEXT NOT NULL,
      reservation_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
      record_json ${json} NOT NULL CHECK (${bytes("record_json")} <= 8192${validJson("record_json")}),
      PRIMARY KEY (tenant_id, principal_id, pool_id, reservation_id),
      UNIQUE (tenant_id, principal_id, pool_id, idempotency_key),
      FOREIGN KEY (tenant_id, principal_id, pool_id)
        REFERENCES ${prefix}plugin_credit_accounts (tenant_id, principal_id, pool_id) ON DELETE RESTRICT
    )${strict};
    CREATE TABLE IF NOT EXISTS ${prefix}plugin_credit_grant_receipts (
      tenant_id TEXT NOT NULL, principal_id TEXT NOT NULL, pool_id TEXT NOT NULL,
      grant_id TEXT NOT NULL, credits TEXT NOT NULL,
      PRIMARY KEY (tenant_id, principal_id, pool_id, grant_id),
      FOREIGN KEY (tenant_id, principal_id, pool_id)
        REFERENCES ${prefix}plugin_credit_accounts (tenant_id, principal_id, pool_id) ON DELETE RESTRICT
    )${strict};
    CREATE TABLE IF NOT EXISTS ${prefix}plugin_credit_entries (
      tenant_id TEXT NOT NULL, principal_id TEXT NOT NULL, pool_id TEXT NOT NULL,
      revision ${integer} NOT NULL CHECK (revision > 0),
      entry_json ${json} NOT NULL CHECK (${bytes("entry_json")} <= 8192${validJson("entry_json")}),
      PRIMARY KEY (tenant_id, principal_id, pool_id, revision),
      FOREIGN KEY (tenant_id, principal_id, pool_id)
        REFERENCES ${prefix}plugin_credit_accounts (tenant_id, principal_id, pool_id) ON DELETE RESTRICT
    )${strict};
  `;
}

function assertVersion(rows: readonly { id: unknown; version: unknown }[]) {
  if (
    rows.length !== 1 ||
    rows[0]!.id !== 1 ||
    rows[0]!.version !== PLUGIN_CREDIT_SCHEMA_VERSION
  )
    throw new Error("plugin_credit_schema_version_unsupported");
}

/** The caller owns the migration transaction; this never changes the core schema version. */
export function migrateSqlitePluginCredits(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS plugin_credit_schema_version (
      id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL
    ) STRICT;
    INSERT INTO plugin_credit_schema_version VALUES (1, 1) ON CONFLICT (id) DO NOTHING;
  `);
  assertVersion(
    database
      .prepare("SELECT id, version FROM plugin_credit_schema_version LIMIT 2")
      .all() as {
      id: unknown;
      version: unknown;
    }[],
  );
  database.exec(pluginCreditSchemaSql({ dialect: "sqlite" }));
  database.exec(`
    CREATE TRIGGER IF NOT EXISTS plugin_credit_entries_no_update
      BEFORE UPDATE ON plugin_credit_entries
      BEGIN SELECT RAISE(ABORT, 'plugin_credit_entry_immutable'); END;
    CREATE TRIGGER IF NOT EXISTS plugin_credit_entries_no_delete
      BEFORE DELETE ON plugin_credit_entries
      BEGIN SELECT RAISE(ABORT, 'plugin_credit_entry_immutable'); END;
  `);
  for (const statement of schemaReads("")) database.prepare(statement).all();
  const triggers = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='plugin_credit_entries' AND name IN ('plugin_credit_entries_no_update','plugin_credit_entries_no_delete')",
    )
    .all();
  if (triggers.length !== 2) throw new Error("plugin_credit_schema_incomplete");
}

/** The caller owns the transaction and migration lock. */
export async function migratePostgresPluginCredits(
  client: PoolClient,
  schema: string,
): Promise<void> {
  const prefix = `${pluginCreditSchemaName(schema)}.`;
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${prefix}plugin_credit_schema_version (
      id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL
    );
    INSERT INTO ${prefix}plugin_credit_schema_version VALUES (1, 1) ON CONFLICT (id) DO NOTHING;
  `);
  const version = await client.query<{ id: unknown; version: unknown }>(
    `SELECT id, version FROM ${prefix}plugin_credit_schema_version LIMIT 2`,
  );
  assertVersion(version.rows);
  await client.query(pluginCreditSchemaSql({ dialect: "postgres", schema }));
  await client.query(`
    CREATE OR REPLACE FUNCTION ${prefix}plugin_credit_entry_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'plugin_credit_entry_immutable'; END;
    $$;
    CREATE OR REPLACE TRIGGER plugin_credit_entries_no_update_or_delete
      BEFORE UPDATE OR DELETE ON ${prefix}plugin_credit_entries
      FOR EACH ROW EXECUTE FUNCTION ${prefix}plugin_credit_entry_immutable();
  `);
  for (const statement of schemaReads(prefix)) await client.query(statement);
}

function schemaReads(prefix: string): readonly string[] {
  return [
    `SELECT tenant_id,principal_id,pool_id,revision,account_json FROM ${prefix}plugin_credit_accounts LIMIT 0`,
    `SELECT tenant_id,principal_id,pool_id,reservation_id,idempotency_key,record_json FROM ${prefix}plugin_credit_reservations LIMIT 0`,
    `SELECT tenant_id,principal_id,pool_id,grant_id,credits FROM ${prefix}plugin_credit_grant_receipts LIMIT 0`,
    `SELECT tenant_id,principal_id,pool_id,revision,entry_json FROM ${prefix}plugin_credit_entries LIMIT 0`,
  ];
}
