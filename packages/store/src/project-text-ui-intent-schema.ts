import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import { creativeProjectSchemaName } from "./creative-project-schema.ts";

export const textIntentTables = [
  "project_text_ui_intent_schema_version",
  "project_text_ui_intents",
] as const;
const columns = [
  "scope_digest",
  "tenant_id",
  "space_id",
  "principal_id",
  "actor_id",
  "project_id",
  "intent_id",
  "kind",
  "idempotency_key",
  "request_digest",
  "revision",
  "phase",
  "acknowledged",
  "record_json",
] as const;
const immutable = [
  "scope_digest",
  "tenant_id",
  "space_id",
  "principal_id",
  "actor_id",
  "project_id",
  "intent_id",
  "kind",
  "idempotency_key",
  "request_digest",
] as const;
const index = "project_text_ui_intents_one_active";
const receiptIndex = "project_text_ui_intents_receipt_key";
const receiptColumns = [
  "tenant_id",
  "space_id",
  "principal_id",
  "actor_id",
  "kind",
  "idempotency_key",
] as const;
const trigger = "project_text_ui_intents_immutable";
const evidenceTables = [
  "creative_projects",
  "project_text_schema_version",
  "project_text_mutation_receipts",
  "project_text_artifacts",
  "project_text_revisions",
] as const;
export function textIntentSchemaSql(schema?: string): string {
  const pg = schema !== undefined,
    p = pg ? `${creativeProjectSchemaName(schema)}.` : "";
  const json = pg ? "JSONB" : "TEXT",
    strict = pg ? "" : " STRICT";
  const bounded = pg
    ? "jsonb_typeof(record_json)='object' AND octet_length(record_json::text)<=65536"
    : "json_valid(record_json) AND json_type(record_json)='object' AND length(CAST(record_json AS BLOB))<=65536";
  return `CREATE TABLE IF NOT EXISTS ${p}project_text_ui_intent_schema_version(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL CHECK(version=1))${strict};
    INSERT INTO ${p}project_text_ui_intent_schema_version VALUES(1,1) ${pg ? "ON CONFLICT(id) DO NOTHING" : "ON CONFLICT(id) DO NOTHING"};
    CREATE TABLE IF NOT EXISTS ${p}project_text_ui_intents(
      scope_digest TEXT NOT NULL,tenant_id TEXT NOT NULL,space_id TEXT NOT NULL,principal_id TEXT NOT NULL,actor_id TEXT NOT NULL,project_id TEXT NOT NULL,
      intent_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('save-outline','save-script','select-revision','set-lock')),
      idempotency_key TEXT NOT NULL,request_digest TEXT NOT NULL,revision ${pg ? "BIGINT" : "INTEGER"} NOT NULL CHECK(revision>=1 AND revision<=9007199254740991),
      phase TEXT NOT NULL CHECK(phase IN ('pending','accepted','refused')),acknowledged INTEGER NOT NULL CHECK(acknowledged IN(0,1) AND (phase!='pending' OR acknowledged=0)),
      record_json ${json} NOT NULL CHECK(${bounded}),
      PRIMARY KEY(intent_id),
      FOREIGN KEY(tenant_id,space_id,project_id,principal_id) REFERENCES ${p}creative_projects(tenant_id,space_id,project_id,owner_principal_id) ON DELETE RESTRICT
    )${strict};
    CREATE UNIQUE INDEX IF NOT EXISTS ${index} ON ${p}project_text_ui_intents(scope_digest) WHERE acknowledged=0;
    CREATE UNIQUE INDEX IF NOT EXISTS ${receiptIndex} ON ${p}project_text_ui_intents(${receiptColumns.join(",")});`;
}
function assertMarker(rows: readonly Record<string, unknown>[]) {
  if (
    rows.length !== 1 ||
    Number(rows[0]?.id) !== 1 ||
    Number(rows[0]?.version) !== 1
  )
    fail();
}
/** Returns false only when the independent journal is wholly absent. Partial/shadow schemas fail closed. */
export function assertSqliteTextIntentSchema(
  db: DatabaseSync,
  optional = false,
): boolean {
  const rows = db
    .prepare(
      "SELECT name,type FROM main.sqlite_schema WHERE name IN (?,?) UNION ALL SELECT name,type FROM temp.sqlite_schema WHERE name IN (?,?)",
    )
    .all(...textIntentTables, ...textIntentTables);
  if (rows.length === 0 && optional) return false;
  if (
    rows.length !== 2 ||
    textIntentTables.some(
      (name) => !rows.some((row) => row.name === name && row.type === "table"),
    )
  )
    fail();
  assertMarker(
    db
      .prepare(
        "SELECT id,version FROM main.project_text_ui_intent_schema_version LIMIT 2",
      )
      .all(),
  );
  for (const table of evidenceTables) {
    const facts = db
      .prepare(
        "SELECT type FROM main.sqlite_schema WHERE name=? UNION ALL SELECT type FROM temp.sqlite_schema WHERE name=?",
      )
      .all(table, table);
    if (facts.length !== 1 || facts[0]?.type !== "table") fail();
  }
  assertMarker(
    db
      .prepare(
        "SELECT id,version FROM main.project_text_schema_version LIMIT 2",
      )
      .all(),
  );
  const actual = db
    .prepare("PRAGMA main.table_info(project_text_ui_intents)")
    .all();
  if (
    actual.length !== columns.length ||
    columns.some(
      (name) => !actual.some((row) => row.name === name && row.notnull === 1),
    ) ||
    !actual.some((row) => row.name === "intent_id" && row.pk === 1)
  )
    fail();
  const idx = db
    .prepare("SELECT sql FROM main.sqlite_schema WHERE type='index' AND name=?")
    .get(index);
  const col = db.prepare(`PRAGMA main.index_info(${index})`).all();
  const indexes = db
    .prepare("PRAGMA main.index_list(project_text_ui_intents)")
    .all();
  if (
    idx === undefined ||
    col.length !== 1 ||
    col[0]?.name !== "scope_digest" ||
    !indexes.some(
      (row) => row.name === index && row.unique === 1 && row.partial === 1,
    ) ||
    !/WHERE acknowledged\s*=\s*0\s*;?$/iu.test(String(idx.sql))
  )
    fail();
  const receipt = db.prepare(`PRAGMA main.index_info(${receiptIndex})`).all();
  if (
    !indexes.some(
      (row) =>
        row.name === receiptIndex && row.unique === 1 && row.partial === 0,
    ) ||
    receipt.length !== receiptColumns.length ||
    receiptColumns.some((name, i) => receipt[i]?.name !== name)
  )
    fail();
  const triggers = db
    .prepare(
      "SELECT name FROM main.sqlite_schema WHERE type='trigger' AND tbl_name='project_text_ui_intents'",
    )
    .all();
  if (
    ![trigger, `${trigger}_delete`].every((name) =>
      triggers.some((row) => row.name === name),
    )
  )
    fail();
  return true;
}
export async function assertPostgresTextIntentSchema(
  client: PoolClient,
  schema: string,
  optional = false,
): Promise<boolean> {
  const p = `${creativeProjectSchemaName(schema)}.`;
  const rows = (
    await client.query(
      "SELECT c.relname,c.relkind FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=ANY($2::text[])",
      [schema, textIntentTables],
    )
  ).rows;
  if (rows.length === 0 && optional) return false;
  if (
    rows.length !== 2 ||
    textIntentTables.some(
      (name) =>
        !rows.some((row) => row.relname === name && row.relkind === "r"),
    )
  )
    fail();
  assertMarker(
    (
      await client.query(
        `SELECT id,version FROM ${p}project_text_ui_intent_schema_version LIMIT 2`,
      )
    ).rows,
  );
  const evidence = (
    await client.query(
      "SELECT c.relname,c.relkind FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=ANY($2::text[])",
      [schema, evidenceTables],
    )
  ).rows;
  if (
    evidence.length !== evidenceTables.length ||
    evidenceTables.some(
      (name) =>
        !evidence.some((row) => row.relname === name && row.relkind === "r"),
    )
  )
    fail();
  assertMarker(
    (
      await client.query(
        `SELECT id,version FROM ${p}project_text_schema_version LIMIT 2`,
      )
    ).rows,
  );
  const actual = (
    await client.query(
      "SELECT a.attname FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='project_text_ui_intents' AND a.attnum>0 AND NOT a.attisdropped",
      [schema],
    )
  ).rows;
  if (
    actual.length !== columns.length ||
    columns.some((name) => !actual.some((row) => row.attname === name))
  )
    fail();
  const idx = (
    await client.query(
      "SELECT i.indisvalid,i.indisready,i.indisunique,pg_get_expr(i.indpred,i.indrelid) AS predicate,pg_get_indexdef(i.indexrelid,1,true) AS column FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indexrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_class t ON t.oid=i.indrelid WHERE n.nspname=$1 AND c.relname=$2 AND t.relname='project_text_ui_intents' AND i.indnkeyatts=1 AND i.indnatts=1",
      [schema, index],
    )
  ).rows;
  if (
    idx.length !== 1 ||
    idx[0]?.indisvalid !== true ||
    idx[0]?.indisready !== true ||
    idx[0]?.indisunique !== true ||
    idx[0]?.column !== "scope_digest" ||
    idx[0]?.predicate !== "(acknowledged = 0)"
  )
    fail();
  const receipt = (
    await client.query(
      "SELECT i.indisvalid,i.indisready,i.indisunique,i.indpred,ARRAY(SELECT pg_get_indexdef(i.indexrelid,k,true) FROM generate_series(1,i.indnkeyatts) k) AS columns FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indexrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_class t ON t.oid=i.indrelid WHERE n.nspname=$1 AND c.relname=$2 AND t.relname='project_text_ui_intents' AND i.indnkeyatts=6 AND i.indnatts=6",
      [schema, receiptIndex],
    )
  ).rows;
  if (
    receipt.length !== 1 ||
    receipt[0]?.indisvalid !== true ||
    receipt[0]?.indisready !== true ||
    receipt[0]?.indisunique !== true ||
    receipt[0]?.indpred !== null ||
    JSON.stringify(receipt[0]?.columns) !== JSON.stringify(receiptColumns)
  )
    fail();
  const triggers = (
    await client.query(
      "SELECT t.tgname,t.tgenabled FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='project_text_ui_intents' AND NOT t.tgisinternal",
      [schema],
    )
  ).rows;
  if (!triggers.some((row) => row.tgname === trigger && row.tgenabled === "O"))
    fail();
  return true;
}
export function migrateSqliteTextIntent(db: DatabaseSync): void {
  const existing = db
    .prepare(
      "SELECT name FROM main.sqlite_schema WHERE name IN (?,?) UNION ALL SELECT name FROM temp.sqlite_schema WHERE name IN (?,?)",
    )
    .all(...textIntentTables, ...textIntentTables);
  if (existing.length > 0) {
    assertSqliteTextIntentSchema(db);
    return;
  }
  db.prepare(
    "SELECT tenant_id,space_id,principal_id,actor_id,kind,idempotency_key,request_digest,project_id,result_json FROM main.project_text_mutation_receipts LIMIT 0",
  ).all();
  db.exec(textIntentSchemaSql());
  const identity = immutable
    .map((c) => `NEW.${c} IS NOT OLD.${c}`)
    .join(" OR ");
  const jsonIdentity = [
    "schemaVersion",
    "scope",
    "intentId",
    "actionId",
    "input",
    "requestDigest",
    "createdAt",
  ]
    .map(
      (key) =>
        `json_extract(NEW.record_json,'$.${key}') IS NOT json_extract(OLD.record_json,'$.${key}')`,
    )
    .join(" OR ");
  db.exec(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON project_text_ui_intents WHEN ${identity} OR ${jsonIdentity} OR NEW.revision!=OLD.revision+1 OR OLD.acknowledged=1 OR (OLD.phase!='pending' AND NEW.phase!=OLD.phase) OR (OLD.phase='accepted' AND json_extract(NEW.record_json,'$.receipt') IS NOT json_extract(OLD.record_json,'$.receipt')) OR (OLD.phase='refused' AND json_extract(NEW.record_json,'$.refusalCode') IS NOT json_extract(OLD.record_json,'$.refusalCode')) BEGIN SELECT RAISE(ABORT,'project_text_ui_intent_immutable'); END;
    CREATE TRIGGER ${trigger}_delete BEFORE DELETE ON project_text_ui_intents BEGIN SELECT RAISE(ABORT,'project_text_ui_intent_immutable'); END;`);
  assertSqliteTextIntentSchema(db);
}
export async function migratePostgresTextIntent(
  client: PoolClient,
  schema: string,
): Promise<void> {
  const p = `${creativeProjectSchemaName(schema)}.`;
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    JSON.stringify(["project-text-ui-intent-schema", schema]),
  ]);
  const existing = (
    await client.query(
      "SELECT c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=ANY($2::text[])",
      [schema, textIntentTables],
    )
  ).rows;
  if (existing.length > 0) {
    await assertPostgresTextIntentSchema(client, schema);
    return;
  }
  await client.query(
    `SELECT tenant_id,space_id,principal_id,actor_id,kind,idempotency_key,request_digest,project_id,result_json FROM ${p}project_text_mutation_receipts LIMIT 0`,
  );
  await client.query(textIntentSchemaSql(schema));
  const identity = immutable
    .map((c) => `NEW.${c} IS DISTINCT FROM OLD.${c}`)
    .join(" OR ");
  const jsonIdentity = [
    "schemaVersion",
    "scope",
    "intentId",
    "actionId",
    "input",
    "requestDigest",
    "createdAt",
  ]
    .map(
      (key) =>
        `NEW.record_json->'${key}' IS DISTINCT FROM OLD.record_json->'${key}'`,
    )
    .join(" OR ");
  await client.query(`CREATE FUNCTION ${p}project_text_ui_intent_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF TG_OP='DELETE' THEN RAISE EXCEPTION 'project_text_ui_intent_immutable'; END IF;
    IF ${identity} OR ${jsonIdentity} OR NEW.revision!=OLD.revision+1 OR OLD.acknowledged=1 OR (OLD.phase!='pending' AND NEW.phase!=OLD.phase) OR (OLD.phase='accepted' AND NEW.record_json->'receipt' IS DISTINCT FROM OLD.record_json->'receipt') OR (OLD.phase='refused' AND NEW.record_json->'refusalCode' IS DISTINCT FROM OLD.record_json->'refusalCode') THEN RAISE EXCEPTION 'project_text_ui_intent_immutable'; END IF; RETURN NEW; END; $$;
    CREATE TRIGGER ${trigger} BEFORE UPDATE OR DELETE ON ${p}project_text_ui_intents FOR EACH ROW EXECUTE FUNCTION ${p}project_text_ui_intent_immutable();`);
  await assertPostgresTextIntentSchema(client, schema);
}
function fail(): never {
  throw new Error("project_text_ui_intent_schema_invalid");
}
