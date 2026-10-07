import {
  parseProjectMediaResultSource,
  parseProjectMediaResultCandidate,
  mediaResultFail as fail,
  mediaInputSame,
  mediaInputDigest,
  type ProjectMediaResultSource,
  type ProjectMediaResultCandidate,
  type ProjectMediaResultRequest,
  type ProjectMediaResultCatalogRequest,
} from "@crewon/application";
import {
  assetLock,
  assetOwner,
  assetProject,
  assetQuery,
  type AssetDialect,
  type AssetSql,
  type AssetRows,
} from "./project-asset-store-support.ts";
import { loadProjectMediaGenerationContextPlan } from "./project-media-generation-read.ts";
import { loadProjectMediaOperationPlan } from "./project-media-operation-plan.ts";
import type { ProjectMediaInputPlan } from "./project-media-input-plan.ts";
type Yield =
  ProjectMediaInputPlan<unknown> extends Generator<infer Y, unknown, unknown>
    ? Y
    : never;
export type MediaResultPlan<T> = Generator<
  | Yield
  | Readonly<{ mediaOperationSchema: true }>
  | Readonly<{ assetSchema: true }>,
  T,
  AssetRows
>;
const raw = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : v);
export function* mediaResultSourcePlan(
  d: AssetDialect,
  request: ProjectMediaResultRequest,
): MediaResultPlan<ProjectMediaResultSource> {
  const { actor, query: q } = request;
  yield* assetLock(d, [
    "creative-project-project",
    d.schema,
    actor.tenantId,
    actor.spaceId,
    q.projectId,
  ]);
  yield* assetProject(d, assetOwner(actor), q.projectId);
  const context = yield* loadProjectMediaGenerationContextPlan(d, {
    tenantId: actor.tenantId,
    spaceId: actor.spaceId,
    runId: q.runId,
  });
  if (
    !context ||
    context.link.reference.projectId !== q.projectId ||
    context.link.actor.principalId !== actor.principalId
  )
    fail("not_found");
  const { link, input } = context;
  const state = yield* loadProjectMediaOperationPlan(
    d,
    {
      tenantId: actor.tenantId,
      runId: q.runId,
      bindingDigest: link.binding.bindingDigest,
    },
    true,
  );
  if (
    !state ||
    state.link.generationDigest !== link.contentDigest ||
    state.link.projectId !== q.projectId
  )
    fail("not_found");
  const op = state.operation;
  if (
    op.status !== "succeeded" ||
    op.providerOperationId === null ||
    typeof op.resultJson !== "string"
  )
    fail("not_ready");
  const result = raw(op.resultJson) as { images?: unknown };
  if (
    !result ||
    typeof result !== "object" ||
    !Array.isArray(result.images) ||
    !result.images.length ||
    result.images.length > 16 ||
    q.resultIndex >= result.images.length
  )
    fail("not_found");
  const target = input.target,
    c = target.configuration,
    b = link.binding;
  if (
    b.pluginId !== "crewon.short-drama" ||
    c.pluginId !== b.pluginId ||
    c.pluginVersion !== link.admission.version ||
    c.revision !== b.configurationRevision ||
    c.contentDigest !== b.configurationDigest ||
    target.package.packageDigest !== link.admission.packageDigest ||
    target.package.version !== link.admission.version ||
    target.package.publisherId !== link.admission.publisherId ||
    typeof c.parameters.baseUrl !== "string" ||
    c.credentialBindings.length
  )
    fail("source_invalid");
  const configurations = yield* assetQuery(
    d,
    `SELECT configuration_json FROM ${d.prefix}extension_configurations WHERE tenant_id=$1 AND space_id=$2 AND plugin_id=$3 AND revision=$4`,
    [actor.tenantId, actor.spaceId, b.pluginId, b.configurationRevision],
  );
  if (
    configurations.length !== 1 ||
    !mediaInputSame(raw(configurations[0]!.configuration_json), c)
  )
    fail("history_invalid");
  const body = {
    schemaVersion: "crewon.project-media-result-source.v1" as const,
    request: { actor: link.actor, query: q },
    reference: link.reference,
    item: input.item,
    workflow: input.workflow,
    targetIdentity: {
      pluginId: "crewon.short-drama" as const,
      version: target.package.version,
      publisherId: target.package.publisherId,
      packageDigest: target.package.packageDigest,
      manifestDigest: c.manifestDigest,
      implementationDigest: c.implementationDigest,
    },
    configuration: {
      revision: c.revision,
      contentDigest: c.contentDigest,
      origin: new URL(c.parameters.baseUrl).href,
    },
    generationDigest: link.contentDigest,
    operationLinkDigest: state.link.contentDigest,
    operation: {
      operationId: op.operationId,
      providerOperationId: op.providerOperationId,
      revision: op.revision,
      contentDigest: mediaInputDigest(op),
    },
    image: result.images[q.resultIndex],
  };
  return parseProjectMediaResultSource({
    ...body,
    contentDigest: mediaInputDigest(body),
  });
}
const table = "project_media_result_candidates";
const columns = [
  "tenant_id",
  "space_id",
  "project_id",
  "owner_principal_id",
  "run_id",
  "result_index",
  "candidate_id",
  "source_digest",
  "content_digest",
];
function values(c: ProjectMediaResultCandidate) {
  const r = c.frozen.request;
  return [
    r.actor.tenantId,
    r.actor.spaceId,
    r.query.projectId,
    r.actor.principalId,
    r.query.runId,
    r.query.resultIndex,
    c.candidateId,
    c.frozen.source.projection.contentDigest,
    c.contentDigest,
  ];
}
export function* mediaResultLoadPlan(
  d: AssetDialect,
  request: ProjectMediaResultRequest,
): MediaResultPlan<ProjectMediaResultCandidate | null> {
  const source = yield* mediaResultSourcePlan(d, request);
  const rows = yield* assetQuery(
    d,
    `SELECT * FROM ${d.prefix}${table} WHERE tenant_id=$1 AND space_id=$2 AND project_id=$3 AND owner_principal_id=$4 AND run_id=$5 AND result_index=$6`,
    [
      request.actor.tenantId,
      request.actor.spaceId,
      request.query.projectId,
      request.actor.principalId,
      request.query.runId,
      request.query.resultIndex,
    ],
  );
  if (!rows.length) return null;
  const row = rows[0]!,
    candidate = parseProjectMediaResultCandidate(raw(row.record_json)),
    indexed = values(candidate);
  if (
    rows.length !== 1 ||
    columns.some((k, i) => String(row[k]) !== String(indexed[i])) ||
    !mediaInputSame(candidate.frozen.source.projection, source)
  )
    fail("history_invalid");
  return candidate;
}
export function* mediaResultSavePlan(
  d: AssetDialect,
  request: ProjectMediaResultRequest,
  candidate: ProjectMediaResultCandidate,
): MediaResultPlan<
  Readonly<{
    disposition: "created" | "replayed";
    candidate: ProjectMediaResultCandidate;
  }>
