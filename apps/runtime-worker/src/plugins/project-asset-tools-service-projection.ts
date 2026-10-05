import type { ProjectAsset, ProjectAssetRevision } from "@crewon/domain";
import {
  projectAssetToolsCodec,
  type ProjectAssetToolsRequests,
} from "@crewon/contracts/project-asset-tools";
export function projectAssetToolHead(a: ProjectAsset) {
  return {
    projectId: a.projectId,
    assetId: a.assetId,
    kind: a.kind,
    revision: a.revision,
    latestContentRevision: a.latestContentRevision,
    selectedContentRevision: a.selectedContentRevision,
    latestReferenceRevision: a.latestReferenceRevision,
    selectedReferenceRevision: a.selectedReferenceRevision,
    locked: a.locked,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}
export function projectAssetToolRevision(r: ProjectAssetRevision) {
  return {
    projectId: r.projectId,
    assetId: r.assetId,
    kind: r.kind,
    contentRevision: r.contentRevision,
    brief: r.brief,
    script: r.script,
    createdAt: r.createdAt,
    contentDigest: r.contentDigest,
  };
}
/** Worst legal opaque ID escaping and revision metadata are checked before starting the mutation. */
export function proveProjectAssetToolMetadataAckBudget(
  request: ProjectAssetToolsRequests["saveCandidate"],
): void {
  const id = '\\"'.repeat(64),
    assetId = request.assetId ?? id,
    time = "9999-12-31T23:59:59.999Z",
    digest = `sha256:${"f".repeat(64)}`,
    n = Number.MAX_SAFE_INTEGER;
  projectAssetToolsCodec.parseResponse("saveCandidate", request, {
    kind: "save-content",
    disposition: "committed",
    asset: {
      projectId: request.projectId,
      assetId,
      kind: request.kind,
      revision: request.expectedAssetRevision + 1,
      latestContentRevision: n,
      selectedContentRevision: n,
      latestReferenceRevision: n,
      selectedReferenceRevision: n,
      locked: true,
      createdAt: time,
      updatedAt: time,
    },
    contentRevision: {
      projectId: request.projectId,
      assetId,
      kind: request.kind,
      contentRevision: n,
      brief: { briefRevision: request.briefRevision, contentDigest: digest },
      script:
        request.script === null
          ? null
          : { ...request.script, episodeId: id, contentDigest: digest },
      createdAt: time,
      contentDigest: digest,
    },
  });
}
