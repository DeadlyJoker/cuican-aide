import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import { creativeProjectSchemaName } from "./creative-project-schema.ts";

export const PROJECT_FOUNDATION_SCHEMA_VERSION = 1;

const immutableTables = [
  "project_sources",
  "project_source_chunks",
  "project_source_chapters",
  "project_proposals",
  "project_foundation_mutation_receipts",
] as const;
const tables = [
  "project_foundation_schema_version",
  "project_foundations",
  ...immutableTables,
] as const;
const reads = [
  "SELECT id,version FROM project_foundation_schema_version LIMIT 0",
  "SELECT tenant_id,space_id,project_id,owner_principal_id,origin,revision,parameters_revision,record_json FROM project_foundations LIMIT 0",
  "SELECT tenant_id,space_id,project_id,source_revision,content_digest,file_digest,character_length,record_json FROM project_sources LIMIT 0",
  "SELECT tenant_id,space_id,project_id,source_revision,chunk_index,start_offset,character_length,content,content_digest FROM project_source_chunks LIMIT 0",
  "SELECT tenant_id,space_id,project_id,source_revision,chapter_id,start_offset,end_offset,record_json FROM project_source_chapters LIMIT 0",
  "SELECT tenant_id,space_id,project_id,proposal_revision,content_digest,record_json FROM project_proposals LIMIT 0",
  "SELECT tenant_id,space_id,principal_id,actor_id,kind,idempotency_key,request_digest,project_id,result_json FROM project_foundation_mutation_receipts LIMIT 0",
] as const;

