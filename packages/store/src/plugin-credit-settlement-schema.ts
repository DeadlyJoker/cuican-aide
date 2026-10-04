import { pluginCreditSchemaName } from "./plugin-credit-schema.ts";

/** Additive opt-in schema; original credit, admission, Run and event versions stay unchanged. */
export function pluginCreditSettlementSchemaSql(
  input:
    | Readonly<{ dialect: "sqlite" }>
    | Readonly<{ dialect: "postgres"; schema: string }>,
): string {
  const pg = input.dialect === "postgres";
  const prefix =
    input.dialect === "postgres"
      ? `${pluginCreditSchemaName(input.schema)}.`
      : "";
  const json = pg ? "JSONB" : "TEXT";
  const bytes = pg
    ? "octet_length(record_json::text)"
    : "length(CAST(record_json AS BLOB))";
  const sql = `
    CREATE TABLE IF NOT EXISTS ${prefix}plugin_credit_settlement_schema_version (
      id INTEGER PRIMARY KEY CHECK (id=1), version INTEGER NOT NULL
    )${pg ? "" : " STRICT"};
    INSERT INTO ${prefix}plugin_credit_settlement_schema_version VALUES(1,1) ON CONFLICT(id) DO NOTHING;
    CREATE TABLE IF NOT EXISTS ${prefix}plugin_credit_settlement_finalizations (
      tenant_id TEXT NOT NULL, run_id TEXT NOT NULL,
      authority_id TEXT NOT NULL, decision_id TEXT NOT NULL, evidence_digest TEXT NOT NULL,
      record_json ${json} NOT NULL CHECK (${bytes} BETWEEN 1 AND 65536${pg ? " AND jsonb_typeof(record_json)='object'" : " AND json_valid(record_json) AND json_type(record_json)='object'"}),
      PRIMARY KEY(tenant_id,run_id), UNIQUE(authority_id,decision_id),
      FOREIGN KEY(tenant_id,run_id) REFERENCES ${prefix}extension_credit_admissions(tenant_id,run_id) ON DELETE RESTRICT
    )${pg ? "" : " STRICT"};`;
  return (
    sql +
    (pg
      ? `
    CREATE OR REPLACE FUNCTION ${prefix}plugin_credit_settlement_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'plugin_credit_settlement_immutable'; END $$;
    CREATE OR REPLACE TRIGGER plugin_credit_settlement_no_update_or_delete
      BEFORE UPDATE OR DELETE ON ${prefix}plugin_credit_settlement_finalizations
      FOR EACH ROW EXECUTE FUNCTION ${prefix}plugin_credit_settlement_immutable();`
      : `
    CREATE TRIGGER IF NOT EXISTS plugin_credit_settlement_no_update
      BEFORE UPDATE ON plugin_credit_settlement_finalizations
      BEGIN SELECT RAISE(ABORT,'plugin_credit_settlement_immutable'); END;
    CREATE TRIGGER IF NOT EXISTS plugin_credit_settlement_no_delete
      BEFORE DELETE ON plugin_credit_settlement_finalizations
      BEGIN SELECT RAISE(ABORT,'plugin_credit_settlement_immutable'); END;`)
  );
}

export function assertPluginCreditSettlementSchemaVersion(
  rows: readonly Readonly<{ id: unknown; version: unknown }>[],
): void {
  if (rows.length !== 1 || rows[0]?.id !== 1 || rows[0]?.version !== 1)
    throw new Error("plugin_credit_settlement_schema_version_unsupported");
}
