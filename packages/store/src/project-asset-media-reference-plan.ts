import {
  ApplicationError,
  projectAssetMediaReferenceResultRequest,
  projectAssetMediaImageSourceFromResult,
  type ProjectAssetMediaReferenceQualificationRequest,
  type QualifiedProjectAssetMediaReference,
} from "@crewon/application";
import {
  assertProjectAssetRevisionIdentity,
  assertProjectAssetReferenceRevisionIdentity,
  projectAssetDependencyStatus,
} from "@crewon/domain";
import {
  assetLock,
  assetOwner,
  assetProject,
  assetHead,
  assetContent,
  assetReference,
  assetBrief,
  assetSelectedScript,
  type AssetDialect,
} from "./project-asset-store-support.ts";
import { assertProjectAssetCurrentScriptSource } from "./project-asset-script-source.ts";
import { loadProjectMediaGenerationContextPlan } from "./project-media-generation-read.ts";
import {
  mediaResultLoadPlan,
  type MediaResultPlan,
} from "./project-media-result-plan.ts";

/** Read-only qualification on the original parent connection. No new reference or selection is written. */
export function* qualifyAssetMediaReferencePlan(
  d: AssetDialect,
  request: ProjectAssetMediaReferenceQualificationRequest,
): MediaResultPlan<QualifiedProjectAssetMediaReference> {
  const { actor, query: q } = request,
    owner = assetOwner(actor);
  yield { assetSchema: true };
  yield* assetLock(d, [
    "creative-project-project",
    d.schema,
    actor.tenantId,
    actor.spaceId,
    q.projectId,
  ]);
  const project = yield* assetProject(d, owner, q.projectId);
  if (project.state !== "active") invalid("project_archived");
  const asset = yield* assetHead(d, owner, q.projectId, q.assetId);
  if (!asset) invalid("asset_not_found");
  if (asset.kind !== "character") invalid("purpose_mismatch");
  if (asset.locked) invalid("asset_locked");
  if (
    asset.revision !== q.expectedAssetRevision ||
    asset.selectedContentRevision !== q.assetContentRevision
  )
    invalid("asset_changed");
  const content = yield* assetContent(
    d,
    owner,
    q.projectId,
    q.assetId,
    q.assetContentRevision,
  );
  if (!content) invalid("history_changed");
  assertProjectAssetRevisionIdentity(asset, content);
  const brief = yield* assetBrief(
      d,
      owner,
      q.projectId,
      project.latestBriefRevision,
    ),
    script = yield* assetSelectedScript(d, owner, q.projectId, content);
  if (
    projectAssetDependencyStatus(content, brief, script).dependencyState !==
    "current"
  )
    invalid("source_stale");
  if (script)
    yield* assertProjectAssetCurrentScriptSource(
      d,
      owner,
      q.projectId,
      script,
      brief,
      {
        failureCode: "project_asset_source_stale",
      },
    );
  const result = yield* mediaResultLoadPlan(
    d,
    projectAssetMediaReferenceResultRequest(request),
  );
  if (!result) invalid("candidate_not_found");
  if (
    result.candidateId !== q.candidateId ||
    result.contentDigest !== q.candidateDigest
  )
    invalid("candidate_changed");
  const history = yield* loadProjectMediaGenerationContextPlan(d, {
    tenantId: actor.tenantId,
    spaceId: actor.spaceId,
    runId: q.runId,
  });
  if (
    !history ||
    history.link.contentDigest !==
      result.frozen.source.projection.generationDigest
  )
    invalid("history_changed");
  const source = projectAssetMediaImageSourceFromResult(result, history.input),
    generated = source.generatedFor;
  if (
    generated.assetId !== q.assetId ||
    generated.contentRevision !== content.contentRevision ||
    generated.contentDigest !== content.contentDigest
  )
    invalid("source_stale");
  // Preserve the original input anchor even after another reference is selected.
  const original = yield* assetReference(
    d,
    owner,
    q.projectId,
    q.assetId,
    generated.referenceRevision,
  );
  if (
    !original ||
    original.contentDigest !== generated.referenceDigest ||
    original.assetContentRevision !== content.contentRevision ||
    original.assetContentDigest !== content.contentDigest
  )
    invalid("history_changed");
  assertProjectAssetReferenceRevisionIdentity(asset, original);
  return Object.freeze({ asset, content, source });
}
function invalid(code: string): never {
  throw new ApplicationError(
    "conflict",
    `project_asset_media_reference_${code}`,
  );
}