/** New records share the original project identity, never its v0 JSON or version table. */
export function projectFoundationSchemaSql(
  input: { dialect: "sqlite" } | { dialect: "postgres"; schema: string },
): string {
  const pg = input.dialect === "postgres";
  const p = pg ? `${creativeProjectSchemaName(input.schema)}.` : "";
  const json = pg ? "JSONB" : "TEXT";
  const integer = pg ? "BIGINT" : "INTEGER";
  const strict = pg ? "" : " STRICT";
  const scope =
    "tenant_id TEXT NOT NULL,space_id TEXT NOT NULL,project_id TEXT NOT NULL";
  const scopeKey = "tenant_id,space_id,project_id";
  const revision = (name: string, minimum = 1) =>
    `${name}>=${minimum} AND ${name}<=9007199254740991`;
  const byteLength = (name: string) =>
    pg ? `octet_length(${name})` : `length(CAST(${name} AS BLOB))`;
  const value = (key: string) =>
    pg ? `(record_json->>'${key}')` : `json_extract(record_json,'$.${key}')`;
  const match = (fields: Record<string, string>) =>
    Object.entries(fields)
      .map(
        ([key, column]) =>
          `${value(key)} IS NOT NULL AND CAST(${value(key)} AS TEXT)=CAST(${column} AS TEXT)`,
      )
      .join(" AND ");
  const boundedJson = (max: number) =>
    pg
      ? `jsonb_typeof(record_json)='object' AND octet_length(record_json::text)<=${max}`
      : `json_valid(record_json) AND json_type(record_json)='object' AND ${byteLength("record_json")}<=${max}`;
  const scopeFields = {
    tenantId: "tenant_id",
    spaceId: "space_id",
    projectId: "project_id",
  };
  const parent = `FOREIGN KEY(${scopeKey}) REFERENCES ${p}creative_projects(${scopeKey}) ON DELETE RESTRICT`;
  return `
    CREATE TABLE IF NOT EXISTS ${p}project_foundation_schema_version (
      id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL
    )${strict};
    INSERT INTO ${p}project_foundation_schema_version VALUES(1,1) ON CONFLICT(id) DO NOTHING;
    CREATE TABLE IF NOT EXISTS ${p}project_foundations (
      ${scope},owner_principal_id TEXT NOT NULL,
      origin TEXT NOT NULL CHECK(origin IN ('creative','novel')),
      revision ${integer} NOT NULL CHECK(${revision("revision")}),
      parameters_revision ${integer} NOT NULL CHECK(${revision("parameters_revision")} AND parameters_revision<=revision),
      record_json ${json} NOT NULL CHECK(${boundedJson(32768)} AND ${match({ ...scopeFields, ownerPrincipalId: "owner_principal_id", origin: "origin", revision: "revision", parametersRevision: "parameters_revision" })}),
      PRIMARY KEY(${scopeKey}),
      FOREIGN KEY(${scopeKey},owner_principal_id) REFERENCES ${p}creative_projects(${scopeKey},owner_principal_id) ON DELETE RESTRICT
    )${strict};
    CREATE TABLE IF NOT EXISTS ${p}project_sources (
      ${scope},source_revision ${integer} NOT NULL CHECK(${revision("source_revision")}),
      content_digest TEXT NOT NULL,file_digest TEXT NOT NULL,
      character_length ${integer} NOT NULL CHECK(${revision("character_length")}),
      record_json ${json} NOT NULL CHECK(${boundedJson(8192)} AND ${match({ ...scopeFields, revision: "source_revision", digest: "content_digest", fileDigest: "file_digest", characterLength: "character_length" })}),
      PRIMARY KEY(${scopeKey},source_revision),
      UNIQUE(${scopeKey},source_revision,content_digest),${parent}
    )${strict};
    CREATE TABLE IF NOT EXISTS ${p}project_source_chunks (
      ${scope},source_revision ${integer} NOT NULL CHECK(${revision("source_revision")}),
      chunk_index ${integer} NOT NULL CHECK(${revision("chunk_index", 0)}),
      start_offset ${integer} NOT NULL CHECK(${revision("start_offset", 0)}),
      character_length ${integer} NOT NULL CHECK(character_length>=1 AND character_length<=4096),
      content TEXT NOT NULL CHECK(${byteLength("content")}>=1 AND ${byteLength("content")}<=4096),
      content_digest TEXT NOT NULL,
      PRIMARY KEY(${scopeKey},source_revision,chunk_index),
      UNIQUE(${scopeKey},source_revision,start_offset),
      FOREIGN KEY(${scopeKey},source_revision) REFERENCES ${p}project_sources(${scopeKey},source_revision) ON DELETE RESTRICT
    )${strict};
    CREATE INDEX IF NOT EXISTS project_source_chunk_window ON ${p}project_source_chunks
      (${scopeKey},source_revision,start_offset);
    CREATE TABLE IF NOT EXISTS ${p}project_source_chapters (
      ${scope},source_revision ${integer} NOT NULL CHECK(${revision("source_revision")}),
      chapter_id TEXT NOT NULL,start_offset ${integer} NOT NULL CHECK(${revision("start_offset", 0)}),
      end_offset ${integer} NOT NULL CHECK(${revision("end_offset")} AND end_offset>start_offset),
      record_json ${json} NOT NULL CHECK(${boundedJson(4096)} AND ${match({ ...scopeFields, sourceRevision: "source_revision", chapterId: "chapter_id", startOffset: "start_offset", endOffset: "end_offset" })}),
      PRIMARY KEY(${scopeKey},source_revision,chapter_id),
      FOREIGN KEY(${scopeKey},source_revision) REFERENCES ${p}project_sources(${scopeKey},source_revision) ON DELETE RESTRICT
    )${strict};
    CREATE INDEX IF NOT EXISTS project_source_chapter_window ON ${p}project_source_chapters
      (${scopeKey},source_revision,start_offset);
    CREATE TABLE IF NOT EXISTS ${p}project_proposals (
      ${scope},proposal_revision ${integer} NOT NULL CHECK(${revision("proposal_revision")}),
      content_digest TEXT NOT NULL,
      record_json ${json} NOT NULL CHECK(${boundedJson(32768)} AND ${match({ ...scopeFields, revision: "proposal_revision", contentDigest: "content_digest" })}),
      PRIMARY KEY(${scopeKey},proposal_revision),
      UNIQUE(${scopeKey},proposal_revision,content_digest),${parent}
    )${strict};
    CREATE TABLE IF NOT EXISTS ${p}project_foundation_mutation_receipts (
      tenant_id TEXT NOT NULL,space_id TEXT NOT NULL,principal_id TEXT NOT NULL,actor_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('create-project','update-parameters','append-source','save-proposal','confirm-proposal','choose-direct-script')),
      idempotency_key TEXT NOT NULL,request_digest TEXT NOT NULL,project_id TEXT NOT NULL,
      result_json ${json} NOT NULL CHECK(${pg ? "jsonb_typeof(result_json)='object' AND octet_length(result_json::text)<=65536" : "json_valid(result_json) AND json_type(result_json)='object' AND length(CAST(result_json AS BLOB))<=65536"}),
      PRIMARY KEY(tenant_id,space_id,principal_id,actor_id,kind,idempotency_key),
      FOREIGN KEY(tenant_id,space_id,project_id,principal_id) REFERENCES ${p}creative_projects(${scopeKey},owner_principal_id) ON DELETE RESTRICT
    )${strict};
  `;
}

