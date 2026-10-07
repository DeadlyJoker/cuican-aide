import { creativeProjectNextRevision } from "./creative-project-validation.ts";
import {
  currentProjectAssetMutation,
  type ProjectAssetMutationInput,
} from "./project-asset-mutations.ts";
import {
  parseProjectAsset,
  parseProjectAssetRevision,
  assertProjectAssetRevisionIdentity,
} from "./project-asset-records.ts";
import { parseProjectAssetReferenceRevision } from "./project-asset-reference.ts";
import {
  parseProjectAssetMediaImageSource,
  type ProjectAssetMediaImageSource,
} from "./project-asset-media-source.ts";
import {
  projectAssetInputFields,
  projectAssetChecked,
  projectAssetFailure,
  projectAssetContentDigest,
} from "./project-asset-validation.ts";
import type {
  ProjectAsset,
  ProjectAssetDigester,
  ProjectAssetRevision,
  ProjectMediaAssetReferenceRevision,
} from "./project-asset-types.ts";

/** The Store must prove original saved media history and current dependencies on its commit connection. */
export function adoptProjectAssetMediaReference(
  input: ProjectAssetMutationInput &
    Readonly<{
      asset: ProjectAsset;
      contentRevision: ProjectAssetRevision;
      source: ProjectAssetMediaImageSource;
    }>,
  digester: ProjectAssetDigester,
): Readonly<{
  asset: ProjectAsset;
  referenceRevision: ProjectMediaAssetReferenceRevision;
}> {
  return projectAssetChecked(() => {
    const values = projectAssetInputFields(input, [
        "project",
        "actor",
        "asset",
        "expectedAssetRevision",
        "at",
        "contentRevision",
        "source",
      ]),
      current = currentProjectAssetMutation(values as typeof input),
      asset = current.asset;
    if (!asset) projectAssetFailure("project_asset_not_found");
    if (asset.locked) projectAssetFailure("project_asset_locked");
    if (asset.kind !== "character")
      projectAssetFailure("project_asset_media_reference_purpose_mismatch");
    const content = parseProjectAssetRevision(values.contentRevision, digester),
      source = parseProjectAssetMediaImageSource(values.source);
    assertProjectAssetRevisionIdentity(asset, content);
    if (
      asset.selectedContentRevision !== content.contentRevision ||
      source.generatedFor.assetId !== asset.assetId ||
      source.generatedFor.contentRevision !== content.contentRevision ||
      source.generatedFor.contentDigest !== content.contentDigest
    )
      projectAssetFailure("project_asset_reference_stale");
    if (current.at < source.observedAt)
      projectAssetFailure("project_asset_timestamp_invalid");
    const referenceRevision = creativeProjectNextRevision(
        asset.latestReferenceRevision,
      ),
      next = parseProjectAsset({
        ...asset,
        revision: creativeProjectNextRevision(asset.revision),
        latestReferenceRevision: referenceRevision,
        selectedReferenceRevision: referenceRevision,
        updatedByActorId: current.actor.actorId,
        updatedAt: current.at,
      }),
      body = {
        schemaVersion: "crewon.project-asset-reference.v2" as const,
        tenantId: asset.tenantId,
        spaceId: asset.spaceId,
        projectId: asset.projectId,
        ownerPrincipalId: asset.ownerPrincipalId,
        assetId: asset.assetId,
        referenceRevision,
        assetContentRevision: content.contentRevision,
        assetContentDigest: content.contentDigest,
        source,
        createdByActorId: current.actor.actorId,
        createdAt: current.at,
      },
      reference = parseProjectAssetReferenceRevision(
        { ...body, contentDigest: projectAssetContentDigest(body, digester) },
        digester,
      );
    if (reference.schemaVersion !== "crewon.project-asset-reference.v2")
      projectAssetFailure("project_asset_schema_unsupported");
    return Object.freeze({ asset: next, referenceRevision: reference });
  });
}
