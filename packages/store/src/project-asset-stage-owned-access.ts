import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import {
  captureProjectAssetStageAuthority,
  type ProjectAssetStageCommitAuthority,
  qualifyPluginProjectReadScope,
} from "@crewon/application";
import {
  extensionCanonicalJson,
  parsePluginProjectWorkspaceOwner,
  validateThreadState,
  type ProjectConversationBinding,
  type ThreadState,
} from "@crewon/domain";
import { decodeConversation } from "./project-conversation-store-support.ts";
import {
  assertSqlitePluginProjectWorkspaceBinding,
  assertPostgresPluginProjectWorkspaceBinding,
} from "./plugin-project-workspace-thread-fence.ts";
import {
  assertSqlitePluginProjectWorkspaceMetadata,
  assertPostgresPluginProjectWorkspaceMetadata,
} from "./plugin-project-workspace-metadata-fence.ts";
import { captureSqliteOwnedProjectAccess } from "./plugin-project-owned-read-sqlite.ts";
import { capturePostgresOwnedProjectAccess } from "./plugin-project-owned-read-postgres.ts";
import { creativeProjectSchemaName } from "./creative-project-schema.ts";
import type { PluginProjectReadCall } from "./plugin-project-owned-read-sqlite.ts";

type Source = NonNullable<
  ReturnType<typeof qualifyPluginProjectReadScope>["assetStageRead"]
>;
function owner(s: Source) {
  const q = captureProjectAssetStageAuthority(s.authority),
    b = s.binding;
  if (
    b.state !== "active" ||
    extensionCanonicalJson(b.owner) !== extensionCanonicalJson(q.actor) ||
    extensionCanonicalJson(b.currentInstallation) !==
      extensionCanonicalJson(q.installation)
  )
    denied();
  q.assertActive();
  return parsePluginProjectWorkspaceOwner({
    ...q.actor,
    profileId: q.installation.profileId,
    pluginId: q.installation.pluginId,
    publisherId: q.installation.publisherId,
    projectId: b.projectId,
  });
}
function check(
  s: Source,
  b: ProjectConversationBinding | null,
  row: Record<string, unknown> | undefined,
) {
  if (
    b === null ||
    extensionCanonicalJson(b) !== extensionCanonicalJson(s.binding) ||
    row === undefined
  )
    denied();
  const state = (
    typeof row.state_json === "string"
      ? JSON.parse(row.state_json)
      : row.state_json
  ) as ThreadState;
  validateThreadState(state);
  const a = s.authority.actor;
  if (
    state.tenantId !== a.tenantId ||
    state.spaceId !== a.spaceId ||
    state.createdByActorId !== a.actorId ||
    state.status !== "active" ||
    state.threadId !== b.threadId ||
    (state.workspaceId ?? null) !== b.workspaceId ||
    row.project_conversation_binding_id !== b.bindingId ||
    row.tenant_id !== state.tenantId ||
    row.space_id !== state.spaceId ||
    row.thread_id !== state.threadId ||
    row.created_by_actor_id !== state.createdByActorId ||
    row.status !== state.status ||
    String(row.revision) !== String(state.revision)
  )
    denied();
  s.authority.assertActive();
}
function dependencyTarget(
  source: ReturnType<typeof qualifyPluginProjectReadScope>,
  call: PluginProjectReadCall | undefined,
  heads: readonly Record<string, unknown>[],
) {
  if (
    source.request.action !== "crewon.project-asset-stage-read.v1" ||
    call === undefined
  )
    return;
  const r = source.request.input;
  if (r.purpose === "availability") return;
  const briefRevision =
    r.purpose === "start-stage" ? r.stage.briefRevision : r.briefRevision;
  const script = r.purpose === "start-stage" ? r.stage.script : null;
  const episodeId =
    r.purpose === "script-source" ? r.episodeId : script?.episodeId;
  if (call.method === "loadBrief" && call.query.briefRevision !== briefRevision)
    denied();
  if (call.method === "loadScript" && call.query.episodeId !== episodeId)
    denied();
  if (call.method === "loadRevision") {
    const pinned =
      script !== null &&
      call.query.artifactId === script.artifactId &&
      call.query.contentRevision === script.contentRevision;
    const selected = heads.some(
      (h) =>
        h.artifact_id === call.query.artifactId &&
        h.selected_content_revision !== null &&
        Number(h.selected_content_revision) === call.query.contentRevision &&
        (h.kind === "outline" ||
          (r.purpose === "script-source" &&
            h.kind === "script" &&
            h.episode_id === episodeId)),
    );
    if (!pinned && !selected) denied();
  }
}
export function assertSqliteAssetStageBoundRead(
  db: DatabaseSync,
  source: ReturnType<typeof qualifyPluginProjectReadScope>,
  call?: PluginProjectReadCall,
) {
  const s = source.assetStageRead;
  if (s === undefined) return;
  const o = owner(s);
  const { projectId: _projectId, ...scope } = o;
  if (
    source.request.action !== "crewon.project-asset-stage-read.v1" ||
    source.request.input.projectId !== o.projectId ||
    source.request.input.threadId !== s.binding.threadId ||
    extensionCanonicalJson(source.scope) !== extensionCanonicalJson(scope)
  )
    denied();
  check(
    s,
    decodeConversation(
      db
        .prepare(
          "SELECT * FROM project_conversation_bindings WHERE tenant_id=? AND space_id=? AND binding_id=?",
        )
        .get(o.tenantId, o.spaceId, s.binding.bindingId),
    ),
    db
      .prepare("SELECT * FROM threads WHERE tenant_id=? AND thread_id=?")
      .get(o.tenantId, s.binding.threadId),
  );
  assertSqlitePluginProjectWorkspaceBinding(db, s.binding);
  dependencyTarget(
    source,
    call,
    call?.method === "loadRevision"
      ? db
          .prepare(
            "SELECT artifact_id,selected_content_revision,kind,episode_id FROM project_text_artifacts WHERE tenant_id=? AND space_id=? AND project_id=?",
          )
          .all(o.tenantId, o.spaceId, o.projectId)
      : [],
  );
}
export async function assertPostgresAssetStageBoundRead(
  c: PoolClient,
  schema: string,
  source: ReturnType<typeof qualifyPluginProjectReadScope>,
  call?: PluginProjectReadCall,
) {
  const s = source.assetStageRead;
  if (s === undefined) return;
  const o = owner(s),
    { projectId: _projectId, ...scope } = o;
  if (
    source.request.action !== "crewon.project-asset-stage-read.v1" ||
    source.request.input.projectId !== o.projectId ||
    source.request.input.threadId !== s.binding.threadId ||
    extensionCanonicalJson(source.scope) !== extensionCanonicalJson(scope)
  )
    denied();
  const prefix = `${creativeProjectSchemaName(schema)}.`;
  check(
    s,
    decodeConversation(
      (
        await c.query(
          `SELECT * FROM ${prefix}project_conversation_bindings WHERE tenant_id=$1 AND space_id=$2 AND binding_id=$3 FOR SHARE`,
          [o.tenantId, o.spaceId, s.binding.bindingId],
        )
      ).rows[0],
    ),
    (
      await c.query(
        `SELECT * FROM ${prefix}threads WHERE tenant_id=$1 AND thread_id=$2 FOR SHARE`,
        [o.tenantId, s.binding.threadId],
      )
    ).rows[0],
  );
  await assertPostgresPluginProjectWorkspaceBinding(c, schema, s.binding);
  dependencyTarget(
    source,
    call,
    call?.method === "loadRevision"
      ? (
          await c.query(
            `SELECT artifact_id,selected_content_revision,kind,episode_id FROM ${prefix}project_text_artifacts WHERE tenant_id=$1 AND space_id=$2 AND project_id=$3 FOR SHARE`,
            [o.tenantId, o.spaceId, o.projectId],
          )
        ).rows
      : [],
  );
}
/** The original Stage admission writer selects positive access only after its
 * independent authority and full namespace match. No user field can opt in.
 */
