import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";

export const PLUGIN_INSTALLATION_SCHEMA_VERSION = 1;

export function pluginInstallationSchemaName(value: string): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_]{0,62}$/u.test(value))
    throw new Error("plugin_installation_schema_invalid");
  return `"${value}"`;
}

const immutableTables = [
  "installed_plugin_packages",
  "plugin_installation_receipts",
] as const;

export function pluginInstallationSchemaSql(
  input: { dialect: "sqlite" } | { dialect: "postgres"; schema: string },
): string {
  const pg = input.dialect === "postgres";
  const prefix = pg ? `${pluginInstallationSchemaName(input.schema)}.` : "";
  const json = pg ? "JSONB" : "TEXT";
  const integer = pg ? "BIGINT" : "INTEGER";
  const strict = pg ? "" : " STRICT";
  const ordinal = pg ? ' COLLATE "C"' : " COLLATE BINARY";
  const value = (column: string, key: string) =>
    pg ? `(${column}->>'${key}')` : `json_extract(${column}, '$.${key}')`;
  const valid = (column: string, max: number) =>
    pg
      ? `jsonb_typeof(${column})='object' AND octet_length(${column}::text)<=${max}`
      : `json_valid(${column}) AND json_type(${column})='object' AND length(CAST(${column} AS BLOB))<=${max}`;
  const matches = (column: string, fields: Record<string, string>) =>
    Object.entries(fields)
      .map(
        ([key, sql]) =>
          `${value(column, key)} IS NOT NULL AND CAST(${value(column, key)} AS TEXT)=CAST(${sql} AS TEXT)`,
      )
      .join(" AND ");
  const scope =
    "tenant_id TEXT NOT NULL,space_id TEXT NOT NULL,profile_id TEXT NOT NULL";
  const fields = {
    tenantId: "tenant_id",
    spaceId: "space_id",
    profileId: "profile_id",
    pluginId: "plugin_id",
    publisherId: "publisher_id",
  };
  return `
    CREATE TABLE IF NOT EXISTS ${prefix}installed_plugin_packages (
      ${scope}, plugin_id TEXT NOT NULL,version TEXT NOT NULL,publisher_id TEXT NOT NULL,
      package_digest TEXT NOT NULL,
      record_json ${json} NOT NULL CHECK (${valid("record_json", 8192)} AND ${matches("record_json", { ...fields, version: "version", packageDigest: "package_digest" })}),
      PRIMARY KEY (tenant_id,space_id,profile_id,plugin_id,version),
      UNIQUE (tenant_id,space_id,profile_id,package_digest),
      UNIQUE (tenant_id,space_id,profile_id,plugin_id,package_digest,publisher_id)
    )${strict};
    CREATE TABLE IF NOT EXISTS ${prefix}plugin_profile_selections (
      ${scope},plugin_id TEXT NOT NULL,publisher_id TEXT NOT NULL,
      revision ${integer} NOT NULL CHECK (revision>=1 AND revision<=9007199254740991),
      state TEXT NOT NULL CHECK (state IN ('enabled','disabled','uninstalled')),
      selected_package_digest TEXT,
      record_json ${json} NOT NULL CHECK (${valid("record_json", 8192)} AND ${matches("record_json", { ...fields, revision: "revision", state: "state" })}
        AND ((selected_package_digest IS NULL AND ${value("record_json", "selectedPackageDigest")} IS NULL) OR (${value("record_json", "selectedPackageDigest")} IS NOT NULL AND CAST(${value("record_json", "selectedPackageDigest")} AS TEXT)=selected_package_digest))),
      CHECK ((state='uninstalled' AND selected_package_digest IS NULL) OR (state IN ('enabled','disabled') AND selected_package_digest IS NOT NULL)),
      PRIMARY KEY (tenant_id,space_id,profile_id,plugin_id),
      FOREIGN KEY (tenant_id,space_id,profile_id,plugin_id,selected_package_digest,publisher_id)
        REFERENCES ${prefix}installed_plugin_packages (tenant_id,space_id,profile_id,plugin_id,package_digest,publisher_id) ON DELETE RESTRICT
    )${strict};
    CREATE INDEX IF NOT EXISTS plugin_profile_selections_page ON ${prefix}plugin_profile_selections
      (tenant_id,space_id,profile_id,plugin_id${ordinal});
    CREATE TABLE IF NOT EXISTS ${prefix}plugin_installation_receipts (
      ${scope},principal_id TEXT NOT NULL,actor_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('install','select')),
      idempotency_key TEXT NOT NULL,request_digest TEXT NOT NULL,plugin_id TEXT NOT NULL,
      result_json ${json} NOT NULL CHECK (${valid("result_json", 32768)}),
      PRIMARY KEY (tenant_id,space_id,profile_id,principal_id,actor_id,kind,idempotency_key),
      FOREIGN KEY (tenant_id,space_id,profile_id,plugin_id)
        REFERENCES ${prefix}plugin_profile_selections (tenant_id,space_id,profile_id,plugin_id) ON DELETE RESTRICT
    )${strict};
  `;
}

export function assertPluginInstallationSchemaVersion(
  rows: readonly { id: unknown; version: unknown }[],
): void {
  if (
    rows.length !== 1 ||
    rows[0]!.id !== 1 ||
    rows[0]!.version !== PLUGIN_INSTALLATION_SCHEMA_VERSION
  )
    throw new Error("plugin_installation_schema_version_unsupported");
}

