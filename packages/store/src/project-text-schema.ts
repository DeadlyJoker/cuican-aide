import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import { creativeProjectSchemaName } from "./creative-project-schema.ts";

export const PROJECT_TEXT_SCHEMA_VERSION = 1;
const historyTables = [
  "project_text_revisions",
  "project_text_mutation_receipts",
] as const;

/** Independent tables; the original project schema and receipt namespace stay unchanged. */
export function projectTextSchemaSql(
  input: { dialect: "sqlite" } | { dialect: "postgres"; schema: string },
): string {
  const pg = input.dialect === "postgres";
  const p = pg ? `${creativeProjectSchemaName(input.schema)}.` : "";
  const json = pg ? "JSONB" : "TEXT";
  const integer = pg ? "BIGINT" : "INTEGER";
  const strict = pg ? "" : " STRICT";
  const revision = (column: string, minimum = 1) =>
    `${column}>=${minimum} AND ${column}<=9007199254740991`;
  const object = (column: string, max: number) =>
    pg
      ? `jsonb_typeof(${column})='object' AND octet_length(${column}::text)<=${max}`
      : `json_valid(${column}) AND json_type(${column})='object' AND length(CAST(${column} AS BLOB))<=${max}`;
  const value = (key: string) =>
    pg ? `(record_json->>'${key}')` : `json_extract(record_json,'$.${key}')`;
  const match = (fields: Record<string, string>) =>
    Object.entries(fields)
      .map(
        ([key, column]) =>
          `${value(key)} IS NOT NULL AND CAST(${value(key)} AS TEXT)=CAST(${column} AS TEXT)`,
      )
      .join(" AND ");
  const scope =
    "tenant_id TEXT NOT NULL,space_id TEXT NOT NULL,project_id TEXT NOT NULL";
  const scopeFields = {
    tenantId: "tenant_id",
    spaceId: "space_id",
    projectId: "project_id",
    artifactId: "artifact_id",
    kind: "kind",
  };
  const episode = `${value("episodeId")} IS NULL AND kind='outline' AND episode_id='' OR ${value("episodeId")} IS NOT NULL AND kind='script' AND ${value("episodeId")}=episode_id AND length(episode_id)>0`;
  const selected = `(${value("selectedContentRevision")} IS NULL AND selected_content_revision IS NULL) OR (${value("selectedContentRevision")} IS NOT NULL AND selected_content_revision IS NOT NULL AND CAST(${value("selectedContentRevision")} AS TEXT)=CAST(selected_content_revision AS TEXT))`;
  const locked = pg
    ? `${value("locked")}=CASE locked WHEN 1 THEN 'true' ELSE 'false' END`
    : `json_type(record_json,'$.locked') IN ('true','false') AND ${value("locked")}=locked`;
  return `
    CREATE TABLE IF NOT EXISTS ${p}project_text_artifacts (
      ${scope},artifact_id TEXT NOT NULL,owner_principal_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('outline','script')),episode_id TEXT NOT NULL,
      revision ${integer} NOT NULL CHECK(${revision("revision")}),
      latest_content_revision ${integer} NOT NULL CHECK(${revision("latest_content_revision")} AND latest_content_revision<=revision),
      selected_content_revision ${integer} CHECK(${revision("selected_content_revision")} AND selected_content_revision<=latest_content_revision),
      locked INTEGER NOT NULL CHECK(locked IN (0,1) AND (locked=0 OR selected_content_revision IS NOT NULL)),
      record_json ${json} NOT NULL CHECK(${object("record_json", 8192)} AND ${match({ ...scopeFields, ownerPrincipalId: "owner_principal_id", revision: "revision", latestContentRevision: "latest_content_revision" })} AND (${episode}) AND (${selected}) AND (${locked})),
      PRIMARY KEY(tenant_id,space_id,project_id,artifact_id),
      UNIQUE(tenant_id,space_id,project_id,kind,episode_id),
      FOREIGN KEY(tenant_id,space_id,project_id,owner_principal_id) REFERENCES ${p}creative_projects(tenant_id,space_id,project_id,owner_principal_id) ON DELETE RESTRICT
    )${strict};
    CREATE TABLE IF NOT EXISTS ${p}project_text_revisions (
      ${scope},artifact_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('outline','script')),episode_id TEXT NOT NULL,
      content_revision ${integer} NOT NULL CHECK(${revision("content_revision")}),
      content_digest TEXT NOT NULL,brief_revision ${integer} NOT NULL CHECK(${revision("brief_revision")}),brief_content_digest TEXT NOT NULL,
      outline_artifact_id TEXT,outline_content_revision ${integer},outline_content_digest TEXT,
      record_json ${json} NOT NULL CHECK(${object("record_json", 262144)} AND ${match({ ...scopeFields, contentRevision: "content_revision", contentDigest: "content_digest" })} AND (${episode})),
      CHECK((outline_artifact_id IS NULL AND outline_content_revision IS NULL AND outline_content_digest IS NULL) OR (kind='script' AND outline_artifact_id IS NOT NULL AND outline_content_revision IS NOT NULL AND outline_content_digest IS NOT NULL AND ${revision("outline_content_revision")})),
      PRIMARY KEY(tenant_id,space_id,project_id,artifact_id,content_revision),
      UNIQUE(tenant_id,space_id,project_id,artifact_id,content_revision,content_digest),
      FOREIGN KEY(tenant_id,space_id,project_id,artifact_id) REFERENCES ${p}project_text_artifacts(tenant_id,space_id,project_id,artifact_id) ON DELETE RESTRICT,
      FOREIGN KEY(tenant_id,space_id,project_id,brief_revision,brief_content_digest) REFERENCES ${p}creative_project_briefs(tenant_id,space_id,project_id,brief_revision,content_digest) ON DELETE RESTRICT,
      FOREIGN KEY(tenant_id,space_id,project_id,outline_artifact_id,outline_content_revision,outline_content_digest) REFERENCES ${p}project_text_revisions(tenant_id,space_id,project_id,artifact_id,content_revision,content_digest) ON DELETE RESTRICT
    )${strict};
    CREATE TABLE IF NOT EXISTS ${p}project_text_mutation_receipts (
      tenant_id TEXT NOT NULL,space_id TEXT NOT NULL,principal_id TEXT NOT NULL,actor_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('save-outline','save-script','select-revision','set-lock')),
      idempotency_key TEXT NOT NULL,request_digest TEXT NOT NULL,project_id TEXT NOT NULL,
      result_json ${json} NOT NULL CHECK(${object("result_json", 524288)}),
      PRIMARY KEY(tenant_id,space_id,principal_id,actor_id,kind,idempotency_key),
      FOREIGN KEY(tenant_id,space_id,project_id,principal_id) REFERENCES ${p}creative_projects(tenant_id,space_id,project_id,owner_principal_id) ON DELETE RESTRICT
    )${strict};
  `;
}

