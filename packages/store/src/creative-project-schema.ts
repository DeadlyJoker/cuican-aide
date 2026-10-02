import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";

export const CREATIVE_PROJECT_SCHEMA_VERSION = 1;

export function creativeProjectSchemaName(value: string): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_]{0,62}$/u.test(value))
    throw new Error("creative_project_schema_invalid");
  return `"${value}"`;
}

const immutableTables = [
  "creative_project_briefs",
  "creative_concept_revisions",
  "creative_project_mutation_receipts",
] as const;
const mutableTables = ["creative_projects", "creative_concept_assets"] as const;

export function creativeProjectSchemaSql(
  input: { dialect: "sqlite" } | { dialect: "postgres"; schema: string },
): string {
  const postgres = input.dialect === "postgres";
  const prefix = postgres ? `${creativeProjectSchemaName(input.schema)}.` : "";
  const json = postgres ? "JSONB" : "TEXT";
  const integer = postgres ? "BIGINT" : "INTEGER";
  const strict = postgres ? "" : " STRICT";
  const ordinal = postgres ? ' COLLATE "C"' : " COLLATE BINARY";
  const jsonValue = (column: string, key: string) =>
    postgres ? `(${column}->>'${key}')` : `json_extract(${column}, '$.${key}')`;
  const jsonCheck = (column: string, max: number) =>
    postgres
      ? `jsonb_typeof(${column})='object' AND octet_length(${column}::text)<=${max}`
      : `json_valid(${column}) AND json_type(${column})='object' AND length(CAST(${column} AS BLOB))<=${max}`;
  const match = (column: string, fields: Record<string, string>) =>
    Object.entries(fields)
      .map(([key, sql]) => {
        const value = jsonValue(column, key);
        return `${value} IS NOT NULL AND CAST(${value} AS TEXT)=CAST(${sql} AS TEXT)`;
      })
      .join(" AND ");
  const scope =
    "tenant_id TEXT NOT NULL, space_id TEXT NOT NULL, project_id TEXT NOT NULL";
  const scopeFields = {
    tenantId: "tenant_id",
    spaceId: "space_id",
    projectId: "project_id",
  };
  const safeRevision = (column: string, minimum = 1) =>
    `${column}>=${minimum} AND ${column}<=9007199254740991`;
  return `
    CREATE TABLE IF NOT EXISTS ${prefix}creative_projects (
      ${scope}, owner_principal_id TEXT NOT NULL,
      revision ${integer} NOT NULL CHECK (${safeRevision("revision")}),
      state TEXT NOT NULL CHECK (state IN ('active','archived')),
      latest_brief_revision ${integer} NOT NULL CHECK (${safeRevision("latest_brief_revision", 0)} AND latest_brief_revision<revision),
      updated_at TEXT NOT NULL,
      record_json ${json} NOT NULL CHECK (${jsonCheck("record_json", 8192)} AND ${match("record_json", { ...scopeFields, ownerPrincipalId: "owner_principal_id", revision: "revision", state: "state", latestBriefRevision: "latest_brief_revision", updatedAt: "updated_at" })}),
      PRIMARY KEY (tenant_id,space_id,project_id),
      UNIQUE (tenant_id,space_id,project_id,owner_principal_id)
    )${strict};
    CREATE INDEX IF NOT EXISTS creative_projects_owner_page ON ${prefix}creative_projects
      (tenant_id,space_id,owner_principal_id,updated_at DESC,project_id${ordinal} DESC);
    CREATE TABLE IF NOT EXISTS ${prefix}creative_project_briefs (
      ${scope}, brief_revision ${integer} NOT NULL CHECK (${safeRevision("brief_revision")}),
      content_digest TEXT NOT NULL,
      record_json ${json} NOT NULL CHECK (${jsonCheck("record_json", 32768)} AND ${match("record_json", { ...scopeFields, briefRevision: "brief_revision", contentDigest: "content_digest" })}),
      PRIMARY KEY (tenant_id,space_id,project_id,brief_revision),
      UNIQUE (tenant_id,space_id,project_id,brief_revision,content_digest),
      FOREIGN KEY (tenant_id,space_id,project_id) REFERENCES ${prefix}creative_projects (tenant_id,space_id,project_id) ON DELETE RESTRICT
    )${strict};
    CREATE TABLE IF NOT EXISTS ${prefix}creative_concept_assets (
      ${scope}, asset_id TEXT NOT NULL,
      revision ${integer} NOT NULL CHECK (${safeRevision("revision")}),
      latest_asset_revision ${integer} NOT NULL CHECK (${safeRevision("latest_asset_revision")} AND latest_asset_revision<=revision),
      record_json ${json} NOT NULL CHECK (${jsonCheck("record_json", 8192)} AND ${match("record_json", { ...scopeFields, assetId: "asset_id", revision: "revision", latestAssetRevision: "latest_asset_revision" })}),
      PRIMARY KEY (tenant_id,space_id,project_id,asset_id),
      FOREIGN KEY (tenant_id,space_id,project_id) REFERENCES ${prefix}creative_projects (tenant_id,space_id,project_id) ON DELETE RESTRICT
    )${strict};
    CREATE TABLE IF NOT EXISTS ${prefix}creative_concept_revisions (
      ${scope}, asset_id TEXT NOT NULL,
      asset_revision ${integer} NOT NULL CHECK (${safeRevision("asset_revision")}),
      brief_revision ${integer} NOT NULL CHECK (${safeRevision("brief_revision")}),
      brief_content_digest TEXT NOT NULL, content_digest TEXT NOT NULL,
      record_json ${json} NOT NULL CHECK (${jsonCheck("record_json", 16384)} AND ${match("record_json", { ...scopeFields, assetId: "asset_id", assetRevision: "asset_revision", briefRevision: "brief_revision", briefContentDigest: "brief_content_digest", contentDigest: "content_digest" })}),
      PRIMARY KEY (tenant_id,space_id,project_id,asset_id,asset_revision),
      FOREIGN KEY (tenant_id,space_id,project_id,asset_id) REFERENCES ${prefix}creative_concept_assets (tenant_id,space_id,project_id,asset_id) ON DELETE RESTRICT,
      FOREIGN KEY (tenant_id,space_id,project_id,brief_revision,brief_content_digest) REFERENCES ${prefix}creative_project_briefs (tenant_id,space_id,project_id,brief_revision,content_digest) ON DELETE RESTRICT
    )${strict};
    CREATE TABLE IF NOT EXISTS ${prefix}creative_project_mutation_receipts (
      tenant_id TEXT NOT NULL, space_id TEXT NOT NULL, principal_id TEXT NOT NULL,
      actor_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('create-project','rename-project','set-project-state','append-brief','create-concept','append-concept')),
      idempotency_key TEXT NOT NULL, request_digest TEXT NOT NULL, project_id TEXT NOT NULL,
      result_json ${json} NOT NULL CHECK (${jsonCheck("result_json", 65536)}),
      PRIMARY KEY (tenant_id,space_id,principal_id,actor_id,kind,idempotency_key),
      FOREIGN KEY (tenant_id,space_id,project_id,principal_id) REFERENCES ${prefix}creative_projects (tenant_id,space_id,project_id,owner_principal_id) ON DELETE RESTRICT
    )${strict};
  `;
}