function unsupported(): never {
  throw new Error("project_foundation_schema_version_unsupported");
}
function incomplete(): never {
  throw new Error("project_foundation_schema_incomplete");
}
function version(rows: readonly { id: unknown; version: unknown }[]) {
  if (
    rows.length !== 1 ||
    Number(rows[0]!.id) !== 1 ||
    Number(rows[0]!.version) !== PROJECT_FOUNDATION_SCHEMA_VERSION
  )
    unsupported();
}

/** Read only. An absent extension is distinct from a corrupt/partial installed schema. */
export function assertSqliteProjectFoundationSchema(
  database: DatabaseSync,
): boolean {
  const names = database
    .prepare(
      `SELECT name,type FROM sqlite_master WHERE name IN (${tables.map(() => "?").join(",")})`,
    )
    .all(...tables);
  if (names.length === 0) return false;
  if (
    names.length !== tables.length ||
    names.some((row) => row.type !== "table")
  )
    incomplete();
  version(
    database
      .prepare(
        "SELECT id,version FROM project_foundation_schema_version LIMIT 2",
      )
      .all() as { id: unknown; version: unknown }[],
  );
  try {
    for (const sql of reads) database.prepare(sql).all();
    for (const table of immutableTables) {
      for (const action of ["update", "delete"] as const) {
        const row = database
          .prepare("SELECT type,tbl_name FROM sqlite_master WHERE name=?")
          .get(`${table}_no_${action}`);
        if (row?.type !== "trigger" || row.tbl_name !== table) incomplete();
      }
    }
    for (const trigger of [
      "project_foundations_identity_immutable",
      "project_foundations_no_delete",
    ]) {
      const row = database
        .prepare("SELECT type,tbl_name FROM sqlite_master WHERE name=?")
        .get(trigger);
      if (row?.type !== "trigger" || row.tbl_name !== "project_foundations")
        incomplete();
    }
    for (const [name, table] of [
      ["project_source_chunk_window", "project_source_chunks"],
      ["project_source_chapter_window", "project_source_chapters"],
    ]) {
      const index = database
        .prepare("SELECT type,tbl_name FROM sqlite_master WHERE name=?")
        .get(name!);
      if (index?.type !== "index" || index.tbl_name !== table) incomplete();
      const columns = database
        .prepare(`PRAGMA index_info('${name}')`)
        .all()
        .map((row) => row.name);
      if (
        columns.join(",") !==
        "tenant_id,space_id,project_id,source_revision,start_offset"
      )
        incomplete();
    }
  } catch {
    incomplete();
  }
  return true;
}

/** Caller owns BEGIN/COMMIT. Reads and construction never invoke migration. */
export function migrateSqliteProjectFoundations(database: DatabaseSync): void {
  if (assertSqliteProjectFoundationSchema(database)) return;
  const parent = database
    .prepare("SELECT type FROM sqlite_master WHERE name='creative_projects'")
    .get();
  if (parent?.type !== "table") incomplete();
  database
    .prepare(
      "SELECT tenant_id,space_id,project_id,owner_principal_id FROM creative_projects LIMIT 0",
    )
    .all();
  database.exec(projectFoundationSchemaSql({ dialect: "sqlite" }));
  for (const table of immutableTables) {
    for (const action of ["UPDATE", "DELETE"] as const)
      database.exec(`
      CREATE TRIGGER ${table}_no_${action.toLowerCase()} BEFORE ${action} ON ${table}
      BEGIN SELECT RAISE(ABORT,'project_foundation_history_immutable'); END;
    `);
  }
  database.exec(`
    CREATE TRIGGER project_foundations_no_delete BEFORE DELETE ON project_foundations
    BEGIN SELECT RAISE(ABORT,'project_foundation_identity_immutable'); END;
    CREATE TRIGGER project_foundations_identity_immutable BEFORE UPDATE ON project_foundations
    WHEN ${identityPredicate("sqlite")}
    BEGIN SELECT RAISE(ABORT,'project_foundation_identity_immutable'); END;
  `);
  assertSqliteProjectFoundationSchema(database);
}

