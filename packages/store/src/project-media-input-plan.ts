import {
  parseSaveProjectMediaInputCommand,
  parseProjectMediaInputQuery,
  parseProjectMediaInputRevision,
  captureProjectMediaInputWrite,
  createProjectMediaInputRevision,
  mediaInputSame as same,
  mediaInputDigest as digest,
  mediaInputReference,
  mediaInputPreparationRequest,
  assertProjectMediaWorkflowReview,
  projectMediaInputFail as fail,
  type ProjectMediaInputStore,
  type ProjectMediaInputQuery,
  type ProjectMediaInputRevision,
  type ProjectMediaInputAuthority,
  type ProjectMediaInputWrite,
  type ActorContext,
  type ProjectGenerationImageResultVerifier,
  type ProjectMaterialPreparationTarget,
} from "@crewon/application";
import {
  extensionCanonicalJson,
  parseExtensionConfiguration,
  projectAssetRevision,
} from "@crewon/domain";
import { creativeStoreDigester } from "./creative-project-store-records.ts";
import { loadAssetReferenceImagePlan } from "./project-asset-reference-image-plan.ts";
import { assertProjectAssetCurrentScriptSource } from "./project-asset-script-source.ts";
import {
  assetLock,
  assetProject,
  assetOwner,
  assetBrief,
  assetScript,
  assetQuery,
  type AssetDialect,
  type AssetRows,
  type AssetSql,
} from "./project-asset-store-support.ts";
export type ProjectMediaInputPlan<T> = Generator<
  AssetSql | Readonly<{ installation: ProjectMaterialPreparationTarget }>,
  T,
  AssetRows
>;
type Input<K extends keyof ProjectMediaInputStore> = Parameters<
  ProjectMediaInputStore[K]
>[0];
const raw = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : v);
const keys = (
  q: Pick<ProjectMediaInputQuery, "actor" | "projectId" | "mediaInputId">,
) => [q.actor.tenantId, q.actor.spaceId, q.projectId, q.mediaInputId];
const filter =
  "tenant_id=$1 AND space_id=$2 AND project_id=$3 AND media_input_id=$4";
function* owner(d: AssetDialect, actor: ActorContext, projectId: string) {
  yield* assetLock(d, [
    "creative-project-project",
    d.schema,
    actor.tenantId,
    actor.spaceId,
    projectId,
  ]);
  return yield* assetProject(d, assetOwner(actor), projectId);
}
export function* loadProjectMediaInputPlan(
  d: AssetDialect,
  q: ProjectMediaInputQuery,
): ProjectMediaInputPlan<Awaited<ReturnType<ProjectMediaInputStore["load"]>>> {
  yield* owner(d, q.actor, q.projectId);
  const heads = yield* assetQuery(
    d,
    `SELECT * FROM ${d.prefix}project_media_inputs WHERE ${filter}`,
    keys(q),
  );
  if (!heads[0]) return null;
  const h = heads[0],
    latest = projectAssetRevision(Number(h.latest_input_revision));
  if (h.owner_principal_id !== q.actor.principalId) fail("owner_mismatch");
  const n = q.inputRevision ?? latest,
    rows = yield* assetQuery(
      d,
      `SELECT * FROM ${d.prefix}project_media_input_revisions WHERE ${filter} AND input_revision=$5`,
      [...keys(q), n],
    );
  if (!rows[0]) {
    if (n === latest) fail("history_invalid");
    return null;
  }
  const r = parseProjectMediaInputRevision(raw(rows[0].record_json));
  if (
    r.actor.tenantId !== q.actor.tenantId ||
    r.actor.spaceId !== q.actor.spaceId ||
    r.actor.principalId !== q.actor.principalId ||
    r.projectId !== q.projectId ||
    r.mediaInputId !== q.mediaInputId ||
    r.inputRevision !== n ||
    n > latest ||
    rows[0].content_digest !== r.contentDigest ||
    !same(raw(h.item_json), r.item) ||
    h.workflow_id !== r.workflow.workflowId ||
    [h, rows[0]].some(
      (row) =>
        row.tenant_id !== r.actor.tenantId ||
        row.space_id !== r.actor.spaceId ||
        row.project_id !== r.projectId ||
        row.media_input_id !== r.mediaInputId,
    )
  )
    fail("history_invalid");
  return Object.freeze({ input: r, latestInputRevision: latest });
}
export function* listProjectMediaInputPlan(
  d: AssetDialect,
  q: Input<"list">,
): ProjectMediaInputPlan<Awaited<ReturnType<ProjectMediaInputStore["list"]>>> {
  yield* owner(d, q.actor, q.projectId);
  const rows = yield* assetQuery(
    d,
    `SELECT media_input_id FROM ${d.prefix}project_media_inputs WHERE tenant_id=$1 AND space_id=$2 AND project_id=$3 AND (${d.postgres ? "$4::text" : "$4"} IS NULL OR media_input_id COLLATE ${d.postgres ? '"C"' : "BINARY"}>$4) ORDER BY media_input_id COLLATE ${d.postgres ? '"C"' : "BINARY"} LIMIT $5`,
    [
      q.actor.tenantId,
      q.actor.spaceId,
      q.projectId,
      q.afterMediaInputId,
      q.limit + 1,
    ],
  );
  const inputs = [];
  for (const row of rows.slice(0, q.limit)) {
    const state = yield* loadProjectMediaInputPlan(d, {
      actor: q.actor,
      projectId: q.projectId,
      mediaInputId: String(row.media_input_id),
      inputRevision: null,
    });
    if (state === null) fail("history_invalid");
    const r = state.input;
    inputs.push(
      Object.freeze({
        projectId: r.projectId,
        mediaInputId: r.mediaInputId,
        latestInputRevision: state.latestInputRevision,
        item: r.item,
        workflowId: r.workflow.workflowId,
        createdAt: r.createdAt,
      }),
    );
  }
  return Object.freeze({
    inputs: Object.freeze(inputs),
    nextMediaInputId:
      rows.length > q.limit ? inputs.at(-1)!.mediaInputId : null,
  });
}
export function* loadProjectMediaInputReceipt(
  d: AssetDialect,
  input: Input<"loadReceipt">,
): ProjectMediaInputPlan<ProjectMediaInputRevision | null> {
  const { actor, command: c } = input;
  yield* owner(d, actor, c.projectId);
  const values = [
      actor.tenantId,
      actor.spaceId,
      actor.principalId,
      actor.actorId,
      c.projectId,
      c.idempotencyKey,
    ],
    rows = yield* assetQuery(
      d,
      `SELECT * FROM ${d.prefix}project_media_input_receipts WHERE tenant_id=$1 AND space_id=$2 AND principal_id=$3 AND actor_id=$4 AND project_id=$5 AND idempotency_key=$6`,
      values,
    );
  if (!rows[0]) return null;
  const row = rows[0];
  if (row.request_digest !== digest({ actor, command: c }))
    fail("idempotency_conflict");
  const saved = yield* loadProjectMediaInputPlan(d, {
    actor,
    projectId: c.projectId,
    mediaInputId: String(row.media_input_id),
    inputRevision: Number(row.input_revision),
  });
  if (
    !saved ||
    saved.input.contentDigest !== row.content_digest ||
    !same(saved.input.actor, actor)
  )
    fail("history_invalid");
  return saved.input;
}
function* dependencies(
  d: AssetDialect,
  actor: ActorContext,
  c: Pick<
    ProjectMediaInputWrite["command"],
    "projectId" | "briefRevision" | "script" | "item"
  >,
): ProjectMediaInputPlan<
  Readonly<{
    brief: ProjectMediaInputRevision["brief"];
    script: ProjectMediaInputRevision["script"];
  }>
