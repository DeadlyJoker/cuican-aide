import {
  parseProjectAssetMediaImageSource,
  projectAssetDigest,
  projectAssetId,
  projectAssetRevision,
  projectAssetTimestamp,
} from "@crewon/domain";
import type { ContentDigester } from "./application-runtime-ports.ts";
import type {
  FrozenProjectAdoptedMediaMaterial,
  ProjectReferenceMaterialFreezeRequest,
} from "./project-reference-material-freeze-port.ts";
import type { ProjectAssetMediaReferenceImageSource } from "./project-asset-media-reference-image.ts";
import {
  parseProjectReferenceMaterialFreezeRequest,
  projectReferenceMaterialFreezeIdentity,
} from "./project-reference-material-freeze-record.ts";
import {
  mediaInputData,
  mediaInputActor,
  mediaInputSame,
} from "./project-media-input-record.ts";
import { materialPreparationFields as fields } from "./project-material-preparation-record.ts";

/** Bounded metadata codec. Only the actual reader/freezer can prove and capture the bytes. */
export function parseFrozenProjectAdoptedMediaMaterial(
  input: unknown,
  digester: ContentDigester,
): FrozenProjectAdoptedMediaMaterial {
  const r = fields(mediaInputData(input, 32 * 1024), [
    "schemaVersion",
    "archiveId",
    "materialId",
    "requestDigest",
    "request",
    "source",
  ]);
  if (r.schemaVersion !== "crewon.project-reference-frozen-material.v2")
    invalid();
  const request = parseProjectReferenceMaterialFreezeRequest(r.request),
    identity = projectReferenceMaterialFreezeIdentity(
      request,
      projectAssetId(r.archiveId),
      digester,
    ),
    s = fields(r.source, [
      "actor",
      "projectId",
      "assetId",
      "assetRevision",
      "contentRevision",
      "contentDigest",
      "referenceRevision",
      "referenceDigest",
      "media",
      "byteDigest",
      "byteLength",
      "mediaType",
      "width",
      "height",
      "observedAt",
    ]),
    actor = mediaInputActor(s.actor),
    media = parseProjectAssetMediaImageSource(s.media);
  if (
    r.materialId !== identity.materialId ||
    r.requestDigest !== identity.requestDigest ||
    request.query.kind !== "character" ||
    !mediaInputSame(actor, request.actor) ||
    s.projectId !== request.query.projectId ||
    s.assetId !== request.query.assetId ||
    s.assetRevision !== request.query.expectedAssetRevision ||
    s.contentRevision !== request.query.contentRevision ||
    s.referenceRevision !== request.query.referenceRevision ||
    media.generatedFor.assetId !== s.assetId ||
    media.generatedFor.contentRevision !== s.contentRevision ||
    media.generatedFor.contentDigest !== s.contentDigest ||
    s.mediaType !== "image/png"
  )
    invalid();
  const byteLength = projectAssetRevision(s.byteLength),
    width = projectAssetRevision(s.width),
    height = projectAssetRevision(s.height);
  if (
    byteLength < 57 ||
    byteLength > 16 * 1024 * 1024 ||
    width > 4096 ||
    height > 4096
  )
    invalid();
  return Object.freeze({
    schemaVersion: "crewon.project-reference-frozen-material.v2",
    ...identity,
    request,
    source: Object.freeze({
      actor,
      projectId: request.query.projectId,
      assetId: request.query.assetId,
      assetRevision: request.query.expectedAssetRevision,
      contentRevision: request.query.contentRevision,
      contentDigest: projectAssetDigest(s.contentDigest),
      referenceRevision: request.query.referenceRevision,
      referenceDigest: projectAssetDigest(s.referenceDigest),
      media,
      byteDigest: projectAssetDigest(s.byteDigest),
      byteLength,
      mediaType: "image/png",
      width,
      height,
      observedAt: projectAssetTimestamp(s.observedAt),
    }),
  });
}

/** Snapshot of original candidate bytes plus the current adopted reference; never a supplier URL. */
export function createFrozenProjectAdoptedMediaMaterial(
  request: ProjectReferenceMaterialFreezeRequest,
  archiveId: string,
  source: ProjectAssetMediaReferenceImageSource,
  digester: ContentDigester,
): FrozenProjectAdoptedMediaMaterial {
  const bytes = source.candidate.frozen.source;
  return parseFrozenProjectAdoptedMediaMaterial(
    {
      schemaVersion: "crewon.project-reference-frozen-material.v2",
      ...projectReferenceMaterialFreezeIdentity(request, archiveId, digester),
      request,
      source: {
        actor: request.actor,
        projectId: source.asset.projectId,
        assetId: source.asset.assetId,
        assetRevision: source.asset.revision,
        contentRevision: source.content.contentRevision,
        contentDigest: source.content.contentDigest,
        referenceRevision: source.reference.referenceRevision,
        referenceDigest: source.reference.contentDigest,
        media: source.reference.source,
        byteDigest: bytes.byteDigest,
        byteLength: bytes.byteLength,
        mediaType: bytes.mediaType,
        width: bytes.width,
        height: bytes.height,
        observedAt: bytes.observedAt,
      },
    },
    digester,
  );
}

export function assertFrozenProjectAdoptedMediaSource(
  record: FrozenProjectAdoptedMediaMaterial,
  source: ProjectAssetMediaReferenceImageSource,
  digester: ContentDigester,
): void {
  const expected = createFrozenProjectAdoptedMediaMaterial(
    record.request,
    record.archiveId,
    source,
    digester,
  );
  if (!mediaInputSame(record, expected)) invalid();
}
function invalid(): never {
  throw new Error("project_adopted_media_frozen_material_invalid");
}