export async function assertPostgresProjectFoundationSchema(
  client: PoolClient,
  schema: string,
): Promise<boolean> {
  const p = `${creativeProjectSchemaName(schema)}.`;
  const names = await client.query<{ relname: string; relkind: string }>(
    "SELECT relname,relkind FROM pg_catalog.pg_class WHERE relnamespace=$1::regnamespace AND relname=ANY($2::text[])",
    [schema, [...tables]],
  );
  if (names.rows.length === 0) return false;
  if (
    names.rows.length !== tables.length ||
    names.rows.some((row) => row.relkind !== "r")
  )
    incomplete();
  version(
    (
      await client.query<{ id: unknown; version: unknown }>(
        `SELECT id,version FROM ${p}project_foundation_schema_version LIMIT 2`,
      )
    ).rows,
  );
  try {
    for (const sql of reads)
      await client.query(sql.replace(/FROM ([a-z_]+)/u, `FROM ${p}$1`));
    for (const table of [...immutableTables, "project_foundations"]) {
      const trigger = await client.query(
        "SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid=$1::regclass AND tgname=$2 AND NOT tgisinternal AND tgenabled='O'",
        [`${p}${table}`, `${table}_immutable`],
      );
      if (trigger.rows.length !== 1) incomplete();
    }
    for (const [name, table] of [
      ["project_source_chunk_window", "project_source_chunks"],
      ["project_source_chapter_window", "project_source_chapters"],
    ]) {
      const index = await client.query(
        "SELECT 1 FROM pg_catalog.pg_index WHERE indexrelid=$1::regclass AND indrelid=$2::regclass AND indisvalid AND indisready AND NOT indisunique AND indpred IS NULL AND indexprs IS NULL",
        [`${p}${name}`, `${p}${table}`],
      );
      if (index.rows.length !== 1) incomplete();
      const columns = await client.query<{ attname: string }>(
        "SELECT a.attname FROM pg_catalog.pg_index i CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum,ordinal) JOIN pg_catalog.pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum WHERE i.indexrelid=$1::regclass ORDER BY k.ordinal",
        [`${p}${name}`],
      );
      if (
        columns.rows.map((row) => row.attname).join(",") !==
        "tenant_id,space_id,project_id,source_revision,start_offset"
      )
        incomplete();
    }
  } catch {
    incomplete();
  }
  return true;
}

/** Caller owns the original connection's migration transaction and advisory lock. */
export async function migratePostgresProjectFoundations(
  client: PoolClient,
  schema: string,
): Promise<void> {
  if (await assertPostgresProjectFoundationSchema(client, schema)) return;
  const p = `${creativeProjectSchemaName(schema)}.`;
  const parent = await client.query<{ relkind: string }>(
    "SELECT relkind FROM pg_catalog.pg_class WHERE relnamespace=$1::regnamespace AND relname='creative_projects'",
    [schema],
  );
  if (parent.rows.length !== 1 || parent.rows[0]!.relkind !== "r") incomplete();
  await client.query(
    `SELECT tenant_id,space_id,project_id,owner_principal_id FROM ${p}creative_projects LIMIT 0`,
  );
  await client.query(
    projectFoundationSchemaSql({ dialect: "postgres", schema }),
  );
  await client.query(`
    CREATE FUNCTION ${p}project_foundation_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'project_foundation_history_immutable'; END;
    $$;
  `);
  for (const table of immutableTables)
    await client.query(`
    CREATE TRIGGER ${table}_immutable BEFORE UPDATE OR DELETE ON ${p}${table}
      FOR EACH ROW EXECUTE FUNCTION ${p}project_foundation_history_immutable();
  `);
  await client.query(`
    CREATE FUNCTION ${p}project_foundation_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP='DELETE' THEN RAISE EXCEPTION 'project_foundation_identity_immutable'; END IF;
        IF ${identityPredicate("postgres")} THEN RAISE EXCEPTION 'project_foundation_identity_immutable'; END IF;
        RETURN NEW;
      END;
    $$;
    CREATE TRIGGER project_foundations_immutable BEFORE UPDATE OR DELETE ON ${p}project_foundations
      FOR EACH ROW EXECUTE FUNCTION ${p}project_foundation_identity_immutable();
  `);
  await assertPostgresProjectFoundationSchema(client, schema);
}

function identityPredicate(dialect: "sqlite" | "postgres") {
  const pg = dialect === "postgres";
  const distinct = pg ? "IS DISTINCT FROM" : "IS NOT";
  const field = (side: string, key: string) =>
    pg
      ? `(${side}.record_json->>'${key}')`
      : `json_extract(${side}.record_json,'$.${key}')`;
  return [
    ...[
      "tenant_id",
      "space_id",
      "project_id",
      "owner_principal_id",
      "origin",
    ].map((column) => `NEW.${column} ${distinct} OLD.${column}`),
    ...["schemaVersion", "createdByActorId", "createdAt"].map(
      (key) => `${field("NEW", key)} ${distinct} ${field("OLD", key)}`,
    ),
  ].join(" OR ");
}
