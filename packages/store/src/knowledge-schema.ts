import type { DatabaseSync } from "node:sqlite";
import { RunStoreError } from "@crewon/application";
import type { PoolClient } from "pg";

export const POSTGRES_KNOWLEDGE_SCHEMA_VERSION = 1;

export function sqliteKnowledgeTablesSql(): string {
  return `
    CREATE TABLE IF NOT EXISTS knowledge_records (
      tenant_id TEXT NOT NULL, space_id TEXT NOT NULL, knowledge_id TEXT NOT NULL,
      created_at TEXT NOT NULL, record_json TEXT NOT NULL CHECK (json_valid(record_json)),
      PRIMARY KEY (tenant_id, space_id, knowledge_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS knowledge_records_page_idx
      ON knowledge_records(tenant_id, space_id, created_at DESC, knowledge_id DESC);
    CREATE TABLE IF NOT EXISTS knowledge_create_receipts (
      tenant_id TEXT NOT NULL, space_id TEXT NOT NULL, scope TEXT NOT NULL,
      idempotency_key TEXT NOT NULL, fingerprint TEXT NOT NULL, knowledge_id TEXT NOT NULL,
      result_json TEXT NOT NULL CHECK (json_valid(result_json)),
      PRIMARY KEY (tenant_id, space_id, scope, idempotency_key),
      FOREIGN KEY (tenant_id, space_id, knowledge_id)
        REFERENCES knowledge_records(tenant_id, space_id, knowledge_id) ON DELETE RESTRICT
    ) STRICT;`;
}

export function migrateSqliteKnowledge(database: DatabaseSync): void {
  database.exec(sqliteKnowledgeTablesSql());
}

export async function migratePostgresKnowledge(
  client: PoolClient,
  schema: string,
): Promise<void> {
  const current = await client.query<{ version: number }>(
    `SELECT version FROM ${schema}.schema_migrations WHERE component='knowledge_authority'`,
  );
  const version = current.rows[0]?.version;
  if (version !== undefined && version !== POSTGRES_KNOWLEDGE_SCHEMA_VERSION)
    throw new RunStoreError(
      version > POSTGRES_KNOWLEDGE_SCHEMA_VERSION
        ? "postgres_schema_too_new"
        : "postgres_schema_version_unsupported",
    );
  await client.query(`
    INSERT INTO ${schema}.schema_migrations(component, version) VALUES ('knowledge_authority', 1) ON CONFLICT (component) DO NOTHING;
    CREATE TABLE IF NOT EXISTS ${schema}.knowledge_records (
      tenant_id text NOT NULL, space_id text NOT NULL, knowledge_id text NOT NULL,
      created_at timestamptz NOT NULL, record_json jsonb NOT NULL CHECK (jsonb_typeof(record_json)='object'),
      PRIMARY KEY (tenant_id, space_id, knowledge_id));
    CREATE INDEX IF NOT EXISTS knowledge_records_page_idx ON ${schema}.knowledge_records(tenant_id, space_id, created_at DESC, knowledge_id DESC);
    CREATE TABLE IF NOT EXISTS ${schema}.knowledge_create_receipts (
      tenant_id text NOT NULL, space_id text NOT NULL, scope text NOT NULL, idempotency_key text NOT NULL,
      fingerprint text NOT NULL, knowledge_id text NOT NULL, result_json jsonb NOT NULL CHECK (jsonb_typeof(result_json)='object'),
      PRIMARY KEY (tenant_id, space_id, scope, idempotency_key),
      FOREIGN KEY (tenant_id, space_id, knowledge_id) REFERENCES ${schema}.knowledge_records(tenant_id, space_id, knowledge_id) ON DELETE RESTRICT);`);
}
