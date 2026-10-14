import { decodeConversation } from "./project-conversation-store-support.ts";
import {
  assertSqlitePluginProjectWorkspaceBinding,
  assertPostgresPluginProjectWorkspaceBinding,
} from "./plugin-project-workspace-thread-fence.ts";
import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import type { qualifyPluginProjectReadScope } from "@crewon/application";
import { parsePluginProjectWorkspaceOwner } from "@crewon/domain";
import {
  PROJECT_ASSET_V2_ACTIONS,
  parseProjectAssetV2Request,
} from "@crewon/contracts/project-assets-v2";
import {
  hasSqlitePluginProjectWorkspaceSchema,
  hasPostgresPluginProjectWorkspaceSchema,
  PLUGIN_PROJECT_WORKSPACE_TABLE,
} from "./plugin-project-workspace-schema.ts";
import {
  decodeNamespace,
  namespaceProjectValues,
  namespaceProjectWhere,
  pluginProjectNamespaceLock,
  pluginProjectWorkspaceLock,
} from "./plugin-project-workspace-store-support.ts";
import { advisoryLock } from "./postgres-thread-lock.ts";
import { pluginInstallationSchemaName } from "./plugin-installation-schema.ts";

type Source = ReturnType<typeof qualifyPluginProjectReadScope>;
function owner(source: Source) {
  const actions = new Set<string>([
    PROJECT_ASSET_V2_ACTIONS.getAsset,
    PROJECT_ASSET_V2_ACTIONS.getRevision,
    PROJECT_ASSET_V2_ACTIONS.getReferenceRevision,
    PROJECT_ASSET_V2_ACTIONS.listAssets,
    PROJECT_ASSET_V2_ACTIONS.listRevisions,
    PROJECT_ASSET_V2_ACTIONS.listReferences,
  ]);
  if (!actions.has(source.request.action)) return undefined;
  if (source.purpose !== "read") denied();
  const request = parseProjectAssetV2Request(source.request);
  return parsePluginProjectWorkspaceOwner({
    ...source.scope,
    projectId: request.input.projectId,
  });
}

/** Called only inside the original qualified read transaction. Metadata-only
 * V2 reads retain the same exact namespace as the project conversation; the
 * immutable full metadata owner is independently rechecked by the existing
 * access.assertProject. Ordinary unqualified readers never enter this path.
 */
export function assertSqliteProjectAssetUiReadNamespace(
  db: DatabaseSync,
  source: Source,
): void {
  const expected = owner(source);
  if (!expected) return;
  if (!hasSqlitePluginProjectWorkspaceSchema(db)) denied();
  const rows = db
    .prepare(
      `SELECT * FROM ${PLUGIN_PROJECT_WORKSPACE_TABLE} WHERE ${namespaceProjectWhere} LIMIT 2`,
    )
    .all(...namespaceProjectValues(expected));
  if (rows.length !== 1 || decodeNamespace(rows[0], expected) === null)
    denied();
  if (
    db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_conversation_bindings'",
      )
      .get()
  ) {
    const row = db
      .prepare(
        "SELECT * FROM project_conversation_bindings WHERE tenant_id=? AND space_id=? AND profile_id=? AND project_id=? AND state='active' ORDER BY thread_id LIMIT 1",
      )
      .get(
        expected.tenantId,
        expected.spaceId,
        expected.profileId,
        expected.projectId,
      );
    if (row) {
      const binding = decodeConversation(row);
      if (binding === null) denied();
      assertSqlitePluginProjectWorkspaceBinding(db, binding);
    }
  }
}

export async function assertPostgresProjectAssetUiReadNamespace(
  c: PoolClient,
  schema: string,
  source: Source,
): Promise<void> {
  const expected = owner(source);
  if (!expected) return;
  // The caller has the original Project advisory. Namespace must precede
  // access.assertProject's project row locks, as for Stage and Run paths.
  await advisoryLock(c, pluginProjectNamespaceLock(expected));
  if (!(await hasPostgresPluginProjectWorkspaceSchema(c, schema))) denied();
  let index = 0;
  const rows = (
    await c.query(
      `SELECT * FROM ${pluginInstallationSchemaName(schema)}.${PLUGIN_PROJECT_WORKSPACE_TABLE} WHERE ${namespaceProjectWhere.replaceAll("?", () => `$${++index}`)} LIMIT 2 FOR SHARE`,
      namespaceProjectValues(expected),
    )
  ).rows;
  if (rows.length !== 1) denied();
  const actual = decodeNamespace(rows[0], expected);
  if (actual === null) denied();
  await advisoryLock(c, pluginProjectWorkspaceLock(actual.workspaceId));
  const relation = `${pluginInstallationSchemaName(schema)}.project_conversation_bindings`;
  if (
    (await c.query("SELECT to_regclass($1) AS name", [relation])).rows[0]
      ?.name !== null
  ) {
    const row = (
      await c.query(
        `SELECT * FROM ${relation} WHERE tenant_id=$1 AND space_id=$2 AND profile_id=$3 AND project_id=$4 AND state='active' ORDER BY thread_id LIMIT 1`,
        [
          expected.tenantId,
          expected.spaceId,
          expected.profileId,
          expected.projectId,
        ],
      )
    ).rows[0];
    if (row) {
      const binding = decodeConversation(row);
      if (binding === null) denied();
      await assertPostgresPluginProjectWorkspaceBinding(c, schema, binding);
    }
  }
}
function denied(): never {
  throw Error("plugin_project_asset_ui_namespace_required");
}
