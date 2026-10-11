import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import { PLUGIN_PROJECT_WORKSPACE_OWNER_FIELDS } from "@crewon/domain";
import { creativeProjectSchemaName } from "./creative-project-schema.ts";
import {
  assertPostgresAssetOwnedSchema,
  assertSqliteAssetOwnedSchema,
  migratePostgresAssetOwnedSchema,
  migrateSqliteAssetOwnedSchema,
  type AssetOwnedSchema,
} from "./project-asset-owned-schema.ts";
import { pluginProjectMetadataOwnerColumns } from "./plugin-project-metadata-owner-records.ts";

export const PLUGIN_PROJECT_METADATA_OWNER_TABLE =
  "plugin_project_metadata_owners";
// Schema constraints and immutable data are not a first-create grant. A future
// qualified original transaction must prove creation and fence every management
// path; this module intentionally exposes no insert/adopt/upsert operation.
const marker = "plugin_project_metadata_owner_schema_version";
const immutable = "plugin_project_metadata_owner_immutable";
const tables = [PLUGIN_PROJECT_METADATA_OWNER_TABLE, marker] as const;
const invalid = () => {
  throw new Error("plugin_project_metadata_owner_schema_invalid");
};

const definition: AssetOwnedSchema = {
  tables,
  marker,
  functions: [immutable],
  error: "plugin_project_metadata_owner_schema_invalid",
  sql(postgres, prefix) {
    const json = postgres ? "JSONB" : "TEXT";
    const strict = postgres ? "" : " STRICT";
    const text = (path: string) =>
      postgres
        ? `record_json#>>'{${path.replaceAll(".", ",")}}'`
        : `json_extract(record_json,'$.${path}')`;
    const isString = (path: string) =>
      postgres
        ? `jsonb_typeof(record_json#>'{${path.replaceAll(".", ",")}}') IS NOT DISTINCT FROM 'string'`
        : `json_type(record_json,'$.${path}') IS 'text'`;
    const matches = PLUGIN_PROJECT_WORKSPACE_OWNER_FIELDS.map(
      (field, index) => {
        const column = pluginProjectMetadataOwnerColumns[index]!;
        return `${isString(`owner.${field}`)} AND ${text(`owner.${field}`)}=${column}`;
      },
    ).join(" AND ");
    const jsonValid = postgres
      ? "jsonb_typeof(record_json)='object' AND octet_length(record_json::text)<=4096 AND jsonb_typeof(record_json->'owner')='object'"
      : "json_valid(record_json) AND json_type(record_json)='object' AND length(CAST(record_json AS BLOB))<=4096 AND json_type(record_json,'$.owner')='object'";
    const exactFields = postgres
      ? `record_json-ARRAY['schemaVersion','owner','createdAt']::text[]='{}'::jsonb AND (record_json->'owner')-ARRAY[${PLUGIN_PROJECT_WORKSPACE_OWNER_FIELDS.map((field) => `'${field}'`).join(",")}]::text[]='{}'::jsonb`
      : `json_remove(record_json,'$.schemaVersion','$.owner','$.createdAt')='{}' AND json_remove(json_extract(record_json,'$.owner'),${PLUGIN_PROJECT_WORKSPACE_OWNER_FIELDS.map((field) => `'$.${field}'`).join(",")})='{}'`;
    const identityColumns = pluginProjectMetadataOwnerColumns
      .slice(0, 8)
      .map(
        (column) =>
          `${column} TEXT NOT NULL CHECK(length(${column}) BETWEEN 1 AND 128)`,
      )
      .join(",");
    const ddl = `CREATE TABLE ${prefix}${PLUGIN_PROJECT_METADATA_OWNER_TABLE}(
      ${identityColumns},
      created_at TEXT NOT NULL CHECK(length(created_at)=24),record_json ${json} NOT NULL,
      PRIMARY KEY(tenant_id,space_id,project_id),
      FOREIGN KEY(tenant_id,space_id,project_id,principal_id) REFERENCES ${prefix}creative_projects(tenant_id,space_id,project_id,owner_principal_id) ON DELETE RESTRICT,
      CHECK(${jsonValid} AND ${exactFields} AND ${isString("schemaVersion")} AND ${text("schemaVersion")}='crewon.plugin-project-metadata-owner.v1' AND ${isString("createdAt")} AND ${text("createdAt")}=created_at AND ${matches})
    )${strict};
    CREATE TABLE ${prefix}${marker}(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,migration_digest TEXT NOT NULL,schema_digest TEXT NOT NULL)${strict};`;
    if (!postgres)
      return (
        ddl +
        tables
          .map((table) => {
            const occupied =
              table === marker
                ? "id=NEW.id"
                : "tenant_id=NEW.tenant_id AND space_id=NEW.space_id AND project_id=NEW.project_id";
            return `CREATE TRIGGER ${table}_no_replace BEFORE INSERT ON ${table} WHEN EXISTS(SELECT 1 FROM ${table} WHERE ${occupied}) BEGIN SELECT RAISE(ABORT,'plugin_project_metadata_owner_immutable'); END;
              CREATE TRIGGER ${table}_immutable BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'plugin_project_metadata_owner_immutable'); END;
              CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'plugin_project_metadata_owner_immutable'); END;`;
          })
          .join("")
      );
    return (
      ddl +
      `CREATE FUNCTION ${prefix}${immutable}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'plugin_project_metadata_owner_immutable'; END; $$;` +
      tables
        .map(
          (table) =>
            `CREATE TRIGGER ${table}_immutable BEFORE UPDATE OR DELETE ON ${prefix}${table} FOR EACH ROW EXECUTE FUNCTION ${prefix}${immutable}();`,
        )
        .join("")
    );
  },
};

