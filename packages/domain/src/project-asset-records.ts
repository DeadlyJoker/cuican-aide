import {
  creativeProjectScopeFields,
  creativeProjectOpaqueId,
} from "./creative-project-validation.ts";
import {
  parseProjectAssetContent,
  projectAssetChecked,
  projectAssetContentDigest,
  projectAssetDigest,
  projectAssetFailure,
  projectAssetId,
  projectAssetKind,
  projectAssetRecord,
  projectAssetRevision,
  projectAssetTimestamp,
} from "./project-asset-validation.ts";
import type {
  ProjectAsset,
  ProjectAssetBriefSource,
  ProjectAssetDigester,
  ProjectAssetRevision,
  ProjectAssetScriptSource,
} from "./project-asset-types.ts";

export function parseProjectAssetBriefSource(
  input: unknown,
): ProjectAssetBriefSource {
  const value = projectAssetRecord(input, ["briefRevision", "contentDigest"]);
  return Object.freeze({
    briefRevision: projectAssetRevision(value.briefRevision),
    contentDigest: projectAssetDigest(value.contentDigest),
  });
}
export function parseProjectAssetScriptSource(
  input: unknown,
): ProjectAssetScriptSource {
  const value = projectAssetRecord(input, [
    "artifactId",
    "episodeId",
    "contentRevision",
    "contentDigest",
  ]);
  return Object.freeze({
    artifactId: projectAssetId(value.artifactId),
    episodeId: projectAssetId(value.episodeId),
    contentRevision: projectAssetRevision(value.contentRevision),
    contentDigest: projectAssetDigest(value.contentDigest),
  });
}
export function parseProjectAsset(input: unknown): ProjectAsset {
  return projectAssetChecked(() => {
    const value = projectAssetRecord(input, [
      "schemaVersion",
      "tenantId",
      "spaceId",
      "projectId",
      "ownerPrincipalId",
      "assetId",
      "kind",
      "revision",
      "latestContentRevision",
      "selectedContentRevision",
      "latestReferenceRevision",
      "selectedReferenceRevision",
      "locked",
      "createdByActorId",
      "createdAt",
      "updatedByActorId",
      "updatedAt",
    ]);
    if (value.schemaVersion !== "crewon.project-asset.v1")
      projectAssetFailure("project_asset_schema_unsupported");
    const revision = projectAssetRevision(value.revision),
      latestContentRevision = projectAssetRevision(value.latestContentRevision),
      latestReferenceRevision = projectAssetRevision(
        value.latestReferenceRevision,
        0,
      ),
      selectedContentRevision =
        value.selectedContentRevision === null
          ? null
          : projectAssetRevision(value.selectedContentRevision),
      selectedReferenceRevision =
        value.selectedReferenceRevision === null
          ? null
          : projectAssetRevision(value.selectedReferenceRevision),
      createdAt = projectAssetTimestamp(value.createdAt),
      updatedAt = projectAssetTimestamp(value.updatedAt);
    if (
      typeof value.locked !== "boolean" ||
      latestContentRevision + latestReferenceRevision > revision ||
      (selectedContentRevision !== null &&
        selectedContentRevision > latestContentRevision) ||
      (selectedReferenceRevision !== null &&
        selectedReferenceRevision > latestReferenceRevision) ||
      (selectedReferenceRevision !== null &&
        selectedContentRevision === null) ||
      (value.locked && selectedContentRevision === null) ||
      updatedAt < createdAt
    )
      projectAssetFailure("project_asset_head_invalid");
    return Object.freeze({
      schemaVersion: "crewon.project-asset.v1",
      ...creativeProjectScopeFields(value),
      projectId: projectAssetId(value.projectId),
      ownerPrincipalId: creativeProjectOpaqueId(value.ownerPrincipalId),
      assetId: projectAssetId(value.assetId),
      kind: projectAssetKind(value.kind),
      revision,
      latestContentRevision,
      selectedContentRevision,
      latestReferenceRevision,
      selectedReferenceRevision,
      locked: value.locked,
      createdByActorId: creativeProjectOpaqueId(value.createdByActorId),
      createdAt,
      updatedByActorId: creativeProjectOpaqueId(value.updatedByActorId),
      updatedAt,
    });
  });
}
export function parseProjectAssetRevision(
  input: unknown,
  digester: ProjectAssetDigester,
): ProjectAssetRevision {
  return projectAssetChecked(() => {
    const value = projectAssetRecord(input, [
      "schemaVersion",
      "tenantId",
      "spaceId",
      "projectId",
      "assetId",
      "kind",
      "contentRevision",
      "brief",
      "script",
      "content",
      "createdByActorId",
      "createdAt",
      "contentDigest",
    ]);
    if (value.schemaVersion !== "crewon.project-asset-revision.v1")
      projectAssetFailure("project_asset_schema_unsupported");
    const body = {
      schemaVersion: "crewon.project-asset-revision.v1" as const,
      ...creativeProjectScopeFields(value),
      projectId: projectAssetId(value.projectId),
      assetId: projectAssetId(value.assetId),
      kind: projectAssetKind(value.kind),
      contentRevision: projectAssetRevision(value.contentRevision),
      brief: parseProjectAssetBriefSource(value.brief),
      script:
        value.script === null
          ? null
          : parseProjectAssetScriptSource(value.script),
      content: parseProjectAssetContent(value.content),
      createdByActorId: creativeProjectOpaqueId(value.createdByActorId),
      createdAt: projectAssetTimestamp(value.createdAt),
    };
    const contentDigest = projectAssetDigest(value.contentDigest);
    if (contentDigest !== projectAssetContentDigest(body, digester))
      projectAssetFailure("project_asset_digest_mismatch");
    return Object.freeze({ ...body, contentDigest });
  });
}
export function assertProjectAssetRevisionIdentity(
  asset: ProjectAsset,
  revision: ProjectAssetRevision,
): void {
  if (
    asset.tenantId !== revision.tenantId ||
    asset.spaceId !== revision.spaceId ||
    asset.projectId !== revision.projectId ||
    asset.assetId !== revision.assetId ||
    asset.kind !== revision.kind ||
    revision.contentRevision > asset.latestContentRevision
  )
    projectAssetFailure("project_asset_revision_mismatch");
}