function assertVersion(rows: readonly { id: unknown; version: unknown }[]) {
  if (
    rows.length !== 1 ||
    rows[0]!.id !== 1 ||
    rows[0]!.version !== CREATIVE_PROJECT_SCHEMA_VERSION
  )
    throw new Error("creative_project_schema_version_unsupported");
}

/** Caller owns the migration transaction. Existing core/extension/credit versions are untouched. */
export function migrateSqliteCreativeProjects(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS creative_project_schema_version (
      id INTEGER PRIMARY KEY CHECK (id=1), version INTEGER NOT NULL
    ) STRICT;
    INSERT INTO creative_project_schema_version VALUES(1,1) ON CONFLICT(id) DO NOTHING;
  `);
  assertVersion(
    database
      .prepare("SELECT id,version FROM creative_project_schema_version LIMIT 2")
      .all() as { id: unknown; version: unknown }[],
  );
  database.exec(creativeProjectSchemaSql({ dialect: "sqlite" }));
  for (const table of immutableTables) {
    for (const action of ["UPDATE", "DELETE"] as const)
      database.exec(`
      CREATE TRIGGER IF NOT EXISTS ${table}_no_${action.toLowerCase()}
        BEFORE ${action} ON ${table}
        BEGIN SELECT RAISE(ABORT,'creative_project_history_immutable'); END;
    `);
  }
  for (const table of mutableTables) {
    database.exec(`
      CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table}
        BEGIN SELECT RAISE(ABORT,'creative_project_identity_immutable'); END;
      CREATE TRIGGER IF NOT EXISTS ${table}_identity_immutable BEFORE UPDATE ON ${table}
        WHEN ${immutableIdentityPredicate(table, "sqlite")}
        BEGIN SELECT RAISE(ABORT,'creative_project_identity_immutable'); END;
    `);
  }
  for (const statement of schemaReads("")) database.prepare(statement).all();
  for (const table of [...immutableTables, ...mutableTables]) {
    const count = database
      .prepare(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND tbl_name=? AND name IN (?,?)",
      )
      .get(
        table,
        immutableTables.includes(table as (typeof immutableTables)[number])
          ? `${table}_no_update`
          : `${table}_identity_immutable`,
        `${table}_no_delete`,
      );
    if (count?.n !== 2) throw new Error("creative_project_schema_incomplete");
  }
}

/** Caller owns BEGIN/COMMIT and the independent migration advisory lock. */
export async function migratePostgresCreativeProjects(
  client: PoolClient,
  schema: string,
): Promise<void> {
  const prefix = `${creativeProjectSchemaName(schema)}.`;
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${prefix}creative_project_schema_version (
      id INTEGER PRIMARY KEY CHECK (id=1), version INTEGER NOT NULL
    );
    INSERT INTO ${prefix}creative_project_schema_version VALUES(1,1) ON CONFLICT(id) DO NOTHING;
  `);
  const version = await client.query<{ id: unknown; version: unknown }>(
    `SELECT id,version FROM ${prefix}creative_project_schema_version LIMIT 2`,
  );
  assertVersion(version.rows);
  await client.query(creativeProjectSchemaSql({ dialect: "postgres", schema }));
  await client.query(`
    CREATE OR REPLACE FUNCTION ${prefix}creative_project_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'creative_project_history_immutable'; END;
    $$;
  `);
  for (const table of immutableTables)
    await client.query(`
    CREATE OR REPLACE TRIGGER ${table}_no_update_or_delete BEFORE UPDATE OR DELETE ON ${prefix}${table}
      FOR EACH ROW EXECUTE FUNCTION ${prefix}creative_project_history_immutable();
  `);
  for (const table of mutableTables)
    await client.query(`
    CREATE OR REPLACE FUNCTION ${prefix}${table}_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP='DELETE' THEN RAISE EXCEPTION 'creative_project_identity_immutable'; END IF;
        IF ${immutableIdentityPredicate(table, "postgres")} THEN RAISE EXCEPTION 'creative_project_identity_immutable'; END IF;
        RETURN NEW;
      END;
    $$;
    CREATE OR REPLACE TRIGGER ${table}_identity_immutable BEFORE UPDATE OR DELETE ON ${prefix}${table}
      FOR EACH ROW EXECUTE FUNCTION ${prefix}${table}_identity_immutable();
  `);
  for (const statement of schemaReads(prefix)) await client.query(statement);
}

