export function sqliteModelUsageSchemaSql(): string {
  return `CREATE TABLE IF NOT EXISTS model_usage_observations (
    usage_order INTEGER PRIMARY KEY AUTOINCREMENT,
    usage_key TEXT NOT NULL UNIQUE,
    tenant_id TEXT NOT NULL, run_id TEXT NOT NULL,
    record_json TEXT NOT NULL CHECK (json_valid(record_json)),
    FOREIGN KEY (tenant_id, run_id) REFERENCES run_snapshots(tenant_id, run_id) ON DELETE CASCADE
  ) STRICT;
  CREATE INDEX IF NOT EXISTS model_usage_run_order ON model_usage_observations(tenant_id, run_id, usage_order);`;
}

export function postgresModelUsageSchemaSql(schema: string): string {
  return `CREATE TABLE IF NOT EXISTS ${schema}.model_usage_observations (
    usage_order bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    usage_key text NOT NULL UNIQUE,
    tenant_id text NOT NULL, run_id text NOT NULL,
    record_json jsonb NOT NULL CHECK (jsonb_typeof(record_json)='object'),
    FOREIGN KEY (tenant_id, run_id) REFERENCES ${schema}.run_snapshots(tenant_id, run_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS model_usage_run_order ON ${schema}.model_usage_observations(tenant_id, run_id, usage_order);`;
}

export function sqliteModelCallSchemaSql(): string {
  return `CREATE TABLE IF NOT EXISTS model_call_observations (
    call_order INTEGER PRIMARY KEY AUTOINCREMENT,
    call_key TEXT NOT NULL UNIQUE,
    tenant_id TEXT NOT NULL, run_id TEXT NOT NULL,
    record_json TEXT NOT NULL CHECK (json_valid(record_json) AND length(CAST(record_json AS BLOB)) <= 16384),
    FOREIGN KEY (tenant_id, run_id) REFERENCES run_snapshots(tenant_id, run_id) ON DELETE CASCADE
  ) STRICT;
  CREATE INDEX IF NOT EXISTS model_call_run_order ON model_call_observations(tenant_id, run_id, call_order);`;
}

export function postgresModelCallSchemaSql(schema: string): string {
  return `CREATE TABLE IF NOT EXISTS ${schema}.model_call_observations (
    call_order bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    call_key text NOT NULL UNIQUE,
    tenant_id text NOT NULL, run_id text NOT NULL,
    record_json jsonb NOT NULL CHECK (jsonb_typeof(record_json)='object' AND octet_length(record_json::text) <= 16384),
    FOREIGN KEY (tenant_id, run_id) REFERENCES ${schema}.run_snapshots(tenant_id, run_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS model_call_run_order ON ${schema}.model_call_observations(tenant_id, run_id, call_order);`;
}
