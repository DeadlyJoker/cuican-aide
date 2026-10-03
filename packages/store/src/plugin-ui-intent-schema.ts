import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import { creativeProjectSchemaName } from "./creative-project-schema.ts";

const tables = [
  "plugin_ui_intent_schema_version",
  "plugin_ui_intent_accounts",
  "plugin_ui_intents",
] as const;
const indexName = "plugin_ui_intents_unresolved_family";
const keys = ["control_realm_id", "tenant_id", "space_id", "principal_id"];
const max = "9007199254740991";
type Spec = Readonly<{
  name: string;
  columns: Readonly<Record<string, "text" | "bigint" | "integer" | "jsonb">>;
  constraints: readonly string[];
}>;
function specs(prefix: string, pg: boolean): readonly Spec[] {
  const maximum = pg ? `'${max}'::bigint` : max;
  const jsonField = (path: string) =>
    pg
      ? `(record_json#>>'{${path.split(".").join(",")}}')`
      : `CAST(json_extract(record_json,'$.${path}') AS TEXT)`;
  const matches = Object.entries({
    "account.controlRealmId": "control_realm_id",
    "account.tenantId": "tenant_id",
    "account.spaceId": "space_id",
    "account.principalId": "principal_id",
    "intentId": "intent_id",
    "sequence": "sequence",
    "kind": "kind",
    "revision": "revision",
    "phase": "phase",
    "dispatchAttemptCount": "dispatch_attempt_count",
    "requestDigest": "request_digest",
  })
    .map(
      ([path, column]) =>
        `${jsonField(path)} IS NOT NULL AND ${jsonField(path)}=${pg ? `${column}::text` : `CAST(${column} AS TEXT)`}`,
    )
    .join(" AND ");
  const common = {
    control_realm_id: "text",
    tenant_id: "text",
    space_id: "text",
    principal_id: "text",
  } as const;
  return [
    {
      name: tables[0],
      columns: { id: "integer", version: "integer", control_realm_id: "text" },
      constraints: [
        "PRIMARY KEY (id)",
        "CHECK (id=1)",
        "UNIQUE (control_realm_id)",
      ],
    },
    {
      name: tables[1],
      columns: { ...common, last_sequence: "bigint" },
      constraints: [
        `PRIMARY KEY (${keys.join(",")})`,
        `CHECK (last_sequence>=0 AND last_sequence<=${maximum})`,
        `FOREIGN KEY (control_realm_id) REFERENCES ${prefix}${tables[0]}(control_realm_id) ON DELETE RESTRICT`,
      ],
    },
    {
      name: tables[2],
      columns: {
        ...common,
        intent_id: "text",
        sequence: "bigint",
        kind: "text",
        family_digest: "text",
        revision: "bigint",
        phase: "text",
        dispatch_attempt_count: "bigint",
        request_digest: "text",
        record_json: "jsonb",
      },
      constraints: [
        `PRIMARY KEY (${keys.join(",")},intent_id)`,
        `UNIQUE (${keys.join(",")},sequence)`,
        `CHECK (sequence>=1 AND sequence<=${maximum})`,
        `CHECK (revision>=1 AND revision<=${maximum})`,
        `CHECK (dispatch_attempt_count>=0 AND dispatch_attempt_count<=${maximum})`,
        pg
          ? "CHECK (kind = ANY (ARRAY['generation'::text,'query'::text,'selection'::text]))"
          : "CHECK (kind IN ('generation','query','selection'))",
        pg
          ? "CHECK (phase = ANY (ARRAY['prepared'::text,'dispatched'::text,'accepted'::text,'refused'::text]))"
          : "CHECK (phase IN ('prepared','dispatched','accepted','refused'))",
        `CHECK (${pg ? "jsonb_typeof(record_json)='object' AND octet_length(record_json::text)" : "json_valid(record_json) AND json_type(record_json)='object' AND length(CAST(record_json AS BLOB))"}<=65536 AND ${matches})`,
        `FOREIGN KEY (${keys.join(",")}) REFERENCES ${prefix}${tables[1]}(${keys.join(",")}) ON DELETE RESTRICT`,
      ],
    },
  ];
}
function tableSql(s: Spec, pg: boolean, prefix: string) {
  return `CREATE TABLE ${prefix}${s.name} (${Object.entries(s.columns)
    .map(
      ([k, t]) =>
        `${k} ${pg ? t.toUpperCase() : t === "jsonb" ? "TEXT" : t === "bigint" ? "INTEGER" : t.toUpperCase()} NOT NULL`,
    )
    .join(",")},${s.constraints.join(",")})${pg ? "" : " STRICT"};`;
}
function indexSql(prefix: string) {
  return `CREATE UNIQUE INDEX ${indexName} ON ${prefix}${tables[2]} (${keys.join(",")},family_digest) WHERE phase IN ('prepared','dispatched');`;
}
function triggerName(t: string, a: string) {
  return `${t}_journal_${a}`;
}
function guard(t: string, a: "update" | "delete"): string {
  if (t === tables[0] || (t === tables[1] && a === "delete")) return "TRUE";
  if (t === tables[1])
    return `${keys.map((k) => `NEW.${k}<>OLD.${k}`).join(" OR ")} OR NEW.last_sequence<>OLD.last_sequence+1`;
  if (a === "delete") return "OLD.phase IN ('prepared','dispatched')";
  // Immutable identity/request/audit pin; accepted and refused are terminal, even to a late process.
  return (
    [
      ...keys,
      "intent_id",
      "sequence",
      "kind",
      "family_digest",
      "request_digest",
    ]
      .map((k) => `NEW.${k}<>OLD.${k}`)
      .join(" OR ") +
    " OR NEW.revision<>OLD.revision+1 OR OLD.phase IN ('accepted','refused') OR NEW.dispatch_attempt_count<OLD.dispatch_attempt_count OR NEW.dispatch_attempt_count>OLD.dispatch_attempt_count+1 OR (NEW.phase='dispatched' AND NEW.dispatch_attempt_count<>OLD.dispatch_attempt_count+1) OR (NEW.phase IN ('accepted','refused') AND (OLD.phase<>'dispatched' OR NEW.dispatch_attempt_count<>OLD.dispatch_attempt_count))"
  );
}
const immutableJsonFields = [
  "sourcePin",
  "rawIdempotencyKey",
  "requestJson",
  "createdAt",
];
function jsonGuard(pg: boolean) {
  return immutableJsonFields
    .map((k) =>
      pg
        ? `NEW.record_json->'${k}' IS DISTINCT FROM OLD.record_json->'${k}'`
        : `json_extract(NEW.record_json,'$.${k}') IS NOT json_extract(OLD.record_json,'$.${k}')`,
    )
    .join(" OR ");
}
function fullGuard(t: string, a: "update" | "delete", pg: boolean) {
  return (
    guard(t, a) +
    (t === tables[2] && a === "update" ? ` OR ${jsonGuard(pg)}` : "")
  );
}
function sqliteTrigger(t: string, a: "update" | "delete") {
  return `CREATE TRIGGER ${triggerName(t, a)} BEFORE ${a.toUpperCase()} ON ${t} WHEN ${fullGuard(t, a, false)} BEGIN SELECT RAISE(ABORT,'plugin_ui_intent_immutable'); END;`;
}
function pgBody(t: string, a: "update" | "delete") {
  return `BEGIN IF ${fullGuard(t, a, true)} THEN RAISE EXCEPTION 'plugin_ui_intent_immutable'; END IF; RETURN ${a === "delete" ? "OLD" : "NEW"}; END`;
}
/** SQL formatting may change; string values and boolean grouping may not. */
const canonicalFormatting = (value: string) =>
  value.toLowerCase().replace(/\s/gu, "");
