import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import { creativeProjectSchemaName } from "./creative-project-schema.ts";

const immutableTables = [
  "project_source_uploads",
  "project_source_upload_parts",
  "project_source_upload_seals",
  "project_source_upload_prepared",
  "project_source_upload_prepared_chunks",
  "project_source_upload_prepared_chapters",
  "project_source_upload_events",
  "project_source_upload_associations",
] as const;
const tables = [
  "project_source_upload_schema_version",
  "project_source_upload_heads",
  "project_source_upload_part_payloads",
  ...immutableTables,
] as const;
const requiredColumns: Record<string, readonly string[]> = {
  project_source_upload_schema_version: ["id", "version", "storage_realm_id"],
  project_source_uploads: [
    "idempotency_key",
    "request_digest",
    "file_digest",
    "byte_length",
    "record_json",
  ],
  project_source_upload_heads: ["revision", "phase", "record_json"],
  project_source_upload_parts: [
    "part_index",
    "byte_offset",
    "byte_length",
    "raw_digest",
    "record_json",
  ],
  project_source_upload_part_payloads: ["part_index", "payload"],
  project_source_upload_seals: ["upload_digest", "record_json"],
  project_source_upload_prepared: [
    "prepared_digest",
    "content_digest",
    "parser_version",
    "record_json",
  ],
  project_source_upload_prepared_chunks: [
    "chunk_index",
    "start_offset",
    "character_length",
    "content",
    "content_digest",
  ],
  project_source_upload_prepared_chapters: [
    "chapter_id",
    "start_offset",
    "end_offset",
    "record_json",
  ],
  project_source_upload_events: ["head_revision", "phase", "record_json"],
  project_source_upload_associations: [
    "project_id",
    "source_revision",
    "source_digest",
    "record_json",
  ],
};
const key = "tenant_id,space_id,owner_principal_id,upload_id";
const ownerColumns =
  "tenant_id TEXT NOT NULL,space_id TEXT NOT NULL,owner_principal_id TEXT NOT NULL,upload_id TEXT NOT NULL";

