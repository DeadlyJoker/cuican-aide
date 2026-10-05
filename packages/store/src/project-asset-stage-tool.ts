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
) {
  const a = loadSqliteAssetStage(db, {
    tenantId: q.actor.tenantId,
    spaceId: q.actor.spaceId,
    runId: q.run.runId,
  });
  check(
    q,
    a,
    a === null
      ? undefined
      : db
          .prepare(
            "SELECT * FROM project_conversation_bindings WHERE tenant_id=? AND space_id=? AND binding_id=?",
          )
          .get(a.actor.tenantId, a.actor.spaceId, a.bindingId),
  );
}
export async function assertPostgresProjectAssetStageTool(
  c: PoolClient,
  schema: string,
  q: ProjectAssetRunCommitTransactionAuthority,
) {
  const a = await loadPostgresAssetStage(c, schema, {
    tenantId: q.actor.tenantId,
    spaceId: q.actor.spaceId,
    runId: q.run.runId,
  });
  check(
    q,
    a,
    a === null
      ? undefined
      : (
          await c.query(
            `SELECT * FROM ${creativeProjectSchemaName(schema)}.project_conversation_bindings WHERE tenant_id=$1 AND space_id=$2 AND binding_id=$3 FOR SHARE`,
            [a.actor.tenantId, a.actor.spaceId, a.bindingId],
          )
        ).rows[0],
  );
}
