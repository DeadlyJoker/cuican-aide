import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import { creativeProjectSchemaName } from "./creative-project-schema.ts";
import {
  assertPostgresProjectGenerationSchema,
  assertSqliteProjectGenerationSchema,
} from "./project-generation-schema.ts";

const versionTable = "concept_selection_schema_version";
export const conceptSelectionTables = [
  "creative_operation_result_links",
  "creative_current_concept_selections",
  "creative_concept_selection_receipts",
] as const;
const identity = [
  "tenant_id",
  "space_id",
  "project_id",
  "owner_principal_id",
  "asset_id",
];
type Spec = Readonly<{
  name: string;
  columns: Readonly<Record<string, "text" | "bigint" | "jsonb" | "integer">>;
  constraints: readonly string[];
}>;
const canonical = (s: string) =>
  s
    .toLowerCase()
    .replace(/::(?:text\[\]|text|bigint|integer)/gu, "")
    .replace(/[\s()'";]/gu, "");
const safe = (column: string, minimum = 1) =>
  `${column}>=${minimum} AND ${column}<=9007199254740991`;
function specs(prefix: string, pg: boolean): readonly Spec[] {
  const common = {
    tenant_id: "text",
    space_id: "text",
    project_id: "text",
    owner_principal_id: "text",
    asset_id: "text",
  } as const;
  const fkOwner = `FOREIGN KEY (tenant_id,space_id,project_id,owner_principal_id) REFERENCES ${prefix}creative_projects(tenant_id,space_id,project_id,owner_principal_id) ON DELETE RESTRICT`;
  const check = (fields: Record<string, string>, max: number) => {
    const field = (path: string) =>
      pg
        ? `(record_json#>>'{${path.split(".").join(",")}}')`
        : `CAST(json_extract(record_json,'$.${path}') AS TEXT)`;
    const match = Object.entries(fields)
      .map(
        ([path, column]) =>
          `${field(path)} IS NOT NULL AND ${field(path)}=${pg ? `${column}::text` : `CAST(${column} AS TEXT)`}`,
      )
      .join(" AND ");
    return `CHECK (${pg ? "jsonb_typeof(record_json)='object' AND octet_length(record_json::text)" : "json_valid(record_json) AND json_type(record_json)='object' AND length(CAST(record_json AS BLOB))"}<=${max} AND ${match})`;
  };
  const scopeFields = {
    tenantId: "tenant_id",
    spaceId: "space_id",
    projectId: "project_id",
    ownerPrincipalId: "owner_principal_id",
  };
  const linkColumns = {
    ...common,
    asset_revision: "bigint",
    source_run_id: "text",
    source_binding_digest: "text",
    operation_id: "text",
    operation_revision: "bigint",
    result_index: "bigint",
    content_digest: "text",
    record_json: "jsonb",
  } as const;
  const linkKey =
    "tenant_id,space_id,project_id,owner_principal_id,asset_id,content_digest";
  return [
    {
      name: versionTable,
      columns: { id: "integer", version: "integer" },
      constraints: ["PRIMARY KEY (id)", "CHECK (id=1)"],
    },
    {
      name: conceptSelectionTables[0],
      columns: linkColumns,
      constraints: [
        `PRIMARY KEY (${linkKey})`,
        `CHECK (${safe("asset_revision")})`,
        `CHECK (${safe("operation_revision")})`,
        "CHECK (result_index>=0 AND result_index<=15)",
        check(
          {
            ...scopeFields,
            "reference.assetId": "asset_id",
            "reference.assetRevision": "asset_revision",
            "sourceRunId": "source_run_id",
            "sourceBindingDigest": "source_binding_digest",
            "operationId": "operation_id",
            "operationRevision": "operation_revision",
            "image.resultIndex": "result_index",
            "contentDigest": "content_digest",
          },
          32768,
        ),
        fkOwner,
        `FOREIGN KEY (tenant_id,space_id,project_id,asset_id,asset_revision) REFERENCES ${prefix}creative_concept_revisions(tenant_id,space_id,project_id,asset_id,asset_revision) ON DELETE RESTRICT`,
        `FOREIGN KEY (tenant_id,source_run_id) REFERENCES ${prefix}creative_project_generation_links(tenant_id,run_id) ON DELETE RESTRICT`,
        `FOREIGN KEY (tenant_id,source_run_id,source_binding_digest,operation_id) REFERENCES ${prefix}extension_external_operations(tenant_id,run_id,binding_digest,operation_id) ON DELETE RESTRICT`,
      ],
    },
    {
      name: conceptSelectionTables[1],
      columns: {
        ...common,
        selection_revision: "bigint",
        result_link_digest: "text",
        record_json: "jsonb",
      },
      constraints: [
        `PRIMARY KEY (${identity.join(",")})`,
        `CHECK (${safe("selection_revision")})`,
        check(
          {
            ...scopeFields,
            assetId: "asset_id",
            selectionRevision: "selection_revision",
            resultLinkDigest: "result_link_digest",
          },
          8192,
        ),
        fkOwner,
        `FOREIGN KEY (${identity.join(",")},result_link_digest) REFERENCES ${prefix}${conceptSelectionTables[0]}(${linkKey}) ON DELETE RESTRICT`,
      ],
    },
    {
      name: conceptSelectionTables[2],
      columns: {
        tenant_id: "text",
        space_id: "text",
        principal_id: "text",
        actor_id: "text",
        idempotency_key: "text",
        request_digest: "text",
        project_id: "text",
        asset_id: "text",
        result_link_digest: "text",
        record_json: "jsonb",
      },
      constraints: [
        "PRIMARY KEY (tenant_id,space_id,principal_id,actor_id,idempotency_key)",
        check(
          {
            "actor.tenantId": "tenant_id",
            "actor.spaceId": "space_id",
            "actor.principalId": "principal_id",
            "actor.actorId": "actor_id",
            "receipt.idempotencyKey": "idempotency_key",
            "receipt.requestDigest": "request_digest",
            "pointer.projectId": "project_id",
            "pointer.assetId": "asset_id",
            "pointer.resultLinkDigest": "result_link_digest",
          },
          65536,
        ),
        `FOREIGN KEY (tenant_id,space_id,project_id,principal_id,asset_id,result_link_digest) REFERENCES ${prefix}${conceptSelectionTables[0]}(${linkKey}) ON DELETE RESTRICT`,
      ],
    },
  ];
}
function tableSql(spec: Spec, pg: boolean, prefix: string) {
  return `CREATE TABLE ${prefix}${spec.name} (${Object.entries(spec.columns)
    .map(
      ([name, type]) =>
        `${name} ${pg ? type.toUpperCase() : type === "jsonb" ? "TEXT" : type === "bigint" ? "INTEGER" : type.toUpperCase()} NOT NULL`,
    )
    .join(",")},${spec.constraints.join(",")})${pg ? "" : " STRICT"};`;
}
function guard(table: string) {
  return (
    identity.map((column) => `OLD.${column}<>NEW.${column}`).join(" OR ") +
    " OR NEW.selection_revision<>OLD.selection_revision+1"
  );
}
function triggerName(table: string, action: string) {
  return `${table}_selection_${action}`;
}
function sqliteTrigger(table: string, action: "update" | "delete") {
  return `CREATE TRIGGER ${triggerName(table, action)} BEFORE ${action.toUpperCase()} ON ${table}${table === conceptSelectionTables[1] && action === "update" ? ` WHEN ${guard(table)}` : ""} BEGIN SELECT RAISE(ABORT,'concept_selection_immutable'); END;`;
}
function pgBody(table: string, action: "update" | "delete") {
  return table === conceptSelectionTables[1] && action === "update"
    ? `BEGIN IF ${guard(table)} THEN RAISE EXCEPTION 'concept_selection_immutable'; END IF; RETURN NEW; END`
    : "BEGIN RAISE EXCEPTION 'concept_selection_immutable'; END";
}
function version(rows: readonly Record<string, unknown>[]) {
  if (rows.length !== 1 || rows[0]?.id !== 1 || rows[0]?.version !== 1)
    throw new Error("concept_selection_schema_version_unsupported");
}
function assertBaseVersions(rows: readonly Record<string, unknown>[]) {
  if (rows.length !== 4 || rows.some((r) => r.id !== 1 || r.version !== 1))
    throw new Error("concept_selection_source_schema_version_unsupported");
}
function baseVersionSql(prefix: string) {
  return [
    "extension_schema_version",
    "plugin_task_admission_schema_version",
    "extension_credit_schema_version",
    "plugin_installation_schema_version",
  ]
    .map((t) => `SELECT id,version FROM ${prefix}${t}`)
    .join(" UNION ALL ");
}
function baseSql(prefix: string) {
  return `SELECT tenant_id,run_id,binding_digest,operation_id,idempotency_key,revision,record_json FROM ${prefix}extension_external_operations LIMIT 0`;
}
function sqliteObjects(db: DatabaseSync) {
  const names = [
    ...specs("", false).map((s) => s.name),
    ...conceptSelectionTables.flatMap((t) => [
      triggerName(t, "update"),
      triggerName(t, "delete"),
    ]),
  ];
  const arg = names.map(() => "?").join(","),
    tables = conceptSelectionTables.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT name,sql,'main' AS origin FROM main.sqlite_master WHERE name IN (${arg}) OR (type='trigger' AND tbl_name IN (${tables})) UNION ALL SELECT name,sql,'temp' AS origin FROM temp.sqlite_master WHERE name IN (${arg}) OR (type='trigger' AND tbl_name IN (${tables}))`,
    )
    .all(
      ...names,
      ...conceptSelectionTables,
      ...names,
      ...conceptSelectionTables,
    );
}
export function assertSqliteConceptSelectionSchema(db: DatabaseSync): void {
  assertSqliteProjectGenerationSchema(db);
  db.prepare(baseSql("")).all();
  assertBaseVersions(db.prepare(baseVersionSql("")).all());
  const expected = new Map<string, string>(
    specs("", false).map((s) => [s.name, tableSql(s, false, "")]),
  );
  for (const table of conceptSelectionTables)
    for (const action of ["update", "delete"] as const)
      expected.set(triggerName(table, action), sqliteTrigger(table, action));
  const rows = sqliteObjects(db);
  if (
    rows.length !== expected.size ||
    rows.some(
      (row) =>
        row.origin !== "main" ||
        canonical(String(row.sql)) !==
          canonical(expected.get(String(row.name)) ?? ""),
    )
  )
    throw new Error("concept_selection_schema_incomplete");
  version(db.prepare(`SELECT id,version FROM ${versionTable} LIMIT 2`).all());
}
export function migrateSqliteConceptSelections(db: DatabaseSync): void {
  assertSqliteProjectGenerationSchema(db);
  db.prepare(baseSql("")).all();
  assertBaseVersions(db.prepare(baseVersionSql("")).all());
  if (sqliteObjects(db).length === 0) {
    for (const spec of specs("", false)) db.exec(tableSql(spec, false, ""));
    db.prepare(`INSERT INTO ${versionTable} VALUES(1,1)`).run();
    for (const table of conceptSelectionTables)
      for (const action of ["update", "delete"] as const)
        db.exec(sqliteTrigger(table, action));
  }
  assertSqliteConceptSelectionSchema(db);
}
async function pgObjects(client: PoolClient, schema: string) {
  return (
    await client.query<{ name: string }>(
      "SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=ANY($2::text[])",
      [schema, specs("", true).map((s) => s.name)],
    )
  ).rows;
}
export async function assertPostgresConceptSelectionSchema(
  client: PoolClient,
  schema: string,
): Promise<void> {
  const prefix = `${creativeProjectSchemaName(schema)}.`;
  await assertPostgresProjectGenerationSchema(client, schema);
  await client.query(baseSql(prefix));
  assertBaseVersions((await client.query(baseVersionSql(prefix))).rows);
  if ((await pgObjects(client, schema)).length !== 4)
    throw new Error("concept_selection_schema_incomplete");
  version(
    (
      await client.query(
        `SELECT id,version FROM ${prefix}${versionTable} LIMIT 2`,
      )
    ).rows,
  );
  for (const spec of specs(prefix, true)) {
    const columns = (
        await client.query(
          "SELECT column_name,data_type,is_nullable FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position",
          [schema, spec.name],
        )
      ).rows,
      expected = Object.entries(spec.columns);
    if (
      columns.length !== expected.length ||
      columns.some(
        (c, i) =>
          c.column_name !== expected[i]?.[0] ||
          c.data_type !== expected[i]?.[1] ||
          c.is_nullable !== "NO",
      )
    )
      throw new Error("concept_selection_schema_incomplete");
    const constraints = (
      await client.query(
        `SELECT pg_get_constraintdef(x.oid) AS definition,x.convalidated AS valid,x.condeferrable AS deferred FROM pg_constraint x JOIN pg_class c ON c.oid=x.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2 AND x.contype<>'n'`,
        [schema, spec.name],
      )
    ).rows;
    if (
      constraints.length !== spec.constraints.length ||
      constraints.some((c) => !c.valid || c.deferred) ||
      spec.constraints.some(
        (e) =>
          !constraints.some(
            (c) => canonical(String(c.definition)) === canonical(e),
          ),
      )
    )
      throw new Error("concept_selection_schema_incomplete");
    if (spec.name === versionTable) continue;
    const triggers = (
      await client.query(
        `SELECT t.tgname AS name,t.tgenabled AS enabled,t.tgtype AS bits,p.prosrc AS body,pn.nspname AS function_schema,l.lanname AS language,pg_get_expr(t.tgqual,t.tgrelid) AS guard FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace pn ON pn.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang WHERE n.nspname=$1 AND c.relname=$2 AND NOT t.tgisinternal`,
        [schema, spec.name],
      )
    ).rows;
    if (
      triggers.length !== 2 ||
      (["update", "delete"] as const).some(
        (action, i) =>
          !triggers.some(
            (t) =>
              t.name === triggerName(spec.name, action) &&
              t.enabled === "O" &&
              t.bits === (i === 0 ? 19 : 11) &&
              t.function_schema === schema &&
              t.language === "plpgsql" &&
              t.guard === null &&
              canonical(String(t.body)) ===
                canonical(pgBody(spec.name, action)),
          ),
      )
    )
      throw new Error("concept_selection_schema_incomplete");
  }
}
export async function migratePostgresConceptSelections(
  client: PoolClient,
  schema: string,
): Promise<void> {
  const prefix = `${creativeProjectSchemaName(schema)}.`;
  await assertPostgresProjectGenerationSchema(client, schema);
  await client.query(baseSql(prefix));
  assertBaseVersions((await client.query(baseVersionSql(prefix))).rows);
  if ((await pgObjects(client, schema)).length === 0) {
    for (const spec of specs(prefix, true))
      await client.query(tableSql(spec, true, prefix));
    await client.query(`INSERT INTO ${prefix}${versionTable} VALUES(1,1)`);
    for (const table of conceptSelectionTables)
      for (const action of ["update", "delete"] as const) {
        const name = triggerName(table, action);
        await client.query(
          `CREATE FUNCTION ${prefix}${name}() RETURNS trigger LANGUAGE plpgsql AS $$ ${pgBody(table, action)} $$;`,
        );
        await client.query(
          `CREATE TRIGGER ${name} BEFORE ${action.toUpperCase()} ON ${prefix}${table} FOR EACH ROW EXECUTE FUNCTION ${prefix}${name}();`,
        );
      }
  }
  await assertPostgresConceptSelectionSchema(client, schema);
}
