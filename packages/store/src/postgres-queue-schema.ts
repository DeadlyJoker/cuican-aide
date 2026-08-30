import { RunStoreError } from "@crewon/application";

export const POSTGRES_QUEUE_SCHEMA_VERSION = 1;

const SCHEMA_NAME = /^[a-z][a-z0-9_]{0,62}$/;

export function validatePostgresSchemaName(schema: string): string {
  if (!SCHEMA_NAME.test(schema)) {
    throw new RunStoreError("postgres_schema_name_invalid");
  }
  return schema;
}

export function quotePostgresIdentifier(identifier: string): string {
  return `"${identifier}"`;
}

export function postgresQueueSchemaSql(schema: string): string {
  return `
    CREATE TABLE IF NOT EXISTS ${schema}.schema_migrations (
      component text PRIMARY KEY,
      version integer NOT NULL CHECK (version >= 1)
    );
    INSERT INTO ${schema}.schema_migrations(component, version)
      VALUES ('durable_queue', ${POSTGRES_QUEUE_SCHEMA_VERSION})
      ON CONFLICT (component) DO NOTHING;

    CREATE TABLE IF NOT EXISTS ${schema}.outbox (
      outbox_order bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      message_id text NOT NULL UNIQUE, tenant_id text NOT NULL, run_id text NOT NULL,
      topic text NOT NULL, message_json jsonb NOT NULL, created_at timestamptz NOT NULL,
      status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','leased','delivered')),
      available_at timestamptz NOT NULL, lease_owner_id text, lease_id text,
      lease_epoch bigint NOT NULL DEFAULT 0 CHECK (lease_epoch BETWEEN 0 AND 9007199254740991),
      lease_expires_at timestamptz, attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      delivered_at timestamptz, last_error_code text,
      CHECK ((status = 'pending' AND lease_owner_id IS NULL AND lease_id IS NULL AND lease_expires_at IS NULL AND delivered_at IS NULL)
        OR (status = 'leased' AND lease_owner_id IS NOT NULL AND lease_id IS NOT NULL AND lease_expires_at IS NOT NULL AND delivered_at IS NULL)
        OR (status = 'delivered' AND lease_owner_id IS NULL AND lease_id IS NULL AND lease_expires_at IS NULL AND delivered_at IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS outbox_claim_idx
      ON ${schema}.outbox(status, available_at, lease_expires_at, outbox_order);

    CREATE TABLE IF NOT EXISTS ${schema}.work_items (
      work_item_order bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      work_item_id text NOT NULL UNIQUE, tenant_id text NOT NULL, run_id text NOT NULL,
      kind text NOT NULL CHECK (kind = 'run.execute'), work_item_json jsonb NOT NULL,
      created_at timestamptz NOT NULL, status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','leased','completed')),
      available_at timestamptz NOT NULL, lease_owner_id text, lease_id text,
      lease_epoch bigint NOT NULL DEFAULT 0 CHECK (lease_epoch BETWEEN 0 AND 9007199254740991),
      lease_expires_at timestamptz, attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      completed_at timestamptz, last_error_code text,
      CHECK ((status = 'pending' AND lease_owner_id IS NULL AND lease_id IS NULL AND lease_expires_at IS NULL AND completed_at IS NULL)
        OR (status = 'leased' AND lease_owner_id IS NOT NULL AND lease_id IS NOT NULL AND lease_expires_at IS NOT NULL AND completed_at IS NULL)
        OR (status = 'completed' AND lease_owner_id IS NULL AND lease_id IS NULL AND lease_expires_at IS NULL AND completed_at IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS work_items_claim_idx
      ON ${schema}.work_items(status, available_at, lease_expires_at, work_item_order);`;
}
