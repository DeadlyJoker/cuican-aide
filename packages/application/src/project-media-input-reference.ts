import {
  parseProjectAssetMediaImageSource,
  projectAssetDigest,
  projectAssetId,
  operationResultIndex,
} from "@crewon/domain";
import type {
  ProjectMediaInputSource,
  ProjectMediaReference,
  ProjectMediaRole,
  ProjectConceptMediaReference,
} from "./project-media-input-port.ts";
import type { ActorContext } from "./authorization-port.ts";
import {
  materialPreparationFields as fields,
  parseProjectMaterialPreparationRequest,
} from "./project-material-preparation-record.ts";
import {
  mediaInputDigest,
  mediaInputSame,
  projectMediaInputFail as fail,
} from "./project-media-input-record.ts";
export function mediaInputReference(
  role: ProjectMediaRole,
  source: ProjectMediaInputSource,
  preparation: ProjectMediaReference["preparation"],
): ProjectMediaReference {
  const common = {
    role,
    sourceDigest: mediaInputDigest(source),
    contentDigest: source.content.contentDigest,
    referenceDigest: source.reference.contentDigest,
    preparation,
  };
  if ("candidate" in source) {
    const media = source.reference.source;
    return Object.freeze({
      ...common,
      sourceKind: "media-result",
      media,
      sourceRunId: media.sourceRunId,
      operationId: media.operationId,
      resultIndex: media.resultIndex,
      sourceConfigurationDigest: media.configurationDigest,
    });
  }
  const link = source.resultLink;
  return Object.freeze({
    ...common,
    resultLinkDigest: link.contentDigest,
    sourceBindingDigest: link.sourceBindingDigest,
    sourceRunId: link.sourceRunId,
    operationId: link.operationId,
    resultIndex: link.image.resultIndex,
    sourceConfigurationDigest: source.configuration.contentDigest,
  });
}

/** Explicit origin branches keep legacy persisted references byte-compatible. */
export function parseProjectMediaInputReference(
  input: unknown,
  actor: ActorContext,
  projectId: string,
  role: ProjectMediaRole,
): ProjectMediaReference {
  const media =
      input !== null &&
      typeof input === "object" &&
      Object.hasOwn(input, "sourceKind"),
    a = fields(input, [
      "role",
      "sourceDigest",
      "contentDigest",
      "referenceDigest",
      "sourceRunId",
      "operationId",
      "resultIndex",
      "sourceConfigurationDigest",
      "preparation",
      ...(media
        ? ["sourceKind", "media"]
        : ["resultLinkDigest", "sourceBindingDigest"]),
    ]),
    preparation = parseProjectMaterialPreparationRequest(a.preparation),
    q = preparation.source.query;
  if (
    a.role !== role ||
    !mediaInputSame(preparation.source.actor, actor) ||
    q.projectId !== projectId ||
    q.kind !== (role === "scene" ? "scene" : "character")
  )
    fail("record_invalid");
  const common = {
    role,
    sourceDigest: projectAssetDigest(a.sourceDigest),
    contentDigest: projectAssetDigest(a.contentDigest),
    referenceDigest: projectAssetDigest(a.referenceDigest),
    sourceRunId: projectAssetId(a.sourceRunId),
    operationId: projectAssetId(a.operationId),
    resultIndex: operationResultIndex(a.resultIndex),
    sourceConfigurationDigest: projectAssetDigest(a.sourceConfigurationDigest),
    preparation,
  };
  if (!media)
    return Object.freeze({
      ...common,
      resultLinkDigest: projectAssetDigest(a.resultLinkDigest),
      sourceBindingDigest: projectAssetDigest(a.sourceBindingDigest),
    }) satisfies ProjectConceptMediaReference;
  const original = parseProjectAssetMediaImageSource(a.media);
  if (
    a.sourceKind !== "media-result" ||
    q.kind !== "character" ||
    original.generatedFor.assetId !== q.assetId ||
    original.generatedFor.contentRevision !== q.contentRevision ||
    original.generatedFor.contentDigest !== common.contentDigest ||
    original.sourceRunId !== common.sourceRunId ||
    original.operationId !== common.operationId ||
    original.resultIndex !== common.resultIndex ||
    original.configurationDigest !== common.sourceConfigurationDigest
  )
    fail("reference_invalid");
  return Object.freeze({
    ...common,
    sourceKind: "media-result",
    media: original,
  });
}