function assertVersion(rows: readonly { id: unknown; version: unknown }[]) {
  if (
    rows.length !== 1 ||
    rows[0]?.id !== 1 ||
    rows[0]?.version !== PROJECT_TEXT_SCHEMA_VERSION
  )
    throw new Error("project_text_schema_version_unsupported");
}

function identityChanged(pg: boolean): string {
  const distinct = pg ? "IS DISTINCT FROM" : "IS NOT";
  const fields = [
    "tenant_id",
    "space_id",
    "project_id",
    "artifact_id",
    "owner_principal_id",
    "kind",
    "episode_id",
  ];
  const json = (side: string, key: string) =>
    pg
      ? `(${side}.record_json->>'${key}')`
      : `json_extract(${side}.record_json,'$.${key}')`;
  return [
    ...fields.map((field) => `NEW.${field} ${distinct} OLD.${field}`),
    ...["schemaVersion", "createdByActorId", "createdAt"].map(
      (field) => `${json("NEW", field)} ${distinct} ${json("OLD", field)}`,
    ),
  ].join(" OR ");
}

/** Caller owns the explicit migration transaction and the real parent connection. */
export function migrateSqliteProjectText(database: DatabaseSync): void {
  database
    .prepare(
      "SELECT tenant_id,space_id,project_id,owner_principal_id FROM creative_projects LIMIT 0",
    )
    .all();
  database.exec(`CREATE TABLE IF NOT EXISTS project_text_schema_version(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL) STRICT;
    INSERT INTO project_text_schema_version VALUES(1,1) ON CONFLICT(id) DO NOTHING;`);
  assertVersion(
    database
      .prepare("SELECT id,version FROM project_text_schema_version LIMIT 2")
      .all() as { id: unknown; version: unknown }[],
  );
  database.exec(projectTextSchemaSql({ dialect: "sqlite" }));
  for (const table of historyTables)
    for (const action of ["UPDATE", "DELETE"] as const)
      database.exec(
        `CREATE TRIGGER IF NOT EXISTS ${table}_no_${action.toLowerCase()} BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT,'project_text_history_immutable'); END;`,
      );
  database.exec(`CREATE TRIGGER IF NOT EXISTS project_text_artifacts_no_delete BEFORE DELETE ON project_text_artifacts BEGIN SELECT RAISE(ABORT,'project_text_identity_immutable'); END;
    CREATE TRIGGER IF NOT EXISTS project_text_artifacts_identity_immutable BEFORE UPDATE ON project_text_artifacts WHEN ${identityChanged(false)} BEGIN SELECT RAISE(ABORT,'project_text_identity_immutable'); END;`);
  for (const sql of schemaReads("")) database.prepare(sql).all();
}