/** Independent migration; the host's core and business versions are untouched. */
export function migrateSqlitePluginInstallation(database: DatabaseSync): void {
  database.exec(`CREATE TABLE IF NOT EXISTS plugin_installation_schema_version (id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL) STRICT;
    INSERT INTO plugin_installation_schema_version VALUES(1,1) ON CONFLICT(id) DO NOTHING;`);
  assertPluginInstallationSchemaVersion(
    database
      .prepare(
        "SELECT id,version FROM plugin_installation_schema_version LIMIT 2",
      )
      .all() as { id: unknown; version: unknown }[],
  );
  database.exec(pluginInstallationSchemaSql({ dialect: "sqlite" }));
  for (const table of immutableTables)
    for (const action of ["UPDATE", "DELETE"] as const)
      database.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_${action.toLowerCase()} BEFORE ${action} ON ${table}
        BEGIN SELECT RAISE(ABORT,'plugin_installation_history_immutable'); END;`);
  database.exec(`CREATE TRIGGER IF NOT EXISTS plugin_profile_selections_no_delete BEFORE DELETE ON plugin_profile_selections
    BEGIN SELECT RAISE(ABORT,'plugin_installation_identity_immutable'); END;
    CREATE TRIGGER IF NOT EXISTS plugin_profile_selections_identity_immutable BEFORE UPDATE ON plugin_profile_selections
    WHEN ${selectionIdentityPredicate("sqlite")}
    BEGIN SELECT RAISE(ABORT,'plugin_installation_identity_immutable'); END;`);
  for (const statement of schemaReads("")) database.prepare(statement).all();
  for (const table of [...immutableTables, "plugin_profile_selections"]) {
    const count = database
      .prepare(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND tbl_name=? AND name IN (?,?)",
      )
      .get(
        table,
        table === "plugin_profile_selections"
          ? `${table}_identity_immutable`
          : `${table}_no_update`,
        `${table}_no_delete`,
      );
    if (count?.n !== 2)
      throw new Error("plugin_installation_schema_incomplete");
  }
}

export async function migratePostgresPluginInstallation(
  client: PoolClient,
  schema: string,
): Promise<void> {
  const prefix = `${pluginInstallationSchemaName(schema)}.`;
  await client.query(`CREATE TABLE IF NOT EXISTS ${prefix}plugin_installation_schema_version (id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL);
    INSERT INTO ${prefix}plugin_installation_schema_version VALUES(1,1) ON CONFLICT(id) DO NOTHING;`);
  assertPluginInstallationSchemaVersion(
    (
      await client.query<{ id: unknown; version: unknown }>(
        `SELECT id,version FROM ${prefix}plugin_installation_schema_version LIMIT 2`,
      )
    ).rows,
  );
  await client.query(
    pluginInstallationSchemaSql({ dialect: "postgres", schema }),
  );
  await client.query(`CREATE OR REPLACE FUNCTION ${prefix}plugin_installation_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'plugin_installation_history_immutable'; END; $$;`);
  for (const table of immutableTables)
    await client.query(`CREATE OR REPLACE TRIGGER ${table}_no_update_or_delete BEFORE UPDATE OR DELETE ON ${prefix}${table}
      FOR EACH ROW EXECUTE FUNCTION ${prefix}plugin_installation_history_immutable();`);
  await client.query(`CREATE OR REPLACE FUNCTION ${prefix}plugin_profile_selection_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'plugin_installation_identity_immutable'; END IF;
      IF ${selectionIdentityPredicate("postgres")} THEN RAISE EXCEPTION 'plugin_installation_identity_immutable'; END IF;
      RETURN NEW;
    END; $$;
    CREATE OR REPLACE TRIGGER plugin_profile_selections_identity_immutable BEFORE UPDATE OR DELETE ON ${prefix}plugin_profile_selections
      FOR EACH ROW EXECUTE FUNCTION ${prefix}plugin_profile_selection_identity_immutable();`);
  for (const statement of schemaReads(prefix)) await client.query(statement);
}

function selectionIdentityPredicate(dialect: "sqlite" | "postgres") {
  const distinct = dialect === "postgres" ? "IS DISTINCT FROM" : "IS NOT";
  const value = (side: string, key: string) =>
    dialect === "postgres"
      ? `(${side}.record_json->>'${key}')`
      : `json_extract(${side}.record_json,'$.${key}')`;
  return [
    ...["tenant_id", "space_id", "profile_id", "plugin_id", "publisher_id"].map(
      (column) => `NEW.${column} ${distinct} OLD.${column}`,
    ),
    `${value("NEW", "schemaVersion")} ${distinct} ${value("OLD", "schemaVersion")}`,
  ].join(" OR ");
}

function schemaReads(prefix: string) {
  return [
    `SELECT tenant_id,space_id,profile_id,plugin_id,version,publisher_id,package_digest,record_json FROM ${prefix}installed_plugin_packages LIMIT 0`,
    `SELECT tenant_id,space_id,profile_id,plugin_id,publisher_id,revision,state,selected_package_digest,record_json FROM ${prefix}plugin_profile_selections LIMIT 0`,
    `SELECT tenant_id,space_id,profile_id,principal_id,actor_id,kind,idempotency_key,request_digest,plugin_id,result_json FROM ${prefix}plugin_installation_receipts LIMIT 0`,
  ];
}
