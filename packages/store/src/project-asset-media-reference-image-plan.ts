import {
  ApplicationError,
  parseProjectAssetMediaReferenceImageSource,
  projectAssetMediaReferenceImageResultRequest,
  mediaInputSame,
  type ProjectAssetMediaReferenceImageRequest,
  type ProjectAssetMediaReferenceImageSource,
  type ProjectMediaResultRequest,
} from "@crewon/application";
import { loadSelectedAssetReferenceRecords } from "./project-asset-reference-image-plan.ts";
import {
  mediaResultLoadPlan,
  type MediaResultPlan,
} from "./project-media-result-plan.ts";
import { loadProjectMediaGenerationContextPlan } from "./project-media-generation-read.ts";
import {
  assetReference,
  assetOwner,
  type AssetDialect,
} from "./project-asset-store-support.ts";

/** Reprove the selected reference, original input and saved output on one original project connection. */
export function* loadAssetMediaReferenceImagePlan(
  d: AssetDialect,
  request: ProjectAssetMediaReferenceImageRequest,
  authorizedResult: ProjectMediaResultRequest,
): MediaResultPlan<ProjectAssetMediaReferenceImageSource> {
  yield { assetSchema: true };
  const selected = yield* loadSelectedAssetReferenceRecords(d, request),
    ref = selected.reference;
  if (ref.schemaVersion !== "crewon.project-asset-reference.v2")
    invalid("source_kind_mismatch");
  const originalRequest = projectAssetMediaReferenceImageResultRequest(
    request,
    ref,
  );
  if (!mediaInputSame(originalRequest, authorizedResult))
    invalid("authority_mismatch");
  const candidate = yield* mediaResultLoadPlan(d, originalRequest);
  if (!candidate) invalid("candidate_missing");
  const history = yield* loadProjectMediaGenerationContextPlan(d, {
    tenantId: request.actor.tenantId,
    spaceId: request.actor.spaceId,
    runId: ref.source.sourceRunId,
  });
  if (
    !history ||
    history.link.contentDigest !==
      candidate.frozen.source.projection.generationDigest
  )
    invalid("history_changed");
  const result = parseProjectAssetMediaReferenceImageSource(
    { ...selected, candidate, generationInput: history.input },
    request,
  );
  const anchor = ref.source.generatedFor,
    original = yield* assetReference(
      d,
      assetOwner(request.actor),
      request.query.projectId,
      request.query.assetId,
      anchor.referenceRevision,
    );
  if (
    !original ||
    original.contentDigest !== anchor.referenceDigest ||
    original.assetContentRevision !== anchor.contentRevision ||
    original.assetContentDigest !== anchor.contentDigest
  )
    invalid("history_changed");
  return result;
}
function invalid(code: string): never {
  throw new ApplicationError(
    "conflict",
    `project_asset_media_reference_image_${code}`,
  );
}
