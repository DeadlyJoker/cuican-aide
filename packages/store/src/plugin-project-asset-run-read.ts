import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import { qualifyPluginProjectReadScope } from "@crewon/application";
import type { ProjectAssetRunReadAuthority } from "@crewon/application/host-project-workspaces";
import {
  extensionCanonicalJson,
  parsePluginProjectWorkspaceOwnerScope,
  type ProjectAssetStageRunAdmission,
} from "@crewon/domain";
import type {
  CreativeProjectLegacyAccess,
  PostgresCreativeProjectLegacyAccess,
} from "./creative-project-legacy-access.ts";
import {
  assertSqliteInstalledProjectRunExecution,
  assertSqliteProjectRunLease,
} from "./creative-project-run-commit-sqlite.ts";
import {
  assertPostgresInstalledProjectRunExecution,
  assertPostgresProjectRunLease,
} from "./creative-project-run-commit-postgres.ts";
import {
  loadSqliteAssetStage,
  loadPostgresAssetStage,
} from "./project-asset-stage-markers.ts";
import { decodeConversation } from "./project-conversation-store-support.ts";
import { creativeProjectSchemaName } from "./creative-project-schema.ts";
import { parseProjectAssetToolCommand } from "@crewon/contracts/project-asset-tools";
import { PROJECT_ASSET_RUN_READ_METHODS } from "@crewon/application/host-project-workspaces";
import { assertProjectAssetStageToolRequest } from "@crewon/domain";
import {
  assertSqliteProjectAssetStageNamespace,
  assertPostgresProjectAssetStageNamespace,
} from "./project-asset-stage-tool.ts";
import {
  assertSqlitePluginProjectWorkspaceBinding,
  assertPostgresPluginProjectWorkspaceBinding,
} from "./plugin-project-workspace-thread-fence.ts";

type Source = ReturnType<typeof qualifyPluginProjectReadScope>;
function target(source: Source) {
  const q = source.assetRunReadAuthority;
  if (q === undefined) return null;
  const owner = parsePluginProjectWorkspaceOwnerScope({
    ...q.actor,
    profileId: q.installation.profileId,
    pluginId: q.installation.pluginId,
    publisherId: q.installation.publisherId,
  });
  if (
    source.request.action !== "crewon.project-asset-run-read.v1" ||
    source.request.input.projectId !== q.assetStageAdmission.projectId ||
    extensionCanonicalJson(source.scope) !== extensionCanonicalJson(owner)
  )
    denied();
  return {
    q,
    project: {
      tenantId: owner.tenantId,
      spaceId: owner.spaceId,
      projectId: q.assetStageAdmission.projectId,
    },
  };
}
function binding(
  q: ProjectAssetRunReadAuthority,
  stage: ProjectAssetStageRunAdmission | null,
  row: Record<string, unknown> | undefined,
) {
  const b = decodeConversation(row);
  if (
    !stage ||
    extensionCanonicalJson(stage) !==
      extensionCanonicalJson(q.assetStageAdmission) ||
    !b ||
    b.state !== "active" ||
    b.bindingId !== stage.bindingId ||
    b.threadId !== stage.threadId ||
    b.projectId !== stage.projectId ||
    b.workspaceId !== stage.workspaceId ||
    b.revision !== stage.bindingRevision ||
    extensionCanonicalJson(b.owner) !== extensionCanonicalJson(stage.actor) ||
    extensionCanonicalJson(b.currentInstallation) !==
      extensionCanonicalJson(stage.installation) ||
    parseProjectAssetToolCommand(
      PROJECT_ASSET_RUN_READ_METHODS[q.operationId],
      JSON.parse(q.commandInput),
    ).projectId !== stage.projectId
  )
    denied();
  assertProjectAssetStageToolRequest(
    stage,
    q.operationId,
    parseProjectAssetToolCommand(
      PROJECT_ASSET_RUN_READ_METHODS[q.operationId],
      JSON.parse(q.commandInput),
    ) as Readonly<Record<string, unknown>>,
  );
  return b;
}
/** True asset read receipt, lease and binding re-read on the original transaction. */
export function assertSqlitePluginProjectAssetRunRead(
  db: DatabaseSync,
  source: Source,
  access: CreativeProjectLegacyAccess,
) {
  const scoped = target(source);
  if (!scoped) return;
  if (!db.isTransaction) denied();
  assertSqliteInstalledProjectRunExecution(db, scoped.q);
  assertSqliteProjectAssetStageNamespace(db, scoped.q.assetStageAdmission);
  access.assertProject(scoped.project);
  const stage = loadSqliteAssetStage(
    db,
    {
      tenantId: scoped.q.actor.tenantId,
      runId: scoped.q.run.runId,
      spaceId: scoped.q.actor.spaceId,
    },
    { projectAccess: access },
  );
  const b = binding(
    scoped.q,
    stage,
    stage === null
      ? undefined
      : db
          .prepare(
            "SELECT * FROM project_conversation_bindings WHERE tenant_id=? AND space_id=? AND binding_id=?",
          )
          .get(stage.actor.tenantId, stage.actor.spaceId, stage.bindingId),
  );
  assertSqlitePluginProjectWorkspaceBinding(db, b);
  assertSqliteProjectRunLease(db, scoped.q);
}
export async function assertPostgresPluginProjectAssetRunRead(
  c: PoolClient,
  schema: string,
  source: Source,
  access: PostgresCreativeProjectLegacyAccess,
) {
  const scoped = target(source);
  if (!scoped) return;
  await assertPostgresInstalledProjectRunExecution(c, schema, scoped.q);
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    JSON.stringify([
      "creative-project-project",
      schema,
      scoped.q.actor.tenantId,
      scoped.q.actor.spaceId,
      scoped.q.assetStageAdmission.projectId,
    ]),
  ]);
  await assertPostgresProjectAssetStageNamespace(
    c,
    schema,
    scoped.q.assetStageAdmission,
  );
  await access.assertProject(scoped.project);
  const stage = await loadPostgresAssetStage(
    c,
    schema,
    {
      tenantId: scoped.q.actor.tenantId,
      runId: scoped.q.run.runId,
      spaceId: scoped.q.actor.spaceId,
    },
    { projectAccess: access },
  );
  const b = binding(
    scoped.q,
    stage,
    stage === null
      ? undefined
      : (
          await c.query<Record<string, unknown>>(
            `SELECT * FROM ${creativeProjectSchemaName(schema)}.project_conversation_bindings WHERE tenant_id=$1 AND space_id=$2 AND binding_id=$3 FOR SHARE`,
            [stage.actor.tenantId, stage.actor.spaceId, stage.bindingId],
          )
        ).rows[0],
  );
  await assertPostgresPluginProjectWorkspaceBinding(c, schema, b);
  await assertPostgresProjectRunLease(c, schema, scoped.q);
}
function denied(): never {
  throw new Error("plugin_project_asset_run_read_denied");
}
