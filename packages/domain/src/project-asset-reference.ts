import {
  creativeProjectScopeFields,
  creativeProjectOpaqueId,
  assertCreativeProjectScope,
  creativeProjectNextRevision,
} from "./creative-project-validation.ts";
import { parseProjectAssetMediaImageSource } from "./project-asset-media-source.ts";
import {
  parseCurrentConceptSelection,
  assertConceptSelectionResult,
  type CurrentConceptSelection,
} from "./current-concept-selection.ts";
import {
  parseOperationResultLink,
  operationResultId,
  operationResultIndex,
  type OperationResultLink,
} from "./operation-result-link.ts";
import {
  parseProjectAsset,
  parseProjectAssetRevision,
  assertProjectAssetRevisionIdentity,
} from "./project-asset-records.ts";
import {
  currentProjectAssetMutation,
  type ProjectAssetMutationInput,
} from "./project-asset-mutations.ts";
import {
  projectAssetChecked,
  projectAssetContentDigest,
  projectAssetDigest,
  projectAssetFailure,
  projectAssetId,
  projectAssetRecord,
  projectAssetRevision,
  projectAssetTimestamp,
  projectAssetInputFields,
} from "./project-asset-validation.ts";
import type {
  ProjectAsset,
  ProjectAssetDigester,
  ProjectAssetImageSource,
  ProjectAssetReferenceMutation,
  ProjectAssetReferenceRevision,
  ProjectConceptAssetReferenceRevision,
  ProjectAssetRevision,
} from "./project-asset-types.ts";

