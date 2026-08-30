export const POSTGRES_RUN_SCHEMA_VERSION = 2;

export function postgresRunSchemaSql(schema: string): string {
  return `
    INSERT INTO ${schema}.schema_migrations(component, version)
      VALUES ('run_authority', ${POSTGRES_RUN_SCHEMA_VERSION})
      ON CONFLICT (component) DO NOTHING;

    CREATE TABLE IF NOT EXISTS ${schema}.run_snapshots (
      run_id text PRIMARY KEY,
      tenant_id text NOT NULL,
      space_id text NOT NULL,
      revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
      last_sequence bigint NOT NULL CHECK (last_sequence BETWEEN 1 AND 9007199254740991),
      state_json jsonb NOT NULL CHECK (jsonb_typeof(state_json) = 'object'),
      updated_at timestamptz NOT NULL,
      UNIQUE (tenant_id, run_id)
    );

    CREATE TABLE IF NOT EXISTS ${schema}.run_thread_bindings (
      tenant_id text NOT NULL,
      run_id text PRIMARY KEY,
      thread_id text NOT NULL,
      UNIQUE (tenant_id, run_id, thread_id),
      FOREIGN KEY (tenant_id, run_id)
        REFERENCES ${schema}.run_snapshots(tenant_id, run_id) ON DELETE CASCADE,
      FOREIGN KEY (tenant_id, thread_id)
        REFERENCES ${schema}.threads(tenant_id, thread_id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS ${schema}.run_events (
      tenant_id text NOT NULL,
      run_id text NOT NULL,
      sequence bigint NOT NULL CHECK (sequence BETWEEN 1 AND 9007199254740991),
      event_id text NOT NULL UNIQUE,
      event_json jsonb NOT NULL CHECK (jsonb_typeof(event_json) = 'object'),
      PRIMARY KEY (run_id, sequence),
      FOREIGN KEY (tenant_id, run_id)
        REFERENCES ${schema}.run_snapshots(tenant_id, run_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ${schema}.idempotency_receipts (
      tenant_id text NOT NULL,
      scope text NOT NULL,
      idempotency_key text NOT NULL,
      run_id text NOT NULL,
      fingerprint text NOT NULL,
      result_json jsonb NOT NULL CHECK (jsonb_typeof(result_json) = 'object'),
      PRIMARY KEY (scope, idempotency_key),
      FOREIGN KEY (tenant_id, run_id)
        REFERENCES ${schema}.run_snapshots(tenant_id, run_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS run_events_tenant_run_idx
      ON ${schema}.run_events(tenant_id, run_id, sequence);
    CREATE INDEX IF NOT EXISTS run_thread_bindings_thread_idx
      ON ${schema}.run_thread_bindings(tenant_id, thread_id, run_id);

    DO $migration$
    BEGIN
      ALTER TABLE ${schema}.outbox ADD CONSTRAINT outbox_run_authority_fk
        FOREIGN KEY (tenant_id, run_id)
        REFERENCES ${schema}.run_snapshots(tenant_id, run_id) ON DELETE CASCADE;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $migration$;
    DO $migration$
    BEGIN
      ALTER TABLE ${schema}.work_items ADD CONSTRAINT work_items_run_authority_fk
        FOREIGN KEY (tenant_id, run_id)
        REFERENCES ${schema}.run_snapshots(tenant_id, run_id) ON DELETE CASCADE;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $migration$;

    DO $migration$
    BEGIN
      ALTER TABLE ${schema}.run_snapshots
        ADD CONSTRAINT run_snapshots_goal_accounting_v2_ck CHECK (
          state_json->>'status' IN ('completed', 'failed', 'canceled')
          OR NOT (state_json ? 'goalBinding')
          OR state_json->'goalBinding' = 'null'::jsonb
          OR (
            state_json ? 'goalAccounting'
            AND jsonb_typeof(state_json->'goalAccounting') = 'object'
          )
        );
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $migration$;

    UPDATE ${schema}.schema_migrations
      SET version = ${POSTGRES_RUN_SCHEMA_VERSION}
      WHERE component = 'run_authority' AND version = 1;`;
}
