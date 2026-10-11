import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import { pluginInstallationSchemaName } from "./plugin-installation-schema.ts";

export const PLUGIN_PROJECT_WORKSPACE_TABLE =
  "plugin_project_workspace_namespaces";
const VERSION_TABLE = "plugin_project_workspace_schema_version";
const objects = [VERSION_TABLE, PLUGIN_PROJECT_WORKSPACE_TABLE] as const;
const columns = [
  "tenant_id",
  "space_id",
  "principal_id",
  "actor_id",
  "profile_id",
  "plugin_id",
  "publisher_id",
  "project_id",
  "workspace_id",
  "created_at",
  "record_json",
] as const;
const triggerName = "plugin_project_workspace_namespace_immutable";
export function pluginProjectWorkspaceSql(
  dialect: "sqlite" | "postgres",
  schema = "public",
): string {
  const p =
    dialect === "sqlite" ? "" : `${pluginInstallationSchemaName(schema)}.`;
  const json = dialect === "sqlite" ? "TEXT" : "JSONB";
  const strict = dialect === "sqlite" ? " STRICT" : "";
  const valid =
    dialect === "sqlite"
      ? "json_valid(record_json) AND length(CAST(record_json AS BLOB))<=4096"
      : "jsonb_typeof(record_json)='object' AND octet_length(record_json::text)<=4096";
  return `CREATE TABLE ${p}${VERSION_TABLE}(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL CHECK(version=1))${strict};
    INSERT INTO ${p}${VERSION_TABLE} VALUES(1,1);
    CREATE TABLE ${p}${PLUGIN_PROJECT_WORKSPACE_TABLE}(
      tenant_id TEXT NOT NULL,space_id TEXT NOT NULL,principal_id TEXT NOT NULL,actor_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,plugin_id TEXT NOT NULL,publisher_id TEXT NOT NULL,project_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL,record_json ${json} NOT NULL CHECK(${valid}),
      PRIMARY KEY(tenant_id,space_id,principal_id,actor_id,profile_id,plugin_id,publisher_id,project_id)
    )${strict};`;
}
function invalid(): never {
  throw new Error("plugin_project_workspace_schema_invalid");
}
function version(rows: readonly { id: unknown; version: unknown }[]): void {
  if (
    rows.length !== 1 ||
    Number(rows[0]!.id) !== 1 ||
    Number(rows[0]!.version) !== 1
  )
    invalid();
}
/** Absent only when no object exists. Partial/unknown schemas never degrade to an ordinary workspace. */
export function hasSqlitePluginProjectWorkspaceSchema(
  db: DatabaseSync,
): boolean {
  const found = db
    .prepare(
      "SELECT name,type FROM main.sqlite_schema WHERE name IN (?,?) UNION ALL SELECT name,type FROM temp.sqlite_schema WHERE name IN (?,?)",
    )
    .all(...objects, ...objects);
  if (found.length === 0) return false;
  if (
    found.length !== 2 ||
    objects.some(
      (name) => !found.some((row) => row.name === name && row.type === "table"),
    )
  )
    invalid();
  version(
    db.prepare(`SELECT id,version FROM ${VERSION_TABLE} LIMIT 2`).all() as {
      id: unknown;
      version: unknown;
    }[],
  );
  const info = db
    .prepare(`PRAGMA main.table_info(${PLUGIN_PROJECT_WORKSPACE_TABLE})`)
    .all();
  if (
    info.length !== columns.length ||
    columns.some((name, index) => info[index]?.name !== name)
  )
    invalid();
  const sql = db
    .prepare("SELECT sql FROM main.sqlite_schema WHERE name=?")
    .get(PLUGIN_PROJECT_WORKSPACE_TABLE)?.sql;
  if (
    typeof sql !== "string" ||
    !/workspace_id\s+TEXT\s+NOT\s+NULL\s+UNIQUE/iu.test(sql) ||
    !/PRIMARY KEY\(tenant_id,space_id,principal_id,actor_id,profile_id,plugin_id,publisher_id,project_id\)/iu.test(
      sql,
    )
  )
    invalid();
  const trigger = db
    .prepare(
      "SELECT sql FROM main.sqlite_schema WHERE name=? AND type='trigger' AND tbl_name=?",
    )
    .get(triggerName, PLUGIN_PROJECT_WORKSPACE_TABLE)?.sql;
  const deletion = db
    .prepare(
      "SELECT sql FROM main.sqlite_schema WHERE name=? AND type='trigger' AND tbl_name=?",
    )
    .get(`${triggerName}_no_delete`, PLUGIN_PROJECT_WORKSPACE_TABLE)?.sql;
  if (
    typeof trigger !== "string" ||
    !trigger.includes("BEFORE UPDATE") ||
    !trigger.includes("RAISE(ABORT,'plugin_project_workspace_immutable')") ||
    typeof deletion !== "string" ||
    !deletion.includes("BEFORE DELETE") ||
    !deletion.includes("RAISE(ABORT,'plugin_project_workspace_immutable')")
  )
    invalid();
  return true;
}
export function migrateSqlitePluginProjectWorkspaces(db: DatabaseSync): void {
  if (hasSqlitePluginProjectWorkspaceSchema(db)) return;
  db.exec(`${pluginProjectWorkspaceSql("sqlite")}
    CREATE TRIGGER ${triggerName} BEFORE UPDATE ON ${PLUGIN_PROJECT_WORKSPACE_TABLE} BEGIN SELECT RAISE(ABORT,'plugin_project_workspace_immutable'); END;
    CREATE TRIGGER ${triggerName}_no_delete BEFORE DELETE ON ${PLUGIN_PROJECT_WORKSPACE_TABLE} BEGIN SELECT RAISE(ABORT,'plugin_project_workspace_immutable'); END;`);
  hasSqlitePluginProjectWorkspaceSchema(db);
}
export async function hasPostgresPluginProjectWorkspaceSchema(
  c: PoolClient,
  schema: string,
): Promise<boolean> {
  const p = `${pluginInstallationSchemaName(schema)}.`;
  const found = (
    await c.query<{ relname: string; relkind: string }>(
      "SELECT cl.relname,cl.relkind FROM pg_catalog.pg_class cl JOIN pg_catalog.pg_namespace n ON n.oid=cl.relnamespace WHERE n.nspname=$1 AND cl.relname=ANY($2::text[])",
      [schema, objects],
    )
  ).rows;
  if (found.length === 0) return false;
  if (
    found.length !== 2 ||
    objects.some(
      (name) =>
        !found.some((row) => row.relname === name && row.relkind === "r"),
    )
  )
    invalid();
  version(
    (
      await c.query<{ id: unknown; version: unknown }>(
        `SELECT id,version FROM ${p}${VERSION_TABLE} LIMIT 2`,
      )
    ).rows,
  );
  const info = (
    await c.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position",
      [schema, PLUGIN_PROJECT_WORKSPACE_TABLE],
    )
  ).rows;
  if (
    info.length !== columns.length ||
    columns.some((name, index) => info[index]?.column_name !== name)
  )
    invalid();
  const constraints = (
    await c.query<{ kind: string; definition: string }>(
      "SELECT x.contype AS kind,pg_get_constraintdef(x.oid) AS definition FROM pg_catalog.pg_constraint x JOIN pg_catalog.pg_class cl ON cl.oid=x.conrelid JOIN pg_catalog.pg_namespace n ON n.oid=cl.relnamespace WHERE n.nspname=$1 AND cl.relname=$2 AND x.contype IN ('p','u')",
      [schema, PLUGIN_PROJECT_WORKSPACE_TABLE],
    )
  ).rows;
  if (
    constraints.length !== 2 ||
    !constraints.some(
      (row) => row.kind === "u" && row.definition === "UNIQUE (workspace_id)",
    ) ||
    !constraints.some(
      (row) =>
        row.kind === "p" &&
        row.definition === `PRIMARY KEY (${columns.slice(0, 8).join(", ")})`,
    )
  )
    invalid();
  const triggers = (
    await c.query<{
      name: string;
      enabled: string;
      bits: number;
      body: string;
    }>(
      "SELECT t.tgname AS name,t.tgenabled AS enabled,t.tgtype AS bits,p.prosrc AS body FROM pg_trigger t JOIN pg_class cl ON cl.oid=t.tgrelid JOIN pg_namespace n ON n.oid=cl.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid WHERE n.nspname=$1 AND cl.relname=$2 AND NOT t.tgisinternal AND t.tgname=$3",
      [schema, PLUGIN_PROJECT_WORKSPACE_TABLE, triggerName],
    )
  ).rows;
  if (
    triggers.length !== 1 ||
    triggers[0]!.enabled !== "O" ||
    Number(triggers[0]!.bits) !== 27 ||
    !triggers[0]!.body.includes(
      "RAISE EXCEPTION 'plugin_project_workspace_immutable'",
    )
  )
    invalid();
  return true;
}
export async function migratePostgresPluginProjectWorkspaces(
  c: PoolClient,
  schema: string,
): Promise<void> {
  if (await hasPostgresPluginProjectWorkspaceSchema(c, schema)) return;
  const p = `${pluginInstallationSchemaName(schema)}.`;
  await c.query(`${pluginProjectWorkspaceSql("postgres", schema)}
    CREATE FUNCTION ${p}${triggerName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'plugin_project_workspace_immutable'; END; $$;
    CREATE TRIGGER ${triggerName} BEFORE UPDATE OR DELETE ON ${p}${PLUGIN_PROJECT_WORKSPACE_TABLE} FOR EACH ROW EXECUTE FUNCTION ${p}${triggerName}();`);
  await hasPostgresPluginProjectWorkspaceSchema(c, schema);
}