> {
  const project = yield* owner(d, actor, c.projectId);
  if (project.state !== "active") fail("project_archived");
  if (project.latestBriefRevision !== c.briefRevision) fail("brief_stale");
  const brief = yield* assetBrief(
    d,
    assetOwner(actor),
    c.projectId,
    c.briefRevision,
  );
  let script: ProjectMediaInputRevision["script"] = null;
  if (c.script) {
    const actual = yield* assetScript(
      d,
      assetOwner(actor),
      c.projectId,
      c.script.artifactId,
      c.script.contentRevision,
    );
    yield* assertProjectAssetCurrentScriptSource(
      d,
      assetOwner(actor),
      c.projectId,
      actual,
      brief,
      { failureCode: "project_asset_source_stale" },
    );
    if (
      c.item.kind === "storyboard-frame-exploration" &&
      actual.episodeId !== c.item.episodeId
    )
      fail("script_episode_mismatch");
    script = Object.freeze({
      artifactId: actual.artifactId,
      contentRevision: actual.contentRevision,
      contentDigest: actual.contentDigest,
    });
  } else if (c.item.kind === "storyboard-frame-exploration")
    fail("script_required");
  return Object.freeze({
    brief: Object.freeze({
      briefRevision: brief.briefRevision,
      contentDigest: brief.contentDigest,
    }),
    script,
  });
}
function* target(
  d: AssetDialect,
  t: ProjectMaterialPreparationTarget,
): ProjectMediaInputPlan<void> {
  const c = t.configuration,
    rows = yield* assetQuery(
      d,
      `SELECT * FROM ${d.prefix}extension_configurations WHERE tenant_id=$1 AND space_id=$2 AND plugin_id=$3 AND revision=$4`,
      [c.tenantId, c.spaceId, c.pluginId, c.revision],
    );
  if (
    rows.length !== 1 ||
    !same(
      parseExtensionConfiguration(
        raw(rows[0]!.configuration_json),
        creativeStoreDigester,
      ),
      c,
    ) ||
    rows[0]!.tenant_id !== c.tenantId ||
    rows[0]!.space_id !== c.spaceId ||
    rows[0]!.plugin_id !== c.pluginId ||
    Number(rows[0]!.revision) !== c.revision
  )
    fail("target_changed");
  yield { installation: t };
}
/** Current metadata proof only: no source file, supplier GET, upload or Run grant. */
export function* qualifyProjectMediaInputPlan(
  d: AssetDialect,
  record: ProjectMediaInputRevision,
  a: ProjectMediaInputAuthority,
  verifier: ProjectGenerationImageResultVerifier | undefined,
): ProjectMediaInputPlan<void> {
  if (!same(a.actor, record.actor)) fail("actor_changed");
  assertProjectMediaWorkflowReview(a.review, record);
  const current = yield* dependencies(d, a.actor, {
    projectId: record.projectId,
    briefRevision: record.brief.briefRevision,
    script: record.script,
    item: record.item,
  });
  if (
    !same(current.brief, record.brief) ||
    !same(current.script, record.script)
  )
    fail("source_changed");
  for (const r of record.references) {
    const s = yield* loadAssetReferenceImagePlan(
      d,
      { actor: a.actor, query: r.preparation.source.query },
      verifier,
    );
    if (!same(mediaInputReference(r.role, s, r.preparation), r))
      fail("source_changed");
    // Derive original request keys from actual source/target facts, never trust stored key strings.
    const c = {
      references: { [r.role]: r.preparation.source.query },
      target: r.preparation.target,
    } as ProjectMediaInputWrite["command"];
    if (
      !same(
        mediaInputPreparationRequest(a.actor, c, r.role, s, record.target),
        r.preparation,
      )
    )
      fail("preparation_changed");
  }
  yield* target(d, record.target);
}
export function* saveProjectMediaInputPlan(
  d: AssetDialect,
  input: ProjectMediaInputWrite,
  a: ProjectMediaInputAuthority,
  verifier: ProjectGenerationImageResultVerifier | undefined,
): ProjectMediaInputPlan<Awaited<ReturnType<ProjectMediaInputStore["save"]>>> {
  const q = captureProjectMediaInputWrite(input),
    c = q.command,
    existing = yield* loadProjectMediaInputReceipt(d, {
      actor: q.actor,
      command: c,
    });
  if (existing)
    return Object.freeze({ disposition: "replayed", input: existing });
  const sources = yield* dependencies(d, q.actor, c),
    record = createProjectMediaInputRevision(q, sources.brief, sources.script);
  yield* qualifyProjectMediaInputPlan(d, record, a, verifier);
  const query = {
      actor: q.actor,
      projectId: c.projectId,
      mediaInputId: record.mediaInputId,
      inputRevision: null,
    },
    head = yield* loadProjectMediaInputPlan(d, query);
  if (c.mediaInputId === null) {
    if (head) fail("identity_conflict");
  } else if (!head || head.latestInputRevision !== c.expectedInputRevision)
    fail("revision_conflict");
  else if (
    !same(head.input.item, record.item) ||
    head.input.workflow.workflowId !== record.workflow.workflowId ||
    record.createdAt < head.input.createdAt
  )
    fail("item_changed");
  const base = keys(query);
  if (!head)
    yield* assetQuery(
      d,
      `INSERT INTO ${d.prefix}project_media_inputs(tenant_id,space_id,project_id,media_input_id,owner_principal_id,latest_input_revision,item_json,workflow_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        ...base,
        q.actor.principalId,
        record.inputRevision,
        extensionCanonicalJson(record.item),
        record.workflow.workflowId,
      ],
    );
  else
    yield* assetQuery(
      d,
      `UPDATE ${d.prefix}project_media_inputs SET latest_input_revision=$5 WHERE ${filter} AND latest_input_revision=$6`,
      [...base, record.inputRevision, c.expectedInputRevision],
    );
  yield* assetQuery(
    d,
    `INSERT INTO ${d.prefix}project_media_input_revisions(tenant_id,space_id,project_id,media_input_id,input_revision,content_digest,record_json) VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [
      ...base,
      record.inputRevision,
      record.contentDigest,
      extensionCanonicalJson(record),
    ],
  );
  yield* assetQuery(
    d,
    `INSERT INTO ${d.prefix}project_media_input_receipts(tenant_id,space_id,principal_id,actor_id,project_id,idempotency_key,request_digest,media_input_id,input_revision,content_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      q.actor.tenantId,
      q.actor.spaceId,
      q.actor.principalId,
      q.actor.actorId,
      c.projectId,
      c.idempotencyKey,
      digest({ actor: q.actor, command: c }),
      record.mediaInputId,
      record.inputRevision,
      record.contentDigest,
    ],
  );
  return Object.freeze({ disposition: "committed", input: record });
}
export function* qualifySavedProjectMediaInput(
  d: AssetDialect,
  q: Input<"qualify">,
  a: ProjectMediaInputAuthority,
  verifier: ProjectGenerationImageResultVerifier | undefined,
): ProjectMediaInputPlan<ProjectMediaInputRevision> {
  const saved = yield* loadProjectMediaInputPlan(
    d,
    parseProjectMediaInputQuery({
      actor: q.actor,
      projectId: q.projectId,
      mediaInputId: q.mediaInputId,
      inputRevision: q.inputRevision,
    }),
  );
  if (!saved) fail("not_found");
  if (saved.latestInputRevision !== q.expectedInputRevision)
    fail("revision_conflict");
  yield* qualifyProjectMediaInputPlan(d, saved.input, a, verifier);
  return saved.input;
}