function immutableIdentityPredicate(
  table: (typeof mutableTables)[number],
  dialect: "sqlite" | "postgres",
) {
  const distinct = dialect === "postgres" ? "IS DISTINCT FROM" : "IS NOT";
  const columns = [
    "tenant_id",
    "space_id",
    "project_id",
    table === "creative_projects" ? "owner_principal_id" : "asset_id",
  ];
  const fields = [
    "schemaVersion",
    "tenantId",
    "spaceId",
    "projectId",
    "createdByActorId",
    "createdAt",
    ...(table === "creative_projects"
      ? ["ownerPrincipalId", "kind"]
      : ["assetId"]),
  ];
  const json = (side: string, field: string) =>
    dialect === "postgres"
      ? `(${side}.record_json->>'${field}')`
      : `json_extract(${side}.record_json,'$.${field}')`;
  return [
    ...columns.map((column) => `NEW.${column} ${distinct} OLD.${column}`),
    ...fields.map(
      (field) => `${json("NEW", field)} ${distinct} ${json("OLD", field)}`,
    ),
  ].join(" OR ");
}

function schemaReads(prefix: string): readonly string[] {
  return [
    `SELECT tenant_id,space_id,project_id,owner_principal_id,revision,state,latest_brief_revision,updated_at,record_json FROM ${prefix}creative_projects LIMIT 0`,
    `SELECT tenant_id,space_id,project_id,brief_revision,content_digest,record_json FROM ${prefix}creative_project_briefs LIMIT 0`,
    `SELECT tenant_id,space_id,project_id,asset_id,revision,latest_asset_revision,record_json FROM ${prefix}creative_concept_assets LIMIT 0`,
    `SELECT tenant_id,space_id,project_id,asset_id,asset_revision,brief_revision,brief_content_digest,content_digest,record_json FROM ${prefix}creative_concept_revisions LIMIT 0`,
    `SELECT tenant_id,space_id,principal_id,actor_id,kind,idempotency_key,request_digest,project_id,result_json FROM ${prefix}creative_project_mutation_receipts LIMIT 0`,
  ];
}