/** Caller owns BEGIN/COMMIT and the independent text migration lock. */
export async function migratePostgresProjectText(
  client: PoolClient,
  schema: string,
): Promise<void> {
  const p = `${creativeProjectSchemaName(schema)}.`;
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    JSON.stringify(["project-text-schema", schema]),
  ]);
  await client.query(
    `SELECT tenant_id,space_id,project_id,owner_principal_id FROM ${p}creative_projects LIMIT 0`,
  );
  await client.query(`CREATE TABLE IF NOT EXISTS ${p}project_text_schema_version(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL);
    INSERT INTO ${p}project_text_schema_version VALUES(1,1) ON CONFLICT(id) DO NOTHING;`);
  assertVersion(
    (
      await client.query<{ id: unknown; version: unknown }>(
        `SELECT id,version FROM ${p}project_text_schema_version LIMIT 2`,
      )
    ).rows,
  );
  await client.query(projectTextSchemaSql({ dialect: "postgres", schema }));
  await client.query(
    `CREATE OR REPLACE FUNCTION ${p}project_text_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'project_text_history_immutable'; END; $$;`,
  );
  for (const table of historyTables)
    await client.query(
      `CREATE OR REPLACE TRIGGER ${table}_no_update_or_delete BEFORE UPDATE OR DELETE ON ${p}${table} FOR EACH ROW EXECUTE FUNCTION ${p}project_text_history_immutable();`,
    );
  await client.query(`CREATE OR REPLACE FUNCTION ${p}project_text_artifact_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF TG_OP='DELETE' OR ${identityChanged(true)} THEN RAISE EXCEPTION 'project_text_identity_immutable'; END IF; RETURN NEW; END; $$;
    CREATE OR REPLACE TRIGGER project_text_artifacts_identity_immutable BEFORE UPDATE OR DELETE ON ${p}project_text_artifacts FOR EACH ROW EXECUTE FUNCTION ${p}project_text_artifact_identity_immutable();`);
  for (const sql of schemaReads(p)) await client.query(sql);
}

function schemaReads(p: string): readonly string[] {
  return [
    `SELECT tenant_id,space_id,project_id,artifact_id,owner_principal_id,kind,episode_id,revision,latest_content_revision,selected_content_revision,locked,record_json FROM ${p}project_text_artifacts LIMIT 0`,
    `SELECT tenant_id,space_id,project_id,artifact_id,kind,episode_id,content_revision,content_digest,brief_revision,brief_content_digest,outline_artifact_id,outline_content_revision,outline_content_digest,record_json FROM ${p}project_text_revisions LIMIT 0`,
    `SELECT tenant_id,space_id,principal_id,actor_id,kind,idempotency_key,request_digest,project_id,result_json FROM ${p}project_text_mutation_receipts LIMIT 0`,
  ];
}
