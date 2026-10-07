import {
  parseProjectAsset,
  parseProjectAssetRevision,
  parseProjectAssetReferenceRevision,
  assertProjectAssetRevisionIdentity,
  assertProjectAssetReferenceRevisionIdentity,
  type ProjectAsset,
  type ProjectAssetRevision,
  type ProjectMediaAssetReferenceRevision,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import type { ActorContext } from "./authorization-port.ts";
import {
  parseProjectAssetReferenceImageQuery,
  type ProjectAssetReferenceImageQuery,
} from "./project-asset-reference-image-store-port.ts";
import {
  materialPreparationFields as fields,
  materialPreparationDigester,
} from "./project-material-preparation-record.ts";
import {
  mediaInputData,
  mediaInputActor,
  mediaInputSame,
  parseProjectMediaInputRevision,
} from "./project-media-input-record.ts";
import {
  parseProjectMediaResultRequest,
  parseProjectMediaResultCandidate,
} from "./project-media-result-record.ts";
import { projectAssetMediaImageSourceFromResult } from "./project-asset-media-reference-qualification.ts";
import type {
  ProjectMediaResultCandidate,
  ProjectMediaResultAuthority,
} from "./project-media-result-port.ts";
import type { ProjectMediaInputRevision } from "./project-media-input-port.ts";

export type ProjectAssetMediaReferenceImageRequest = Readonly<{
  actor: ActorContext;
  query: ProjectAssetReferenceImageQuery;
}>;
/** Host-internal bounded proof. Includes original input/config metadata, never a UI or model response. */
export type ProjectAssetMediaReferenceImageSource = Readonly<{
  asset: ProjectAsset;
  content: ProjectAssetRevision;
  reference: ProjectMediaAssetReferenceRevision;
  candidate: ProjectMediaResultCandidate;
  generationInput: ProjectMediaInputRevision;
}>;
export interface ProjectAssetMediaReferenceImageStore {
  loadAdoptedAssetReference(
    request: ProjectAssetMediaReferenceImageRequest,
    authority: ProjectMediaResultAuthority,
  ): Promise<ProjectAssetMediaReferenceImageSource>;
}
export function parseProjectAssetMediaReferenceImageRequest(
  input: unknown,
): ProjectAssetMediaReferenceImageRequest {
  const r = fields(mediaInputData(input, 4096), ["actor", "query"]);
  return Object.freeze({
    actor: mediaInputActor(r.actor),
    query: parseProjectAssetReferenceImageQuery(r.query),
  });
}
/** Only a selected stored V2 reference may select the original saved output. */
export function projectAssetMediaReferenceImageResultRequest(
  input: ProjectAssetMediaReferenceImageRequest,
  reference: ProjectMediaAssetReferenceRevision,
) {
  const r = parseProjectAssetMediaReferenceImageRequest(input);
  const ref = parseProjectAssetReferenceRevision(
    reference,
    materialPreparationDigester,
  );
  if (
    ref.schemaVersion !== "crewon.project-asset-reference.v2" ||
    ref.tenantId !== r.actor.tenantId ||
    ref.spaceId !== r.actor.spaceId ||
    ref.ownerPrincipalId !== r.actor.principalId ||
    ref.projectId !== r.query.projectId ||
    ref.assetId !== r.query.assetId ||
    ref.referenceRevision !== r.query.referenceRevision ||
    ref.assetContentRevision !== r.query.contentRevision
  )
    invalid();
  return parseProjectMediaResultRequest({
    actor: r.actor,
    query: {
      projectId: r.query.projectId,
      runId: ref.source.sourceRunId,
      resultIndex: ref.source.resultIndex,
    },
  });
}
export function parseProjectAssetMediaReferenceImageSource(
  input: unknown,
  request: ProjectAssetMediaReferenceImageRequest,
): ProjectAssetMediaReferenceImageSource {
  const r = parseProjectAssetMediaReferenceImageRequest(request),
    v = fields(mediaInputData(input, 192 * 1024), [
      "asset",
      "content",
      "reference",
      "candidate",
      "generationInput",
    ]),
    asset = parseProjectAsset(v.asset),
    content = parseProjectAssetRevision(v.content, materialPreparationDigester),
    reference = parseProjectAssetReferenceRevision(
      v.reference,
      materialPreparationDigester,
    ),
    candidate = parseProjectMediaResultCandidate(v.candidate),
    generationInput = parseProjectMediaInputRevision(v.generationInput);
  assertProjectAssetRevisionIdentity(asset, content);
  assertProjectAssetReferenceRevisionIdentity(asset, reference);
  if (
    reference.schemaVersion !== "crewon.project-asset-reference.v2" ||
    asset.kind !== "character" ||
    r.query.kind !== "character" ||
    asset.revision !== r.query.expectedAssetRevision ||
    asset.selectedContentRevision !== r.query.contentRevision ||
    asset.selectedReferenceRevision !== r.query.referenceRevision ||
    reference.assetContentDigest !== content.contentDigest ||
    reference.assetContentRevision !== content.contentRevision ||
    !mediaInputSame(
      reference.source,
      projectAssetMediaImageSourceFromResult(candidate, generationInput),
    )
  )
    invalid();
  const selected = projectAssetMediaReferenceImageResultRequest(r, reference),
    frozen = candidate.frozen.request;
  // Same owner may use a different current actor; original producer identity remains immutable.
  if (
    frozen.actor.tenantId !== r.actor.tenantId ||
    frozen.actor.spaceId !== r.actor.spaceId ||
    frozen.actor.principalId !== r.actor.principalId ||
    !mediaInputSame(frozen.query, selected.query)
  )
    invalid();
  return Object.freeze({
    asset,
    content,
    reference,
    candidate,
    generationInput,
  });
}
function invalid(): never {
  throw new ApplicationError(
    "conflict",
    "project_asset_media_reference_image_proof_invalid",
  );
}