> {
  const old = yield* mediaResultLoadPlan(d, request);
  if (old) {
    if (!mediaInputSame(old, candidate)) fail("conflict");
    return Object.freeze({ disposition: "replayed", candidate: old });
  }
  const project = yield* assetProject(
    d,
    assetOwner(request.actor),
    request.query.projectId,
  );
  if (project.state !== "active") fail("project_archived");
  const source = yield* mediaResultSourcePlan(d, request);
  if (!mediaInputSame(source, candidate.frozen.source.projection))
    fail("source_changed");
  yield* assetQuery(
    d,
    `INSERT INTO ${d.prefix}${table}(${columns.join(",")},record_json) VALUES(${Array.from({ length: 10 }, (_, i) => `$${i + 1}`).join(",")})`,
    [...values(candidate), JSON.stringify(candidate)],
  );
  return Object.freeze({ disposition: "created", candidate });
}

export function* mediaResultPublicationPlan(
  d: AssetDialect,
  request: ProjectMediaResultRequest,
): MediaResultPlan<ProjectMediaResultSource> {
  const old = yield* mediaResultLoadPlan(d, request);
  if (old) return old.frozen.source.projection;
  const project = yield* assetProject(
    d,
    assetOwner(request.actor),
    request.query.projectId,
  );
  if (project.state !== "active") fail("project_archived");
  return yield* mediaResultSourcePlan(d, request);
}

/** The original project lock, owner filter and accepted provenance remain authoritative on every page. */
export function* mediaResultCatalogPlan(
  d: AssetDialect,
  request: ProjectMediaResultCatalogRequest,
): MediaResultPlan<
  Readonly<{
    candidates: readonly ProjectMediaResultCandidate[];
    nextCandidateId: string | null;
  }>
> {
  const { actor, query } = request;
  yield* assetLock(d, [
    "creative-project-project",
    d.schema,
    actor.tenantId,
    actor.spaceId,
    query.projectId,
  ]);
  yield* assetProject(d, assetOwner(actor), query.projectId);
  const collation = d.postgres ? 'COLLATE "C"' : "COLLATE BINARY";
  const rows = yield* assetQuery(
    d,
    `SELECT * FROM ${d.prefix}${table} WHERE tenant_id=$1 AND space_id=$2 AND project_id=$3 AND owner_principal_id=$4 AND (CAST($5 AS TEXT) IS NULL OR candidate_id ${collation}>$5) ORDER BY candidate_id ${collation} LIMIT $6`,
    [
      actor.tenantId,
      actor.spaceId,
      query.projectId,
      actor.principalId,
      query.afterCandidateId,
      query.limit + 1,
    ],
  );
  if (rows.length > query.limit + 1) fail("catalog_invalid");
  const candidates: ProjectMediaResultCandidate[] = [];
  let previous = query.afterCandidateId;
  for (const row of rows) {
    const candidate = parseProjectMediaResultCandidate(raw(row.record_json)),
      indexed = values(candidate),
      source = candidate.frozen.request;
    if (
      columns.some((key, i) => String(row[key]) !== String(indexed[i])) ||
      source.actor.tenantId !== actor.tenantId ||
      source.actor.spaceId !== actor.spaceId ||
      source.actor.principalId !== actor.principalId ||
      source.query.projectId !== query.projectId ||
      (previous !== null && candidate.candidateId <= previous)
    )
      fail("history_invalid");
    // Validate against original Run/input/operation history, including the lookahead row.
    const actual = yield* mediaResultLoadPlan(d, {
      actor,
      query: source.query,
    });
    if (!mediaInputSame(actual, candidate)) fail("history_invalid");
    previous = candidate.candidateId;
    candidates.push(candidate);
  }
  const hasMore = candidates.length > query.limit;
  if (hasMore) candidates.pop();
  return Object.freeze({
    candidates: Object.freeze(candidates),
    nextCandidateId: hasMore ? candidates.at(-1)!.candidateId : null,
  });
}
