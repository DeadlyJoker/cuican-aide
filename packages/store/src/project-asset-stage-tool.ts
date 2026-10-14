import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import {
  projectAssetRunMutationCommand,
  type ProjectAssetRunCommitTransactionAuthority,
} from "@crewon/application";
import {
  extensionCanonicalJson,
  assertProjectAssetStageToolRequest,
  projectAssetFailure,
  type ProjectAssetStageRunAdmission,
} from "@crewon/domain";
import { decodeConversation } from "./project-conversation-store-support.ts";
import { creativeStoreDigester } from "./creative-project-store-records.ts";
import { creativeProjectSchemaName } from "./creative-project-schema.ts";
import {
  assertSqlitePluginProjectWorkspaceBinding,
  assertPostgresPluginProjectWorkspaceBinding,
} from "./plugin-project-workspace-thread-fence.ts";
import {
  loadSqliteAssetStage,
  loadPostgresAssetStage,
} from "./project-asset-stage-markers.ts";
function check(
  q: ProjectAssetRunCommitTransactionAuthority,
  a: ProjectAssetStageRunAdmission | null,
  row: Record<string, unknown> | undefined,
) {
  if (
    !a ||
    extensionCanonicalJson(a) !==
      extensionCanonicalJson(q.assetStageAdmission) ||
    a.runId !== q.run.runId ||
    a.threadId !== q.run.threadId ||
    extensionCanonicalJson(a.actor) !== extensionCanonicalJson(q.actor) ||
    extensionCanonicalJson(a.installation) !==
      extensionCanonicalJson(q.installation) ||
    a.pluginTaskAdmissionDigest !==
      creativeStoreDigester.sha256(extensionCanonicalJson(q.admission)) ||
    a.extensionBindingDigest !== q.admission.extensionBindingDigest
  )
    projectAssetFailure("project_asset_stage_tool_denied");
  const b = decodeConversation(row);
  if (
    !b ||
    b.state !== "active" ||
    b.bindingId !== a.bindingId ||
    b.projectId !== a.projectId ||
    b.threadId !== a.threadId ||
    b.workspaceId !== a.workspaceId ||
    extensionCanonicalJson(b.owner) !== extensionCanonicalJson(a.actor) ||
    extensionCanonicalJson(b.currentInstallation) !==
      extensionCanonicalJson(a.installation)
  )
    projectAssetFailure("project_asset_stage_tool_denied");
  const command = projectAssetRunMutationCommand(q, creativeStoreDigester);
  assertProjectAssetStageToolRequest(
    a,
    q.operationId,
    command as unknown as Readonly<Record<string, unknown>>,
  );
}
export function assertSqliteProjectAssetStageTool(
  db: DatabaseSync,
  q: ProjectAssetRunCommitTransactionAuthority,
  options?: Readonly<{
    projectAccess: import("./creative-project-legacy-access.ts").CreativeProjectLegacyAccess;
  }>,
) {
  const a = loadSqliteAssetStage(
    db,
    {
      tenantId: q.actor.tenantId,
      spaceId: q.actor.spaceId,
      runId: q.run.runId,
    },
    options,
  );
  const row =
    a === null
      ? undefined
      : db
          .prepare(
            "SELECT * FROM project_conversation_bindings WHERE tenant_id=? AND space_id=? AND binding_id=?",
          )
          .get(a.actor.tenantId, a.actor.spaceId, a.bindingId);
  check(q, a, row);
  assertSqlitePluginProjectWorkspaceBinding(db, decodeConversation(row)!);
}
export async function assertPostgresProjectAssetStageTool(
  c: PoolClient,
  schema: string,
  q: ProjectAssetRunCommitTransactionAuthority,
  options?: Readonly<{
    projectAccess: import("./creative-project-legacy-access.ts").PostgresCreativeProjectLegacyAccess;
  }>,
) {
  const a = await loadPostgresAssetStage(
    c,
    schema,
    {
      tenantId: q.actor.tenantId,
      spaceId: q.actor.spaceId,
      runId: q.run.runId,
    },
    options,
  );
  const row =
    a === null
      ? undefined
      : (
          await c.query(
            `SELECT * FROM ${creativeProjectSchemaName(schema)}.project_conversation_bindings WHERE tenant_id=$1 AND space_id=$2 AND binding_id=$3 FOR SHARE`,
            [a.actor.tenantId, a.actor.spaceId, a.bindingId],
          )
        ).rows[0];
  check(q, a, row);
  await assertPostgresPluginProjectWorkspaceBinding(
    c,
    schema,
    decodeConversation(row)!,
  );
}

function namespaceBinding(
  stage: ProjectAssetStageRunAdmission,
  row: Record<string, unknown> | undefined,
) {
  const b = decodeConversation(row);
  if (
    !b ||
    b.state !== "active" ||
    b.bindingId !== stage.bindingId ||
    b.revision !== stage.bindingRevision ||
    b.projectId !== stage.projectId ||
    b.threadId !== stage.threadId ||
    b.workspaceId !== stage.workspaceId ||
    extensionCanonicalJson(b.owner) !== extensionCanonicalJson(stage.actor) ||
    extensionCanonicalJson(b.currentInstallation) !==
      extensionCanonicalJson(stage.installation)
  )
    projectAssetFailure("project_asset_stage_namespace_denied");
  return b;
}
/** Namespace constraint from a separately Run-qualified Stage fact, before the
 * positive project row is locked. This check itself lends no Tool/read/write grant.
 */
export function assertSqliteProjectAssetStageNamespace(
  db: DatabaseSync,
  stage: ProjectAssetStageRunAdmission,
) {
  const b = namespaceBinding(
    stage,
    db
      .prepare(
        "SELECT * FROM project_conversation_bindings WHERE tenant_id=? AND space_id=? AND binding_id=?",
      )
      .get(stage.actor.tenantId, stage.actor.spaceId, stage.bindingId),
  );
  assertSqlitePluginProjectWorkspaceBinding(db, b);
}
export async function assertPostgresProjectAssetStageNamespace(
  c: PoolClient,
  schema: string,
  stage: ProjectAssetStageRunAdmission,
) {
  const b = namespaceBinding(
    stage,
    (
      await c.query<Record<string, unknown>>(
        `SELECT * FROM ${creativeProjectSchemaName(schema)}.project_conversation_bindings WHERE tenant_id=$1 AND space_id=$2 AND binding_id=$3 FOR SHARE`,
        [stage.actor.tenantId, stage.actor.spaceId, stage.bindingId],
      )
    ).rows[0],
  );
  await assertPostgresPluginProjectWorkspaceBinding(c, schema, b);
}
