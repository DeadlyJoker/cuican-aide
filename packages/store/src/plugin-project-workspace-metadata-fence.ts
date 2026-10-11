import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import type { PluginProjectWorkspaceOwner } from "@crewon/domain";
import {
  hasSqlitePluginProjectMetadataOwnerSchema,
  hasPostgresPluginProjectMetadataOwnerSchema,
  PLUGIN_PROJECT_METADATA_OWNER_TABLE as table,
} from "./plugin-project-metadata-owner-schema.ts";
import { decodePluginProjectMetadataOwnerRecord } from "./plugin-project-metadata-owner-records.ts";
import { pluginInstallationSchemaName } from "./plugin-installation-schema.ts";

function assertOwner(
  row: Record<string, unknown> | undefined,
  owner: PluginProjectWorkspaceOwner,
): void {
  // Preserve the original legacy namespace path; absence never establishes metadata ownership.
  if (row === undefined) return;
  if (typeof row.stored_principal !== "string")
    throw new Error("plugin_project_workspace_metadata_owner_conflict");
  try {
    decodePluginProjectMetadataOwnerRecord(row, {
      expectedOwner: owner,
      storedProjectPrincipalId: row.stored_principal,
    });
  } catch {
    throw new Error("plugin_project_workspace_metadata_owner_conflict");
  }
}

/** Same namespace transaction: a protected project's immutable owner must match the live Host owner. */
export function assertSqlitePluginProjectWorkspaceMetadata(
  db: DatabaseSync,
  owner: PluginProjectWorkspaceOwner,
): void {
  if (!hasSqlitePluginProjectMetadataOwnerSchema(db)) return;
  assertOwner(
    db
      .prepare(
        `SELECT o.*,p.owner_principal_id AS stored_principal FROM ${table} o LEFT JOIN creative_projects p ON p.tenant_id=o.tenant_id AND p.space_id=o.space_id AND p.project_id=o.project_id WHERE o.tenant_id=? AND o.space_id=? AND o.project_id=?`,
      )
      .get(owner.tenantId, owner.spaceId, owner.projectId),
    owner,
  );
}

export async function assertPostgresPluginProjectWorkspaceMetadata(
  client: PoolClient,
  schema: string,
  owner: PluginProjectWorkspaceOwner,
): Promise<void> {
  if (!(await hasPostgresPluginProjectMetadataOwnerSchema(client, schema)))
    return;
  const prefix = `${pluginInstallationSchemaName(schema)}.`;
  const result = await client.query(
    `SELECT o.*,p.owner_principal_id AS stored_principal FROM ${prefix}${table} o LEFT JOIN ${prefix}creative_projects p ON p.tenant_id=o.tenant_id AND p.space_id=o.space_id AND p.project_id=o.project_id WHERE o.tenant_id=$1 AND o.space_id=$2 AND o.project_id=$3 FOR SHARE OF o`,
    [owner.tenantId, owner.spaceId, owner.projectId],
  );
  assertOwner(result.rows[0], owner);
}