/** Independent namespace in the existing database; callers own migration transactions. */
export function projectSourceUploadSchemaSql(
  input: { dialect: "sqlite" } | { dialect: "postgres"; schema: string },
): string {
  const pg = input.dialect === "postgres";
  const prefix = pg ? `${creativeProjectSchemaName(input.schema)}.` : "";
  const json = pg ? "JSONB" : "TEXT";
  const int = pg ? "BIGINT" : "INTEGER";
  const strict = pg ? "" : " STRICT";
  const bytes = (column: string) =>
    pg ? `octet_length(${column})` : `length(CAST(${column} AS BLOB))`;
  const boundedJson = (maximum: number) =>
    pg
      ? `jsonb_typeof(record_json)='object' AND octet_length(record_json::text)<=${maximum}`
      : `json_valid(record_json) AND json_type(record_json)='object' AND ${bytes("record_json")}<=${maximum}`;
  const positive = (name: string, min = 1) =>
    `${name}>=${min} AND ${name}<=9007199254740991`;
  const parent = `FOREIGN KEY(${key}) REFERENCES ${prefix}project_source_uploads(${key}) ON DELETE RESTRICT`;
  const table = (name: string, body: string) =>
    `CREATE TABLE ${prefix}${name} (${body})${strict};`;
  return [
    table(
      "project_source_upload_schema_version",
      "id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL CHECK(version=1),storage_realm_id TEXT NOT NULL",
    ),
    table(
      "project_source_uploads",
      `${ownerColumns},idempotency_key TEXT NOT NULL,request_digest TEXT NOT NULL,file_digest TEXT NOT NULL,byte_length ${int} NOT NULL CHECK(byte_length>=1 AND byte_length<=20000000),record_json ${json} NOT NULL CHECK(${boundedJson(16384)}),PRIMARY KEY(${key}),UNIQUE(tenant_id,space_id,owner_principal_id,idempotency_key)`,
    ),
    table(
      "project_source_upload_heads",
      `${ownerColumns},revision ${int} NOT NULL CHECK(${positive("revision")}),phase TEXT NOT NULL CHECK(phase IN ('receiving','raw-sealed','preparing','ready','rejected','cancelled','expired')),record_json ${json} NOT NULL CHECK(${boundedJson(196608)}),PRIMARY KEY(${key}),${parent}`,
    ),
    table(
      "project_source_upload_parts",
      `${ownerColumns},part_index ${int} NOT NULL CHECK(part_index>=0 AND part_index<306),byte_offset ${int} NOT NULL CHECK(byte_offset=part_index*65536),byte_length ${int} NOT NULL CHECK(byte_length>=1 AND byte_length<=65536),raw_digest TEXT NOT NULL,record_json ${json} NOT NULL CHECK(${boundedJson(2048)}),PRIMARY KEY(${key},part_index),${parent}`,
    ),
    table(
      "project_source_upload_part_payloads",
      `${ownerColumns},part_index ${int} NOT NULL CHECK(part_index>=0 AND part_index<306),payload ${pg ? "BYTEA" : "BLOB"} NOT NULL CHECK(${pg ? "octet_length(payload)" : "length(payload)"}>=1 AND ${pg ? "octet_length(payload)" : "length(payload)"}<=65536),PRIMARY KEY(${key},part_index),FOREIGN KEY(${key},part_index) REFERENCES ${prefix}project_source_upload_parts(${key},part_index) ON DELETE RESTRICT`,
    ),
    table(
      "project_source_upload_seals",
      `${ownerColumns},upload_digest TEXT NOT NULL,record_json ${json} NOT NULL CHECK(${boundedJson(2048)}),PRIMARY KEY(${key}),${parent}`,
    ),
    table(
      "project_source_upload_prepared",
      `${ownerColumns},prepared_digest TEXT NOT NULL,content_digest TEXT NOT NULL,parser_version TEXT NOT NULL,record_json ${json} NOT NULL CHECK(${boundedJson(8192)}),PRIMARY KEY(${key}),${parent}`,
    ),
    table(
      "project_source_upload_prepared_chunks",
      `${ownerColumns},chunk_index ${int} NOT NULL CHECK(chunk_index>=0 AND chunk_index<20000),start_offset ${int} NOT NULL CHECK(${positive("start_offset", 0)}),character_length ${int} NOT NULL CHECK(character_length>=1 AND character_length<=4096),content TEXT NOT NULL CHECK(${bytes("content")}>=1 AND ${bytes("content")}<=4096),content_digest TEXT NOT NULL,PRIMARY KEY(${key},chunk_index),UNIQUE(${key},start_offset),FOREIGN KEY(${key}) REFERENCES ${prefix}project_source_upload_prepared(${key}) ON DELETE RESTRICT`,
    ),
    table(
      "project_source_upload_prepared_chapters",
      `${ownerColumns},chapter_id TEXT NOT NULL,start_offset ${int} NOT NULL CHECK(${positive("start_offset", 0)}),end_offset ${int} NOT NULL CHECK(${positive("end_offset")} AND end_offset>start_offset),record_json ${json} NOT NULL CHECK(${boundedJson(4096)}),PRIMARY KEY(${key},chapter_id),UNIQUE(${key},start_offset),FOREIGN KEY(${key}) REFERENCES ${prefix}project_source_upload_prepared(${key}) ON DELETE RESTRICT`,
    ),
    table(
      "project_source_upload_events",
      `${ownerColumns},head_revision ${int} NOT NULL CHECK(${positive("head_revision")}),phase TEXT NOT NULL,record_json ${json} NOT NULL CHECK(${boundedJson(196608)}),PRIMARY KEY(${key},head_revision),${parent}`,
    ),
    table(
      "project_source_upload_associations",
      `${ownerColumns},project_id TEXT NOT NULL,source_revision ${int} NOT NULL CHECK(${positive("source_revision")}),source_digest TEXT NOT NULL,record_json ${json} NOT NULL CHECK(${boundedJson(8192)}),PRIMARY KEY(${key},project_id,source_revision),${parent},FOREIGN KEY(tenant_id,space_id,project_id,owner_principal_id) REFERENCES ${prefix}creative_projects(tenant_id,space_id,project_id,owner_principal_id) ON DELETE RESTRICT`,
    ),
  ].join("\n");
}

