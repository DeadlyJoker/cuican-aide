import type { ProjectAssetReferenceRevision } from "@crewon/domain";
import {
  parsePublicProjectAssetReferenceRevisionV2,
  parsePublicProjectAssetViewV2,
  type PublicProjectAssetReferenceRevisionV2,
} from "@crewon/contracts/project-assets-v2";
import type {
  ProjectAssetView,
  ProjectAssetMutationResult,
} from "./project-asset-store-port.ts";
import {
  projectAssetPublicHead,
  projectAssetPublicRevision,
} from "./plugin-project-asset-action-projection.ts";

/** Explicit versioned projection. The original v1 projection remains unchanged. */
export function projectAssetPublicReferenceV2(
  r: ProjectAssetReferenceRevision,
): PublicProjectAssetReferenceRevisionV2 {
  const source = r.source;
  return parsePublicProjectAssetReferenceRevisionV2({
    projectId: r.projectId,
    assetId: r.assetId,
    referenceRevision: r.referenceRevision,
    assetContentRevision: r.assetContentRevision,
    assetContentDigest: r.assetContentDigest,
    source:
      r.schemaVersion === "crewon.project-asset-reference.v1"
        ? { kind: "concept-selection", ...r.source }
        : {
            kind: "media-result",
            candidateId: r.source.candidateId,
            candidateDigest: r.source.candidateDigest,
            sourceRunId: source.sourceRunId,
            resultIndex: source.resultIndex,
            mediaInputId: r.source.mediaInputId,
            inputRevision: r.source.inputRevision,
            workflowId: r.source.workflowId,
            generatedFor: r.source.generatedFor,
            observedAt: r.source.observedAt,
          },
    createdAt: r.createdAt,
    contentDigest: r.contentDigest,
  });
}
export function projectAssetPublicViewV2(v: ProjectAssetView | null) {
  return v === null
    ? null
    : parsePublicProjectAssetViewV2({
        asset: projectAssetPublicHead(v.asset),
        selectedContentRevision:
          v.selectedRevision === null
            ? null
            : projectAssetPublicRevision(v.selectedRevision),
        selectedReferenceRevision:
          v.selectedReference === null
            ? null
            : projectAssetPublicReferenceV2(v.selectedReference),
        dependencyState: v.dependencyState,
        staleReasons: v.staleReasons,
        referenceState: v.referenceState,
      });
}
export function projectAssetPublicMutationV2(v: ProjectAssetMutationResult) {
  return Object.freeze({
    kind: v.kind,
    disposition: v.disposition,
    asset: projectAssetPublicHead(v.asset),
    contentRevision:
      v.contentRevision === null
        ? null
        : projectAssetPublicRevision(v.contentRevision),
    referenceRevision:
      v.referenceRevision === null
        ? null
        : projectAssetPublicReferenceV2(v.referenceRevision),
  });
}
