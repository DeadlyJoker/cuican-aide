import type { PublicProjectAssetView } from "../project-assets-v2-service";
import type { AdoptProjectAssetMediaReferenceRequest } from "../project-assets-v2-types";
import type { ProjectMediaResultSummary } from "../project-media-results-service";

/** Display eligibility only. The host independently checks the frozen generation inputs and current asset. */
export function mediaReferenceTarget(
  view: PublicProjectAssetView | null,
  candidate: ProjectMediaResultSummary,
  projectId: string | null,
): Omit<AdoptProjectAssetMediaReferenceRequest, "idempotencyKey"> | null {
  if (
    !view ||
    view.asset.kind !== "character" ||
    view.asset.locked ||
    view.dependencyState !== "current" ||
    !view.selectedContentRevision ||
    view.asset.projectId !== projectId ||
    candidate.projectId !== projectId ||
    candidate.workflowId !== "krea2-reference-four-view" ||
    candidate.item.kind !== "character-reference" ||
    candidate.item.assetId !== view.asset.assetId
  )
    return null;
  return {
    projectId,
    assetId: view.asset.assetId,
    expectedAssetRevision: view.asset.revision,
    assetContentRevision: view.selectedContentRevision.contentRevision,
    runId: candidate.runId,
    resultIndex: candidate.resultIndex,
    candidateId: candidate.candidateId,
    candidateDigest: candidate.contentDigest,
  };
}