function fail(code: string): never {
  throw new Error(code);
}
function realm(rows: readonly Record<string, unknown>[]): string {
  const row = rows[0];
  if (
    rows.length !== 1 ||
    Number(row?.id) !== 1 ||
    Number(row?.version) !== 1 ||
    typeof row?.storage_realm_id !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(row.storage_realm_id)
  )
    fail("project_source_upload_schema_version_unsupported");
  return row.storage_realm_id as string;
}
const reads = Object.entries(requiredColumns).map(([table, columns]) => ({
  table,
  columns:
    table === "project_source_upload_schema_version"
      ? columns
      : [...key.split(","), ...columns],
}));

/** Read-only; partial/corrupt installation is never treated as an absent extension. */
export function assertSqliteProjectSourceUploadSchema(
  database: DatabaseSync,
): false | string {
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
    fail("project_source_upload_schema_incomplete");
  const id = realm(
    database
      .prepare(
        "SELECT id,version,storage_realm_id FROM project_source_upload_schema_version LIMIT 2",
      )
      .all(),
  );
  try {
    for (const read of reads)
      database
        .prepare(`SELECT ${read.columns.join(",")} FROM ${read.table} LIMIT 0`)
        .all();
    for (const name of [
      ...immutableTables,
      "project_source_upload_schema_version",
    ])
      for (const action of ["update", "delete"])
        assertSqliteTrigger(database, `${name}_no_${action}`, name);
    for (const [name, table] of [
      [
        "project_source_upload_heads_identity_immutable",
        "project_source_upload_heads",
      ],
      ["project_source_upload_heads_no_delete", "project_source_upload_heads"],
      [
        "project_source_upload_part_payloads_no_update",
        "project_source_upload_part_payloads",
      ],
    ])
      assertSqliteTrigger(database, name!, table!);
  } catch {
    fail("project_source_upload_schema_incomplete");
  }
  return id;
}
function assertSqliteTrigger(
  database: DatabaseSync,
  name: string,
  table: string,
) {
  const row = database
    .prepare("SELECT type,tbl_name FROM sqlite_master WHERE name=?")
    .get(name);
  if (row?.type !== "trigger" || row.tbl_name !== table)
    fail("project_source_upload_schema_incomplete");
}
export function migrateSqliteProjectSourceUploads(
  database: DatabaseSync,
): string {
  const existing = assertSqliteProjectSourceUploadSchema(database);
  if (existing !== false) return existing;
  database
    .prepare(
      "SELECT tenant_id,space_id,project_id,owner_principal_id FROM creative_projects LIMIT 0",
    )
    .all();
  database.exec(projectSourceUploadSchemaSql({ dialect: "sqlite" }));
  database
    .prepare("INSERT INTO project_source_upload_schema_version VALUES(1,1,?)")
    .run(randomUUID());
  for (const table of [
    ...immutableTables,
    "project_source_upload_schema_version",
  ])
    for (const action of ["UPDATE", "DELETE"])
      database.exec(
        `CREATE TRIGGER ${table}_no_${action.toLowerCase()} BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT,'project_source_upload_history_immutable'); END;`,
      );
  database.exec(`
    CREATE TRIGGER project_source_upload_heads_no_delete BEFORE DELETE ON project_source_upload_heads BEGIN SELECT RAISE(ABORT,'project_source_upload_identity_immutable'); END;
    CREATE TRIGGER project_source_upload_heads_identity_immutable BEFORE UPDATE ON project_source_upload_heads
    WHEN ${key
      .split(",")
      .map((column) => `NEW.${column} IS NOT OLD.${column}`)
      .join(" OR ")}
    BEGIN SELECT RAISE(ABORT,'project_source_upload_identity_immutable'); END;
    CREATE TRIGGER project_source_upload_part_payloads_no_update BEFORE UPDATE ON project_source_upload_part_payloads BEGIN SELECT RAISE(ABORT,'project_source_upload_payload_immutable'); END;
  `);
  const id = assertSqliteProjectSourceUploadSchema(database);
  if (id === false) fail("project_source_upload_schema_incomplete");
  return id;
}

