import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import {
  captureProjectAssetStageAuthority,
  type CommitExtensionTurnInput,
  type CommitExtensionTurnOptions,
  type ProjectAssetStageCommitAuthority,
} from "@crewon/application";
import {
  parseProjectAssetStageRunAdmission,
  createProjectAssetStageRunAdmission,
  extensionCanonicalJson,
  validateThreadState,
  projectAssetFailure,
  type ProjectAssetStageRunAdmission,
  type ThreadState,
} from "@crewon/domain";
import { creativeStoreDigester } from "./creative-project-store-records.ts";
import { decodeConversation } from "./project-conversation-store-support.ts";
import {
  assertSqliteProjectTextUiCommit,
  assertPostgresProjectTextUiCommit,
} from "./project-text-ui-commit-support.ts";
import {
  assertSqliteAssetStageSchema,
  assertPostgresAssetStageSchema,
} from "./project-asset-stage-schema.ts";
import {
  assetQuery,
  assetLock,
  assetOwner,
  assetProject,
  assetBrief,
  assetScript,
  type AssetDialect,
  type AssetPlan,
} from "./project-asset-store-support.ts";
import { creativeProjectSchemaName } from "./creative-project-schema.ts";
import { assertProjectAssetCurrentScriptSource } from "./project-asset-script-source.ts";
export type PreparedAssetStage = Readonly<{
  admission: ProjectAssetStageRunAdmission;
  authority: ProjectAssetStageCommitAuthority;
  input: CommitExtensionTurnInput;
}>;
function fail(code = "project_asset_stage_admission_invalid"): never {
  return projectAssetFailure(code);
}
function plainField(o: object, key: string) {
  const d = Object.getOwnPropertyDescriptor(o, key);
  if ((!d && key in o) || (d && (!d.enumerable || !Object.hasOwn(d, "value"))))
    fail();
  return d?.value;
}
export function captureProjectAssetStageTurn(
  input: CommitExtensionTurnInput,
  options: CommitExtensionTurnOptions | undefined,
): Readonly<{
  stage: PreparedAssetStage | null;
  options: CommitExtensionTurnOptions | undefined;
}> {
  const raw = plainField(input, "projectAssetStageAdmission"),
    q =
      options === undefined
        ? undefined
        : plainField(options, "projectAssetStageAuthority");
  if (raw === undefined) {
    if (q !== undefined) fail();
    return { stage: null, options };
  }
  if (
    q === undefined ||
    input.pluginAdmission === undefined ||
    input.projectStageAdmission !== undefined ||
    input.projectTextPlanAdmission !== undefined ||
    input.projectGeneration !== undefined ||
    input.projectQuery !== undefined ||
    input.projectHistoricalQuery !== undefined ||
    input.pluginQueryAdmission !== undefined ||
    options === undefined ||
    Reflect.ownKeys(options).some(
      (k) => k !== "projectAssetStageAuthority" && k !== "unmeteredAuthority",
    )
  )
    fail();
  const admission = parseProjectAssetStageRunAdmission(
      raw,
      creativeStoreDigester,
    ),
    authority = captureProjectAssetStageAuthority(q);
  if (
    extensionCanonicalJson(admission.actor) !==
      extensionCanonicalJson(authority.actor) ||
    extensionCanonicalJson(admission.installation) !==
      extensionCanonicalJson(authority.installation) ||
    admission.runId !== input.binding.runId ||
    admission.threadId !== input.binding.threadId ||
    admission.requestDigest !== input.receipt.requestDigest ||
    admission.idempotencyKey !== input.receipt.idempotencyKey ||
    admission.extensionBindingDigest !== input.binding.bindingDigest ||
    admission.pluginTaskAdmissionDigest !==
      creativeStoreDigester.sha256(
        extensionCanonicalJson(input.pluginAdmission),
      )
  )
    fail();
  const remaining = Object.create(
    Object.getPrototypeOf(options),
    Object.fromEntries(
      Object.entries(Object.getOwnPropertyDescriptors(options)).filter(
        ([k]) => k !== "projectAssetStageAuthority",
      ),
    ),
  ) as CommitExtensionTurnOptions;
  return {
    stage: Object.freeze({
      admission,
      authority,
      input: structuredClone(input),
    }),
    options: Reflect.ownKeys(remaining).length ? remaining : undefined,
  };
}
function* checkRows(
  d: AssetDialect,
  p: PreparedAssetStage,
  current: boolean,
): AssetPlan<void> {
  const a = p.admission,
    owner = assetOwner(a.actor);
  yield* assetLock(d, [
    "idempotency",
    p.input.turn.idempotency.scope,
    p.input.turn.idempotency.key,
  ]);
  yield* assetLock(d, ["run", a.actor.tenantId, a.runId]);
  yield* assetLock(d, ["thread", a.actor.tenantId, a.threadId]);
  yield* assetLock(d, [
    "creative-project-project",
    d.schema,
    a.actor.tenantId,
    a.actor.spaceId,
    a.projectId,
  ]);
  const b = decodeConversation(
    (yield* assetQuery(
      d,
      `SELECT * FROM ${d.prefix}project_conversation_bindings WHERE tenant_id=$1 AND space_id=$2 AND binding_id=$3${d.postgres ? " FOR SHARE" : ""}`,
      [a.actor.tenantId, a.actor.spaceId, a.bindingId],
    ))[0],
  );
  const project = yield* assetProject(d, owner, a.projectId);
  if (
    !b ||
    b.state !== "active" ||
    b.revision !== a.bindingRevision ||
    project.state !== "active" ||
    b.threadId !== a.threadId ||
    b.workspaceId !== a.workspaceId ||
    extensionCanonicalJson(b.owner) !== extensionCanonicalJson(a.actor) ||
    extensionCanonicalJson(b.currentInstallation) !==
      extensionCanonicalJson(a.installation)
  )
    fail("project_asset_stage_binding_conflict");
  const recreated = createProjectAssetStageRunAdmission(
    {
      actor: a.actor,
      binding: b,
      admission: p.input.pluginAdmission!,
      extensionBinding: p.input.binding,
      stage: a.stage,
      sources: a.sources,
      at: a.createdAt,
    },
    creativeStoreDigester,
  );
  if (extensionCanonicalJson(recreated) !== extensionCanonicalJson(a)) fail();
  const row = (yield* assetQuery(
    d,
    `SELECT * FROM ${d.prefix}threads WHERE tenant_id=$1 AND thread_id=$2${d.postgres ? " FOR SHARE" : ""}`,
    [a.actor.tenantId, a.threadId],
  ))[0];
  if (!row) fail("project_asset_stage_thread_conflict");
  const t = (
    typeof row.state_json === "string"
      ? JSON.parse(row.state_json)
      : row.state_json
  ) as ThreadState;
  validateThreadState(t);
  if (
    t.tenantId !== a.actor.tenantId ||
    t.spaceId !== a.actor.spaceId ||
    t.threadId !== a.threadId ||
    t.createdByActorId !== a.actor.actorId ||
    t.status !== "active" ||
    (t.workspaceId ?? null) !== a.workspaceId ||
    row.project_conversation_binding_id !== a.bindingId ||
    row.tenant_id !== t.tenantId ||
    row.space_id !== t.spaceId ||
    row.thread_id !== t.threadId ||
    row.created_by_actor_id !== t.createdByActorId ||
    row.status !== t.status ||
    String(row.revision) !== String(t.revision)
  )
    fail("project_asset_stage_thread_conflict");
  const brief = yield* assetBrief(
    d,
    owner,
    a.projectId,
    a.sources.brief.briefRevision,
  );
  if (
    brief.contentDigest !== a.sources.brief.contentDigest ||
    (current && project.latestBriefRevision !== brief.briefRevision)
  )
    fail("project_asset_stage_sources_stale");
  if (a.sources.script !== null) {
    const s = yield* assetScript(
      d,
      owner,
      a.projectId,
      a.sources.script.artifactId,
      a.sources.script.contentRevision,
    );
    if (
      s.episodeId !== a.sources.script.episodeId ||
      s.contentDigest !== a.sources.script.contentDigest ||
      s.brief.contentDigest !== brief.contentDigest ||
      s.brief.briefRevision !== brief.briefRevision
    )
      fail("project_asset_stage_sources_stale");
    if (current)
      yield* assertProjectAssetCurrentScriptSource(
        d,
        owner,
        a.projectId,
        s,
        brief,
        { failureCode: "project_asset_stage_sources_stale" },
      );
  }
}
export function assertSqliteAssetStageTurn(
  db: DatabaseSync,
  p: PreparedAssetStage | null,
  current: boolean,
) {
  if (!p) return;
  assertSqliteAssetStageSchema(db);
  assertSqliteProjectTextUiCommit(db, p.authority);
  const plan = checkRows(
    { postgres: false, prefix: "", schema: "main" },
    p,
    current,
  );
  let n = plan.next();
  while (!n.done) n = plan.next(db.prepare(n.value.sql).all(...n.value.values));
}
export async function assertPostgresAssetStageTurn(
  c: PoolClient,
  schema: string,
  p: PreparedAssetStage | null,
  current: boolean,
) {
  if (!p) return;
  await assertPostgresAssetStageSchema(c, schema);
  await assertPostgresProjectTextUiCommit(c, schema, p.authority);
  const plan = checkRows(
    { postgres: true, prefix: `${creativeProjectSchemaName(schema)}.`, schema },
    p,
    current,
  );
  let n = plan.next();
  while (!n.done)
    n = plan.next((await c.query(n.value.sql, [...n.value.values])).rows);
}
export function assertAssetStageReplay(
  p: PreparedAssetStage | null,
  s: ProjectAssetStageRunAdmission | null,
) {
  if (
    extensionCanonicalJson(p?.admission ?? null) !== extensionCanonicalJson(s)
  )
    fail("project_asset_stage_admission_conflict");
}
export function assetStageValues(a: ProjectAssetStageRunAdmission) {
  return [
    a.actor.tenantId,
    a.actor.spaceId,
    a.runId,
    a.threadId,
    a.bindingId,
    a.bindingRevision,
    a.contentDigest,
    JSON.stringify(a),
  ] as const;
}
