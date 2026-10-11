import {
  captureSqliteAssetLegacyExecution,
  capturePostgresAssetLegacyExecution,
} from "./project-asset-legacy-instruction.ts";
import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import {
  captureProjectMediaInputStageAuthority,
  type CommitExtensionTurnInput,
  type CommitExtensionTurnOptions,
  type ProjectMediaInputStageCommitAuthority,
} from "@crewon/application";
import {
  parseProjectMediaInputStageRunAdmission,
  createProjectMediaInputStageRunAdmission,
  extensionCanonicalJson,
  validateThreadState,
  projectAssetFailure,
  type ProjectMediaInputStageRunAdmission,
  type ThreadState,
} from "@crewon/domain";
import { creativeStoreDigester } from "./creative-project-store-records.ts";
import { decodeConversation } from "./project-conversation-store-support.ts";
import {
  assertSqliteProjectTextUiCommit,
  assertPostgresProjectTextUiCommit,
} from "./project-text-ui-commit-support.ts";
import {
  assertSqliteMediaInputStageSchema,
  assertPostgresMediaInputStageSchema,
} from "./project-media-input-stage-schema.ts";
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
export type PreparedMediaInputStage = Readonly<{
  admission: ProjectMediaInputStageRunAdmission;
  authority: ProjectMediaInputStageCommitAuthority;
  input: CommitExtensionTurnInput;
}>;
function fail(code = "project_media_input_stage_admission_invalid"): never {
  return projectAssetFailure(code);
}
function plainField(o: object, key: string) {
  const d = Object.getOwnPropertyDescriptor(o, key);
  if ((!d && key in o) || (d && (!d.enumerable || !Object.hasOwn(d, "value"))))
    fail();
  return d?.value;
}
export function captureProjectMediaInputStageTurn(
  input: CommitExtensionTurnInput,
  options: CommitExtensionTurnOptions | undefined,
): Readonly<{
  stage: PreparedMediaInputStage | null;
  options: CommitExtensionTurnOptions | undefined;
}> {
  const raw = plainField(input, "projectMediaInputStageAdmission"),
    q =
      options === undefined
        ? undefined
        : plainField(options, "projectMediaInputStageAuthority");
  if (raw === undefined) {
    if (q !== undefined) fail();
    return { stage: null, options };
  }
  if (
    q === undefined ||
    input.pluginAdmission === undefined ||
    input.projectStageAdmission !== undefined ||
    input.projectAssetStageAdmission !== undefined ||
    input.projectMediaGeneration !== undefined ||
    input.projectTextPlanAdmission !== undefined ||
    input.projectGeneration !== undefined ||
    input.projectQuery !== undefined ||
    input.projectHistoricalQuery !== undefined ||
    input.pluginQueryAdmission !== undefined ||
    options === undefined ||
    Reflect.ownKeys(options).some(
      (k) =>
        k !== "projectMediaInputStageAuthority" && k !== "unmeteredAuthority",
    )
  )
    fail();
  const admission = parseProjectMediaInputStageRunAdmission(
      raw,
      creativeStoreDigester,
    ),
    authority = captureProjectMediaInputStageAuthority(q);
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
        ([k]) => k !== "projectMediaInputStageAuthority",
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
  p: PreparedMediaInputStage,
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
    fail("project_media_input_stage_binding_conflict");
  const recreated = createProjectMediaInputStageRunAdmission(
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
  if (!row) fail("project_media_input_stage_thread_conflict");
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
    fail("project_media_input_stage_thread_conflict");
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
    fail("project_media_input_stage_sources_stale");
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
      fail("project_media_input_stage_sources_stale");
    if (current)
      yield* assertProjectAssetCurrentScriptSource(
        d,
        owner,
        a.projectId,
        s,
        brief,
        { failureCode: "project_media_input_stage_sources_stale" },
      );
  }
}
export function assertSqliteMediaInputStageTurn(
  db: DatabaseSync,
  p: PreparedMediaInputStage | null,
  current: boolean,
) {
  if (!p) return;
  assertSqliteMediaInputStageSchema(db);
  assertSqliteProjectTextUiCommit(db, p.authority);
  const plan = checkRows(
    { postgres: false, prefix: "", schema: "main" },
    p,
    current,
  );
  const legacy = captureSqliteAssetLegacyExecution(db);
  let n = plan.next();
  while (!n.done)
    n = plan.next(
      "assetLegacyAccess" in n.value
        ? legacy.execute(n.value)
        : db.prepare(n.value.sql).all(...n.value.values),
    );
  legacy.assertCurrent();
  assertSqliteProjectTextUiCommit(db, p.authority);
}
export async function assertPostgresMediaInputStageTurn(
  c: PoolClient,
  schema: string,
  p: PreparedMediaInputStage | null,
  current: boolean,
) {
  if (!p) return;
  await assertPostgresMediaInputStageSchema(c, schema);
  await assertPostgresProjectTextUiCommit(c, schema, p.authority);
  const plan = checkRows(
    { postgres: true, prefix: `${creativeProjectSchemaName(schema)}.`, schema },
    p,
    current,
  );
  const legacy = capturePostgresAssetLegacyExecution(c, schema);
  let n = plan.next();
  while (!n.done)
    n = plan.next(
      "assetLegacyAccess" in n.value
        ? await legacy.execute(n.value)
        : (await c.query(n.value.sql, [...n.value.values])).rows,
    );
  await legacy.assertCurrent();
  await assertPostgresProjectTextUiCommit(c, schema, p.authority);
}
export function assertMediaInputStageReplay(
  p: PreparedMediaInputStage | null,
  s: ProjectMediaInputStageRunAdmission | null,
) {
  if (
    extensionCanonicalJson(p?.admission ?? null) !== extensionCanonicalJson(s)
  )
    fail("project_media_input_stage_admission_conflict");
}
export function mediaInputStageValues(a: ProjectMediaInputStageRunAdmission) {
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