function assertSqliteParent(db: DatabaseSync): void {
  const parent = db
    .prepare(
      "SELECT type FROM main.sqlite_schema WHERE name='creative_projects' UNION ALL SELECT type FROM temp.sqlite_schema WHERE name='creative_projects'",
    )
    .all();
  if (parent.length !== 1 || parent[0]!.type !== "table") invalid();
  if (db.prepare("PRAGMA foreign_keys").get()?.foreign_keys !== 1) invalid();
  db.prepare(
    "SELECT tenant_id,space_id,project_id,owner_principal_id FROM main.creative_projects LIMIT 0",
  ).all();
}

/** No construction or read path migrates. False means complete absence, never partial state. */
export function hasSqlitePluginProjectMetadataOwnerSchema(
  db: DatabaseSync,
): boolean {
  const expected = tables.flatMap((name) => [
    { name, type: "table", tbl_name: name },
    { name: `${name}_no_replace`, type: "trigger", tbl_name: name },
    { name: `${name}_immutable`, type: "trigger", tbl_name: name },
    { name: `${name}_no_delete`, type: "trigger", tbl_name: name },
  ]);
  const placeholders = expected.map(() => "?").join(",");
  const names = expected.map((row) => row.name);
  const found = db
    .prepare(
      `SELECT name,type,tbl_name,'main' AS location FROM main.sqlite_schema WHERE name IN (${placeholders}) UNION ALL SELECT name,type,tbl_name,'temp' AS location FROM temp.sqlite_schema WHERE name IN (${placeholders})`,
    )
    .all(...names, ...names);
  if (
    found.length !== 0 &&
    (found.length !== expected.length ||
      expected.some(
        (row) =>
          !found.some(
            (value) =>
              value.location === "main" &&
              value.name === row.name &&
              value.type === row.type &&
              value.tbl_name === row.tbl_name,
          ),
      ))
  )
    invalid();
  if (!assertSqliteAssetOwnedSchema(db, definition, true)) return false;
  assertSqliteParent(db);
  if (
    db
      .prepare(
        `PRAGMA foreign_key_check(${PLUGIN_PROJECT_METADATA_OWNER_TABLE})`,
      )
      .all().length !== 0
  )
    invalid();
  return true;
}

/** Caller owns the original connection and BEGIN/COMMIT/ROLLBACK. No metadata is backfilled. */
export function migrateSqlitePluginProjectMetadataOwners(
  db: DatabaseSync,
): void {
  if (!db.isTransaction)
    throw new Error("plugin_project_metadata_owner_transaction_required");
  if (hasSqlitePluginProjectMetadataOwnerSchema(db)) return;
  assertSqliteParent(db);
  migrateSqliteAssetOwnedSchema(db, definition);
  hasSqlitePluginProjectMetadataOwnerSchema(db);
}

async function assertPostgresParent(
  client: PoolClient,
  schema: string,
): Promise<void> {
  const parents = (
    await client.query<{ relkind: string }>(
      "SELECT c.relkind FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='creative_projects'",
      [schema],
    )
  ).rows;
  if (parents.length !== 1 || parents[0]!.relkind !== "r") invalid();
  await client.query(
    `SELECT tenant_id,space_id,project_id,owner_principal_id FROM ${creativeProjectSchemaName(schema)}.creative_projects LIMIT 0`,
  );
}

export async function hasPostgresPluginProjectMetadataOwnerSchema(
  client: PoolClient,
  schema: string,
): Promise<boolean> {
  creativeProjectSchemaName(schema);
  // The reusable catalog snapshot only includes ordinary tables. Detect views and
  // other partial named relations first so an invalid schema never becomes absent.
  const found = (
    await client.query<{ relname: string; relkind: string }>(
      "SELECT c.relname,c.relkind FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=ANY($2::text[])",
      [schema, tables],
    )
  ).rows;
  if (found.some((row) => row.relkind !== "r")) invalid();
  const present = await assertPostgresAssetOwnedSchema(
    client,
    schema,
    definition,
    true,
  );
  if (present) await assertPostgresParent(client, schema);
  return present;
}

/** Explicit caller transaction, original schema and migration lock; never a Pool acquisition. */
export async function migratePostgresPluginProjectMetadataOwners(
  client: PoolClient,
  schema: string,
): Promise<void> {
  creativeProjectSchemaName(schema);
  const first = (
    await client.query<{ id: string }>(
      "SELECT pg_current_xact_id()::text AS id",
    )
  ).rows[0]?.id;
  const second = (
    await client.query<{ id: string | null }>(
      "SELECT pg_current_xact_id_if_assigned()::text AS id",
    )
  ).rows[0]?.id;
  if (first === undefined || first !== second)
    throw new Error("plugin_project_metadata_owner_transaction_required");
  if (await hasPostgresPluginProjectMetadataOwnerSchema(client, schema)) return;
  await assertPostgresParent(client, schema);
  await migratePostgresAssetOwnedSchema(client, schema, definition);
  await hasPostgresPluginProjectMetadataOwnerSchema(client, schema);
}
