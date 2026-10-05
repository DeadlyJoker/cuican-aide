import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";

const requiredTables = [
  "creative_project_schema_version",
  "creative_projects",
  "creative_project_briefs",
  "creative_concept_assets",
  "creative_concept_revisions",
  "project_generation_schema_version",
  "creative_project_generation_links",
  "extension_schema_version",
  "extension_configurations",
  "extension_run_bindings",
  "extension_mutation_receipts",
  "extension_external_operations",
  "run_snapshots",
  "plugin_installation_schema_version",
  "installed_plugin_packages",
  "plugin_profile_selections",
  "plugin_task_admission_schema_version",
  "plugin_task_admissions",
  "plugin_query_task_admission_schema_version",
  "plugin_query_task_admissions",
] as const;
const optionalTables = [
  "extension_credit_schema_version",
  "extension_credit_admissions",
  "plugin_credit_schema_version",
  "plugin_credit_accounts",
  "plugin_credit_reservations",
  "plugin_credit_entries",
  "plugin_task_unmetered_schema_version",
  "plugin_task_unmetered_admissions",
] as const;
const independentTables = [
  "project_historical_query_schema_version",
  "creative_project_historical_query_links",
] as const;
const allTables = [...requiredTables, ...optionalTables, ...independentTables];
const marker = "project_historical_query_digest";
function invalid(): never {
  throw new Error("project_historical_query_schema_incomplete");
}
/** Every evidence lookup remains on actual main tables, without temp/view substitution. */
export function assertSqliteHistoricalQueryEvidenceCatalog(
  db: DatabaseSync,
): void {
  const placeholders = allTables.map(() => "?").join(",");
  if (
    db
      .prepare(
        `SELECT name FROM sqlite_temp_master WHERE name IN (${placeholders}) LIMIT 1`,
      )
      .get(...allTables) !== undefined
  )
    invalid();
  const objects = db
    .prepare(
      `SELECT name,type FROM main.sqlite_master WHERE name IN (${placeholders})`,
    )
    .all(...allTables);
  const byName = new Map(objects.map((row) => [row.name, row.type]));
  for (const name of requiredTables)
    if (byName.get(name) !== "table") invalid();
  for (const name of [...optionalTables, ...independentTables])
    if (byName.has(name) && byName.get(name) !== "table") invalid();
}
export async function assertPostgresHistoricalQueryEvidenceCatalog(
  client: PoolClient,
  schema: string,
): Promise<void> {
  const rows = (
    await client.query<{ name: string; kind: string }>(
      "SELECT c.relname AS name,c.relkind AS kind FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=ANY($2::text[])",
      [schema, allTables],
    )
  ).rows;
  const byName = new Map(rows.map((row) => [row.name, row.kind]));
  for (const name of requiredTables) if (byName.get(name) !== "r") invalid();
  for (const name of [...optionalTables, ...independentTables])
    if (byName.has(name) && byName.get(name) !== "r") invalid();
}
export function assertSqliteHistoricalQueryMarkerColumn(
  db: DatabaseSync,
): void {
  const field = db
    .prepare("PRAGMA main.table_info(plugin_query_task_admissions)")
    .all()
    .find((row) => row.name === marker);
  if (
    field === undefined ||
    field.type !== "TEXT" ||
    field.notnull !== 0 ||
    field.dflt_value !== null ||
    field.pk !== 0
  )
    invalid();
}
export async function assertPostgresHistoricalQueryMarkerColumn(
  client: PoolClient,
  schema: string,
): Promise<void> {
  const rows = (
    await client.query<{
      type: string;
      not_null: boolean;
      generated: string;
      has_default: boolean;
    }>(
      `SELECT t.typname AS type,a.attnotnull AS not_null,a.attgenerated AS generated,a.atthasdef AS has_default FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_type t ON t.oid=a.atttypid WHERE n.nspname=$1 AND c.relname='plugin_query_task_admissions' AND c.relkind='r' AND a.attname=$2 AND NOT a.attisdropped`,
      [schema, marker],
    )
  ).rows;
  const field = rows[0];
  if (
    rows.length !== 1 ||
    field?.type !== "text" ||
    field.not_null ||
    field.generated !== "" ||
    field.has_default
  )
    invalid();
}
export function sqliteHasHistoricalQueryObjects(db: DatabaseSync): boolean {
  return (
    db
      .prepare("SELECT 1 FROM main.sqlite_master WHERE name IN (?,?) LIMIT 1")
      .get(...independentTables) !== undefined
  );
}
export async function postgresHasHistoricalQueryObjects(
  client: PoolClient,
  schema: string,
): Promise<boolean> {
  return (
    (
      await client.query(
        "SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) LIMIT 1",
        [schema, independentTables],
      )
    ).rows.length !== 0
  );
}