export function parseProjectAssetImageSource(
  input: unknown,
): ProjectAssetImageSource {
  return projectAssetChecked(() => {
    const value = projectAssetRecord(input, [
      "conceptAssetId",
      "conceptAssetRevision",
      "selectionRevision",
      "conceptSelectionDigest",
      "resultLinkDigest",
      "generationLinkDigest",
      "sourceRunId",
      "sourceBindingDigest",
      "pluginId",
      "pluginVersion",
      "packageDigest",
      "configurationRevision",
      "configurationDigest",
      "operationId",
      "operationRevision",
      "operationDigest",
      "rawResultDigest",
      "resultIndex",
    ]);
    return Object.freeze({
      conceptAssetId: projectAssetId(value.conceptAssetId),
      conceptAssetRevision: projectAssetRevision(value.conceptAssetRevision),
      selectionRevision: projectAssetRevision(value.selectionRevision),
      conceptSelectionDigest: projectAssetDigest(value.conceptSelectionDigest),
      resultLinkDigest: projectAssetDigest(value.resultLinkDigest),
      generationLinkDigest: projectAssetDigest(value.generationLinkDigest),
      sourceRunId: creativeProjectOpaqueId(value.sourceRunId),
      sourceBindingDigest: projectAssetDigest(value.sourceBindingDigest),
      pluginId: creativeProjectOpaqueId(value.pluginId),
      pluginVersion: creativeProjectOpaqueId(value.pluginVersion),
      packageDigest: projectAssetDigest(value.packageDigest),
      configurationRevision: projectAssetRevision(value.configurationRevision),
      configurationDigest: projectAssetDigest(value.configurationDigest),
      operationId: operationResultId(value.operationId),
      operationRevision: projectAssetRevision(value.operationRevision),
      operationDigest: projectAssetDigest(value.operationDigest),
      rawResultDigest: projectAssetDigest(value.rawResultDigest),
      resultIndex: operationResultIndex(value.resultIndex),
    });
  });
}
export function parseProjectAssetReferenceRevision(
  input: unknown,
  digester: ProjectAssetDigester,
): ProjectAssetReferenceRevision {
  return projectAssetChecked(() => {
    const value = projectAssetRecord(input, [
      "schemaVersion",
      "tenantId",
      "spaceId",
      "projectId",
      "ownerPrincipalId",
      "assetId",
      "referenceRevision",
      "assetContentRevision",
      "assetContentDigest",
      "source",
      "createdByActorId",
      "createdAt",
      "contentDigest",
    ]);
    if (
      value.schemaVersion !== "crewon.project-asset-reference.v1" &&
      value.schemaVersion !== "crewon.project-asset-reference.v2"
    )
      projectAssetFailure("project_asset_schema_unsupported");
    const origin =
      value.schemaVersion === "crewon.project-asset-reference.v1"
        ? {
            schemaVersion: "crewon.project-asset-reference.v1" as const,
            source: parseProjectAssetImageSource(value.source),
          }
        : {
            schemaVersion: "crewon.project-asset-reference.v2" as const,
            source: parseProjectAssetMediaImageSource(value.source),
          };
    const body = {
      ...origin,
      ...creativeProjectScopeFields(value),
      projectId: projectAssetId(value.projectId),
      ownerPrincipalId: creativeProjectOpaqueId(value.ownerPrincipalId),
      assetId: projectAssetId(value.assetId),
      referenceRevision: projectAssetRevision(value.referenceRevision),
      assetContentRevision: projectAssetRevision(value.assetContentRevision),
      assetContentDigest: projectAssetDigest(value.assetContentDigest),
      createdByActorId: creativeProjectOpaqueId(value.createdByActorId),
      createdAt: projectAssetTimestamp(value.createdAt),
    };
    if (
      body.schemaVersion === "crewon.project-asset-reference.v2" &&
      (body.source.generatedFor.assetId !== body.assetId ||
        body.source.generatedFor.contentRevision !==
          body.assetContentRevision ||
        body.source.generatedFor.contentDigest !== body.assetContentDigest ||
        body.createdAt < body.source.observedAt)
    )
      projectAssetFailure("project_asset_reference_mismatch");
    const contentDigest = projectAssetDigest(value.contentDigest);
    if (contentDigest !== projectAssetContentDigest(body, digester))
      projectAssetFailure("project_asset_digest_mismatch");
    return Object.freeze({ ...body, contentDigest });
  });
}
/** The existing SQL index column stores an origin digest; the record's explicit version determines its meaning. */
export function projectAssetReferenceOriginDigest(
  reference: ProjectAssetReferenceRevision,
): string {
  return reference.schemaVersion === "crewon.project-asset-reference.v1"
    ? reference.source.resultLinkDigest
    : reference.source.candidateDigest;
}
export function assertProjectAssetReferenceRevisionIdentity(
  asset: ProjectAsset,
  reference: ProjectAssetReferenceRevision,
): void {
  if (
    asset.tenantId !== reference.tenantId ||
    asset.spaceId !== reference.spaceId ||
    asset.projectId !== reference.projectId ||
    asset.ownerPrincipalId !== reference.ownerPrincipalId ||
    asset.assetId !== reference.assetId ||
    reference.referenceRevision > asset.latestReferenceRevision ||
    reference.assetContentRevision > asset.latestContentRevision
  )
    projectAssetFailure("project_asset_reference_mismatch");
}
/** The caller must prove succeeded original Run/admission/configuration/operation on its Store connection. */
export function saveProjectAssetReferenceCandidate(
  input: ProjectAssetMutationInput &
    Readonly<{
      asset: ProjectAsset;
      contentRevision: ProjectAssetRevision;
      conceptSelection: CurrentConceptSelection;
      resultLink: OperationResultLink;
      expectedConceptSelectionRevision: number;
    }>,
  digester: ProjectAssetDigester,
): Readonly<{
  asset: ProjectAsset;
  referenceRevision: ProjectConceptAssetReferenceRevision;
}> {
  return projectAssetChecked(() => {
    input = projectAssetInputFields(input, [
      "project",
      "actor",
      "asset",
      "expectedAssetRevision",
      "at",
      "contentRevision",
      "conceptSelection",
      "resultLink",
      "expectedConceptSelectionRevision",
    ]) as typeof input;
    const current = currentProjectAssetMutation(input),
      asset = current.asset;
    if (asset === null) projectAssetFailure("project_asset_not_found");
    const content = parseProjectAssetRevision(input.contentRevision, digester);
    assertProjectAssetRevisionIdentity(asset, content);
    const selection = parseCurrentConceptSelection(
        input.conceptSelection,
        digester,
      ),
      link = parseOperationResultLink(input.resultLink, digester);
    assertCreativeProjectScope(current.project, selection);
    assertCreativeProjectScope(current.project, link);
    assertConceptSelectionResult(selection, link);
    if (
      selection.ownerPrincipalId !== current.actor.principalId ||
      selection.selectionRevision !==
        projectAssetRevision(input.expectedConceptSelectionRevision)
    )
      projectAssetFailure("project_asset_concept_selection_changed");
    if (current.at < selection.selectedAt || current.at < link.observedAt)
      projectAssetFailure("project_asset_timestamp_invalid");
    const next = parseProjectAsset({
      ...asset,
      revision: creativeProjectNextRevision(asset.revision),
      latestReferenceRevision: creativeProjectNextRevision(
        asset.latestReferenceRevision,
      ),
      updatedByActorId: current.actor.actorId,
      updatedAt: current.at,
    });
    const source: ProjectAssetImageSource = Object.freeze({
      conceptAssetId: link.reference.assetId,
      conceptAssetRevision: link.reference.assetRevision,
      selectionRevision: selection.selectionRevision,
      conceptSelectionDigest: selection.contentDigest,
      resultLinkDigest: link.contentDigest,
      generationLinkDigest: link.generationLinkDigest,
      sourceRunId: link.sourceRunId,
      sourceBindingDigest: link.sourceBindingDigest,
      pluginId: link.pluginId,
      pluginVersion: link.pluginVersion,
      packageDigest: link.packageDigest,
      configurationRevision: link.configurationRevision,
      configurationDigest: link.configurationDigest,
      operationId: link.operationId,
      operationRevision: link.operationRevision,
      operationDigest: link.operationDigest,
      rawResultDigest: link.rawResultDigest,
      resultIndex: link.image.resultIndex,
    });
    const body = {
      schemaVersion: "crewon.project-asset-reference.v1" as const,
      tenantId: asset.tenantId,
      spaceId: asset.spaceId,
      projectId: asset.projectId,
      ownerPrincipalId: asset.ownerPrincipalId,
      assetId: asset.assetId,
      referenceRevision: next.latestReferenceRevision,
      assetContentRevision: content.contentRevision,
      assetContentDigest: content.contentDigest,
      source,
      createdByActorId: current.actor.actorId,
      createdAt: current.at,
    };
    const referenceRevision = parseProjectAssetReferenceRevision(
      { ...body, contentDigest: projectAssetContentDigest(body, digester) },
      digester,
    );
    if (referenceRevision.schemaVersion !== "crewon.project-asset-reference.v1")
      projectAssetFailure("project_asset_schema_unsupported");
    return Object.freeze({
      asset: next,
      referenceRevision,
    });
  });
}
export function selectProjectAssetReferenceRevision(
  input: ProjectAssetMutationInput &
    Readonly<{
      asset: ProjectAsset;
      selectedContentRevision: ProjectAssetRevision;
      referenceRevision: ProjectAssetReferenceRevision;
    }>,
  digester: ProjectAssetDigester,
): ProjectAssetReferenceMutation {
  return projectAssetChecked(() => {
    input = projectAssetInputFields(input, [
      "project",
      "actor",
      "asset",
      "expectedAssetRevision",
      "at",
      "selectedContentRevision",
      "referenceRevision",
    ]) as typeof input;
    const current = currentProjectAssetMutation(input),
      asset = current.asset;
    if (asset === null) projectAssetFailure("project_asset_not_found");
    const content = parseProjectAssetRevision(
        input.selectedContentRevision,
        digester,
      ),
      reference = parseProjectAssetReferenceRevision(
        input.referenceRevision,
        digester,
      );
    assertProjectAssetRevisionIdentity(asset, content);
    assertProjectAssetReferenceRevisionIdentity(asset, reference);
    if (
      asset.selectedContentRevision !== content.contentRevision ||
      reference.assetContentRevision !== content.contentRevision ||
      reference.assetContentDigest !== content.contentDigest
    )
      projectAssetFailure("project_asset_reference_stale");
    if (
      asset.locked &&
      asset.selectedReferenceRevision !== reference.referenceRevision
    )
      projectAssetFailure("project_asset_locked");
    return Object.freeze({
      asset: parseProjectAsset({
        ...asset,
        revision: creativeProjectNextRevision(asset.revision),
        selectedReferenceRevision: reference.referenceRevision,
        updatedByActorId: current.actor.actorId,
        updatedAt: current.at,
      }),
      referenceRevision: reference,
    });
  });
}
export function projectAssetReferenceState(
  asset: ProjectAsset,
  selectedContent: ProjectAssetRevision | null,
  selectedReference: ProjectAssetReferenceRevision | null,
): "unselected" | "current" | "stale" {
  if (selectedReference === null) {
    if (asset.selectedReferenceRevision !== null)
      projectAssetFailure("project_asset_reference_mismatch");
    return "unselected";
  }
  assertProjectAssetReferenceRevisionIdentity(asset, selectedReference);
  if (asset.selectedReferenceRevision !== selectedReference.referenceRevision)
    projectAssetFailure("project_asset_reference_mismatch");
  if (selectedContent !== null)
    assertProjectAssetRevisionIdentity(asset, selectedContent);
  if (
    asset.selectedContentRevision !== (selectedContent?.contentRevision ?? null)
  )
    projectAssetFailure("project_asset_revision_mismatch");
  return selectedContent !== null &&
    selectedReference.assetContentRevision ===
      selectedContent.contentRevision &&
    selectedReference.assetContentDigest === selectedContent.contentDigest
    ? "current"
    : "stale";
}
