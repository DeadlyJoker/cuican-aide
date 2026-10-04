import { pluginCreditSchemaName } from "./plugin-credit-schema.ts";

export const RECOVERY_SCHEMA_VERSION = 1;
export const recoveryMarkerName =
  "plugin_credit_settlement_recovery_schema_version";
export const recoveryIndexName =
  "plugin_credit_settlement_recovery_admissions_idx";
export const recoveryIndexColumns = [
  "tenant_id",
  "space_id",
  "profile_id",
  "run_id",
] as const;

/** Explicit opt-in metadata index. This never creates installation tables or finances. */
export function pluginCreditSettlementRecoverySchemaSql(
  input:
    | Readonly<{ dialect: "sqlite" }>
    | Readonly<{ dialect: "postgres"; schema: string }>,
): string {
  if (input.dialect === "sqlite")
    return `
    CREATE TABLE main.${recoveryMarkerName}(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL) STRICT;
    INSERT INTO main.${recoveryMarkerName} VALUES(1,1);
    CREATE INDEX main.${recoveryIndexName} ON plugin_task_admissions(${recoveryIndexColumns.map((column) => `${column} COLLATE BINARY ASC`).join(",")});`;
  const prefix = `${pluginCreditSchemaName(input.schema)}.`;
  return `
    CREATE TABLE ${prefix}${recoveryMarkerName}(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL);
    INSERT INTO ${prefix}${recoveryMarkerName} VALUES(1,1);
    CREATE INDEX ${recoveryIndexName} ON ${prefix}plugin_task_admissions(${recoveryIndexColumns.map((column) => `${column} COLLATE "C" ASC`).join(",")});`;
}

export function assertPluginCreditSettlementRecoveryVersion(
  rows: readonly Readonly<{ id: unknown; version: unknown }>[],
): void {
  if (
    rows.length !== 1 ||
    rows[0]?.id !== 1 ||
    rows[0]?.version !== RECOVERY_SCHEMA_VERSION
  )
    throw new Error(
      "plugin_credit_settlement_recovery_schema_version_unsupported",
    );
}