export async function assertPostgresProjectSourceUploadSchema(
  client: PoolClient,
  schema: string,
): Promise<false | string> {
  const prefix = `${creativeProjectSchemaName(schema)}.`;
  const found = await client.query(
    "SELECT c.relname AS name,c.relkind AS kind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=ANY($2::text[])",
    [schema, tables],
  );
  if (found.rows.length === 0) return false;
  if (
    found.rows.length !== tables.length ||
    found.rows.some((row) => row.kind !== "r")
  )
    fail("project_source_upload_schema_incomplete");
  const id = realm(
    (
      await client.query(
        `SELECT id,version,storage_realm_id FROM ${prefix}project_source_upload_schema_version LIMIT 2`,
      )
    ).rows,
  );
  try {
    for (const read of reads)
      await client.query(
        `SELECT ${read.columns.join(",")} FROM ${prefix}${read.table} LIMIT 0`,
      );
    for (const table of [
      ...immutableTables,
      "project_source_upload_schema_version",
    ])
      for (const action of ["update", "delete"])
        await assertPgTrigger(client, schema, `${table}_no_${action}`, table);
    for (const [name, table] of [
      [
        "project_source_upload_heads_identity_immutable",
        "project_source_upload_heads",
      ],
      ["project_source_upload_heads_no_delete", "project_source_upload_heads"],
      [
        "project_source_upload_part_payloads_no_update",
        "project_source_upload_part_payloads",
      ],
    ])
      await assertPgTrigger(client, schema, name!, table!);
  } catch {
    fail("project_source_upload_schema_incomplete");
  }
  return id;
}
async function assertPgTrigger(
  client: PoolClient,
  schema: string,
  name: string,
  table: string,
) {
  const result = await client.query(
    "SELECT t.tgenabled AS enabled FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2 AND t.tgname=$3 AND NOT t.tgisinternal",
    [schema, table, name],
  );
  if (result.rows.length !== 1 || !["O", "A"].includes(result.rows[0]?.enabled))
    fail("project_source_upload_schema_incomplete");
}
export async function migratePostgresProjectSourceUploads(
  client: PoolClient,
  schema: string,
): Promise<string> {
  const prefix = `${creativeProjectSchemaName(schema)}.`;
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `${schema}:project-source-upload-schema-v1`,
  ]);
  const existing = await assertPostgresProjectSourceUploadSchema(
    client,
    schema,
  );
  if (existing !== false) return existing;
  await client.query(
    `SELECT tenant_id,space_id,project_id,owner_principal_id FROM ${prefix}creative_projects LIMIT 0`,
  );
  await client.query(
    projectSourceUploadSchemaSql({ dialect: "postgres", schema }),
  );
  await client.query(
    `INSERT INTO ${prefix}project_source_upload_schema_version VALUES(1,1,$1)`,
    [randomUUID()],
  );
  await client.query(
    `CREATE FUNCTION ${prefix}project_source_upload_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'project_source_upload_history_immutable'; END; $$`,
  );
  for (const table of [
    ...immutableTables,
    "project_source_upload_schema_version",
  ])
    for (const action of ["UPDATE", "DELETE"])
      await client.query(
        `CREATE TRIGGER ${table}_no_${action.toLowerCase()} BEFORE ${action} ON ${prefix}${table} FOR EACH ROW EXECUTE FUNCTION ${prefix}project_source_upload_immutable()`,
      );
  await client.query(`
    CREATE TRIGGER project_source_upload_heads_no_delete BEFORE DELETE ON ${prefix}project_source_upload_heads FOR EACH ROW EXECUTE FUNCTION ${prefix}project_source_upload_immutable();
    CREATE TRIGGER project_source_upload_heads_identity_immutable BEFORE UPDATE ON ${prefix}project_source_upload_heads FOR EACH ROW WHEN (${key
      .split(",")
      .map((column) => `NEW.${column} IS DISTINCT FROM OLD.${column}`)
      .join(
        " OR ",
      )}) EXECUTE FUNCTION ${prefix}project_source_upload_immutable();
    CREATE TRIGGER project_source_upload_part_payloads_no_update BEFORE UPDATE ON ${prefix}project_source_upload_part_payloads FOR EACH ROW EXECUTE FUNCTION ${prefix}project_source_upload_immutable();
  `);
  const id = await assertPostgresProjectSourceUploadSchema(client, schema);
  if (id === false) fail("project_source_upload_schema_incomplete");
  return id;
}
