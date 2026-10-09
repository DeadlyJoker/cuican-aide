import { PLUGIN_COMPOSITION_LOCK_LIMITS } from "@crewon/contracts/plugins";
import { pluginInstallationSchemaName } from "./plugin-installation-schema.ts";

export function pluginCompositionSchemaSql(
  input: { dialect: "sqlite" } | { dialect: "postgres"; schema: string },
): string {
  const pg = input.dialect === "postgres",
    prefix = pg ? `${pluginInstallationSchemaName(input.schema)}.` : "";
  const integer = pg ? "BIGINT" : "INTEGER",
    json = "TEXT",
    strict = pg ? "" : " STRICT";
  const scope =
    "tenant_id TEXT NOT NULL,space_id TEXT NOT NULL,profile_id TEXT NOT NULL";
  const value = (path: string[]) =>
    pg
      ? `(lock_json::jsonb#>>'{${path.join(",")}}')`
      : `json_extract(lock_json,'$.${path.join(".")}')`;
  const identity = [
    ["tenantId", "tenant_id"],
    ["spaceId", "space_id"],
    ["profileId", "profile_id"],
    ["authorityEpoch", "authority_epoch"],
  ]
    .map(
      ([key, column]) =>
        `${value(["scope", key!])} IS NOT NULL AND ${value(["scope", key!])}=${column}`,
    )
    .join(" AND ");
  const revision = `revision ${integer} NOT NULL CHECK(revision>=1 AND revision<=9007199254740991)`;
  const valid = pg
    ? `jsonb_typeof(lock_json::jsonb)='object' AND octet_length(lock_json)<=${PLUGIN_COMPOSITION_LOCK_LIMITS.bytes}`
    : `json_valid(lock_json) AND json_type(lock_json)='object' AND length(CAST(lock_json AS BLOB))<=${PLUGIN_COMPOSITION_LOCK_LIMITS.bytes}`;
  return `
CREATE TABLE IF NOT EXISTS ${prefix}plugin_composition_schema_version(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL CHECK(version>=1))${strict};
CREATE TABLE IF NOT EXISTS ${prefix}plugin_composition_locks(
 ${scope},authority_epoch TEXT NOT NULL,${revision},lock_digest TEXT NOT NULL,actor_id TEXT NOT NULL,principal_id TEXT NOT NULL,
 lock_json ${json} NOT NULL CHECK(${valid} AND ${identity} AND ${value(["schemaVersion"])} IS NOT NULL AND ${value(["schemaVersion"])}='crewon.plugin-composition-lock.v1' AND ${value(["lockDigest"])} IS NOT NULL AND ${value(["lockDigest"])}=lock_digest AND ${value(["revision"])} IS NOT NULL AND CAST(${value(["revision"])} AS TEXT)=CAST(revision AS TEXT)),
 PRIMARY KEY(tenant_id,space_id,profile_id,revision),UNIQUE(tenant_id,space_id,profile_id,lock_digest),UNIQUE(tenant_id,space_id,profile_id,revision,lock_digest)
)${strict};
CREATE TABLE IF NOT EXISTS ${prefix}plugin_composition_heads(
 ${scope},${revision},lock_digest TEXT NOT NULL,PRIMARY KEY(tenant_id,space_id,profile_id),
 FOREIGN KEY(tenant_id,space_id,profile_id,revision,lock_digest) REFERENCES ${prefix}plugin_composition_locks(tenant_id,space_id,profile_id,revision,lock_digest)
)${strict};
${
  pg
    ? `CREATE OR REPLACE FUNCTION ${prefix}reject_composition_lock_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'plugin_composition_lock_immutable'; END $$;
DROP TRIGGER IF EXISTS plugin_composition_lock_immutable ON ${prefix}plugin_composition_locks;
CREATE TRIGGER plugin_composition_lock_immutable BEFORE UPDATE OR DELETE ON ${prefix}plugin_composition_locks FOR EACH ROW EXECUTE FUNCTION ${prefix}reject_composition_lock_change();`
    : `CREATE TRIGGER IF NOT EXISTS plugin_composition_lock_no_update BEFORE UPDATE ON plugin_composition_locks BEGIN SELECT RAISE(ABORT,'plugin_composition_lock_immutable'); END;
CREATE TRIGGER IF NOT EXISTS plugin_composition_lock_no_delete BEFORE DELETE ON plugin_composition_locks BEGIN SELECT RAISE(ABORT,'plugin_composition_lock_immutable'); END;`
}
INSERT INTO ${prefix}plugin_composition_schema_version(id,version) VALUES(1,1) ON CONFLICT(id) DO NOTHING;
`;
}
