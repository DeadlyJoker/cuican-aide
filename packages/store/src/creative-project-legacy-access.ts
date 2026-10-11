import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import {
  validateCreativeProjectScope,
  type CreativeProjectScope,
} from "@crewon/domain";
import { creativeProjectSchemaName } from "./creative-project-schema.ts";
import {
  PLUGIN_PROJECT_METADATA_OWNER_TABLE,
  hasPostgresPluginProjectMetadataOwnerSchema,
  hasSqlitePluginProjectMetadataOwnerSchema,
} from "./plugin-project-metadata-owner-schema.ts";

/** Negative legacy-access filters, never qualifications for protected reads or writes. */
export type CreativeProjectLegacyAccess = Readonly<{
  predicate(alias: string): string;
  assertProject(scope: CreativeProjectScope): void;
}>;
export type PostgresCreativeProjectLegacyAccess = Readonly<{
  predicate(alias: string): string;
  assertProject(scope: CreativeProjectScope): Promise<void>;
}>;

function predicate(present: boolean, prefix: string, alias: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(alias))
    throw new Error("creative_project_legacy_alias_invalid");
  return present
    ? `NOT EXISTS(SELECT 1 FROM ${prefix}${PLUGIN_PROJECT_METADATA_OWNER_TABLE} legacy_metadata_owner WHERE legacy_metadata_owner.tenant_id=${alias}.tenant_id AND legacy_metadata_owner.space_id=${alias}.space_id AND legacy_metadata_owner.project_id=${alias}.project_id)`
    : "TRUE";
}

/** Capture within the original SQLite snapshot; never cache absence across operations. */
export function captureSqliteCreativeProjectLegacyAccess(
  db: DatabaseSync,
): CreativeProjectLegacyAccess {
  const present = hasSqlitePluginProjectMetadataOwnerSchema(db);
  return Object.freeze({
    predicate: (alias: string) => predicate(present, "main.", alias),
    assertProject(input: CreativeProjectScope): void {
      const scope = validateCreativeProjectScope(input);
      if (
        present &&
        db
          .prepare(
            `SELECT 1 FROM main.${PLUGIN_PROJECT_METADATA_OWNER_TABLE} WHERE tenant_id=? AND space_id=? AND project_id=?`,
          )
          .get(scope.tenantId, scope.spaceId, scope.projectId) !== undefined
      )
        throw new Error("creative_project_not_found");
    },
  });
}

/** After the shared schema lock, capture in the caller's original READ COMMITTED transaction. No DDL or pool acquisition. */
export async function capturePostgresCreativeProjectLegacyAccess(
  client: PoolClient,
  schema: string,
): Promise<PostgresCreativeProjectLegacyAccess> {
  const prefix = `${creativeProjectSchemaName(schema)}.`;
  const present = await hasPostgresPluginProjectMetadataOwnerSchema(
    client,
    schema,
  );
  return Object.freeze({
    predicate: (alias: string) => predicate(present, prefix, alias),
    async assertProject(input: CreativeProjectScope): Promise<void> {
      const scope = validateCreativeProjectScope(input);
      if (
        present &&
        (
          await client.query(
            `SELECT 1 FROM ${prefix}${PLUGIN_PROJECT_METADATA_OWNER_TABLE} WHERE tenant_id=$1 AND space_id=$2 AND project_id=$3`,
            [scope.tenantId, scope.spaceId, scope.projectId],
          )
        ).rowCount !== 0
      )
        throw new Error("creative_project_not_found");
    },
  });
}

export function assertSqliteCreativeProjectLegacyAccess(
  db: DatabaseSync,
  scope: CreativeProjectScope,
): void {
  captureSqliteCreativeProjectLegacyAccess(db).assertProject(scope);
}
export async function assertPostgresCreativeProjectLegacyAccess(
  client: PoolClient,
  schema: string,
  scope: CreativeProjectScope,
): Promise<void> {
  await (
    await capturePostgresCreativeProjectLegacyAccess(client, schema)
  ).assertProject(scope);
}

/** Actual caller-owned READ COMMITTED transaction only; never changes its isolation or commits it. */
export async function lockPostgresCreativeProjectLegacySchema(
  client: PoolClient,
  schema: string,
): Promise<void> {
  creativeProjectSchemaName(schema);
  // A fixed SAVEPOINT is accepted only inside the caller's actual transaction
  // block, including READ ONLY. XID assignment cannot prove read-only blocks.
  try {
    await client.query("SAVEPOINT crewon_legacy_metadata_schema");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "25P01")
      throw new Error("creative_project_legacy_transaction_required", {
        cause: error,
      });
    throw error;
  }
  const isolation = await client.query("SHOW transaction_isolation");
  if (isolation.rows[0]?.transaction_isolation !== "read committed")
    throw new Error("creative_project_legacy_isolation_invalid");
  await client.query(
    "SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))",
    [JSON.stringify(["plugin_project_metadata_owner_schema_version", schema])],
  );
  // Releasing the subtransaction retains its xact lock until outer COMMIT.
  await client.query("RELEASE SAVEPOINT crewon_legacy_metadata_schema");
}