const canonical = (value: string) =>
  normalizeOutsideLiterals(value, canonicalFormatting).replace(/;$/u, "");
// Only PostgreSQL's engine-rendered definitions need its redundant grouping/casts removed.
// Our CHECK definitions contain AND-only predicates; the partial index has one ANY predicate.
// This compatibility path never compares a trigger or function body.
const canonicalPostgresDefinition = (value: string) =>
  normalizeOutsideLiterals(value, (outside) =>
    canonicalFormatting(outside)
      .replace(/"/gu, "")
      .replace(/::(?:text\[\]|text|bigint|integer)/gu, "")
      .replace(/[()]/gu, ""),
  );
function normalizeOutsideLiterals(
  s: string,
  outside: (value: string) => string,
): string {
  const parts: string[] = [];
  let cursor = 0;
  while (cursor < s.length) {
    const quote = s.indexOf("'", cursor);
    if (quote < 0) {
      parts.push(outside(s.slice(cursor)));
      break;
    }
    parts.push(outside(s.slice(cursor, quote)));
    let end = quote + 1;
    for (; end < s.length; end++) {
      if (s[end] === "\\") {
        end++;
      } else if (s[end] === "'") {
        if (s[end + 1] !== "'") break;
        end++;
      }
    }
    if (end >= s.length) throw new Error("plugin_ui_intent_schema_incomplete");
    parts.push(s.slice(quote, end + 1));
    cursor = end + 1;
  }
  return parts.join("");
}
function marker(rows: readonly Record<string, unknown>[]): string {
  const row = rows[0];
  if (
    rows.length !== 1 ||
    row?.id !== 1 ||
    row.version !== 1 ||
    typeof row.control_realm_id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      row.control_realm_id,
    )
  )
    throw new Error("plugin_ui_intent_schema_version_unsupported");
  return row.control_realm_id;
}
function sqliteObjects(db: DatabaseSync) {
  const names = [
      ...tables,
      indexName,
      ...tables.flatMap((t) => [
        triggerName(t, "update"),
        triggerName(t, "delete"),
      ]),
    ],
    params = names.map(() => "?").join(","),
    tableParams = tables.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT name,sql,'main' AS origin FROM main.sqlite_master WHERE name IN (${params}) OR (type='trigger' AND tbl_name IN (${tableParams})) UNION ALL SELECT name,sql,'temp' AS origin FROM temp.sqlite_master WHERE name IN (${params}) OR (type='trigger' AND tbl_name IN (${tableParams}))`,
    )
    .all(...names, ...tables, ...names, ...tables);
}
export function assertSqlitePluginUiIntentSchema(db: DatabaseSync): string {
  const expected = new Map(
    specs("", false).map((s) => [s.name, tableSql(s, false, "")]),
  );
  expected.set(indexName, indexSql(""));
  for (const t of tables)
    for (const a of ["update", "delete"] as const)
      expected.set(triggerName(t, a), sqliteTrigger(t, a));
  const rows = sqliteObjects(db);
  if (
    rows.length !== expected.size ||
    rows.some(
      (r) =>
        r.origin !== "main" ||
        canonical(String(r.sql)) !==
          canonical(expected.get(String(r.name)) ?? ""),
    )
  )
    throw new Error("plugin_ui_intent_schema_incomplete");
  return marker(
    db
      .prepare(`SELECT id,version,control_realm_id FROM ${tables[0]} LIMIT 2`)
      .all(),
  );
}
export function migrateSqlitePluginUiIntentJournal(db: DatabaseSync): string {
  if (sqliteObjects(db).length === 0) {
    for (const s of specs("", false)) db.exec(tableSql(s, false, ""));
    db.prepare(`INSERT INTO ${tables[0]} VALUES(1,1,?)`).run(randomUUID());
    db.exec(indexSql(""));
    for (const t of tables)
      for (const a of ["update", "delete"] as const)
        db.exec(sqliteTrigger(t, a));
  }
  return assertSqlitePluginUiIntentSchema(db);
}
async function pgObjects(client: PoolClient, schema: string) {
  return (
    await client.query(
      "SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=ANY($2::text[])",
      [schema, [...tables, indexName]],
    )
  ).rows;
}
export async function assertPostgresPluginUiIntentSchema(
  client: PoolClient,
  schema: string,
): Promise<string> {
  const prefix = `${creativeProjectSchemaName(schema)}.`;
  if ((await pgObjects(client, schema)).length !== 4)
    throw new Error("plugin_ui_intent_schema_incomplete");
  const realm = marker(
    (
      await client.query(
        `SELECT id,version,control_realm_id FROM ${prefix}${tables[0]} LIMIT 2`,
      )
    ).rows,
  );
  for (const s of specs(prefix, true)) {
    const columns = (
        await client.query(
          "SELECT column_name,data_type,is_nullable FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position",
          [schema, s.name],
        )
      ).rows,
      expected = Object.entries(s.columns);
    if (
      columns.length !== expected.length ||
      columns.some(
        (c, i) =>
          c.column_name !== expected[i]?.[0] ||
          c.data_type !== expected[i]?.[1] ||
          c.is_nullable !== "NO",
      )
    )
      throw new Error("plugin_ui_intent_schema_incomplete");
    const constraints = (
      await client.query(
        "SELECT pg_get_constraintdef(x.oid) AS definition,x.convalidated AS valid,x.condeferrable AS deferred FROM pg_constraint x JOIN pg_class c ON c.oid=x.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2 AND x.contype<>'n'",
        [schema, s.name],
      )
    ).rows;
    if (
      constraints.length !== s.constraints.length ||
      constraints.some((c) => !c.valid || c.deferred) ||
      s.constraints.some(
        (e) =>
          !constraints.some(
            (c) =>
              canonicalPostgresDefinition(String(c.definition)) ===
              canonicalPostgresDefinition(e),
          ),
      )
    )
      throw new Error("plugin_ui_intent_schema_incomplete");
    const triggers = (
      await client.query(
        "SELECT t.tgname AS name,t.tgenabled AS enabled,t.tgtype AS bits,p.prosrc AS body,pn.nspname AS function_schema,l.lanname AS language,pg_get_expr(t.tgqual,t.tgrelid) AS guard FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace pn ON pn.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang WHERE n.nspname=$1 AND c.relname=$2 AND NOT t.tgisinternal",
        [schema, s.name],
      )
    ).rows;
    if (
      triggers.length !== 2 ||
      (["update", "delete"] as const).some(
        (a, i) =>
          !triggers.some(
            (t) =>
              t.name === triggerName(s.name, a) &&
              t.enabled === "O" &&
              t.bits === (i === 0 ? 19 : 11) &&
              t.function_schema === schema &&
              t.language === "plpgsql" &&
              t.guard === null &&
              canonical(String(t.body)) === canonical(pgBody(s.name, a)),
          ),
      )
    )
      throw new Error("plugin_ui_intent_schema_incomplete");
  }
  const indexes = (
    await client.query(
      "SELECT pg_get_indexdef(i.indexrelid) AS definition,i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2",
      [schema, indexName],
    )
  ).rows;
  // PostgreSQL renders IN as = ANY(ARRAY[...]); compare its stable structural parts.
  const expectedIndex = `CREATE UNIQUE INDEX ${indexName} ON ${prefix}${tables[2]} USING btree (${keys.join(",")},family_digest) WHERE (phase = ANY (ARRAY['prepared'::text, 'dispatched'::text]))`;
  if (
    indexes.length !== 1 ||
    !indexes[0]?.valid ||
    canonicalPostgresDefinition(String(indexes[0].definition)) !==
      canonicalPostgresDefinition(expectedIndex)
  )
    throw new Error("plugin_ui_intent_schema_incomplete");
  return realm;
}
export async function migratePostgresPluginUiIntentJournal(
  client: PoolClient,
  schema: string,
): Promise<string> {
  const prefix = `${creativeProjectSchemaName(schema)}.`;
  if ((await pgObjects(client, schema)).length === 0) {
    for (const s of specs(prefix, true))
      await client.query(tableSql(s, true, prefix));
    await client.query(`INSERT INTO ${prefix}${tables[0]} VALUES(1,1,$1)`, [
      randomUUID(),
    ]);
    await client.query(indexSql(prefix));
    for (const t of tables)
      for (const a of ["update", "delete"] as const) {
        const name = triggerName(t, a);
        await client.query(
          `CREATE FUNCTION ${prefix}${name}() RETURNS trigger LANGUAGE plpgsql AS $$ ${pgBody(t, a)} $$;`,
        );
        await client.query(
          `CREATE TRIGGER ${name} BEFORE ${a.toUpperCase()} ON ${prefix}${t} FOR EACH ROW EXECUTE FUNCTION ${prefix}${name}();`,
        );
      }
  }
  return assertPostgresPluginUiIntentSchema(client, schema);
}