export function captureSqliteAssetStageOwnedAccess(
  db: DatabaseSync,
  authority: ProjectAssetStageCommitAuthority,
  binding: ProjectConversationBinding,
) {
  const o = owner({ authority, binding });
  if (assertSqlitePluginProjectWorkspaceMetadata(db, o) !== "protected")
    return undefined;
  assertSqlitePluginProjectWorkspaceBinding(db, binding);
  const access = captureSqliteOwnedProjectAccess(db, { scope: o });
  return Object.freeze({
    predicate: access.predicate,
    assertProject(scope: Parameters<typeof access.assertProject>[0]) {
      if (
        scope.tenantId !== o.tenantId ||
        scope.spaceId !== o.spaceId ||
        scope.projectId !== o.projectId
      )
        denied();
      access.assertProject(scope);
    },
  });
}
export async function capturePostgresAssetStageOwnedAccess(
  c: PoolClient,
  schema: string,
  authority: ProjectAssetStageCommitAuthority,
  binding: ProjectConversationBinding,
) {
  const o = owner({ authority, binding });
  if (
    (await assertPostgresPluginProjectWorkspaceMetadata(c, schema, o)) !==
    "protected"
  )
    return undefined;
  await assertPostgresPluginProjectWorkspaceBinding(c, schema, binding);
  const access = await capturePostgresOwnedProjectAccess(c, schema, {
    scope: o,
  });
  return Object.freeze({
    predicate: access.predicate,
    async assertProject(scope: {
      tenantId: string;
      spaceId: string;
      projectId: string;
    }) {
      if (
        scope.tenantId !== o.tenantId ||
        scope.spaceId !== o.spaceId ||
        scope.projectId !== o.projectId
      )
        denied();
      await access.assertProject(scope);
    },
  });
}
function denied(): never {
  throw new Error("project_asset_stage_bound_read_conflict");
}
